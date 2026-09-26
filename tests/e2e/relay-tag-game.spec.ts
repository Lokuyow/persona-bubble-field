import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { buildTagGameActionTemplate, createTagGameSchedule, finalizeTagGameState, parseTagGameActionEvent, parseTagGameEvent, TAG_GAME_KIND, TAG_GAME_TRANSFER_COOLDOWN_MS, type TagGameState } from '../../src/lib/tagGame';
import { MENDING_TERMINAL, TAG_GAME_TERMINAL } from '../../src/lib/fieldFacilities';
import { resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { buildWorldMessageTemplate, buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { CHANNEL_ID, fixtureSecret, installDelayedRelay, moveRelaySelfTo, relayState, seedRelayAccount, testEvents, clickRelayLogicalCell, dragRelayJoystick } from './helpers/relayHarness';

async function preparePlayer(page: Page, secret: Uint8Array, nowMs: number, points = 0, persistAcrossReload = false): Promise<void> {
	await page.clock.install({ time: nowMs });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents: [], realtimePublishOutcome: 'echo', persistAcrossReload });
	await seedRelayAccount(page, secret, getPublicKey(secret), nowMs + 14 * 24 * 60 * 60 * 1_000, points);
	await page.goto('/');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${getPublicKey(secret)}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(7070)))).toBe(true);
}

async function synchronizeBrowserClocks(pages: readonly Page[]): Promise<void> {
	const nowMs = Math.max(...await Promise.all(pages.map((page) => page.evaluate(() => Date.now()))));
	await Promise.all(pages.map((page) => page.clock.setSystemTime(nowMs)));
}

async function injectRealtime(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(next), event);
}

async function injectPosition(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(next), event);
}

async function injectWorldMessage(page: Page, event: NostrEvent): Promise<void> {
	await page.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), event);
}

async function setRealtimePublishDeferral(page: Page, deferred: boolean): Promise<void> {
	await page.evaluate((shouldDefer) => {
		const testRelay = (window as typeof window & { __relayStartupTest: { deferRealtimePublishes(): void; releaseRealtimePublishes(): void } }).__relayStartupTest;
		if (shouldDefer) testRelay.deferRealtimePublishes();
		else testRelay.releaseRealtimePublishes();
	}, deferred);
}

async function latestGameEvent(page: Page, gameId: string): Promise<NostrEvent> {
	const events = await page.evaluate((id) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		return published.filter((candidate) => candidate.kind === 37070 && candidate.tags && (candidate.tags as string[][]).some((tag) => tag[0] === 'd' && tag[1] === id));
	}, gameId);
	const event = (events as unknown as NostrEvent[]).sort((first, second) => Number(second.created_at) - Number(first.created_at) ||
		(parseTagGameEvent(second, CHANNEL_ID)?.state.revision ?? -1) - (parseTagGameEvent(first, CHANNEL_ID)?.state.revision ?? -1))[0] ?? null;
	if (!event) throw new Error(`No published tag-game state for ${gameId}.`);
	return event;
}

async function latestWorldState(page: Page, author: string): Promise<NostrEvent> {
	return latestPublished(page, WORLD_STATE_KIND, author);
}

async function latestPublished(page: Page, kind: number, author?: string): Promise<NostrEvent> {
	const result = await page.evaluate(({ eventKind, pubkey }) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		const matches = published.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === eventKind && (!pubkey || event.pubkey === pubkey))
			.sort((first, second) => Number(second.event.created_at) - Number(first.event.created_at) || second.index - first.index)[0]?.event ?? null;
		return { event: matches, published: published.map((candidate) => ({ kind: candidate.kind, pubkey: candidate.pubkey })) };
	}, { eventKind: kind, pubkey: author });
	if (!result.event) throw new Error(`No published event of kind ${kind} by ${author ?? 'any author'}; saw ${JSON.stringify(result.published)}.`);
	return result.event as unknown as NostrEvent;
}

async function latestTagGameAction(page: Page, author: string, action: string): Promise<NostrEvent> {
	const events = await page.evaluate((pubkey) => (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published
		.filter((event) => event.kind === 27070 && event.pubkey === pubkey), author);
	const event = (events as unknown as NostrEvent[]).reverse().find((candidate) => parseTagGameActionEvent(candidate, CHANNEL_ID)?.action === action);
	if (!event) throw new Error(`No published ${action} action by ${author}.`);
	return event;
}

async function tagGamePersistence(page: Page): Promise<{ lock: unknown; reservation: unknown; receipt: unknown; savedPoints: number | null }> {
	return page.evaluate(() => new Promise((resolve, reject) => {
		const open = indexedDB.open('persona-bubble-field-account', 8);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const database = open.result;
			const request = database.transaction('persona-bubble-field-player-state', 'readonly').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const state = request.result;
				resolve({ lock: state?.tagGame?.lock ?? null, reservation: state?.tagGame?.reservation ?? null, receipt: state?.realtimeSettlementLedger?.tagGameReceipt ?? null, savedPoints: state?.mode?.kind === 'running' ? state.mode.activeRun.gameState.points : null });
				database.close();
			};
		};
	}));
}

async function exerciseTagGameControlsAtViewport(page: Page, gameId: string, viewport: { width: number; height: number }): Promise<void> {
	await page.setViewportSize(viewport);
	const hud = page.locator(`[data-tag-game-hud-id="${gameId}"]`);
	const speaker = page.getByRole('button', { name: /Open sound settings/ });
	const leave = page.locator(`[data-tag-game-leave="${gameId}"]`);
	await expect(hud).toBeVisible();
	await expect(speaker).toBeVisible();
	await expect(leave).toBeVisible();
	const [hudBox, speakerBox] = await Promise.all([hud.boundingBox(), speaker.boundingBox()]);
	expect(hudBox && speakerBox).toBeTruthy();
	if (hudBox && speakerBox) expect(hudBox.y).toBeGreaterThanOrEqual(speakerBox.y + speakerBox.height);
	const effectText = hud.locator('.game-hud-effect span');
	await expect(effectText).toBeVisible();
	const effectTextBox = await effectText.boundingBox();
	expect(effectTextBox && hudBox).toBeTruthy();
	if (effectTextBox && hudBox) {
		expect(effectTextBox.x).toBeGreaterThanOrEqual(hudBox.x);
		expect(effectTextBox.x + effectTextBox.width).toBeLessThanOrEqual(hudBox.x + hudBox.width);
	}
	const normalHud = page.locator('[data-unified-status-hud]');
	if (await normalHud.count()) {
		const [normalHudBox, gameHudBox] = await Promise.all([normalHud.boundingBox(), hud.boundingBox()]);
		expect(normalHudBox && gameHudBox).toBeTruthy();
		if (normalHudBox && gameHudBox) expect(gameHudBox.y).toBeGreaterThanOrEqual(normalHudBox.y + normalHudBox.height);
	}
	await speaker.click();
	const slider = page.getByRole('slider', { name: 'Sound volume' });
	await expect(slider).toBeVisible();
	const stackBox = await page.locator('[data-field-status-huds]').boundingBox();
	const popoverBox = await page.getByRole('dialog', { name: 'Sound settings' }).boundingBox();
	expect(stackBox && popoverBox).toBeTruthy();
	if (stackBox && popoverBox) expect(stackBox.y).toBeGreaterThanOrEqual(popoverBox.y + popoverBox.height);
	await slider.fill('35');
	await expect(slider).toHaveValue('35');
	await speaker.click();
	await expect(slider).toBeHidden();
	const actionCount = (await relayState(page)).state.published.filter((event) => event.kind === 27070).length;
	await leave.click();
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(actionCount);
	await expect(leave).toBeVisible();
}

async function openTagGameTerminal(page: Page): Promise<void> {
	const self = page.locator('.participant[data-self="true"]');
	const position = await self.getAttribute('data-position');
	await clickRelayLogicalCell(page, TAG_GAME_TERMINAL.position);
	if (await page.locator('[data-cell-action="tag-game-terminal"]').count()) await page.locator('[data-cell-action="tag-game-terminal"]').click();
	if (await page.getByRole('dialog', { name: '鬼ごっこ' }).count() === 0) throw new Error(`Tag-game terminal did not open from self position ${position}.`);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible();
}

