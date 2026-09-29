import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { openDevWorld, openClockedDevWorld, openDevTraceWorld, fieldOwnedBlankPoint, profileTrigger, profileDialog } from './helpers/devWorldHarness';

test.describe('DEV World Sandbox', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
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

		await openDevTraceWorld(page, 'trace-markers');
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
		await openDevTraceWorld(page, 'trace-markers');
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
		for (const viewport of [{ width: 1100, height: 850 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await openDevTraceWorld(page, 'trace-markers');
			await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
			await page.locator('[data-cell-position="8,4"]').click();
			await expect(page.getByRole('menu', { name: 'Cell actions' })).toHaveCount(0);

			const start = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
			await page.mouse.move(start.x, start.y);
			await page.mouse.down();
			await page.mouse.move(start.x + 24, start.y);
			await page.mouse.up();
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '8,3');
			const colocatedMarker = page.locator('[data-trace-marker-position="8,3"]');
			await expect(colocatedMarker).toBeVisible();
			const stacking = await page.evaluate(() => ({
				markerLayer: Number.parseInt(getComputedStyle(document.querySelector('.trace-marker-layer')!).zIndex, 10),
				participant: Number.parseInt(getComputedStyle(document.querySelector('.participant[data-self="true"]')!).zIndex, 10),
				markerPointerEvents: getComputedStyle(document.querySelector('[data-trace-marker-position="8,3"]')!).pointerEvents
			}));
			expect(stacking.markerLayer).toBeGreaterThan(stacking.participant);
			expect(stacking.markerPointerEvents).toBe('none');

			await profileTrigger(page, '女の子').click();
			const menu = page.getByRole('menu', { name: 'Cell actions' });
			await expect(menu.getByRole('menuitem')).toHaveCount(2);
			await expect(menu.locator('[data-cell-action="movement"]')).toHaveCount(0);
			const participantAction = menu.locator('[data-cell-action="participant"]');
			const traceAction = menu.locator('[data-cell-action="trace"]');
			await expect(participantAction).toHaveCount(1);
			await expect(traceAction).toHaveCount(1);
			const menuBox = await menu.boundingBox();
			const participantBox = await participantAction.boundingBox();
			const traceBox = await traceAction.boundingBox();
			expect(menuBox && participantBox && traceBox).toBeTruthy();
			if (menuBox && participantBox && traceBox) {
				expect(participantBox.width).toBeCloseTo(menuBox.width, 1);
				expect(traceBox.width).toBeCloseTo(menuBox.width, 1);
				expect(Math.abs(traceBox.y - participantBox.y - participantBox.height)).toBeLessThan(1);
			}
			await page.mouse.click(participantBox!.x + participantBox!.width - 3, participantBox!.y + participantBox!.height / 2);
			await expect(profileDialog(page)).toBeVisible();
			await page.keyboard.press('Escape');
			await expect(profileDialog(page)).toBeHidden();
			await profileTrigger(page, '女の子').click();
			const outsideMenu = page.getByRole('menu', { name: 'Cell actions' });
			await expect(outsideMenu).toBeVisible();
			const outside = await fieldOwnedBlankPoint(page, { x: 5, y: 5 });
			await page.mouse.click(outside.x, outside.y);
			await expect(outsideMenu).toBeHidden();
			await profileTrigger(page, '女の子').click();
			await page.getByRole('menu', { name: 'Cell actions' }).locator('[data-cell-action="trace"]').click();
			await expect(page.locator('[data-trace-root-id="' + '4'.repeat(64) + '"]')).toContainText('newest root');
		}
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
});
