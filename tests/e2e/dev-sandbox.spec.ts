import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevTraceWorld, openDevWorld } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('lists categorized scenarios and keeps the selected character across scenario reset', async ({ page }) => {
		await page.goto('/?devWorld=1&devCharacter=020');
		await expect(page.getByLabel('Select DEV scenario')).toHaveValue('default');
		await expect(page.locator('optgroup[label="Speech"]')).toHaveCount(1);
		await expect(page.getByText('Plain DEV World with no seeded fixture.')).toBeVisible();
		await expect(page.getByLabel('Select sandbox character')).toHaveValue('020');
		const scenarioSelect = page.getByLabel('Select DEV scenario');
		await scenarioSelect.selectOption('trace-replies');
		await page.getByRole('button', { name: 'Open selected DEV scenario' }).click();
		await expect(scenarioSelect).toHaveValue('trace-replies');
		await expect(page).toHaveURL(/devWorld=1&devCharacter=020&devScenario=trace-replies|devWorld=1&devScenario=trace-replies&devCharacter=020/);
		await expect(page.getByLabel('Select sandbox character')).toHaveValue('020');
		await page.getByRole('button', { name: 'Reset scenario' }).click();
		await expect(page).toHaveURL(/devScenario=trace-replies/);
		await expect(page.getByLabel('Select sandbox character')).toHaveValue('020');
		await expect(page.locator('.trace-marker')).toHaveCount(3);
	});

	test('keeps desktop Trace DEV controls and Chatter actions independently operable', async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 720 });
		await openDevTraceWorld(page, 'trace-replies');
		const controls = page.getByLabel('DEV sandbox controls');
		const chatter = page.getByLabel('Chatter', { exact: true });
		const boxes = await Promise.all([controls.boundingBox(), chatter.boundingBox()]);
		if (!boxes[0] || !boxes[1]) throw new Error('Expected Trace controls and Chatter geometry.');
		const [controlBox, chatterBox] = boxes;
		expect(controlBox.x < chatterBox.x + chatterBox.width && controlBox.x + controlBox.width > chatterBox.x && controlBox.y < chatterBox.y + chatterBox.height && controlBox.y + controlBox.height > chatterBox.y).toBe(false);
		await page.keyboard.press('c');
		await expect(chatter).toBeHidden();
		await page.getByLabel('Select DEV scenario').selectOption('chatter-timeline');
		await page.getByRole('button', { name: 'Open selected DEV scenario' }).click();
		await expect(page).toHaveURL(/devWorld=1&devCharacter=001&devScenario=chatter-timeline|devWorld=1&devScenario=chatter-timeline&devCharacter=001/);
	});

	test('runs a local Cooperation and Defection Playground flow with bot settlement and virtual phases', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/?devWorld=1&devScenario=cooperation-defection-playground');
		await expect(page.getByRole('heading', { name: '協力と抜け駆け experimental' })).toBeVisible();
		const panel = page.locator('[data-realtime-panel]');
		await expect(panel).not.toContainText('所持100,000ptによる通常の脱出');
		await expect(panel).not.toContainText('既存のworld conversationで相談できます。');
		await expect(panel).not.toContainText('このラウンドの選択はまだありません');
		await expect(panel).not.toContainText(/cooperation-defection:.*:group:/);
		const next = page.getByRole('button', { name: 'Advance Cooperation and Defection Playground phase' });
		await expect(next).toBeDisabled();
		const group = page.locator('[data-realtime-group-trigger]').first();
		const groupPosition = (await group.getAttribute('data-cell-position'))!.split(',').map(Number);
		for (let index = 0; index < 8; index += 1) {
			const current = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
			if (!current) throw new Error('Expected the DEV self position.');
			const [x, y] = current.split(',').map(Number);
			if (Math.max(Math.abs(x - groupPosition[0]), Math.abs(y - groupPosition[1])) <= 1) break;
			await page.keyboard.press(x > groupPosition[0] ? 'ArrowLeft' : x < groupPosition[0] ? 'ArrowRight' : y > groupPosition[1] ? 'ArrowUp' : 'ArrowDown');
		}
		const nearGroup = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
		expect(nearGroup).not.toBe(`${groupPosition[0]},${groupPosition[1]}`);
		await group.click();
		await expect(next).toBeEnabled();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		await expect(page.locator('[data-realtime-panel]')).not.toContainText('開始まで待ってください。');
		await expect(page.locator('[data-realtime-group-participating="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveAttribute('aria-label', '参加地点に参加済み（参加先）');
		const rules = page.locator('.cooperation-defection-rules-disclosure');
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(panel.locator('[data-cooperation-defection-registration-countdown]')).toBeVisible();
		await rules.locator('summary').click();
		await next.click();
		await expect(panel).toContainText('参加中（3人）');
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(panel.locator('.round-timer')).toBeVisible();
		await rules.locator('summary').click();
		await expect(panel.locator('[data-cooperation-defection-selection-status]')).toHaveCount(0);
		await expect(panel).not.toContainText('既存のworld conversationで相談できます。');
		await next.click();
		await expect(page.getByRole('button', { name: '協力する' })).toBeEnabled();
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(panel.locator('.round-timer')).toBeVisible();
		await expect(panel.locator('[data-cooperation-defection-selection-status]')).toHaveCount(0);
		await page.getByRole('button', { name: '協力する' }).click();
		await expect(page.getByRole('button', { name: '協力する' })).toHaveClass(/selected/);
		await expect(panel.locator('[data-cooperation-defection-selection-status]')).toContainText('秘密選択を送信済み');
		await next.click();
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('+1,000pt');
		await expect(panel.locator('[data-cooperation-defection-selection-status]')).toHaveCount(0);
		await expect(panel).not.toContainText('まだありません');
		const detailsTrigger = page.getByRole('button', { name: '結果の詳細を見る' });
		await detailsTrigger.click();
		const resultDetails = page.getByRole('region', { name: 'ラウンド1の結果の詳細' });
		await expect(resultDetails.locator('h3')).toHaveText('ラウンド 1 · 結果');
		await expect(resultDetails.locator('[data-cooperation-defection-group-verdict]')).toContainText('協力成功');
		await expect(resultDetails.locator('[data-cooperation-defection-personal-score]')).toHaveCount(0);
		await expect(resultDetails.locator('[data-cooperation-defection-breakdown="cooperate"]')).toContainText('+1,000pt');
		await expect(resultDetails.locator('[data-cooperation-defection-breakdown="cooperate"]')).toContainText('協力 3人');
		await expect(resultDetails.locator('[data-cooperation-defection-breakdown="cooperate"] .self-participant')).toContainText('自分');
		await expect(resultDetails.locator('[data-cooperation-defection-breakdown="defect"]')).toContainText('抜け駆け 0人');
		const desktopTextSizes = await page.evaluate(() => ({
			result: Number.parseFloat(getComputedStyle(document.querySelector('[data-cooperation-defection-round-result]')!).fontSize),
			details: Number.parseFloat(getComputedStyle(document.querySelector('.result-details-body')!).fontSize)
		}));
		await page.setViewportSize({ width: 390, height: 844 });
		await page.locator('.sandbox-mobile-toggle').click();
		const mobilePanelAndDetailsFit = await page.evaluate(() => {
			const panelElement = document.querySelector<HTMLElement>('[data-realtime-panel]')!;
			const panel = panelElement.getBoundingClientRect();
			const details = document.querySelector('.result-details')!.getBoundingClientRect();
			const body = document.querySelector<HTMLElement>('.result-details-body')!;
			const mobileTextSizes = {
				result: Number.parseFloat(getComputedStyle(document.querySelector('[data-cooperation-defection-round-result]')!).fontSize),
				details: Number.parseFloat(getComputedStyle(body).fontSize)
			};
			const fits = panel.left >= 0 && panel.right <= innerWidth && details.left >= 0 && details.right <= innerWidth &&
				details.top >= 0 && details.bottom <= innerHeight && panelElement.scrollWidth <= panelElement.clientWidth &&
				body.scrollWidth <= body.clientWidth;
			return { fits, ...mobileTextSizes };
		});
		expect(mobilePanelAndDetailsFit.fits).toBe(true);
		expect(mobilePanelAndDetailsFit.result).toBeLessThan(desktopTextSizes.result);
		expect(mobilePanelAndDetailsFit.details).toBeLessThan(desktopTextSizes.details);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.keyboard.press('Escape');
		await expect(resultDetails).toHaveCount(0);
		await expect(detailsTrigger).toBeFocused();
		await detailsTrigger.click();
		await next.click();
		await expect(resultDetails).toHaveCount(0);
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('前ラウンド');
		await page.getByRole('button', { name: '結果の詳細を見る' }).click();
		await expect(page.getByRole('region', { name: 'ラウンド1の結果の詳細' })).toBeVisible();
		await page.getByRole('button', { name: '結果の詳細を閉じる' }).click();
		await next.click();
		await page.getByRole('button', { name: '協力する' }).click();
		await next.click();
		await next.click();
		await next.click();
		await page.getByRole('button', { name: '協力する' }).click();
		await next.click();
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('+1,000pt');
	});

	for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
		test(`keeps Cooperation and Defection Playground controls and panel separate at ${viewport.width}px`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=cooperation-defection-playground');
			if (viewport.width <= 700) await page.locator('.sandbox-mobile-toggle').click();
			const controls = page.getByLabel('DEV sandbox controls');
			const panel = page.locator('[data-realtime-panel]');
			await expect(controls).toBeVisible();
			await expect(panel).toBeVisible();
			const withinViewport = await panel.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return rect.left >= 0 && rect.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
			});
			expect(withinViewport).toBe(true);
			const boxes = await Promise.all([controls.boundingBox(), panel.boundingBox()]);
			if (!boxes[0] || !boxes[1]) throw new Error('Expected DEV controls and game panel geometry.');
			const [a, b] = boxes;
			expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
			const botPreset = page.getByLabel('Select Cooperation and Defection bot preset');
			await botPreset.selectOption('split');
			await expect(botPreset).toHaveValue('split');
			await expect(page.getByRole('button', { name: 'Advance Cooperation and Defection Playground phase' })).toBeVisible();
		});
	}

	for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
		test(`keeps selection controls clickable over a bubble and preserves bubble text selection at ${viewport.width}px`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.goto('/?devWorld=1&devScenario=cooperation-defection-playground');
			if (viewport.width <= 700) await page.locator('.sandbox-mobile-toggle').click();
			const group = page.locator('[data-realtime-group-trigger]').first();
			const [groupX, groupY] = (await group.getAttribute('data-cell-position'))!.split(',').map(Number);
			for (let index = 0; index < 8; index += 1) {
				const current = (await page.locator('.participant[data-self="true"]').getAttribute('data-position'))!.split(',').map(Number);
				if (Math.max(Math.abs(current[0] - groupX), Math.abs(current[1] - groupY)) <= 1) break;
				await page.keyboard.press(current[0] > groupX ? 'ArrowLeft' : current[0] < groupX ? 'ArrowRight' : current[1] > groupY ? 'ArrowUp' : 'ArrowDown');
			}
			await group.click();
			const advance = page.getByRole('button', { name: 'Advance Cooperation and Defection Playground phase' });
			await advance.click();
			await advance.click();
			const cooperate = page.locator('[data-cooperation-defection-choice="cooperate"]');
			await expect(cooperate).toBeVisible();
			const bubble = await page.evaluateHandle(() => {
				const element = document.createElement('div');
				element.className = 'bubble bubble-normal';
				element.dataset.layoutTestBubble = 'true';
				element.style.cssText = 'position:absolute;width:160px;height:42px;z-index:auto;pointer-events:auto;';
				const content = document.createElement('span');
				content.className = 'bubble-content';
				content.textContent = '選択操作と吹き出しの文字選択';
				content.style.cssText = 'user-select:text;-webkit-user-select:text;';
				element.append(content);
				document.querySelector('.bubble-layer')!.append(element);
				return element;
			});
			await bubble.evaluate((element) => {
				const control = document.querySelector('[data-cooperation-defection-choice="cooperate"]')!.getBoundingClientRect();
				const bubble = element.getBoundingClientRect();
				(element as HTMLElement).style.transform = `translate3d(${control.left + (control.width - bubble.width) / 2}px, ${control.top + (control.height - bubble.height) / 2}px, 0)`;
			});
			const hitTarget = await cooperate.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('[data-cooperation-defection-choice]') === element;
			});
			expect(hitTarget).toBe(true);
			await cooperate.click();
			await expect(cooperate).toHaveClass(/selected/);
			await bubble.evaluate((element) => {
				(element as HTMLElement).style.transform = 'translate3d(20px, 200px, 0)';
			});
			const bubbleIsInteractive = await bubble.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('[data-layout-test-bubble]') === element;
			});
			expect(bubbleIsInteractive).toBe(true);
			const bubbleText = page.locator('[data-layout-test-bubble] .bubble-content');
			await bubbleText.selectText();
			await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('選択操作');
		});
	}

	test('keeps result details keyboard-scrollable, closable, and nonmodal on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1&devScenario=cooperation-defection-playground');
		await page.locator('.sandbox-mobile-toggle').click();
		const rules = page.locator('.cooperation-defection-rules-disclosure');
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(page.locator('[data-cooperation-defection-registration-countdown]')).toBeVisible();
		await rules.locator('summary').click();
		const group = page.locator('[data-realtime-group-trigger]').first();
		const [groupX, groupY] = (await group.getAttribute('data-cell-position'))!.split(',').map(Number);
		for (let index = 0; index < 8; index += 1) {
			const [x, y] = (await page.locator('.participant[data-self="true"]').getAttribute('data-position'))!.split(',').map(Number);
			if (Math.max(Math.abs(x - groupX), Math.abs(y - groupY)) <= 1) break;
			await page.keyboard.press(x > groupX ? 'ArrowLeft' : x < groupX ? 'ArrowRight' : y > groupY ? 'ArrowUp' : 'ArrowDown');
		}
		await group.click();
		const advance = page.getByRole('button', { name: 'Advance Cooperation and Defection Playground phase' });
		await advance.click();
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(page.locator('.round-timer')).toBeVisible();
		await rules.locator('summary').click();
		await advance.click();
		await rules.locator('summary').click();
		await expect(rules).toHaveAttribute('open', '');
		await expect(page.locator('.round-timer')).toBeVisible();
		await page.locator('[data-cooperation-defection-choice="cooperate"]').click();
		await advance.click();
		await page.locator('.sandbox-mobile-toggle').click();
		await page.setViewportSize({ width: 390, height: 320 });
		const trigger = page.getByRole('button', { name: '結果の詳細を見る' });
		await trigger.click();
		const details = page.getByRole('region', { name: 'ラウンド1の結果の詳細' });
		const body = details.getByRole('region', { name: '結果の詳細内容' });
		await expect(details).toBeVisible();
		await details.locator('.self-participant').evaluate((element) => {
			const name = element.firstChild;
			if (name?.nodeType === Node.TEXT_NODE) name.textContent = 'very-long-unbroken-participant-name-that-must-wrap-within-the-scorecard';
		});
		await expect.poll(() => body.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		const scroll = await body.evaluate((element) => ({ client: element.clientHeight, total: element.scrollHeight }));
		expect(scroll.total).toBeGreaterThan(scroll.client);
		await body.focus();
		await body.press('End');
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		const [x] = (await page.locator('.participant[data-self="true"]').getAttribute('data-position'))!.split(',').map(Number);
		await page.keyboard.press(x < 15 ? 'ArrowRight' : 'ArrowLeft');
		await expect.poll(async () => (await page.locator('.participant[data-self="true"]').getAttribute('data-position'))!.split(',')[0]).not.toBe(String(x));
		await page.getByRole('button', { name: '結果の詳細を閉じる' }).click();
		await expect(details).toHaveCount(0);
		await expect(trigger).toBeFocused();
	});
	test('renders the Cooperation and Defection registration and game fixtures without fixed-facility overlap', async ({ page }) => {
		await page.setViewportSize({ width: 360, height: 640 });
		await page.goto('/?devWorld=1&devScenario=cooperation-defection-registration');
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		const registration = await page.locator('[data-realtime-group-id]').evaluateAll((groups) => groups.map((group) => group.getAttribute('data-realtime-group-position')));
		expect(registration.length).toBeGreaterThan(0);
		expect(registration).not.toContain('12,3');
		expect(registration).not.toContain('14,3');
		await expect(page.locator('[data-realtime-group-id] img')).toHaveCount(0);
		await expect(page.locator('[data-realtime-group-id]').first()).toHaveCSS('border-radius', '50%');
		await expect(page.locator('[data-realtime-group-trigger]')).toHaveCount(registration.length);
		await page.getByText('ルールを見る', { exact: true }).click();
		await expect(page.getByRole('dialog')).toContainText('3〜6人 · 全3ラウンド');
		await expect(page.getByRole('dialog')).not.toContainText('所持100,000ptによる通常の脱出');
		await expect(page.getByRole('dialog')).toContainText('相談 30秒 → 選択 30秒 → 結果発表 20秒');
		await expect(page.getByRole('dialog')).toContainText('失敗');
		await page.getByText('ルールを見る', { exact: true }).click();

		await page.goto('/?devWorld=1&devScenario=cooperation-defection-game');
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		await expect(page.locator('[data-cooperation-defection-round-progress]')).toContainText('ラウンド 1 · 選択');
		await expect(page.locator('[data-cooperation-defection-choice="cooperate"]')).toBeDisabled();
		await expect(page.locator('[data-cooperation-defection-choice="defect"]')).toBeDisabled();
		await expect(page.locator('[data-realtime-group-trigger]')).toHaveCount(0);
	});

	test('prioritizes the countdown and keeps the registration HUD readable on desktop and mobile', async ({ page }) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.goto('/?devWorld=1&devScenario=cooperation-defection-registration');
		const deadline = page.locator('[data-cooperation-defection-registration-deadline]');
		const countdown = page.locator('[data-cooperation-defection-registration-countdown]');
		await expect(deadline).toBeVisible();
		const countdownValue = countdown.locator('strong');
		const desktopTimerFont = await countdownValue.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		const desktopDeadlineFont = await deadline.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		expect(desktopTimerFont).toBeGreaterThan(desktopDeadlineFont);
		await page.getByText('ルールを見る', { exact: true }).click();
		const rulesText = page.locator('.cooperation-defection-rules-inline p').first();
		await expect(rulesText).toBeVisible();
		const iconSizes = await page.locator('[data-realtime-panel] .hud-icon svg').evaluateAll((icons) => icons.map((icon) => icon.getBoundingClientRect().width));
		expect(new Set(iconSizes).size).toBe(1);
		const panelBounds = await page.locator('[data-realtime-panel]').boundingBox();
		expect(panelBounds).not.toBeNull();
		expect(panelBounds!.x).toBeGreaterThanOrEqual(0);
		expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(1440);

		await page.setViewportSize({ width: 390, height: 844 });
		await expect(deadline).toBeVisible();
		const mobileTimerFont = await countdownValue.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		const mobileDeadlineFont = await deadline.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
		expect(mobileTimerFont).toBeGreaterThan(mobileDeadlineFont);
		expect(mobileTimerFont).toBeLessThan(desktopTimerFont);
		const mobileBounds = await page.locator('[data-realtime-panel]').boundingBox();
		expect(mobileBounds).not.toBeNull();
		expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
		expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
		expect(await page.locator('[data-realtime-panel]').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
	});

	test('does not open the mending terminal in DEV World', async ({ page }) => {
		await openDevWorld(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
	});

	test('does not paint the default-viewport field scene before measurement and keeps it visible after resize', async ({ page, browser, baseURL }) => {
		const ssrContext = await browser.newContext({
			baseURL,
			javaScriptEnabled: false,
			viewport: { width: 1440, height: 900 }
		});
		try {
			const ssrPage = await ssrContext.newPage();
			await ssrPage.goto('/?devWorld=1', { waitUntil: 'domcontentloaded' });
			const prerenderedScene = ssrPage.locator('.field-scene');
			await expect(prerenderedScene).toHaveCount(1);
			expect(await ssrPage.locator('.field-viewport').evaluate((element) => ({
				ready: element.classList.contains('initial-field-geometry-ready'),
				visibility: getComputedStyle(element.querySelector('.field-scene')!).visibility
			}))).toEqual({ ready: false, visibility: 'hidden' });
			await expect(ssrPage.locator('aside.recent-message-timeline')).toHaveCount(0);
		} finally {
			await ssrContext.close();
		}

		await page.setViewportSize({ width: 2560, height: 1440 });
		await installFieldFrameSampling(page);
		await page.goto('/?devWorld=1');
		await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
		await expect(page.locator('.field-scene')).toBeVisible();
		await expect(page.locator('.field-area')).toHaveCSS('left', '8px');
		await expect(page.locator('.field-area')).toHaveCSS('width', '2544px');
		const startupFrames = await sampleRenderedField(page);
		const visibleFrames = startupFrames.filter((frame) => frame.source === 'frame' && frame.visible);
		expect(visibleFrames.length).toBeGreaterThan(0);
		for (const frame of visibleFrames) {
			expect(frame.scene.width).toBe(1216);
			expect(frame.scene.height).toBe(608);
			expect(Number.isFinite(frame.scene.x)).toBe(true);
			expect(Number.isFinite(frame.scene.y)).toBe(true);
		}

		for (const viewport of [
			{ width: 2000, height: 1440, worldWidth: 1216, worldHeight: 608 },
			{ width: 2000, height: 1200, worldWidth: 1216, worldHeight: 608 },
			{ width: 700, height: 900, worldWidth: 800, worldHeight: 400 },
			{ width: 701, height: 900, worldWidth: 1216, worldHeight: 608 }
		]) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await expect.poll(() => page.locator('.field-scene').evaluate((element) => {
				const { width, height } = element.getBoundingClientRect();
				return { width, height };
			})).toEqual({ width: viewport.worldWidth, height: viewport.worldHeight });
			await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
		}
		const resizeFrames = (await sampleRenderedField(page)).slice(startupFrames.length);
		expect(resizeFrames.length).toBeGreaterThan(0);
		expect(resizeFrames.every((frame) => frame.visible)).toBe(true);
	});

	test('switches the self character through the sandbox selector', async ({ page }) => {
		await openDevWorld(page);

		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.selectOption('005');
		await expect(characterSelect).toHaveValue('005');

		const selectedLabel = (await characterSelect.locator('option:checked').textContent())?.trim() ?? '';
		const selectedName = selectedLabel.split(' — ')[1];
		expect(selectedName).toBeTruthy();

		const self = page.locator('.participant').first();
		await expect(self.locator('img')).toHaveAttribute('src', /characters\/005\.webp$/);
		await expect(self.locator('.participant-name')).toHaveText(selectedName ?? '');
	});
});
