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
	cooperationDefectionOutcomeId,
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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, nextScheduledCooperationDefectionSchedule, signedCooperationDefectionAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, isDeathTraceEvent, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove, pressRelayKeyboardMovement } from './helpers/relayHarness';

const COOPERATION_DEFECTION_SELF_POSITION = { x: 3, y: 2 } as const;
const COOPERATION_DEFECTION_FIELD_SIZE = { columns: 16, rows: 8 } as const;

function scheduleWithDistantFirstGroup(startSchedule: ReturnType<typeof getCooperationDefectionSchedule>) {
	let schedule = startSchedule;
	for (let attempt = 0; attempt < 32; attempt += 1) {
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, COOPERATION_DEFECTION_FIELD_SIZE)[0];
		if (Math.max(Math.abs(group.position.x - COOPERATION_DEFECTION_SELF_POSITION.x), Math.abs(group.position.y - COOPERATION_DEFECTION_SELF_POSITION.y)) > 1) {
			return { schedule, group };
		}
		const nextSchedule = nextScheduledCooperationDefectionSchedule(schedule);
		if (nextSchedule.instanceId === schedule.instanceId) throw new Error('CooperationDefection schedule search did not advance to a new instance.');
		schedule = nextSchedule;
	}
	throw new Error('Could not find a CooperationDefection schedule with a distant first group within 32 days.');
}

async function waitForDeathLastWords(page: Page): Promise<void> {
	const presentation = page.locator('[data-death-presentation]');
	await expect(presentation).toBeVisible();
	await expect(presentation).toHaveAttribute('data-death-phase', 'intro');
	await expect(presentation.getByRole('heading', { name: '死亡' })).toBeVisible();
	await expect(presentation.getByText('一生が終わりました。', { exact: true })).toBeVisible();
	await expect(presentation.locator('textarea')).toHaveCount(0);
	await expect(presentation.getByRole('button')).toHaveCount(0);
	await expect(page.locator('.field-viewport.death-presentation-active')).toHaveCount(1);
	await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
	await expect(page.locator('[data-death-presentation-tombstone]')).toHaveCount(1);
	await page.clock.runFor(2_500);
	await expect(presentation).toHaveAttribute('data-death-phase', 'last-words');
	await expect(presentation.getByText('一生が終わりました。最後に、世界にひとこと残せます。', { exact: true })).toBeVisible();
	await expect(presentation.locator('textarea')).toBeVisible();
	await expect(presentation.locator('.death-presentation-card')).toBeFocused();
}

async function publishedDeathTraceCount(page: Page, pubkey: string): Promise<number> {
	return (await relayState(page)).state.published.filter((event) => isDeathTraceEvent(event) && event.pubkey === pubkey).length;
}

