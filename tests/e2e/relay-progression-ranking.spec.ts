import { expect, test } from '@playwright/test';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { buildPublicProfileStateTemplate, buildWorldStateEventTemplate } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { AUTHORITATIVE_RELAYS, CHANNEL_ID, fixtureSecret, installDelayedRelay, openReadyRelayWorld, relayState, moveRelaySelfTo, clickRelayLogicalCell, seedRelayAccount, testEvents } from './helpers/relayHarness';

function publicProfile(secret: Uint8Array, now: number, points: number) {
	return finalizeEvent(buildPublicProfileStateTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
		createdAt: Math.floor(now / 1_000),
		runNumber: 1,
		points,
		abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 },
		rootPoints: 0,
		lifespan: { baseExpiresAtMs: now + 86_400_000, extension: null }
	}), secret);
}

function strictInvalidPublicProfile(secret: Uint8Array, createdAt: number, points: number) {
	const profile = publicProfile(secret, createdAt * 1_000, points);
	const content = JSON.parse(profile.content) as Record<string, unknown>;
	content.version = 2;
	return finalizeEvent({ ...profile, content: JSON.stringify(content), created_at: createdAt }, secret);
}

function terminalExit(secret: Uint8Array, createdAt: number, reason: 'death' | 'clear') {
	return finalizeEvent(buildWorldStateEventTemplate({
		channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
		position: { x: 8, y: 0 },
		slot: 'exit',
		createdAt,
		runNumber: 1,
		exitReason: reason
	}), secret);
}

