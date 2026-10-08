import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectDialogIconCloseButton } from './helpers/dialogMotion';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	buildPublicProfileStateTemplate,
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
import { CHANNEL_ID, AUTHORITATIVE_RELAYS, fixtureSecret, testEvents, isDeathTraceEvent, installDelayedRelay, relayState, dragRelayJoystick, publishedMessages, waitForPublishedMessageCount, pauseAtCurrentBrowserTime, startSelectedRun, openReadyRelayWorld, openClearReadyWorld, installPromptApiStub, seedRelayAccount, readRelayGameState, overwriteRelayGameState, seedUnavailablePersona, installDeathTransitionFailure, armDeathTransitionFailure, moveRelaySelfTo } from './helpers/relayHarness';

function rgbChannels(color: string): [number, number, number] {
	const channels = color.match(/[\d.]+/g)?.map(Number);
	if (!channels || channels.length < 3) throw new Error(`Unexpected CSS color: ${color}`);
	return [channels[0]!, channels[1]!, channels[2]!];
}

function relativeLuminance(color: string): number {
	const channels = rgbChannels(color).map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

async function expectProfileScrollbarLayout(dialog: Locator): Promise<void> {
	const scrollViewport = dialog.locator('.profile-dialog-scroll-viewport');
	const scrollbar = dialog.locator('.profile-dialog-scrollbar');
	await expect.poll(() => scrollViewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
	const dialogBox = await dialog.boundingBox();
	const scrollbarBox = await scrollbar.boundingBox();
	const contentBox = await dialog.locator('.profile-life-stats, .summary-card').first().boundingBox();
	const paddingRight = await dialog.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight));
	expect(dialogBox).not.toBeNull();
	expect(scrollbarBox).not.toBeNull();
	expect(contentBox).not.toBeNull();
	const outerInset = dialogBox!.x + dialogBox!.width - (scrollbarBox!.x + scrollbarBox!.width);
	const contentRight = contentBox!.x + contentBox!.width;
	const contentGap = scrollbarBox!.x - contentRight;
	expect(outerInset).toBeGreaterThan(0);
	expect(outerInset).toBeLessThanOrEqual(paddingRight / 2);
	expect(contentGap).toBeGreaterThan(outerInset);
	expect(scrollbarBox!.x).toBeGreaterThan(contentRight);
	expect(scrollbarBox!.x + scrollbarBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
	const previousTop = await scrollViewport.evaluate((element) => element.scrollTop);
	await scrollViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(previousTop);
	await scrollViewport.evaluate((element) => { element.scrollTop = 0; });
	expect(await dialog.evaluate((element) => element.ownerDocument.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

function contrastRatio(first: string, second: string): number {
	const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
	return (luminances[0]! + 0.05) / (luminances[1]! + 0.05);
}

async function expectSharedProfileFocusRing(button: Locator): Promise<void> {
	const focus = await button.evaluate((element) => {
		const style = getComputedStyle(element);
		const surface = getComputedStyle(element.closest('.clear-section')!).backgroundColor;
		const tokenProbe = document.createElement('span');
		tokenProbe.style.color = 'var(--action-focus-ring)';
		document.body.append(tokenProbe);
		const tokenColor = getComputedStyle(tokenProbe).color;
		tokenProbe.remove();
		return { matches: element.matches(':focus-visible'), outline: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor, tokenColor, surface };
	});
	expect(focus.matches).toBe(true);
	expect(focus.outline).toBe('solid');
	expect(focus.width).toBe('3px');
	expect(focus.color).toBe(focus.tokenColor);
	expect(contrastRatio(focus.color, focus.surface)).toBeGreaterThanOrEqual(3);
}


test.describe('Relay startup', () => {
	test('uses the shared focus ring on profile actions against their actual light surface', async ({ page }) => {
		await page.setViewportSize({ width: 1_200, height: 900 });
		await openClearReadyWorld(page);
		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await profileTrigger.click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.locator('[data-initial-focus]')).toBeFocused();

		const info = dialog.getByRole('button', { name: '脱出するとどうなるかを見る' });
		await page.keyboard.press('Tab');
		await expect(info).toBeFocused();
		await expectSharedProfileFocusRing(info);
		const escape = dialog.getByRole('button', { name: '脱出', exact: true });
		await expect(escape).toBeEnabled();
		await page.keyboard.press('Tab');
		await expect(escape).toBeFocused();
		await expectSharedProfileFocusRing(escape);
	});

	test('opens the self profile from the ActionDock without adjustment-terminal proximity', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await openReadyRelayWorld(page);

		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await expect(profileTrigger).toBeVisible();
		await expect(page.locator('.action-dock').getByRole('button', { name: '自分のプロフィールを開く' })).toHaveCount(1);
		const avatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const dock = document.querySelector<HTMLElement>('.profile-trigger-character-avatar');
			if (!field || !dock) throw new Error('Expected field and ActionDock self avatars.');
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
		const profileHeading = dialog.getByRole('heading', { name: 'プロフィール', exact: true });
		await expect(profileHeading).toHaveClass(/visually-hidden/);
		await expect(dialog.locator('[data-initial-focus]')).toBeFocused();
		await expect(dialog).toHaveAccessibleName(character.name);
		await expect(dialog).toHaveAccessibleDescription('自分のプロフィールと現在の人生情報');
		await expect(dialog.getByRole('heading', { name: '人生', exact: true })).toHaveCount(0);
		await expect(dialog.getByRole('heading', { name: 'Root', exact: true })).toHaveCount(0);
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await expect(dialog).toContainText('人生 #1');
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
		const abilityIcons = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];
		const abilityIconGeometry = await dialog.locator('.ability-row').evaluateAll((rows) => rows.map((row) => {
			const icon = row.querySelector<HTMLElement>('.ability-icon')!;
			const label = row.querySelector<HTMLElement>('.ability-copy')!;
			const level = row.querySelector<HTMLElement>('.ability-values')!;
			const box = (element: HTMLElement) => element.getBoundingClientRect();
			const iconBox = box(icon), labelBox = box(label), levelBox = box(level);
			return { key: row.getAttribute('data-ability-key'), iconName: icon.getAttribute('data-ability-icon'), iconCount: icon.querySelectorAll('svg').length, iconLeft: iconBox.left, labelLeft: labelBox.left, iconRight: iconBox.right, labelRight: labelBox.right, labelLevelOverlap: labelBox.right > levelBox.left };
		}));
		expect(abilityIconGeometry.map(({ key }) => key)).toEqual(abilityIcons);
		expect(abilityIconGeometry.map(({ iconName }) => iconName)).toEqual(['brain', 'stack-2', 'shield-check']);
		for (const [index, row] of abilityIconGeometry.entries()) {
			expect(row.iconCount).toBe(1);
			expect(row.labelLeft).toBeGreaterThanOrEqual(row.iconRight);
			expect(row.labelLevelOverlap).toBe(false);
			await expect(dialog.locator('.ability-row').nth(index).locator('.ability-copy strong')).toHaveText(['推論効率', 'コンテキスト容量', 'ハルシネーション抑制'][index]);
		}
		for (const [index, level] of ['Lv1', 'Lv1', 'Lv1'].entries()) await expect(dialog.locator('.ability-row').nth(index).locator('.ability-values strong')).toHaveText(level);
		await expect(dialog).toContainText('Root Point');
		await expect(dialog).toContainText('脱出');
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toHaveAttribute('data-action-intent', 'danger');
		await expect(dialog).not.toContainText('Normal Clear');
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		const escapeContent = page.locator('.escape-info-popover');
		await expect(escapeTrigger).toBeVisible();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'closed');
		await expect(escapeContent).toBeHidden();
		await escapeTrigger.click();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'open');
		await expect(escapeContent).toBeVisible();
		await expect(escapeContent).toContainText('現在の一生を終える');
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
		const about = dialog.locator('.profile-dialog-about');
		await expect(about).toHaveText(character.about);
		await expect(about).toHaveCSS('font-size', '16px');
		await expect(about).toHaveCSS('margin-top', '8px');
		await expect(about).toHaveCSS('margin-bottom', '8px');
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(96);
		await expect(dialog).toContainText('100,000 ptで現在の一生を終えます。');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog).toContainText('未回収の作業ポイントは含まれません。');
		await expect(dialog).not.toContainText('100,000 ptで現在の一生を終えます。未回収の作業ポイントは含まれません。');
		await expect(dialog).toContainText('100,000 pt');
		await expect(dialog.locator('.clear-progress-head[data-stat-icon="wallet"] > span > svg')).toHaveCount(1);
		const disabledEscape = dialog.getByRole('button', { name: '脱出', exact: true });
		await expect(disabledEscape).toBeDisabled();
		const disabledEscapeColors = await disabledEscape.evaluate((button) => {
			const disabled = getComputedStyle(button);
			const probe = document.createElement('span');
			probe.style.cssText = 'position:absolute;color:var(--action-disabled-foreground);background:var(--action-disabled-background);border:1px solid var(--action-disabled-border)';
			button.closest('.clear-section')!.append(probe);
			const genericDisabled = getComputedStyle(probe);
			const result = { background: disabled.backgroundColor, foreground: disabled.color, border: disabled.borderColor, genericBackground: genericDisabled.backgroundColor, genericForeground: genericDisabled.color, genericBorder: genericDisabled.borderColor };
			probe.remove();
			return result;
		});
		expect(disabledEscapeColors.background).toBe(disabledEscapeColors.genericBackground);
		expect(disabledEscapeColors.foreground).toBe(disabledEscapeColors.genericForeground);
		expect(disabledEscapeColors.border).toBe(disabledEscapeColors.genericBorder);
		await expect(dialog.getByText('clear不可: 所持ポイントが100,000pt未満です')).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: /へ強化/ })).toHaveCount(0);

		const closeButton = dialog.getByRole('button', { name: '閉じる', exact: true });
		await expectDialogIconCloseButton(dialog, closeButton, '閉じる');
		await closeButton.click();
		await expect(dialog).toBeHidden();
		await expect(profileTrigger).toBeFocused();

		const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
		await fieldTrigger.click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('人生 #1');
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

	test('opens the field self profile directly when the cell has no Trace on desktop and mobile', async ({ page }) => {
		for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
			const now = Date.now();
			const secret = fixtureSecret(19);
			const pubkey = getPublicKey(secret);
			await page.setViewportSize(viewport);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: testEvents(now) });
			await seedRelayAccount(page, secret, pubkey, now + 7 * 24 * 60 * 60 * 1000);
			await page.goto('/');
			await expect(page.locator('.action-dock')).toBeVisible();
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
			await expect(fieldTrigger).toBeVisible();
			await fieldTrigger.click();
			await expect(page.locator('.self-profile-content')).toBeVisible();
			await expect(page.locator('.field-action-menu')).toHaveCount(0);
			await expect(page.locator('.self-profile-content [data-initial-focus]')).toBeFocused();
			const scrollViewport = page.locator('.self-profile-viewport');
			await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(0);
			await expect(page.locator('.self-profile-content [data-initial-focus]')).toHaveClass(/visually-hidden/);
			await page.locator('.self-profile-content').getByRole('button', { name: '閉じる', exact: true }).click();
			await expect(page.locator('.self-profile-content')).toHaveCount(0);
			await expect(fieldTrigger).toBeFocused();
		}
	});

	test('offers self profile and Trace actions for their shared cell on desktop and mobile', async ({ page }) => {
		for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
			const now = Date.now();
			const secret = fixtureSecret(19);
			const pubkey = getPublicKey(secret);
			const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
			let root = finalizeEvent(buildWorldMessageTemplate({
				channel,
				content: 'Trace sharing the self cell',
				speechType: 'normal',
				position: { x: 3, y: 2 },
				createdAt: Math.floor(now / 1000)
			}), fixtureSecret(31));
			for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
				root = finalizeEvent(buildWorldMessageTemplate({
					channel,
					content: `Trace sharing the self cell ${attempt}`,
					speechType: 'normal',
					position: { x: 3, y: 2 },
					createdAt: Math.floor(now / 1000)
				}), fixtureSecret(31));
			}
			await page.setViewportSize(viewport);
			await page.clock.setFixedTime(now);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: testEvents(now), traceRoots: [root] });
			await seedRelayAccount(page, secret, pubkey, now + 7 * 24 * 60 * 60 * 1000);
			await page.goto('/');
			await expect(page.locator('.action-dock')).toBeVisible();
			await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
			await expect(fieldTrigger).toHaveAttribute('aria-label', / のプロフィールを開く$/);
			await expect(page.locator(`[data-trace-marker-position="3,2"]`)).toBeVisible();
			await fieldTrigger.click();
			const menu = page.getByRole('menu', { name: 'Cell actions' });
			const selfAction = menu.locator('[data-cell-action="participant"]');
			const traceAction = menu.locator('[data-cell-action="trace"]');
			await expect(menu.getByRole('menuitem')).toHaveCount(2);
			await expect(selfAction).toHaveText('自分のプロフィールを開く');
			await expect(traceAction).toHaveText('痕跡を調べる');
			await selfAction.click();
			const selfDialog = page.locator('.self-profile-content');
			await expect(selfDialog).toBeVisible();
			await expect(page.locator('.profile-dialog-content')).toHaveCount(0);
			await expect(selfDialog.locator('[data-initial-focus]')).toBeFocused();
			await selfDialog.getByRole('button', { name: '閉じる', exact: true }).click();
			await expect(selfDialog).toHaveCount(0);
			await expect(fieldTrigger).toBeFocused();

			await fieldTrigger.click();
			await expect(menu).toBeVisible();
			await menu.locator('[data-cell-action="trace"]').click();
			await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toContainText('Trace sharing the self cell');
			await expect(page.locator('[data-trace-marker-position="3,2"]')).toHaveCount(0);
		}
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
		const abilityGeometry = await dialog.locator('.ability-row').evaluateAll((rows) => rows.map((row) => {
			const icon = row.querySelector<HTMLElement>('.ability-icon')!.getBoundingClientRect();
			const label = row.querySelector<HTMLElement>('.ability-copy')!.getBoundingClientRect();
			const values = row.querySelector<HTMLElement>('.ability-values')!.getBoundingClientRect();
			return { iconRight: icon.right, labelLeft: label.left, labelRight: label.right, valuesLeft: values.left };
		}));
		for (const row of abilityGeometry) {
			expect(row.labelLeft).toBeGreaterThanOrEqual(row.iconRight);
			expect(row.labelRight).toBeLessThanOrEqual(row.valuesLeft);
		}
		const dialogBox = await dialog.boundingBox();
		const viewportBox = await scrollViewport.boundingBox();
		const metrics = await scrollViewport.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		await expectProfileScrollbarLayout(dialog);
		await expect(dialog.locator('.self-profile-sections > section')).toHaveCount(1);
		await expect(dialog.locator('[aria-labelledby="self-profile-run"], [aria-labelledby="self-profile-root"]')).toHaveCount(0);
		await expect(dialog.getByRole('heading', { name: '人生', exact: true })).toHaveCount(0);
		await expect(dialog.getByRole('heading', { name: 'Root', exact: true })).toHaveCount(0);
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
		const mobileCloseLayout = await dialog.evaluate((element) => {
			const scrollArea = element.querySelector('.self-profile-scroll')!;
			const footer = element.querySelector<HTMLElement>('.dialog-mobile-close-footer')!;
			const dialogRect = element.getBoundingClientRect();
			const footerRect = footer.getBoundingClientRect();
			return {
				horizontalOverflow: element.scrollWidth > element.clientWidth || document.documentElement.scrollWidth > innerWidth,
				closeOutsideScroll: !scrollArea.contains(footer),
				footerWithinDialog: footerRect.left >= dialogRect.left && footerRect.right <= dialogRect.right && footerRect.bottom <= dialogRect.bottom + 1
			};
		});
		expect(mobileCloseLayout).toEqual({ horizontalOverflow: false, closeOutsideScroll: true, footerWithinDialog: true });
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
		await expectDialogIconCloseButton(dialog, dialog.getByRole('button', { name: '閉じる' }), '閉じる');
	});

	test('places the ActionDock controls below the editor on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openReadyRelayWorld(page);

		const editor = page.locator('.composer-editor-slot');
		const profileTrigger = page.locator('.profile-trigger');
		const soundButton = page.getByRole('button', { name: 'Open sound settings' });
		const speechToggle = page.locator('.speech-type-toggle');
		const editorBox = await editor.boundingBox();
		const profileBox = await profileTrigger.boundingBox();
		const soundBox = await soundButton.boundingBox();
		const speechBox = await speechToggle.boundingBox();
		const viewportWidth = await page.evaluate(() => window.innerWidth);
		expect(editorBox).not.toBeNull();
		expect(profileBox).not.toBeNull();
		expect(soundBox).not.toBeNull();
		expect(speechBox).not.toBeNull();
		expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(profileBox!.y + 1);
		expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(speechBox!.y + 1);
		expect(Math.abs(profileBox!.y - soundBox!.y)).toBeLessThan(2);
		expect(profileBox!.x + profileBox!.width).toBeLessThan(soundBox!.x);
		if (viewportWidth <= 420) {
			expect(profileBox!.y + profileBox!.height).toBeLessThanOrEqual(speechBox!.y + 1);
			expect(soundBox!.y + soundBox!.height).toBeLessThanOrEqual(speechBox!.y + 1);
		} else {
			expect(Math.abs(profileBox!.y - speechBox!.y)).toBeLessThan(2);
			expect(soundBox!.x + soundBox!.width).toBeLessThan(speechBox!.x);
		}
	});

	test('shows overflow point and lifespan status after the Context cap', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, 1, { inferenceAcceleration: 0, contextCompression: 1, hallucinationResistance: 0 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
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
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.setSystemTime(startTime + 12 * 60 * 1000);
		await pauseAtCurrentBrowserTime(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: '延命中' })).toBeVisible();
		await expect(dialog.locator('.mending-dialog-title [data-mending-icon="heart-plus"]')).toHaveCount(1);
		await expect(dialog).toContainText('未回収ポイント');
		await expect(dialog).toContainText('寿命延長');
		await expect(dialog).toContainText('作業中に反映');
		await expect(dialog).toContainText('通常作業は上限');
		await expect(dialog).toContainText('ポイント・寿命延長が継続中');
		await expect(dialog.getByRole('progressbar', { name: '作業の蓄積進捗' })).toHaveAttribute('aria-valuenow', '100');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('aria-label', '延命中');
		await expect(page.locator('[data-unified-status-hud] [data-mending-status]')).toHaveAttribute('data-mending-icon', 'heart-plus');
		await expect(page.locator('[data-unified-status-hud] [data-mending-rate]')).toHaveText('0.20 pt/分+0.02h/h');
	});