async function prepareFailedCooperationScenario(page: Page, remainingDays: number, waitForResultSpeech = false) {
	const { schedule, group } = scheduleWithDistantFirstGroup(upcomingRegistrationSchedule());
	const otherPlayers = [
		{ secret: fixtureSecret(20), choice: 'cooperate' as const, nonce: '1'.repeat(64) },
		{ secret: fixtureSecret(21), choice: 'defect' as const, nonce: '2'.repeat(64) }
	];
	const otherJoins = otherPlayers.map(({ secret }) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000));
	const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
		const pubkey = getPublicKey(secret);
		const action = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: group.id, round: 1, authorPubkey: pubkey, choice, nonce });
		const event = signedCooperationDefectionAction(secret, schedule, action, getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000);
		return { secret, choice, nonce, event };
	});
	const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedCooperationDefectionAction(secret, schedule,
		buildCooperationDefectionRevealAction({ groupId: group.id, round: 1, commitId: event.id, choice, nonce }), getCooperationDefectionRoundSchedule(schedule, 1).resultAtMs + 1_000));
	const startTime = schedule.registrationAtMs + 1_000;
	const selfSecret = fixtureSecret(19);
	const selfPubkey = getPublicKey(selfSecret);
	let mainFrameNavigations = 0;
	page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) mainFrameNavigations += 1; });
	await page.clock.install({ time: startTime });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, {
		primaryEvents: testEvents(startTime),
		realtimeEvents: [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals],
		persistAcrossReload: true,
		realtimePublishOutcome: 'accepted'
	});
	await seedRelayAccount(page, selfSecret, selfPubkey, startTime + remainingDays * 24 * 60 * 60 * 1_000);
	await page.goto('/');
	await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
	const initialMainFrameNavigations = mainFrameNavigations;

	await page.locator('[data-realtime-group-trigger]').click();
	await page.clock.runFor(50);
	const nearPosition = group.position.y > 0 ? { x: group.position.x, y: group.position.y - 1 } : { x: group.position.x, y: group.position.y + 1 };
	const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
	await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
	await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
	await page.locator('[data-realtime-group-trigger]').click();
	await page.getByRole('button', { name: '参加する' }).click();
	await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');

	const round = getCooperationDefectionRoundSchedule(schedule, 1);
	await page.clock.setSystemTime(round.selectionAtMs + 1_000);
	await page.clock.runFor(1_000);
	await page.locator('[data-cooperation-defection-choice="defect"]').click();
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);
	await page.clock.setSystemTime(round.resultAtMs + 1_000);
	await page.clock.runFor(1_000);
	await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
	if (waitForResultSpeech) {
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('no-response'));
	}
	await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
	await page.clock.runFor(1_000);
	return { schedule, group, selfPubkey, initialMainFrameNavigations, getMainFrameNavigations: () => mainFrameNavigations };
}


