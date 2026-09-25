import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { finalizeTagGameState, parseTagGameActionEvent, parseTagGameEvent, TAG_GAME_KIND, type TagGameState } from '../../src/lib/tagGame';
import { TAG_GAME_TERMINAL } from '../../src/lib/fieldFacilities';
import { buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { CHANNEL_ID, fixtureSecret, installDelayedRelay, moveRelaySelfTo, relayState, seedRelayAccount, testEvents, clickRelayLogicalCell, dragRelayJoystick } from './helpers/relayHarness';

async function preparePlayer(page: Page, secret: Uint8Array, nowMs: number, points = 0): Promise<void> {
	await page.clock.install({ time: nowMs });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents: [], realtimePublishOutcome: 'echo' });
	await seedRelayAccount(page, secret, getPublicKey(secret), nowMs + 14 * 24 * 60 * 60 * 1_000, points);
	await page.goto('/');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${getPublicKey(secret)}"]`)).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(7070)))).toBe(true);
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

async function tagGamePersistence(page: Page): Promise<{ lock: unknown; receipt: unknown }> {
	return page.evaluate(() => new Promise((resolve, reject) => {
		const open = indexedDB.open('persona-bubble-field-account', 8);
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const database = open.result;
			const request = database.transaction('persona-bubble-field-player-state', 'readonly').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const state = request.result;
				resolve({ lock: state?.tagGame?.lock ?? null, receipt: state?.realtimeSettlementLedger?.tagGameReceipt ?? null });
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
	await speaker.click();
	const slider = page.getByRole('slider', { name: 'Sound volume' });
	await expect(slider).toBeVisible();
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

		await openTagGameTerminal(hostPage);
		await hostPage.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect.poll(async () => (await relayState(hostPage)).state.published.some((event) => event.kind === TAG_GAME_KIND)).toBe(true);
		const firstState = await latestPublished(hostPage, TAG_GAME_KIND);
		const parsedLobby = parseTagGameEvent(firstState, CHANNEL_ID);
		expect(parsedLobby).not.toBeNull();
		const gameId = parsedLobby!.state.gameId;
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		await Promise.all([openTagGameTerminal(participantPage), openTagGameTerminal(participantTwoPage)]);
		await Promise.all([expect(participantPage.locator('main')).toHaveAttribute('data-realtime-status', 'active'), expect(participantTwoPage.locator('main')).toHaveAttribute('data-realtime-status', 'active')]);
		await Promise.all([injectRealtime(participantPage, firstState), injectRealtime(participantTwoPage, firstState)]);
		await Promise.all([expect(participantPage.getByRole('button', { name: '参加申請' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '参加申請' })).toBeVisible()]);
		await Promise.all([participantPage.getByRole('button', { name: '参加申請' }).click(), participantTwoPage.getByRole('button', { name: '参加申請' }).click()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(0)));
		const [joinAction, joinActionTwo] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey)]);
		await Promise.all([injectRealtime(hostPage, joinAction), injectRealtime(hostPage, joinActionTwo)]);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.participant.length).toBe(3);
		await Promise.all([injectRealtime(participantPage, await latestGameEvent(hostPage, gameId)), injectRealtime(participantTwoPage, await latestGameEvent(hostPage, gameId))]);

		await hostPage.getByRole('button', { name: '開始を提案' }).click();
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('proposed');
		const proposal = await latestGameEvent(hostPage, gameId);
		await Promise.all([injectRealtime(participantPage, proposal), injectRealtime(participantTwoPage, proposal)]);
		await Promise.all([expect(participantPage.getByRole('button', { name: '開始に同意' })).toBeVisible(), expect(participantTwoPage.getByRole('button', { name: '開始に同意' })).toBeVisible()]);
		await hostPage.getByRole('button', { name: '開始に同意' }).click();
		await Promise.all([participantPage.getByRole('button', { name: '開始に同意' }).click(), participantTwoPage.getByRole('button', { name: '開始に同意' }).click()]);
		await Promise.all([participantPage, participantTwoPage].map((participant) => expect.poll(async () => (await relayState(participant)).state.published.filter((event) => event.kind === 27070).length).toBeGreaterThan(1)));
		await expect.poll(async () => (await relayState(hostPage)).state.published.filter((event) => event.kind === 27070 && event.pubkey === hostPubkey).length).toBeGreaterThan(0);
		const [consent, consentTwo, hostConsent] = await Promise.all([latestPublished(participantPage, 27070, participantPubkey), latestPublished(participantTwoPage, 27070, participantTwoPubkey), latestPublished(hostPage, 27070, hostPubkey)]);
		await Promise.all([injectRealtime(hostPage, consent), injectRealtime(hostPage, consentTwo), injectRealtime(hostPage, hostConsent)]);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('countdown');
		await Promise.all([injectRealtime(participantPage, await latestGameEvent(hostPage, gameId)), injectRealtime(participantTwoPage, await latestGameEvent(hostPage, gameId))]);
		await hostPage.clock.runFor(6_000);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('running');
		const runningEvent = await latestGameEvent(hostPage, gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		await Promise.all([hostPage, participantPage, participantTwoPage].map((page) => page.clock.setFixedTime(running.startedAt! * 1_000 + 5_000)));
		await Promise.all([injectRealtime(participantPage, runningEvent), injectRealtime(participantTwoPage, runningEvent)]);
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantTwoPage.locator('[data-tag-game-hud]')).toBeVisible();
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
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
		await hostPage.clock.runFor(181_000);
		await hostPage.clock.runFor(2_000);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, gameId), CHANNEL_ID)?.state.phase).toBe('ended');
		const finalStateEvent = await latestGameEvent(hostPage, gameId);
		await injectRealtime(participantPage, finalStateEvent);
		await injectRealtime(participantTwoPage, finalStateEvent);
		await Promise.all([openTagGameTerminal(hostPage), openTagGameTerminal(participantPage), openTagGameTerminal(participantTwoPage)]);
		await expect(hostPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
		await expect(participantPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
		await expect(participantTwoPage.getByText(/恩恵\d+秒・災厄\d+秒/).first()).toBeVisible();
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
	const startedAt = await page.evaluate(() => Math.floor(Date.now() / 1000));
	const gameId = `${remoteHostPubkey}:${startedAt}:${'d'.repeat(64)}`;
	const active: TagGameState = {
		gameId, hostPubkey: remoteHostPubkey, phase: 'running', revision: 0, updatedAt: startedAt,
		startedAt, endsAt: startedAt + 180, seed: 'e'.repeat(64), ownerPubkey: remoteHostPubkey, effect: 'benefit', transferAt: startedAt * 1000,
		participant: [remoteHostPubkey, joinerPubkey].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
		settledAtMs: startedAt * 1000
	};
	const signed = finalizeTagGameState(active, CHANNEL_ID, startedAt, remoteHostSecret);
	const relayStateBeforeProbe = (await relayState(page)).state.requests.length;
	await injectRealtime(page, signed);
		await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-realtime-status', 'active');
	await page.clock.runFor(31_000);
	await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(relayStateBeforeProbe);
	await page.clock.runFor(6_000);
	await expect(page.getByText('中断')).toBeVisible();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
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
		await hostPage.getByRole('button', { name: '開始に同意' }).click();
		await participantPage.getByRole('button', { name: '開始に同意' }).click();
		await Promise.all([hostPage, participantPage].map((page) => expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 27070 && parseTagGameActionEvent(event as unknown as NostrEvent, CHANNEL_ID)?.action === 'consent')).toBe(true)));
		const [hostConsent, participantConsent] = await Promise.all([latestPublished(hostPage, 27070, hostPubkey), latestPublished(participantPage, 27070, participantPubkey)]);
		await Promise.all([injectRealtime(hostPage, hostConsent), injectRealtime(hostPage, participantConsent)]);
		await expect.poll(async () => parseTagGameEvent(await latestGameEvent(hostPage, lobby.gameId), CHANNEL_ID)?.state.phase).toBe('countdown');
		await injectRealtime(participantPage, await latestGameEvent(hostPage, lobby.gameId));
		await hostPage.clock.runFor(6_000);
		const runningEvent = await latestGameEvent(hostPage, lobby.gameId);
		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
		expect(running.phase).toBe('running');
		await Promise.all([hostPage, participantPage].map((page) => page.clock.setFixedTime(running.startedAt! * 1_000 + 5_000)));
		await injectRealtime(participantPage, runningEvent);
		await Promise.all([hostPage, participantPage].map((page) => page.getByRole('button', { name: '閉じる', exact: true }).click()));
		await expect.poll(async () => (await tagGamePersistence(participantPage)).lock).toMatchObject({ gameId: lobby.gameId });

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
	function hostedGame(hostSecret: Uint8Array, otherSecret: Uint8Array, marker: string): NostrEvent {
		const host = getPublicKey(hostSecret);
		const other = getPublicKey(otherSecret);
		const state: TagGameState = {
			gameId: `${host}:${startedAt}:${marker.repeat(64)}`, hostPubkey: host, phase: 'running', revision: 0, updatedAt: startedAt,
			startedAt, endsAt: startedAt + 180, seed: marker.repeat(64), ownerPubkey: host, effect: 'benefit', transferAt: startedAt * 1_000,
			participant: [host, other].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: startedAt, status: 'active' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })),
			settledAtMs: startedAt * 1_000
		};
		return finalizeTagGameState(state, CHANNEL_ID, startedAt, hostSecret);
	}
	const gameA = hostedGame(ownerASecret, runnerASecret, 'a');
	const gameB = hostedGame(ownerBSecret, runnerBSecret, 'b');
	const gameAId = parseTagGameEvent(gameA, CHANNEL_ID)!.state.gameId;
	const gameBId = parseTagGameEvent(gameB, CHANNEL_ID)!.state.gameId;
	await Promise.all([injectRealtime(page, gameA), injectRealtime(page, gameB)]);
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);

	await openTagGameTerminal(page);
	await page.locator(`[data-tag-game-watch="${gameBId}"]`).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveAttribute('data-tag-game-hud-id', gameBId);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'holder');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerBSecret)}"]`)).toHaveAttribute('data-tag-game-role', 'participant');
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(ownerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await expect(page.locator(`.participant[data-participant-id="${getPublicKey(runnerASecret)}"][data-tag-game-role]`)).toHaveCount(0);
	await page.getByRole('button', { name: '観戦を解除' }).click();
	await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
	await expect(page.locator('.participant[data-tag-game-role]')).toHaveCount(0);
});
