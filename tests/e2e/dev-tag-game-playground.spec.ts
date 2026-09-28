import { expect, test } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { dragJoystick } from './helpers/devWorldHarness';

test.describe('DEV Tag Game Playground', () => {
	test.beforeEach(async ({ page }) => {
		await installHostOwnedStub(page);
	});

	test('runs the local recruitment, touch, schedule, settlement, and reset flow without Relay sockets', async ({ page }) => {
		const sockets: string[] = [];
		page.on('websocket', (socket) => sockets.push(socket.url()));
		await page.setViewportSize({ width: 1365, height: 900 });
		await page.goto('/?devWorld=1&devScenario=tag-game-playground&devCharacter=020');
		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(3);
		await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
		await expect(page.getByLabel('Select sandbox character')).toHaveValue('020');
		const selectedCharacterSrc = await page.locator('.participant[data-self="true"] .avatar img').getAttribute('src');
		expect(selectedCharacterSrc).toBeTruthy();

		const self = page.locator('.participant[data-self="true"]');
		const beforeKeyboard = await self.getAttribute('data-position');
		await page.keyboard.press('ArrowRight');
		await expect(self).not.toHaveAttribute('data-position', beforeKeyboard ?? '');
		const beforePointer = await self.getAttribute('data-position');
		await dragJoystick(page, { x: -24, y: 0 });
		await expect(self).not.toHaveAttribute('data-position', beforePointer ?? '');

		await page.getByRole('button', { name: 'Open DEV tag-game panel' }).click();
		const panel = page.getByRole('dialog', { name: '鬼ごっこ' });
		await expect(panel).toBeVisible();
		await panel.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await expect(panel).toContainText('参加者 1 / 8人');
		await expect(panel.locator('.host-identity img')).toHaveAttribute('src', selectedCharacterSrc!);
		await expect(panel.getByRole('button', { name: '開始を提案' })).toBeDisabled();
		await panel.getByRole('button', { name: 'BOTを参加させる' }).click();
		await expect(panel).toContainText('参加者 3 / 8人');
		await panel.getByRole('button', { name: '開始を提案' }).click();
		await expect(panel).toContainText('開始確認中');
		await panel.getByRole('button', { name: 'BOTが開始に同意' }).click();
		await expect(panel).toContainText('開始準備中');
		await panel.getByRole('button', { name: '閉じる' }).click();
		await page.getByRole('button', { name: 'Advance tag-game time 5 seconds' }).click();
		const hud = page.locator('[data-tag-game-hud]');
		await expect(hud).toBeVisible();
		await expect(hud.locator('[data-tag-game-remaining]')).toBeVisible();
		const effectDisplay = hud.locator('[data-tag-game-effect]');
		const effectBefore = await effectDisplay.getAttribute('data-tag-game-effect');
		await page.getByRole('button', { name: 'Advance to next tag-game effect' }).click();
		await expect(effectDisplay).not.toHaveAttribute('data-tag-game-effect', effectBefore ?? '');

		const selfPosition = (await self.getAttribute('data-position'))!.split(',').map(Number);
		const botASelect = page.getByLabel('Set BOT A position');
		const optionValues = await botASelect.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
		const directions = [
			{ dx: 1, dy: 0, self: 'ArrowRight', bot: 'left' }, { dx: -1, dy: 0, self: 'ArrowLeft', bot: 'right' },
			{ dx: 0, dy: 1, self: 'ArrowDown', bot: 'up' }, { dx: 0, dy: -1, self: 'ArrowUp', bot: 'down' }
		];
		const adjacent = directions.find((direction) => optionValues.includes(`${selfPosition[0] + direction.dx},${selfPosition[1] + direction.dy}`));
		if (!adjacent) throw new Error('Expected a valid neighboring field cell for BOT A.');
		await botASelect.selectOption(`${selfPosition[0] + adjacent.dx},${selfPosition[1] + adjacent.dy}`);
		const effect = await effectDisplay.getAttribute('data-tag-game-effect');
		const holderDisplay = effectDisplay.locator('strong');
		const initialHolder = await holderDisplay.innerText();
		const botTouch = page.getByRole('button', { name: `BOT touches player ${adjacent.bot}` });
		if (effect === 'benefit') await botTouch.click();
		else await page.keyboard.press(adjacent.self);
		await expect.poll(() => holderDisplay.innerText()).not.toBe(initialHolder);
		const firstNewHolder = await holderDisplay.innerText();
		await page.getByRole('button', { name: 'Advance tag-game time 5 seconds' }).click();
		if (effect === 'benefit') await page.keyboard.press(adjacent.self);
		else await botTouch.click();
		await expect.poll(() => holderDisplay.innerText()).not.toBe(firstNewHolder);

		await page.getByRole('button', { name: 'Advance to tag-game end' }).click();
		await expect(page.locator('[data-dev-tag-game-controls]')).toContainText('寿命-');
		await expect(page.locator('[data-tag-game-hud]')).toHaveCount(0);
		await page.getByRole('button', { name: 'Open DEV tag-game panel' }).click();
		const resultsPanel = page.getByRole('dialog', { name: '鬼ごっこ' });
		await expect(resultsPanel.locator('[aria-label="鬼ごっこ結果"]')).toBeVisible();
		await resultsPanel.getByRole('button', { name: '閉じる' }).click();
		const totalsBefore = await page.locator('[data-dev-tag-game-controls] .tag-game-local-totals').innerText();
		await page.getByRole('button', { name: 'Advance tag-game time 5 seconds' }).click();
		expect(await page.locator('[data-dev-tag-game-controls] .tag-game-local-totals').innerText()).toBe(totalsBefore);
		await expect(panel).toHaveCount(0);
		await page.getByRole('button', { name: 'Reset scenario' }).click();
		await expect(page).toHaveURL(/devScenario=tag-game-playground/);
		await expect(page.locator('.participant')).toHaveCount(3);
		await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
		expect(sockets.filter((url) => url.startsWith('wss://'))).toEqual([]);
	});

	test('keeps the mobile DEV controls contained and collapsible beside the game HUD', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/?devWorld=1&devScenario=tag-game-playground');
		const controls = page.getByLabel('DEV sandbox controls');
		const summary = page.locator('.sandbox-mobile-toggle');
		await expect(summary).toBeVisible();
		await expect(page.locator('[data-dev-tag-game-controls]')).toBeHidden();
		await summary.click();
		await expect(page.locator('[data-dev-tag-game-controls]')).toBeVisible();
		const [controlBox, viewportBox] = await Promise.all([controls.boundingBox(), page.locator('.field-viewport').boundingBox()]);
		if (!controlBox || !viewportBox) throw new Error('Expected mobile playground control geometry.');
		expect(controlBox.x).toBeGreaterThanOrEqual(viewportBox.x);
		expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(viewportBox.x + viewportBox.width);
		expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(viewportBox.y + viewportBox.height);
		await page.getByRole('button', { name: 'Open DEV tag-game panel' }).click();
		const panel = page.getByRole('dialog', { name: '鬼ごっこ' });
		await panel.getByRole('button', { name: '鬼ごっこを開催' }).click();
		await panel.getByRole('button', { name: 'BOTを参加させる' }).click();
		await panel.getByRole('button', { name: '開始を提案' }).click();
		await panel.getByRole('button', { name: 'BOTが開始に同意' }).click();
		await panel.getByRole('button', { name: '閉じる' }).click();
		await page.getByRole('button', { name: 'Advance tag-game time 5 seconds' }).click();
		await expect(page.locator('[data-tag-game-hud]')).toBeVisible();
		await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
	});
});
