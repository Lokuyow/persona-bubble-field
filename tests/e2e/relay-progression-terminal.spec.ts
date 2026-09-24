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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, overwriteRelayMendingBuild, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, chooseMoveToward, moveRelaySelfTo } from './helpers/relayHarness';


test.describe('Relay startup', () => {
	test('runs and collects a mending job only from the adjacent terminal cells', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const terminal = page.getByRole('button', { name: '作業端末' });
		const mendingFacility = page.locator('[data-field-facility="mending-terminal"]');
		await expect(mendingFacility.locator('img')).toHaveAttribute('src', /field\/objects\/mending-terminal\.webp$/);
		await expect(mendingFacility).not.toContainText('作業');
		await expect(page.locator('[data-field-facility="adjustment-terminal"] img')).toHaveAttribute('src', /field\/objects\/adjustment-terminal\.webp$/);
		await expect(page.locator('[data-field-facility="adjustment-terminal"]')).not.toContainText('能力強化');
		await terminal.click();
		await expect(page.getByRole('status')).toContainText('近づくと端末を使える');

		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.runFor(1_001);
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await dragRelayJoystick(page, { x: 0, y: -100 }, { x: 12, y: 4 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,2');
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const publishedWorldStateCount = async () => (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length;
		const beforeMendingStart = await publishedWorldStateCount();
		await page.clock.runFor(1_001);
		await terminal.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingStart);
		const started = await readRelayGameState(page);
		expect(started).toMatchObject({ version: 4, points: 0, pointProgressTicks: 0, mendingJob: expect.objectContaining({ processedDurationMs: 0, unclaimedPoints: 0 }) });
		const activeDialog = page.getByRole('dialog');
		await expect(activeDialog.getByRole('heading', { name: '作業中' })).toBeVisible();
		await expect(activeDialog.locator('.mending-startup-feedback')).toContainText('作業を開始しました');
		const startupScrollExtent = await activeDialog.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight
		}));
		expect(startupScrollExtent.scrollWidth).toBeLessThanOrEqual(startupScrollExtent.clientWidth);
		await expect.poll(async () => activeDialog.locator('.mending-startup-feedback').count()).toBe(0);
		const settledScrollExtent = await activeDialog.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
		expect(settledScrollExtent.scrollWidth).toBeLessThanOrEqual(settledScrollExtent.clientWidth);
		expect(settledScrollExtent.scrollHeight - settledScrollExtent.clientHeight).toBe(startupScrollExtent.scrollHeight - startupScrollExtent.clientHeight);
		await expect(activeDialog.getByRole('button', { name: '作業を開始' })).toHaveCount(0);
		await expect(activeDialog).toContainText('作業中');
		await expect(activeDialog).toContainText('0 pt');
		await expect(activeDialog).toContainText('上限まで あと5分');
		await expect(activeDialog).not.toContainText('今受け取れる');
		await expect(activeDialog).toContainText('+0 pt');
		await expect(activeDialog.locator('[data-mending-icon="wallet"] svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="coins"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="heart"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(activeDialog.locator('.reward-group .action-group')).toHaveCount(1);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
		await expect(activeDialog.locator('.mending-success-feedback')).toHaveCount(0);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toBeDisabled();
		const beforeZeroPointCollection = await publishedWorldStateCount();
		await expect.poll(publishedWorldStateCount).toBe(beforeZeroPointCollection);
		await expect(activeDialog.getByRole('button', { name: '詳細を見る' })).toHaveAttribute('aria-expanded', 'false');
		await activeDialog.getByRole('button', { name: '詳細を見る' }).click();
		await expect(activeDialog).toContainText('現在のポイント速度');
		await expect(activeDialog.getByRole('button', { name: '詳細を閉じる' })).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('aria-label', '作業中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('data-mending-icon', 'tool');
		await expect(page.locator('.lifespan-hud [data-mending-rate]')).toHaveText('1.00 pt/分+0.1h/h');
		const activeMendingRow = page.locator('.lifespan-hud [data-mending-row]');
		const activeRowBoxes = await activeMendingRow.evaluate((row) => {
			const status = row.querySelector('[data-mending-status]')!.getBoundingClientRect();
			const rate = row.querySelector('[data-mending-rate]')!.getBoundingClientRect();
			const pointRate = row.querySelector('[data-mending-rate] > span:first-child')!.getBoundingClientRect();
			const lifespanRate = row.querySelector('[data-mending-rate] > span:last-child')!.getBoundingClientRect();
			return { statusRight: status.right, rateLeft: rate.left, pointLeft: pointRate.left, pointRight: pointRate.right, lifespanLeft: lifespanRate.left, lifespanRight: lifespanRate.right, rowRight: row.getBoundingClientRect().right };
		});
		expect(activeRowBoxes.rateLeft).toBeGreaterThanOrEqual(activeRowBoxes.statusRight);
		expect(activeRowBoxes.lifespanLeft).toBeGreaterThan(activeRowBoxes.pointRight);
		expect(Math.round(activeRowBoxes.lifespanRight)).toBe(Math.round(activeRowBoxes.rowRight));
		await page.getByRole('button', { name: '閉じる', exact: true }).click();

		const startedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs;
		const partialAt = startedAt + 1 * 60 * 1000 + 30 * 1000;
		await page.clock.setSystemTime(partialAt);
		await pauseAtCurrentBrowserTime(page);
		await terminal.click();
		const partialDialog = page.getByRole('dialog');
		await expect(partialDialog.locator('.mending-startup-feedback')).toHaveCount(0);
		await expect(partialDialog).toContainText('上限まで あと4分');
		await expect(partialDialog).toContainText(/次の1ptまで [1-9][0-9]?秒/);
		await expect(partialDialog.locator('.next-point[data-mending-icon="clock"] > svg')).toHaveCount(1);
		await expect(partialDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(partialDialog).toContainText('+1 pt');
		await expect(partialDialog.getByRole('button', { name: '成果を受け取る' })).toBeEnabled();
		const beforeMendingReward = await publishedWorldStateCount();
		await partialDialog.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(async () => {
			const partialState = await readRelayGameState(page);
			return partialState.points === 1 && partialState.pointProgressTicks > 0 && partialState.pointProgressTicks < 60_000_000;
		}).toBe(true);
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingReward);
		await expect(page.locator('.mending-success-feedback')).toContainText('+1 pt');

		const secondAt = partialAt + 3 * 60 * 1000;
		await page.clock.setSystemTime(secondAt);
		await pauseAtCurrentBrowserTime(page);
		if (await page.getByRole('dialog').count() > 0) await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await terminal.click();
		await expect(page.getByRole('dialog')).toContainText('+3 pt');
		await page.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(4);

		if (await page.getByRole('dialog').count() > 0) await page.getByRole('button', { name: '閉じる', exact: true }).click();
		const afterSecond = await readRelayGameState(page);
		const fullAt = (afterSecond.mendingJob as { startedAtMs: number }).startedAtMs + 5 * 60 * 1000;
		await page.clock.setSystemTime(fullAt);
		await pauseAtCurrentBrowserTime(page);
		const completedAtTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 2 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), completedAtTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,2');
		await terminal.click();
		await expect(page.getByRole('dialog')).toContainText('上限に達しました');
		await expect(page.getByRole('dialog').getByRole('heading', { name: '作業停止中' })).toBeVisible();
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('aria-label', '作業停止中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('data-mending-icon', 'player-pause');
		await expect(page.locator('.lifespan-hud [data-mending-rate]')).toHaveText('0.00 pt/分+0.0h/h');
		await expect(page.getByRole('dialog')).not.toContainText('今受け取れる');
		await expect(page.getByRole('dialog')).toContainText('+5 pt');
		await expect(page.getByRole('dialog')).not.toContainText('次の1ptまで');
		await expect(page.getByRole('dialog').locator('[data-mending-icon="coins"] .next-point')).toHaveClass(/next-point-hidden/);
		await page.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object), points: 9, pointProgressTicks: 30_000_000 });
		await expect(page.getByRole('dialog')).toContainText('9 pt');
		await expect(page.getByRole('dialog')).toContainText('上限まで あと5分');
		await expect(page.getByRole('dialog')).toContainText('+0 pt');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('aria-label', '作業中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('data-mending-icon', 'tool');
		await expect(page.locator('.lifespan-hud [data-mending-rate]')).toHaveText('1.00 pt/分+0.1h/h');
		const collected = await readRelayGameState(page);
		expect(collected.mendingJob).toEqual(expect.objectContaining({ startedAtMs: expect.any(Number) }));
		expect(collected.points).toBe(9);
		expect(collected.lifespanExpiresAtMs).toBeGreaterThan(started.lifespanExpiresAtMs);
		expect(collected.lifespanExpiresAtMs).toBeLessThanOrEqual(started.lifespanExpiresAtMs + 6 * 60 * 1000);
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
	});

	test('opens the adjustment terminal only nearby and persists one ability upgrade', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 10);
		await page.goto('/');
		const adjustment = page.getByRole('button', { name: '能力強化端末' });
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await adjustment.click();
		await expect(page.locator('.trace-proximity-feedback[role="status"]')).toContainText('近づくと端末を使える');

		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await adjustment.click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		await expect(dialog).toContainText('10 pt');
		await expect(dialog).not.toContainText('POINT');
		await expect(dialog).not.toContainText('ポイントを使って、より効率よく活動できるようにします。');
		await expect(dialog.locator('.ability-card')).toHaveCount(3);
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Lv1');
		await expect(dialog).toContainText('1.00');
		await expect(dialog).toContainText('1.10');
		await expect(dialog).toContainText('ポイント生成速度');
		await expect(dialog).toContainText('必要ポイント');
		await expect(dialog.getByRole('button', { name: 'Lv2へ強化' }).first()).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Lv2へ強化' }).first()).toHaveCSS('color', 'rgb(255, 255, 255)');
		const beforeAbilityUpgrade = (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length;
		await page.clock.runFor(1_001);
		const upgradedCard = dialog.locator('.ability-card').first();
		const stableBefore = await upgradedCard.evaluate((card) => {
			const type = card.querySelector('.ability-type')!.getBoundingClientRect();
			const cost = card.querySelector('.cost')!.getBoundingClientRect();
			const button = card.querySelector('button')!.getBoundingClientRect();
			return { typeY: type.y, costY: cost.y, buttonY: button.y };
		});
		await expect(dialog).not.toContainText('強化後');
		await expect(dialog).not.toContainText('normal clear');
		await expect(dialog).not.toContainText('Root Point');
		await dialog.getByRole('button', { name: 'Lv2へ強化' }).first().click();
		await expect(dialog).toContainText('9 pt');
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length).toBeGreaterThan(beforeAbilityUpgrade);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		const stableDuring = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			costY: card.querySelector('.cost')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableDuring).toEqual(stableBefore);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(0, { timeout: 1_500 });
		const stableAfter = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			costY: card.querySelector('.cost')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableAfter).toEqual(stableBefore);
		await expect(page.locator('.lifespan-hud [data-stat-icon="wallet"]')).toHaveText('9pt');
		await expect(page.locator('.lifespan-hud')).toHaveAttribute('aria-label', /ポイント 9pt/);
		await expect(dialog).toContainText('推論効率 Lv2');
		await page.reload();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 9, abilities: { inferenceEfficiency: 2, contextCapacity: 1, hallucinationSuppression: 1 } });
	});

	test('shows the linear Run effect and arrival-level cost at the adjustment terminal', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 10, { inferenceEfficiency: 10, contextCapacity: 1, hallucinationSuppression: 1 });
		await page.goto('/');
		await page.evaluate(() => {
			(window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await page.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		const inference = dialog.locator('.ability-card').first();
		await expect(inference).toContainText('1.90');
		await expect(inference).toContainText('+0.10 pt/分');
		await expect(inference.locator('.cost')).toContainText('2 pt');
		await inference.getByRole('button', { name: 'Lv11へ強化' }).click();
		await expect(inference).toContainText('2.00');
		await expect(inference.locator('.cost')).toContainText('2 pt');
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 8, abilities: { inferenceEfficiency: 11 } });
	});

	test('shows maxed abilities as unavailable at the adjustment terminal', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await page.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		await expect(dialog.getByRole('button', { name: '最大Lv' })).toHaveCount(3);
		for (const button of await dialog.getByRole('button', { name: '最大Lv' }).all()) await expect(button).toBeDisabled();
	});

	test('routes self around fixed terminals and active participants', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		const remoteSecret = fixtureSecret(20);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atThirteenThree = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		const occupiedAbove = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 2 }, slot: 0,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), remoteSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atThirteenThree);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), occupiedAbove);
		await expect(page.locator(`.participant[data-participant-id="${occupiedAbove.pubkey}"]`)).toHaveAttribute('data-position', '13,2');
		await expect(chooseMoveToward(page, { x: 11, y: 3 })).resolves.toEqual({ key: 'ArrowDown', expected: '13,4' });
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
	});
});
