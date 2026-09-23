import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { openDevWorld, openClockedDevWorld, openDevTraceWorld, fieldOwnedBlankPoint, viewportExternalPoint, chatterNonInteractivePoint, speechMovementPoint, dragJoystick } from './helpers/devWorldHarness';

test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('uses a floating pointer joystick for mouse drag movement and removes cell movement affordances', async ({ page }) => {
		await openClockedDevWorld(page);
		await expect(page.locator('.field-movement-layer, .movement-cell, .movement-cell-chevron')).toHaveCount(0);

		const self = page.locator('.participant').first();
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 8, start.y);
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await page.mouse.move(start.x + 24, start.y);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
		await page.mouse.up();
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '10,3');
	});

	test('starts movement from viewport space outside the field area while keeping external taps inert', async ({ page }) => {
		await openDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const start = await viewportExternalPoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,3');
		await page.mouse.up();
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);

		await page.mouse.click(start.x, start.y);
		await expect(self).toHaveAttribute('data-position', '8,3');
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);
	});

	test('starts movement from noninteractive Chatter space', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=chatter-timeline');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.keyboard.press('c');
		await expect(page.locator('aside[aria-label="Chatter"]')).toBeVisible();
		const start = await chatterNonInteractivePoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x - 24, start.y);
		await expect(page.locator('[data-pointer-joystick="left"]')).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '6,3');
		await page.mouse.up();
	});

	test('starts movement from movement-capable speech presentation space', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=speech-comparison');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		const start = await speechMovementPoint(page);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await page.mouse.up();
	});

	test('does not start movement from the ActionDock', async ({ page }) => {
		await openDevTraceWorld(page, 'trace-replies');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.action-dock')).toBeVisible();
		const self = page.locator('.participant[data-self="true"]');
		const composer = page.locator('.action-dock');
		const box = await composer.boundingBox();
		if (!box) throw new Error('Expected the ActionDock to be visible.');
		const start = { x: box.x + box.width / 2, y: box.y + Math.min(20, box.height / 2) };
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
		await expect(self).toHaveAttribute('data-position', '7,3');
		await page.mouse.up();
	});

	test('moves one representative cardinal direction through the pointer path', async ({ page }) => {
		await openDevWorld(page);
		await dragJoystick(page, { x: 24, y: 0 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
	});

	test('moves one representative diagonal direction through the pointer path', async ({ page }) => {
		await openDevWorld(page);
		await dragJoystick(page, { x: 24, y: -24 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,2');
	});

	test('continues diagonal pointer movement at the shared 500ms cadence', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up-right"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '8,2');
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.mouse.up();
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '9,1');
	});
});