test('three Fake Relay clients create, join, consent, start, touch, and settle through the field UI', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const participantTwoPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const participantSecret = fixtureSecret(43);
	const participantTwoSecret = fixtureSecret(47);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	const participantTwoPubkey = getPublicKey(participantTwoSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(participantPage, participantSecret, nowMs), preparePlayer(participantTwoPage, participantTwoSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const hostPosition = await latestPublished(hostPage, WORLD_STATE_KIND, hostPubkey);
		const participantPosition = await latestPublished(participantPage, WORLD_STATE_KIND, participantPubkey);
		const participantTwoPosition = await latestPublished(participantTwoPage, WORLD_STATE_KIND, participantTwoPubkey);
		await Promise.all([injectPosition(participantPage, hostPosition), injectPosition(participantTwoPage, hostPosition), injectPosition(hostPage, participantPosition), injectPosition(hostPage, participantTwoPosition)]);
		await synchronizeBrowserClocks([hostPage, participantPage, participantTwoPage]);
		await moveRelaySelfTo(participantTwoPage, { x: MENDING_TERMINAL.position.x - 1, y: MENDING_TERMINAL.position.y });
		await participantTwoPage.getByRole('button', { name: '作業端末' }).click();
		const mendingDialog = participantTwoPage.getByRole('dialog', { name: '作業中' });
		await expect(mendingDialog).toBeVisible();
		await expect(participantTwoPage.locator('[data-unified-status-hud] [data-mending-row]')).toBeVisible();
		await mendingDialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 });

		await openTagGameTerminal(hostPage);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary');
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const firstState = await latestPublished(hostPage, TAG_GAME_KIND);
		const parsedLobby = parseTagGameEvent(firstState, CHANNEL_ID);
		expect(parsedLobby).not.toBeNull();
		const gameId = parsedLobby!.state.gameId;
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveCount(0);
		await expect(hostPage.getByText('あなたの開催').first()).toBeVisible();
		const hostCard = hostPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: 'あなたの開催' });
		await expect(hostCard.getByText('参加者 1 / 8人')).toBeVisible();
		await expect(hostCard.locator('[data-tag-game-participant-slot]')).toHaveCount(1);
		await expect(hostCard.locator('.participant-slot-empty')).toHaveCount(7);
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		await Promise.all([openTagGameTerminal(participantPage), openTagGameTerminal(participantTwoPage)]);
		await Promise.all([expect(participantPage.locator('main')).toHaveAttribute('data-realtime-status', 'active'), expect(participantTwoPage.locator('main')).toHaveAttribute('data-realtime-status', 'active')]);
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		const hostCharacter = resolveCharacterFromPubkey(hostPubkey)!.name;
		await expect(participantPage.getByText(`開催者 ${hostCharacter}`)).toBeVisible();
		await Promise.all([expect(participantPage.getByRole('button', { name: '参加申請' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '参加申請' })).toBeVisible()]);
		await expect(participantPage.getByRole('button', { name: '参加申請' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('[data-action-variant="primary"]')).toHaveCount(1);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveCount(0);
		await expect(participantPage.locator('.tag-game-arrival')).toHaveCount(0);
		await Promise.all([participantPage.getByRole('button', { name: '参加申請' }).click(), participantTwoPage.getByRole('button', { name: '参加申請' }).click()]);
		await Promise.all([expect(participantPage.getByText('参加申請済み（受理待ち）').first()).toBeVisible(), expect(participantTwoPage.getByText('参加申請済み（受理待ち）').first()).toBeVisible()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(0)));
		const [joinAction, joinActionTwo] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey)]);
		await Promise.all([injectRealtime(hostPage, joinAction), injectRealtime(hostPage, joinActionTwo)]);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.participant.length).toBe(3);
		const registeredEvent = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, registeredEvent), injectRealtime(participantTwoPage, registeredEvent)]);
		await expect(participantPage.getByText('参加申請済み（参加登録済み）').first()).toBeVisible();
		await expect(participantPage.locator('.tag-game-arrival')).toContainText('あなた');
		await expect(participantPage.locator('.tag-game-arrival')).toContainText(resolveCharacterFromPubkey(participantTwoPubkey)!.name);
		await expect(participantPage.locator('[data-tag-game-participant-slot]')).toHaveCount(3);
		await expect(participantPage.locator('.participant-slot-empty')).toHaveCount(5);
		const participantViewport = participantPage.viewportSize();
		const participantCard = participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: `開催者 ${hostCharacter}` });
		const participantGrid = participantCard.locator('.participant-slots');
		await participantPage.setViewportSize({ width: 390, height: 844 });
		await expect.poll(async () => participantGrid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(4);
		const cancelApplication = participantCard.getByRole('button', { name: '申請を取り消す' });
		await expect(cancelApplication).toBeVisible();
		const [gridBox, cancelBox] = await Promise.all([participantGrid.boundingBox(), cancelApplication.boundingBox()]);
		expect(gridBox && cancelBox).toBeTruthy();
		if (gridBox && cancelBox) expect(cancelBox.y).toBeGreaterThanOrEqual(gridBox.y + gridBox.height);
		if (participantViewport) await participantPage.setViewportSize(participantViewport);
		await participantTwoPage.getByRole('button', { name: '閉じる', exact: true }).click();
		await injectRealtime(participantTwoPage, registeredEvent);
		await openTagGameTerminal(participantTwoPage);
		await expect(participantTwoPage.locator('[data-tag-game-participant-slot]')).toHaveCount(3);
		await expect(participantTwoPage.locator('.tag-game-arrival')).toHaveCount(0);

		await expect(hostPage.getByRole('button', { name: '開始を提案' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(hostCard.getByRole('button', { name: '募集を取り消す' })).toHaveAttribute('data-action-variant', 'tertiary');
		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('proposed');
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		const proposal = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, proposal), injectRealtime(participantTwoPage, proposal)]);
		await Promise.all([expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '開始に同意' })).toBeVisible()]);
		await expect(participantPage.getByRole('button', { name: '開始に同意' })).toHaveAttribute('data-action-variant', 'primary');
		await expect(participantPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('[data-action-variant="primary"]')).toHaveCount(1);
		await expect(hostCard.getByText('開催者は同意済み')).toBeVisible();
		await expect(hostCard.getByRole('button', { name: '開始に同意' })).toHaveCount(0);
		await expect(hostCard.getByRole('button', { name: '今回は辞退' })).toHaveCount(0);
		const hostLeave = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'leave', runNumber: 1, nonce: 'a'.repeat(32), createdAt: Math.floor(await hostPage.evaluate(() => Date.now() / 1000)) }), hostSecret);
		await injectRealtime(hostPage, hostLeave);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.participant.length).toBe(3);
		await Promise.all([participantPage.getByRole('button', { name: '開始に同意' }).click(), participantTwoPage.getByRole('button', { name: '開始に同意' }).click()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(1)));
		const [consent, consentTwo] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey)]);
		await Promise.all([injectRealtime(hostPage, consent), injectRealtime(hostPage, consentTwo)]);
		expect((await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toHaveLength(0);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('countdown');
		await Promise.all([injectRealtime(participantPage, await latestGameEvent(hostPage, gameId)), injectRealtime(participantTwoPage, await latestGameEvent(hostPage, gameId))]);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		await hostPage.clock.runFor(6_000);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('running');
		const runningEvent = await latestGameEvent(hostPage, gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setFixedTime(running.startedAt! * 1_000 + 5_000)));
		await Promise.all([injectRealtime(participantPage, runningEvent), injectRealtime(participantTwoPage, runningEvent)]);
		const touchActivityAt = running.startedAt! + 5;
		const touchActivity = [
			[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]
		] as const;
		for (const [secret, position] of touchActivity) {
			const activity = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: touchActivityAt, position, slot: 1, runNumber: 1 }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectPosition(page, activity)));
		}
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0)));
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantTwoPage.locator('[data-tag-game-hud]')).toBeVisible();
		const participantHudHolder = running.ownerPubkey === participantPubkey ? 'あなた' : resolveCharacterFromPubkey(running.ownerPubkey!)!.name;
		await expect(participantPage.locator('[data-tag-game-hud]')).toContainText(participantHudHolder);
		await expect(participantPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect', running.effect!);
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText(/02:5\d/);
		if (await hostPage.locator('[data-tag-game-hud] [data-tag-game-effect]').getAttribute('data-tag-game-effect-active') === 'true') {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText(running.effect === 'benefit' ? '所持者以外が追いかけて奪う' : '所持者が追いかけて押し付ける');
		} else {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
		}
		const gamePages = new Map([[hostPubkey, hostPage], [participantPubkey, participantPage], [participantTwoPubkey, participantTwoPage]]);
		const holderHudPage = gamePages.get(running.ownerPubkey!)!;
		const holderUnifiedHud = holderHudPage.locator('[data-unified-status-hud]');
		await expect(holderUnifiedHud).toHaveAttribute('data-tag-game-projection', 'true');
		await expect(holderUnifiedHud.locator('[data-tag-game-projection-row]')).toHaveCount(0);
		await expect(holderUnifiedHud).not.toContainText(/予測中|未確定予測|確定分・保存待ち/);
		await expect.poll(async () => {
			const data = await holderUnifiedHud.evaluate((element) => {
				const hud = element as HTMLElement;
				return {
					points: hud.dataset.currentPoints,
					pointMeter: hud.querySelector<HTMLElement>('[data-points-meter]')?.dataset.meterValue,
					remaining: hud.dataset.currentRemainingMs,
					lifespanMeter: hud.querySelector<HTMLElement>('[data-lifespan-meter]')?.dataset.meterValue,
					lifespanMaximum: hud.dataset.maximumLifespanMs
				};
			});
			return data.points === data.pointMeter && data.lifespanMeter === String(Math.min(Number(data.lifespanMaximum), Number(data.remaining)));
		}).toBe(true);
		if (await holderHudPage.locator('[data-tag-game-hud] [data-tag-game-effect-active]').getAttribute('data-tag-game-effect-active') === 'true') {
			if (running.effect === 'benefit') {
				await expect.poll(async () => Number(await holderUnifiedHud.getAttribute('data-current-points'))).toBeGreaterThan(Number(await holderUnifiedHud.getAttribute('data-saved-points')));
			} else {
				await expect.poll(async () => Number(await holderUnifiedHud.getAttribute('data-current-expires-at-ms'))).toBeLessThan(Number(await holderUnifiedHud.getAttribute('data-base-expires-at-ms')));
			}
		}
		for (const [pubkey, page] of gamePages) {
			if (pubkey === running.ownerPubkey) continue;
			const hud = page.locator('[data-unified-status-hud]');
			await expect(hud.locator('[data-tag-game-projection-row]')).toHaveCount(0);
			await expect(hud).toHaveAttribute('data-current-points', await hud.getAttribute('data-saved-points') ?? '');
		}
		const firstRemaining = await hostPage.locator('[data-tag-game-remaining]').textContent();
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setSystemTime(running.startedAt! * 1_000 + 6_000)));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(250)));
		await expect(hostPage.locator('[data-tag-game-remaining]')).not.toHaveText(firstRemaining ?? '');
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText(/02:5\d/);
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage)]);
		const refreshedAt = Math.floor(await hostPage.evaluate(() => Date.now() / 1_000)) + 1;
		const sameGameRunning = finalizeTagGameState({ ...running, revision: running.revision + 1, updatedAt: refreshedAt }, CHANNEL_ID, refreshedAt, hostSecret);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectRealtime(page, sameGameRunning)));
		await Promise.all([hostPage, participantPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		await Promise.all([hostPage, participantPage].map(async (page) => {
			await page.getByRole('button', { name: '閉じる', exact: true }).click();
		}));
		const participantTwoViewport = participantTwoPage.viewportSize();
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 1200, height: 900 });
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 390, height: 844 });
		await exerciseTagGameControlsAtViewport(participantTwoPage, gameId, { width: 390, height: 480 });
		if (participantTwoViewport) await participantTwoPage.setViewportSize(participantTwoViewport);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const [latestHostPosition, latestParticipantPosition, latestParticipantTwoPosition] = await Promise.all([
			latestWorldState(hostPage, hostPubkey), latestWorldState(participantPage, participantPubkey), latestWorldState(participantTwoPage, participantTwoPubkey)
		]);
		await injectPosition(hostPage, latestParticipantPosition);
		await injectPosition(hostPage, latestParticipantTwoPosition);
		await injectPosition(participantPage, latestHostPosition);
		await injectPosition(participantPage, latestParticipantTwoPosition);
		await injectPosition(participantTwoPage, latestHostPosition);
		await injectPosition(participantTwoPage, latestParticipantPosition);

		const cells = new Map([[hostPubkey, { page: hostPage, position: { x: 7, y: 5 } }], [participantPubkey, { page: participantPage, position: { x: 7, y: 6 } }], [participantTwoPubkey, { page: participantTwoPage, position: { x: 8, y: 5 } }]]);
		const holderPage = cells.get(running.ownerPubkey!)!.page;
		const holderMarker = holderPage.locator(`.participant[data-participant-id="${running.ownerPubkey}"]`);
		await expect(holderMarker).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(holderMarker).toHaveAttribute('data-tag-game-effect', running.effect!);
		const displayedEffect = holderPage.locator('[data-tag-game-hud] [data-tag-game-effect]');
		await expect(holderMarker).toHaveAttribute('data-tag-game-effect-active', await displayedEffect.getAttribute('data-tag-game-effect-active') ?? 'false');
		const fieldEffectLabel = holderMarker.locator('.tag-game-holder-label');
		await expect(fieldEffectLabel).toContainText(running.effect === 'benefit' ? '恩恵' : '災厄');
		await expect(fieldEffectLabel).not.toContainText(/pt\/秒|時間\/秒|停止中/);
		await expect(fieldEffectLabel.locator('small')).toHaveCount(0);
		const labelBox = await fieldEffectLabel.boundingBox();
		const holderBox = await holderMarker.boundingBox();
		const holderNameBox = await holderMarker.locator('.participant-name').boundingBox();
		const avatarBox = await holderMarker.locator('.participant-profile-trigger .avatar').boundingBox();
		expect(labelBox && holderBox && holderNameBox && avatarBox).toBeTruthy();
		if (labelBox && holderBox && holderNameBox && avatarBox) {
			expect(labelBox.x).toBeGreaterThanOrEqual(holderBox.x);
			expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(holderBox.x + holderBox.width);
			expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(avatarBox.y);
			expect(labelBox.y + labelBox.height).toBeLessThan(holderNameBox.y);
		}
		const holderViewport = holderPage.viewportSize();
		await holderPage.setViewportSize({ width: 390, height: 844 });
		await expect(fieldEffectLabel.locator('strong')).toBeVisible();
		await expect(fieldEffectLabel.locator('small')).toHaveCount(0);
		if (holderViewport) await holderPage.setViewportSize(holderViewport);
		const currentTouchState = parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)!.state;
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			const pageNow = await page.evaluate(() => Date.now());
			await page.clock.setSystemTime(Math.max(pageNow, (currentTouchState.transferAt ?? pageNow) + 4_000));
		}));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(300)));
		let touchStateEvent = await latestGameEvent(hostPage, gameId);
		let touchState = parseTagGameEvent(touchStateEvent, CHANNEL_ID)!.state;
		const activeAt = Math.max(...await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.evaluate(() => Math.floor(Date.now() / 1_000)))));
		for (const [secret, position] of [[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]] as const) {
			const activity = finalizeEvent(buildWorldMessageTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: activeAt, position, content: 'active touch E2E participant', speechType: 'normal' }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectWorldMessage(page, activity)));
		}
		await hostPage.clock.runFor(300);
		touchStateEvent = await latestGameEvent(hostPage, gameId);
		touchState = parseTagGameEvent(touchStateEvent, CHANNEL_ID)!.state;
		await Promise.all([participantPage, participantTwoPage].map((page) => injectRealtime(page, touchStateEvent)));
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.locator(`.participant[data-participant-id="${touchState.ownerPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder')));
		const holder = cells.get(touchState.ownerPubkey!)!;
		const target = [...cells.entries()].find(([pubkey, candidate]) => pubkey !== touchState.ownerPubkey && Math.abs(candidate.position.x - holder.position.x) + Math.abs(candidate.position.y - holder.position.y) === 1)!;
		const actorEntry = touchState.effect === 'benefit' ? target : [touchState.ownerPubkey!, holder] as const;
		const actorPubkey = actorEntry[0];
		const actor = actorEntry[1].page;
		const touchTargetPubkey = touchState.effect === 'benefit' ? touchState.ownerPubkey! : target[0];
		let transferredEvent = touchStateEvent;
		let transferred = touchState;
		await expect(actor.locator(`.participant[data-participant-id="${touchTargetPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await expect(actor.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-position', `${actorEntry[1].position.x},${actorEntry[1].position.y}`);
		await expect(actor.locator(`.participant[data-participant-id="${touchTargetPubkey}"]`)).toHaveAttribute('data-position', `${cells.get(touchTargetPubkey)!.position.x},${cells.get(touchTargetPubkey)!.position.y}`);
		const dx = cells.get(touchTargetPubkey)!.position.x - actorEntry[1].position.x;
		const dy = cells.get(touchTargetPubkey)!.position.y - actorEntry[1].position.y;
		await expect(actor.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		// Hold the host's signed 37070 before any touch can reach the organizer;
		// setting this after input races the live 27070 echo and publication.
		await setRealtimePublishDeferral(hostPage, true);
		const actionCountBeforeTouch = (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length;
		await dragRelayJoystick(actor, { x: dx * 100, y: dy * 100 }, actorEntry[1].position);
		await expect(actor.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
		await expect.poll(async () => (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length).toBeGreaterThan(actionCountBeforeTouch);
		await expect.poll(async () => latestTagGameAction(actor, actorPubkey, 'touch').then(() => true, () => false)).toBe(true);
		const touchAction = await latestTagGameAction(actor, actorPubkey, 'touch');
		await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		const parsedTouch = parseTagGameActionEvent(touchAction, CHANNEL_ID);
		expect(parsedTouch?.action).toBe('touch');
		expect(parsedTouch?.payload.actorProof).toMatchObject({ worldStateEventId: expect.any(String), positionEvidenceEventId: expect.any(String) });
		expect(parsedTouch?.payload.targetProof).toMatchObject({ worldStateEventId: expect.any(String), positionEvidenceEventId: expect.any(String) });
		await injectRealtime(hostPage, touchAction);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.runFor(2_100)));
		// The organizer creates its own signed state locally; only remote
		// submitters need the temporary unconfirmed status while that state is held.
		if (actorPubkey !== hostPubkey) await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('転移未確認');
		await setRealtimePublishDeferral(hostPage, false);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.transferAt).toBeGreaterThan(touchState.transferAt ?? 0);
		transferredEvent = await latestGameEvent(hostPage, gameId);
		transferred = parseTagGameEvent(transferredEvent, CHANNEL_ID)!.state;
		expect(transferredEvent.kind).toBe(TAG_GAME_KIND);
		expect(transferredEvent.pubkey).toBe(hostPubkey);
		expect(transferred.ownerPubkey).toBe(touchState.effect === 'benefit' ? actorPubkey : touchTargetPubkey);
		await Promise.all([participantPage, participantTwoPage].map((page) => injectRealtime(page, transferredEvent)));
		if (actorPubkey !== hostPubkey) {
			await expect(actor.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
			await actor.clock.runFor(1_900);
			await expect(actor.locator('[data-tag-game-touch-status]')).toHaveCount(0);
		}
		const receivedAtMs = await actor.evaluate(() => Date.now());
		const officialCooldownRemainingMs = Math.max(0, (transferred.transferAt ?? transferred.startedAt! * 1_000) + TAG_GAME_TRANSFER_COOLDOWN_MS - receivedAtMs);
		const cooldownLine = actor.locator('[data-tag-game-cooldown-line]');
		if (officialCooldownRemainingMs === 0) await expect(cooldownLine).toHaveCount(0);
		else {
			const displayedCooldownMs = Number(await cooldownLine.getAttribute('aria-valuenow'));
			expect(Math.abs(displayedCooldownMs - officialCooldownRemainingMs)).toBeLessThanOrEqual(250);
		}
		await expect(actor.locator('[data-tag-game-hud]')).toBeVisible();
		const presenceAt = Math.max(transferredEvent.created_at, ...await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.evaluate(() => Math.floor(Date.now() / 1_000))))) + 1;
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setSystemTime(presenceAt * 1_000)));
		for (const [secret, position] of [[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]] as const) {
			const activity = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: presenceAt, position, slot: 1, runNumber: 1 }), secret);
			await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectPosition(page, activity)));
		}
		const confirmedTransfer = finalizeTagGameState({ ...transferred, revision: transferred.revision + 1, updatedAt: presenceAt }, CHANNEL_ID, presenceAt, hostSecret);
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => injectRealtime(page, confirmedTransfer)));
		const transferredHolderPage = cells.get(transferred.ownerPubkey!)!.page;
		await expect(transferredHolderPage.locator(`.participant[data-participant-id="${transferred.ownerPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(transferredHolderPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toBeVisible();

		const endsAt = running.endsAt! * 1000;
		const channel = { channelId: CHANNEL_ID, relayHint: latestHostPosition.tags.find((tag) => tag[0] === 'e')?.[2] ?? 'wss://relay.test/' };
		const finalActivityAt = Math.floor(endsAt / 1_000) - 1;
		await hostPage.clock.setSystemTime(finalActivityAt * 1_000);
		const finalActivity = [
			[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]
		] as const;
		// Keep ordinary signed World activity fresh at the end while fast-forwarding the host clock.
		for (const [secret, position] of finalActivity) {
			const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: finalActivityAt, position, slot: 1, runNumber: 1 }), secret);
			await injectPosition(hostPage, event);
		}
		const beforeFinal = await latestGameEvent(hostPage, gameId);
	await hostPage.clock.setSystemTime(Math.max(endsAt + 1_000, (beforeFinal.created_at + 1) * 1_000));
	await hostPage.clock.runFor(1_250);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('ended');
		await expect(hostPage.locator('[data-tag-game-hud]')).toHaveCount(0);
		const finalStateEvent = await latestGameEvent(hostPage, gameId);
		await injectRealtime(participantPage, finalStateEvent);
		await injectRealtime(participantTwoPage, finalStateEvent);
		const finalState = parseTagGameEvent(finalStateEvent, CHANNEL_ID)!.state;
		const finalLocal = finalState.participant.find((member) => member.pubkey === participantPubkey)!;
		await expect.poll(async () => (await tagGamePersistence(participantPage)).receipt).toMatchObject({ gameId, points: finalLocal.points, lifespanLossMs: finalLocal.lifespanLossMs });
		await expect(participantPage.locator('[data-unified-status-hud]')).toHaveAttribute('data-saved-points', String((await tagGamePersistence(participantPage)).savedPoints));
		await expect(participantPage.locator('[data-unified-status-hud]')).not.toHaveAttribute('data-tag-game-projection', 'true');
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage), openTagGameTerminal(participantTwoPage)]);
		await expect(hostPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
		await expect(participantPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
		await expect(participantTwoPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
		await expect(participantPage.locator('.results')).toContainText(resolveCharacterFromPubkey(hostPubkey)!.name);
		await expect(participantPage.locator('.results')).toContainText('あなた');
	} finally {
		await Promise.all([hostPage.close(), participantPage.close(), participantTwoPage.close()]);
	}
});

test('keeps join actions secondary when multiple tag-game lobbies are available', async ({ browser }) => {
	const firstHostPage = await browser.newPage();
	const secondHostPage = await browser.newPage();
	const joinerPage = await browser.newPage();
	const nowMs = Date.now();
	const firstHostSecret = fixtureSecret(61);
	const secondHostSecret = fixtureSecret(63);
	const joinerSecret = fixtureSecret(51);
	try {
		await Promise.all([preparePlayer(firstHostPage, firstHostSecret, nowMs), preparePlayer(secondHostPage, secondHostSecret, nowMs), preparePlayer(joinerPage, joinerSecret, nowMs)]);
		await Promise.all([
			moveRelaySelfTo(firstHostPage, { x: 7, y: 5 }),
			moveRelaySelfTo(secondHostPage, { x: 8, y: 5 }),
			moveRelaySelfTo(joinerPage, { x: 7, y: 6 })
		]);
		await Promise.all([openTagGameTerminal(firstHostPage), openTagGameTerminal(secondHostPage)]);
		await Promise.all([
			expect(firstHostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary'),
			expect(secondHostPage.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'primary')
		]);
		await expect(joinerPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await Promise.all([
			firstHostPage.getByRole('button', { name: '鬼ごっこを開催' }).click(),
			secondHostPage.getByRole('button', { name: '鬼ごっこを開催' }).click()
		]);
		await Promise.all([firstHostPage, secondHostPage].map(async (hostPage) =>
			expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true)
		));
		const lobbies = await Promise.all([
			latestPublished(firstHostPage, TAG_GAME_KIND, getPublicKey(firstHostSecret)),
			latestPublished(secondHostPage, TAG_GAME_KIND, getPublicKey(secondHostSecret))
		]);
		await joinerPage.setViewportSize({ width: 390, height: 844 });
		await openTagGameTerminal(joinerPage);
		const dialog = joinerPage.getByRole('dialog', { name: '鬼ごっこ' });
		for (const [index, event] of lobbies.entries()) {
			await injectRealtime(joinerPage, event);
			await expect.poll(() => dialog.locator('ul > li').count()).toBe(index + 1);
		}
		const joinButtons = dialog.getByRole('button', { name: '参加申請' });
		await expect(joinButtons).toHaveCount(2);
		await expect(joinButtons.nth(0)).toHaveAttribute('data-action-variant', 'secondary');
		await expect(joinButtons.nth(1)).toHaveAttribute('data-action-variant', 'secondary');
		await expect(dialog.getByRole('button', { name: '鬼ごっこを開催' })).toHaveAttribute('data-action-variant', 'secondary');
		await expect(dialog.locator('[data-action-variant="primary"]')).toHaveCount(0);
	} finally {
		await Promise.all([firstHostPage.close(), secondHostPage.close(), joinerPage.close()]);
	}
});

test('organizer accepts a touch with the seed-derived role before the ordinary switch is republished', async ({ page }) => {
	const nowMs = Date.now();
	const nowSeconds = Math.floor(nowMs / 1_000);
	const hostSecret = fixtureSecret(41);
	const holderSecret = fixtureSecret(43);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	await preparePlayer(page, hostSecret, nowMs, 200_000);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const startedAt = Math.floor(await page.evaluate(() => Date.now() / 1_000)) - 11;
	const seed = Array.from({ length: 10_000 }, (_, index) => `switch-touch-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs === 10_000 && schedule[1].effect === 'benefit' && schedule[1].durationMs >= 30_000;
	});
	expect(seed).toBeTruthy();
	const schedule = createTagGameSchedule(seed!);
	const switchedAtMs = startedAt * 1_000 + schedule[0].durationMs;
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt, endsAt: startedAt + 180, seed: seed!, ownerPubkey: holderPubkey, effect: 'calamity', transferAt: startedAt * 1_000,
		lastHolderResponseAtMs: nowSeconds * 1_000,
		participant: [
			{ pubkey: hostPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 },
			{ pubkey: holderPubkey, runNumber: 1, registeredAt: startedAt, status: 'active', points: 0, lifespanLossMs: 36_000_000, benefitMs: 0, calamityMs: 10_000 }
		], settledAtMs: switchedAtMs
	};
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const holderPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), holderSecret);
	const holderActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'fresh holder activity', speechType: 'normal' }), holderSecret);
	await injectPosition(page, holderPosition);
	await injectWorldMessage(page, holderActivity);
	const signedRunning = finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret);
	await injectRealtime(page, signedRunning);
	const holder = page.locator(`.participant[data-participant-id="${holderPubkey}"]`);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect', 'benefit');
	await expect(holder).toHaveAttribute('data-tag-game-touch-target', 'true');
	const before = (await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND).length;
	await page.keyboard.down('ArrowRight');
	const actor = page.locator(`.participant[data-participant-id="${hostPubkey}"]`);
	await expect(actor).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThan(0);
	await page.keyboard.up('ArrowRight');
	const touch = await latestTagGameAction(page, hostPubkey, 'touch');
	expect(parseTagGameActionEvent(touch, CHANNEL_ID)?.payload.targetPubkey).toBe(holderPubkey);
	await injectRealtime(page, touch);
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.ownerPubkey).toBe(hostPubkey);
	const finalized = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(finalized.effect).toBe('benefit');
	expect(finalized.participant.find((member) => member.pubkey === holderPubkey)?.calamityMs).toBe(10_000);
	expect((await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND).length).toBeGreaterThan(before);
});

