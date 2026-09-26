import { expect, test, type Locator, type Page } from '@playwright/test';

export type TraceGeometryRect = { x: number; y: number; width: number; height: number };
export type TraceGeometryFrame = {
	ready: string | null;
	visible: boolean;
	rootCard: TraceGeometryRect;
	rootBubble: TraceGeometryRect;
	surface: TraceGeometryRect | null;
	viewBox: string | null;
	rootTailCount: number;
	relationConnectorCount: number;
};

export async function openDevWorld(page: Page): Promise<void> {
	await page.goto('/?devWorld=1');
	await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
	await expect(page.locator('.participant')).toHaveCount(1);
	await expect(page.locator('[data-unified-status-hud]')).toHaveCount(0);
}

export async function openDevTraceWorld(page: Page, scenario: 'trace-markers' | 'trace-replies' | 'trace-inactive-self'): Promise<void> {
	await page.goto(`/?devWorld=1&devScenario=${scenario}`);
	await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
	await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'dev');
}

export async function openClockedDevWorld(page: Page): Promise<void> {
	await page.clock.install({ time: Date.now() });
	await openDevWorld(page);
	const now = await page.evaluate(() => Date.now());
	await page.clock.pauseAt(now + 1_000);
}

export async function readMergedBubbleGeometry(page: Page, memberPrefixes: readonly string[]) {
	return page.locator('.bubble-merged').evaluate((bubble, prefixes) => {
		const mergedMemberIds = new Set(prefixes.map((prefix) => prefix.repeat(64)));
		const rect = bubble.getBoundingClientRect();
		const style = getComputedStyle(bubble);
		const polygons = [...document.querySelectorAll<SVGPolygonElement>('.tail-layer polygon')]
			.filter((polygon) => mergedMemberIds.has(polygon.dataset.tailParticipantId ?? ''));
		const tailStartXs = polygons.map((polygon) => {
			const first = polygon.points.getItem(0);
			const second = polygon.points.getItem(1);
			const target = polygon.points.getItem(polygon.points.numberOfItems - 1);
			const base = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
			const dx = target.x - base.x;
			const dy = target.y - base.y;
			const length = Math.hypot(dx, dy) || 1;
			return base.x + (dx / length) * 2;
		});
		const connectionMasks = [...bubble.querySelectorAll<HTMLElement>('.bubble-tail-connection')].map((mask) => {
			const maskRect = mask.getBoundingClientRect();
			const maskStyle = getComputedStyle(mask);
			return {
				participantId: mask.dataset.tailParticipantId,
				centerX: maskRect.left + maskRect.width / 2,
				width: maskRect.width,
				height: maskRect.height,
				background: maskStyle.backgroundColor
			};
		});

		return {
			memberCount: Number(bubble.dataset.mergedMembers),
			width: rect.width,
			height: rect.height,
			fontSize: Number.parseFloat(style.fontSize),
			paddingLeft: Number.parseFloat(style.paddingLeft),
			tailStartXs,
			connectionMasks,
			tailOutlineCount: document.querySelectorAll('.tail-layer path[data-tail-participant-id]').length,
			borderRadius: style.borderRadius,
			background: style.backgroundColor
		};
	}, memberPrefixes);
}

export async function readCharacterGeometry(page: Page) {
	return page.locator('.participant').first().evaluate((participant) => {
		const avatar = participant.querySelector<HTMLElement>('.avatar');
		const participantRect = participant.getBoundingClientRect();
		const avatarRect = avatar?.getBoundingClientRect();
		const fieldGrid = document.querySelector<HTMLElement>('.field-grid');
		if (!avatar || !avatarRect) throw new Error('Expected the participant avatar to be rendered.');
		if (!fieldGrid) throw new Error('Expected the field grid to be rendered.');
		const fieldGridRect = fieldGrid.getBoundingClientRect();
		const [x, y] = (participant.dataset.position ?? '').split(',').map(Number);
		const cellSize = Number.parseFloat(getComputedStyle(participant).width);

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
			},
			gridCellCenter: {
				x: fieldGridRect.left + (x + 0.5) * cellSize,
				y: fieldGridRect.top + (y + 0.5) * cellSize
			}
		};
	});
}

