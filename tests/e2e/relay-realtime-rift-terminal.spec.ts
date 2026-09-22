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
	test('publishes a World State exit after a realtime death outcome commits locally', async ({ page }) => {
		const { schedule, hole } = scheduleWithDistantFirstHole(upcomingRegistrationSchedule());
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
		const { schedule, hole } = scheduleWithDistantFirstHole(upcomingRegistrationSchedule());
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

