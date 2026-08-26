import { describe, expect, it } from 'vitest';
import {
	clampCamera,
	clampToViewport,
	getFieldWorldSize,
	gridToWorld,
	mergedBubblePreferredAnchor,
	moveOneCell,
	normalBubblePreferredAnchor,
	worldToScreen
} from './geometry';

describe('field geometry', () => {
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

	it('places a normal bubble above its speaker', () => {
		expect(normalBubblePreferredAnchor({ x: 200, y: 180 }, { width: 120, height: 44 }, 16)).toEqual({
		 x: 140,
		 y: 120
	});
	});

	it('centers a merged bubble above its members', () => {
		expect(
			mergedBubblePreferredAnchor(
				[
					{ x: 120, y: 240 },
					{ x: 200, y: 200 },
					{ x: 280, y: 240 }
				],
				{ width: 160, height: 48 },
				16
			)
		).toEqual({ x: 120, y: 136 });
	});

	it('keeps bubble anchors inside the viewport', () => {
		expect(clampToViewport({ x: -40, y: 500 }, { width: 120, height: 44 }, { width: 320, height: 240 }, 12)).toEqual({
		 x: 12,
		 y: 184
	});
	});
});
