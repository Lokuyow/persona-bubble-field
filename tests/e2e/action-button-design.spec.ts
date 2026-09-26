import { expect, test } from '@playwright/test';

function channel(color: string): [number, number, number] {
	const normalized = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
	if (normalized) return [Number(normalized[1]) * 255, Number(normalized[2]) * 255, Number(normalized[3]) * 255];
	const values = color.match(/[\d.]+/g)?.map(Number);
	if (!values || values.length < 3) throw new Error(`Unexpected computed color ${color}.`);
	return [values[0]!, values[1]!, values[2]!];
}

function luminance(color: string): number {
	const linear = channel(color).map((value) => {
		const normalized = value / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(first: string, second: string): number {
	const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return (values[0]! + 0.05) / (values[1]! + 0.05);
}

test('shared action tokens expose every state on light and dark surfaces at desktop and mobile widths', async ({ page }) => {
	await page.goto('/');
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('DOM.enable');
	await cdp.send('CSS.enable');
	for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(viewport);
		await page.evaluate(() => {
			document.querySelector('[data-action-button-test-fixture]')?.remove();
			const fixture = document.createElement('div');
			fixture.dataset.actionButtonTestFixture = 'true';
			fixture.style.cssText = 'position:fixed;z-index:9999;inset:8px auto auto 8px;display:grid;gap:8px;max-width:calc(100vw - 16px);padding:12px;background:#fff;color:#20242a';
			fixture.innerHTML = `
				<div data-test-surface="light" style="display:flex;flex-wrap:wrap;gap:8px;max-width:calc(100vw - 56px);background:#fff;color:#20242a;padding:8px">
				<button data-test-action="primary" class="action-button action-button-primary action-button-intent-normal">Primary</button>
				<button data-test-action="secondary" class="action-button action-button-secondary action-button-intent-normal">Secondary</button>
				<button data-test-action="tertiary" class="action-button action-button-tertiary action-button-intent-normal">Tertiary</button>
				<button data-test-action="cancel" class="action-button action-button-tertiary action-button-intent-cancel">Cancel</button>
				<button data-test-action="danger" class="action-button action-button-secondary action-button-intent-danger">Danger</button>
				<button class="action-button action-button-primary action-button-intent-normal" disabled>Disabled primary</button>
				</div>
				<div class="selection-dialog" data-test-surface="dark" style="display:flex;flex-wrap:wrap;gap:8px;max-width:calc(100vw - 56px);background:#131729;color:#fff;padding:8px">
				<button data-test-action="primary" class="action-button action-button-primary action-button-intent-normal">Primary</button>
				<button data-test-action="secondary" class="action-button action-button-secondary action-button-intent-normal">Secondary</button>
				<button data-test-action="tertiary" class="action-button action-button-tertiary action-button-intent-normal">Tertiary</button>
				<button data-test-action="cancel" class="action-button action-button-tertiary action-button-intent-cancel">Cancel</button>
				<button data-test-action="danger" class="action-button action-button-secondary action-button-intent-danger">Danger</button>
				<button class="action-button action-button-primary action-button-intent-normal" disabled>Disabled primary</button>
				</div>`;
			document.body.append(fixture);
		});

		for (const surfaceName of ['light', 'dark']) {
			const surface = page.locator(`[data-test-surface="${surfaceName}"]`);
			for (const name of ['Primary', 'Secondary', 'Tertiary', 'Cancel', 'Danger']) {
				const button = surface.getByRole('button', { name, exact: true });
				const variant = name === 'Primary' ? 'primary' : name === 'Secondary' || name === 'Danger' ? 'secondary' : 'tertiary';
				const normal = await button.evaluate((element) => {
					const style = getComputedStyle(element);
					return { background: style.backgroundColor, border: style.borderColor, foreground: style.color, borderStyle: style.borderStyle, borderWidth: style.borderWidth, surface: getComputedStyle(element.parentElement!).backgroundColor };
				});
				expect(normal.background, `${surfaceName} ${name} background`).not.toBe('rgba(0, 0, 0, 0)');
				expect(normal.borderStyle).not.toBe('none');
				expect(normal.borderWidth).toBe('1px');
				expect(normal.border).not.toBe('rgba(0, 0, 0, 0)');
				expect(contrast(normal.foreground, normal.background), `${surfaceName} ${name} text contrast`).toBeGreaterThanOrEqual(4.5);
				expect(Math.max(contrast(normal.border, normal.surface), contrast(normal.background, normal.surface)), `${surfaceName} ${name} boundary contrast (${normal.border}, ${normal.background}, ${normal.surface})`).toBeGreaterThanOrEqual(3);

				await button.hover();
				await page.waitForTimeout(150);
				const hover = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
				expect(hover, `${surfaceName} ${name} hover`).not.toBe(normal.background);
				expect(contrast(normal.foreground, hover), `${surfaceName} ${name} hover text contrast`).toBeGreaterThanOrEqual(4.5);
				const documentNode = await cdp.send('DOM.getDocument');
				const node = await cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: `[data-test-surface="${surfaceName}"] [data-test-action="${name.toLowerCase()}"]` });
				await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: ['active'] });
				await page.waitForTimeout(50);
				const activeState = await button.evaluate((element, variantName) => ({ background: getComputedStyle(element).backgroundColor, token: getComputedStyle(element).getPropertyValue(`--action-${variantName}-background-active`), matches: element.matches(':active'), disabled: element.matches(':disabled'), ruleMatches: element.matches(`.action-button-${variantName}:active:not(:disabled)`) }), variant);
				expect(activeState.matches, `${surfaceName} ${name} CDP active state`).toBe(true);
				expect(activeState.ruleMatches, `${surfaceName} ${name} active rule`).toBe(true);
				expect(activeState.background, `${surfaceName} ${name} active token ${activeState.token}`).not.toBe(hover);
				expect(contrast(normal.foreground, activeState.background), `${surfaceName} ${name} active text contrast`).toBeGreaterThanOrEqual(4.5);
				await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: [] });

				await page.keyboard.press('Tab');
				await button.focus();
				await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: ['focus-visible'] });
				const focus = await button.evaluate((element) => ({ matches: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle, color: getComputedStyle(element).outlineColor }));
				expect(focus.matches).toBe(true);
				expect(focus.outline).toBe('solid');
				expect(contrast(focus.color, normal.surface), `${surfaceName} ${name} focus outline contrast`).toBeGreaterThanOrEqual(3);
				await cdp.send('CSS.forcePseudoState', { nodeId: node.nodeId, forcedPseudoClasses: [] });
			}

			const disabledPrimary = surface.getByRole('button', { name: 'Disabled primary' });
			await expect(disabledPrimary).toBeDisabled();
			const disabledStyle = await disabledPrimary.evaluate((element) => ({
				background: getComputedStyle(element).backgroundColor,
				border: getComputedStyle(element).borderColor,
				foreground: getComputedStyle(element).color,
				surface: getComputedStyle(element.parentElement!).backgroundColor
			}));
			const primaryBackground = await surface.getByRole('button', { name: 'Primary', exact: true }).evaluate((element) => getComputedStyle(element).backgroundColor);
			expect(disabledStyle.background).not.toBe(primaryBackground);
			expect(contrast(disabledStyle.foreground, disabledStyle.background), `${surfaceName} disabled text contrast`).toBeGreaterThanOrEqual(4.5);
			expect(Math.max(contrast(disabledStyle.border, disabledStyle.surface), contrast(disabledStyle.background, disabledStyle.surface)), `${surfaceName} disabled boundary contrast`).toBeGreaterThanOrEqual(3);
		}
	}
});
