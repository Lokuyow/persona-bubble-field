import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevWorld, readCharacterGeometry, dragJoystick, expectNoConsoleProblems } from './helpers/devWorldHarness';

async function waitForInitialFieldGeometry(page: Page): Promise<void> {
	await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
}

test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test.describe('responsive field presentation', () => {
		for (const viewport of [
			{ name: 'mobile', width: 390, height: 844, sideMargin: '8px', fieldWidth: '374px', cell: '50px', avatar: '46px', worldWidth: '800px', worldHeight: '400px' },
			{ name: 'desktop', width: 1200, height: 900, sideMargin: '8px', fieldWidth: '1184px', cell: '76px', avatar: '72px', worldWidth: '1216px', worldHeight: '608px' }
		]) {
			test(`${viewport.name} uses the responsive cell and centered avatar`, async ({ page }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				await expectNoConsoleProblems(page, async () => {
					await openDevWorld(page);
					const scene = page.locator('.field-scene');
					const fieldArea = page.locator('.field-area');
					await expect(scene).toHaveCSS('width', viewport.worldWidth);
					await expect(scene).toHaveCSS('height', viewport.worldHeight);
					await expect(fieldArea).toHaveCSS('left', viewport.sideMargin);
					await expect(fieldArea).toHaveCSS('width', viewport.fieldWidth);

						const geometry = await readCharacterGeometry(page);
						expect(geometry.cellWidth).toBe(viewport.cell);
					expect(geometry.cellHeight).toBe(viewport.cell);
					expect(geometry.avatarWidth).toBe(viewport.avatar);
					expect(geometry.avatarHeight).toBe(viewport.avatar);
					expect(Math.abs(geometry.avatarCenter.x - geometry.participantCenter.x)).toBeLessThan(0.5);
					expect(Math.abs(geometry.avatarCenter.y - geometry.participantCenter.y)).toBeLessThan(0.5);
					expect(Math.abs(geometry.participantCenter.x - geometry.gridCellCenter.x)).toBeLessThan(0.01);
					expect(Math.abs(geometry.participantCenter.y - geometry.gridCellCenter.y)).toBeLessThan(0.01);
					await expect(page.locator('.participant-name')).toBeVisible();
					await expect(fieldArea).toHaveCSS('overflow', 'hidden');
					await expect(page.locator('.participant')).not.toHaveAttribute('data-movement-animation', 'active');
				});
			});
		}
	});

	test('keeps the centered character and camera follow after movement', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await expectNoConsoleProblems(page, async () => {
			await openDevWorld(page);
			const self = page.locator('.participant').first();
			const scene = page.locator('.field-scene');
			const before = await readCharacterGeometry(page);
			const beforeTransform = await scene.evaluate((element) => getComputedStyle(element).transform);

			const beforeLogicalStyle = await self.evaluate((element) => ({
				left: (element as HTMLElement).style.left,
				top: (element as HTMLElement).style.top
			}));
			await dragJoystick(page, { x: 24, y: -24 });
			await expect(self).toHaveAttribute('data-position', '8,2');
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
			const after = await readCharacterGeometry(page);
			const afterTransform = await scene.evaluate((element) => getComputedStyle(element).transform);
			const afterLogicalStyle = await self.evaluate((element) => ({
				left: (element as HTMLElement).style.left,
				top: (element as HTMLElement).style.top
			}));

			expect(afterTransform).not.toBe(beforeTransform);
			expect(afterLogicalStyle.left).not.toBe(beforeLogicalStyle.left);
			expect(afterLogicalStyle.top).not.toBe(beforeLogicalStyle.top);
			expect(Math.abs(after.avatarCenter.x - page.viewportSize()!.width / 2)).toBeLessThan(0.5);
			expect(Math.abs(after.avatarCenter.x - after.participantCenter.x)).toBeLessThan(0.5);
			expect(after.avatarWidth).toBe('46px');
			expect(after.avatarHeight).toBe('46px');
			expect(before.participantCenter.y).not.toBe(after.participantCenter.y);
		});
	});

	test('disables movement animation when reduced motion is preferred', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await dragJoystick(page, { x: 24, y: 0 });
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
	});

	test('controls live speech sound preferences without starting field movement', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await waitForInitialFieldGeometry(page);
		const speaker = page.getByRole('button', { name: /Open sound settings/ });
		await expect(speaker).toBeVisible();
		const speakerChrome = await speaker.evaluate((element) => {
			const style = getComputedStyle(element);
			return { border: style.border, background: style.backgroundColor, boxShadow: style.boxShadow, backdropFilter: style.backdropFilter };
		});
		expect(speakerChrome.border).toBe('1px solid rgb(154, 169, 193)');
		expect(speakerChrome.background).toBe('rgb(32, 42, 64)');
		expect(speakerChrome.boxShadow).toBe('none');
		expect(speakerChrome.backdropFilter).toBe('none');
		await expect(page.locator('[data-sound-icon="volume-2"]')).toBeVisible();
		const speakerBox = await speaker.boundingBox();
		const iconBox = await page.locator('[data-sound-icon]').boundingBox();
		expect(speakerBox && iconBox).toBeTruthy();
		if (speakerBox && iconBox) {
			expect(speakerBox.width).toBeGreaterThanOrEqual(44);
			expect(speakerBox.height).toBeGreaterThanOrEqual(44);
			expect(Math.abs((iconBox.x + iconBox.width / 2) - (speakerBox.x + speakerBox.width / 2))).toBeLessThan(1);
			expect(Math.abs((iconBox.y + iconBox.height / 2) - (speakerBox.y + speakerBox.height / 2))).toBeLessThan(1);
			expect(iconBox.width).toBeGreaterThanOrEqual(24);
			expect(iconBox.height).toBeGreaterThanOrEqual(24);
		}
		await speaker.click();
		const panel = page.locator('.sound-panel');
		await expect(panel).toBeVisible();
		await expect(panel.getByText('Volume', { exact: true })).toHaveCount(0);
		await expect(panel.getByRole('slider', { name: 'Sound volume' })).toBeVisible();
		await page.getByLabel('DEV sandbox controls').click({ position: { x: 5, y: 5 } });
		await expect(panel).toBeHidden();
		await speaker.click();
		await expect(panel).toBeVisible();
		const controlsBox = await page.getByLabel('DEV sandbox controls').boundingBox();
		expect(controlsBox).toBeTruthy();
		const hasTouch = await page.evaluate(() => 'ontouchstart' in window);
		if (hasTouch && controlsBox) {
			await page.touchscreen.tap(controlsBox.x + 5, controlsBox.y + 5);
			await expect(panel).toBeHidden();
			await speaker.click();
			await expect(panel).toBeVisible();
		}
		const self = page.locator('.participant[data-self="true"]');
		const positionBeforeSliderDrag = await self.getAttribute('data-position');
		const slider = page.getByRole('slider', { name: 'Sound volume' });
		const sliderBox = await slider.boundingBox();
		expect(sliderBox).toBeTruthy();
		if (sliderBox) {
			const y = sliderBox.y + sliderBox.height / 2;
			await page.mouse.move(sliderBox.x + sliderBox.width * 0.85, y);
			await page.mouse.down();
			await page.mouse.move(sliderBox.x + sliderBox.width * 0.25, y, { steps: 6 });
			await page.mouse.up();
		}
		await expect.poll(async () => Number(await slider.inputValue())).toBeGreaterThan(0);
		await expect(self).toHaveAttribute('data-position', positionBeforeSliderDrag ?? '');
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await expect(panel).toBeVisible();
		await expect(page.getByRole('button', { name: 'Mute sound' })).toHaveCount(0);
		await slider.fill('25');
		await expect(page.locator('[data-sound-icon="volume-4"]')).toBeVisible();
		await expect(panel).toBeVisible();
		await slider.fill('34');
		await expect(page.locator('[data-sound-icon="volume-2"]')).toBeVisible();
		await slider.fill('67');
		await expect(page.locator('[data-sound-icon="volume"]')).toBeVisible();
		await slider.fill('0');
		await expect(page.locator('[data-sound-icon="volume-off"]')).toBeVisible();
		await expect(page.getByRole('button', { name: 'Open sound settings (muted)' })).toBeVisible();
		await slider.fill('25');
		await expect(page.getByRole('button', { name: 'Open sound settings' })).toBeVisible();
		const viewport = await page.locator('.field-viewport').boundingBox();
		const control = await speaker.boundingBox();
		expect(viewport && control).toBeTruthy();
		if (viewport && control) {
			expect(control.x + control.width).toBeLessThanOrEqual(viewport.x + viewport.width);
			expect(control.y).toBeGreaterThanOrEqual(viewport.y);
		}
		await page.reload();
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await waitForInitialFieldGeometry(page);
		await page.getByRole('button', { name: /Open sound settings/ }).click();
		await expect(page.getByRole('slider', { name: 'Sound volume' })).toHaveValue('25');
		await expect(page.getByRole('button', { name: 'Mute sound' })).toHaveCount(0);
		await page.getByRole('slider', { name: 'Sound volume' }).fill('0');
		await expect(page.getByRole('button', { name: 'Open sound settings (muted)' })).toBeVisible();
		await page.reload();
		await waitForInitialFieldGeometry(page);
		await page.getByRole('button', { name: /Open sound settings/ }).click();
		await expect(page.getByRole('slider', { name: 'Sound volume' })).toHaveValue('0');
	});

	test('keeps the speaker control usable on desktop', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await page.goto('/?devWorld=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await waitForInitialFieldGeometry(page);
		const speaker = page.getByRole('button', { name: /Open sound settings/ });
		await speaker.click();
		await expect(page.locator('.sound-panel')).toBeVisible();
		const viewport = await page.locator('.field-viewport').boundingBox();
		const panel = await page.locator('.sound-panel').boundingBox();
		expect(viewport && panel).toBeTruthy();
		if (viewport && panel) {
			expect(panel.x).toBeGreaterThanOrEqual(viewport.x);
			expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.x + viewport.width);
		}
	});

	test('injects DEV live speech through the production live bubble path', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.locator('.sandbox-mobile-toggle').click();
		await expect(page.locator('.sandbox-mobile-toggle-wrapper')).toHaveAttribute('open', '');
		await expect(page.getByLabel('DEV speech sound injector')).toBeVisible();
		const self = page.locator('.participant[data-self="true"]');
		const positionBefore = await self.getAttribute('data-position');
		for (const [label, speechType] of [['Normal', 'normal'], ['Shout', 'shout'], ['Monologue', 'monologue']] as const) {
			await page.locator('.sandbox-speech-injector button').nth(label === 'Normal' ? 0 : label === 'Shout' ? 1 : 2).click();
			await expect(page.locator(`.bubble-normal[data-speech-type="${speechType}"]`)).toBeVisible();
		}
		await page.locator('.sandbox-speech-injector button').first().click();
		await expect(page.locator('.bubble-normal[data-speech-type="normal"]')).toContainText('Sound test: normal #4');
		expect(await self.getAttribute('data-position')).toBe(positionBefore);
	});
});