test('same-target long press keeps touch status stable while Relay acknowledgements are delayed', async ({ browser }) => {
	test.setTimeout(60_000);
	const hostPage = await browser.newPage();
	const actorPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(53);
	const actorSecret = fixtureSecret(59);
	const hostPubkey = getPublicKey(hostSecret);
	const actorPubkey = getPublicKey(actorSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(actorPage, actorSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 8, y: 5 }), moveRelaySelfTo(actorPage, { x: 7, y: 5 })]);
		const [hostPosition, actorPosition] = await Promise.all([latestWorldState(hostPage, hostPubkey), latestWorldState(actorPage, actorPubkey)]);
		await Promise.all([hostPage, actorPage].flatMap((page) => [injectPosition(page, hostPosition), injectPosition(page, actorPosition)]));
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
		const gameNowMs = Date.now();
		await Promise.all([hostPage, actorPage].map((page) => page.clock.setSystemTime(gameNowMs)));
		const nowSeconds = Math.floor(gameNowMs / 1_000);
		const startedAt = nowSeconds - 4;
		const seed = Array.from({ length: 1_000 }, (_, index) => `held-touch-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
		const gameId = `${hostPubkey}:${startedAt}:${'8'.repeat(64)}`;
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 180, seed, ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [hostPubkey, actorPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000
		};
		const runningEvent = finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret);
		await Promise.all([injectRealtime(hostPage, runningEvent), injectRealtime(actorPage, runningEvent)]);
		const activeMessage = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'holder active for held-touch test', speechType: 'normal' }), hostSecret);
		const actorMessage = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 7, y: 5 }, content: 'actor active for held-touch test', speechType: 'normal' }), actorSecret);
		for (const page of [hostPage, actorPage]) await Promise.all([injectWorldMessage(page, activeMessage), injectWorldMessage(page, actorMessage)]);
		await expect(actorPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await actorPage.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: string): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		await actorPage.keyboard.down('ArrowRight');
		await expect.poll(async () => latestTagGameAction(actorPage, actorPubkey, 'touch').then(() => true, () => false)).toBe(true);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		await actorPage.evaluate(() => {
			const hud = document.querySelector('[data-tag-game-hud]');
			const status = document.querySelector('[data-tag-game-touch-status]');
			if (!hud || !status) throw new Error('Expected the pending touch status before the long-press observation.');
			const trace: Array<string | null> = [status.textContent?.trim() ?? null];
			(window as typeof window & { __touchStatusTrace?: Array<string | null>; __touchStatusObserver?: MutationObserver }).__touchStatusTrace = trace;
			const observer = new MutationObserver(() => trace.push(document.querySelector('[data-tag-game-touch-status]')?.textContent?.trim() ?? null));
			observer.observe(hud, { childList: true, subtree: true, characterData: true });
			(window as typeof window & { __touchStatusObserver?: MutationObserver }).__touchStatusObserver = observer;
		});
		await setRealtimePublishDeferral(actorPage, true);
		await actorPage.clock.runFor(1_300);
		await expect.poll(async () => (await relayState(actorPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThanOrEqual(3);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('判定待ち・開催者未確認');
		const traceDuringHold = await actorPage.evaluate(() => (window as typeof window & { __touchStatusTrace: Array<string | null> }).__touchStatusTrace);
		expect(traceDuringHold).not.toContain(null);
		expect(traceDuringHold.every((text) => text === '判定待ち・開催者未確認')).toBe(true);
		await actorPage.evaluate(() => (window as typeof window & { __touchStatusObserver?: MutationObserver }).__touchStatusObserver?.disconnect());
		await actorPage.keyboard.up('ArrowRight');
		await actorPage.clock.runFor(2_100);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('転移未確認');
		const firstTouch = await latestTagGameAction(actorPage, actorPubkey, 'touch');
		// The host's controlled clock must advance so its signed 37070 is newer
		// than the initial running event (same-second addressable conflicts are
		// intentionally not selected by clients).
		await hostPage.clock.runFor(1_000);
		await injectRealtime(hostPage, firstTouch);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.ownerPubkey).toBe(actorPubkey);
		const confirmedState = await latestGameEvent(hostPage, gameId);
		expect(confirmedState.kind).toBe(TAG_GAME_KIND);
		expect(confirmedState.pubkey).toBe(hostPubkey);
		await injectRealtime(actorPage, confirmedState);
		await expect(actorPage.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
		await setRealtimePublishDeferral(actorPage, false);
		await actorPage.clock.runFor(10);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveText('所持者が更新されました');
		await actorPage.clock.runFor(1_900);
		await expect(actorPage.locator('[data-tag-game-touch-status]')).toHaveCount(0);
		await expect(actorPage.locator('[data-tag-game-hud]')).toBeVisible();
	} finally {
		await Promise.all([hostPage.close(), actorPage.close()]);
	}
});

test('the 23-second cutoff survives reload and recovery excludes the stopped interval', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(61);
	const ownerSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const ownerPubkey = getPublicKey(ownerSecret);
	await preparePlayer(page, hostSecret, nowMs, 0, true);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const nowSeconds = Math.floor(await page.evaluate(() => Date.now() / 1_000));
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const ownerPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), ownerSecret);
	await injectPosition(page, ownerPosition);
	const seed = Array.from({ length: 10_000 }, (_, index) => `pause-recovery-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs >= 30_000;
	})!;
	const gameId = `${hostPubkey}:${nowSeconds}:${'6'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt: nowSeconds, endsAt: nowSeconds + 180, seed, ownerPubkey, effect: 'calamity', transferAt: nowSeconds * 1_000,
		participant: [hostPubkey, ownerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: nowSeconds * 1_000, lastHolderResponseAtMs: nowSeconds * 1_000
	};
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret));
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await page.clock.runFor(15_500);
	const precheck = await latestTagGameAction(page, hostPubkey, 'response-challenge');
	expect(parseTagGameActionEvent(precheck, CHANNEL_ID)?.payload).toMatchObject({ stage: 'precheck' });
	await page.clock.runFor(8_000);
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.holderChallengeId).toBeTruthy();
	const stopped = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	const stoppedEvent = await latestGameEvent(page, gameId);
	expect(stopped.settledAtMs).toBe(nowSeconds * 1_000 + 23_000);
	const stoppedOwner = stopped.participant.find((member) => member.pubkey === ownerPubkey)!;
	expect(stoppedOwner.calamityMs).toBe(23_000);

	await page.reload();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${hostPubkey}"]`)).toBeVisible();
	await injectRealtime(page, stoppedEvent);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await page.clock.runFor(1_500);
	const replayedStates = await page.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<Record<string, unknown>> } } }).__relayStartupTest.state.realtimeHistory
		.filter((event) => event.kind === 37070 && (event.tags as string[][]).some((tag) => tag[0] === 'd' && tag[1] === id)), gameId) as unknown as NostrEvent[];
	const replayedStop = parseTagGameEvent(replayedStates.at(-1)!, CHANNEL_ID)!.state;
	expect(replayedStop.holderChallengeId).toBeTruthy();
	expect(replayedStop.settledAtMs).toBe(stopped.settledAtMs);
	expect(replayedStop.participant.find((member) => member.pubkey === ownerPubkey)?.calamityMs).toBe(stoppedOwner.calamityMs);

	const resumeAtMs = await page.evaluate(() => Date.now());
	const resumeBoundaryMs = Math.floor(resumeAtMs / 1_000) * 1_000;
	const resumedActivity = finalizeEvent(buildWorldMessageTemplate({ channel,
		createdAt: Math.floor(resumeAtMs / 1_000), position: { x: 8, y: 5 }, content: 'holder resumed World activity', speechType: 'normal' }), ownerSecret);
	await injectWorldMessage(page, resumedActivity);
	await page.clock.runFor(500);
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.holderChallengeId).toBeUndefined();
	const resumed = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(resumed.settledAtMs).toBeGreaterThanOrEqual(resumeBoundaryMs);
	expect(resumed.lastHolderResponseAtMs).toBeGreaterThanOrEqual(resumeBoundaryMs);
	expect(resumed.participant.find((member) => member.pubkey === ownerPubkey)?.calamityMs).toBe(stoppedOwner.calamityMs);
});

