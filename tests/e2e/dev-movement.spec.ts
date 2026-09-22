import { expect, test, type Locator, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, sampleRenderedField } from './helpers/fieldFrames';
import { openDevWorld, openClockedDevWorld, fieldOwnedBlankPoint, viewportExternalPoint, chatterNonInteractivePoint, speechMovementPoint, dragJoystick, profileTrigger, profileDialog } from './helpers/devWorldHarness';


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
		await page.goto('/?devWorld=1&devScenario=trace-replies');
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

	test('accepts the touch PointerEvent path without changing the movement API', async ({ page }) => {
		await openDevWorld(page);
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.locator('.field-area').evaluate((node, point) => {
			const init = { bubbles: true, pointerId: 17, pointerType: 'touch', isPrimary: true, button: 0 } as const;
			node.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: point.x, clientY: point.y }));
			node.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: point.x + 24, clientY: point.y }));
			node.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: point.x + 24, clientY: point.y }));
		}, start);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(page.locator('[data-pointer-joystick]')).toHaveCount(0);
	});

	test('starts mouse movement from field-owned selectable targets without activating them', async ({ page }) => {
		await openDevWorld(page);
		const participant = page.locator('.participant-profile-trigger').first();
		const participantBox = await participant.boundingBox();
		if (!participantBox) throw new Error('Expected the participant profile trigger to be visible.');
		await page.mouse.move(participantBox.x + participantBox.width / 2, participantBox.y + participantBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(participantBox.x + participantBox.width / 2 + 24, participantBox.y + participantBox.height / 2);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await page.mouse.up();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(profileDialog(page)).toBeHidden();

		await page.goto('/?devWorld=1&devScenario=trace-markers');
		const cellTrigger = page.locator('[data-cell-position="8,4"]');
		const cellBox = await cellTrigger.boundingBox();
		if (!cellBox) throw new Error('Expected the trace cell selection trigger to be visible.');
		await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(cellBox.x + cellBox.width / 2 + 24, cellBox.y + cellBox.height / 2);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await page.mouse.up();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toBeHidden();
	});

	test('starts mouse movement from the investigated root author ghost', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		const traceCell = page.locator('[data-cell-position="8,4"]');
		await expect(traceCell).toHaveAttribute('aria-label', '痕跡を調べる');
		await traceCell.click();
		const ghost = page.locator('.trace-ghost-profile-trigger');
		await expect(ghost).toBeVisible();
		const box = await ghost.boundingBox();
		if (!box) throw new Error('Expected the trace ghost profile trigger to be visible.');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2);
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await page.mouse.up();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(profileDialog(page)).toBeHidden();
	});

	test('moves from a field-owned button through a real touch pointer sequence', async ({ page }) => {
		await openDevWorld(page);
		const trigger = page.locator('.participant-profile-trigger').first();
		const box = await trigger.boundingBox();
		if (!box) throw new Error('Expected the participant profile trigger to be visible.');
		const client = await page.context().newCDPSession(page);
		await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
		await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 24, y, id: 1 }] });
		await expect(page.locator('[data-pointer-joystick="right"]')).toBeVisible();
		await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
		await expect(profileDialog(page)).toBeHidden();
	});

	test('keeps tap selection separate from pointer movement and preserves participant trace menus', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=trace-markers');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await page.locator('[data-cell-position="8,4"]').click();
		await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);

		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 24, start.y);
		await page.mouse.up();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');

		await profileTrigger(page, '女の子').click();
		const menu = page.getByRole('menu', { name: 'Cell actions' });
		await expect(menu.getByRole('menuitem')).toHaveCount(2);
		await expect(menu.locator('[data-cell-action="movement"]')).toHaveCount(0);
		await expect(menu.locator('[data-cell-action="participant"]')).toHaveCount(1);
		await expect(menu.locator('[data-cell-action="trace"]')).toHaveCount(1);
	});

	test('does not render a field-external cell at the field edge', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		for (let index = 0; index < 7; index += 1) await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '0,3');
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x - 24, start.y);
		await expect(page.locator('[data-pointer-joystick="left"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '0,3');
		await page.mouse.up();
	});

	test('does not move into an occupied cell through the pointer joystick', async ({ page }) => {
		await page.goto('/?devWorld=1&devScenario=speech-showcase');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();

		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up"]')).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '7,3');
		await page.mouse.up();
	});

	test('keeps keyboard ownership during a pending pointer tap and safely takes over on drag', async ({ page }) => {
		await openClockedDevWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		await page.keyboard.down('ArrowRight');
		await page.clock.runFor(50);
		await expect(self).toHaveAttribute('data-position', '8,3');

		const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,3');
		await page.mouse.move(start.x, start.y - 24);
		await expect(page.locator('[data-pointer-joystick="up"]')).toBeVisible();
		await expect(self).toHaveAttribute('data-position', '9,2');
		await page.clock.runFor(500);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.mouse.up();
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', '9,1');
		await page.keyboard.up('ArrowRight');
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', '8,1');
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
