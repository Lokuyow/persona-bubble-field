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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, upcomingRegistrationSchedule, nextScheduledCooperationDefectionSchedule, signedCooperationDefectionAction, syntheticChannelFixture, installDelayedRelay, relayState, seedRelayAccount, readRelayGameState, realtimeInstanceIds, isRealtimeRequest, readRealtimePendingInstances, seedRealtimePendingInstance, chooseHorizontalMove } from './helpers/relayHarness';

const formatJstDeadline = (timeMs: number) => `${new Intl.DateTimeFormat('ja-JP', {
	timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(timeMs))} JST`;

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


test.describe('Relay startup', () => {
	test('shows each participant the result for their own group', async ({ browser }) => {
		const schedule = upcomingRegistrationSchedule();
		const groups = deriveCooperationDefectionGroupPositions(schedule.instanceId, { columns: 16, rows: 8 }, 7);
		const [failureGroup, successGroup] = groups;
		if (!failureGroup || !successGroup) throw new Error('Expected two event groups.');
		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		const players = [
			{ secret: fixtureSecret(31), groupId: successGroup.id, choice: 'cooperate' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(32), groupId: failureGroup.id, choice: 'defect' as const, nonce: '2'.repeat(64) },
			{ secret: fixtureSecret(33), groupId: failureGroup.id, choice: 'cooperate' as const, nonce: '3'.repeat(64) },
			{ secret: fixtureSecret(34), groupId: failureGroup.id, choice: 'defect' as const, nonce: '4'.repeat(64) },
			{ secret: fixtureSecret(35), groupId: failureGroup.id, choice: 'defect' as const, nonce: '5'.repeat(64) },
			{ secret: fixtureSecret(36), groupId: successGroup.id, choice: 'cooperate' as const, nonce: '6'.repeat(64) },
			{ secret: fixtureSecret(37), groupId: successGroup.id, choice: 'defect' as const, nonce: '7'.repeat(64) }
		];
		const joins = players.map(({ secret, groupId }) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId }, schedule.registrationAtMs + 1_000));
		const commits = players.map(({ secret, groupId, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId, round: 1, authorPubkey: pubkey, choice, nonce });
			return { event: signedCooperationDefectionAction(secret, schedule, action, round.selectionAtMs + 1_000), choice, nonce, groupId };
		});
		const reveals = commits.map(({ event, choice, nonce, groupId }, index) => signedCooperationDefectionAction(players[index]!.secret, schedule,
			buildCooperationDefectionRevealAction({ groupId, round: 1, commitId: event.id, choice, nonce }), round.resultAtMs + 1_000));
		const realtimeEvents = [...joins, ...commits.map(({ event }) => event), ...reveals];
		const startTime = schedule.registrationAtMs + 1_000;
		const pageCooperate = await browser.newPage();
		const pageDefectFailure = await browser.newPage();
		const pageDefectSuccess = await browser.newPage();
		const selfCooperate = players[0]!;
		const selfDefectFailure = players[1]!;
		const selfDefectSuccess = players[6]!;
		const prepareParticipant = async (page: Page, player: (typeof players)[number]) => {
			const pubkey = getPublicKey(player.secret);
			await page.clock.install({ time: startTime });
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents, realtimeTerminal: 'closed', persistAcrossReload: true, realtimePublishOutcome: 'accepted' });
			await seedRelayAccount(page, player.secret, pubkey, startTime + 5 * 24 * 60 * 60 * 1_000);
			await page.goto('/');
			await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
			await page.evaluate((events) => {
				const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
				for (const event of events) relay.injectRealtimeEvent(event);
			}, realtimeEvents);
			await page.clock.setSystemTime(round.selectionAtMs + 1_000);
			await page.clock.runFor(1_000);
			await page.clock.setSystemTime(round.resultAtMs + 1_000);
			await page.clock.runFor(1_000);
			await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
			await page.clock.runFor(1_000);
		};
		try {
			await Promise.all([
				prepareParticipant(pageCooperate, selfCooperate),
				prepareParticipant(pageDefectFailure, selfDefectFailure),
				prepareParticipant(pageDefectSuccess, selfDefectSuccess)
			]);
			const cooperateResult = pageCooperate.locator('[data-cooperation-defection-round-result]');
			const defectFailureResult = pageDefectFailure.locator('[data-cooperation-defection-round-result]');
			const defectSuccessResult = pageDefectSuccess.locator('[data-cooperation-defection-round-result]');
			await expect(cooperateResult.locator('[data-cooperation-defection-own-result]')).toHaveText('協力成功');
			await expect(cooperateResult).toContainText('あなた: +100pt');
			await pageCooperate.getByRole('button', { name: '結果の詳細を見る' }).click();
			const cooperateDetails = pageCooperate.getByRole('region', { name: 'ラウンド1の結果の詳細' });
			await expect(cooperateDetails.locator('h3')).toHaveText('ラウンド 1 · 結果');
			await expect(cooperateDetails.locator('[data-cooperation-defection-group-verdict]')).toContainText('抜け駆け発生');
			await expect(cooperateDetails).not.toContainText('本人の選択未確認');
			await expect(cooperateDetails.locator('[data-cooperation-defection-breakdown="cooperate"]')).toContainText('協力 2人');
			await expect(cooperateDetails.locator('[data-cooperation-defection-breakdown="cooperate"]')).toContainText('+100pt');
			await expect(cooperateDetails.locator('[data-cooperation-defection-breakdown="defect"]')).toContainText('+10,000pt');
			await expect(cooperateDetails.locator('.breakdown-row.own-choice .self-participant')).toContainText('自分');
			await expect(defectFailureResult.locator('[data-cooperation-defection-own-result]')).toHaveText('抜け駆け失敗');
			await expect(defectFailureResult).toContainText('あなた: 寿命 −3日');
			await pageDefectFailure.getByRole('button', { name: '結果の詳細を見る' }).click();
			const defectFailureDetails = pageDefectFailure.getByRole('region', { name: 'ラウンド1の結果の詳細' });
			await expect(defectFailureDetails.locator('h3')).toHaveText('ラウンド 1 · 結果');
			await expect(defectFailureDetails.locator('[data-cooperation-defection-group-verdict]')).toContainText('失敗');
			await expect(defectFailureDetails.locator('[data-cooperation-defection-breakdown="defect"]')).toContainText('抜け駆け 3人');
			await expect(defectSuccessResult.locator('[data-cooperation-defection-own-result]')).toHaveText('抜け駆け成功');
			await expect(defectSuccessResult).toContainText('あなた: +10,000pt');
			await pageDefectSuccess.getByRole('button', { name: '結果の詳細を見る' }).click();
			const defectSuccessDetails = pageDefectSuccess.getByRole('region', { name: 'ラウンド1の結果の詳細' });
			await expect(defectSuccessDetails.locator('h3')).toHaveText('ラウンド 1 · 結果');
			await expect(defectSuccessDetails.locator('[data-cooperation-defection-group-verdict]')).toContainText('抜け駆け発生');
			for (const page of [pageCooperate, pageDefectFailure, pageDefectSuccess]) {
				await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'degraded');
				await expect(page.locator('[data-cooperation-defection-communication-warning]')).toBeVisible();
				await expect(page.locator('[data-cooperation-defection-round-result]')).toBeVisible();
				await expect(page.getByRole('region', { name: 'ラウンド1の結果の詳細' })).toBeVisible();
				await page.getByRole('button', { name: '結果の詳細を閉じる' }).click();
				await expect(page.getByRole('region', { name: 'ラウンド1の結果の詳細' })).toHaveCount(0);
				await page.getByRole('button', { name: '結果の詳細を見る' }).click();
				await expect(page.getByRole('region', { name: 'ラウンド1の結果の詳細' })).toBeVisible();
			}
		} finally {
			await Promise.all([pageCooperate.close(), pageDefectFailure.close(), pageDefectSuccess.close()]);
		}
	});

	test('shows valid choices without speculative rewards when a round is insufficient', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, { columns: 16, rows: 8 }, 7)[0]!;
		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		const secrets = [fixtureSecret(31), fixtureSecret(32), fixtureSecret(33)];
		const joins = secrets.map((secret) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000));
		const validChoices = [{ secret: secrets[0]!, choice: 'cooperate' as const, nonce: '8'.repeat(64) }, { secret: secrets[1]!, choice: 'defect' as const, nonce: '9'.repeat(64) }];
		const commits = validChoices.map(({ secret, choice, nonce }) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: group.id, round: 1, authorPubkey: getPublicKey(secret), choice, nonce }), round.selectionAtMs + 1_000));
		const reveals = validChoices.map(({ secret, choice, nonce }, index) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionRevealAction({ groupId: group.id, round: 1, commitId: commits[index]!.id, choice, nonce }), round.resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [...joins, ...commits, ...reveals], realtimeTerminal: 'closed', persistAcrossReload: true, realtimePublishOutcome: 'accepted' });
		await seedRelayAccount(page, secrets[0]!, getPublicKey(secrets[0]!), startTime + 5 * 24 * 60 * 60 * 1_000);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, [...joins, ...commits, ...reveals]);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-cooperation-defection-own-result]')).toHaveText('ラウンド不成立');
		await page.getByRole('button', { name: '結果の詳細を見る' }).click();
		const details = page.getByRole('region', { name: 'ラウンド1の結果の詳細' });
		await expect(details.locator('[data-cooperation-defection-group-verdict]')).toContainText('不成立');
		await expect(details.locator('[data-cooperation-defection-personal-score]')).toHaveCount(0);
		await expect(details.locator('[data-cooperation-defection-breakdown="cooperate"]')).toContainText('協力 1人');
		await expect(details.locator('[data-cooperation-defection-breakdown="defect"]')).toContainText('抜け駆け 1人');
		await expect(details).not.toContainText('pt');
		await expect(details).not.toContainText('寿命 −3日');
	});

	test('does not create a settlement recovery marker for a spectator receiving another player join', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const spectatorEvent = signedCooperationDefectionAction(fixtureSecret(20), schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000);
		await page.clock.install({ time: schedule.registrationAtMs + 1_000 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(schedule.registrationAtMs + 1_000), realtimeEvents: [spectatorEvent] });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
	});

	test('rejects a stale CooperationDefection join confirmation after movement or registration ends', async ({ page }) => {
		const { schedule, group } = scheduleWithDistantFirstGroup(upcomingRegistrationSchedule());
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [], realtimePublishOutcome: 'accepted' });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-group-trigger]')).toHaveCount(1);

		const nearPosition = group.position.y > 0 ? { x: group.position.x, y: group.position.y - 1 } : { x: group.position.x, y: group.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);

		const farPosition = { x: group.position.x > 2 ? group.position.x - 2 : group.position.x + 2, y: group.position.y };
		const farEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: farPosition, slot: 0, createdAt: Math.floor((startTime + 3_000) / 1000) }), selfSecret);
		await page.locator('[data-realtime-group-trigger]').click();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), farEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${farPosition.x},${farPosition.y}`);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const nearEventAgain = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 4_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEventAgain);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-group-trigger]').click();
		await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
	});

	for (const input of [
		{ name: 'desktop pointer', viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false },
		{ name: 'mobile touch pointer', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
	]) {
		test(`toggles Cooperation and Defection rules with a real ${input.name}`, async ({ browser }) => {
			const page = await browser.newPage({ viewport: input.viewport, isMobile: input.isMobile, hasTouch: input.hasTouch });
			try {
				const schedule = upcomingRegistrationSchedule();
				const startTime = schedule.registrationAtMs + 1_000;
				await page.clock.install({ time: startTime });
				await installHostOwnedStub(page);
				await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [] });
				const secret = fixtureSecret(19);
				await seedRelayAccount(page, secret, getPublicKey(secret));
				await page.goto('/');
				await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
				const summary = page.locator('.cooperation-defection-rules-disclosure summary');
				const disclosure = page.locator('.cooperation-defection-rules-disclosure');
				const rules = page.locator('.cooperation-defection-rules-inline');
				const positionBefore = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
				const bounds = await summary.boundingBox();
				if (!bounds) throw new Error('Expected visible rules disclosure control.');
				const tapRules = async () => {
					const x = bounds.x + bounds.width / 2;
					const y = bounds.y + bounds.height / 2;
					if (input.hasTouch) await page.touchscreen.tap(x, y);
					else await page.mouse.click(x, y);
				};
				await tapRules();
				await expect(disclosure).toHaveJSProperty('open', true);
				await expect(rules).toBeVisible();
				await tapRules();
				await expect(disclosure).toHaveJSProperty('open', false);
				await expect(rules).toBeHidden();
				await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', positionBefore!);
				await expect(page.locator('.pointer-joystick')).toHaveCount(0);
			} finally {
				await page.close();
			}
		});
	}

	test('completes CooperationDefection join, snapshot, commit, automatic reveal, settlement, and reload recovery', async ({ page }) => {
		const { schedule, group } = scheduleWithDistantFirstGroup(upcomingRegistrationSchedule());
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'cooperate' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'cooperate' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: group.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedCooperationDefectionAction(secret, schedule, action, getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, pubkey, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionRevealAction({ groupId: group.id, round: 1, commitId: event.id, choice, nonce }), getCooperationDefectionRoundSchedule(schedule, 1).resultAtMs + 1_000));
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
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();

		await page.locator('[data-realtime-group-trigger]').click();
		await page.clock.runFor(50);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		const nearPosition = group.position.y > 0 ? { x: group.position.x, y: group.position.y - 1 } : { x: group.position.x, y: group.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-group-trigger]').click();
		await expect(page.getByRole('dialog')).toContainText('3〜6人 / 全3ラウンド');
		await expect(page.getByRole('dialog').locator('[data-cooperation-defection-registration-deadline]')).toHaveText(`受付締切: ${formatJstDeadline(schedule.gameAtMs)}`);
		await expect(page.getByRole('dialog').locator('[data-cooperation-defection-registration-countdown]')).toContainText(/^残り時間: 04:\d{2}$/);
		await expect(page.getByRole('dialog')).toContainText('寿命を3日失います。残り寿命によっては死亡します。');
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.getByRole('button', { name: 'キャンセル' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('rejected'));
		await page.locator('[data-realtime-group-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		}).length).toBeGreaterThan(0);
		await expect(page.locator('[data-realtime-panel]')).not.toContainText('参加済み');
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		await page.locator('[data-realtime-group-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		})).toBe(true);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		await expect(page.locator('[data-cooperation-defection-registration-deadline]')).toHaveText(`受付締切: ${formatJstDeadline(schedule.gameAtMs)}`);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveAttribute('aria-label', '参加地点に参加済み（参加先）');

		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('選択');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加中（3人）');
		await page.locator('[data-cooperation-defection-choice="cooperate"]').click();
		await expect(page.locator('[data-cooperation-defection-choice="cooperate"]')).toBeDisabled();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);

		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		await expect(page.locator('[data-cooperation-defection-selection-status]')).toContainText('自動公開済み');

		await page.clock.setSystemTime(round.resultAtMs + 2_000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('[data-realtime-panel]')).toContainText('ゲーム中');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals]);
		await page.clock.runFor(100);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '協力')).toBe(false);
		await page.locator('.speech-type-toggle').click();
		await expect(page.locator('.speech-type-toggle')).toHaveAttribute('data-speech-type', 'shout');
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(2_000);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(1_000);
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('+1,000pt');
		await expect(page.locator('[data-cooperation-defection-own-result]')).toHaveText('全員協力');
		await expect(page.locator('[data-cooperation-defection-selection-status]')).toHaveCount(0);
		await page.getByRole('button', { name: '結果の詳細を見る' }).click();
		await expect(page.getByRole('region', { name: 'ラウンド1の結果の詳細' }).locator('[data-cooperation-defection-group-verdict]')).toContainText('協力成功');
		await page.getByRole('button', { name: '結果の詳細を閉じる' }).click();
		const automaticSpeech = (await relayState(page)).state.published.find((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '協力');
		expect(automaticSpeech).toBeDefined();
		expect(verifyEvent(automaticSpeech as unknown as NostrEvent)).toBe(true);
		expect(parseWorldMessage(automaticSpeech as unknown as NostrEvent, CHANNEL_ID)).toMatchObject({ content: '協力', speechType: 'normal' });
		expect(automaticSpeech?.tags).toContainEqual(['l', 'chat', 'io.github.lokuyow.persona-bubble-field']);
		const automaticBubble = page.locator(`.bubble[data-bubble-participant-id="${selfPubkey}"]`).filter({ hasText: '協力' });
		await expect(automaticBubble).toBeVisible();
		const compactPanel = page.locator('[data-realtime-panel]');
		const naturallyPlacedRects = await Promise.all([automaticBubble.boundingBox(), compactPanel.boundingBox()]);
		if (!naturallyPlacedRects[0] || !naturallyPlacedRects[1]) throw new Error('Expected measured result bubble and compact panel bounds.');
		const [bubbleBox, panelBox] = naturallyPlacedRects;
		expect(bubbleBox.x < panelBox.x + panelBox.width && bubbleBox.x + bubbleBox.width > panelBox.x && bubbleBox.y < panelBox.y + panelBox.height && bubbleBox.y + bubbleBox.height > panelBox.y).toBe(false);
		const bubbleText = automaticBubble.locator('.bubble-content');
		await bubbleText.selectText();
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('協力');
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		const frontmostDuringOverlap = await automaticBubble.evaluate((element) => {
			const panel = document.querySelector('[data-realtime-panel]')!.getBoundingClientRect();
			const rect = element.getBoundingClientRect();
			(element as HTMLElement).style.transform = `translate3d(${panel.left + (panel.width - rect.width) / 2}px, ${panel.top + (panel.height - rect.height) / 2}px, 0)`;
			const updated = element.getBoundingClientRect();
			return document.elementFromPoint(updated.left + updated.width / 2, updated.top + updated.height / 2)?.closest('.bubble') === element;
		});
		expect(frontmostDuringOverlap).toBe(true);
		await expect(page.locator(`.recent-message-timeline [data-timeline-pubkey="${selfPubkey}"] .timeline-content`).filter({ hasText: /^協力$/ })).toBeVisible();
		await expect(page.locator('.speech-type-toggle')).toHaveAttribute('data-speech-type', 'shout');
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();

		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('[data-realtime-panel]')).toContainText('ゲーム中');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect.poll(async () => {
			const state = (await relayState(page)).state;
			const messageIds = [...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 42 && event.pubkey === selfPubkey && event.content === '協力')
				.map((event) => event.id);
			return new Set(messageIds).size;
		}).toBe(1);

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await expect.poll(async () => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		await expect(page.locator('[data-realtime-group-trigger]')).toHaveCount(0);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(1_000);
	});

	test('keeps automatic publication error visible when the confirmed result does not include the player', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, COOPERATION_DEFECTION_FIELD_SIZE)[0];
		if (!group) throw new Error('Expected a CooperationDefection group.');
		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		const otherPlayers = [
			{ secret: fixtureSecret(41), nonce: '4'.repeat(64) },
			{ secret: fixtureSecret(47), nonce: '5'.repeat(64) },
			{ secret: fixtureSecret(51), nonce: '6'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: group.id, round: 1, authorPubkey: pubkey, choice: 'cooperate', nonce });
			return { secret, nonce, event: signedCooperationDefectionAction(secret, schedule, action, round.selectionAtMs + 1_000) };
		});
		const otherReveals = otherCommits.map(({ secret, nonce, event }) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionRevealAction({ groupId: group.id, round: 1, commitId: event.id, choice: 'cooperate', nonce }), round.resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(43);
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
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		const selfJoin = signedCooperationDefectionAction(selfSecret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 2_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(event), selfJoin);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加中（4人）');
		await page.locator('[data-cooperation-defection-choice="cooperate"]').click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('no-response'));
		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(10_500);
		await expect(page.locator('[data-cooperation-defection-selection-status]')).toContainText('自動公開エラー（結果未確認）');
		const result = page.locator('[data-cooperation-defection-round-result]');
		await expect(result.locator('[data-cooperation-defection-own-result]')).toHaveText('本人の選択未確認');
		await expect(page.locator('[data-cooperation-defection-selection-status]')).toContainText('自動公開エラー（結果未確認）');
		await page.getByRole('button', { name: '結果の詳細を見る' }).click();
		const details = page.getByRole('region', { name: 'ラウンド1の結果の詳細' });
		await expect(details.locator('h3')).toHaveText('ラウンド 1 · 結果');
		await expect(details.locator('[data-cooperation-defection-group-verdict]')).toContainText('協力成功');
		await expect(details.locator('[data-cooperation-defection-own-choice-unconfirmed]')).toContainText('本人の選択未確認');
		await expect(details.locator('[data-cooperation-defection-breakdown="cooperate"] .self-participant')).toHaveCount(0);
		await expect(details.locator('.self-participant')).toHaveCount(0);
		await expect(details).not.toContainText('全員協力');
		await expect(details).not.toContainText('あなた:');
	});
});