for (const stateKind of ['missing', 'corrupt'] as const) {
		test(`keeps public world read available for ${stateKind} persona storage`, async ({ page }) => {
			const events = testEvents(Date.now() + 30_000);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: events });
			await seedUnavailablePersona(page, stateKind);
			await page.goto('/');
			await expect(page.locator('.action-dock')).toBeVisible();
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === 42)).toBe(true);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
			await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
			await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
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
			expect(persistedKeys).toEqual([
				'persona-bubble-field-interaction-rewards',
				'persona-bubble-field-player-state',
				'persona-bubble-field-root-secret',
				'persona-bubble-field-world-write-journal'
			]);
		});
	}

	test('shows and refreshes the top lifespan and points meters for the current persona', async ({ page }) => {
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
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const hud = page.locator('[data-unified-status-hud]');
		await expect(hud.locator('.meter-row')).toHaveCount(2);
		await expect(hud.locator('.meter-row').nth(0)).toContainText('寿命');
		await expect(hud.locator('.meter-row').nth(1)).toContainText('ポイント');
		await expect(hud.locator('[data-lifespan-value]')).toHaveText('2日 18時間');
		await expect(hud.locator('[data-points-value]')).toHaveText('0pt');
		await expect(hud).toHaveAttribute('aria-label', '寿命とポイント');
		await expect(hud.getByRole('meter', { name: '寿命' })).toHaveAttribute('aria-valuetext', /2日 18時間、最大 7日/);
		await expect(hud.getByRole('meter', { name: 'ポイント' })).toHaveAttribute('aria-valuetext', '0pt、100,000ptまで');
		const hudBounds = await hud.boundingBox();
		expect(hudBounds).toBeTruthy();
		if (hudBounds) expect(hudBounds.width).toBeGreaterThan(1_000);
		await expect(hud.locator('[data-mending-status]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-rate]')).toHaveCount(0);
		await expect(hud.locator('[data-mending-row]')).toHaveCount(0);

		await pauseAtCurrentBrowserTime(page);
		await page.clock.setSystemTime(expiresAtMs - 23 * hour - 59 * minute);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-lifespan-value]')).toHaveText('23時間 59分');
		await expect(hud.locator('[data-lifespan-value]')).toHaveAttribute('data-value-change', 'decrease');
		await expect(hud.locator('[data-lifespan-value]')).toHaveCSS('color', 'rgb(255, 104, 117)');

		await page.clock.setSystemTime(expiresAtMs - 59 * minute - 59 * 1000);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud.locator('[data-lifespan-value]')).toHaveText('59分');
		await expect(hud.locator('[data-lifespan-value]')).toHaveAttribute('data-value-change', 'decrease');
		await expect(hud.locator('[data-lifespan-value]')).toHaveCSS('color', 'rgb(255, 104, 117)');
	});

	test('keeps a rank-three seven-day Run inside its thirty-day lifespan meter and the top HUD operable on desktop and mobile', async ({ page }) => {
		const startTime = Date.now();
		const day = 24 * 60 * 60 * 1_000;
		const secret = fixtureSecret(61);
		const pubkey = getPublicKey(secret);
		await page.setViewportSize({ width: 1_200, height: 900 });
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * day, 125_000, undefined, 3, { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 3 });
		await page.goto('/');
		await expect(page.locator('.action-dock')).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const hud = page.locator('[data-unified-status-hud]');
		const lifeMeter = hud.getByRole('meter', { name: '寿命' });
		const pointsMeter = hud.getByRole('meter', { name: 'ポイント' });
		await expect(lifeMeter).toHaveAttribute('aria-valuemin', '0');
		await expect(lifeMeter).toHaveAttribute('aria-valuemax', String(30 * day));
		const initialLifespanMeterValue = Number(await lifeMeter.getAttribute('aria-valuenow'));
		expect(initialLifespanMeterValue).toBeLessThanOrEqual(7 * day);
		expect(initialLifespanMeterValue).toBeGreaterThan(7 * day - 60_000);
		await expect(pointsMeter).toHaveAttribute('aria-valuemax', '100000');
		await expect(pointsMeter).toHaveAttribute('aria-valuenow', '100000');
		await expect(hud.locator('[data-points-value]')).toHaveText('125,000pt');
		await expect(hud).not.toContainText('脱出');

		const chatter = page.locator('aside[aria-label="Chatter"]');
		if (!(await chatter.isVisible())) await page.keyboard.press('c');
		await expect(chatter).toBeVisible();
		const sound = page.getByRole('button', { name: 'Open sound settings' });
		await sound.click();
		const slider = page.getByRole('slider', { name: 'Sound volume' });
		await expect(slider).toBeVisible();
		await slider.fill('35');
		await expect(slider).toHaveValue('35');
		await page.keyboard.press('Escape');

		for (const viewport of [{ width: 1_200, height: 900 }, { width: 960, height: 900 }, { width: 390, height: 844 }, { width: 390, height: 480 }]) {
			await page.setViewportSize(viewport);
			const hudBox = await hud.boundingBox();
			const soundBox = await sound.boundingBox();
			expect(hudBox && soundBox).toBeTruthy();
			if (hudBox && soundBox) {
				expect(hudBox.y).toBeLessThan(50);
				expect(soundBox.x).toBeGreaterThanOrEqual(0);
				expect(soundBox.y).toBeGreaterThanOrEqual(0);
				expect(soundBox.x + soundBox.width).toBeLessThanOrEqual(viewport.width);
				expect(soundBox.y + soundBox.height).toBeLessThanOrEqual(viewport.height);
			}
			const meterRows = await hud.locator('.meter-row').evaluateAll((rows) => rows.map((row) => {
				const box = (element: Element) => {
					const rect = element.getBoundingClientRect();
					return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
				};
				const meter = row.querySelector('[role="meter"]')!;
				const fill = meter.querySelector('.meter-fill')!;
				const value = row.querySelector('strong')!;
				const textRange = document.createRange();
				textRange.selectNodeContents(value);
				const textRects = [...textRange.getClientRects()];
				const textLeft = Math.min(...textRects.map((rect) => rect.left));
				const textRight = Math.max(...textRects.map((rect) => rect.right));
				return {
					row: box(row),
					label: box(row.querySelector('.meter-label')!),
					bar: box(meter),
					value: box(value),
					text: { left: textLeft, right: textRight, width: textRight - textLeft },
					centers: [row.querySelector('.meter-label')!, meter, row.querySelector('strong')!].map((element) => {
						const rect = element.getBoundingClientRect();
						return (rect.top + rect.bottom) / 2;
					}),
					barRadius: getComputedStyle(meter).borderTopLeftRadius,
					fillRadius: getComputedStyle(fill).borderTopLeftRadius
				};
			}));
			const expectedBarHeight = viewport.width >= 960 ? 14 : 12;
			expect(meterRows).toHaveLength(2);
			for (const row of meterRows) {
				expect(row.bar.height).toBe(expectedBarHeight);
				expect(row.barRadius).toBe('0px');
				expect(row.fillRadius).toBe('0px');
			}
			const textMetrics = await hud.evaluate((element) => {
				const lifespan = getComputedStyle(element.querySelector('[data-lifespan-value]')!);
				const points = getComputedStyle(element.querySelector('[data-points-value]')!);
				const unit = getComputedStyle(element.querySelector('[data-points-value] span')!);
				return { lifespanSize: lifespan.fontSize, lifespanWeight: lifespan.fontWeight, pointsSize: points.fontSize, pointsWeight: points.fontWeight, unitSize: unit.fontSize };
			});
			expect(textMetrics.pointsSize).toBe(textMetrics.lifespanSize);
			expect(textMetrics.pointsWeight).toBe(textMetrics.lifespanWeight);
			expect(Number.parseFloat(textMetrics.unitSize)).toBeGreaterThan(Number.parseFloat(textMetrics.pointsSize) * .8);
			if (viewport.width >= 960) {
				for (const row of meterRows) {
					for (const center of row.centers) expect(Math.abs(center - row.centers[0])).toBeLessThanOrEqual(1);
					expect(row.label.right).toBeLessThanOrEqual(row.bar.left);
					expect(row.bar.right).toBeLessThanOrEqual(row.value.left);
					expect(row.bar.left - row.label.right).toBeGreaterThanOrEqual(12);
					expect(row.bar.left - row.label.right).toBeLessThanOrEqual(16);
					expect(row.value.left - row.bar.right).toBeGreaterThanOrEqual(12);
					expect(row.value.left - row.bar.right).toBeLessThanOrEqual(16);
					expect(row.text.left).toBeGreaterThanOrEqual(row.value.left - 1);
					expect(row.text.right).toBeLessThanOrEqual(row.value.right + 1);
					expect(row.value.width).toBeGreaterThanOrEqual(row.text.width - 1);
					expect(row.value.right).toBeLessThanOrEqual(row.row.right);
				}
				expect(Math.abs(meterRows[0].bar.left - meterRows[1].bar.left)).toBeLessThanOrEqual(1);
				expect(Math.abs(meterRows[0].bar.right - meterRows[1].bar.right)).toBeLessThanOrEqual(1);
			} else {
				for (const row of meterRows) {
					expect(row.label.right).toBeLessThan(row.text.left);
					expect(row.text.right).toBeLessThanOrEqual(row.row.right);
					expect(row.text.left).toBeGreaterThanOrEqual(row.value.left - 1);
					expect(row.text.right).toBeLessThanOrEqual(row.value.right + 1);
					expect(row.bar.top).toBeGreaterThanOrEqual(row.label.bottom);
					expect(row.bar.top).toBeGreaterThanOrEqual(row.value.bottom);
					expect(row.bar.width).toBeGreaterThanOrEqual(row.row.width - 1);
				}
			}
			const chatterBox = await chatter.boundingBox();
			expect(chatterBox).toBeTruthy();
			if (chatterBox) {
				expect(chatterBox.x).toBeGreaterThanOrEqual(0);
				expect(chatterBox.y).toBeGreaterThanOrEqual(0);
				expect(chatterBox.x + chatterBox.width).toBeLessThanOrEqual(viewport.width);
				expect(chatterBox.y + chatterBox.height).toBeLessThanOrEqual(viewport.height + 1);
			}
		}
	});
});

