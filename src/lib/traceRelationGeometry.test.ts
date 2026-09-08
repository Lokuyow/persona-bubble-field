import { describe, expect, it } from 'vitest';
import { traceRelationEndpoints } from './traceRelationGeometry';

describe('Trace relation geometry', () => {
	it('insets both endpoints toward the opposite surface while preserving direction', () => {
		const parent = { x: 100, y: 200 };
		const child = { x: 300, y: 350 };
		const result = traceRelationEndpoints(parent, child);
		const distance = Math.hypot(child.x - parent.x, child.y - parent.y);
		const startOffset = Math.hypot(result.start.x - parent.x, result.start.y - parent.y);
		const endOffset = Math.hypot(child.x - result.end.x, child.y - result.end.y);
		expect(startOffset).toBeGreaterThan(0);
		expect(endOffset).toBeGreaterThan(0);
		expect(startOffset).toBeLessThan(distance / 2);
		expect(endOffset).toBeLessThan(distance / 2);
		expect(Math.hypot(result.end.x - result.start.x, result.end.y - result.start.y)).toBeGreaterThan(0);
		expect((result.start.x - parent.x) * (child.x - parent.x) + (result.start.y - parent.y) * (child.y - parent.y)).toBeGreaterThan(0);
		expect((child.x - result.end.x) * (child.x - parent.x) + (child.y - result.end.y) * (child.y - parent.y)).toBeGreaterThan(0);
	});

	it('clamps the inset for a very short relation without reversing endpoints', () => {
		const result = traceRelationEndpoints({ x: 0, y: 0 }, { x: 6, y: 8 });
		expect(result.start.x).toBeGreaterThan(0);
		expect(result.start.y).toBeGreaterThan(0);
		expect(result.end.x).toBeLessThan(6);
		expect(result.end.y).toBeLessThan(8);
		expect(Math.hypot(result.end.x - result.start.x, result.end.y - result.start.y)).toBeGreaterThan(0);
	});
});
