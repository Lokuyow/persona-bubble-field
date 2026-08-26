import { describe, expect, it } from 'vitest';
import {
	clampCamera,
	clampToBounds,
	clampToViewport,
	DESKTOP_CELL_SIZE,
	getFieldWorldSize,
	getResponsiveCellSize,
	gridToWorld,
	MOBILE_CELL_SIZE,
	mergedBubblePreferredAnchor,
	moveOneCell,
	normalBubblePreferredAnchor,
	speechAreaBubbleY,
	worldToScreen
} from './geometry';

describe('field geometry', () => {
	it('selects the prototype cell size by viewport width', () => {
		expect(getResponsiveCellSize(360)).toBe(MOBILE_CELL_SIZE);
		expect(getResponsiveCellSize(700)).toBe(MOBILE_CELL_SIZE);
		expect(getResponsiveCellSize(701)).toBe(DESKTOP_CELL_SIZE);
	});

	it('uses the mobile cell size for grid to world conversion at 360px', () => {
		expect(gridToWorld({ x: 1, y: 2 }, getResponsiveCellSize(360))).toEqual({ x: 84, y: 140 });
	});

	it('keeps responsive field size and camera projection on the same cell size', () => {
		const cellSize = getResponsiveCellSize(360);
		const field = getFieldWorldSize({ columns: 16, rows: 8, cellSize });
		const player = gridToWorld({ x: 7, y: 4 }, cellSize);
		const camera = clampCamera(player, { width: 360, height: 740 }, field);

		expect(field).toEqual({ width: 896, height: 448 });
		expect(worldToScreen(player, camera).x).toBe(180);
	});

	it('converts a grid cell to the center of its world cell', () => {
		expect(gridToWorld({ x: 2, y: 3 }, 40)).toEqual({ x: 100, y: 140 });
	});

	it('clamps the camera to the field edges', () => {
		const field = getFieldWorldSize({ columns: 16, rows: 8, cellSize: 40 });

		expect(clampCamera({ x: 10, y: 10 }, { width: 240, height: 160 }, field)).toEqual({ x: 0, y: 0 });
		expect(clampCamera({ x: 630, y: 310 }, { width: 240, height: 160 }, field)).toEqual({ x: 400, y: 160 });
	});

	it('centers a smaller field inside a larger viewport', () => {
		expect(clampCamera({ x: 100, y: 100 }, { width: 900, height: 600 }, { width: 640, height: 320 })).toEqual({
		 x: -130,
		 y: -140
	});
	});

	it('projects world coordinates into the camera viewport', () => {
		expect(worldToScreen({ x: 180, y: 140 }, { x: 80, y: 60 })).toEqual({ x: 100, y: 80 });
	});

	it('rejects movement beyond field edges and into occupied cells', () => {
		const field = { columns: 4, rows: 3 };

		expect(moveOneCell({ x: 0, y: 0 }, 'left', field)).toBeNull();
		expect(moveOneCell({ x: 3, y: 2 }, 'down', field)).toBeNull();
		expect(moveOneCell({ x: 1, y: 1 }, 'right', field, [{ x: 2, y: 1 }])).toBeNull();
	});

	it('moves one cell in each cardinal direction', () => {
		const field = { columns: 4, rows: 3 };

		expect(moveOneCell({ x: 1, y: 1 }, 'up', field)).toEqual({ x: 1, y: 0 });
		expect(moveOneCell({ x: 1, y: 1 }, 'down', field)).toEqual({ x: 1, y: 2 });
		expect(moveOneCell({ x: 1, y: 1 }, 'left', field)).toEqual({ x: 0, y: 1 });
		expect(moveOneCell({ x: 1, y: 1 }, 'right', field)).toEqual({ x: 2, y: 1 });
	});

	it('places a normal bubble at the speech area lane while following speaker X', () => {
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };

		expect(normalBubblePreferredAnchor(200, { width: 120, height: 44 }, speechArea)).toEqual({ x: 140, y: 142 });
	});

	it('keeps normal bubble vertical placement in the speech area regardless of speaker Y', () => {
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };
		const bubble = { width: 120, height: 44 };
		const anchor = normalBubblePreferredAnchor(200, bubble, speechArea);

		expect(anchor.y).toBe(speechAreaBubbleY(speechArea, bubble));
		expect(anchor.y).toBeGreaterThanOrEqual(speechArea.y);
		expect(anchor.y + bubble.height).toBeLessThanOrEqual(speechArea.y + speechArea.height);
	});

	it('centers a merged bubble horizontally from its members', () => {
		expect(
			mergedBubblePreferredAnchor(
				[
					{ x: 120, y: 240 },
					{ x: 200, y: 200 },
					{ x: 280, y: 240 }
				],
				{ width: 160, height: 48 },
				{ x: 16, y: 84, width: 288, height: 160 }
			)
		).toEqual({ x: 120, y: 140 });
	});

	it('keeps bubble anchors inside the viewport', () => {
		expect(clampToViewport({ x: -40, y: 500 }, { width: 120, height: 44 }, { width: 320, height: 240 }, 12)).toEqual({
		 x: 12,
		 y: 184
		});
	});

	it('keeps a bubble inside the explicit speech area bounds', () => {
		expect(
			clampToBounds(
				{ x: 220, y: 20 },
				{ width: 120, height: 44 },
				{ x: 16, y: 84, width: 288, height: 160 },
				8
			)
		).toEqual({ x: 176, y: 92 });
	});

	it('calculates a merged anchor from only the members it receives', () => {
		const visibleMembers = [{ x: 120, y: 220 }, { x: 200, y: 200 }];
		const offscreenMember = { x: 900, y: 30 };

		expect(
			mergedBubblePreferredAnchor(visibleMembers, { width: 160, height: 48 }, { x: 16, y: 84, width: 288, height: 160 })
		).toEqual({ x: 80, y: 140 });
		expect(
			mergedBubblePreferredAnchor(
				[...visibleMembers, offscreenMember],
				{ width: 160, height: 48 },
				{ x: 16, y: 84, width: 288, height: 160 }
			)
		).not.toEqual({ x: 80, y: 140 });
	});
});
