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
		await page.goto('/?devWorld=1&devScenario=cooperation-defection-playground');
		await expect(page.getByRole('heading', { name: '協力と抜け駆け experimental' })).toBeVisible();
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
		await expect(page.locator('[data-realtime-panel]')).toContainText('開始まで待ってください。');
		await expect(page.locator('[data-realtime-group-participating="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-group-trigger][aria-pressed="true"]')).toHaveAttribute('aria-label', '参加地点に参加済み（参加先）');
		await next.click();
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 3');
		await next.click();
		await expect(page.getByRole('button', { name: '協力する' })).toBeEnabled();
		await page.getByRole('button', { name: '協力する' }).click();
		await expect(page.getByRole('button', { name: '協力する' })).toHaveClass(/selected/);
		await expect(page.locator('[data-cooperation-defection-selection-status]')).not.toContainText('まだありません');
		await next.click();
		await expect(page.locator('[data-cooperation-defection-round-result]')).toContainText('+1,000pt');
		await next.click();
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
			const boxes = await Promise.all([controls.boundingBox(), panel.boundingBox()]);
			if (!boxes[0] || !boxes[1]) throw new Error('Expected DEV controls and game panel geometry.');
			const [a, b] = boxes;
			expect(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y).toBe(false);
			await expect(page.getByRole('button', { name: 'Advance Cooperation and Defection Playground phase' })).toBeVisible();
		});
	}
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
		await expect(page.getByRole('dialog')).toContainText('1グループ3〜6人、全3ラウンドです。');
		await expect(page.getByRole('dialog')).toContainText('相談 30秒 → 選択 30秒 → 結果発表 20秒');
		await expect(page.getByRole('dialog')).toContainText('協力失敗');
		await page.getByText('ルールを見る', { exact: true }).click();

		await page.goto('/?devWorld=1&devScenario=cooperation-defection-game');
		await expect(page.locator('[data-realtime-panel]')).toBeVisible();
		await expect(page.locator('[data-realtime-panel]')).toContainText('選択内容は結果発表まで秘密です');
		await expect(page.locator('[data-cooperation-defection-choice="cooperate"]')).toBeDisabled();
		await expect(page.locator('[data-cooperation-defection-choice="defect"]')).toBeDisabled();
		await expect(page.locator('[data-realtime-group-trigger]')).toHaveCount(0);
	});

	test('does not open the mending terminal in DEV World', async ({ page }) => {
		await openDevWorld(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.lifespan-hud')).toHaveCount(0);
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
