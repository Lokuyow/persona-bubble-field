import { expect, test, type Page } from '@playwright/test';
import { getPublicKey, type Event } from 'nostr-tools/pure';
import {
	buildCooperationDefectionCommitAction,
	buildCooperationDefectionRevealAction,
	buildManualCooperationDefectionInstanceId,
	COOPERATION_DEFECTION_PROTOCOL_KEY,
	deriveCooperationDefectionGroupPositions,
	getCooperationDefectionRoundSchedule,
	getCooperationDefectionScheduleForInstance,
	type CooperationDefectionAction
} from '../../src/lib/cooperationDefection';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import {
	AUTHORITATIVE_RELAYS,
	fixtureSecret,
	installDelayedRelay,
	readRealtimePendingInstances,
	readRelayGameState,
	relayState,
	seedRelayAccount,
	signedCooperationDefectionAction,
	syntheticChannelFixture,
	testEvents,
	upcomingRegistrationSchedule
} from './helpers/relayHarness';

const FIELD = { columns: 16, rows: 8 } as const;
const CANCELLATION_NOTICE = '参加人数が足りなかったため開催されませんでした';

async function prepare(page: Page, nowMs: number, realtimeEvents: readonly Event[], persistAcrossReload = false): Promise<void> {
	await page.clock.install({ time: nowMs });
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(nowMs), realtimeEvents, persistAcrossReload, realtimePublishOutcome: 'accepted' });
}

async function releaseInitialSubscriptions(page: Page): Promise<void> {
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
}

function signedAction(secret: Uint8Array, schedule: ReturnType<typeof upcomingRegistrationSchedule>, action: CooperationDefectionAction, timeMs: number): Event {
	return signedCooperationDefectionAction(secret, schedule, action, timeMs);
}

