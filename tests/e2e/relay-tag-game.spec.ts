import { expect, test, type Page } from '@playwright/test';
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure';
import { finalizeTagGameState, parseTagGameActionEvent, parseTagGameEvent, TAG_GAME_KIND, type TagGameState } from '../../src/lib/tagGame';
import { TAG_GAME_TERMINAL } from '../../src/lib/fieldFacilities';
import { buildWorldStateEventTemplate, WORLD_STATE_KIND } from '../../src/lib/nostrProtocol';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { CHANNEL_ID, fixtureSecret, installDelayedRelay, moveRelaySelfTo, relayState, seedRelayAccount, testEvents, clickRelayLogicalCell, dragRelayJoystick } from './helpers/relayHarness';

async function preparePlayer(page: Page, secret: Uint8Array, nowMs: number): Promise<void> {
	await page.clock.install({ time: nowMs });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents: [], realtimePublishOutcome: 'echo' });
	await seedRelayAccount(page, secret, getPublicKey(secret), nowMs + 14 * 24 * 60 * 60 * 1_000);
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
	const event = await page.evaluate((id) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		return published.filter((candidate) => candidate.kind === 37070 && candidate.tags && (candidate.tags as string[][]).some((tag) => tag[0] === 'd' && tag[1] === id))
			.sort((first, second) => Number(second.created_at) - Number(first.created_at))[0] ?? null;
	}, gameId);
	if (!event) throw new Error(`No published tag-game state for ${gameId}.`);
	return event as unknown as NostrEvent;
}

async function latestWorldState(page: Page, author: string): Promise<NostrEvent> {
	return latestPublished(page, WORLD_STATE_KIND, author);
}

async function latestPublished(page: Page, kind: number, author?: string): Promise<NostrEvent> {
	const result = await page.evaluate(({ eventKind, pubkey }) => {
		const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<Record<string, unknown>> } } }).__relayStartupTest.state.published;
		const matches = published.filter((candidate) => candidate.kind === eventKind && (!pubkey || candidate.pubkey === pubkey))
			.sort((first, second) => Number(second.created_at) - Number(first.created_at))[0] ?? null;
		return { event: matches, published: published.map((candidate) => ({ kind: candidate.kind, pubkey: candidate.pubkey })) };
	}, { eventKind: kind, pubkey: author });
	if (!result.event) throw new Error(`No published event of kind ${kind} by ${author ?? 'any author'}; saw ${JSON.stringify(result.published)}.`);
	return result.event as unknown as NostrEvent;
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
		await Promise.all([injectRealtime(participantPage, runningEvent), injectRealtime(participantTwoPage, runningEvent)]);
		await expect(hostPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantPage.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(participantTwoPage.locator('[data-tag-game-hud]')).toBeVisible();
		await Promise.all([hostPage, participantPage, participantTwoPage].map(async (page) => {
			await page.getByRole('button', { name: '閉じる', exact: true }).click();
		}));
		await Promise.all([moveRelaySelfTo(hostPage, { x: 7, y: 5 }), moveRelaySelfTo(participantPage, { x: 7, y: 6 }), moveRelaySelfTo(participantTwoPage, { x: 8, y: 5 })]);
		const [latestHostPosition, latestParticipantPosition, latestParticipantTwoPosition] = await Promise.all([
			latestWorldState(hostPage, hostPubkey), latestWorldState(participantPage, participantPubkey), latestWorldState(participantTwoPage, participantTwoPubkey)
		]);
		await Promise.all([
			injectPosition(hostPage, latestParticipantPosition), injectPosition(hostPage, latestParticipantTwoPosition),
			injectPosition(participantPage, latestHostPosition), injectPosition(participantPage, latestParticipantTwoPosition),
			injectPosition(participantTwoPage, latestHostPosition), injectPosition(participantTwoPage, latestParticipantPosition)
		]);

		const running = parseTagGameEvent(runningEvent, CHANNEL_ID)!.state;
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
		const touchAction = await latestPublished(actor, 27070, actorPubkey);
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
