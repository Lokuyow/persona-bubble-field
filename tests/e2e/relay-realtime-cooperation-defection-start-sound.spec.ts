import { expect, test, type Page } from '@playwright/test';
import { getPublicKey } from 'nostr-tools/pure';
import {
	buildManualCooperationDefectionInstanceId,
	deriveCooperationDefectionGroupPositions,
	getCooperationDefectionScheduleForInstance,
	COOPERATION_DEFECTION_PROTOCOL_KEY,
	type CooperationDefectionSchedule
} from '../../src/lib/cooperationDefection';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import {
	AUTHORITATIVE_RELAYS,
	fixtureSecret,
	installDelayedRelay,
	relayState,
	realtimeInstanceIds,
	seedRelayAccount,
	signedCooperationDefectionAction,
	syntheticChannelFixture,
	testEvents,
	upcomingRegistrationSchedule
} from './helpers/relayHarness';

const AUDIO_START_DURATION_SECONDS = 0.43;
const COOPERATION_FIELD_SIZE = { columns: 16, rows: 8 } as const;

async function installAudioRecorder(page: Page, options: { muted?: boolean; playbackFails?: boolean } = {}): Promise<void> {
	await page.addInitScript((soundTestOptions) => {
		const preferenceKey = 'persona-bubble-field:speech-sound:v1';
		if (soundTestOptions.muted) localStorage.setItem(preferenceKey, JSON.stringify({ volume: 0 }));
		const recordedKey = 'cooperation-start-sounds';
		const recordStart = (duration: number) => {
			const recorded = JSON.parse(sessionStorage.getItem(recordedKey) ?? '[]') as number[];
			recorded.push(duration);
			sessionStorage.setItem(recordedKey, JSON.stringify(recorded));
		};
		class TestAudioContext {
			state: AudioContextState = 'suspended';
			currentTime = 0;
			sampleRate = 10_000;
			destination = {} as AudioDestinationNode;
			createGain() {
				return { gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime() {} }, connect() {} } as unknown as GainNode;
			}
			createBuffer(_channels: number, length: number, sampleRate: number) {
				return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) } as unknown as AudioBuffer;
			}
			createBufferSource() {
				if (soundTestOptions.playbackFails) throw new Error('Audio output unavailable in test fixture.');
				let buffer: AudioBuffer | null = null;
				return {
					set buffer(value: AudioBuffer | null) { buffer = value; },
					get buffer() { return buffer; },
					connect() {},
					start() { if (buffer) recordStart(buffer.duration); }
				} as unknown as AudioBufferSourceNode;
			}
			resume() { this.state = 'running'; return Promise.resolve(); }
			close() { this.state = 'closed'; return Promise.resolve(); }
		}
		Object.defineProperty(window, 'AudioContext', { configurable: true, value: TestAudioContext });
	}, options);
}

async function recordedCooperationStartSounds(page: Page): Promise<number[]> {
	return page.evaluate(() => JSON.parse(sessionStorage.getItem('cooperation-start-sounds') ?? '[]') as number[])
		.then((durations) => durations.filter((duration) => Math.abs(duration - AUDIO_START_DURATION_SECONDS) < 0.001));
}

async function unlockSoundFromTheUI(page: Page): Promise<void> {
	await page.getByRole('button', { name: /Open sound settings/ }).click();
	await expect(page.getByRole('dialog', { name: 'Sound settings' })).toBeVisible();
	await page.keyboard.press('Escape');
}

async function installScheduledParticipant(page: Page, options: {
	schedule: CooperationDefectionSchedule;
	joins: Array<{ secret: Uint8Array; groupId: string; createdAtMs: number }>;
	selfSecret: Uint8Array;
	muted?: boolean;
	playbackFails?: boolean;
	persistAcrossReload?: boolean;
	deferRealtimeEvents?: boolean;
}): Promise<void> {
	const startTime = options.schedule.registrationAtMs + 1_000;
	const joinEvents = options.joins.map(({ secret, groupId, createdAtMs }) => signedCooperationDefectionAction(secret,
		options.schedule, { action: 'join', groupId }, createdAtMs));
	await page.clock.install({ time: startTime });
	await installAudioRecorder(page, { muted: options.muted, playbackFails: options.playbackFails });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, {
		primaryEvents: testEvents(startTime),
		realtimeEvents: joinEvents,
		deferRealtimeEvents: options.deferRealtimeEvents,
		persistAcrossReload: options.persistAcrossReload,
		realtimePublishOutcome: 'accepted'
	});
	const selfPubkey = getPublicKey(options.selfSecret);
	await seedRelayAccount(page, options.selfSecret, selfPubkey);
	await page.goto('/');
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
		(request.filter.kinds as number[])[0] === 42)).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
		(request.filter.kinds as number[]).includes(7070))).toBe(true);
	await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', options.deferRealtimeEvents ? 'degraded' : 'active');
}