test.describe('Cooperation and Defection underfilled group cancellation', () => {
	test('does not decide before realtime bootstrap, cancels a two-person scheduled group, and recovers after reload', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const group = deriveCooperationDefectionGroupPositions(schedule.instanceId, FIELD)[0];
		if (!group) throw new Error('Expected the scheduled event group.');
		const selfSecret = fixtureSecret(19);
		const otherSecret = fixtureSecret(20);
		const joinEvents = [selfSecret, otherSecret].map((secret, index) => signedAction(secret, schedule,
			{ action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000 + index));
		const nowMs = getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000;
		await prepare(page, nowMs, joinEvents, true);
		const initialExpiry = nowMs + 5 * 24 * 60 * 60 * 1_000;
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret), initialExpiry, 100_000);
		await page.goto('/');
		await expect(page.locator('[data-cooperation-defection-cancelled]')).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-participants-loading]')).toBeVisible();
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toHaveCount(0);
		await releaseInitialSubscriptions(page);
		const notice = page.locator('[data-cooperation-defection-cancelled]');
		await expect(notice).toHaveText(CANCELLATION_NOTICE);
		await expect(page.locator('[data-cooperation-defection-participants-loading]')).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-choice]')).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-round-result]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		expect(await readRelayGameState(page)).toMatchObject({ points: 100_000, lifespanExpiresAtMs: initialExpiry });
		const firstPublished = (await relayState(page)).state.published;
		expect(firstPublished.filter((event) => event.kind === 7070 && event.pubkey === getPublicKey(selfSecret))).toHaveLength(0);
		expect(firstPublished.filter((event) => event.kind === 42 && event.pubkey === getPublicKey(selfSecret))).toHaveLength(0);
		await page.clock.runFor(5_100);
		await expect(page.locator('[data-realtime-panel]')).toHaveCount(0);

		await page.reload();
		await releaseInitialSubscriptions(page);
		await expect(page.locator('[data-cooperation-defection-cancelled]')).toHaveText(CANCELLATION_NOTICE);
		await expect(page.locator('[data-cooperation-defection-choice]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		const profile = page.getByRole('dialog');
		await expect(profile.getByRole('button', { name: '脱出', exact: true })).toBeEnabled();
		await profile.getByRole('button', { name: '脱出', exact: true }).click();
		await expect(page.getByText('脱出しました', { exact: true })).toBeVisible();
	});

	test('does not show round progress for a spectator when there are no participants', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const nowMs = getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000;
		const secret = fixtureSecret(19);
		await prepare(page, nowMs, []);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('[data-cooperation-defection-participants-loading]')).toBeVisible();
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toHaveCount(0);
		await releaseInitialSubscriptions(page);
		await expect(page.locator('[data-cooperation-defection-participants-loading]')).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-round-result]')).toHaveCount(0);

		const delayedGroup = deriveCooperationDefectionGroupPositions(schedule.instanceId, FIELD, 7)[1];
		if (!delayedGroup) throw new Error('Expected delayed joins to derive a second group.');
		const delayedJoins = [21, 23, 29, 30, 31, 32, 33].map((label, index) => signedAction(fixtureSecret(label), schedule,
			{ action: 'join', groupId: delayedGroup.id }, schedule.registrationAtMs + 2_000 + index));
		await page.evaluate((events) => {
			const harness = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) harness.injectRealtimeEvent(event);
		}, delayedJoins);
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toHaveCount(0);
	});

	test('applies underfilled cancellation to a manually started event', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const scheduled = upcomingRegistrationSchedule();
		const createdAt = Math.floor((scheduled.warningAtMs - 30 * 60 * 1_000) / 1_000);
		const instanceId = buildManualCooperationDefectionInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		const schedule = getCooperationDefectionScheduleForInstance(instanceId, createdAt * 1_000);
		if (!schedule) throw new Error('Expected the manual event schedule.');
		const group = deriveCooperationDefectionGroupPositions(instanceId, FIELD)[0];
		if (!group) throw new Error('Expected the manual event group.');
		const secret = fixtureSecret(19);
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		const join = signedCooperationDefectionAction(secret, schedule, { action: 'join', groupId: group.id }, schedule.registrationAtMs + 1_000, channel.event.id);
		const nowMs = getCooperationDefectionRoundSchedule(schedule, 1).selectionAtMs + 1_000;
		await page.clock.install({ time: nowMs });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { testWorldConfig: channel.worldConfig, primaryEvents: testEvents(nowMs, channel.event.id), realtimeEvents: [control, join] });
		await seedRelayAccount(page, secret, getPublicKey(secret), nowMs + 5 * 24 * 60 * 60 * 1_000);
		await page.goto('/');
		await releaseInitialSubscriptions(page);
		await expect(page.locator('[data-realtime-panel]')).toContainText('運営開催');
		await expect(page.locator('[data-cooperation-defection-cancelled]')).toHaveText(CANCELLATION_NOTICE);
		await expect(page.locator('[data-cooperation-defection-choice]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
	});

	test('continues a sufficiently staffed group beside an underfilled group', async ({ browser }) => {
		const schedule = upcomingRegistrationSchedule();
		const [underfilledGroup, activeGroup] = deriveCooperationDefectionGroupPositions(schedule.instanceId, FIELD, 7);
		if (!underfilledGroup || !activeGroup) throw new Error('Expected two groups for seven registered players.');
		const players = Array.from({ length: 7 }, (_, index) => ({ secret: fixtureSecret(index + 30), groupId: index < 2 ? underfilledGroup.id : activeGroup.id }));
		const joins = players.map(({ secret, groupId }, index) => signedCooperationDefectionAction(secret, schedule,
			{ action: 'join', groupId }, schedule.registrationAtMs + 1_000 + index));
		const activePlayers = players.slice(2, 5);
		const round = getCooperationDefectionRoundSchedule(schedule, 1);
		const commits = activePlayers.map(({ secret }, index) => {
			const choice = 'cooperate' as const;
			const nonce = String(index + 1).repeat(64);
			const commitment = buildCooperationDefectionCommitAction({ instanceId: schedule.instanceId, groupId: activeGroup.id, round: 1,
				authorPubkey: getPublicKey(secret), choice, nonce });
			const event = signedCooperationDefectionAction(secret, schedule, commitment, round.selectionAtMs + 1_000 + index);
			return { secret, choice, nonce, event };
		});
		const reveals = commits.map(({ secret, choice, nonce, event }, index) => signedCooperationDefectionAction(secret, schedule,
			buildCooperationDefectionRevealAction({ groupId: activeGroup.id, round: 1, commitId: event.id, choice, nonce }), round.resultAtMs + 1_000 + index));
		const realtimeEvents = [...joins, ...commits.map(({ event }) => event), ...reveals];
		const nowMs = round.revealCutoffAtMs + 1_000;
		const cancelledPage = await browser.newPage();
		const activePage = await browser.newPage();
		const spectatorPage = await browser.newPage();
		const cancelledSelf = players[0]!;
		const activeSelf = players[2]!;
		const prepareParticipant = async (page: Page, player: (typeof players)[number]) => {
			await prepare(page, nowMs, realtimeEvents);
			await seedRelayAccount(page, player.secret, getPublicKey(player.secret), nowMs + 5 * 24 * 60 * 60 * 1_000);
			await page.goto('/');
			await releaseInitialSubscriptions(page);
		};
		const prepareSpectator = async () => {
			const secret = fixtureSecret(41);
			await prepare(spectatorPage, nowMs, realtimeEvents);
			await seedRelayAccount(spectatorPage, secret, getPublicKey(secret), nowMs + 5 * 24 * 60 * 60 * 1_000);
			await spectatorPage.goto('/');
			await releaseInitialSubscriptions(spectatorPage);
		};
		try {
			await Promise.all([prepareParticipant(cancelledPage, cancelledSelf), prepareParticipant(activePage, activeSelf), prepareSpectator()]);
			await expect(cancelledPage.locator('[data-cooperation-defection-cancelled]')).toHaveText(CANCELLATION_NOTICE);
			await expect(cancelledPage.locator('[data-cooperation-defection-round-result]')).toHaveCount(0);
			await expect(cancelledPage.locator('[data-cooperation-defection-choice]')).toHaveCount(0);
			await expect(cancelledPage.locator('[data-cooperation-defection-round-progress]')).toHaveCount(0);
			await expect(activePage.locator('[data-cooperation-defection-round-result]')).toContainText('全員協力');
			await expect(activePage.locator('[data-cooperation-defection-round-result]')).toContainText('あなた: +1,000pt');
			await expect(activePage.locator('[data-cooperation-defection-round-progress]')).toBeVisible();
			await expect(spectatorPage.locator('[data-cooperation-defection-round-progress]')).toBeVisible();
			await expect(spectatorPage.locator('[data-cooperation-defection-round-result]')).toHaveCount(0);
			await expect.poll(async () => readRealtimePendingInstances(cancelledPage)).toEqual([]);
			await expect.poll(async () => readRealtimePendingInstances(activePage)).toEqual([schedule.instanceId]);
			expect(await readRelayGameState(cancelledPage)).toMatchObject({ points: 0 });
			expect(await readRelayGameState(activePage)).toMatchObject({ points: 1_000 });
		} finally {
			await Promise.all([cancelledPage.close(), activePage.close(), spectatorPage.close()]);
		}
	});
});
