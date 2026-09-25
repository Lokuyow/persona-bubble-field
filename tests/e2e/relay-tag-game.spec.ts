import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { buildTagGameActionTemplate, createTagGameSchedule, finalizeTagGameState, parseTagGameActionEvent, parseTagGameEvent, TAG_GAME_KIND, type TagGameState } from '../../src/lib/tagGame';
import { MENDING_TERMINAL, TAG_GAME_TERMINAL } from '../../src/lib/fieldFacilities';
import { resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
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
	const normalHud = page.locator('.lifespan-hud');
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
		await expect(participantTwoPage.locator('.lifespan-hud [data-mending-row]')).toBeVisible();
		await mendingDialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 });

		await openTagGameTerminal(hostPage);
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

		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('proposed');
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toBeVisible()));
		const proposal = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, proposal), injectRealtime(participantTwoPage, proposal)]);
		await Promise.all([expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '開始に同意' })).toBeVisible()]);
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
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => expect(page.getByRole('dialog', { name: '鬼ごっこ' })).toHaveCount(0)));
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantTwoPage.locator('[data-tag-game-hud]')).toBeVisible();
		const participantHudHolder = running.ownerPubkey === participantPubkey ? 'あなた' : resolveCharacterFromPubkey(running.ownerPubkey!)!.name;
		await expect(participantPage.locator('[data-tag-game-hud]')).toContainText(participantHudHolder);
		await expect(participantPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect', running.effect!);
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText(/02:5\d/);
		if (await hostPage.locator('[data-tag-game-hud] [data-tag-game-effect]').getAttribute('data-tag-game-effect-active') === 'true') {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText(running.effect === 'benefit' ? '追いかけて奪う' : '追いかけて押し付ける');
		} else {
			await expect(hostPage.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
		}
		const gamePages = new Map([[hostPubkey, hostPage], [participantPubkey, participantPage], [participantTwoPubkey, participantTwoPage]]);
		const holderHudPage = gamePages.get(running.ownerPubkey!)!;
		await expect(holderHudPage.locator('.lifespan-hud')).toHaveAttribute('data-tag-game-projection', 'true');
		if (await holderHudPage.locator('[data-tag-game-hud] [data-tag-game-effect-active]').getAttribute('data-tag-game-effect-active') === 'true') {
			await expect(holderHudPage.locator(`[data-tag-game-projection-row="${running.effect === 'benefit' ? 'points' : 'lifespan'}"]`)).toContainText(running.effect === 'benefit' ? '+50pt/秒・予測' : '-1時間/秒・予測');
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
		if (participantTwoViewport) await participantTwoPage.setViewportSize(participantTwoViewport);
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const [latestHostPosition, latestParticipantPosition, latestParticipantTwoPosition] = await Promise.all([
			latestWorldState(hostPage, hostPubkey), latestWorldState(participantPage, participantPubkey), latestWorldState(participantTwoPage, participantTwoPubkey)
		]);
		await Promise.all([
			injectPosition(hostPage, latestParticipantPosition), injectPosition(hostPage, latestParticipantTwoPosition),
			injectPosition(participantPage, latestHostPosition), injectPosition(participantPage, latestParticipantTwoPosition),
			injectPosition(participantTwoPage, latestHostPosition), injectPosition(participantTwoPage, latestParticipantPosition)
		]);

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
		const holder = cells.get(running.ownerPubkey!)!;
		const target = running.effect === 'benefit' ? [...cells.entries()].find(([pubkey, candidate]) => pubkey !== running.ownerPubkey && Math.abs(candidate.position.x - holder.position.x) + Math.abs(candidate.position.y - holder.position.y) === 1)! : [...cells.entries()].find(([pubkey, candidate]) => pubkey !== running.ownerPubkey && Math.abs(candidate.position.x - holder.position.x) + Math.abs(candidate.position.y - holder.position.y) === 1)!;
		const actorEntry = running.effect === 'benefit' ? target : [running.ownerPubkey!, holder] as const;
		const actorPubkey = actorEntry[0];
		const actor = actorEntry[1].page;
		const touchTargetPubkey = running.effect === 'benefit' ? running.ownerPubkey! : target[0];
		await expect(actor.locator(`.participant[data-participant-id="${actorPubkey}"]`)).toHaveAttribute('data-position', `${actorEntry[1].position.x},${actorEntry[1].position.y}`);
		await expect(actor.locator(`.participant[data-participant-id="${touchTargetPubkey}"]`)).toHaveAttribute('data-position', `${cells.get(touchTargetPubkey)!.position.x},${cells.get(touchTargetPubkey)!.position.y}`);
		const dx = cells.get(touchTargetPubkey)!.position.x - actorEntry[1].position.x;
		const dy = cells.get(touchTargetPubkey)!.position.y - actorEntry[1].position.y;
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			const pageNow = await page.evaluate(() => Date.now());
			const touchReadyAt = Math.max(pageNow, Math.floor((running.transferAt ?? pageNow) / 1_000) * 1_000) + 5_000;
			await page.clock.setSystemTime(touchReadyAt);
			await page.clock.runFor(10);
		}));
		await expect(actor.locator('main')).toHaveAttribute('data-realtime-status', 'active');
		const actionCountBeforeTouch = (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length;
		await dragRelayJoystick(actor, { x: dx * 100, y: dy * 100 }, actorEntry[1].position);
		await expect.poll(async () => (await relayState(actor)).state.published.filter((event) => event.kind === 27070 && event.pubkey === actorPubkey).length).toBeGreaterThan(actionCountBeforeTouch);
		await expect.poll(async () => latestTagGameAction(actor, actorPubkey, 'touch').then(() => true, () => false)).toBe(true);
		const touchAction = await latestTagGameAction(actor, actorPubkey, 'touch');
		expect(parseTagGameActionEvent(touchAction, CHANNEL_ID)?.action).toBe('touch');
		await injectRealtime(hostPage, touchAction);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.transferAt).toBeGreaterThan(running.transferAt ?? 0);
		const transferredEvent = await latestGameEvent(hostPage, gameId);
		const transferred = parseTagGameEvent(transferredEvent, CHANNEL_ID)!.state;
		await Promise.all([participantPage, participantTwoPage].map((page) => injectRealtime(page, transferredEvent)));
		const transferredHolderPage = cells.get(transferred.ownerPubkey!)!.page;
		await expect(transferredHolderPage.locator(`.participant[data-participant-id="${transferred.ownerPubkey}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
		await expect(transferredHolderPage.locator(`[data-tag-game-hud] [data-tag-game-effect="${transferred.effect}"]`)).toBeVisible();

		const endsAt = running.endsAt! * 1000;
		const channel = { channelId: CHANNEL_ID, relayHint: latestHostPosition.tags.find((tag) => tag[0] === 'e')?.[2] ?? 'wss://relay.test/' };
		const finalActivityAt = Math.floor(endsAt / 1_000) - 1;
		const finalActivity = [
			[hostSecret, { x: 7, y: 5 }], [participantSecret, { x: 7, y: 6 }], [participantTwoSecret, { x: 8, y: 5 }]
		] as const;
		// Keep ordinary signed World activity fresh at the end while fast-forwarding the host clock.
		for (const [secret, position] of finalActivity) {
			const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt: finalActivityAt, position, slot: 1, runNumber: 1 }), secret);
			await injectPosition(hostPage, event);
		}
		await hostPage.clock.setSystemTime(endsAt + 1_000);
		await hostPage.clock.runFor(250);
		await expect(hostPage.locator('[data-tag-game-remaining]')).toHaveText('00:00');
		await expect(hostPage.locator('[data-tag-game-hud]')).toContainText('最終精算中・効果停止');
		await expect(hostPage.locator('[data-tag-game-hud] [data-tag-game-effect]')).toHaveAttribute('data-tag-game-effect-active', 'false');
		await hostPage.clock.runFor(181_000);
		await hostPage.clock.runFor(2_000);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('ended');
		const finalStateEvent = await latestGameEvent(hostPage, gameId);
		await injectRealtime(participantPage, finalStateEvent);
		await injectRealtime(participantTwoPage, finalStateEvent);
		const finalState = parseTagGameEvent(finalStateEvent, CHANNEL_ID)!.state;
		const finalLocal = finalState.participant.find((member) => member.pubkey === participantPubkey)!;
		await expect.poll(async () => (await tagGamePersistence(participantPage)).receipt).toMatchObject({ gameId, points: finalLocal.points, lifespanLossMs: finalLocal.lifespanLossMs });
		await expect(participantPage.locator('.lifespan-hud')).toHaveAttribute('data-saved-points', String((await tagGamePersistence(participantPage)).savedPoints));
		await expect(participantPage.locator('.lifespan-hud')).not.toHaveAttribute('data-tag-game-projection', 'true');
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
	const startedAt = await page.evaluate(() => Math.floor(Date.now() / 1000));
	const gameId = `${remoteHostPubkey}:${startedAt}:${'d'.repeat(64)}`;
	const active: TagGameState = {
		gameId, hostPubkey: remoteHostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 180, seed: transitionSeed!, ownerPubkey: remoteHostPubkey, effect: 'calamity', transferAt: startedAt * 1000,
		participant: [remoteHostPubkey, joinerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAt * 1000
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
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('追いかけて押し付ける');
	await page.clock.runFor(10_000);
	const benefit = { ...active, revision: 1, updatedAt: startedAt + 1, effect: 'benefit' as const };
	await injectRealtime(page, finalizeTagGameState(benefit, CHANNEL_ID, startedAt + 1, remoteHostSecret));
	await expect(holder).toHaveAttribute('data-tag-game-effect', 'benefit');
	await expect(holder.locator('.tag-game-holder-label')).not.toContainText('+50pt/秒');
	await expect(page.locator('[data-tag-game-hud] [data-tag-game-effect]')).toContainText('追いかけて奪う');
	const challenge = finalizeTagGameState({ ...benefit, revision: 2, updatedAt: startedAt + 10, holderChallengeId: 'f'.repeat(32), holderChallengeStartedAtMs: (startedAt + 10) * 1_000 }, CHANNEL_ID, startedAt + 10, remoteHostSecret);
	await injectRealtime(page, challenge);
	await expect(page.locator('[data-tag-game-hud]')).toContainText('応答確認中・効果停止');
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
		await dialog.getByRole('button', { name: 'Lv2へ強化' }).first().click();
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
	function hostedGame(hostSecret: Uint8Array, otherSecret: Uint8Array, marker: string, phase: 'countdown' | 'running' = 'running'): NostrEvent {
		const host = getPublicKey(hostSecret);
		const other = getPublicKey(otherSecret);
		const state: TagGameState = {
			gameId: `${host}:${startedAt}:${marker.repeat(64)}`, hostPubkey: host, phase, revision: 0, updatedAt: startedAt,
			...(phase === 'countdown' ? { startAt: startedAt + 10 } : {}),
			startedAt, endsAt: startedAt + 180, seed: marker.repeat(64), ownerPubkey: host, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [host, other].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		return finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
	}
	const gameA = hostedGame(ownerASecret, runnerASecret, 'a', 'countdown');
	const gameB = hostedGame(ownerBSecret, runnerBSecret, 'b');
	const gameAId = parseTagGameEvent(gameA, CHANNEL_ID)!.state.gameId;
	const gameBId = parseTagGameEvent(gameB, CHANNEL_ID)!.state.gameId;
	await Promise.all([injectRealtime(page, gameA), injectRealtime(page, gameB)]);
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);

	await openTagGameTerminal(page);
	await page.locator(`[data-tag-game-watch="${gameBId}"]`).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
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