test('organizer local safety stop hides touch targets and resumes presentation after activity returns', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const organizerSecret = fixtureSecret(47);
	const targetSecret = fixtureSecret(51);
	const organizerPubkey = getPublicKey(organizerSecret);
	const targetPubkey = getPublicKey(targetSecret);
	await preparePlayer(page, organizerSecret, nowMs, 0);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const nowSeconds = Math.floor(await page.evaluate(() => Date.now() / 1_000));
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const targetPosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), targetSecret);
	const targetActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: nowSeconds, position: { x: 8, y: 5 }, content: 'active target', speechType: 'normal' }), targetSecret);
	await injectPosition(page, targetPosition);
	await injectWorldMessage(page, targetActivity);
	const seed = Array.from({ length: 10_000 }, (_, index) => `local-pause-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs >= 30_000;
	})!;
	const gameId = `${organizerPubkey}:${nowSeconds}:${'7'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey: organizerPubkey, phase: 'running', revision: 0, updatedAt: nowSeconds,
		startedAt: nowSeconds, endsAt: nowSeconds + 180, seed, ownerPubkey: organizerPubkey, effect: 'calamity', transferAt: nowSeconds * 1_000,
		participant: [organizerPubkey, targetPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: nowSeconds, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: nowSeconds * 1_000, lastHolderResponseAtMs: nowSeconds * 1_000
	};
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, nowSeconds, organizerSecret));
	const target = page.locator(`.participant[data-participant-id="${targetPubkey}"]`);
	const hud = page.locator('[data-tag-game-hud]');
	await expect(target).toHaveAttribute('data-tag-game-touch-target', 'true');
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectTagGameStatePublishes(): void } }).__relayStartupTest.rejectTagGameStatePublishes());
	await page.clock.runFor(23_500);
	await expect.poll(async () => {
		const event = await latestGameEvent(page, gameId);
		return parseTagGameEvent(event, CHANNEL_ID)?.state.holderChallengeId ?? null;
	}).toBeTruthy();
	const locallyStoppedAttempt = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(locallyStoppedAttempt.settledAtMs).toBe(nowSeconds * 1_000 + 23_000);
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'false');
	await expect(hud.locator('[data-tag-game-effect] span')).toHaveText('安全停止中・効果停止');
	await expect(hud.locator('[data-tag-game-cooldown]')).toHaveText('効果停止中');
	await expect(target).not.toHaveAttribute('data-tag-game-touch-target', 'true');
	const unifiedHud = page.locator('[data-unified-status-hud]');
	const pausedExpiry = await unifiedHud.getAttribute('data-current-expires-at-ms');
	const pausedPoints = await unifiedHud.getAttribute('data-current-points');
	await page.clock.runFor(2_000);
	await expect(unifiedHud).toHaveAttribute('data-current-expires-at-ms', pausedExpiry ?? '');
	await expect(unifiedHud).toHaveAttribute('data-current-points', pausedPoints ?? '');
	const touchCountBefore = (await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length;
	await page.keyboard.press('ArrowRight');
	await expect(page.locator(`.participant[data-participant-id="${organizerPubkey}"]`)).toHaveAttribute('data-position', '7,5');
	expect((await relayState(page)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch')).toHaveLength(touchCountBefore);

	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowTagGameStatePublishes(): void } }).__relayStartupTest.allowTagGameStatePublishes());
	const resumedAtMs = await page.evaluate(() => Date.now());
	const resumedActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: Math.floor(resumedAtMs / 1_000),
		position: { x: 7, y: 5 }, content: 'organizer activity resumed', speechType: 'normal' }), organizerSecret);
	await injectWorldMessage(page, resumedActivity);
	await page.clock.runFor(500);
	await expect(hud.locator('[data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect(hud.locator('[data-tag-game-effect] span')).toHaveText('所持者が追いかけて押し付ける');
	await expect(target).toHaveAttribute('data-tag-game-touch-target', 'true');
});

