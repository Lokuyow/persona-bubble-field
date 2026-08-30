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

function profileTrigger(page: Page, name: string) {
	return page.getByRole('button', { name: `${name} のプロフィールを開く` });
}

function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

async function expectProfile(page: Page, character: { name: string; picture: string; about: string }): Promise<void> {
	const dialog = profileDialog(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-dialog-title]')).toHaveText(character.name);
	await expect(dialog.locator('.profile-dialog-avatar img')).toHaveAttribute('src', new RegExp(`characters/${character.picture}$`));
	await expect(dialog.locator('.profile-dialog-about')).toHaveText(character.about);
}

async function openProfile(page: Page, name: string): Promise<void> {
	await profileTrigger(page, name).click();
	await expect(profileDialog(page)).toBeVisible();
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
	});

	test('opens a profile by keyboard', async ({ page }) => {
		await openDevWorld(page);

		await profileTrigger(page, '女の子').focus();
		await page.keyboard.press('Enter');
		await expect(profileDialog(page)).toBeVisible();
	});

	for (const closePath of ['close button', 'Escape', 'outside interaction'] as const) {
		test(`keeps profile history aligned after ${closePath}`, async ({ page }) => {
			await openDevWorld(page);
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
			await page.goForward();
			await expect(profileDialog(page)).toBeVisible();
			await page.goBack();
			await expect(profileDialog(page)).toBeHidden();
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
		await expect(page.getByText('DEV World Sandbox', { exact: true })).toBeVisible();
		await openProfile(page, '全裸中年男性');

		const dialog = profileDialog(page);
		const viewport = dialog.locator('.profile-dialog-scroll-viewport');
		await expect(viewport).toBeVisible();
		expect(await viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
		await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
		await expect(dialog.getByRole('button', { name: '閉じる' })).toBeVisible();
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
