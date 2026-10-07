import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectDialogIconCloseButton, finishDialogEntrance, finishDialogExit } from './helpers/dialogMotion';
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
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { formatElapsedDuration } from '../../src/lib/lifespanHud';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, overwriteRelayMendingBuild, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, chooseMoveToward, moveRelaySelfTo } from './helpers/relayHarness';

type MendingRewardObservation = {
	done: boolean;
	sawSummary: boolean;
	sawImpactBloom: boolean;
	sawJackpotBloom: boolean;
	sawPrimaryRays: boolean;
	sawSecondaryRays: boolean;
	sawRings: boolean;
	sawParticles: boolean;
	sawBorderEmphasis: boolean;
	sawLifespanBorderEmphasis: boolean;
	sawCardsGlow: boolean;
	sawWalletEmphasis: boolean;
	sawSummaryTransform: boolean;
	sawRaysTransform: boolean;
	sawRingTransform: boolean;
	sawSparklesTransform: boolean;
	sawParticlesTransform: boolean;
	sawPointsTransform: boolean;
	sawWalletTransform: boolean;
	sawPointsGlow: boolean;
	sawRewardNumberEmphasis: boolean;
	sawDecorativeOpacity: boolean;
	finalInlineStyles: string[];
};

test.describe('Relay startup', () => {
	test('shows Root-accelerated point speed before work and keeps it after work starts', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(29);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1_000, 0,
			{ inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, 1,
			{ inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const initialPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1_000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), initialPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await moveRelaySelfTo(page, { x: 11, y: 3 });

		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await profileTrigger.click();
		const beforeWorkProfile = page.getByRole('dialog');
		const beforeWorkDetails = beforeWorkProfile.getByRole('region', { name: '詳細' });
		await expect(beforeWorkDetails).toContainText('現在のポイント速度');
		await expect(beforeWorkDetails).toContainText('2.00 pt/分');
		await expect(beforeWorkDetails).toContainText('推論加速');
		await expect(beforeWorkDetails).toContainText('×2.00');
		await expect(beforeWorkDetails).not.toContainText('有効作業 残り');
		await beforeWorkProfile.getByRole('button', { name: '閉じる' }).click();

		const terminal = page.getByRole('button', { name: '作業端末' });
		await terminal.click();
		await expect(page.getByRole('dialog').getByRole('heading', { name: '作業中' })).toBeVisible();
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('2.00 pt/分+0.1h/h');
		await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
		await profileTrigger.click();
		const activeWorkProfile = page.getByRole('dialog');
		const activeWorkDetails = activeWorkProfile.getByRole('region', { name: '詳細' });
		await expect(activeWorkDetails).toContainText('×2.00');
		await expect(activeWorkDetails).toContainText('2.00 pt/分');
		await expect(activeWorkDetails).not.toContainText('有効作業 残り');
	});

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
		// The distant terminal is clipped; keyboard activation must preserve the camera.
		await terminal.focus();
		await terminal.press('Enter');
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
		await page.clock.setFixedTime(await page.evaluate(() => Date.now()));
		await terminal.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingStart);
		const started = await readRelayGameState(page);
		const mendingStartedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs;
		expect(started).toMatchObject({ version: 4, points: 0, pointProgressTicks: 0, mendingJob: expect.objectContaining({ processedDurationMs: 0, unclaimedPoints: 0 }) });
		const activeDialog = page.getByRole('dialog');
		await expect(activeDialog.getByRole('heading', { name: '作業中' })).toBeVisible();
		await expect(activeDialog.locator('.mending-dialog-title [data-mending-icon="tool"]')).toHaveCount(1);
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
		await expect(activeDialog).toContainText('未回収ポイント');
		await expect(activeDialog).toContainText('寿命延長');
		await expect(activeDialog).toContainText('作業中に反映');
		await expect(activeDialog.getByRole('region', { name: '作業の成果' })).toBeVisible();
		await expect(activeDialog.locator('[data-mending-icon="wallet"] svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="coins"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="heart"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(activeDialog.locator('.action-group')).toHaveCount(1);
		const collectButton = activeDialog.getByRole('button', { name: '成果を受け取る' });
		await expect(collectButton).toBeVisible();
		await expect(collectButton).toHaveAttribute('data-action-variant', 'primary');
		await expect(activeDialog.locator('[data-action-variant="primary"]')).toHaveCount(1);
		await expect(activeDialog.getByRole('button', { name: /詳細を見る|詳細を閉じる/ })).toHaveCount(0);
		await expect(activeDialog.locator('.details-content')).toHaveCount(0);
		const closeButton = activeDialog.getByRole('button', { name: '閉じる', exact: true });
		await expectDialogIconCloseButton(activeDialog, closeButton, '閉じる');
		await expect(collectButton.locator('svg')).toHaveCount(1);
		await expect(collectButton.locator('svg path')).toHaveAttribute('d', /^M4 20h16m-8-6V4/);
		await expect(activeDialog.locator('.result-card-feedback')).toHaveCount(0);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toBeDisabled();
		const workMeter = activeDialog.getByRole('progressbar', { name: '作業の蓄積進捗' });
		await expect(workMeter).toHaveAttribute('aria-valuenow', '0');
		const workMeterMetrics = await workMeter.evaluate((meter) => {
			const rect = meter.getBoundingClientRect();
			const dialogRect = meter.closest('[role="dialog"]')!.getBoundingClientRect();
			return { height: rect.height, left: rect.left, right: rect.right, dialogLeft: dialogRect.left, dialogRight: dialogRect.right };
		});
		expect(workMeterMetrics.height).toBeGreaterThan(11);
		expect(workMeterMetrics.left).toBeGreaterThanOrEqual(workMeterMetrics.dialogLeft);
		expect(workMeterMetrics.right).toBeLessThanOrEqual(workMeterMetrics.dialogRight);
		await page.clock.setSystemTime(mendingStartedAt);
		const disabledCollectStyle = await collectButton.evaluate((button) => ({
			...(() => {
				const style = getComputedStyle(button);
				const dialog = button.closest('.mending-dialog-content')!;
				const probe = document.createElement('span');
				probe.style.cssText = 'position:absolute;background:var(--action-primary-disabled-background);border:1px solid var(--action-primary-disabled-border);color:var(--action-primary-disabled-foreground)';
				dialog.append(probe);
				const tokenStyle = getComputedStyle(probe);
				const result = { background: style.backgroundColor, border: style.borderColor, foreground: style.color, tokenBackground: tokenStyle.backgroundColor, tokenBorder: tokenStyle.borderColor, tokenForeground: tokenStyle.color };
				probe.remove();
				return result;
			})()
		}));
		expect(disabledCollectStyle.background).toBe(disabledCollectStyle.tokenBackground);
		expect(disabledCollectStyle.border).toBe(disabledCollectStyle.tokenBorder);
		expect(disabledCollectStyle.foreground).toBe(disabledCollectStyle.tokenForeground);
		const beforeZeroPointCollection = await publishedWorldStateCount();
		await expect.poll(publishedWorldStateCount).toBe(beforeZeroPointCollection);
		const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
		for (const [width, height, expectedColumns] of [[1280, 800, 2], [390, 640, 1]] as const) {
			await page.setViewportSize({ width, height });
			const meterLayout = await activeDialog.getByRole('progressbar', { name: '作業の蓄積進捗' }).evaluate((meter) => {
				const meterRect = meter.getBoundingClientRect();
				const dialogRect = meter.closest('[role="dialog"]')!.getBoundingClientRect();
				return { left: meterRect.left, right: meterRect.right, dialogLeft: dialogRect.left, dialogRight: dialogRect.right, viewportWidth: innerWidth };
			});
			expect(meterLayout.left).toBeGreaterThanOrEqual(meterLayout.dialogLeft);
			expect(meterLayout.right).toBeLessThanOrEqual(meterLayout.dialogRight);
			expect(meterLayout.right).toBeLessThanOrEqual(meterLayout.viewportWidth);
			if (width === 390) await expectDialogIconCloseButton(activeDialog, closeButton, '閉じる');
			const visibleButtonStyles = await activeDialog.evaluate((dialog) => {
				const collect = getComputedStyle(dialog.querySelector('.collect-button')!);
				return { collectBackground: collect.backgroundColor, collectBorder: collect.borderColor, collectForeground: collect.color };
			});
			expect(visibleButtonStyles.collectBackground).toBe(disabledCollectStyle.background);
			expect(visibleButtonStyles.collectBorder).toBe(disabledCollectStyle.border);
			expect(visibleButtonStyles.collectForeground).toBe(disabledCollectStyle.foreground);
			const layout = await activeDialog.evaluate((dialog) => {
				const cards = [...dialog.querySelectorAll<HTMLElement>('.result-card')];
				const cardRects = cards.map((card) => card.getBoundingClientRect());
				const resultList = dialog.querySelector('.result-list')!.getBoundingClientRect();
				const status = dialog.querySelector('.status-group')!.getBoundingClientRect();
				const button = dialog.querySelector('.collect-button')!.getBoundingClientRect();
				const close = dialog.querySelector('.action-button-close')!.getBoundingClientRect();
				return {
					columns: new Set(cardRects.map((rect) => Math.round(rect.left))).size,
					cardsOverlap: cardRects[0].right > cardRects[1].left && cardRects[0].left < cardRects[1].right && cardRects[0].bottom > cardRects[1].top && cardRects[0].top < cardRects[1].bottom,
					cardsSameHeight: Math.abs(cardRects[0].height - cardRects[1].height) < 1,
					horizontalOverflow: dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
					dialogOrder: close.top <= resultList.top && resultList.bottom <= status.top && status.bottom <= button.top,
					buttonFillsRow: Math.abs(button.width - resultList.width) < 1,
					buttonHeight: button.height,
					buttonWithinViewport: button.left >= 0 && button.right <= innerWidth
				};
			});
			expect(layout.columns).toBe(expectedColumns);
			expect(layout.cardsOverlap).toBe(false);
			expect(layout.cardsSameHeight).toBe(true);
			expect(layout.horizontalOverflow).toBe(false);
			expect(layout.dialogOrder).toBe(true);
			expect(layout.buttonFillsRow).toBe(true);
			expect(layout.buttonHeight).toBeGreaterThanOrEqual(48);
			expect(layout.buttonHeight).toBeLessThanOrEqual(52);
			expect(layout.buttonWithinViewport).toBe(true);
		}
		await page.setViewportSize(originalViewport);
		await expect(activeDialog.getByRole('button', { name: /詳細を見る|詳細を閉じる/ })).toHaveCount(0);
		for (const detail of ['現在のポイント速度', '最大蓄積', '1時間の作業で寿命', '推論加速', '最大寿命']) await expect(activeDialog).not.toContainText(detail);
		await page.setViewportSize({ width: 390, height: 520 });
		const dialogLayout = await activeDialog.evaluate((dialog) => ({
			horizontalOverflow: dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
			verticalOverflow: dialog.scrollHeight > dialog.clientHeight
		}));
		expect(dialogLayout.horizontalOverflow).toBe(false);
		expect(dialogLayout.verticalOverflow).toBe(true);
		await expect(closeButton).toBeInViewport({ ratio: 1 });
		await page.setViewportSize(originalViewport);
		await closeButton.click();
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		const selfProfile = page.getByRole('dialog');
		const workDetails = selfProfile.getByRole('region', { name: '詳細' });
		await expect(workDetails).toBeVisible();
		await expect(workDetails).toContainText('現在のポイント速度');
		await expect(workDetails).toContainText('1.00 pt/分');
		await expect(workDetails).toContainText('最大蓄積');
		await expect(workDetails).toContainText('5分');
		await expect(workDetails).toContainText('1時間の作業で寿命');
		await expect(workDetails).toContainText('+6分');
		await expect(workDetails).toContainText('推論加速');
		await expect(workDetails).toContainText('×1.00');
		await expect(workDetails).toContainText('最大寿命');
		await expect(workDetails).toContainText('7日');
		await expect(selfProfile).toContainText('Root Point');
		await expect(selfProfile).toContainText('脱出');
		await expect(selfProfile.locator('.ability-row')).toHaveCount(3);
		await selfProfile.getByRole('button', { name: '閉じる' }).click();
		await terminal.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '作業中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'tool');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('1.00 pt/分+0.1h/h');
		const activeMendingRow = page.locator('[data-unified-status-hud] [data-mending-row]');
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
		await pauseAtCurrentBrowserTime(page);
		const lifespanValue = page.locator('[data-unified-status-hud] [data-lifespan-value]');
		const hud = page.locator('[data-unified-status-hud]');
		const expiryBeforeWorkTick = Number(await hud.getAttribute('data-current-expires-at-ms'));
		await page.clock.runFor(1_000);
		await expect.poll(async () => Number(await hud.getAttribute('data-current-expires-at-ms'))).toBeGreaterThan(expiryBeforeWorkTick);
		await expect(lifespanValue).toHaveAttribute('data-value-change', 'decrease');
		await expect(lifespanValue).toHaveCSS('color', 'rgb(255, 104, 117)');
		await expect(lifespanValue).toHaveCSS('animation-name', 'none');
		const firstWorkSequence = Number(await lifespanValue.getAttribute('data-value-change-sequence'));
		await page.clock.runFor(1_000);
		await expect.poll(async () => Number(await lifespanValue.getAttribute('data-value-change-sequence'))).toBeGreaterThan(firstWorkSequence);
		await expect(lifespanValue).toHaveCSS('color', 'rgb(255, 104, 117)');
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(terminal).toBeFocused();
		await finishDialogExit(activeDialog);

		const startedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs;
		const partialAt = startedAt + 1 * 60 * 1000 + 30 * 1000;
		await page.clock.setSystemTime(partialAt);
		await pauseAtCurrentBrowserTime(page);
		await terminal.click();
		const partialDialog = page.getByRole('dialog');
		await expect(partialDialog.locator('.mending-startup-feedback')).toHaveCount(0);
		const partialMeter = partialDialog.getByRole('progressbar', { name: '作業の蓄積進捗' });
		const partialMeterValue = Number(await partialMeter.getAttribute('aria-valuenow'));
		expect(partialMeterValue).toBeGreaterThan(0);
		expect(partialMeterValue).toBeLessThan(100);
		await expect(partialDialog).toContainText('上限まで あと4分');
		await expect(partialDialog).toContainText(/次の1ptまで [1-9][0-9]?秒/);
		await expect(partialDialog.locator('.next-point[data-mending-icon="clock"] > svg')).toHaveCount(1);
		await expect(partialDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(partialDialog).toContainText('+1 pt');
		const enabledCollect = partialDialog.getByRole('button', { name: '成果を受け取る' });
		await expect(enabledCollect).toBeEnabled();
		await expect(enabledCollect).toHaveAttribute('data-action-variant', 'primary');
		const enabledCollectStyle = await enabledCollect.evaluate((button) => {
			const dialog = button.closest('.mending-dialog-content')!;
			const probe = document.createElement('span');
			probe.style.cssText = 'position:absolute;background:var(--action-primary-background)';
			dialog.append(probe);
			const result = { background: getComputedStyle(button).backgroundColor, primaryBackground: getComputedStyle(probe).backgroundColor };
			probe.remove();
			return result;
		});
		expect(enabledCollectStyle.background).toBe(enabledCollectStyle.primaryBackground);
		expect(enabledCollectStyle.background).not.toBe(disabledCollectStyle.background);
		for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await page.mouse.move(viewport.width - 1, viewport.height - 1);
			await expect.poll(() => enabledCollect.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(enabledCollectStyle.background);
			await expect(enabledCollect).toBeVisible();
			const enabledHitArea = await enabledCollect.evaluate((button) => {
				const rect = button.getBoundingClientRect();
				return { height: rect.height, background: getComputedStyle(button).backgroundColor };
			});
			expect(enabledHitArea.height).toBeGreaterThanOrEqual(44);
			expect(enabledHitArea.background).toBe(enabledCollectStyle.background);
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		const beforeMendingReward = await publishedWorldStateCount();
		const hudPoints = page.locator('[data-unified-status-hud] [data-points-value]');
		const assertCollectionLayout = async (viewport: { width: number; height: number }, expectedPoints: number, reducedMotion = false) => {
			await page.setViewportSize(viewport);
			if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.evaluate(() => {
					const dialog = document.querySelector<HTMLElement>('.mending-dialog-content')!;
					const rewardLayer = document.querySelector<HTMLElement>('.mending-reward-layer')!;
					const pointsCard = dialog.querySelector<HTMLElement>('.result-card[data-mending-icon="coins"]')!;
					const lifespanCard = dialog.querySelector<HTMLElement>('.result-card[data-mending-icon="heart"]')!;
					const wallet = dialog.querySelector<SVGElement>('[data-mending-icon="wallet"] svg')!;
					const pointsValue = dialog.querySelector<HTMLElement>('.owned-points-value')!;
					const initialPointsCardShadow = getComputedStyle(pointsCard).boxShadow;
					const initialLifespanCardShadow = getComputedStyle(lifespanCard).boxShadow;
					const observation = {
						baselineBorder: getComputedStyle(pointsCard).borderColor,
						baselineLifespanBorder: getComputedStyle(lifespanCard).borderColor,
						baselineWallet: getComputedStyle(wallet).color,
						baselinePoints: getComputedStyle(pointsValue).color,
						sawSummary: false,
						sawImpactBloom: false,
						sawJackpotBloom: false,
						sawPrimaryRays: false,
						sawSecondaryRays: false,
						sawRings: false,
						sawParticles: false,
						sawBorderEmphasis: false,
						sawLifespanBorderEmphasis: false,
						sawCardsGlow: false,
						sawWalletEmphasis: false,
						sawSummaryTransform: false,
						sawRaysTransform: false,
						sawRingTransform: false,
						sawSparklesTransform: false,
						sawParticlesTransform: false,
						sawPointsTransform: false,
						sawWalletTransform: false,
						sawPointsGlow: false,
						sawRewardNumberEmphasis: false,
						sawDecorativeOpacity: false,
						finalInlineStyles: [] as string[],
						done: false
					};
					const observedWindow = window as typeof window & {
						__mendingRewardObservation?: MendingRewardObservation;
					};
					observedWindow.__mendingRewardObservation = observation;
					let summaryRef: HTMLElement | null = null;
					let impactBloomRef: HTMLElement | null = null;
					let jackpotBloomRef: HTMLElement | null = null;
					let primaryRaysRef: SVGElement | null = null;
					let secondaryRaysRef: SVGElement | null = null;
					let ringRefs: SVGElement[] = [];
					let sparklesRef: SVGElement | null = null;
					let particleRefs: SVGElement[] = [];
					let pointsRef: HTMLElement | null = null;
					let pointsBaselineShadow: string | null = null;
					const hasTransform = (element: HTMLElement | SVGElement): boolean => {
						const style = getComputedStyle(element);
						return element.style.transform !== '' || element.style.scale !== '' || element.style.translate !== '' || element.style.rotate !== '' ||
							style.transform !== 'none' || (style.scale !== 'none' && style.scale !== '1') || style.translate !== 'none' || style.rotate !== 'none';
					};
					const sample = () => {
						observation.sawBorderEmphasis ||= getComputedStyle(pointsCard).borderColor !== observation.baselineBorder;
						observation.sawLifespanBorderEmphasis ||= getComputedStyle(lifespanCard).borderColor !== observation.baselineLifespanBorder;
						observation.sawWalletEmphasis ||= getComputedStyle(wallet).color !== observation.baselineWallet || getComputedStyle(pointsValue).color !== observation.baselinePoints;
						const summary = rewardLayer.querySelector<HTMLElement>('.reward-summary');
						const impactBloom = rewardLayer.querySelector<HTMLElement>('.reward-impact-bloom');
						const jackpotBloom = rewardLayer.querySelector<HTMLElement>('.reward-jackpot-bloom');
						const primaryRays = rewardLayer.querySelector<SVGElement>('.reward-burst-rays-primary');
						const secondaryRays = rewardLayer.querySelector<SVGElement>('.reward-burst-rays-secondary');
						const rings = [...rewardLayer.querySelectorAll<SVGElement>('.reward-burst-ring')];
						const sparkles = rewardLayer.querySelector<SVGElement>('.reward-burst-sparkles');
						const particles = [...rewardLayer.querySelectorAll<SVGElement>('.reward-particle')];
						const rewardPoints = rewardLayer.querySelector<HTMLElement>('.reward-summary-points');
						if (summary && impactBloom && jackpotBloom && primaryRays && secondaryRays && rings.length > 1 && sparkles && particles.length > 0 && rewardPoints) {
							summaryRef = summary;
							impactBloomRef = impactBloom;
							jackpotBloomRef = jackpotBloom;
							primaryRaysRef = primaryRays;
							secondaryRaysRef = secondaryRays;
							ringRefs = rings;
							sparklesRef = sparkles;
							particleRefs = particles;
							pointsRef = rewardPoints;
							pointsBaselineShadow ??= getComputedStyle(rewardPoints).textShadow;
							observation.sawSummary = true;
							observation.sawImpactBloom ||= Number(getComputedStyle(impactBloom).opacity) > 0;
							observation.sawJackpotBloom ||= Number(getComputedStyle(jackpotBloom).opacity) > 0;
							observation.sawPrimaryRays ||= Number(getComputedStyle(primaryRays).opacity) > 0;
							observation.sawSecondaryRays ||= Number(getComputedStyle(secondaryRays).opacity) > 0;
							observation.sawRings ||= rings.some((ring) => Number(getComputedStyle(ring).opacity) > 0);
							observation.sawParticles ||= particles.some((particle) => Number(getComputedStyle(particle).opacity) > 0);
							observation.sawSummaryTransform ||= hasTransform(summary);
							observation.sawRaysTransform ||= hasTransform(primaryRays) || hasTransform(secondaryRays);
							observation.sawRingTransform ||= rings.some(hasTransform);
							observation.sawSparklesTransform ||= hasTransform(sparkles);
							observation.sawParticlesTransform ||= particles.some(hasTransform);
							observation.sawPointsTransform ||= hasTransform(rewardPoints);
							observation.sawWalletTransform ||= hasTransform(wallet);
							observation.sawPointsGlow ||= getComputedStyle(pointsValue).textShadow !== 'none';
							observation.sawRewardNumberEmphasis ||= getComputedStyle(rewardPoints).textShadow !== pointsBaselineShadow;
							observation.sawCardsGlow ||= getComputedStyle(pointsCard).boxShadow !== initialPointsCardShadow || getComputedStyle(lifespanCard).boxShadow !== initialLifespanCardShadow;
							observation.sawDecorativeOpacity ||= observation.sawImpactBloom && observation.sawJackpotBloom && observation.sawPrimaryRays && observation.sawSecondaryRays && observation.sawRings && Number(getComputedStyle(sparkles).opacity) > 0 && observation.sawParticles;
						} else if (observation.sawSummary) {
							observation.finalInlineStyles = [pointsCard, lifespanCard, pointsValue, wallet, summaryRef, impactBloomRef, jackpotBloomRef, primaryRaysRef, secondaryRaysRef, ...ringRefs, sparklesRef, ...particleRefs, pointsRef].map((element) => element?.style.cssText ?? 'missing');
							observation.done = true;
						}
						if (!observation.done) requestAnimationFrame(sample);
					};
					requestAnimationFrame(sample);
			});
			const dialog = page.getByRole('dialog');
			const collect = dialog.getByRole('button', { name: '成果を受け取る' });
			const readLayout = () => dialog.evaluate((element) => {
				const rect = (selector: string) => {
					const box = element.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
					return [box.left, box.top, box.right, box.bottom, box.width, box.height];
				};
				return {
					dialog: (() => { const box = element.getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom, box.width, box.height]; })(), cards: [...element.querySelectorAll<HTMLElement>('.result-card')].map((card) => {
						const box = card.getBoundingClientRect();
						return [box.left, box.top, box.right, box.bottom, box.width, box.height];
					}),
					progress: rect('.progress-track'), button: rect('.collect-button'),
					extent: [element.scrollWidth, element.scrollHeight, element.clientWidth, element.clientHeight]
				};
			});
			const before = await readLayout();
			const stateBefore = await readRelayGameState(page);
			const rewardStatus = dialog.locator('[role="status"][aria-live="polite"]');
			await expect(rewardStatus).toHaveCount(1);
			await expect(rewardStatus).toHaveText('');
			await collect.click();
			await expect.poll(async () => {
				const current = await readRelayGameState(page);
				return current.points;
			}).toBe(expectedPoints);
			const stateAfter = await readRelayGameState(page);
			const collectedPoints = stateAfter.points - stateBefore.points;
			const materializedLifespan = Math.max(0, stateAfter.lifespanExpiresAtMs - stateBefore.lifespanExpiresAtMs);
			expect(stateAfter.lifespanExpiresAtMs).toBeGreaterThan(stateBefore.lifespanExpiresAtMs);
			const rewardSummary = page.locator('.mending-reward-layer .reward-summary');
			await expect(rewardSummary).toBeVisible();
			const rewardCenters = await page.locator('.mending-reward-layer').evaluate((layer) => {
				const centerX = (selector: string) => {
					const rect = layer.querySelector<HTMLElement | SVGElement>(selector)!.getBoundingClientRect();
					return rect.left + rect.width / 2;
				};
				return {
					summary: centerX('.reward-summary'),
					burst: centerX('.reward-burst')
				};
			});
			expect(Math.abs(rewardCenters.burst - rewardCenters.summary)).toBeLessThanOrEqual(1);
			await expect(rewardSummary.locator('.reward-summary-title')).toHaveText('成果を受け取りました');
			await expect(rewardSummary.locator('.reward-summary-points')).toHaveText(`+${collectedPoints} pt`);
			await expect(rewardStatus).toContainText(`成果を受け取りました。${collectedPoints}ポイント。`);
			if (materializedLifespan > 0) {
				const formattedLifespan = formatElapsedDuration(materializedLifespan);
				await expect(rewardSummary.locator('.reward-summary-lifespan')).toHaveText(`寿命延長 +${formattedLifespan}`);
				await expect(rewardSummary.locator('.reward-summary-support')).toHaveText('作業中に反映済み');
				await expect(rewardStatus).toContainText(`寿命延長 +${formattedLifespan}は作業中に反映済みです。`);
			} else {
				await expect(rewardSummary.locator('.reward-summary-lifespan')).toHaveCount(0);
			}
			const rewardLayerState = await page.locator('.mending-reward-layer').evaluate((layer) => ({
				pointerEvents: getComputedStyle(layer).pointerEvents,
				overflow: getComputedStyle(layer).overflow
			}));
			expect(rewardLayerState).toEqual({ pointerEvents: 'none', overflow: 'hidden' });
			await expect(hudPoints).toHaveAttribute('data-value-change', 'increase');
			await expect(hudPoints).toHaveCSS('color', 'rgb(87, 230, 138)');
			await expect(hudPoints).toHaveCSS('animation-name', 'none');
			const pointsCard = dialog.locator('.result-card[data-mending-icon="coins"]');
			const lifespanCard = dialog.locator('.result-card[data-mending-icon="heart"]');
			await expect(pointsCard.locator('.result-label')).toHaveText('未回収ポイント');
			await expect(pointsCard.locator('.result-copy')).toBeVisible();
			await expect(lifespanCard.locator('.result-label')).toHaveText('寿命延長');
			await expect(lifespanCard.locator('.result-support')).toHaveText('作業中に反映');
			expect(await readLayout()).toEqual(before);
			const horizontalOverflow = await dialog.evaluate((element) => element.scrollWidth > element.clientWidth || document.documentElement.scrollWidth > innerWidth);
			expect(horizontalOverflow).toBe(false);
			await expect(collect).toBeDisabled();
			expect(await readLayout()).toEqual(before);
			// Keep the result readable beyond the reward sound and through the summary's reading interval.
			await page.clock.runFor(600);
			await expect(rewardSummary).toBeVisible();
			await expect(rewardSummary.locator('.reward-summary-points')).toHaveText(`+${collectedPoints} pt`);
			await page.clock.runFor(900);
			await expect(rewardSummary).toBeVisible();
			await expect(rewardSummary.locator('.reward-summary-title')).toHaveText('成果を受け取りました');
			await expect(rewardSummary.locator('.reward-summary-points')).toHaveText(`+${collectedPoints} pt`);
			let observation = await page.evaluate(() => (window as typeof window & { __mendingRewardObservation?: MendingRewardObservation }).__mendingRewardObservation);
			if (reducedMotion) {
				while (!observation?.done) {
					await page.clock.runFor(16);
					observation = await page.evaluate(() => (window as typeof window & { __mendingRewardObservation?: MendingRewardObservation }).__mendingRewardObservation);
				}
			} else {
				while (!observation || !observation.sawDecorativeOpacity || !observation.sawSummaryTransform || !observation.sawRaysTransform || !observation.sawRingTransform || !observation.sawSparklesTransform || !observation.sawParticlesTransform || !observation.sawPointsTransform || !observation.sawWalletTransform || !observation.sawBorderEmphasis || !observation.sawLifespanBorderEmphasis || !observation.sawCardsGlow || !observation.sawWalletEmphasis || !observation.sawPointsGlow || !observation.sawRewardNumberEmphasis) {
					await page.clock.runFor(16);
					observation = await page.evaluate(() => (window as typeof window & { __mendingRewardObservation?: MendingRewardObservation }).__mendingRewardObservation);
				}
			}
			while (!observation?.done) {
				await page.clock.runFor(16);
				observation = await page.evaluate(() => (window as typeof window & { __mendingRewardObservation?: MendingRewardObservation }).__mendingRewardObservation);
			}
			const feedback = observation;
			expect(feedback?.sawSummary).toBe(true);
			expect(feedback?.sawImpactBloom).toBe(true);
			expect(feedback?.sawJackpotBloom).toBe(true);
			expect(feedback?.sawPrimaryRays).toBe(true);
			expect(feedback?.sawSecondaryRays).toBe(true);
			expect(feedback?.sawRings).toBe(true);
			expect(feedback?.sawParticles).toBe(true);
			expect(feedback?.sawDecorativeOpacity).toBe(true);
			expect(feedback?.sawBorderEmphasis).toBe(true);
			expect(feedback?.sawLifespanBorderEmphasis).toBe(true);
			expect(feedback?.sawCardsGlow).toBe(true);
			expect(feedback?.sawWalletEmphasis).toBe(true);
			expect(feedback?.sawPointsGlow).toBe(true);
			expect(feedback?.sawRewardNumberEmphasis).toBe(true);
			const observedMotionTransforms = [feedback?.sawSummaryTransform, feedback?.sawRaysTransform, feedback?.sawRingTransform, feedback?.sawSparklesTransform, feedback?.sawParticlesTransform, feedback?.sawPointsTransform, feedback?.sawWalletTransform];
			if (reducedMotion) expect(observedMotionTransforms).toEqual([false, false, false, false, false, false, false]);
			else expect(observedMotionTransforms).toEqual([true, true, true, true, true, true, true]);
			expect(feedback?.finalInlineStyles.every((style) => style === '')).toBe(true);
			await expect(rewardSummary).toHaveCount(0);
			if (reducedMotion) {
				await page.emulateMedia({ reducedMotion: 'no-preference' });
			}
		};
		await assertCollectionLayout({ width: 1280, height: 800 }, 1);
		const firstRewardDialog = page.getByRole('dialog');
		await firstRewardDialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await finishDialogExit(firstRewardDialog);
		await expect(terminal).toBeFocused();
		await terminal.click();
		const reopenedRewardDialog = page.getByRole('dialog');
		await expect(reopenedRewardDialog).toContainText('1 pt');
		await expect(page.locator('.mending-reward-layer .reward-summary')).toHaveCount(0);
		const reopenedRewardStatus = reopenedRewardDialog.locator('[role="status"][aria-live="polite"]');
		await expect(reopenedRewardStatus).toHaveCount(1);
		await expect(reopenedRewardStatus).toHaveText('');
		await expect.poll(async () => {
			const partialState = await readRelayGameState(page);
			return partialState.points === 1 && partialState.pointProgressTicks > 0 && partialState.pointProgressTicks < 60_000_000;
		}).toBe(true);
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingReward);
		while (await hudPoints.getAttribute('data-value-change') !== null) await page.clock.runFor(16);
		await expect(hudPoints).not.toHaveAttribute('data-value-change', /.+/);
		await expect(hudPoints).toHaveCSS('color', 'rgb(255, 255, 255)');

		const secondAt = partialAt + 3 * 60 * 1000;
		await page.clock.setSystemTime(secondAt);
		await pauseAtCurrentBrowserTime(page);
		if (await page.getByRole('dialog').count() > 0) {
			const currentDialog = page.getByRole('dialog');
			await currentDialog.getByRole('button', { name: '閉じる', exact: true }).click();
			await finishDialogExit(currentDialog);
		}
		await terminal.click();
		await expect(page.getByRole('dialog')).toContainText('+3 pt');
		await assertCollectionLayout({ width: 390, height: 844 }, 4, true);
		await page.setViewportSize(originalViewport);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(4);

		if (await page.getByRole('dialog').count() > 0) {
			const currentDialog = page.getByRole('dialog');
			await currentDialog.getByRole('button', { name: '閉じる', exact: true }).click();
			await finishDialogExit(currentDialog);
		}
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
		await expect(page.getByRole('dialog').locator('.mending-dialog-title [data-mending-icon="player-pause"]')).toHaveCount(1);
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '作業停止中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'player-pause');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('0.00 pt/分+0.0h/h');
		await expect(page.getByRole('dialog')).not.toContainText('今受け取れる');
		await expect(page.getByRole('dialog')).toContainText('+5 pt');
		await expect(page.getByRole('dialog')).not.toContainText('次の1ptまで');
		await expect(page.getByRole('dialog').locator('[data-mending-icon="coins"] .next-point')).toHaveClass(/next-point-hidden/);
		await page.evaluate(() => {
			let release: (() => void) | null = null;
			let started = false;
			(window as typeof window & {
				__personaBubbleFieldTestHooks: {
					started: () => boolean;
					release: () => void;
					beforeMendingMutation: (operation: 'start' | 'collect') => Promise<void>;
				};
			}).__personaBubbleFieldTestHooks = {
				started: () => started,
				release: () => { release?.(); release = null; },
				beforeMendingMutation: async (operation) => {
					if (operation !== 'collect') return;
					started = true;
					await new Promise<void>((resolve) => { release = resolve; });
				}
			};
		});
		const delayedCollectDialog = page.getByRole('dialog');
		await delayedCollectDialog.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { started(): boolean } }).__personaBubbleFieldTestHooks.started())).toBe(true);
		await delayedCollectDialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await finishDialogExit(delayedCollectDialog);
		await expect(terminal).toBeFocused();
		await page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { release(): void } }).__personaBubbleFieldTestHooks.release());
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object), points: 9, pointProgressTicks: 30_000_000 });
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await terminal.click();
		const reopenedAfterClosedCollection = page.getByRole('dialog');
		await expect(reopenedAfterClosedCollection).toContainText('9 pt');
		await expect(reopenedAfterClosedCollection).toContainText('上限まで あと5分');
		await expect(reopenedAfterClosedCollection).toContainText('+0 pt');
		await expect(page.locator('.mending-reward-layer .reward-summary')).toHaveCount(0);
		const closedCollectionStatus = reopenedAfterClosedCollection.locator('[role="status"][aria-live="polite"]');
		await expect(closedCollectionStatus).toHaveCount(1);
		await expect(closedCollectionStatus).toHaveText('');
		await expect(page.locator('.mending-reward-layer .reward-burst-rays, .mending-reward-layer .reward-burst-ring')).toHaveCount(0);
		await expect(reopenedAfterClosedCollection.locator('.owned-points svg')).toHaveCount(1);
		await expect(reopenedAfterClosedCollection.locator('.owned-points-value')).toHaveCount(1);
		await expect(reopenedAfterClosedCollection.locator('.result-list .result-card').first()).toBeVisible();
		await expect(reopenedAfterClosedCollection.locator('.result-list .result-card')).toHaveCount(2);
		const closedCollectionInlineStyles = await reopenedAfterClosedCollection.evaluate((dialog) => {
			const wallet = dialog.querySelector<SVGElement>('.owned-points svg');
			const pointsValue = dialog.querySelector<HTMLElement>('.owned-points-value');
			const cards = [...dialog.querySelectorAll<HTMLElement>('.result-list .result-card')];
			return [wallet, pointsValue, ...cards].map((element) => element?.style.cssText ?? 'missing');
		});
		expect(closedCollectionInlineStyles).toEqual(['', '', '', '']);
		await expect(reopenedAfterClosedCollection.getByRole('button', { name: '成果を受け取る' })).toBeDisabled();
		await expect(reopenedAfterClosedCollection.getByRole('button', { name: '閉じる', exact: true })).toBeEnabled();
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '作業中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'tool');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('1.00 pt/分+0.1h/h');
		const collected = await readRelayGameState(page);
		expect(collected.mendingJob).toEqual(expect.objectContaining({ startedAtMs: expect.any(Number) }));
		expect(collected.points).toBe(9);
		expect(collected.lifespanExpiresAtMs).toBeGreaterThan(started.lifespanExpiresAtMs);
		expect(collected.lifespanExpiresAtMs).toBeLessThanOrEqual(started.lifespanExpiresAtMs + 6 * 60 * 1000);
		await reopenedAfterClosedCollection.getByRole('button', { name: '閉じる', exact: true }).click();
	});

	test('opens the adjustment terminal only nearby and persists ability upgrades', async ({ page }) => {
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
		await adjustment.focus();
		await adjustment.press('Enter');
		await expect(page.locator('.trace-proximity-feedback[role="status"]')).toContainText('近づくと端末を使える');

		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await adjustment.click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		const upgradeButton = dialog.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt）' });
		await expect(dialog.getByRole('heading', { name: '能力強化' })).toBeFocused();
		await expectDialogIconCloseButton(dialog, dialog.getByRole('button', { name: '閉じる' }), '閉じる');
		const initialDialogScroll = await dialog.evaluate((element) => element.scrollTop);
		expect(initialDialogScroll).toBe(0);
		await expect(dialog.getByLabel('所持ポイント 10 pt')).toBeVisible();
		const expectHeaderToStayReadable = async () => {
			const overlaps = await dialog.evaluate((element) => {
				const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
				const title = rect('.adjustment-dialog-title');
				const points = rect('.points-display');
				const close = rect('.action-button-close');
				const intersects = (first: DOMRect, second: DOMRect) => first.left < second.right && second.left < first.right && first.top < second.bottom && second.top < first.bottom;
				return { titlePoints: intersects(title, points), titleClose: intersects(title, close), pointsClose: intersects(points, close) };
			});
			expect(overlaps).toEqual({ titlePoints: false, titleClose: false, pointsClose: false });
		};
		await expectHeaderToStayReadable();
		await expect(dialog.getByRole('tooltip')).toHaveCount(0);
		await expect(dialog).toContainText('10 pt');
		await expect(dialog).not.toContainText('POINT');
		await expect(dialog).not.toContainText('ポイントを使って、より効率よく活動できるようにします。');
		await expect(dialog.locator('.ability-card')).toHaveCount(3);
		await expect(dialog.locator('.adjustment-dialog-title svg')).toHaveCount(1);
		await expect(dialog.locator('.ability-name svg')).toHaveCount(3);
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Lv1');
		await expect(dialog).toContainText('1.00');
		await expect(dialog).not.toContainText('1.10');
		await expect(dialog.locator('.current-row').first()).toContainText('1.00');
		await expect(dialog.locator('.current-row').first()).toContainText('pt/分');
		await expect(dialog.locator('.ability-card').nth(1).locator('.current-row strong')).toHaveText('5分');
		await expect(dialog.locator('.delta-row').first()).toContainText('+0.10 pt/分');
		await expect(dialog).toContainText('ポイント生成速度');
		await expect(upgradeButton).toBeVisible();
		await expect(upgradeButton).toHaveAttribute('aria-label', '推論効率をLv2へ強化（必要1pt）');
		await expect(upgradeButton).toHaveText('必要 1pt');
		const upgradeIcon = upgradeButton.locator('svg');
		await expect(upgradeIcon).toHaveCount(1);
		const upgradeIconPaths = upgradeIcon.locator('path');
		await expect(upgradeIconPaths).toHaveCount(1);
		await expect(upgradeIconPaths).toHaveAttribute('fill', 'currentColor');
		await expect(upgradeIconPaths).toHaveAttribute('d', /^M19 2a3 3 0 0 1 3 3v14/);
		const buttonComposition = await upgradeButton.evaluate((button) => {
			const buttonRect = button.getBoundingClientRect();
			const textRect = button.querySelector('.upgrade-requirement')!.getBoundingClientRect();
			const iconRect = button.querySelector('svg')!.getBoundingClientRect();
			return {
				buttonHeight: buttonRect.height,
				iconWidth: iconRect.width,
				iconHeight: iconRect.height,
				iconFits: iconRect.left >= buttonRect.left && iconRect.right <= buttonRect.right && iconRect.top >= buttonRect.top && iconRect.bottom <= buttonRect.bottom,
				textBeforeIcon: textRect.right <= iconRect.left,
				contentCentered: Math.abs((textRect.left + iconRect.right) / 2 - (buttonRect.left + buttonRect.right) / 2) < 1
			};
		});
		expect(buttonComposition).toEqual({ buttonHeight: 50, iconWidth: 28, iconHeight: 28, iconFits: true, textBeforeIcon: true, contentCentered: true });
		await expect(upgradeButton).not.toContainText('強化');
		await expect(dialog).not.toContainText('必要ポイント');
		const effectTypography = await dialog.evaluate((element) => {
			const current = getComputedStyle(element.querySelector('.current-row strong')!).fontSize;
			const delta = getComputedStyle(element.querySelector('.delta-row strong')!).fontSize;
			return { current, delta };
		});
		expect(effectTypography.current).toBe(effectTypography.delta);
		expect(Number.parseFloat(effectTypography.current)).toBeGreaterThanOrEqual(18);
		expect(Number.parseFloat(effectTypography.current)).toBeLessThanOrEqual(20);
		for (const [width, columns] of [[1000, 3], [800, 2], [390, 1]] as const) {
			await page.setViewportSize({ width, height: 800 });
			const layout = await dialog.evaluate((element) => {
				const content = element as HTMLElement;
				const cards = [...content.querySelectorAll<HTMLElement>('.ability-card')];
				const rects = cards.map((card) => card.getBoundingClientRect());
				return {
					columnCount: new Set(rects.map((rect) => Math.round(rect.left))).size,
					horizontalOverflow: content.scrollWidth > content.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
					cardsOverlap: rects.some((a, i) => rects.slice(i + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)),
					valueOverflow: cards.some((card) => [...card.querySelectorAll<HTMLElement>('.value-row')].some((row) => row.scrollWidth > row.clientWidth)),
					nameAndLevelOverlap: cards.some((card) => {
						const name = card.querySelector('.ability-name')!.getBoundingClientRect();
						const level = card.querySelector('.ability-level')!.getBoundingClientRect();
						return name.right > level.left && name.left < level.right && name.bottom > level.top && name.top < level.bottom;
					})
				};
			});
			expect(layout).toEqual({ columnCount: columns, horizontalOverflow: false, cardsOverlap: false, valueOverflow: false, nameAndLevelOverlap: false });
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		const beforeAbilityUpgrade = (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length;
		await page.clock.runFor(1_001);
		const upgradedCard = dialog.locator('.ability-card').first();
		const stableBefore = await upgradedCard.evaluate((card) => {
			const type = card.querySelector('.ability-type')!.getBoundingClientRect();
			const button = card.querySelector('button')!.getBoundingClientRect();
			const values = card.querySelector('.ability-values')!.getBoundingClientRect();
			return { typeY: type.y, valuesY: values.y, buttonY: button.y };
		});
		const ctaWidth = await upgradedCard.evaluate((card) => ({ button: card.querySelector('button')!.clientWidth, card: card.clientWidth }));
		expect(ctaWidth.button).toBeGreaterThan(ctaWidth.card * 0.7);
		await expect(dialog).not.toContainText('強化後');
		await expect(dialog).not.toContainText('normal clear');
		await expect(dialog).not.toContainText('Root Point');
		await page.keyboard.press('Tab');
		for (let index = 0; index < 12 && !(await upgradeButton.evaluate((button) => document.activeElement === button)); index++) await page.keyboard.press('Tab');
		await expect(upgradeButton).toBeFocused();
		await expect(upgradeButton).toHaveCSS('outline-style', 'solid');
		await pauseAtCurrentBrowserTime(page);
		await page.keyboard.press('Enter');
		await expect(dialog).toContainText('9 pt');
		const liveUpgradeButton = upgradedCard.getByRole('button');
		await expect(liveUpgradeButton).toHaveAttribute('aria-label', '推論効率をLv3へ強化（必要1pt）');
		await liveUpgradeButton.press('Enter');
		await expect(dialog).toContainText('8 pt');
		const hudPoints = page.locator('[data-unified-status-hud] [data-points-value]');
		await expect(hudPoints).toHaveAttribute('data-value-change', 'decrease');
		await expect(hudPoints).toHaveCSS('color', 'rgb(255, 104, 117)');
		await expect(hudPoints).toHaveCSS('animation-name', 'none');
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length).toBeGreaterThan(beforeAbilityUpgrade);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		const stableDuring = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			valuesY: card.querySelector('.ability-values')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableDuring).toEqual(stableBefore);
		await page.keyboard.press('Escape');
		await finishDialogExit(dialog);
		await expect(adjustment).toBeFocused();
		await adjustment.click();
		await expect(dialog.getByRole('heading', { name: '能力強化' })).toBeFocused();
		await finishDialogEntrance(dialog, true);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		const reopenedPresentationStyles = await dialog.locator('.ability-card').first().evaluate((card) => ({
			card: (card as HTMLElement).style.cssText,
			level: card.querySelector<HTMLElement>('.ability-level')!.style.cssText,
			badge: card.querySelector<HTMLElement>('.level-up-badge')!.style.cssText
		}));
		expect(reopenedPresentationStyles).toEqual({ card: '', level: '', badge: '' });
		await page.clock.runFor(800);
		await expect(hudPoints).not.toHaveAttribute('data-value-change', /.+/);
		await expect(hudPoints).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(dialog.locator('.level-up-badge')).toHaveCount(0, { timeout: 1_500 });
		const stableAfter = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			valuesY: card.querySelector('.ability-values')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableAfter).toEqual(stableBefore);
		await expect(page.locator('[data-unified-status-hud] [data-points-value]')).toHaveText('8pt');
		await expect(page.locator('[data-unified-status-hud] [data-points-meter]')).toHaveAttribute('aria-valuenow', '8');
		await expect(dialog).toContainText('推論効率 Lv3');
		await page.keyboard.press('Escape');
		await finishDialogExit(dialog);
		await expect(adjustment).toBeFocused();
		await adjustment.click();
		await expect(dialog.getByRole('heading', { name: '能力強化' })).toBeFocused();
		await finishDialogEntrance(dialog, true);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const reducedMotionButton = upgradedCard.getByRole('button');
		await expect(reducedMotionButton).toBeEnabled();
		await upgradedCard.evaluate((card) => {
			const level = card.querySelector<HTMLElement>('.ability-level')!;
			const observation = {
				baselineBorder: getComputedStyle(card).borderColor,
				baselineLevel: getComputedStyle(level).color,
				sawBorderEmphasis: false,
				sawLevelEmphasis: false,
				sawMotionTransform: false,
				sawBadge: false,
				badgeInlineStyleAfterRemoval: null as string | null,
				done: false
			};
			const observedWindow = window as typeof window & {
				__reducedMotionUpgradeObservation?: typeof observation;
			};
			observedWindow.__reducedMotionUpgradeObservation = observation;

			const hasTransform = (element: HTMLElement): boolean => {
				const style = getComputedStyle(element);
				return element.style.transform !== '' || element.style.scale !== '' || element.style.translate !== '' ||
					style.transform !== 'none' || (style.scale !== 'none' && style.scale !== '1') || style.translate !== 'none';
			};
			let observedBadge: HTMLElement | null = null;
			const sample = () => {
				observation.sawBorderEmphasis ||= getComputedStyle(card).borderColor !== observation.baselineBorder;
				observation.sawLevelEmphasis ||= getComputedStyle(level).color !== observation.baselineLevel;
				observation.sawMotionTransform ||= hasTransform(level);
				const badge = card.querySelector<HTMLElement>('.level-up-badge');
				if (badge) {
					observedBadge = badge;
					observation.sawBadge = true;
					observation.sawMotionTransform ||= hasTransform(badge);
				} else if (observation.sawBadge) {
					observation.badgeInlineStyleAfterRemoval = observedBadge?.style.cssText ?? null;
					observation.done = true;
				}
				if (!observation.done) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		await reducedMotionButton.press('Enter');
		await expect(dialog).toContainText('7 pt');
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		let reducedMotionObservation = await page.evaluate(() => (window as typeof window & {
			__reducedMotionUpgradeObservation?: { done: boolean };
		}).__reducedMotionUpgradeObservation);
		while (!reducedMotionObservation?.done) {
			await page.clock.runFor(16);
			reducedMotionObservation = await page.evaluate(() => (window as typeof window & {
				__reducedMotionUpgradeObservation?: { done: boolean };
			}).__reducedMotionUpgradeObservation);
		}
		const reducedMotionFeedback = await page.evaluate(() => (window as typeof window & {
			__reducedMotionUpgradeObservation?: {
				sawBorderEmphasis: boolean;
				sawLevelEmphasis: boolean;
				sawMotionTransform: boolean;
				badgeInlineStyleAfterRemoval: string | null;
			};
		}).__reducedMotionUpgradeObservation);
		expect(reducedMotionFeedback?.sawBorderEmphasis).toBe(true);
		expect(reducedMotionFeedback?.sawLevelEmphasis).toBe(true);
		expect(reducedMotionFeedback?.sawMotionTransform).toBe(false);
		expect(reducedMotionFeedback?.badgeInlineStyleAfterRemoval).toBe('');
		await expect(dialog.locator('.level-up-badge')).toHaveCount(0);
		const reducedMotionCleanup = await upgradedCard.evaluate((card) => ({
			card: (card as HTMLElement).style.cssText,
			level: card.querySelector<HTMLElement>('.ability-level')!.style.cssText
		}));
		expect(reducedMotionCleanup).toEqual({ card: '', level: '' });
		await expect(dialog).toContainText('推論効率 Lv4');
		await page.setViewportSize({ width: 390, height: 640 });
		await expectHeaderToStayReadable();
		const mobileAdjustmentScroll = await dialog.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
			return { top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight };
		});
		expect(mobileAdjustmentScroll.maximum).toBeGreaterThan(0);
		expect(mobileAdjustmentScroll.top).toBe(mobileAdjustmentScroll.maximum);
		const adjustmentClosePoint = await dialog.getByRole('button', { name: '閉じる', exact: true }).evaluate((button) => {
			const rect = button.getBoundingClientRect();
			const dialog = button.closest('.adjustment-dialog-content')!;
			const dialogRect = dialog.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, inViewport: rect.top >= dialogRect.top && rect.bottom <= dialogRect.bottom && rect.left >= dialogRect.left && rect.right <= dialogRect.right, receivesPointer: Boolean(hit && button.contains(hit)) };
		});
		expect(adjustmentClosePoint.inViewport).toBe(true);
		expect(adjustmentClosePoint.receivesPointer).toBe(true);
		await page.mouse.click(adjustmentClosePoint.x, adjustmentClosePoint.y);
		await finishDialogExit(dialog);
		await expect(adjustment).toBeFocused();
		await page.reload();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 7, abilities: { inferenceEfficiency: 4, contextCapacity: 1, hallucinationSuppression: 1 } });
	});

	test('shows the linear Run effect and arrival-level cost at the adjustment terminal', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 10, { inferenceEfficiency: 10, contextCapacity: 4, hallucinationSuppression: 1 });
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
		const contextCapacity = dialog.locator('.ability-card').nth(1);
		await expect(contextCapacity.locator('.current-row strong')).toHaveText('50分');
		await expect(contextCapacity.locator('.delta-row strong')).toHaveText('+15分');
		await expect(inference).toContainText('1.90');
		await expect(inference).toContainText('+0.10 pt/分');
		await expect(inference.locator('.upgrade-button')).toHaveText('必要 2pt');
		await expect(dialog.locator('[data-action-variant="primary"]')).toHaveCount(3);
		await expect(dialog.locator('.upgrade-button')).toHaveCount(3);
		await expect(dialog.locator('.upgrade-button[data-action-variant="primary"]')).toHaveCount(3);
		const viewportSize = page.viewportSize();
		expect(viewportSize).not.toBeNull();
		if (viewportSize) await page.mouse.move(viewportSize.width - 1, viewportSize.height - 1);
		await expect.poll(async () => {
			const colors = await dialog.locator('.upgrade-button').evaluateAll((buttons) => buttons.map((button) => getComputedStyle(button).backgroundColor));
			return new Set(colors).size;
		}).toBe(1);
		for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await expectDialogIconCloseButton(dialog, dialog.getByRole('button', { name: '閉じる' }), '閉じる');
			for (const card of await dialog.locator('.ability-card').all()) {
				const button = card.locator('.upgrade-button');
				await expect(button).toBeEnabled();
				await expect(button).toBeVisible();
			}
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		await inference.getByRole('button', { name: '推論効率をLv11へ強化（必要2pt）' }).click();
		await expect(inference).toContainText('2.00');
		await expect(inference.locator('.upgrade-button')).toHaveText('必要 2pt');
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 8, abilities: { inferenceEfficiency: 11 } });
		await contextCapacity.getByRole('button', { name: 'コンテキスト容量をLv5へ強化（必要1pt）' }).click();
		await expect(contextCapacity.locator('.current-row strong')).toHaveText('1時間5分');
		await expect(contextCapacity.locator('.delta-row strong')).toHaveText('+15分');
		await expect(contextCapacity).not.toContainText('分 分');
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 7, abilities: { inferenceEfficiency: 11, contextCapacity: 5 } });
		await dialog.locator('.ability-card').nth(2).getByRole('button', { name: 'ハルシネーション抑制をLv2へ強化（必要1pt）' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 6, abilities: { inferenceEfficiency: 11, contextCapacity: 5, hallucinationSuppression: 2 } });
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
		await expect(dialog.locator('.delta-row')).toHaveCount(0);
		await expect(dialog).not.toContainText('必要ポイント');
		await expect(dialog.locator('.ability-card').nth(1).locator('.current-row strong')).toHaveText('24時間50分');
		for (const label of ['推論効率', 'コンテキスト容量', 'ハルシネーション抑制']) {
			const button = dialog.getByRole('button', { name: `${label}は最大Lvです` });
			await expect(button).toBeDisabled();
			await expect(button).toHaveAttribute('data-action-variant', 'primary');
			await expect(button).toHaveAttribute('aria-label', `${label}は最大Lvです`);
			await expect(button).toHaveText('最大Lv');
			await expect(button.locator('svg')).toHaveCount(0);
		}
		await expect(dialog.locator('.upgrade-button[data-action-variant="primary"]')).toHaveCount(3);
	});

	test('disables ability upgrades when the required points are unavailable', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 0);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
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
		const upgradeButton = inference.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt、ポイント不足）' });
		await expect(upgradeButton).toBeDisabled();
		await expect(upgradeButton).toHaveAttribute('data-action-variant', 'primary');
		expect(await upgradeButton.getAttribute('aria-describedby')).toBeNull();
		await expect(upgradeButton).toHaveText('必要 1pt');
		await expect(upgradeButton.locator('svg')).toHaveCount(1);
	});

	test('keeps ability choices primary as availability changes and disables them during an upgrade', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 1, { inferenceEfficiency: 10, contextCapacity: 1, hallucinationSuppression: 1 });
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await page.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		await expectDialogIconCloseButton(dialog, dialog.getByRole('button', { name: '閉じる' }), '閉じる');
		const upgrades = dialog.locator('.upgrade-button');
		await expect(upgrades).toHaveCount(3);
		await expect(dialog.locator('.upgrade-button[data-action-variant="primary"]')).toHaveCount(3);
		await expect(dialog.getByRole('button', { name: '推論効率をLv11へ強化（必要2pt、ポイント不足）' })).toBeDisabled();
		const contextUpgrade = dialog.getByRole('button', { name: 'コンテキスト容量をLv2へ強化（必要1pt）' });
		const halluUpgrade = dialog.getByRole('button', { name: 'ハルシネーション抑制をLv2へ強化（必要1pt）' });
		await expect(contextUpgrade).toBeEnabled();
		await expect(halluUpgrade).toBeEnabled();
		for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await expect(upgrades).toHaveCount(3);
			for (const button of await upgrades.all()) await expect(button).toBeVisible();
		}
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.evaluate(() => {
			const dialog = document.querySelector('.adjustment-dialog-content');
			if (!dialog) throw new Error('Expected the ability upgrade dialog.');
			const state = window as typeof window & { __upgradeBusyEvidence?: Promise<{ count: number; allDisabled: boolean; allPrimary: boolean }> };
			state.__upgradeBusyEvidence = new Promise((resolve) => {
				const observer = new MutationObserver(() => {
					const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('.upgrade-button'));
					if (buttons.length === 3 && buttons.every((button) => button.getAttribute('aria-label')?.includes('強化処理中'))) {
						observer.disconnect();
						resolve({ count: buttons.length, allDisabled: buttons.every((button) => button.disabled), allPrimary: buttons.every((button) => button.getAttribute('data-action-variant') === 'primary') });
					}
				});
				observer.observe(dialog, { subtree: true, attributes: true, attributeFilter: ['aria-label', 'disabled'] });
			});
		});
		await contextUpgrade.click();
		const busyEvidence = await page.evaluate(() => (window as typeof window & { __upgradeBusyEvidence: Promise<{ count: number; allDisabled: boolean; allPrimary: boolean }> }).__upgradeBusyEvidence);
		expect(busyEvidence).toEqual({ count: 3, allDisabled: true, allPrimary: true });
		for (const button of await upgrades.all()) {
			await expect(button).toBeDisabled();
			await expect(button).toHaveAttribute('data-action-variant', 'primary');
		}
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 0, abilities: { contextCapacity: 2 } });
		await expect(dialog.getByRole('button', { name: '推論効率をLv11へ強化（必要2pt、ポイント不足）' })).toBeDisabled();
		await expect(dialog.getByRole('button', { name: 'コンテキスト容量をLv3へ強化（必要1pt、ポイント不足）' })).toBeDisabled();
		await expect(dialog.getByRole('button', { name: 'ハルシネーション抑制をLv2へ強化（必要1pt、ポイント不足）' })).toBeDisabled();
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