test('keeps a valid precheck response as local activity when 37070 updates fail', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(36);
	const holderSecret = fixtureSecret(38);
	const hostPubkey = getPublicKey(hostSecret);
	const holderPubkey = getPublicKey(holderSecret);
	await preparePlayer(page, hostSecret, nowMs, 0, false);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const startedAt = await page.evaluate(() => Math.floor(Date.now() / 1_000));
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const holderActivity = finalizeEvent(buildWorldMessageTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 },
		content: 'holder is active', speechType: 'normal' }), holderSecret);
	await injectWorldMessage(page, holderActivity);
	const seed = Array.from({ length: 10_000 }, (_, index) => `precheck-response-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'benefit' && schedule[0].durationMs >= 40_000;
	})!;
	const gameId = `${hostPubkey}:${startedAt}:${'e'.repeat(64)}`;
	const running: TagGameState = {
		gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 180, seed, ownerPubkey: holderPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
		participant: [hostPubkey, holderPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000
	};
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectTagGameStatePublishes(): void } }).__relayStartupTest.rejectTagGameStatePublishes());
	await injectRealtime(page, finalizeTagGameState(running, CHANNEL_ID, startedAt, hostSecret));
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await page.clock.runFor(15_500);
	const precheck = await latestTagGameAction(page, hostPubkey, 'response-challenge');
	expect(parseTagGameActionEvent(precheck, CHANNEL_ID)?.payload).toMatchObject({ stage: 'precheck' });
	const challengeId = parseTagGameActionEvent(precheck, CHANNEL_ID)!.payload.challengeId as string;
	await page.clock.runFor(500);
	const response = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'response', runNumber: 1,
		nonce: 'f'.repeat(32), createdAt: await page.evaluate(() => Math.floor(Date.now() / 1_000)), payload: { challengeId } }), holderSecret);
	await injectRealtime(page, response);
	const precheckCountAfterResponse = await page.evaluate((pubkey) => (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; pubkey?: string; tags: string[][]; content: string }> } } }).__relayStartupTest.state.published
		.filter((event) => event.kind === 27070 && event.pubkey === pubkey && JSON.parse(event.content).stage === 'precheck').length, hostPubkey);
	await page.clock.runFor(8_000);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect(page.locator('[data-tag-game-hud]')).not.toContainText('応答確認中・効果停止');
	const hostStates = (await relayState(page)).state.published.filter((event) => event.kind === TAG_GAME_KIND && event.pubkey === hostPubkey);
	expect(hostStates.some((event) => parseTagGameEvent(event as unknown as NostrEvent, CHANNEL_ID)?.state.holderChallengeId)).toBe(false);
	await page.clock.runFor(6_000);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect-active]')).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 27070 &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'response-challenge' &&
		parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.payload.stage === 'precheck').length).toBe(precheckCountAfterResponse);
});

test('host silence is detected only while the local Relay connection is active', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const selfSecret = fixtureSecret(43);
	await preparePlayer(page, selfSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	const remoteHostSecret = fixtureSecret(51);
	const remoteHostPubkey = getPublicKey(remoteHostSecret);
	const joinerPubkey = getPublicKey(selfSecret);
	const transitionSeed = Array.from({ length: 10_000 }, (_, index) => `host-silence-${index}`).find((candidate) => {
		const schedule = createTagGameSchedule(candidate);
		return schedule[0].effect === 'calamity' && schedule[0].durationMs === 10_000 && schedule[1].effect === 'benefit';
	});
	expect(transitionSeed).toBeTruthy();
	const startedAtMs = await page.evaluate(() => Date.now());
	const startedAt = Math.floor(startedAtMs / 1_000);
	const gameId = `${remoteHostPubkey}:${startedAt}:${'d'.repeat(64)}`;
	const active: TagGameState = {
		gameId, hostPubkey: remoteHostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 180, seed: transitionSeed!, ownerPubkey: remoteHostPubkey, effect: 'calamity', transferAt: startedAtMs,
		participant: [remoteHostPubkey, joinerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAtMs
	};
	const signed = finalizeTagGameState(active, CHANNEL_ID, startedAt, remoteHostSecret);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	const hostActivity = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 }, slot: 1, runNumber: 1 }), remoteHostSecret);
	await injectPosition(page, hostActivity);
	const relayStateBeforeProbe = (await relayState(page)).state.requests.length;
	await injectRealtime(page, signed);
	await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-realtime-status', 'active');
	const holder = page.locator(`.participant[data-participant-id="${remoteHostPubkey}"]`);
	await expect(holder).toHaveAttribute('data-tag-game-effect', 'calamity');
	await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'true');
	await expect(holder.locator('.tag-game-holder-label')).toContainText('災厄');
	await expect(holder.locator('.tag-game-holder-label')).not.toContainText('寿命−1時間/秒');
	const cooldownLine = page.locator('[data-tag-game-cooldown-line]');
	await expect(cooldownLine).toBeVisible();
	const cooldownInitialWidth = await cooldownLine.locator('span').evaluate((element) => element.getBoundingClientRect().width);
	await page.clock.runFor(700);
	const cooldownShortenedWidth = await cooldownLine.locator('span').evaluate((element) => element.getBoundingClientRect().width);
	expect(cooldownShortenedWidth).toBeLessThan(cooldownInitialWidth);
	await page.clock.runFor(1_500);
	await expect(cooldownLine).toHaveCount(0);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者が追いかけて押し付ける');
		await page.clock.runFor(10_000);
		await expect(holder).toHaveAttribute('data-tag-game-effect', 'benefit');
		await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'true');
		await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
		await expect(page.locator('[data-tag-game-cooldown]')).toHaveCount(0);
	const benefit = { ...active, revision: 1, updatedAt: startedAt + 1, effect: 'benefit' as const };
	await injectRealtime(page, finalizeTagGameState(benefit, CHANNEL_ID, startedAt + 1, remoteHostSecret));
	await expect(holder).toHaveAttribute('data-tag-game-effect', 'benefit');
	await expect(holder.locator('.tag-game-holder-label')).not.toContainText('+50pt/秒');
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveCount(0);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
	const challenge = finalizeTagGameState({ ...benefit, revision: 2, updatedAt: startedAt + 10, holderChallengeId: 'f'.repeat(32), holderChallengeStartedAtMs: (startedAt + 10) * 1_000 }, CHANNEL_ID, startedAt + 10, remoteHostSecret);
	await injectRealtime(page, challenge);
	await expect(page.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveText('効果停止中');
	await expect(page.locator('[data-tag-game-leave]')).toBeVisible();
	await expect(holder).toHaveAttribute('data-tag-game-effect-active', 'false');
	await page.clock.runFor(31_000);
	await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(relayStateBeforeProbe);
	await page.clock.runFor(6_000);
	await expect(page.getByText('中断')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
});

test('organizer is auto-consented, and proposal expiry removes nonresponders before a fresh proposal', async ({ page }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const consentSecret = fixtureSecret(43);
	const silentSecret = fixtureSecret(47);
	const hostPubkey = getPublicKey(hostSecret);
	const consentPubkey = getPublicKey(consentSecret);
	const silentPubkey = getPublicKey(silentSecret);
	await preparePlayer(page, hostSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	await openTagGameTerminal(page);
	await page.getByRole('button', { name: '鬼ごっこを開催' }).click();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
	const gameId = parseTagGameEvent(await latestPublished(page, TAG_GAME_KIND, hostPubkey), CHANNEL_ID)!.state.gameId;
	const lobby = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	const createdAt = lobby.updatedAt + 1;
	const populatedLobby: TagGameState = { ...lobby, updatedAt: createdAt, participant: [hostPubkey, consentPubkey, silentPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: createdAt, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })) };
	await injectRealtime(page, finalizeTagGameState(populatedLobby, CHANNEL_ID, createdAt, hostSecret));
	await page.clock.runFor(2_000);
	await page.getByRole('button', { name: '開始を提案' }).click();
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.phase).toBe('proposed');
	const firstProposal = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(firstProposal.participant.find((member) => member.pubkey === hostPubkey)).toMatchObject({ consentProposalId: firstProposal.proposalId, consented: true });
	const consent = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'consent', runNumber: 1, nonce: 'c'.repeat(32), createdAt: createdAt + 1, payload: { proposalId: firstProposal.proposalId! } }), consentSecret);
	await injectRealtime(page, consent);
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.participant.find((member) => member.pubkey === consentPubkey)?.consented).toBe(true);
	await page.clock.runFor(31_000);
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.phase).toBe('lobby');
	const returned = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(returned.participant.map((member) => member.pubkey)).toEqual([hostPubkey, consentPubkey]);
	await expect(page.getByRole('button', { name: '開始を提案' })).toBeVisible();
	await page.getByRole('button', { name: '開始を提案' }).click();
	await expect.poll(async () => parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)?.state.proposalId).not.toBe(firstProposal.proposalId);
	const secondProposal = parseTagGameEvent(await latestGameEvent(page, gameId), CHANNEL_ID)!.state;
	expect(secondProposal.participant.find((member) => member.pubkey === hostPubkey)).toMatchObject({ consentProposalId: secondProposal.proposalId, consented: true });
	const resetConsent = secondProposal.participant.find((member) => member.pubkey === consentPubkey)!;
	expect(resetConsent.consentProposalId).toBeUndefined();
	expect(resetConsent.consented).toBe(false);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').getByText('開催者は同意済み')).toBeVisible();
});

test('same-second death exit ends a two-player game when the non-holder leaves', async ({ browser }) => {
	test.setTimeout(60_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const startedAt = Math.floor(nowMs / 1_000);
	const hostSecret = fixtureSecret(53);
	const participantSecret = fixtureSecret(59);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs), preparePlayer(participantPage, participantSecret, nowMs)]);
		await moveRelaySelfTo(hostPage, { x: 7, y: 5 });
		await moveRelaySelfTo(participantPage, { x: 8, y: 5 });
		const gameId = `${hostPubkey}:${startedAt}:${'f'.repeat(64)}`;
		const state: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 180, seed: 'a'.repeat(64), ownerPubkey: hostPubkey, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [{ pubkey: hostPubkey, runNumber: 1 }, { pubkey: participantPubkey, runNumber: 2 }].map(({ pubkey, runNumber }) => ({ pubkey, runNumber, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		const running = finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
		const worldSecond = startedAt + 1;
		const delayedOldRunExit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt, position: { x: 8, y: 5 }, slot: 'exit', runNumber: 1, exitReason: 'death' }), participantSecret);
		const activePosition = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: worldSecond, position: { x: 8, y: 5 }, slot: 1, runNumber: 2 }), participantSecret);
		const deathExit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: worldSecond, position: { x: 8, y: 5 }, slot: 'exit', runNumber: 2, exitReason: 'death' }), participantSecret);
		await injectRealtime(hostPage, running);
		await injectRealtime(participantPage, running);
		await injectPosition(hostPage, delayedOldRunExit);
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await injectPosition(hostPage, activePosition);
		await expect(hostPage.locator(`.participant[data-participant-id="${participantPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await injectPosition(hostPage, deathExit);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('interrupted');
		const final = parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state;
		expect(final?.endReason).toBe('too-few-participants');
		expect(final?.participant.find((member) => member.pubkey === participantPubkey)?.status).toBe('dead');
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('organizer-confirmed leave settles the two-player game and releases the quitter lock', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(61);
	const participantSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([
			preparePlayer(hostPage, hostSecret, nowMs, 200_000), preparePlayer(participantPage, participantSecret, nowMs, 200_000)
		]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 })]);
		const hostPosition = await latestWorldState(hostPage, hostPubkey);
		const participantPosition = await latestWorldState(participantPage, participantPubkey);
		await Promise.all([injectPosition(hostPage, participantPosition), injectPosition(participantPage, hostPosition)]);

		await openTagGameTerminal(hostPage);
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const lobbyEvent = await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey);
		const lobby = parseTagGameEvent(lobbyEvent, CHANNEL_ID)!.state;
		await injectRealtime(participantPage, lobbyEvent);
		await openTagGameTerminal(participantPage);
		await expect(participantPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await injectRealtime(participantPage, lobbyEvent);
		await expect(participantPage.getByRole('button', { name: '参加申請' })).toBeVisible();
		await participantPage.getByRole('button', { name: '参加申請' }).click();
		await expect.poll(async () => (await relayState(participantPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === participantPubkey)).toBe(true);
		const join = await latestPublished(participantPage, 27070, participantPubkey);
		await injectRealtime(hostPage, join);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.participant.length).toBe(2);
		await injectRealtime(participantPage, await latestGameEvent(hostPage, lobby.gameId));

		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.phase).toBe('proposed');
		const proposal = await latestGameEvent(hostPage, lobby.gameId);
		await injectRealtime(participantPage, proposal);
		await expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible();
		const hostCard = hostPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('li').filter({ hasText: 'あなたの開催' });
		await expect(hostCard.getByText('開催者は同意済み')).toBeVisible();
		await expect(hostCard.getByRole('button', { name: '開始に同意' })).toHaveCount(0);
		await expect(hostCard.getByRole('button', { name: '今回は辞退' })).toHaveCount(0);
		await participantPage.getByRole('button', { name: '開始に同意' }).click();
		await expect.poll(async () => (await relayState(participantPage)).state.published.some((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toBe(true);
		const participantConsent = await latestPublished(participantPage, 27070, participantPubkey);
		await injectRealtime(hostPage, participantConsent);
		expect((await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toHaveLength(0);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.phase).toBe('countdown');
		await injectRealtime(participantPage, await latestGameEvent(hostPage, lobby.gameId));
		await hostPage.clock.runFor(6_000);
		const runningEvent = await latestGameEvent(hostPage, lobby.gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		expect(running.phase).toBe('running');
		await Promise.all([hostPage, participantPage].map((page) => page.clock.setSystemTime(running.startedAt! * 1_000 + 5_000)));
		await injectRealtime(participantPage, runningEvent);
		await Promise.all([hostPage, participantPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0)));
		await expect.poll(async () => (await tagGamePersistence(participantPage)).lock).toMatchObject({ gameId: lobby.gameId });
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage)]);
		await Promise.all([hostPage, participantPage].map((page) => page.getByRole('button', { name: '閉じる', exact: true }).click()));

		const leaverPage = running.ownerPubkey === hostPubkey ? hostPage : participantPage;
		const leaverPubkey = leaverPage === hostPage ? hostPubkey : participantPubkey;
		const leaveButton = leaverPage.locator(`[data-tag-game-leave="${lobby.gameId}"]`);
		await expect(leaveButton).toBeVisible();
		await leaveButton.click();
		await expect(leaveButton).toBeVisible();
		expect(await tagGamePersistence(leaverPage)).toMatchObject({ lock: { gameId: lobby.gameId } });
		const leaveAction = await latestPublished(leaverPage, 27070, leaverPubkey);
		expect(parseTagGameActionEvent(leaveAction, CHANNEL_ID)?.action).toBe('leave');
		await injectRealtime(hostPage, leaveAction);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.phase).toBe('interrupted');
		const finalEvent = await latestGameEvent(hostPage, lobby.gameId);
		const finalState = parseTagGameEvent(finalEvent, CHANNEL_ID)!.state;
		const quitter = finalState.participant.find((member) => member.pubkey === leaverPubkey)!;
		expect(finalState.endReason).toBe(leaverPubkey === hostPubkey ? 'host-exit' : 'too-few-participants');
		expect(quitter.status).toBe('left');
		expect(quitter.benefitMs + quitter.calamityMs).toBeGreaterThan(0);
		if (leaverPage !== hostPage) await injectRealtime(leaverPage, finalEvent);
		await expect.poll(async () => tagGamePersistence(leaverPage)).toMatchObject({
			lock: null,
			receipt: { gameId: lobby.gameId, points: quitter.points, lifespanLossMs: quitter.lifespanLossMs }
		});
		await expect(leaverPage.locator('[data-tag-game-hud]')).toHaveCount(0);
		await openTagGameTerminal(leaverPage);
		await expect(leaverPage.getByRole('dialog', { name: '鬼ごっこ' }).locator('.results')).toContainText('退出');
		await leaverPage.getByRole('dialog', { name: '鬼ごっこ' }).getByRole('button', { name: '閉じる', exact: true }).click();

		await leaverPage.clock.setSystemTime(running.startedAt! * 1_000 + 10_000);
		await moveRelaySelfTo(leaverPage, { x: 13, y: 3 });
		await leaverPage.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = leaverPage.getByRole('dialog', { name: '能力強化' });
		await expect(dialog).toBeVisible();
		await dialog.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt）' }).click();
		await expect(dialog).toContainText('推論効率 Lv2');
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('organizer cancellation terminates the lobby, clears pending reservations, and ignores delayed joins', async ({ browser }) => {
	test.setTimeout(45_000);
	const hostPage = await browser.newPage();
	const joinerPage = await browser.newPage();
	const nowMs = Date.now();
	const hostSecret = fixtureSecret(41);
	const joinerSecret = fixtureSecret(43);
	const hostPubkey = getPublicKey(hostSecret);
	const joinerPubkey = getPublicKey(joinerSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs, 0, true), preparePlayer(joinerPage, joinerSecret, nowMs)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 6 }), moveRelaySelfTo(joinerPage, { x: 8, y: 5 })]);
		await synchronizeBrowserClocks([hostPage, joinerPage]);
		await openTagGameTerminal(hostPage);
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const lobbyEvent = await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey);
		const lobby = parseTagGameEvent(lobbyEvent, CHANNEL_ID)!.state;
		await injectRealtime(joinerPage, lobbyEvent);
		await openTagGameTerminal(joinerPage);
		await expect(joinerPage.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		await injectRealtime(joinerPage, lobbyEvent);
		await expect(joinerPage.getByRole('button', { name: '参加申請' })).toBeVisible();
		await joinerPage.getByRole('button', { name: '参加申請' }).click();
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toMatchObject({ gameId: lobby.gameId, expiresAtMs: expect.any(Number) });
		await expect.poll(async () => (await relayState(joinerPage)).state.published.some((event) => event.kind === 27070 && event.pubkey === joinerPubkey)).toBe(true);
		const delayedJoin = await latestPublished(joinerPage, 27070, joinerPubkey);
		await injectRealtime(hostPage, delayedJoin);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.participant.length).toBe(2);
		await injectRealtime(joinerPage, await latestGameEvent(hostPage, lobby.gameId));
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toEqual({ gameId: lobby.gameId,
			identity: expect.any(Object), runNumber: 1 });
		await expect(hostPage.getByRole('button', { name: '募集を取り消す' })).toBeVisible();
		await hostPage.getByRole('button', { name: '募集を取り消す' }).click();
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.endReason).toBe('host-cancelled');
		const cancelled = await latestGameEvent(hostPage, lobby.gameId);
		await injectRealtime(hostPage, delayedJoin);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.endReason).toBe('host-cancelled');
		await expect(hostPage.getByText('あなたの開催').first()).toHaveCount(0);
		await expect(hostPage.locator('.results')).toHaveCount(0);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
		await hostPage.reload();
		await moveRelaySelfTo(hostPage, { x: 7, y: 6 });
		await expect(hostPage.locator('.participant[data-self="true"]')).toBeVisible();
		await openTagGameTerminal(hostPage);
		await injectRealtime(hostPage, cancelled);
		await expect(hostPage.getByText('あなたの開催').first()).toHaveCount(0);
		await expect(hostPage.locator('.results')).toHaveCount(0);
		await expect(hostPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
		await expect.poll(async () => (await tagGamePersistence(hostPage)).reservation).toBeNull();
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const replacement = parseTagGameEvent(await latestPublished(hostPage, TAG_GAME_KIND, hostPubkey), CHANNEL_ID)!.state;
		expect(replacement.gameId).not.toBe(lobby.gameId);
		await expect(hostPage.getByText('あなたの開催').first()).toBeVisible();
		await joinerPage.evaluate((event) => (window as typeof window & { __relayStartupTest: { queueRealtimeBootstrapEvent(event: object): void } }).__relayStartupTest.queueRealtimeBootstrapEvent(event), cancelled);
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).not.toBeNull();
		const activeRealtimeCountBeforeReload = await joinerPage.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount());
		expect(await joinerPage.evaluate((id) => sessionStorage.getItem('relay-startup-queued-realtime-bootstrap-events')?.includes(id) ?? false, cancelled.id)).toBe(true);
		await joinerPage.clock.setSystemTime(cancelled.created_at * 1_000 + 91_000);
		await joinerPage.reload();
		await expect.poll(async () => joinerPage.evaluate((id) => (window as typeof window & { __relayStartupTest: { state: { realtimeHistory: Array<{ id: string }> } } }).__relayStartupTest.state.realtimeHistory.some((event) => event.id === id), cancelled.id)).toBe(true);
		await openTagGameTerminal(joinerPage);
		await expect.poll(async () => (await relayState(joinerPage)).state.requests.some((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(lobby.gameId)))).toBe(true);
		await expect.poll(async () => (await tagGamePersistence(joinerPage)).reservation).toBeNull();
		const recoveryRequests = (await relayState(joinerPage)).state.requests.filter((request) => request.filters.some((filter) =>
			(filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND)));
		expect(recoveryRequests.length).toBeGreaterThan(0);
		const recoveryRequest = recoveryRequests.find((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(lobby.gameId)));
		expect(recoveryRequest).toBeDefined();
		const discoverySince = recoveryRequest?.filters.find((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND) && !filter['#d'])?.since as number;
		expect(discoverySince).toBeGreaterThan(cancelled.created_at);
		expect(discoverySince).toBeLessThan(cancelled.created_at + 15);
		await expect.poll(async () => joinerPage.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(activeRealtimeCountBeforeReload);
		await expect(joinerPage.getByRole('button', { name: '鬼ごっこを開催' })).toBeVisible();
	} finally {
		await Promise.all([hostPage.close(), joinerPage.close()]);
	}
});

