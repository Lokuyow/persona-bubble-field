import { test, expect } from '@playwright/test';

test('keeps button labels unselectable while preserving text selection elsewhere', async ({ page }) => {
	await page.goto('/');

	const styles = await page.evaluate(() => {
		const fixture = document.createElement('div');
		fixture.innerHTML = '<button type="button">Action label</button><a href="#target">Link</a><p>Readable body text</p><input value="Editable text">';
		document.body.append(fixture);
		const button = fixture.querySelector('button')!;
		const input = fixture.querySelector('input')!;
		const root = getComputedStyle(document.documentElement);
		return {
			buttonUserSelect: getComputedStyle(button).userSelect,
			buttonWebkitUserSelect: getComputedStyle(button).webkitUserSelect,
			inputUserSelect: getComputedStyle(input).userSelect,
			tapHighlight: root.webkitTapHighlightColor
		};
	});

	expect(styles.buttonUserSelect).toBe('none');
	expect(styles.buttonWebkitUserSelect).toBe('none');
	expect(styles.inputUserSelect).not.toBe('none');
	expect(styles.tapHighlight).toBe('rgba(0, 0, 0, 0)');
});
