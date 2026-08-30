import { expect, test, type Page } from '@playwright/test';

async function openDevWorld(page: Page): Promise<void> {
	await page.goto('/?devWorld=1');
	await expect(page.getByText('DEV World Sandbox', { exact: true })).toBeVisible();
	await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
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
});
