import { expect, type Locator, type Page } from '@playwright/test';
import { expectIconCloseButton } from './iconCloseButton';

/** Finish only Web Animations owned by one mounted Bits UI Dialog. */
export async function finishDialogAnimations(dialog: Locator): Promise<void> {
	await dialog.evaluate(async (element) => {
		const animations = element.getAnimations();
		for (const animation of animations) {
			if (animation.playState !== 'finished') animation.finish();
		}
		await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
	});
}

export async function expectDialogIconCloseButton(dialog: Locator, button: Locator, accessibleName: string): Promise<void> {
	await finishDialogAnimations(dialog);
	await expectIconCloseButton(button, accessibleName);
}

/** Let Bits UI process its exit frame while keeping a fake game's Date fixed. */
export async function finishDialogExit(dialog: Locator): Promise<void> {
	const page = dialog.page();
	const fixedNow = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(fixedNow);
	await page.clock.resume();
	await page.clock.setFixedTime(fixedNow);
	await finishDialogAnimations(dialog);
	await expect(dialog).toHaveCount(0);
	await page.clock.pauseAt(fixedNow);
	await page.clock.setSystemTime(fixedNow);
}

/** Let a clock-frozen Bits UI entrance frame run without changing Date.now(). */
export async function finishDialogEntrance(page: Page, dialog: Locator): Promise<void> {
	const fixedNow = await page.evaluate(() => Date.now());
	await page.clock.setFixedTime(fixedNow);
	await page.clock.resume();
	await page.clock.setFixedTime(fixedNow);
	await dialog.evaluate(async (element) => {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		const animations = element.getAnimations();
		for (const animation of animations) {
			if (animation.playState !== 'finished') animation.finish();
		}
		await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
	});
	await page.clock.pauseAt(fixedNow);
	await page.clock.setSystemTime(fixedNow);
}
