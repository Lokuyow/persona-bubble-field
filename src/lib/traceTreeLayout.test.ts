import { describe, expect, it } from 'vitest';
import { distinctTraceAnchor, traceChildPreferred } from './traceTreeLayout';

describe('trace tree layout', () => {
	it('uses right-bottom, left-bottom, right-top, left-top slots then outer rings', () => {
		const parent = { anchor: { x: 100, y: 100 }, footprint: { width: 80, height: 40 } };
		const child = { width: 60, height: 30 };
		expect([0, 1, 2, 3, 4].map((index) => traceChildPreferred(parent, child, index))).toEqual([
			{ x: 190, y: 150 }, { x: 30, y: 150 }, { x: 190, y: 60 }, { x: 30, y: 60 }, { x: 260, y: 190 }
		]);
	});

	it('uses outer and edge fallbacks when clamp would reuse an anchor', () => {
		const bounds = { x: 0, y: 0, width: 300, height: 200 };
		const footprint = { width: 80, height: 40 };
		const first = distinctTraceAnchor({ x: 280, y: 190 }, footprint, bounds, [], 0);
		const second = distinctTraceAnchor({ x: 280, y: 190 }, footprint, bounds, [first], 1);
		expect(second).not.toEqual(first);
		expect(second.x).toBeGreaterThanOrEqual(bounds.x);
		expect(second.y).toBeGreaterThanOrEqual(bounds.y);
	});

	it('does not reuse a visually rounded sub-pixel anchor', () => {
		const bounds = { x: 0, y: 0, width: 500, height: 300 };
		const footprint = { width: 80, height: 40 };
		const occupied = { x: 220.4, y: 160.4 };
		const next = distinctTraceAnchor({ x: 220.6, y: 160.6 }, footprint, bounds, [occupied], 0);
		expect(Math.round(next.x)).not.toBe(Math.round(occupied.x));
		expect(Math.round(next.y)).not.toBe(Math.round(occupied.y));
	});

	it('searches the remaining legal positions when a narrow area clamps every ranked slot', () => {
		const bounds = { x: 0, y: 0, width: 84, height: 40 };
		const footprint = { width: 80, height: 80 };
		const anchors: Array<{ x: number; y: number }> = [];
		for (let rank = 0; rank < 5; rank += 1) {
			anchors.push(distinctTraceAnchor({ x: 80, y: 0 }, footprint, bounds, anchors, rank));
		}
		expect(new Set(anchors.map(({ x, y }) => `${Math.round(x)},${Math.round(y)}`)).size).toBe(anchors.length);
	});
});
