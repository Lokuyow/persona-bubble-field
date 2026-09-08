import { describe, expect, it } from 'vitest';
import { advanceMergedAnchorHistory } from './mergedAnchorHistory';

describe('merged anchor history', () => {
	it('records visible placements and updates changed coordinates without mutating history', () => {
		const previous = Object.freeze({ a: Object.freeze({ x: 1, y: 2 }) });
		const placements = new Map([['a', { x: 3, y: 4 }], ['b', { x: 5, y: 6 }]]);
		expect(advanceMergedAnchorHistory(previous, new Set(['a', 'b']), placements))
			.toEqual({ a: { x: 3, y: 4 }, b: { x: 5, y: 6 } });
		expect(previous).toEqual({ a: { x: 1, y: 2 } });
		expect(placements.size).toBe(2);
	});

	it('retains the last placement when all members are offscreen and returns the same unchanged history', () => {
		const previous = { a: { x: 1, y: 2 } };
		expect(advanceMergedAnchorHistory(previous, new Set(['a']), new Map())).toBe(previous);
		expect(advanceMergedAnchorHistory(previous, new Set(['a']), new Map([['a', { x: 1, y: 2 }]]))).toBe(previous);
	});

	it('removes expired bubbles and does not revive them through stale placements', () => {
		const previous = { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } };
		expect(advanceMergedAnchorHistory(previous, new Set(['b']), new Map([['a', { x: 5, y: 6 }]])))
			.toEqual({ b: { x: 3, y: 4 } });
	});
});
