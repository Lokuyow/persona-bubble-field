import { describe, expect, it } from 'vitest';
import {
	clampCamera,
	clampToBounds,
	clampToViewport,
	DESKTOP_CELL_SIZE,
	fieldLocalToViewport,
	formatCanonicalGridPosition,
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
	parseCanonicalGridPosition,
	placeBubbles,
	worldToScreen
} from './geometry';

function overlapsWithGap(
	first: { anchor: { x: number; y: number }; size: { width: number; height: number } },
	second: { anchor: { x: number; y: number }; size: { width: number; height: number } },
	gap = 8
) {
	return (
		first.anchor.x < second.anchor.x + second.size.width + gap &&
		first.anchor.x + first.size.width + gap > second.anchor.x &&
		first.anchor.y < second.anchor.y + second.size.height + gap &&
		first.anchor.y + first.size.height + gap > second.anchor.y
	);
}

function overlapAreaWithGap(
	first: { anchor: { x: number; y: number }; size: { width: number; height: number } },
	second: { anchor: { x: number; y: number }; size: { width: number; height: number } },
	gap = 8
) {
	const width = Math.min(first.anchor.x + first.size.width, second.anchor.x + second.size.width + gap) -
		Math.max(first.anchor.x, second.anchor.x - gap);
	const height = Math.min(first.anchor.y + first.size.height, second.anchor.y + second.size.height + gap) -
		Math.max(first.anchor.y, second.anchor.y - gap);

	return Math.max(0, width) * Math.max(0, height);
}

