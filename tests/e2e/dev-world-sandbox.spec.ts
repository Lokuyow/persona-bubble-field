import { expect, test, type Page } from '@playwright/test';

async function openDevWorld(page: Page): Promise<void> {
	await page.goto('/?devWorld=1');
	await expect(page.getByText('DEV World Sandbox', { exact: true })).toBeVisible();
	await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
}

async function readCharacterGeometry(page: Page) {
	return page.locator('.participant').first().evaluate((participant) => {
		const avatar = participant.querySelector<HTMLElement>('.avatar');
		const participantRect = participant.getBoundingClientRect();
		const avatarRect = avatar?.getBoundingClientRect();
		if (!avatar || !avatarRect) throw new Error('Expected the participant avatar to be rendered.');

		return {
			cellWidth: getComputedStyle(participant).width,
			cellHeight: getComputedStyle(participant).height,
			avatarWidth: getComputedStyle(avatar).width,
			avatarHeight: getComputedStyle(avatar).height,
			participantCenter: {
				x: participantRect.left + participantRect.width / 2,
				y: participantRect.top + participantRect.height / 2
			},
			avatarCenter: {
				x: avatarRect.left + avatarRect.width / 2,
				y: avatarRect.top + avatarRect.height / 2
			}
		};
	});
}

async function expectNoConsoleProblems(page: Page, action: () => Promise<void>): Promise<void> {
	const problems: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
	});
	await action();
	expect(problems).toEqual([]);
}

test.describe('DEV World Sandbox', () => {
	test('starts with the local-only self and deterministic character presentation', async ({ page }) => {
		await openDevWorld(page);

		await expect(page.getByText('local only · Relay connection disabled · publishing disabled', { exact: true })).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(1);

		const characterSelect = page.getByLabel('Select sandbox character');
		await expect(characterSelect).toHaveValue('001');

		const self = page.locator('.participant').first();
		await expect(self).toHaveAttribute('data-position', '7,3');
		await expect(self.locator('img')).toHaveAttribute('src', /characters\/001\.webp$/);
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

	test('moves by control and keyboard, then resets to the initial position', async ({ page }) => {
		await openDevWorld(page);

		const self = page.locator('.participant').first();
		await page.getByRole('button', { name: 'Move right' }).click();
		await expect(self).toHaveAttribute('data-position', '8,3');

		await page.keyboard.press('ArrowUp');
		await expect(self).toHaveAttribute('data-position', '8,2');

		await page.getByRole('button', { name: 'Reset sandbox' }).click();
		await expect(self).toHaveAttribute('data-position', '7,3');
	});

	test.describe('responsive field presentation', () => {
		for (const viewport of [
			{ name: 'mobile', width: 390, height: 844, cell: '80px', avatar: '76px', worldWidth: '1280px', worldHeight: '640px' },
			{ name: 'desktop', width: 1200, height: 900, cell: '96px', avatar: '92px', worldWidth: '1536px', worldHeight: '768px' }
		]) {
			test(`${viewport.name} uses the larger cell and centered avatar`, async ({ page }) => {
				await page.setViewportSize({ width: viewport.width, height: viewport.height });
				await expectNoConsoleProblems(page, async () => {
					await openDevWorld(page);
					const scene = page.locator('.field-scene');
					await expect(scene).toHaveCSS('width', viewport.worldWidth);
					await expect(scene).toHaveCSS('height', viewport.worldHeight);

					const geometry = await readCharacterGeometry(page);
					expect(geometry.cellWidth).toBe(viewport.cell);
					expect(geometry.cellHeight).toBe(viewport.cell);
					expect(geometry.avatarWidth).toBe(viewport.avatar);
					expect(geometry.avatarHeight).toBe(viewport.avatar);
					expect(Math.abs(geometry.avatarCenter.x - geometry.participantCenter.x)).toBeLessThan(0.5);
					expect(Math.abs(geometry.avatarCenter.y - geometry.participantCenter.y)).toBeLessThan(0.5);
					await expect(page.locator('.participant-name')).toBeVisible();
					await expect(page.locator('.field-area')).toHaveCSS('overflow', 'hidden');
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

			await page.getByRole('button', { name: 'Move right' }).click();
			await expect(self).toHaveAttribute('data-position', '8,3');
			const after = await readCharacterGeometry(page);
			const afterTransform = await scene.evaluate((element) => getComputedStyle(element).transform);

			expect(afterTransform).not.toBe(beforeTransform);
			expect(Math.abs(after.avatarCenter.x - page.viewportSize()!.width / 2)).toBeLessThan(0.5);
			expect(Math.abs(after.avatarCenter.x - after.participantCenter.x)).toBeLessThan(0.5);
			expect(after.avatarWidth).toBe('76px');
			expect(after.avatarHeight).toBe('76px');
			expect(before.participantCenter.y).toBe(after.participantCenter.y);
		});
	});
});
