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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, nextScheduledRiftSchedule, signedRiftAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove } from './helpers/relayHarness';


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
		await expect(page.locator('.action-dock')).toBeVisible();
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
		await expect(page.locator('.action-dock')).toBeVisible();
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
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 1');
		await expect(page.locator('[data-rift-choice="maintain"]')).toBeEnabled();
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
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
});
