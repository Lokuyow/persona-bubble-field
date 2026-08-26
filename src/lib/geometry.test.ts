import { describe, expect, it } from 'vitest';
import {
	clampCamera,
	clampToBounds,
	clampToViewport,
	DESKTOP_CELL_SIZE,
	fieldLocalToViewport,
	getActualFieldTop,
	getFieldAreaBounds,
	getFieldWorldSize,
	getResponsiveCellSize,
	gridToWorld,
	logicalFieldYToSpeechY,
	MOBILE_CELL_SIZE,
	mergedBubblePreferredAnchor,
	moveOneCell,
	normalBubblePreferredAnchor,
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

	it('separates field area from speech area and uses field area height for the camera', () => {
		const viewport = { width: 360, height: 740 };
		const speechArea = { x: 16, y: 84, width: 328, height: 176 };
		const fieldArea = getFieldAreaBounds(viewport, speechArea);
		const cellSize = getResponsiveCellSize(viewport.width);
		const fieldWorld = getFieldWorldSize({ columns: 16, rows: 8, cellSize });
		const player = gridToWorld({ x: 7, y: 4 }, cellSize);
		const camera = clampCamera(player, { width: fieldArea.width, height: fieldArea.height }, fieldWorld);
		const topRow = fieldLocalToViewport(
			worldToScreen(gridToWorld({ x: 0, y: 0 }, cellSize), camera),
			fieldArea
		);

		expect(fieldArea.y).toBe(speechArea.y + speechArea.height);
		expect(fieldArea.height).toBe(viewport.height - fieldArea.y);
		expect(camera.y).toBe((fieldWorld.height - fieldArea.height) / 2);
		expect(topRow.y).toBeGreaterThanOrEqual(fieldArea.y);
		expect(getActualFieldTop(fieldArea, camera)).toBe(fieldArea.y + (fieldArea.height - fieldWorld.height) / 2);
	});

	it('extends the effective speech area to the actual centered field top', () => {
		const fieldArea = { x: 0, y: 260, width: 360, height: 480 };

		expect(getActualFieldTop(fieldArea, { x: 0, y: -16 })).toBe(276);
		expect(getActualFieldTop(fieldArea, { x: 0, y: 0 })).toBe(fieldArea.y);
		expect(getActualFieldTop(fieldArea, { x: 0, y: 16 })).toBe(fieldArea.y);
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

	it('maps logical field Y into the speech area while keeping the bubble inside', () => {
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };
		const bubble = { width: 120, height: 44 };

		const top = logicalFieldYToSpeechY(0, 8, bubble, speechArea);
		const bottom = logicalFieldYToSpeechY(7, 8, bubble, speechArea);

		expect(top).toBeLessThan(bottom);
		expect(top).toBeGreaterThanOrEqual(speechArea.y);
		expect(bottom + bubble.height).toBeLessThanOrEqual(speechArea.y + speechArea.height);
	});

	it('keeps normal bubble X tied to the speaker while logical Y changes only bubble Y', () => {
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };
		const bubble = { width: 120, height: 44 };
		const top = normalBubblePreferredAnchor(200, 0, 8, bubble, speechArea);
		const bottom = normalBubblePreferredAnchor(200, 7, 8, bubble, speechArea);

		expect(top.x).toBe(bottom.x);
		expect(top.y).toBeLessThan(bottom.y);
	});

	it('centers a merged bubble horizontally from its members', () => {
		expect(
			mergedBubblePreferredAnchor(
				[
					{ x: 120, y: 240 },
					{ x: 200, y: 200 },
					{ x: 280, y: 240 }
				],
				8,
				{ width: 160, height: 48 },
				{ x: 16, y: 84, width: 288, height: 160 }
			)
		).toMatchObject({ x: 120 });
		expect(
			mergedBubblePreferredAnchor(
				[{ x: 120, y: 2 }, { x: 200, y: 2 }, { x: 280, y: 2 }],
				8,
				{ width: 160, height: 48 },
				{ x: 16, y: 84, width: 288, height: 160 }
			).y
		).toBe(logicalFieldYToSpeechY(2, 8, { width: 160, height: 48 }, { x: 16, y: 84, width: 288, height: 160 }));
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
		const visibleMembers = [{ x: 120, y: 2 }, { x: 200, y: 4 }];
		const offscreenMember = { x: 900, y: 0 };

		expect(
			mergedBubblePreferredAnchor(visibleMembers, 8, { width: 160, height: 48 }, { x: 16, y: 84, width: 288, height: 160 })
		).toMatchObject({ x: 80 });
		expect(
			mergedBubblePreferredAnchor(visibleMembers, 8, { width: 160, height: 48 }, { x: 16, y: 84, width: 288, height: 160 }).y
		).toBe(logicalFieldYToSpeechY((2 + 4) / 2, 8, { width: 160, height: 48 }, { x: 16, y: 84, width: 288, height: 160 }));
		expect(
			mergedBubblePreferredAnchor(
				[...visibleMembers, offscreenMember],
				8,
				{ width: 160, height: 48 },
				{ x: 16, y: 84, width: 288, height: 160 }
			)
		).not.toMatchObject({ x: 80 });
	});

	it('uses the visible members logical Y average for a merged bubble', () => {
		const bubble = { width: 160, height: 48 };
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };
		const anchor = mergedBubblePreferredAnchor([{ x: 120, y: 0 }, { x: 200, y: 6 }], 8, bubble, speechArea);

		expect(anchor.y).toBe(logicalFieldYToSpeechY(3, 8, bubble, speechArea));
	});

	it('keeps logical bubble ordering independent of camera Y', () => {
		const speechArea = { x: 16, y: 84, width: 288, height: 160 };
		const bubble = { width: 120, height: 44 };
		const first = normalBubblePreferredAnchor(200, 2, 8, bubble, speechArea);
		const second = normalBubblePreferredAnchor(200, 5, 8, bubble, speechArea);

		expect(first.x).toBe(second.x);
		expect(first.y).toBeLessThan(second.y);
	});
});