test.describe('Relay startup', () => {
	test('publishes a World State exit after a realtime death outcome commits locally', async ({ page }) => {
		const { schedule, group, selfPubkey } = await prepareFailedCooperationScenario(page, 2);

		await waitForDeathLastWords(page);
		expect(await publishedDeathTraceCount(page, selfPubkey)).toBe(0);
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

	test('does not wait for an unanswered automatic result message before death presentation', async ({ page }) => {
		const { selfPubkey } = await prepareFailedCooperationScenario(page, 2, true);
		await waitForDeathLastWords(page);
		const published = (await relayState(page)).state.published;
		expect(published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '抜け駆け')).toBe(true);
		expect(published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(true);
	});

	test('keeps the World session active after a surviving lifespan penalty', async ({ page }) => {
		const { schedule, selfPubkey, initialMainFrameNavigations, getMainFrameNavigations } = await prepareFailedCooperationScenario(page, 5);
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('協力失敗');
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('あなた: 寿命 −3日');
		await expect(page.locator('[data-death-presentation]')).toHaveCount(0);
		const self = page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`);
		await expect(self).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '抜け駆け')).toBe(true);

		const move = await chooseHorizontalMove(page);
		await page.clock.runFor(1_001);
		await editor.fill('normal message after surviving penalty');
		await editor.press('Enter');
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === 'normal message after surviving penalty')).toBe(true);
		await editor.fill('');
		await editor.focus();
		await page.clock.runFor(1_001);
		await pressRelayKeyboardMovement(page, move);
		await expect(self).toHaveAttribute('data-position', move.expected);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey && event.content === move.expected.replace(',', ':'))).toBe(true);
		await expect(page.locator('[data-death-presentation]')).toHaveCount(0);
		await expect.poll(async () => getMainFrameNavigations()).toBe(initialMainFrameNavigations);
		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
	});

	test('restores an already committed lifespan loss without reapplying or reloading', async ({ page }) => {
		const { schedule, group } = scheduleWithDistantFirstGroup(upcomingRegistrationSchedule());
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'cooperate' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'defect' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: group.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedCooperationDefectionAction(secret, schedule, action, getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionRevealAction({ groupId: group.id, round: 1, commitId: event.id, choice, nonce }), getCooperationDefectionRoundSchedule(schedule, 1).resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		let mainFrameNavigations = 0;
		page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) mainFrameNavigations += 1; });
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
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();
		const initialMainFrameNavigations = mainFrameNavigations;
		await page.locator('[data-realtime-group-trigger]').click();
		await page.clock.runFor(50);
		const nearPosition = group.position.y > 0 ? { x: group.position.x, y: group.position.y - 1 } : { x: group.position.x, y: group.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-group-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.locator('[data-cooperation-defection-choice="defect"]').click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);
		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		const outcomeId = cooperationDefectionOutcomeId(schedule.instanceId, group.id, 1, selfPubkey);
		const lifespanAfterCommittedLoss = await page.evaluate(async (appliedOutcomeId) => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
				const store = transaction.objectStore('persona-bubble-field-player-state');
				const request = store.get('player-lifecycle');
				let lifespanAfterLoss = 0;
				await new Promise<void>((resolve, reject) => {
					request.onsuccess = () => {
						const current = request.result as {
							realtimeSettlementLedger?: { schemaVersion: number; identity: unknown; runNumber: number; pendingInstanceIds: string[]; appliedOutcomeIds: string[] };
							mode: { kind: 'running'; activeRun: { revision: number; gameState: { lifespanExpiresAtMs: number } } };
						};
						const ledger = current.realtimeSettlementLedger;
						if (!ledger) throw new Error('Expected a realtime settlement ledger.');
						lifespanAfterLoss = current.mode.activeRun.gameState.lifespanExpiresAtMs - 72 * 60 * 60 * 1_000;
						store.put({
							...current,
							mode: { kind: 'running', activeRun: { ...current.mode.activeRun, revision: current.mode.activeRun.revision + 1,
								gameState: { ...current.mode.activeRun.gameState, lifespanExpiresAtMs: lifespanAfterLoss } } },
							realtimeSettlementLedger: { ...ledger, appliedOutcomeIds: [...new Set([...ledger.appliedOutcomeIds, appliedOutcomeId])] }
						}, 'player-lifecycle');
					};
					request.onerror = () => reject(request.error);
					transaction.oncomplete = () => resolve();
					transaction.onerror = () => reject(transaction.error);
					transaction.onabort = () => reject(transaction.error);
				});
				return lifespanAfterLoss;
			} finally { database.close(); }
		}, outcomeId);
		await page.reload();
		const navigationsAfterRestore = mainFrameNavigations;
		expect(navigationsAfterRestore).toBe(initialMainFrameNavigations + 1);
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(12_000);
		await expect.poll(async () => mainFrameNavigations).toBe(navigationsAfterRestore);
		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		const persistedSettlement = await page.evaluate((appliedOutcomeId) => new Promise<{ lifespanExpiresAtMs: number; outcomeCount: number; pendingInstanceIds: string[] }>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('persona-bubble-field-player-state', 'readonly');
				const read = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				read.onerror = () => reject(read.error);
				read.onsuccess = () => {
					const state = read.result as { mode: { kind: string; activeRun?: { gameState: { lifespanExpiresAtMs: number } } }; realtimeSettlementLedger?: { appliedOutcomeIds: string[]; pendingInstanceIds: string[] } };
					resolve({ lifespanExpiresAtMs: state.mode.activeRun?.gameState.lifespanExpiresAtMs ?? 0,
						outcomeCount: state.realtimeSettlementLedger?.appliedOutcomeIds.filter((id) => id === appliedOutcomeId).length ?? 0,
						pendingInstanceIds: state.realtimeSettlementLedger?.pendingInstanceIds ?? [] });
				};
				transaction.oncomplete = () => database.close();
			};
		}), outcomeId);
		expect(persistedSettlement.lifespanExpiresAtMs).toBe(lifespanAfterCommittedLoss);
		expect(persistedSettlement.outcomeCount).toBe(1);
		expect(persistedSettlement.pendingInstanceIds).not.toContain(schedule.instanceId);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const exits = (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		expect(exits).toHaveLength(0);
	});
});
