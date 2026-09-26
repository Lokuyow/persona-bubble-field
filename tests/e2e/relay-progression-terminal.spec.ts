import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectIconCloseButton } from './helpers/iconCloseButton';
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
		await expect(activeDialog.getByRole('button', { name: '詳細を見る' })).toHaveAttribute('data-action-variant', 'tertiary');
		const closeButton = activeDialog.getByRole('button', { name: '閉じる', exact: true });
		await expectIconCloseButton(closeButton, '閉じる');
		await expect(collectButton.locator('svg')).toHaveCount(1);
		await expect(collectButton.locator('svg path')).toHaveAttribute('d', /^M4 20h16m-8-6V4/);
		await expect(activeDialog.locator('.mending-success-feedback')).toHaveCount(0);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toBeDisabled();
		const disabledCollectStyle = await collectButton.evaluate((button) => ({
			...(() => {
				const style = getComputedStyle(button);
				const dialog = button.closest('.mending-dialog-content')!;
				const probe = document.createElement('span');
				probe.style.cssText = 'position:absolute;background:var(--action-primary-disabled-background);border:1px solid var(--action-primary-disabled-border);color:var(--action-primary-disabled-foreground)';
				dialog.append(probe);
				const tokenStyle = getComputedStyle(probe);
				const details = getComputedStyle(dialog.querySelector('.details-toggle')!);
				const result = { background: style.backgroundColor, border: style.borderColor, foreground: style.color, tokenBackground: tokenStyle.backgroundColor, tokenBorder: tokenStyle.borderColor, tokenForeground: tokenStyle.color, tertiaryBackground: details.backgroundColor, tertiaryForeground: details.color };
				probe.remove();
				return result;
			})()
		}));
		expect(disabledCollectStyle.background).toBe(disabledCollectStyle.tokenBackground);
		expect(disabledCollectStyle.border).toBe(disabledCollectStyle.tokenBorder);
		expect(disabledCollectStyle.foreground).toBe(disabledCollectStyle.tokenForeground);
		expect(disabledCollectStyle.background).not.toBe(disabledCollectStyle.tertiaryBackground);
		expect(disabledCollectStyle.foreground).not.toBe(disabledCollectStyle.tertiaryForeground);
		const beforeZeroPointCollection = await publishedWorldStateCount();
		await expect.poll(publishedWorldStateCount).toBe(beforeZeroPointCollection);
		const originalViewport = page.viewportSize() ?? { width: 1280, height: 720 };
		for (const [width, height, expectedColumns] of [[1280, 800, 2], [390, 640, 1]] as const) {
			await page.setViewportSize({ width, height });
			if (width === 390) await expectIconCloseButton(closeButton, '閉じる');
			const visibleButtonStyles = await activeDialog.evaluate((dialog) => {
				const collect = getComputedStyle(dialog.querySelector('.collect-button')!);
				const neutral = getComputedStyle(dialog.querySelector('.details-toggle')!);
				return { collectBackground: collect.backgroundColor, collectBorder: collect.borderColor, collectForeground: collect.color, neutralBackground: neutral.backgroundColor };
			});
			expect(visibleButtonStyles.collectBackground).toBe(disabledCollectStyle.background);
			expect(visibleButtonStyles.collectBorder).toBe(disabledCollectStyle.border);
			expect(visibleButtonStyles.collectForeground).toBe(disabledCollectStyle.foreground);
			expect(visibleButtonStyles.collectBackground).not.toBe(visibleButtonStyles.neutralBackground);
			const layout = await activeDialog.evaluate((dialog) => {
				const cards = [...dialog.querySelectorAll<HTMLElement>('.result-card')];
				const cardRects = cards.map((card) => card.getBoundingClientRect());
				const resultList = dialog.querySelector('.result-list')!.getBoundingClientRect();
				const status = dialog.querySelector('.status-group')!.getBoundingClientRect();
				const button = dialog.querySelector('.collect-button')!.getBoundingClientRect();
				const details = dialog.querySelector('.details-section')!.getBoundingClientRect();
				const close = dialog.querySelector('.action-button-close')!.getBoundingClientRect();
				return {
					columns: new Set(cardRects.map((rect) => Math.round(rect.left))).size,
					cardsOverlap: cardRects[0].right > cardRects[1].left && cardRects[0].left < cardRects[1].right && cardRects[0].bottom > cardRects[1].top && cardRects[0].top < cardRects[1].bottom,
					cardsSameHeight: Math.abs(cardRects[0].height - cardRects[1].height) < 1,
					horizontalOverflow: dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
					dialogOrder: close.top <= resultList.top && resultList.bottom <= status.top && status.bottom <= button.top && button.bottom <= details.top,
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
		await expect(activeDialog.getByRole('button', { name: '詳細を見る' })).toHaveAttribute('aria-expanded', 'false');
		await activeDialog.getByRole('button', { name: '詳細を見る' }).click();
		await expect(activeDialog).toContainText('現在のポイント速度');
		await expect(activeDialog).toContainText('最大蓄積');
		await expect(activeDialog).toContainText('1時間の作業で寿命');
		await expect(activeDialog).toContainText('推論加速');
		await expect(activeDialog).toContainText('最大寿命');
		await expect(activeDialog.getByRole('button', { name: '詳細を閉じる' })).toHaveAttribute('aria-expanded', 'true');
		await page.setViewportSize({ width: 390, height: 520 });
		const detailLayout = await activeDialog.evaluate((dialog) => ({
			horizontalOverflow: dialog.scrollWidth > dialog.clientWidth || document.documentElement.scrollWidth > document.documentElement.clientWidth,
			verticalOverflow: dialog.scrollHeight > dialog.clientHeight
		}));
		expect(detailLayout.horizontalOverflow).toBe(false);
		expect(detailLayout.verticalOverflow).toBe(true);
		await expect(closeButton).toBeInViewport({ ratio: 1 });
		await page.setViewportSize(originalViewport);
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
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(terminal).toBeFocused();

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
		await expect(page.getByRole('dialog').locator('.mending-dialog-title [data-mending-icon="player-pause"]')).toHaveCount(1);
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '作業停止中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'player-pause');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('0.00 pt/分+0.0h/h');
		await expect(page.getByRole('dialog')).not.toContainText('今受け取れる');
		await expect(page.getByRole('dialog')).toContainText('+5 pt');
		await expect(page.getByRole('dialog')).not.toContainText('次の1ptまで');
		await expect(page.getByRole('dialog').locator('[data-mending-icon="coins"] .next-point')).toHaveClass(/next-point-hidden/);
		await page.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object), points: 9, pointProgressTicks: 30_000_000 });
		await expect(page.getByRole('dialog')).toContainText('9 pt');
		await expect(page.getByRole('dialog')).toContainText('上限まで あと5分');
		await expect(page.getByRole('dialog')).toContainText('+0 pt');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '作業中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'tool');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('1.00 pt/分+0.1h/h');
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
		const upgradeButton = dialog.getByRole('button', { name: '推論効率をLv2へ強化（必要1pt）' });
		await expect(upgradeButton).toBeFocused();
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
		await page.keyboard.press('Enter');
		await page.keyboard.press('Enter');
		await expect(dialog).toContainText('9 pt');
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === pubkey).length).toBeGreaterThan(beforeAbilityUpgrade);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		const stableDuring = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			valuesY: card.querySelector('.ability-values')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableDuring).toEqual(stableBefore);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(0, { timeout: 1_500 });
		const stableAfter = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			valuesY: card.querySelector('.ability-values')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableAfter).toEqual(stableBefore);
		await expect(page.locator('[data-unified-status-hud] [data-points-value]')).toHaveText('9pt');
		await expect(page.locator('[data-unified-status-hud] [data-points-meter]')).toHaveAttribute('aria-valuenow', '9');
		await expect(dialog).toContainText('推論効率 Lv2');
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(adjustment).toBeFocused();
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
			await expectIconCloseButton(dialog.getByRole('button', { name: '閉じる' }), '閉じる');
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
		await expectIconCloseButton(dialog.getByRole('button', { name: '閉じる' }), '閉じる');
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
		await page.evaluate(() => document.querySelector<HTMLButtonElement>('.adjustment-dialog-content .ability-card:nth-child(2) .upgrade-button')!.click());
		await expect(dialog.getByRole('button', { name: /強化処理中/ })).toHaveCount(3);
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
