import { expect, type Locator } from '@playwright/test';

export async function expectIconCloseButton(button: Locator, accessibleName: string): Promise<void> {
	await expect(button).toBeVisible();
	await expect(button).toHaveAttribute('aria-label', accessibleName);
	await expect(button).toHaveClass(/\baction-button\b/);
	await expect(button).toHaveClass(/\baction-button-tertiary\b/);
	await expect(button).toHaveClass(/\baction-button-close\b/);

	const appearance = await button.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const icon = element.querySelector('svg');
		const iconBounds = icon?.getBoundingClientRect();
		return {
			width: bounds.width,
			height: bounds.height,
			background: style.backgroundColor,
			borderStyle: style.borderStyle,
			borderWidth: style.borderWidth,
			text: element.textContent?.trim() ?? '',
			icon: icon && iconBounds ? {
				width: iconBounds.width,
				height: iconBounds.height,
				ariaHidden: icon.getAttribute('aria-hidden')
			} : null
		};
	});

	expect(appearance.width).toBe(44);
	expect(appearance.height).toBe(44);
	expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
	expect(appearance.borderStyle).toBe('solid');
	expect(appearance.borderWidth).toBe('1px');
	expect(appearance.text).toBe('');
	expect(appearance.icon).toEqual({ width: 24, height: 24, ariaHidden: 'true' });
}
