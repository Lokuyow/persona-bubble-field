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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, nextScheduledCooperationDefectionSchedule, signedCooperationDefectionAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove, waitForRelayComposerReady } from './helpers/relayHarness';

const formatJstDeadline = (timeMs: number) => `${new Intl.DateTimeFormat('ja-JP', {
	timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(timeMs))} JST`;


test.describe('Relay startup', () => {
	test('accepts a creator-signed manual CooperationDefection control from a synthetic DEV channel', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualCooperationDefectionInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control]
		});
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await waitForRelayComposerReady(page);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect(page.locator('[data-realtime-panel]')).toContainText('· 運営開催');
		await expect(page.locator('[data-cooperation-defection-registration-deadline]')).toHaveText(`受付締切: ${formatJstDeadline((createdAt + 5 * 60) * 1_000)}`);
		await expect(page.locator('[data-cooperation-defection-registration-countdown]')).toContainText(/^残り時間: 04:\d{2}$/);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);

		await page.clock.setSystemTime(initialTime + 73_000);
		await page.clock.runFor(500);
		await expect(page.locator('[data-cooperation-defection-registration-countdown]')).toContainText(/^残り時間: 03:\d{2}$/);
		await page.reload();
		await waitForRelayComposerReady(page);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('· 運営開催');
		await expect(page.locator('[data-cooperation-defection-registration-deadline]')).toHaveText(`受付締切: ${formatJstDeadline((createdAt + 5 * 60) * 1_000)}`);
		await expect(page.locator('[data-cooperation-defection-registration-countdown]')).toContainText(/^残り時間: 03:\d{2}$/);
	});

	test('promotes recovered manual CooperationDefection state to current after an active-game reload', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const scheduled = upcomingRegistrationSchedule();
		const initialTime = scheduled.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualCooperationDefectionInstanceId(createdAt, 'fedcba9876543210fedcba9876543210');
		const manualSchedule = getCooperationDefectionScheduleForInstance(manualInstanceId, initialTime);
		if (!manualSchedule) throw new Error('Expected the manual schedule fixture.');
		const secret = fixtureSecret(19);
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control],
			persistAcrossReload: true
		});
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await waitForRelayComposerReady(page);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
		const group = deriveCooperationDefectionGroupPositions(manualInstanceId, { columns: 16, rows: 8 })[0];
		const join = signedCooperationDefectionAction(secret, manualSchedule, { action: 'join', groupId: group.id }, initialTime + 1_000, channel.event.id);
		const otherJoins = [fixtureSecret(20), fixtureSecret(21)].map((otherSecret, index) => signedCooperationDefectionAction(otherSecret, manualSchedule,
			{ action: 'join', groupId: group.id }, initialTime + 2_000 + index, channel.event.id));
		await page.evaluate((events) => {
			const harness = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) harness.injectRealtimeEvent(event);
		}, [join, ...otherJoins]);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
		await page.evaluate(({ controlEvent, joinEvent }) => {
			const harness = (window as typeof window & { __relayStartupTest: { state: { published: object[] } } }).__relayStartupTest;
			harness.state.published.push(controlEvent, ...joinEvent);
		}, { controlEvent: control, joinEvent: [join, ...otherJoins] });
		await page.clock.setSystemTime(manualSchedule.gameAtMs + COOPERATION_DEFECTION_CONSULTATION_MS + 1_000);
		await page.reload();
		await waitForRelayComposerReady(page);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 3');
		await expect(page.locator('[data-cooperation-defection-choice="cooperate"]')).toBeEnabled();
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
	});

	test('starts realtime early only for a persisted settlement recovery instance', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const previousSchedule = getCooperationDefectionSchedule(schedule.warningAtMs - 24 * 60 * 60 * 1000);
		const initialTime = schedule.warningAtMs - 1_000;
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(initialTime) });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await seedRealtimePendingInstance(page, previousSchedule.instanceId);
		await page.goto('/');
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
});