export async function fieldCellCenter(page: Page, position: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.locator('.field-grid').evaluate((grid, cell) => {
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!scene) throw new Error('Expected the field scene to be rendered.');
		const rect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		return { x: rect.left + (cell.x + 0.5) * cellSize, y: rect.top + (cell.y + 0.5) * cellSize };
	}, position);
}

export async function fieldOwnedBlankPoint(page: Page, preferred: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.locator('.field-grid').evaluate((grid, preferredCell) => {
		const scene = document.querySelector<HTMLElement>('.field-scene');
		const fieldArea = document.querySelector<HTMLElement>('.field-area');
		if (!scene || !fieldArea) throw new Error('Expected the field surface to be rendered.');
		const gridRect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		const candidates = [preferredCell, ...Array.from({ length: 8 }, (_, index) => ({
			x: preferredCell.x + (index % 4) - 1,
			y: preferredCell.y + Math.floor(index / 4) - 1
		}))];
		for (const cell of candidates) {
			const point = { x: gridRect.left + (cell.x + 0.5) * cellSize, y: gridRect.top + (cell.y + 0.5) * cellSize };
			const hit = document.elementFromPoint(point.x, point.y);
			if (!hit || !fieldArea.contains(hit)) continue;
			if (hit.closest('.participant, [data-field-gesture-origin="selectable"], .field-action-menu, .sandbox-controls, .action-dock, [role="dialog"]')) continue;
			return point;
		}
		const rect = (element: Element) => {
			const box = element.getBoundingClientRect();
			return { x: box.x, y: box.y, width: box.width, height: box.height };
		};
		throw new Error(`No field-owned blank point. fieldArea=${JSON.stringify(rect(fieldArea))} grid=${JSON.stringify(rect(grid))} controls=${JSON.stringify([...document.querySelectorAll('.sandbox-controls')].map(rect))}`);
	}, preferred);
}

export async function viewportExternalPoint(page: Page): Promise<{ x: number; y: number }> {
	return page.locator('.field-viewport').evaluate((viewport) => {
		const viewportRect = viewport.getBoundingClientRect();
		const fieldRect = document.querySelector<HTMLElement>('.field-area')!.getBoundingClientRect();
		const composerRect = document.querySelector<HTMLElement>('.action-dock')?.getBoundingClientRect() ?? null;
		const candidates = [
			{ x: viewportRect.left + viewportRect.width / 2, y: viewportRect.top + 20 },
			{ x: viewportRect.left + 20, y: viewportRect.top + viewportRect.height / 2 },
			{ x: viewportRect.right - 20, y: viewportRect.top + viewportRect.height / 2 }
		];
		const inside = (rect: DOMRect, point: { x: number; y: number }) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
		const point = candidates.find((candidate) => inside(viewportRect, candidate) && !inside(fieldRect, candidate) && (!composerRect || !inside(composerRect, candidate)));
		if (!point) throw new Error(`No viewport-external point. viewport=${JSON.stringify(viewportRect.toJSON())} field=${JSON.stringify(fieldRect.toJSON())} composer=${JSON.stringify(composerRect?.toJSON() ?? null)}`);
		return point;
	});
}

export async function chatterNonInteractivePoint(page: Page): Promise<{ x: number; y: number }> {
	return page.locator('aside[aria-label="Chatter"]').evaluate((chatter) => {
		const rect = chatter.getBoundingClientRect();
		const header = chatter.querySelector<HTMLElement>('.timeline-header')?.getBoundingClientRect();
		if (!header) throw new Error('Expected the Chatter header to be rendered.');
		return { x: rect.right - 8, y: header.top + header.height / 2 };
	});
}