async function awaitScheduledGameStart(page: Page, schedule: CooperationDefectionSchedule): Promise<void> {
	await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
	await page.clock.runFor(500);
}

test.describe('Cooperation and Defection start sound', () => {
	test('plays once for a scheduled participant and does not replay after active-game reload', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, COOPERATION_FIELD_SIZE)[0];
		if (!group) throw new Error('Expected a scheduled event group.');
		const selfSecret = fixtureSecret(19);
		await installScheduledParticipant(page, {
			schedule,
			selfSecret,
			persistAcrossReload: true,
			joins: [19, 20, 21].map((label, index) => ({ secret: fixtureSecret(label), groupId: group.id, createdAtMs: schedule.registrationAtMs + 1_000 + index }))
		});
		await unlockSoundFromTheUI(page);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await awaitScheduledGameStart(page, schedule);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加中（3人）');
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(1);

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[]).includes(7070))).toBe(true);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'active');
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toContainText('ラウンド 1 · 相談');
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(1);
	});

	test('plays once for a successful manually started group', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const scheduled = upcomingRegistrationSchedule();
		const createdAt = Math.floor((scheduled.warningAtMs - 30 * 60 * 1_000) / 1_000);
		const manualInstanceId = buildManualCooperationDefectionInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		const initialTime = (createdAt + 1) * 1_000;
		const schedule = getCooperationDefectionScheduleForInstance(manualInstanceId, initialTime);
		if (!schedule) throw new Error('Expected a manual event schedule.');
		const group = deriveCooperationDefectionGroupPositions(manualInstanceId, COOPERATION_FIELD_SIZE)[0];
		if (!group) throw new Error('Expected a manual event group.');
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		const joins = [19, 20, 21].map((label, index) => signedCooperationDefectionAction(fixtureSecret(label), schedule,
			{ action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000 + index, channel.event.id));
		await page.clock.install({ time: initialTime });
		await installAudioRecorder(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control],
			realtimePublishOutcome: 'accepted'
		});
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('運営開催');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[]).includes(7070) && realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'active');
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, joins);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await unlockSoundFromTheUI(page);
		await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
		await page.clock.runFor(500);
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toContainText('ラウンド 1 · 相談');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加中（3人）');
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(1);
	});

	test('plays once when the participant snapshot is confirmed during the first consultation phase', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, COOPERATION_FIELD_SIZE)[0];
		if (!group) throw new Error('Expected a scheduled event group.');
		const selfSecret = fixtureSecret(19);
		const joins = [19, 20, 21].map((label, index) => signedCooperationDefectionAction(fixtureSecret(label), schedule,
			{ action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000 + index));
		await installScheduledParticipant(page, { schedule, selfSecret, joins: [], deferRealtimeEvents: true });
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, joins);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await unlockSoundFromTheUI(page);
		await awaitScheduledGameStart(page, schedule);
		await expect(page.locator('[data-realtime-panel]')).toContainText('ゲーム中');
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseRealtimeEvents(): void } }).__relayStartupTest.releaseRealtimeEvents());
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toContainText('ラウンド 1 · 相談');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加中（3人）');
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(1);
		await page.clock.runFor(2_000);
		await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(1);
	});

	test('does not play for an underfilled participant, an unjoined spectator, a muted participant, or failed audio output', async ({ browser }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, COOPERATION_FIELD_SIZE)[0];
		if (!group) throw new Error('Expected a scheduled event group.');
		const cases: Array<{ selfSecret: Uint8Array; joins: readonly number[]; muted?: boolean; underfilled?: boolean; playbackFails?: boolean }> = [
			{ selfSecret: fixtureSecret(19), joins: [19, 20], underfilled: true },
			{ selfSecret: fixtureSecret(41), joins: [19, 20, 21] },
			{ selfSecret: fixtureSecret(23), joins: [23, 29, 30], muted: true },
			{ selfSecret: fixtureSecret(29), joins: [23, 29, 30], playbackFails: true }
		];
		for (const scenario of cases) {
			const page = await browser.newPage();
			try {
				await installScheduledParticipant(page, {
					schedule,
					selfSecret: scenario.selfSecret,
					muted: scenario.muted,
					playbackFails: scenario.playbackFails,
					joins: scenario.joins.map((label, index) => ({ secret: fixtureSecret(label), groupId: group.id, createdAtMs: schedule.registrationAtMs + 1_000 + index }))
				});
				await unlockSoundFromTheUI(page);
				await awaitScheduledGameStart(page, schedule);
				if (scenario.underfilled) {
					await expect(page.locator('[data-cooperation-defection-cancelled]')).toHaveText('参加人数が足りなかったため開催されませんでした');
				} else {
					await expect(page.locator('[data-cooperation-defection-round-progress]')).toContainText('ラウンド 1 · 相談');
				}
				await expect.poll(() => recordedCooperationStartSounds(page)).toHaveLength(0);
			} finally {
				await page.close();
			}
		}
	});
});
