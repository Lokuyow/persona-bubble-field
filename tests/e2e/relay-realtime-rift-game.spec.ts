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

const RIFT_SELF_POSITION = { x: 3, y: 2 } as const;
const RIFT_FIELD_SIZE = { columns: 16, rows: 8 } as const;

function scheduleWithDistantFirstHole(startSchedule: ReturnType<typeof getRiftSchedule>) {
	let schedule = startSchedule;
	for (let attempt = 0; attempt < 32; attempt += 1) {
		const hole = deriveRiftHolePositions(schedule.instanceId, RIFT_FIELD_SIZE)[0];
		if (Math.max(Math.abs(hole.position.x - RIFT_SELF_POSITION.x), Math.abs(hole.position.y - RIFT_SELF_POSITION.y)) > 1) {
			return { schedule, hole };
		}
		const nextSchedule = nextScheduledRiftSchedule(schedule);
		if (nextSchedule.instanceId === schedule.instanceId) throw new Error('Rift schedule search did not advance to a new instance.');
		schedule = nextSchedule;
	}
	throw new Error('Could not find a Rift schedule with a distant first hole within 32 days.');
}


test.describe('Relay startup', () => {
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
		const { schedule, hole } = scheduleWithDistantFirstHole(upcomingRegistrationSchedule());
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
		const { schedule, hole } = scheduleWithDistantFirstHole(upcomingRegistrationSchedule());
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
});