export async function speechMovementPoint(page: Page): Promise<{ x: number; y: number }> {
	return page.locator('.bubble-normal[data-speech-type="shout"]').first().evaluate((bubble) => {
		const rect = bubble.getBoundingClientRect();
		const candidates = [
			{ x: rect.left + 2, y: rect.top + rect.height / 2 },
			{ x: rect.right - 2, y: rect.top + rect.height / 2 },
			{ x: rect.left + rect.width / 2, y: rect.top + 2 }
		];
		const point = candidates.find(({ x, y }) => {
			const hit = document.elementFromPoint(x, y);
			return hit && !hit.closest('.bubble-content, button, input, textarea, select, [contenteditable="true"]');
		});
		if (!point) throw new Error(`No speech movement point. bubble=${JSON.stringify(rect.toJSON())}`);
		return point;
	});
}

export async function installTraceGeometryFrameSampling(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Rect = { x: number; y: number; width: number; height: number };
		type TraceFrame = {
			ready: string | null;
			visible: boolean;
			rootCard: Rect;
			rootBubble: Rect;
			surface: Rect | null;
			viewBox: string | null;
			rootTailCount: number;
			relationConnectorCount: number;
		};
		const state = window as typeof window & { __traceGeometryFrames: TraceFrame[] };
		state.__traceGeometryFrames = [];
		const rect = (element: Element): Rect => {
			const { x, y, width, height } = element.getBoundingClientRect();
			return { x, y, width, height };
		};
		const sample = () => {
			const rootCard = document.querySelector<HTMLElement>('.trace-root-card');
			const rootBubble = document.querySelector<HTMLElement>('[data-trace-root-id]');
			if (!rootCard || !rootBubble) return;
			const surface = rootBubble.querySelector<SVGSVGElement>('.bubble-surface');
			const style = getComputedStyle(rootCard);
			state.__traceGeometryFrames.push({
				ready: rootCard.dataset.traceGeometryReady ?? null,
				visible: style.visibility === 'visible' && style.display !== 'none',
				rootCard: rect(rootCard),
				rootBubble: rect(rootBubble),
				surface: surface ? rect(surface) : null,
				viewBox: surface?.getAttribute('viewBox') ?? null,
				rootTailCount: document.querySelectorAll('[data-trace-tail-root-id]').length,
				relationConnectorCount: document.querySelectorAll('.trace-relation-connector').length
			});
		};
		const frame = () => { sample(); requestAnimationFrame(frame); };
		requestAnimationFrame(frame);
		new MutationObserver(sample).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'data-trace-geometry-ready'] });
	});
}

export async function sampleTraceGeometryFrames(page: Page) {
	await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
	return page.evaluate<TraceGeometryFrame[]>(() => (window as typeof window & { __traceGeometryFrames: TraceGeometryFrame[] }).__traceGeometryFrames);
}

export async function dragJoystick(page: Page, delta: { x: number; y: number }, startCell = { x: 5, y: 5 }): Promise<void> {
	const start = await fieldOwnedBlankPoint(page, startCell);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + delta.x, start.y + delta.y);
	await page.mouse.up();
}

export async function expectNoConsoleProblems(page: Page, action: () => Promise<void>): Promise<void> {
	const problems: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
	});
	page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
	await action();
	expect(problems).toEqual([]);
}

export function profileTrigger(page: Page, name: string) {
	return page.getByRole('button', { name: `${name} のプロフィールを開く` });
}

export function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

export async function expectProfile(page: Page, character: { name: string; picture: string; about: string }): Promise<void> {
	const dialog = profileDialog(page);
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('[data-dialog-title]')).toHaveText(character.name);
	await expect(dialog.locator('.profile-dialog-avatar img')).toHaveAttribute('src', new RegExp(`characters/${character.picture}$`));
	await expect(dialog.locator('.profile-dialog-about')).toHaveText(character.about);
}

export async function openProfile(page: Page, name: string): Promise<void> {
	await profileTrigger(page, name).click();
	await expect(profileDialog(page)).toBeVisible();
}

export async function profileTriggerCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
	const box = await profileTrigger(page, name).boundingBox();
	if (!box) throw new Error('Expected the profile trigger to have a bounding box.');
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
