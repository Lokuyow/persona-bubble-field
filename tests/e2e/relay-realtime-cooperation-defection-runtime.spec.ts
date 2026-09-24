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
	buildCooperationDefectionActionTemplate,
	buildCooperationDefectionCommitAction,
	buildCooperationDefectionRevealAction,
	buildManualCooperationDefectionInstanceId,
	deriveCooperationDefectionGroupPositions,
	getCooperationDefectionRoundSchedule,
	getCooperationDefectionSchedule,
	getCooperationDefectionScheduleForInstance,
	COOPERATION_DEFECTION_CONSULTATION_MS,
	COOPERATION_DEFECTION_PROTOCOL_KEY,
	type CooperationDefectionAction
} from '../../src/lib/cooperationDefection';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, nextScheduledCooperationDefectionSchedule, signedCooperationDefectionAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove, pressRelayKeyboardMovement } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('keeps primary and Trace ahead of an unknown-capacity realtime attempt', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), hiddenSubscriptionLimit: 3 });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
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
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect(page.locator('[data-realtime-panel]')).toHaveCount(0);
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
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		expect((await relayState(page)).state.requests.filter(isRealtimeRequest)).toHaveLength(AUTHORITATIVE_RELAYS.length);
		await page.clock.setSystemTime(schedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(schedule.instanceId))).toBe(true);

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeRealtimeCount(): number }
		}).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const state = (await relayState(page)).state;
		expect(state.closedSubscriptions.some((closed) => state.requests.some((request) => request.subId === closed.subId && isRealtimeRequest(request)))).toBe(true);
	});

	test('restarts realtime for the next day without recreating the world session', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const nextSchedule = getCooperationDefectionSchedule(schedule.warningAtMs + 24 * 60 * 60 * 1_000);
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
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
		await expect(page.locator('[data-realtime-panel]')).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const closedAfterFirstDay = (await relayState(page)).state.closedSubscriptions;
		const firstRequestIds = new Set(firstRealtimeRequests.map((request) => request.subId));
		expect(closedAfterFirstDay.some((closed) => firstRequestIds.has(closed.subId))).toBe(true);

		await page.clock.setSystemTime(nextSchedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(firstRealtimeRequests.length);
		const allRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		const nextRealtimeRequests = allRealtimeRequests.slice(firstRealtimeRequests.length);
		expect(nextRealtimeRequests.length).toBeGreaterThan(0);
		expect(nextRealtimeRequests.some((request) => realtimeInstanceIds(request).length === 1 && realtimeInstanceIds(request)[0] === nextSchedule.instanceId)).toBe(true);
		expect((await relayState(page)).state.requests.filter((request) =>
			[42, WORLD_STATE_KIND].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000)).toHaveLength(primaryRequestCount);

		const nextGroup = deriveCooperationDefectionGroupPositions(nextSchedule.instanceId, { columns: 16, rows: 8 })[0];
		const nextJoin = signedCooperationDefectionAction(secret, nextSchedule, { action: 'join', groupId: nextGroup.id }, nextSchedule.registrationAtMs + 1_000);
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
		await pressRelayKeyboardMovement(page, move);
	});
});
