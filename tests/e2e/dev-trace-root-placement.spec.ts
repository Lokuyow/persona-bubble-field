import { expect, test, type Page } from '@playwright/test';
import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { openDevTraceWorld } from './helpers/devWorldHarness';

async function rootGeometry(page: Page) {
	return page.locator('.trace-root-bubble').evaluate((root) => {
		const ghost = document.querySelector<HTMLElement>('[data-trace-ghost-root-id]');
		const tail = document.querySelector<SVGPolygonElement>('polygon[data-trace-tail-root-id]');
		const outline = document.querySelector<SVGPathElement>('path[data-trace-tail-root-id]');
		const opening = root.querySelector<SVGPolygonElement>('polygon[data-tail-opening]');
		if (!ghost || !tail || !outline || !opening) throw new Error('Expected the root, ghost, tail, outline and opening.');
		const screenPoints = (element: SVGPolygonElement) => {
			const matrix = element.getScreenCTM();
			if (!matrix) throw new Error('Missing screen transform.');
			return Array.from({ length: element.points.numberOfItems }, (_, index) => element.points.getItem(index).matrixTransform(matrix));
		};
		const tailPoints = screenPoints(tail);
		const openingPoints = screenPoints(opening);
		const outlineStart = outline.getPointAtLength(0).matrixTransform(outline.getScreenCTM()!);
		return {
			body: root.getBoundingClientRect().toJSON(), ghost: ghost.getBoundingClientRect().toJSON(),
			compact: ghost.classList.contains('trace-ghost-compact'), edge: tail.dataset.traceTailEdge,
			target: { x: tailPoints[2].x, y: tailPoints[2].y },
			root: { x: (tailPoints[0].x + tailPoints[1].x) / 2, y: (tailPoints[0].y + tailPoints[1].y) / 2 },
			openingError: Math.max(...openingPoints.map((point, index) => Math.hypot(point.x - tailPoints[index].x, point.y - tailPoints[index].y))),
			outlineError: Math.hypot(outlineStart.x - tailPoints[0].x, outlineStart.y - tailPoints[0].y)
		};
	});
}

for (const viewport of [{ name: 'desktop', width: 1100, height: 850 }, { name: 'mobile', width: 390, height: 844 }]) {
	for (const [speechType, cell] of [['normal', '8,3'], ['shout', '8,4'], ['monologue', '7,3']] as const) {
		test(`keeps ${speechType} Trace roots above their source and connects a forced below fallback on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await installHostOwnedStub(page);
			await openDevTraceWorld(page, 'trace-markers');
			const source = speechType === 'monologue' ? page.locator('.participant[data-self="true"] button') : page.locator(`[data-cell-position="${cell}"]`);
			await source.focus();
			await page.keyboard.press('Enter');
			const menu = page.getByRole('menu', { name: 'Cell actions' });
			if (await menu.isVisible()) await menu.getByRole('menuitem', { name: '痕跡を調べる', exact: true }).click();
			await expect(page.locator('.trace-root-card')).toHaveAttribute('data-trace-geometry-ready', 'ready');
			await expect(page.locator('.trace-root-bubble')).toHaveAttribute('data-speech-type', speechType);
			const above = await rootGeometry(page);
			expect(above.body.bottom).toBeLessThanOrEqual(above.ghost.top + 0.01);
			expect(above.edge).toBe('bottom');
			expect(Math.abs(above.target.y - above.ghost.top)).toBeLessThan(1);
			expect(above.target.y).toBeGreaterThanOrEqual(above.body.bottom);
			expect(above.compact).toBe(speechType === 'monologue');
			expect(above.openingError).toBeLessThan(1);
			expect(above.outlineError).toBeLessThan(0.01);

			// Resize the measured HUD obstacle; no delay or fixture-only placement override.
			await page.locator('[data-field-status-huds]').evaluate((hud) => {
				const viewport = document.querySelector<HTMLElement>('.field-viewport')!;
				const ghost = document.querySelector<HTMLElement>('[data-trace-ghost-root-id]')!;
				const bottom = ghost.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top;
				hud.style.cssText = `position:absolute;top:0;left:0;width:100%;height:${bottom + 8}px;pointer-events:none;`;
			});
			await expect(page.locator('polygon[data-trace-tail-root-id]')).toHaveAttribute('data-trace-tail-edge', 'top');
			const below = await rootGeometry(page);
			expect(below.body.top).toBeGreaterThan(below.ghost.bottom);
			expect(Math.abs(below.target.y - below.ghost.bottom)).toBeLessThan(1);
			expect(below.target.y).toBeLessThan(below.body.top);
			expect(below.root.y).toBeGreaterThan(below.target.y);
			expect(below.openingError).toBeLessThan(1);
			expect(below.outlineError).toBeLessThan(0.01);
		});
	}
}
