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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, overwriteRelayMendingBuild, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, moveRelaySelfTo } from './helpers/relayHarness';


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
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
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
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		const adjustment = page.getByRole('button', { name: '能力強化端末' });
		await adjustment.click();
		await expect(page.getByRole('status')).toContainText('近づくと端末を使える');

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
		await expect(dialog).toContainText('1.18');
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

	test('opens the self profile from the ComposerDock without adjustment-terminal proximity', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await openReadyRelayWorld(page);

		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await expect(profileTrigger).toBeVisible();
		await expect(page.locator('.composer-controls .profile-trigger')).toHaveCount(1);
		const avatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const dock = document.querySelector<HTMLElement>('.profile-trigger-character-avatar');
			if (!field || !dock) throw new Error('Expected field and ComposerDock self avatars.');
			const fieldStyle = getComputedStyle(field);
			const dockStyle = getComputedStyle(dock);
			return { fieldBackground: fieldStyle.backgroundColor, dockBackground: dockStyle.backgroundColor, fieldBorder: fieldStyle.borderTopColor, dockBorder: dockStyle.borderTopColor };
		});
		expect(avatarColors.dockBackground).toBe(avatarColors.fieldBackground);
		expect(avatarColors.dockBorder).toBe(avatarColors.fieldBorder);
		const dockBox = await profileTrigger.boundingBox();
		expect(dockBox).not.toBeNull();
		expect(dockBox!.width).toBeCloseTo(54, 0);
		const character = requireCharacterFromPubkey(getPublicKey(fixtureSecret(41)));
		const avatarImage = profileTrigger.locator('img');
		await expect(avatarImage).toHaveCount(1);
		await expect(avatarImage).toHaveAttribute('src', `/${character.picture}`);
		await expect.poll(() => avatarImage.evaluate((image) => {
			const loadedImage = image as HTMLImageElement;
			return { complete: loadedImage.complete, naturalWidth: loadedImage.naturalWidth };
		})).toEqual({ complete: true, naturalWidth: expect.any(Number) });
		await expect.poll(() => avatarImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await profileTrigger.click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await expect(dialog).toContainText('Run #1');
		await expect(dialog).toContainText('残り寿命');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog.locator('.summary-card[data-stat-icon="heart"] > span > svg')).toHaveCount(1);
		await expect(dialog.locator('.summary-card[data-stat-icon="wallet"] > span > svg')).toHaveCount(1);
		for (const statIcon of ['heart', 'wallet']) {
			const card = dialog.locator(`.summary-card[data-stat-icon="${statIcon}"]`);
			const labelBox = await card.locator('span').boundingBox();
			const valueBox = await card.locator('strong').boundingBox();
			expect(labelBox).not.toBeNull();
			expect(valueBox).not.toBeNull();
			expect(valueBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height - 1);
		}
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Root Point');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		const escapeContent = page.locator('.escape-info-popover');
		await expect(escapeTrigger).toBeVisible();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'closed');
		await expect(escapeContent).toBeHidden();
		await escapeTrigger.click();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'open');
		await expect(escapeContent).toBeVisible();
		await expect(escapeContent).toContainText('現在のRunを終了');
		await expect(escapeContent).toContainText('Root Point +1');
		await expect(escapeContent).toContainText('次の人格を選択');
		await expect(escapeContent).toContainText('秘密鍵を取得可能');
		await page.keyboard.press('Escape');
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toContainText(character.about);
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(96);
		await expect(dialog).toContainText('100,000 ptで現在のRunを終了します。');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog).toContainText('未回収の作業ポイントは含まれません。');
		await expect(dialog).not.toContainText('100,000 ptで現在のRunを終了します。未回収の作業ポイントは含まれません。');
		await expect(dialog).toContainText('100,000 pt');
		await expect(dialog.locator('.clear-progress-head[data-stat-icon="wallet"] > span > svg')).toHaveCount(1);
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeDisabled();
		await expect(dialog.getByText('clear不可: 所持ポイントが100,000pt未満です')).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: /へ強化/ })).toHaveCount(0);

		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(profileTrigger).toBeFocused();

		const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
		await fieldTrigger.click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Run #1');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const headerAvatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const header = document.querySelector<HTMLElement>('.self-profile-avatar');
			if (!field || !header) throw new Error('Expected field and self profile avatars.');
			return { field: getComputedStyle(field).backgroundColor, header: getComputedStyle(header).backgroundColor };
		});
		expect(headerAvatarColors.header).toBe(headerAvatarColors.field);
		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(fieldTrigger).toBeFocused();
	});

	test('publishes a World State exit after normal clear and advances to Identity selection', async ({ page }) => {
		const { pubkey } = await openClearReadyWorld(page);
		const position = await page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`).getAttribute('data-position');
		expect(position).toMatch(/^\d+,\d+$/);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		const profile = page.getByRole('dialog');
		await expect(profile.getByRole('button', { name: '脱出', exact: true })).toBeEnabled();
		await profile.getByRole('button', { name: '脱出', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect(page.getByText('脱出しました', { exact: true })).toBeVisible();
		await expect(page.getByText('現在のRunを終了し、Root Pointを1獲得しました。', { exact: true })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByText('脱出しました', { exact: true })).toHaveCount(0);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ rootPoints: number; mode: string; status: string; outcome: string }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { rootPoints: number; mode: { kind: string; pendingSelection?: { reusableIdentities?: Array<{ pubkey: string }> } }; identities: Array<{ pubkey: string; status: string; runHistory: Array<{ outcome: string }> }> };
						const identity = state.identities[0];
						resolve({ rootPoints: state.rootPoints, mode: state.mode.kind, status: identity.status, outcome: identity.runHistory.at(-1)?.outcome ?? '' });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toMatchObject({ rootPoints: 1, mode: 'selecting', status: 'cleared', outcome: 'cleared' });
		const exits = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, pubkey);
		expect(exits).toHaveLength(1);
		expect(exits[0]?.content).toBe(position?.replace(',', ':'));
	});

	test('keeps normal clear committed when terminal exit publication is rejected', async ({ page }) => {
		const { pubkey } = await openClearReadyWorld(page);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();
		await page.getByRole('dialog').getByRole('button', { name: '脱出', exact: true }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ rootPoints: number; mode: string; status: string }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { rootPoints: number; mode: { kind: string }; identities: Array<{ status: string }> };
						resolve({ rootPoints: state.rootPoints, mode: state.mode.kind, status: state.identities[0]?.status ?? '' });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toEqual({ rootPoints: 1, mode: 'selecting', status: 'cleared' });
	});

	test('keeps the self profile dialog inside a short mobile viewport and scrolls its content', async ({ page }) => {
		await page.setViewportSize({ width: 420, height: 420 });
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await openReadyRelayWorld(page);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const scrollViewport = dialog.locator('.self-profile-viewport');
		await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(0);
		await expect(dialog.locator('.escape-info-trigger')).not.toBeFocused();
		await expect(dialog.locator('[data-initial-focus]')).toBeFocused();
		const dialogBox = await dialog.boundingBox();
		const viewportBox = await scrollViewport.boundingBox();
		const metrics = await scrollViewport.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		await expect(dialog.locator('.self-profile-sections > section')).toHaveCount(3);
		for (const statIcon of ['heart', 'wallet']) {
			const card = dialog.locator(`.summary-card[data-stat-icon="${statIcon}"]`);
			const labelBox = await card.locator('span').boundingBox();
			const valueBox = await card.locator('strong').boundingBox();
			expect(labelBox).not.toBeNull();
			expect(valueBox).not.toBeNull();
			expect(valueBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height - 1);
		}
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(viewportBox).not.toBeNull();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(72);
		expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
		expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(420);
		expect(viewportBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
		expect(viewportBox!.y + viewportBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		await escapeTrigger.click();
		const escapePopover = page.locator('.escape-info-popover');
		await expect(escapePopover).toBeVisible();
		const popoverBox = await escapePopover.boundingBox();
		const expandedMetrics = await dialog.locator('.self-profile-viewport').evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		expect(popoverBox).not.toBeNull();
		expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewportSize.width);
		expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewportSize.height);
		expect(expandedMetrics).toEqual(metrics);
		await dialog.getByRole('button', { name: '脱出', exact: true }).scrollIntoViewIfNeeded();
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeVisible();
	});

	test('places the ComposerDock controls below the editor on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openReadyRelayWorld(page);

		const editor = page.locator('.composer-editor-slot');
		const controls = page.locator('.composer-controls');
		const profileTrigger = page.locator('.profile-trigger');
		const speechToggle = page.locator('.speech-type-toggle');
		const editorBox = await editor.boundingBox();
		const controlsBox = await controls.boundingBox();
		const profileBox = await profileTrigger.boundingBox();
		const speechBox = await speechToggle.boundingBox();
		expect(editorBox).not.toBeNull();
		expect(controlsBox).not.toBeNull();
		expect(profileBox).not.toBeNull();
		expect(speechBox).not.toBeNull();
		expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(controlsBox!.y + 1);
		expect(profileBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(speechBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(Math.abs(profileBox!.y - speechBox!.y)).toBeLessThan(2);
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
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
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

	test('keeps an offline mending job alive across browser reopen after its stored expiry', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 2 * 60 * 1000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);

		await page.clock.setSystemTime(startTime + 2 * 60 * 1000 + 10 * 1000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect(page.locator('.lifespan-hud')).toBeVisible();
		const reopened = await readRelayGameState(page);
		expect(reopened).toMatchObject({ personaPubkey: pubkey, lifespanExpiresAtMs: started.lifespanExpiresAtMs, mendingJob: expect.any(Object) });
	});

	test('closes a stale completed mending dialog before its reward can be collected', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		const terminal = page.getByRole('button', { name: '作業端末' });
		await terminal.click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);
		const job = started.mendingJob as { startedAtMs: number };
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await page.clock.setSystemTime(job.startedAtMs + 5 * 60 * 1000);
		const currentTerminalPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), currentTerminalPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await terminal.click();
		await expect(page.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
		await page.clock.runFor(1_001);
		const moved = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 0, y: 0 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), moved);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const stale = await readRelayGameState(page);
		expect(stale).toMatchObject({ points: 0, mendingJob: expect.any(Object) });
	});

	test('converges two tabs on one mending start and collection', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		const other = await page.context().newPage();
		const clients = [page, other] as const;
		try {
			await Promise.all(clients.map((client) => client.clock.install({ time: startTime })));
			await Promise.all(clients.map(async (client) => {
				await installHostOwnedStub(client);
				await installDelayedRelay(client, { primaryEvents: testEvents(startTime) });
			}));
			await seedRelayAccount(page, secret, pubkey);
			await Promise.all(clients.map(async (client) => {
				await client.goto('/');
				await expect(client.locator('.composer-dock')).toBeVisible();
				await client.evaluate(() => {
					const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
					relay.releaseMetadata(); relay.releasePrimary();
				});
				await expect(client.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
			}));
			const injectTerminalPosition = async (client: Page) => {
				const event = finalizeEvent(buildWorldStateEventTemplate({
					channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
					createdAt: Math.floor(await client.evaluate(() => Date.now()) / 1000)
				}), secret);
				await client.evaluate((position) => (window as typeof window & {
					__relayStartupTest: { injectPosition(event: object): void }
				}).__relayStartupTest.injectPosition(position), event);
				await expect(client.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
			};
			await Promise.all(clients.map(injectTerminalPosition));
			await Promise.all(clients.map(async (client) => {
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('dialog')).toBeVisible();
			}));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
			const started = await readRelayGameState(page);
			expect(started.mendingJob).toEqual(expect.any(Object));

			const completedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs + 5 * 60 * 1000;
			await Promise.all(clients.map((client) => client.clock.setSystemTime(completedAt)));
			await Promise.all(clients.map(injectTerminalPosition));
			for (const client of clients) {
				const close = client.getByRole('button', { name: '閉じる', exact: true });
				if (await close.isVisible()) await close.click();
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
			}
			await Promise.all(clients.map((client) => client.getByRole('button', { name: '成果を受け取る' }).click()));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
			const collected = await readRelayGameState(page);
			expect(collected).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
		} finally {
			await other.close();
		}
	});

	test('reloads an old terminal mutation after another tab selects the next identity', async ({ page }) => {
		const secret = fixtureSecret(63);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.evaluate(() => {
			let release: (() => void) | null = null;
			let started = false;
			(window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean; release: () => void; beforeMendingMutation: (operation: 'start' | 'collect') => Promise<void> } }).__personaBubbleFieldTestHooks = {
				started: () => started,
				release: () => { release?.(); release = null; },
				beforeMendingMutation: async (operation) => {
					if (operation !== 'start') return;
					started = true;
					await new Promise<void>((resolve) => { release = resolve; });
				}
			};
		});
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean } }).__personaBubbleFieldTestHooks.started())).toBe(true);
		const oldPublishedCount = (await relayState(page)).state.published.length;

		const reincarnator = await page.context().newPage();
		try {
			await installHostOwnedStub(reincarnator);
			await installDelayedRelay(reincarnator);
			await reincarnator.goto('/');
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect(reincarnator.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
			await overwriteRelayGameState(reincarnator, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await reincarnator.reload({ waitUntil: 'domcontentloaded' });
			await expect(reincarnator.getByRole('dialog')).toBeVisible();
			await expect(reincarnator.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
			await reincarnator.getByRole('button', { name: /を選ぶ$/ }).first().click();
			await startSelectedRun(reincarnator);
			await expect(reincarnator.getByRole('dialog')).toHaveCount(0);
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect.poll(async () => (await readRelayGameState(reincarnator)).personaPubkey).not.toBe(oldPubkey);

			const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
			await page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { release: () => void } }).__personaBubbleFieldTestHooks.release());
			await reloaded;
			await page.waitForLoadState('load');
			await expect(page.locator('.composer-dock')).toBeVisible();
			await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
			await page.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			const newPubkey = (await readRelayGameState(page)).personaPubkey;
			expect(newPubkey).not.toBe(oldPubkey);
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			await editor.fill('new persona after superseded mending');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === newPubkey)).toBe(true);
			const observed = await page.evaluate(() => {
				const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ kind: number; pubkey: string }>; published: Array<{ kind: number; pubkey: string }>; previousClosedSubscriptions: unknown[] } } }).__relayStartupTest.state;
				return { published: [...state.previousPublished, ...state.published], closed: state.previousClosedSubscriptions };
			});
			expect(observed.closed.length).toBeGreaterThan(0);
			const postSupersession = observed.published.slice(oldPublishedCount);
			expect(postSupersession.filter((event) => [WORLD_STATE_KIND, 42, 1111].includes(event.kind))).not.toContainEqual(expect.objectContaining({ pubkey: oldPubkey }));
			expect(postSupersession).toContainEqual(expect.objectContaining({ kind: WORLD_STATE_KIND, pubkey: newPubkey }));
			expect(postSupersession).toContainEqual(expect.objectContaining({ kind: 42, pubkey: newPubkey }));
		} finally {
			await reincarnator.close();
		}
	});

	test('shows overflow lifespan extension status after the Context cap', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, 1);
		await overwriteRelayMendingBuild(page, { inferenceAcceleration: 0, contextCompression: 1, hallucinationResistance: 0 }, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.setSystemTime(startTime + 8 * 60 * 1000);
		await pauseAtCurrentBrowserTime(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: '延命中' })).toBeVisible();
		await expect(dialog).toContainText('ポイント蓄積は上限');
		await expect(dialog).toContainText('寿命延長のみ継続中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('aria-label', '延命中');
		await expect(page.locator('.lifespan-hud [data-mending-status]')).toHaveAttribute('data-mending-icon', 'heart-plus');
		await expect(page.locator('.lifespan-hud [data-mending-rate]')).toHaveText('0.00 pt/分+0.02h/h');
	});

	test('fails closed to a public read-only world when a mending mutation finds corrupt storage', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await overwriteRelayGameState(page, { version: 99 });
		const before = (await publishedMessages(page)).length;
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('must remain read-only after corrupt mending');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
	});

	test('moves an expired persona to the next identity selection', async ({ page }) => {
		const secret = fixtureSecret(51);
		const pubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();

		await overwriteRelayGameState(page, {
			version: 4,
			personaPubkey: pubkey,
			lifespanExpiresAtMs: Date.now() - 1,
			points: 321,
			abilities: { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 },
			mendingJob: null
		});
		await page.reload({ waitUntil: 'domcontentloaded' });

		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const previousCharacterId = requireCharacterFromPubkey(pubkey).characterId;
		const pendingCharacterIds = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<string[]>((resolve, reject) => {
					request.onsuccess = () => resolve((request.result as { mode: { pendingSelection: { candidates: Array<{ characterId: string }> } } }).mode.pendingSelection.candidates.map((candidate) => candidate.characterId));
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		expect(pendingCharacterIds).not.toContain(previousCharacterId);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const reset = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<{ pubkey: string; game: { personaPubkey: string; points: number; abilities: Record<string, number> } }>((resolve, reject) => {
					const tx = database.transaction('persona-bubble-field-player-state');
					const playerRequest = tx.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					tx.oncomplete = () => {
						const lifecycle = playerRequest.result as { mode: { activeRun: { identity: { pubkey: string }; gameState: { personaPubkey: string; points: number; pointProgressTicks: number; abilities: Record<string, number> } } } };
						resolve({ pubkey: lifecycle.mode.activeRun.identity.pubkey, game: lifecycle.mode.activeRun.gameState });
					};
					tx.onerror = () => reject(tx.error);
				});
			} finally { database.close(); }
		});
		expect(reset.pubkey).not.toBe(pubkey);
		expect(reset.game).toMatchObject({ personaPubkey: reset.pubkey, points: 0, pointProgressTicks: 0,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${reset.pubkey}"]`)).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const before = (await publishedMessages(page)).length;
		await editor.fill('after identity transition');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, before + 1);
		const event = await page.evaluate((message) => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === message);
		}, 'after identity transition');
		expect(event?.pubkey).toBe(reset.pubkey);
	});

	for (const stateKind of ['missing', 'corrupt'] as const) {
		test(`keeps public world read available for ${stateKind} persona storage`, async ({ page }) => {
			const events = testEvents(Date.now() + 30_000);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: events });
			await seedUnavailablePersona(page, stateKind);
			await page.goto('/');
			await expect(page.locator('.composer-dock')).toBeVisible();
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === 42)).toBe(true);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
			await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
			await expect(page.locator('.lifespan-hud')).toHaveCount(0);
			await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);

			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			const before = (await publishedMessages(page)).length;
			await editor.fill('must remain read-only');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
			await expect(editor).toHaveValue('must remain read-only');

			const persistedKeys = await page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string[]>((resolve, reject) => {
						resolve(Array.from(database.objectStoreNames));
					});
				} finally { database.close(); }
			});
			expect(persistedKeys).toEqual(['persona-bubble-field-player-state', 'persona-bubble-field-root-secret']);
		});
	}

	test('shows and refreshes the current persona lifespan HUD', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const day = 24 * hour;
		const minute = 60 * 1000;
		const expiresAtMs = startTime + 2 * day + 18 * hour + minute;
		const secret = fixtureSecret(61);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, expiresAtMs);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const hud = page.locator('.lifespan-hud');
		await expect(hud.locator('[data-stat-icon="heart"] > svg')).toHaveCount(1);
		await expect(hud.locator('[data-stat-icon="wallet"] > svg')).toHaveCount(1);
		const hudIconLefts = await hud.locator('[data-stat-icon] > svg').evaluateAll((icons) => icons.map((icon) => Math.round(icon.getBoundingClientRect().left)));
		expect(hudIconLefts).toEqual([hudIconLefts[0], hudIconLefts[0]]);
		const hudStatBoxes = await hud.locator('[data-stat-icon]').evaluateAll((stats) => stats.map((stat) => {
			const icon = stat.querySelector('svg')!.getBoundingClientRect();
			const value = stat.querySelector('.stat-value')!.getBoundingClientRect();
			return { iconLeft: Math.round(icon.left), iconRight: Math.round(icon.right), valueLeft: Math.round(value.left), valueRight: Math.round(value.right) };
		}));
		expect(hudStatBoxes[0]?.iconLeft).toBe(hudStatBoxes[1]?.iconLeft);
		expect(hudStatBoxes[0]?.valueRight).toBe(hudStatBoxes[1]?.valueRight);
		for (const stat of hudStatBoxes) expect(stat.valueLeft).toBeGreaterThan(stat.iconRight);
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('2日 18時間');
		await expect(hud.locator('[data-stat-icon="wallet"]')).toHaveText('0pt');
		await expect(hud).not.toContainText('寿命');
		await expect(hud).not.toContainText('ポイント');
		await expect(hud).toHaveAttribute('aria-label', /寿命 .*ポイント 0pt/);
		await expect(hud.locator('[data-mending-status]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-rate]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-row]')).toHaveCount(0);

		await pauseAtCurrentBrowserTime(page);
		await page.clock.setSystemTime(expiresAtMs - 23 * hour - 59 * minute);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('23時間 59分');

		await page.clock.setSystemTime(expiresAtMs - 59 * minute - 59 * 1000);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-stat-icon="heart"]')).toHaveText('59分');
	});

	test('keeps public read-only updates after runtime death transition fails', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(59);
		const pubkey = getPublicKey(secret);
		const events = testEvents();
		await page.clock.install({ time: startTime });
		await installDeathTransitionFailure(page);
		await installPromptApiStub(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: events });
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		const initialRequestCount = (await relayState(page)).state.requests.length;
		await armDeathTransitionFailure(page);
		await page.clock.runFor(31_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__personaLifecycleFailureTest: { injected(): number }
		}).__personaLifecycleFailureTest.injected())).toBe(1);
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		expect((await relayState(page)).state.published.some((event) => event.kind === WORLD_STATE_KIND && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(false);
		await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(initialRequestCount);

		const live = testEvents(startTime + 31_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), live.message);
		await expect(page.locator(`.bubble[data-bubble-id="${live.message.id}"]`)).toBeVisible();

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const beforeComposer = (await publishedMessages(page)).length;
		await editor.fill('blocked after runtime death');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeComposer);
		await expect(editor).toHaveValue('blocked after runtime death');

		await editor.fill('');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeEnabled();
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		const beforeCandidate = (await publishedMessages(page)).length;
		await primary.click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeCandidate);
		await expect(page.locator('.suggestion-panel')).toBeVisible();
	});

	test('moves an active Relay session to identity selection when its deadline is crossed', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(55);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);

		await page.clock.runFor(31_000);
		await expect(page.locator('[data-death-presentation]')).toBeVisible();
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残さず進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const persistedPubkey = async () => page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<string>((resolve, reject) => {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					request.onsuccess = () => resolve((request.result as { mode: { kind: 'running'; activeRun: { identity: { pubkey: string } } } }).mode.activeRun.identity.pubkey);
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		await expect.poll(persistedPubkey).not.toBe(pubkey);
		const newPubkey = await persistedPubkey();
		expect(newPubkey).not.toBe(pubkey);

		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toHaveCount(0);

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('runtime identity transition message');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, 1);
		const event = await page.evaluate(() => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === 'runtime identity transition message');
		});
		expect(event?.pubkey).toBe(newPubkey);
	});

	test('publishes a terminal World State exit after live runtime death commits locally', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true, rejectTracePublishes: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);

		await page.clock.runFor(31_000);
		await expect(page.locator('[data-death-presentation]')).toBeVisible();
		await page.locator('[data-death-presentation] textarea').fill('A last word from this Run');
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残して進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect(page.getByText('Runが終了しました', { exact: true })).toBeVisible();
		await expect(page.getByText('この人格のRunは死亡として終了しました。次の人格を選んでください。', { exact: true })).toBeVisible();
		await page.reload();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByText('Runが終了しました', { exact: true })).toHaveCount(0);
		await expect.poll(async () => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, pubkey)).toHaveLength(1);
		const exit = await page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			const published = [...state.previousPublished, ...state.published];
			return published.find((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey);
		expect(exit?.content).toMatch(/^\d+:\d+$/);
		expect(exit?.tags.find((tag) => tag[0] === 'e')?.[1]).toBe(CHANNEL_ID);
		const traces = await page.evaluate((expectedPubkey) => {
			const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 42 && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace:death' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && event.pubkey === expectedPubkey && event.content === 'A last word from this Run')
				.map((event) => [event.id, event])).values()];
		}, pubkey);
		expect(traces).toHaveLength(1);
		expect(traces[0]?.tags.find((tag) => tag[0] === 'w')?.[1]).toBe(exit?.content);
	});

	test('keeps local death committed when the terminal exit is rejected by Relay', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(63);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.clock.runFor(31_000);
		await expect(page.locator('[data-death-presentation]')).toBeVisible();
		await page.locator('[data-death-presentation] textarea').fill('trace publication is best effort');
		await page.locator('[data-death-presentation]').getByRole('button', { name: '残して進む' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect.poll(() => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...state.previousPublished, ...state.published].some((event) => event.kind === 30079 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey)).toBe(true);
		const traces = (await relayState(page)).state.published.filter((event) => isDeathTraceEvent(event) && event.pubkey === pubkey);
		expect(traces).toHaveLength(0);
	});
});