describe('field geometry', () => {
	it('round-trips canonical grid positions', () => {
		const position = { x: 15, y: 7 };

		expect(formatCanonicalGridPosition(position)).toBe('15:7');
		expect(parseCanonicalGridPosition('15:7')).toEqual(position);
	});

	it.each(['00:0', '01:2', '+1:2', '-1:2', '1:-2', '1.5:2', '1,2', '1:2:3'])
		('rejects non-canonical grid position %s', (value) => {
			expect(parseCanonicalGridPosition(value)).toBeNull();
		});

	it('rejects grid positions that cannot be represented safely', () => {
		expect(parseCanonicalGridPosition('9007199254740992:0')).toBeNull();
		expect(() => formatCanonicalGridPosition({ x: Number.MAX_SAFE_INTEGER + 1, y: 0 })).toThrow(TypeError);
	});

	it('selects the prototype cell size by viewport width', () => {
		expect(getResponsiveCellSize(360)).toBe(MOBILE_CELL_SIZE);
		expect(getResponsiveCellSize(700)).toBe(MOBILE_CELL_SIZE);
		expect(getResponsiveCellSize(701)).toBe(DESKTOP_CELL_SIZE);
	});

	it('uses the mobile cell size for grid to world conversion at 360px', () => {
		expect(gridToWorld({ x: 1, y: 2 }, getResponsiveCellSize(360))).toEqual({ x: 75, y: 125 });
	});

	it('keeps responsive field size and camera projection on the same cell size', () => {
		const cellSize = getResponsiveCellSize(360);
		const field = getFieldWorldSize({ columns: 16, rows: 8, cellSize });
		const player = gridToWorld({ x: 7, y: 4 }, cellSize);
		const camera = clampCamera(player, { width: 360, height: 740 }, field);

		expect(field).toEqual({ width: 800, height: 400 });
		expect(worldToScreen(player, camera).x).toBe(180);
	});

	it('separates field area from speech area and clamps the mobile world to it', () => {
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
		expect(fieldArea.x).toBe(8);
		expect(fieldArea.width).toBe(viewport.width - 16);
		expect(fieldArea.height).toBe(viewport.height - fieldArea.y);
		expect(camera.y).toBe(-40);
		expect(topRow.y).toBe(fieldArea.y + MOBILE_CELL_SIZE / 2 + 40);
		expect(getActualFieldTop(fieldArea, camera)).toBe(fieldArea.y - camera.y);
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

	it('keeps an isolated bubble at its preferred anchor', () => {
		const bounds = { x: 0, y: 0, width: 320, height: 200 };
		const result = placeBubbles(
			[{ id: 'isolated', preferred: { x: 36, y: 52 }, size: { width: 80, height: 32 } }],
			bounds,
			56
		);

		expect(result).toEqual([{ id: 'isolated', anchor: { x: 36, y: 52 } }]);
	});

	it('is deterministic for the same inputs, including stable ordering', () => {
		const items = [
			{ id: 'merged-note', preferred: { x: 100, y: 70 }, size: { width: 160, height: 48 } },
			{ id: 'normal-note', preferred: { x: 100, y: 70 }, size: { width: 120, height: 44 } },
			{ id: 'third-note', preferred: { x: 140, y: 70 }, size: { width: 100, height: 36 } }
		];
		const bounds = { x: 0, y: 0, width: 360, height: 240 };

		expect(placeBubbles(items, bounds, 56)).toEqual(placeBubbles(items, bounds, 56));
		expect(placeBubbles(items, bounds, 56).map(({ id }) => id)).toEqual([
			'merged-note',
			'normal-note',
			'third-note'
		]);
	});

	it('keeps every candidate result inside the speech bounds', () => {
		const bounds = { x: 16, y: 84, width: 328, height: 176 };
		const result = placeBubbles(
			[
				{ id: 'left', preferred: { x: -200, y: -80 }, size: { width: 184, height: 54 } },
				{ id: 'right', preferred: { x: 300, y: 400 }, size: { width: 218, height: 58 } }
			],
			bounds,
			56
		);

		for (const placement of result) {
			const item = [
				{ id: 'left', size: { width: 184, height: 54 } },
				{ id: 'right', size: { width: 218, height: 58 } }
			].find((candidate) => candidate.id === placement.id)!;
			expect(placement.anchor.x).toBeGreaterThanOrEqual(bounds.x);
			expect(placement.anchor.y).toBeGreaterThanOrEqual(bounds.y);
			expect(placement.anchor.x + item.size.width).toBeLessThanOrEqual(bounds.x + bounds.width);
			expect(placement.anchor.y + item.size.height).toBeLessThanOrEqual(bounds.y + bounds.height);
		}
	});

	it('resolves a feasible three-bubble fixture without gap collisions', () => {
		const items = [
			{ id: 'first', preferred: { x: 100, y: 60 }, size: { width: 80, height: 30 } },
			{ id: 'second', preferred: { x: 100, y: 60 }, size: { width: 80, height: 30 } },
			{ id: 'third', preferred: { x: 100, y: 60 }, size: { width: 80, height: 30 } }
		];
		const placements = placeBubbles(items, { x: 0, y: 0, width: 320, height: 200 }, 56);

		for (let first = 0; first < placements.length; first += 1) {
			for (let second = first + 1; second < placements.length; second += 1) {
				const firstItem = { ...items.find((item) => item.id === placements[first].id)!, anchor: placements[first].anchor };
				const secondItem = { ...items.find((item) => item.id === placements[second].id)!, anchor: placements[second].anchor };
				expect(overlapsWithGap(firstItem, secondItem)).toBe(false);
			}
		}
	});

	it('repairs the current 360px three-bubble fixture with edge-aligned reflow', () => {
		const items = [
			{ id: 'merged-note', preferred: { x: 126, y: 122 }, size: { width: 218, height: 58 } },
			{ id: 'upper-normal', preferred: { x: 16, y: 144 }, size: { width: 184, height: 54 } },
			{ id: 'lower-normal', preferred: { x: 16, y: 202 }, size: { width: 184, height: 54 } }
		];
		const placements = placeBubbles(items, { x: 16, y: 84, width: 328, height: 192 }, MOBILE_CELL_SIZE);

		for (let first = 0; first < placements.length; first += 1) {
			for (let second = first + 1; second < placements.length; second += 1) {
				const firstItem = { ...items.find((item) => item.id === placements[first].id)!, anchor: placements[first].anchor };
				const secondItem = { ...items.find((item) => item.id === placements[second].id)!, anchor: placements[second].anchor };
				expect(overlapsWithGap(firstItem, secondItem)).toBe(false);
			}
		}
	});

	it('handles mixed normal and merged sizes in the 360px collision fixture', () => {
		const items = [
			{ id: 'haru-note', preferred: { x: 88, y: 150 }, size: { width: 184, height: 54 } },
			{ id: 'merged-note', preferred: { x: 72, y: 150 }, size: { width: 218, height: 58 } }
		];
		const bounds = { x: 16, y: 84, width: 328, height: 176 };
		const placements = placeBubbles(items, bounds, MOBILE_CELL_SIZE);

		expect(overlapsWithGap(
			{ ...items[0], anchor: placements.find(({ id }) => id === items[0].id)!.anchor },
			{ ...items[1], anchor: placements.find(({ id }) => id === items[1].id)!.anchor }
		)).toBe(false);
	});

	it('preserves upper-to-lower spatial correspondence when bubbles do not collide', () => {
		const items = [
			{ id: 'upper', preferred: { x: 40, y: 90 }, size: { width: 100, height: 36 } },
			{ id: 'lower', preferred: { x: 220, y: 180 }, size: { width: 100, height: 36 } }
		];
		const placements = placeBubbles(items, { x: 0, y: 0, width: 360, height: 260 }, 56);

		expect(placements.find(({ id }) => id === 'upper')!.anchor.y).toBe(90);
		expect(placements.find(({ id }) => id === 'lower')!.anchor.y).toBe(180);
	});

	it('deduplicates clamped edge candidates safely', () => {
		const bounds = { x: 0, y: 0, width: 100, height: 80 };
		const items = [
			{ id: 'edge-a', preferred: { x: 90, y: 70 }, size: { width: 90, height: 70 } },
			{ id: 'edge-b', preferred: { x: 90, y: 70 }, size: { width: 90, height: 70 } }
		];

		expect(placeBubbles(items, bounds, 56)).toHaveLength(2);
		expect(placeBubbles(items, bounds, 56)[0].anchor).toEqual({ x: 10, y: 10 });
	});

	it('uses candidate order to resolve equal-distance ties', () => {
		const items = [
			{ id: 'first', preferred: { x: 100, y: 100 }, size: { width: 50, height: 50 } },
			{ id: 'second', preferred: { x: 100, y: 100 }, size: { width: 50, height: 50 } }
		];

		expect(placeBubbles(items, { x: 0, y: 0, width: 300, height: 300 }, 56)).toEqual([
			{ id: 'first', anchor: { x: 100, y: 100 } },
			{ id: 'second', anchor: { x: 100, y: 42 } }
	]);
	});

	it('keeps dense fixed-bubble scoring deterministic with bounded repair candidates', () => {
		const fixed = Array.from({ length: 12 }, (_, index) => ({
			id: `fixed-${String(index).padStart(2, '0')}`,
			preferred: { x: 100, y: 100 },
			size: { width: 80, height: 30 }
		}));
		const target = { id: 'target', preferred: { x: 100, y: 100 }, size: { width: 80, height: 30 } };
		const bounds = { x: 0, y: 0, width: 320, height: 320 };
		const denseInput = [...fixed, target];
		const first = placeBubbles(denseInput, bounds, 56);
		const second = placeBubbles(denseInput, bounds, 56);
		const targetPlacement = first.find(({ id }) => id === target.id)!;

		expect(first).toEqual(second);
		expect(first).toHaveLength(13);
		expect(targetPlacement.anchor).not.toEqual(target.preferred);
		expect(targetPlacement.anchor).toEqual(second.find(({ id }) => id === target.id)!.anchor);
	});

	it('returns all bubbles in narrow bounds and never worsens preferred overlap', () => {
		const bounds = { x: 0, y: 0, width: 120, height: 50 };
		const items = [
			{ id: 'first', preferred: { x: 0, y: 0 }, size: { width: 100, height: 40 } },
			{ id: 'second', preferred: { x: 0, y: 0 }, size: { width: 100, height: 40 } }
		];
		const placements = placeBubbles(items, bounds, 56);
		const selected = { ...items[1], anchor: placements.find(({ id }) => id === 'second')!.anchor };
		const preferred = { ...items[1], anchor: { x: 0, y: 0 } };
		const first = { ...items[0], anchor: placements.find(({ id }) => id === 'first')!.anchor };

		expect(placements).toHaveLength(items.length);
		expect(overlapsWithGap(first, selected)).toBe(true);
		expect(overlapAreaWithGap(first, selected)).toBeLessThanOrEqual(overlapAreaWithGap(first, preferred));
	});
});
