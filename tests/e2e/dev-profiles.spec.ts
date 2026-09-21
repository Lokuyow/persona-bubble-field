import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevWorld, openClockedDevWorld, profileTrigger, profileDialog, expectProfile, openProfile, profileTriggerCenter } from './helpers/devWorldHarness';


test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('opens a profile by pointer, restores it through history, and resumes movement after Back', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await openProfile(page, '女の子');
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});

		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '7,3');

		await page.goBack();
		await expect(profileDialog(page)).toBeHidden();
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		await page.goForward();
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});

		await page.goBack();
		await expect(profileDialog(page)).toBeHidden();
		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', '8,3');
		await openProfile(page, '女の子');
		await expectProfile(page, {
			name: '女の子',
			picture: '001.webp',
			about: '知らない場所でも、わりと平気そう。'
		});
	});

	test('stops a held Arrow when a profile dialog opens', async ({ page }) => {
		await openClockedDevWorld(page);

		const self = page.locator('.participant').first();
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await profileTrigger(page, '女の子').click();
		await expect(profileDialog(page)).toBeVisible();
		const positionWhenOpened = await self.getAttribute('data-position');
		await page.clock.runFor(1_000);
		await page.keyboard.up('ArrowRight');
		await expect(self).toHaveAttribute('data-position', positionWhenOpened ?? '');
	});

	test('opens a profile by keyboard', async ({ page }) => {
		await openDevWorld(page);

		await profileTrigger(page, '女の子').focus();
		await page.keyboard.press('Enter');
		await expect(profileDialog(page)).toBeVisible();
	});

	test('does not add a body pointer lock while a profile is open', async ({ page }) => {
		await openDevWorld(page);
		await openProfile(page, '女の子');

		expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).toBe('auto');
	});

	for (const closePath of ['close button', 'Escape', 'outside interaction'] as const) {
		test(`keeps profile history aligned and immediately reopens after ${closePath}`, async ({ page }) => {
			await openDevWorld(page);
			const self = page.locator('.participant').first();
			const triggerCenter = await profileTriggerCenter(page, '女の子');
			await openProfile(page, '女の子');

			if (closePath === 'close button') {
				await profileDialog(page).getByRole('button', { name: '閉じる' }).click();
			} else if (closePath === 'Escape') {
				await page.keyboard.press('Escape');
			} else {
				await page.locator('.profile-dialog-overlay').click({ position: { x: 4, y: 4 } });
			}

			await expect(profileDialog(page)).toBeHidden();
			await expect(profileTrigger(page, '女の子')).toBeFocused();
			await page.mouse.click(triggerCenter.x, triggerCenter.y);
			await expectProfile(page, {
				name: '女の子',
				picture: '001.webp',
				about: '知らない場所でも、わりと平気そう。'
			});
			if (closePath === 'close button') {
				await profileDialog(page).getByRole('button', { name: '閉じる' }).click();
				await expect(profileDialog(page)).toBeHidden();
				await page.mouse.click(triggerCenter.x, triggerCenter.y);
				await expect(profileDialog(page)).toBeVisible();
			}
			await page.goBack();
			await expect(profileDialog(page)).toBeHidden();
			await page.goForward();
			await expect(profileDialog(page)).toBeVisible();
			await page.goBack();
			await expect(profileDialog(page)).toBeHidden();
			await page.keyboard.press('ArrowRight');
			await expect(self).toHaveAttribute('data-position', '8,3');
		});
	}

	test('uses an Avatar fallback when a character image fails to load', async ({ page }) => {
		await page.route('**/characters/001.webp', (route) => route.fulfill({ status: 404 }));
		await openDevWorld(page);

		const trigger = profileTrigger(page, '女の子');
		await expect(trigger.locator('.avatar')).toHaveText('女');
		await trigger.click();
		await expect(profileDialog(page).locator('.profile-dialog-avatar')).toHaveText('女');
	});

	test('keeps a long profile usable on a mobile viewport', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 360 });
		await page.goto('/?devWorld=1&devCharacter=002');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await openProfile(page, '全裸中年男性');

		const dialog = profileDialog(page);
		const viewport = dialog.locator('.profile-dialog-scroll-viewport');
		await expect(viewport).toBeVisible();
		const scrollState = await viewport.evaluate((element) => ({
			scrollable: element.scrollHeight > element.clientHeight,
			initialTop: element.scrollTop
		}));
		expect(scrollState.scrollable).toBe(true);
		expect(scrollState.initialTop).toBe(0);
		await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
		expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

		const closeButton = dialog.getByRole('button', { name: '閉じる' });
		await expect(closeButton).toBeInViewport({ ratio: 1 });
		const closeBox = await closeButton.boundingBox();
		const viewportSize = page.viewportSize();
		expect(closeBox).not.toBeNull();
		expect(viewportSize).not.toBeNull();
		expect(closeBox!.x).toBeGreaterThanOrEqual(0);
		expect(closeBox!.y).toBeGreaterThanOrEqual(0);
		expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(viewportSize!.width);
		expect(closeBox!.y + closeBox!.height).toBeLessThanOrEqual(viewportSize!.height);
		await closeButton.click();
		await expect(dialog).toBeHidden();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});
});
