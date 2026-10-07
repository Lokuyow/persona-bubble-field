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
		const mobileFooter = element.closest<HTMLElement>('.dialog-mobile-close-footer');
		const footerStyle = mobileFooter ? getComputedStyle(mobileFooter) : null;
		const dialog = element.closest<HTMLElement>('[role="dialog"]');
		const dialogBounds = dialog?.getBoundingClientRect();
		const dialogStyle = dialog ? getComputedStyle(dialog) : null;
		const footerBounds = mobileFooter?.getBoundingClientRect();
		const icon = element.querySelector('svg');
		const iconBounds = icon?.getBoundingClientRect();
		return {
			mobileFooter: Boolean(mobileFooter),
			width: bounds.width,
			height: bounds.height,
			background: style.backgroundColor,
			borderStyle: style.borderStyle,
			borderWidth: style.borderWidth,
			footerBorderStyle: footerStyle?.borderTopStyle ?? null,
			footerBorderWidth: footerStyle?.borderTopWidth ?? null,
			footerCenterDelta: footerBounds ? Math.abs(bounds.left + bounds.width / 2 - footerBounds.left - footerBounds.width / 2) : null,
			footerBottomSpace: footerBounds && dialogBounds && dialogStyle ? dialogBounds.bottom - footerBounds.bottom - Number.parseFloat(dialogStyle.borderBottomWidth) : null,
			text: element.textContent?.trim() ?? '',
			icon: icon && iconBounds ? {
				width: iconBounds.width,
				height: iconBounds.height,
				ariaHidden: icon.getAttribute('aria-hidden')
			} : null
		};
	});

	if (appearance.mobileFooter) {
		expect(appearance.width).toBe(44);
		expect(appearance.height).toBe(44);
		expect(appearance.footerCenterDelta).toBeLessThan(1);
		expect(appearance.footerBottomSpace).toBeGreaterThan(0);
		expect(appearance.footerBorderStyle).toBe('solid');
		expect(appearance.footerBorderWidth).toBe('1px');
	} else {
		expect(appearance.width).toBe(44);
		expect(appearance.height).toBe(44);
		expect(appearance.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(appearance.borderStyle).toBe('solid');
		expect(appearance.borderWidth).toBe('1px');
	}
	expect(appearance.text).toBe('');
	expect(appearance.icon).toEqual({ width: 24, height: 24, ariaHidden: 'true' });
}