test('releases an approved reservation after finite known-game recovery when Relay has no retained state', async ({ browser }) => {
	test.setTimeout(60_000);
	const nowMs = Date.now();
	const page = await browser.newPage();
	const selfSecret = fixtureSecret(53);
	const gameId = `${getPublicKey(fixtureSecret(47))}:${Math.floor(nowMs / 1_000)}:${'c'.repeat(64)}`;
	try {
		await preparePlayer(page, selfSecret, nowMs, 0, true);
		await moveRelaySelfTo(page, { x: 8, y: 5 });
		await page.evaluate((reservationGameId) => new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account', 8);
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
				const store = transaction.objectStore('persona-bubble-field-player-state');
				const read = store.get('player-lifecycle');
				read.onsuccess = () => {
					const current = read.result;
					const activeRun = current.mode.activeRun;
					store.put({ ...current, tagGame: { reservation: { gameId: reservationGameId, identity: activeRun.identity, runNumber: activeRun.runNumber } } }, 'player-lifecycle');
				};
				transaction.oncomplete = () => { database.close(); resolve(); };
				transaction.onerror = () => { database.close(); reject(transaction.error); };
			};
		}), gameId);
		await page.clock.setSystemTime(nowMs + 91_000);
		await page.reload();
		await openTagGameTerminal(page);
		await expect(page.locator(`[data-tag-game-cancel-reservation="${gameId}"]`)).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter['#d'] as string[] | undefined)?.includes(gameId)))).toBe(true);
		await page.clock.fastForward(31_000);
		await expect.poll(async () => (await tagGamePersistence(page)).reservation).toBeNull();
	} finally {
		await page.close();
	}
});