test.describe('public profile rankings', () => {
	test('waits through immediate post-refresh primary startup and starts the ranking read in the same open dialog', async ({ page }) => {
		const secret = fixtureSecret(19);
		const now = Date.now();
		await page.clock.install({ time: now });
		await installHostOwnedStub(page);
		const primaryEvents = testEvents(now);
		await installDelayedRelay(page, {
			deferPrimaryEvents: true,
			deferRankingEvents: true,
			primaryEvents: {
				...primaryEvents,
				position: finalizeEvent(buildWorldStateEventTemplate({
					channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
					position: { x: 7, y: 0 },
					slot: 0,
					createdAt: Math.floor(now / 1_000)
				}), secret)
			}
		});
		await seedRelayAccount(page, secret, getPublicKey(secret), now + 7 * 24 * 60 * 60 * 1_000);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect(page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' })).toBeVisible();
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return AUTHORITATIVE_RELAYS.every((url) =>
				requests.some((request) => request.url === url && (request.filter.kinds as number[] | undefined)?.[0] === 42) &&
				requests.some((request) => request.url === url && (request.filter.kinds as number[] | undefined)?.[0] === 30_079));
		}).toBe(true);
		await page.evaluate((authoritativeRelays) => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimaryRelays(urls: string[]): void } }).__relayStartupTest;
			relay.releasePrimaryEvents();
			relay.releasePrimaryRelays(authoritativeRelays.slice(0, 3));
		}, AUTHORITATIVE_RELAYS);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,0');
		await clickRelayLogicalCell(page, { x: 8, y: 0 });
		await clickRelayLogicalCell(page, { x: 8, y: 0 });

		const dialog = page.getByRole('dialog', { name: 'ランキング' });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('[data-ranking-skeleton]')).toBeVisible();
		const isRankingRequest = (request: { filters: Record<string, unknown>[] }) => request.filters.length === 2 &&
			request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')));
		expect((await relayState(page)).state.requests.filter(isRankingRequest)).toHaveLength(0);
		await page.clock.runFor(3_001);
		await expect(dialog.getByText('ランキングを取得中…')).toBeVisible();
		await expect(dialog.locator('[data-ranking-empty]')).toHaveCount(0);

		await page.evaluate((authoritativeRelays) => (window as typeof window & { __relayStartupTest: { releasePrimaryRelays(urls: string[]): void } }).__relayStartupTest.releasePrimaryRelays(authoritativeRelays.slice(3)), AUTHORITATIVE_RELAYS);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRankingRequest).length).toBeGreaterThan(0);
		const profile = publicProfile(secret, now, 900);
		const activeRankingReads = await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectRankingEvent(event: object): number }
		}).__relayStartupTest.injectRankingEvent(event), profile);
		expect(activeRankingReads).toBeGreaterThan(0);
		await expect(dialog.locator('[data-ranking-column="points"] [data-ranking-row]')).toHaveCount(1);
		await expect(dialog.getByText('900 pt')).toBeVisible();
	});

	test('opens from the field terminal, keeps one batch read across tabs, shows late results, and closes outstanding Relay reads', async ({ page }) => {
		const secret = fixtureSecret(19);
		const now = Date.now();
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.clock.install({ time: now });
		const profile = publicProfile(secret, now, 900);
		await openReadyRelayWorld(page, 1);
		const rankingTerminal = page.locator('[data-field-facility="ranking-terminal"]');
		const rankingTerminalImage = rankingTerminal.locator('img');
		await expect(rankingTerminalImage).toHaveAttribute('src', /field\/objects\/ranking-terminal\.webp$/);
		await expect.poll(() => rankingTerminalImage.evaluate((image) => {
			const element = image as HTMLImageElement;
			const rect = element.getBoundingClientRect();
			return element.complete && element.naturalWidth > 0 && element.naturalHeight > 0 && rect.width > 0 && rect.height > 0;
		})).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferRankingEvents(): void }
		}).__relayStartupTest.deferRankingEvents());
		await clickRelayLogicalCell(page, { x: 8, y: 0 });
		await expect(page.getByText('近づくとランキングを見られる')).toBeVisible();
		await expect(page.getByRole('dialog', { name: 'ランキング' })).toHaveCount(0);
		await moveRelaySelfTo(page, { x: 7, y: 0 });
		await clickRelayLogicalCell(page, { x: 8, y: 0 });

		const dialog = page.getByRole('dialog', { name: 'ランキング' });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('[data-ranking-tab="points"]')).toBeHidden();
		await expect(dialog.locator('[data-ranking-tab="lifespan"]')).toBeHidden();
		await expect(dialog.locator('[data-ranking-skeleton]')).toBeVisible();
		await expect(dialog.getByRole('region', { name: 'ポイントランキング' })).toBeVisible();
		await expect(dialog.getByRole('region', { name: '寿命ランキング' })).toBeVisible();
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return requests.filter((request) => request.filters.length === 2 &&
				request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')))).length;
		}).toBeGreaterThan(0);
		const isRankingRequest = (request: { filters: Record<string, unknown>[] }) => request.filters.length === 2 &&
			request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')));
		const rankingRequests = (await relayState(page)).state.requests.filter(isRankingRequest);
		const requestCount = rankingRequests.length;
		const requestsByRelay = new Map<string, number>();
		for (const request of rankingRequests) requestsByRelay.set(request.url, (requestsByRelay.get(request.url) ?? 0) + 1);
		expect([...requestsByRelay.values()].every((count) => count === 1)).toBe(true);
		expect((await relayState(page)).state.requests.filter(isRankingRequest)).toHaveLength(requestCount);

		await page.clock.runFor(3_001);
		await expect(dialog.getByText('ランキングを取得中…')).toBeVisible();
		await expect(dialog.locator('[data-ranking-empty]')).toHaveCount(0);
		const activeRankingReads = await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectRankingEvent(event: object): number }
		}).__relayStartupTest.injectRankingEvent(event), profile);
		expect(activeRankingReads).toBeGreaterThan(0);
		const pointsColumn = dialog.getByRole('region', { name: 'ポイントランキング' });
		const lifespanColumn = dialog.getByRole('region', { name: '寿命ランキング' });
		await expect(pointsColumn).toBeVisible();
		await expect(lifespanColumn).toBeVisible();
		await expect(pointsColumn.locator('[data-ranking-row]')).toHaveCount(1);
		await expect(lifespanColumn.locator('[data-ranking-row]')).toHaveCount(1);
		await expect(pointsColumn.getByText('900 pt')).toBeVisible();
		const row = pointsColumn.locator('[data-ranking-row]');
		await expect(row.locator('.ranking-self')).toHaveText('自分');
		const avatarLayout = (targetRow: typeof row) => () => targetRow.evaluate((rowElement) => {
			const avatar = rowElement.querySelector<HTMLElement>('.ranking-avatar.avatar');
			if (!avatar) return { hasArea: false, isSquare: false, contained: false };
			const rowRect = rowElement.getBoundingClientRect();
			const avatarRect = avatar.getBoundingClientRect();
			return {
				hasArea: avatarRect.width > 0 && avatarRect.height > 0,
				isSquare: avatarRect.width === avatarRect.height,
				contained: avatarRect.left >= rowRect.left && avatarRect.top >= rowRect.top &&
					avatarRect.right <= rowRect.right && avatarRect.bottom <= rowRect.bottom
			};
		});
		const expectAvatarLayout = async (targetRow: typeof row) => expect.poll(avatarLayout(targetRow)).toEqual({ hasArea: true, isSquare: true, contained: true });
		await expectAvatarLayout(row);
		await page.setViewportSize({ width: 688, height: 844 });
		await expect(dialog.locator('[data-ranking-tab="points"]')).toBeHidden();
		await expect(dialog.locator('[data-ranking-tab="lifespan"]')).toBeHidden();
		await expect(pointsColumn).toBeVisible();
		await expect(lifespanColumn).toBeVisible();
		await expect.poll(() => dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
		expect((await relayState(page)).state.requests.filter(isRankingRequest)).toHaveLength(requestCount);
		await page.setViewportSize({ width: 390, height: 844 });
		const pointsTab = dialog.getByRole('button', { name: 'ポイント' });
		const lifespanTab = dialog.getByRole('button', { name: '寿命' });
		await expect(pointsTab).toBeVisible();
		await expect(lifespanTab).toBeVisible();
		await expect(pointsTab).toHaveAttribute('aria-pressed', 'true');
		await expect(lifespanTab).toHaveAttribute('aria-pressed', 'false');
		await expect(pointsColumn).toBeVisible();
		await expect(lifespanColumn).toBeHidden();
		await expectAvatarLayout(row);

		const deathSecret = fixtureSecret(41);
		const clearSecret = fixtureSecret(53);
		const extraProfiles = [publicProfile(deathSecret, now + 1_000, 300), publicProfile(clearSecret, now + 2_000, 100)];
		const extraExits = [terminalExit(deathSecret, Math.floor(now / 1_000) + 3, 'death'), terminalExit(clearSecret, Math.floor(now / 1_000) + 4, 'clear')];
		for (const event of [...extraProfiles, ...extraExits]) {
			await page.evaluate((rankingEvent) => (window as typeof window & {
				__relayStartupTest: { injectRankingEvent(event: object): number }
			}).__relayStartupTest.injectRankingEvent(rankingEvent), event);
		}
		await expect(pointsColumn.locator('[data-ranking-row]')).toHaveCount(3);
		await expect(pointsColumn.locator('[data-ranking-state="death"] .ranking-value')).toHaveText('300 pt');
		await expect(pointsColumn.locator('[data-ranking-state="death"] .ranking-state')).toHaveText('死亡');
		await expect(pointsColumn.locator('[data-ranking-state="clear"] .ranking-value')).toHaveText('100 pt');
		await expect(pointsColumn.locator('[data-ranking-state="clear"] .ranking-state')).toHaveText('脱出');
		await lifespanTab.click();
		await expect(lifespanTab).toHaveAttribute('aria-pressed', 'true');
		await expect(pointsTab).toHaveAttribute('aria-pressed', 'false');
		await expect(pointsColumn).toBeHidden();
		await expect(lifespanColumn).toBeVisible();
		await expect(lifespanColumn.locator('[data-ranking-row]')).toHaveCount(3);
		await expect(lifespanColumn.locator('[data-ranking-state="death"] .ranking-value')).toHaveText('死亡');
		await expect(lifespanColumn.locator('[data-ranking-state="clear"] .ranking-value')).toHaveText('脱出');
		await expect(lifespanColumn.locator('[data-ranking-state="alive"] .ranking-value')).not.toBeEmpty();
		expect((await relayState(page)).state.requests.filter(isRankingRequest)).toHaveLength(requestCount);

		const rankingSubIds = (await relayState(page)).state.requests.filter(isRankingRequest).map((request) => request.subId);
		const outsidePosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			position: { x: 3, y: 2 },
			slot: 0,
			createdAt: Math.floor((await page.evaluate(() => Date.now())) / 1_000) + 2,
			runNumber: 1
		}), secret);
		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectPosition(event: object): void }
		}).__relayStartupTest.injectPosition(event), outsidePosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await expect(dialog).toHaveCount(0);
		await expect.poll(async () => {
			const closedIds = (await relayState(page)).state.closedSubscriptions.map((closed) => closed.subId);
			return rankingSubIds.map((subId) => closedIds.includes(subId));
		}).toEqual(rankingSubIds.map(() => true));
	});

	test('shows empty only after the deferred finite ranking batch completes without valid rows', async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		await openReadyRelayWorld(page, 1);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferRankingEvents(): void }
		}).__relayStartupTest.deferRankingEvents());
		await moveRelaySelfTo(page, { x: 7, y: 0 });
		await clickRelayLogicalCell(page, { x: 8, y: 0 });

		const dialog = page.getByRole('dialog', { name: 'ランキング' });
		await expect(dialog).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => request.filters.length === 2 &&
			request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')))).length).toBeGreaterThan(0);
		await page.clock.runFor(3_001);
		await expect(dialog.getByText('ランキングを取得中…')).toBeVisible();
		await expect(dialog.locator('[data-ranking-empty]')).toHaveCount(0);

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseRankingEvents(): void }
		}).__relayStartupTest.releaseRankingEvents());
		await expect(dialog.getByText('ランキング情報がありません')).toBeVisible();
		await expect(dialog.locator('[data-ranking-loading]')).toHaveCount(0);
	});

	test('returns to loading and then empty when a newer strict-invalid canonical profile removes the last row', async ({ page }) => {
		const secret = fixtureSecret(63);
		const now = Date.now();
		await page.clock.install({ time: now });
		const validProfile = publicProfile(secret, now, 500);
		await openReadyRelayWorld(page, 1);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferRankingEvents(): void }
		}).__relayStartupTest.deferRankingEvents());
		await moveRelaySelfTo(page, { x: 7, y: 0 });
		await clickRelayLogicalCell(page, { x: 8, y: 0 });

		const dialog = page.getByRole('dialog', { name: 'ランキング' });
		const pointsColumn = dialog.locator('[data-ranking-column="points"]');
		await expect(dialog).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.length === 2 &&
			request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:'))))).toBe(true);
		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectRankingEvent(event: object): number }
		}).__relayStartupTest.injectRankingEvent(event), validProfile);
		await expect(pointsColumn.locator('[data-ranking-row]')).toHaveCount(1);

		const invalidLatest = strictInvalidPublicProfile(secret, validProfile.created_at + 1, 900);
		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectRankingEvent(event: object): number }
		}).__relayStartupTest.injectRankingEvent(event), invalidLatest);
		await expect(pointsColumn.locator('[data-ranking-row]')).toHaveCount(0);
		await expect(dialog.getByText('ランキングを取得中…')).toBeVisible();
		await expect(dialog.locator('[data-ranking-empty]')).toHaveCount(0);

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseRankingEvents(): void }
		}).__relayStartupTest.releaseRankingEvents());
		await expect(dialog.getByText('ランキング情報がありません')).toBeVisible();
		await expect(dialog.locator('[data-ranking-loading]')).toHaveCount(0);
	});
});
