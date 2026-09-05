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
});
