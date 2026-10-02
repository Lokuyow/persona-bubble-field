import { expect, test } from '@playwright/test';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildPublicProfileStateTemplate } from '../../src/lib/nostrProtocol';
import { CHANNEL_ID, fixtureSecret, openReadyRelayWorld, relayState, moveRelaySelfTo, clickRelayLogicalCell } from './helpers/relayHarness';

test.describe('public profile rankings', () => {
	test('opens from the field terminal, keeps one batch read across tabs, shows late results, and closes outstanding Relay reads', async ({ page }) => {
		const secret = fixtureSecret(19);
		const now = Date.now();
		await page.clock.install({ time: now });
		const profile = finalizeEvent(buildPublicProfileStateTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			createdAt: Math.floor(now / 1_000),
			runNumber: 1,
			points: 900,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 },
			rootPoints: 0,
			lifespan: { baseExpiresAtMs: now + 86_400_000, extension: null }
		}), secret);
		await openReadyRelayWorld(page, 1);
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
		await expect(dialog.locator('[data-ranking-skeleton]')).toBeVisible();
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return requests.filter((request) => request.filters.length === 2 &&
				request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')))).length;
		}).toBeGreaterThan(0);
		const isRankingRequest = (request: { filters: Record<string, unknown>[] }) => request.filters.length === 2 &&
			request.filters.some((filter) => ((filter['#d'] as string[] | undefined) ?? []).some((value) => value.includes(':profile-state:')));
		const requestCount = (await relayState(page)).state.requests.filter(isRankingRequest).length;
		await dialog.getByRole('tab', { name: '寿命' }).click();
		await expect(dialog.getByRole('tab', { name: '寿命' })).toHaveAttribute('aria-selected', 'true');
		expect((await relayState(page)).state.requests.filter(isRankingRequest)).toHaveLength(requestCount);

		await page.clock.runFor(3_001);
		await expect(dialog.getByText('ランキング情報がありません')).toBeVisible();
		const activeRankingReads = await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectRankingEvent(event: object): number }
		}).__relayStartupTest.injectRankingEvent(event), profile);
		expect(activeRankingReads).toBeGreaterThan(0);
		await dialog.getByRole('tab', { name: 'ポイント' }).click();
		await expect(dialog.getByText('900 pt')).toBeVisible();
		await expect(dialog.locator('[data-ranking-row]')).toHaveCount(1);
		await expect(dialog.locator('[data-ranking-row] .ranking-self')).toHaveText('自分');
		await dialog.getByRole('button', { name: '閉じる' }).click();
		await expect(dialog).toHaveCount(0);
		const rankingSubIds = (await relayState(page)).state.requests.filter(isRankingRequest).map((request) => request.subId);
		await expect.poll(async () => {
			const closedIds = (await relayState(page)).state.closedSubscriptions.map((closed) => closed.subId);
			return rankingSubIds.map((subId) => closedIds.includes(subId));
		}).toEqual(rankingSubIds.map(() => true));
	});
});
