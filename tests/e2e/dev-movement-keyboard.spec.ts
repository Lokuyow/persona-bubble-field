import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { openDevWorld, openClockedDevWorld } from './helpers/devWorldHarness';

test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('continues one-cell movement on an explicit keyboard hold and stops on keyup', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
	});

	test('moves with a representative physical WASD key', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.press('d');
		await expect(self).toHaveAttribute('data-position', '8,3');
	});

	test('deduplicates logical directions and cleans up a neutral hold on native input focus', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant').first();

		await page.keyboard.down('w');
		await page.keyboard.down('ArrowUp');
		await page.keyboard.down('s');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '7,3');

		await page.getByLabel('Select sandbox character').focus();
		await page.keyboard.up('s');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '7,3');
		await page.keyboard.up('ArrowUp');
		await page.keyboard.up('w');
	});

	test('does not leave a held movement running after window blur', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
	});

	test('does not leave a held movement running after the page becomes hidden', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
	});

	test('does not turn browser repeat events into direct movement requests', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.evaluate(() => {
			for (let index = 0; index < 10; index += 1) {
				window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
			}
		});
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.keyboard.up('ArrowRight');
	});

	test('preserves native Arrow behavior for the DEV character select', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.focus();
		await page.keyboard.press('ArrowDown');
		await expect(characterSelect).toHaveValue('002');
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('preserves native input behavior for WASD and N in the DEV character select', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		const characterSelect = page.getByLabel('Select sandbox character');
		await characterSelect.focus();
		const before = await characterSelect.inputValue();
		for (const key of ['w', 'a', 's', 'd', 'n']) await page.keyboard.press(key);
		await expect(characterSelect).toHaveValue(before);
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test('does not intercept WASD or N during composition or with modifiers', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.press('Shift+d');
		await page.keyboard.press('Control+a');
		await page.keyboard.press('Alt+s');
		await page.keyboard.press('Meta+w');
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'd', code: 'KeyD', isComposing: true, bubbles: true
		})));
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'n', code: 'KeyN', isComposing: true, bubbles: true
		})));
		await expect(self).toHaveAttribute('data-position', '7,3');
	});
});
