import { expect, test, type Locator, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	WORLD_STATE_KIND,
	buildDeathTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import {
	buildRiftActionTemplate,
	buildRiftCommitAction,
	buildRiftRevealAction,
	buildManualRiftInstanceId,
	deriveRiftHolePositions,
	getRiftRoundSchedule,
	getRiftSchedule,
	getRiftScheduleForInstance,
	RIFT_CONSULTATION_MS,
	RIFT_PROTOCOL_KEY,
	type RiftAction
} from '../../src/lib/rift';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, signedRiftAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('accepts a creator-signed manual Rift control from a synthetic DEV channel', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualRiftInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: RIFT_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			channelEvent: channel.event,
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control]
		});
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
	});

	test('promotes recovered manual Rift state to current after an active-game reload', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const scheduled = upcomingRegistrationSchedule();
		const initialTime = scheduled.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualRiftInstanceId(createdAt, 'fedcba9876543210fedcba9876543210');
		const manualSchedule = getRiftScheduleForInstance(manualInstanceId, initialTime);
		if (!manualSchedule) throw new Error('Expected the manual schedule fixture.');
		const secret = fixtureSecret(19);
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: RIFT_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			channelEvent: channel.event,
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control],
			persistAcrossReload: true
		});
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
		const hole = deriveRiftHolePositions(manualInstanceId, { columns: 16, rows: 8 })[0];
		const join = signedRiftAction(secret, manualSchedule, { action: 'join', holeId: hole.id }, initialTime + 1_000, channel.event.id);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(event), join);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
		await page.evaluate(({ controlEvent, joinEvent }) => {
			const harness = (window as typeof window & { __relayStartupTest: { state: { published: object[] } } }).__relayStartupTest;
			harness.state.published.push(controlEvent, joinEvent);
		}, { controlEvent: control, joinEvent: join });
		await page.clock.setSystemTime(manualSchedule.gameAtMs + RIFT_CONSULTATION_MS + 1_000);
		await page.reload();
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 1');
		await expect(page.locator('[data-rift-choice="maintain"]')).toBeEnabled();
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
	});

	test('keeps primary and Trace ahead of an unknown-capacity realtime attempt', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), hiddenSubscriptionLimit: 3 });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBe(AUTHORITATIVE_RELAYS.length);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[])[0] === 1111)).toBe(true);
		const startupRequests = (await relayState(page)).state.requests;
		// Realtime may be requested before Trace finishes configuring. The
		// priority contract is the final ownership after reconfiguration, not the
		// incidental order of the first REQ packets.
		expect(startupRequests.some(isRealtimeRequest)).toBe(true);
		expect(startupRequests.some((request) => (request.filter.kinds as number[])[0] === 1111)).toBe(true);
		await page.clock.runFor(10_001);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'degraded');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number; activeTraceReplyCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeTraceReplyCount(): number } }).__relayStartupTest.activeTraceReplyCount())).toBeGreaterThan(0);
		const primaryRequests = (await relayState(page)).state.requests.filter((request) =>
			[42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000);
		expect(primaryRequests).toHaveLength(AUTHORITATIVE_RELAYS.length * 2);
	});

	test('keeps control realtime during dormancy and switches to the scheduled instance at registration', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.warningAtMs - 1_000;
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(schedule.registrationAtMs + 1_000) });
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBe(AUTHORITATIVE_RELAYS.length);
		const realtimeRequestsBeforeRegistration = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(realtimeRequestsBeforeRegistration).toHaveLength(AUTHORITATIVE_RELAYS.length);
		expect(realtimeInstanceIds(realtimeRequestsBeforeRegistration[0])).toEqual([]);

		await page.clock.setSystemTime(schedule.warningAtMs + 1_000);
		await page.clock.runFor(1_000);
		expect((await relayState(page)).state.requests.filter(isRealtimeRequest)).toHaveLength(AUTHORITATIVE_RELAYS.length);
		await page.clock.setSystemTime(schedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(schedule.instanceId))).toBe(true);

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeRealtimeCount(): number }
		}).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const state = (await relayState(page)).state;
		expect(state.closedSubscriptions.some((closed) => state.requests.some((request) => request.subId === closed.subId && isRealtimeRequest(request)))).toBe(true);
	});

	test('starts realtime early only for a persisted settlement recovery instance', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const previousSchedule = getRiftSchedule(schedule.warningAtMs - 24 * 60 * 60 * 1000);
		const initialTime = schedule.warningAtMs - 1_000;
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(initialTime) });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await seedRealtimePendingInstance(page, previousSchedule.instanceId);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			isRealtimeRequest(request) && realtimeInstanceIds(request).includes(previousSchedule.instanceId))).toBe(true);
		const earlyRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(earlyRealtimeRequests.every((request) => {
			const instances = realtimeInstanceIds(request);
			return instances?.length === 1 && instances[0] === previousSchedule.instanceId;
		})).toBe(true);
	});

	test('restarts realtime for the next day without recreating the world session', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const nextSchedule = getRiftSchedule(schedule.warningAtMs + 24 * 60 * 60 * 1_000);
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
		const firstRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(firstRealtimeRequests.some((request) => realtimeInstanceIds(request).length === 1 && realtimeInstanceIds(request)[0] === schedule.instanceId)).toBe(true);
		const primaryRequestCount = (await relayState(page)).state.requests.filter((request) =>
			[42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000).length;

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const closedAfterFirstDay = (await relayState(page)).state.closedSubscriptions;
		const firstRequestIds = new Set(firstRealtimeRequests.map((request) => request.subId));
		expect(closedAfterFirstDay.some((closed) => firstRequestIds.has(closed.subId))).toBe(true);

		await page.clock.setSystemTime(nextSchedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(firstRealtimeRequests.length);
		const allRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		const nextRealtimeRequests = allRealtimeRequests.slice(firstRealtimeRequests.length);
		expect(nextRealtimeRequests.length).toBeGreaterThan(0);
		expect(nextRealtimeRequests.some((request) => realtimeInstanceIds(request).length === 1 && realtimeInstanceIds(request)[0] === nextSchedule.instanceId)).toBe(true);
		expect((await relayState(page)).state.requests.filter((request) =>
			[42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000)).toHaveLength(primaryRequestCount);

		const nextHole = deriveRiftHolePositions(nextSchedule.instanceId, { columns: 16, rows: 8 })[0];
		const nextJoin = signedRiftAction(secret, nextSchedule, { action: 'join', holeId: nextHole.id }, nextSchedule.registrationAtMs + 1_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(event), nextJoin);
		await page.clock.setSystemTime(nextSchedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 1');
	});

	test('keeps normal world movement and conversation available when realtime is unavailable', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeTerminal: 'closed' });
		const secret = fixtureSecret(41);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const self = page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`);
		await expect(self).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => (request.filter.kinds as number[])[0] === 7070).length).toBeGreaterThan(0);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'degraded');

		await editor.fill('normal world survives realtime timeout');
		await editor.press('Enter');
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.content === 'normal world survives realtime timeout')).toBe(true);
		const move = await chooseHorizontalMove(page);
		await editor.fill('');
		await editor.focus();
		await page.clock.runFor(1_001);
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('does not create a settlement recovery marker for a spectator receiving another player join', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const spectatorEvent = signedRiftAction(fixtureSecret(20), schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000);
		await page.clock.install({ time: schedule.registrationAtMs + 1_000 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(schedule.registrationAtMs + 1_000), realtimeEvents: [spectatorEvent] });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
	});

	test('rejects a stale Rift join confirmation after movement or registration ends', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [], realtimePublishOutcome: 'accepted' });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-hole-trigger]')).toHaveCount(1);

		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);

		const farPosition = { x: hole.position.x > 2 ? hole.position.x - 2 : hole.position.x + 2, y: hole.position.y };
		const farEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: farPosition, slot: 0, createdAt: Math.floor((startTime + 3_000) / 1000) }), selfSecret);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), farEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${farPosition.x},${farPosition.y}`);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const nearEventAgain = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 4_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEventAgain);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
	});

	test('completes Rift join, snapshot, commit, automatic reveal, settlement, and reload recovery', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'maintain' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'maintain' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedRiftAction(secret, schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildRiftCommitAction({ instanceId: schedule.instanceId, holeId: hole.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedRiftAction(secret, schedule, action, getRiftRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, pubkey, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedRiftAction(secret, schedule,
			buildRiftRevealAction({ holeId: hole.id, round: 1, commitId: event.id, choice, nonce }), getRiftRoundSchedule(schedule, 1).resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: testEvents(startTime),
			realtimeEvents: [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals],
			persistAcrossReload: true,
			realtimePublishOutcome: 'accepted'
		});
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		const panelLayout = await page.locator('[data-realtime-panel]').evaluate((panel) => {
			const rect = panel.getBoundingClientRect();
			return { centerX: rect.left + rect.width / 2, top: rect.top, right: rect.right, viewportWidth: window.innerWidth };
		});
		expect(Math.abs(panelLayout.centerX - panelLayout.viewportWidth / 2)).toBeLessThanOrEqual(1);
		expect(panelLayout.top).toBeGreaterThanOrEqual(0);
		expect(panelLayout.right).toBeLessThanOrEqual(panelLayout.viewportWidth);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();

		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.runFor(50);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await expect(page.getByRole('dialog')).toContainText('3〜6人 / 全3ラウンド');
		await expect(page.getByRole('dialog')).toContainText('脱出を選んだ者は死亡');
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.getByRole('button', { name: 'キャンセル' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('rejected'));
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		}).length).toBeGreaterThan(0);
		await expect(page.locator('[data-realtime-panel]')).not.toContainText('参加済み');
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		})).toBe(true);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveAttribute('aria-label', '抜け穴へ参加済み（参加先）');

		const round = getRiftRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('秘密選択');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 3');
		await page.locator('[data-rift-choice="maintain"]').click();
		await expect(page.locator('[data-rift-choice="maintain"]')).toBeDisabled();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);

		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		await expect(page.locator('[data-rift-selection-status]')).toContainText('自動公開済み');

		await page.clock.setSystemTime(round.resultAtMs + 2_000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('[data-realtime-panel]')).toContainText('綻びゲーム中');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals]);
		await page.clock.runFor(100);
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(2_000);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(20);
		await expect(page.locator('[data-rift-round-result]')).toContainText('+20pt');

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await expect.poll(async () => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		await expect(page.locator('[data-realtime-hole-trigger]')).toHaveCount(0);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(20);
	});

	test('publishes a World State exit after a realtime death outcome commits locally', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'maintain' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'escape' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedRiftAction(secret, schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildRiftCommitAction({ instanceId: schedule.instanceId, holeId: hole.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedRiftAction(secret, schedule, action, getRiftRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedRiftAction(secret, schedule,
			buildRiftRevealAction({ holeId: hole.id, round: 1, commitId: event.id, choice, nonce }), getRiftRoundSchedule(schedule, 1).resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: testEvents(startTime),
			realtimeEvents: [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals],
			persistAcrossReload: true,
			realtimePublishOutcome: 'accepted'
		});
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest.releaseMetadata());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();

		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.runFor(50);
		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');

		const round = getRiftRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.locator('[data-rift-choice="escape"]').click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);
		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(2_000);

		await expect(page.locator('[data-death-presentation]')).toBeVisible();
		await page.locator('[data-death-presentation] textarea').fill('A last word from this Run');
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残して進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const exits = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, selfPubkey);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.content).toMatch(/^\d+:\d+$/);
		expect(exits[0]?.tags.find((tag) => tag[0] === 'e')?.[1]).toBe(CHANNEL_ID);
		const traces = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:death' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.pubkey === expectedPubkey && event.content === 'A last word from this Run')
				.map((event) => [event.id, event])).values()];
		}, selfPubkey);
		expect(traces).toHaveLength(1);
		expect(traces[0]?.tags.find((tag) => tag[0] === 'w')?.[1]).toBe(exits[0]?.content);
	});

	test('does not publish a terminal exit when a realtime death outcome is duplicate', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'maintain' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'escape' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedRiftAction(secret, schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildRiftCommitAction({ instanceId: schedule.instanceId, holeId: hole.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedRiftAction(secret, schedule, action, getRiftRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedRiftAction(secret, schedule,
			buildRiftRevealAction({ holeId: hole.id, round: 1, commitId: event.id, choice, nonce }), getRiftRoundSchedule(schedule, 1).resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: testEvents(startTime),
			realtimeEvents: [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals],
			persistAcrossReload: true,
			realtimePublishOutcome: 'accepted'
		});
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest.releaseMetadata());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.runFor(50);
		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		const round = getRiftRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.locator('[data-rift-choice="escape"]').click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);
		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		const outcomeId = `${schedule.instanceId}:${hole.id}:r1:${selfPubkey}:death`;
		await page.evaluate(async (appliedOutcomeId) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
				const store = transaction.objectStore('persona-bubble-field-player-state');
				const request = store.get('player-lifecycle');
				await new Promise<void>((resolve, reject) => {
					request.onsuccess = () => {
						const current = request.result as { realtimeSettlementLedger?: { schemaVersion: number; identity: unknown; runNumber: number; pendingInstanceIds: string[]; appliedOutcomeIds: string[] } };
						const ledger = current.realtimeSettlementLedger;
						if (!ledger) throw new Error('Expected a realtime settlement ledger.');
						store.put({ ...current, realtimeSettlementLedger: { ...ledger, appliedOutcomeIds: [...ledger.appliedOutcomeIds, appliedOutcomeId] } }, 'player-lifecycle');
					};
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				});
			} finally { database.close(); }
		}, outcomeId);
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(2_000);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest.releaseMetadata());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const exits = (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		expect(exits).toHaveLength(0);
	});
});