test('opens an active field participant profile by pubkey and renders only matching Run evidence', async ({ page }) => {
	const startTime = Date.now();
	const selfSecret = fixtureSecret(19);
	const otherSecret = fixtureSecret(23);
	const otherPubkey = getPublicKey(otherSecret);
	const otherCharacter = requireCharacterFromPubkey(otherPubkey);
	const createdAt = Math.floor(startTime / 1_000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
	const otherEvents = {
		message: finalizeEvent(buildWorldMessageTemplate({ channel, content: 'Public profile target', speechType: 'normal', position: { x: 5, y: 4 }, createdAt }), otherSecret),
		position: finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 5, y: 4 }, slot: 0, createdAt, runNumber: 2 }), otherSecret)
	};
	const profileCandidates = [12_345, 54_321].map((points) => finalizeEvent(buildPublicProfileStateTemplate({
		channel, createdAt, runNumber: 2, points,
		abilities: { inferenceEfficiency: 1, contextCapacity: 2, hallucinationSuppression: 3 }, rootPoints: 678,
		lifespan: { baseExpiresAtMs: startTime + 5 * 24 * 60 * 60 * 1_000, extension: null }
	}), otherSecret)).sort((left, right) => left.id.localeCompare(right.id));
	const profileState = profileCandidates[0]!;
	const expectedProfilePoints = (JSON.parse(profileState.content) as { points: number }).points;
	await page.clock.install({ time: startTime });
	await installHostOwnedStub(page);
	await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret), startTime + 7 * 24 * 60 * 60 * 1_000);
	await installDelayedRelay(page, { primaryEvents: otherEvents, profileStateEvents: [profileCandidates[1]!, profileCandidates[0]!] });
	await page.goto('/');
	await expect(page.locator('.action-dock')).toBeVisible();
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
		AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && (request.filter.kinds as number[])[0] === 42)).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	const participant = page.locator(`.participant[data-participant-id="${otherPubkey}"]`);
	await expect(participant).toBeVisible();
	const chatter = page.getByLabel('Chatter', { exact: true });
	if (await chatter.isVisible()) await page.locator('.chatter-toggle').click();
	const fieldProfileTrigger = participant.getByRole('button', { name: /プロフィールを開く/ });
	await fieldProfileTrigger.focus();
	await fieldProfileTrigger.press('Enter');
	const dialog = page.locator('.profile-dialog-content');
	await expect(dialog).toBeVisible();
	const profileHeading = dialog.getByRole('heading', { name: 'プロフィール', exact: true });
	await expect(profileHeading).toHaveClass(/visually-hidden/);
	await expect(dialog.locator('[data-initial-focus]')).toBeFocused();
	await expect(dialog).toHaveAccessibleName(otherCharacter.name);
	await expect(dialog).toHaveAccessibleDescription('キャラクターのプロフィールと確認できた公開人生情報');
	const profileViewport = dialog.locator('.profile-dialog-scroll-viewport');
	await expect.poll(() => profileViewport.evaluate((element) => element.scrollTop)).toBe(0);
	await expect(dialog.getByRole('heading', { name: '人生', exact: true })).toHaveCount(0);
	await expect(dialog.getByRole('heading', { name: 'Root', exact: true })).toHaveCount(0);
	await expect(dialog.locator('.profile-dialog-avatar')).toBeVisible();
	await expect(dialog.locator('[data-dialog-title]')).toHaveText(otherCharacter.name);
	const about = dialog.locator('.profile-dialog-about');
	await expect(about).toHaveText(otherCharacter.about);
	await expect(about).toHaveCSS('font-size', '16px');
	await expect(about).toHaveCSS('margin-top', '8px');
	await expect(about).toHaveCSS('margin-bottom', '8px');
	await expect(dialog.locator('.profile-state-status')).toHaveCount(0);
	await expect(dialog).toContainText('人生 #2');
	await expect(dialog).toContainText('残り寿命');
	await expect(dialog).toContainText('所持ポイント');
	await expect(dialog).toContainText('推論効率');
	await expect(dialog).toContainText('コンテキスト容量');
	await expect(dialog).toContainText('ハルシネーション抑制');
	await expect(dialog.locator('.work-details')).toHaveCount(0);
	await expect(dialog.getByRole('heading', { name: '詳細' })).toHaveCount(0);
	await expect(dialog).toContainText(`${expectedProfilePoints} pt`);
	await expect(dialog).toContainText('678 RP');
	await expect(dialog.locator('.profile-state-status')).toHaveCount(0);
	await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toHaveCount(0);
	await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
		request.filters.some((filter) => (filter.authors as string[] | undefined)?.[0] === otherPubkey &&
			(filter['#d'] as string[] | undefined)?.includes(`io.github.lokuyow.persona-bubble-field:profile-state:${CHANNEL_ID}`)))).toBe(true);
	const profileReqs = (await relayState(page)).state.requests.filter((request) => request.filters.some((filter) =>
		(filter.authors as string[] | undefined)?.[0] === otherPubkey && (filter['#d'] as string[] | undefined)?.includes(`io.github.lokuyow.persona-bubble-field:profile-state:${CHANNEL_ID}`)));
	expect(profileReqs.length).toBeGreaterThan(0);
	for (const request of profileReqs) for (const filter of request.filters) {
		if ((filter.authors as string[] | undefined)?.[0] !== otherPubkey) continue;
		expect(filter.limit).toBe(1);
		expect(filter.since).toBeUndefined();
		expect(filter['#r']).toBeUndefined();
	}
	for (const size of [{ width: 1280, height: 420 }, { width: 390, height: 420 }]) {
		await page.setViewportSize(size);
		await expectProfileScrollbarLayout(dialog);
	}
	await page.setViewportSize({ width: 390, height: 640 });
	await expect(dialog).toHaveClass(/self-profile-content/);
	await expect(dialog.locator('.profile-dialog-identity')).toBeVisible();
	await expect(dialog.locator('.profile-dialog-scroll-viewport')).toBeVisible();
	const dialogGeometry = await dialog.boundingBox();
	const viewportSize = page.viewportSize();
	expect(dialogGeometry).not.toBeNull();
	expect(viewportSize).not.toBeNull();
	expect(dialogGeometry!.x).toBeGreaterThanOrEqual(0);
	expect(dialogGeometry!.y).toBeGreaterThanOrEqual(0);
	expect(dialogGeometry!.x + dialogGeometry!.width).toBeLessThanOrEqual(viewportSize!.width);
	expect(dialogGeometry!.y + dialogGeometry!.height).toBeLessThanOrEqual(viewportSize!.height);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.evaluate(() => {
		(document as Document & { __profileExitText?: string }).__profileExitText = '';
		document.addEventListener('transitionrun', (event) => {
			if (!(event.target instanceof HTMLElement) || !event.target.matches('.profile-dialog-content[data-ending-style]')) return;
			(document as Document & { __profileExitText?: string }).__profileExitText = event.target.textContent ?? '';
		}, true);
	});
	await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
	await expect.poll(() => page.evaluate(() => (document as Document & { __profileExitText?: string }).__profileExitText ?? '')).not.toBe('');
	const exitPresentationText = await page.evaluate(() => (document as Document & { __profileExitText?: string }).__profileExitText ?? '');
	for (const expectedText of [otherCharacter.name, otherCharacter.about, '人生 #2', `${expectedProfilePoints} pt`, 'コンテキスト容量', '678 RP']) {
		expect(exitPresentationText).toContain(expectedText);
	}
	await expect(dialog).toHaveCount(0);
	await expect.poll(async () => {
		const state = await relayState(page);
		return profileReqs.every((request) => state.state.closedSubscriptions.some((closed) => closed.subId === request.subId));
	}).toBe(true);
});