test('requests a missing remote Run position proof and accepts the next input after it arrives', async ({ browser }) => {
	test.setTimeout(90_000);
	const hostPage = await browser.newPage();
	const participantPage = await browser.newPage();
	const nowMs = Date.now();
	const nowSeconds = Math.floor(nowMs / 1_000);
	const hostSecret = fixtureSecret(61);
	const participantSecret = fixtureSecret(63);
	const hostPubkey = getPublicKey(hostSecret);
	const participantPubkey = getPublicKey(participantSecret);
	try {
		await Promise.all([preparePlayer(hostPage, hostSecret, nowMs, 200_000), preparePlayer(participantPage, participantSecret, nowMs, 200_000)]);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 8, y: 5 })]);
		const hostPosition = await latestWorldState(hostPage, hostPubkey);
		await injectPosition(participantPage, hostPosition);
		const activeMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' }, createdAt: nowSeconds,
			position: { x: 8, y: 5 }, content: 'fresh World activity', speechType: 'normal'
		}), participantSecret);
		await hostPage.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), activeMessage);
		await participantPage.evaluate((next) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(next), activeMessage);

		const startedAt = nowSeconds - 5;
		const seed = Array.from({ length: 10_000 }, (_, index) => `missing-proof-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'calamity')!;
		const gameId = `${hostPubkey}:${startedAt}:${'9'.repeat(64)}`;
		const running: TagGameState = {
			gameId, hostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 180, seed, ownerPubkey: hostPubkey, effect: 'calamity', transferAt: startedAt * 1_000,
			participant: [hostPubkey, participantPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		const runningEvent = finalizeTagGameState(running, CHANNEL_ID, nowSeconds, hostSecret);
		// The participant's one-time Run proof refresh starts when its own
		// signed running state arrives. Block it before that transition so this
		// scenario exercises recovery after the initial publication fails.
		await participantPage.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await Promise.all([injectRealtime(hostPage, runningEvent), injectRealtime(participantPage, runningEvent)]);
		await expect(hostPage.locator(`.participant[data-participant-id="${participantPubkey}"]`)).toHaveAttribute('data-tag-game-touch-target', 'true');
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');

		await dragRelayJoystick(hostPage, { x: 100, y: 0 }, { x: 7, y: 5 });
		await expect(hostPage.locator(`.participant[data-participant-id="${hostPubkey}"]`)).toHaveAttribute('data-tag-game-touch-attempt', /\d+/);
		await expect.poll(async () => latestTagGameAction(hostPage, hostPubkey, 'touch').then(() => true, () => false)).toBe(true);
		const firstTouch = await latestTagGameAction(hostPage, hostPubkey, 'touch');
		const firstPayload = parseTagGameActionEvent(firstTouch, CHANNEL_ID)!.payload;
		expect(firstPayload.targetProof).toBeUndefined();
		await injectRealtime(hostPage, firstTouch);
		await expect.poll(async () => latestTagGameAction(hostPage, hostPubkey, 'position-refresh-request').then(() => true, () => false)).toBe(true);
		const refreshRequest = await latestTagGameAction(hostPage, hostPubkey, 'position-refresh-request');
		expect(parseTagGameActionEvent(refreshRequest, CHANNEL_ID)?.payload).toMatchObject({ targetPubkey: participantPubkey, targetRunNumber: 1 });
		const duplicateRefreshRequest = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL_ID, gameId, action: 'position-refresh-request', runNumber: 1,
			nonce: 'b'.repeat(32), createdAt: nowSeconds, payload: { targetPubkey: participantPubkey, targetRunNumber: 1 } }), hostSecret);
		await Promise.all([injectRealtime(participantPage, refreshRequest), injectRealtime(participantPage, duplicateRefreshRequest)]);
		await participantPage.clock.runFor(1_100);
		const rejectedPositionIds = await participantPage.evaluate(() => [...new Set((window as typeof window & { __relayStartupTest: { state: { rejectedPositionPublishIds: string[] } } }).__relayStartupTest.state.rejectedPositionPublishIds)]);
		expect(rejectedPositionIds.length).toBeGreaterThan(0);
		await participantPage.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		// Retry timing and the existing 30079 per-second slot planner are
		// independent bounds; allow both to advance after the Relay recovers.
		await participantPage.clock.runFor(2_200);
		await expect.poll(async () => {
			const latest = await latestWorldState(participantPage, participantPubkey);
			return !rejectedPositionIds.includes(latest.id) && latest.tags.some((tag) => tag[0] === 'r' && tag[1] === '1');
		}).toBe(true);
		const refreshedPosition = await latestWorldState(participantPage, participantPubkey);
		expect(refreshedPosition.tags).toContainEqual(['r', '1']);
		expect(refreshedPosition.id).not.toBe((await latestWorldState(hostPage, participantPubkey).catch(() => null))?.id);
		await injectPosition(hostPage, refreshedPosition);
		await injectPosition(participantPage, refreshedPosition);
		await hostPage.clock.runFor(600);
		await dragRelayJoystick(hostPage, { x: 100, y: 0 }, { x: 7, y: 5 });
		await expect.poll(async () => (await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'touch').length).toBeGreaterThan(1);
		const retryTouch = (await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === hostPubkey)
			.map((event) => event as unknown as NostrEvent).reverse().find((event) => parseTagGameActionEvent(event, CHANNEL_ID)?.action === 'touch')!;
		const retryProof = parseTagGameActionEvent(retryTouch, CHANNEL_ID)!.payload.targetProof as { positionEvidenceEventId: string };
		expect(retryProof.positionEvidenceEventId).toBe(refreshedPosition.id);
		await injectRealtime(hostPage, retryTouch);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.ownerPubkey).toBe(participantPubkey);
	} finally {
		await Promise.all([hostPage.close(), participantPage.close()]);
	}
});

test('does not show unselected games and lets a spectator choose and clear one target', async ({ page }) => {
	const nowMs = Date.now();
	const spectatorSecret = fixtureSecret(19);
	const ownerASecret = fixtureSecret(20);
	const runnerASecret = fixtureSecret(21);
	const ownerBSecret = fixtureSecret(23);
	const runnerBSecret = fixtureSecret(29);
	const startedAt = Math.floor(nowMs / 1_000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://relay.test/' };
	await preparePlayer(page, spectatorSecret, nowMs);
	await moveRelaySelfTo(page, { x: 7, y: 5 });
	const players = [
		{ secret: ownerASecret, position: { x: 2, y: 2 } }, { secret: runnerASecret, position: { x: 3, y: 2 } },
		{ secret: ownerBSecret, position: { x: 5, y: 2 } }, { secret: runnerBSecret, position: { x: 6, y: 2 } }
	] as const;
	for (const player of players) {
		const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: startedAt + 1, position: player.position, slot: 1, runNumber: 1 }), player.secret);
		await injectPosition(page, event);
	}
	await page.clock.setSystemTime(startedAt * 1_000 + 250);
	await page.clock.runFor(1_000);
	const cooldownNowMs = await page.evaluate(() => Date.now());
	const benefitSeed = Array.from({ length: 1_000 }, (_, index) => `watch-benefit-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
	function hostedGame(hostSecret: Uint8Array, otherSecret: Uint8Array, marker: string, phase: 'countdown' | 'running' = 'running'): NostrEvent {
		const host = getPublicKey(hostSecret);
		const other = getPublicKey(otherSecret);
		const state: TagGameState = {
			gameId: `${host}:${startedAt}:${marker.repeat(64)}`, hostPubkey: host, phase, revision: 0, updatedAt: startedAt,
			...(phase === 'countdown' ? { startAt: startedAt + 10 } : {}),
		startedAt, endsAt: startedAt + 180, seed: benefitSeed, ownerPubkey: host, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [host, other].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		return finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
	}
	const gameA = hostedGame(ownerASecret, runnerASecret, 'a', 'countdown');
	const initialGameB = parseTagGameEvent(hostedGame(ownerBSecret, runnerBSecret, 'b'), CHANNEL_ID)!.state;
	const gameBUpdatedAt = Math.floor(cooldownNowMs / 1_000);
	const gameB = finalizeTagGameState({ ...initialGameB, updatedAt: gameBUpdatedAt, transferAt: cooldownNowMs + 500 }, CHANNEL_ID, gameBUpdatedAt, ownerBSecret);
	const gameAId = parseTagGameEvent(gameA, CHANNEL_ID)!.state.gameId;
	const gameBId = parseTagGameEvent(gameB, CHANNEL_ID)!.state.gameId;
	await Promise.all([injectRealtime(page, gameA), injectRealtime(page, gameB)]);
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);

	await openTagGameTerminal(page);
	await page.locator(`[data-tag-game-watch="${gameBId}"]`).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('所持者以外が追いかけて奪う');
	const watchedGame = parseTagGameEvent(gameB, CHANNEL_ID)!.state;
	const desktopHud = page.locator('[data-tag-game-hud]');
	await expect(desktopHud.locator('[data-tag-game-hud-footer]')).toHaveCount(0);
	const desktopHeight = await desktopHud.evaluate((element) => element.getBoundingClientRect().height);
	const desktopLine = desktopHud.locator('[data-tag-game-cooldown-line]');
	await expect(desktopLine).toBeVisible();
	const desktopAnimationDelaySeconds = Number.parseFloat(await desktopLine.evaluate((element) => getComputedStyle(element.querySelector('span')!).animationDelay));
	expect(desktopAnimationDelaySeconds).toBeGreaterThanOrEqual(0.35);
	expect(desktopAnimationDelaySeconds).toBeLessThanOrEqual(0.5);
	await page.clock.runFor(2_200);
	await expect(desktopLine).toBeVisible();
	await page.clock.runFor(400);
	await expect(desktopLine).toHaveCount(0);
	expect(await desktopHud.evaluate((element) => element.getBoundingClientRect().height)).toBe(desktopHeight);

	await page.setViewportSize({ width: 390, height: 844 });
	const mobileHeight = await desktopHud.evaluate((element) => element.getBoundingClientRect().height);
	const mobileNowMs = await page.evaluate(() => Date.now());
	const mobileTransfer = finalizeTagGameState({ ...watchedGame, revision: 1, updatedAt: Math.floor(mobileNowMs / 1_000), transferAt: mobileNowMs + 500 }, CHANNEL_ID, Math.floor(mobileNowMs / 1_000), ownerBSecret);
	await injectRealtime(page, mobileTransfer);
	await expect(desktopHud.locator('[data-tag-game-hud-footer]')).toHaveCount(0);
	await expect(desktopHud.locator('[data-tag-game-cooldown-line]')).toBeVisible();
	await page.clock.runFor(2_700);
	await expect(desktopHud.locator('[data-tag-game-cooldown-line]')).toHaveCount(0);
	expect(await desktopHud.evaluate((element) => element.getBoundingClientRect().height)).toBe(mobileHeight);

	await page.clock.setSystemTime(watchedGame.endsAt! * 1_000 + 1_000);
	await page.clock.runFor(1_100);
	await expect(page.locator('[data-tag-game-remaining]')).toHaveText('00:00');
	await expect(page.locator('[data-tag-game-cooldown]')).toHaveText('最終精算中');
	await expect(page.locator('[data-tag-game-leave]')).toHaveCount(0);
	await injectRealtime(page, gameB);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible();
	const startAAt = Math.max(Math.floor(Date.now() / 1_000), startedAt + 1);
	const countdownA = parseTagGameEvent(gameA, CHANNEL_ID)!.state;
	const runningA = finalizeTagGameState({ ...countdownA, phase: 'running', revision: 1, updatedAt: startAAt, startedAt: startAAt, endsAt: startAAt + 180, settledAtMs: startAAt * 1_000 }, CHANNEL_ID, startAAt, ownerASecret);
	await injectRealtime(page, runningA);
	await expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await page.getByRole('button', { name: '観戦を解除' }).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);
});
