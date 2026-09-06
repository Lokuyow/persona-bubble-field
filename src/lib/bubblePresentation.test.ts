import { describe, expect, it } from 'vitest';
import { tailGeometry, taperedBandGeometry } from './bubblePresentation';

describe('tapered bubble geometry', () => {
	it('keeps both band midpoints, width ordering, and finite zero-length output', () => {
		const band = taperedBandGeometry({ x: 10, y: 20 }, { x: 50, y: 20 }, 8, 2);
		expect({
			start: { x: (band.startLeft.x + band.startRight.x) / 2, y: (band.startLeft.y + band.startRight.y) / 2 },
			end: { x: (band.endLeft.x + band.endRight.x) / 2, y: (band.endLeft.y + band.endRight.y) / 2 },
			startWidth: Math.hypot(band.startLeft.x - band.startRight.x, band.startLeft.y - band.startRight.y),
			endWidth: Math.hypot(band.endLeft.x - band.endRight.x, band.endLeft.y - band.endRight.y)
		}).toEqual({ start: { x: 10, y: 20 }, end: { x: 50, y: 20 }, startWidth: 8, endWidth: 2 });
		const zero = taperedBandGeometry({ x: 12, y: 9 }, { x: 12, y: 9 }, 7, 3);
		expect(Object.values(zero).flatMap((value) => typeof value === 'string' ? value.split(/[ ,]+/).map(Number) : [value.x, value.y]).every(Number.isFinite)).toBe(true);
	});

	it('preserves representative normal, merged, special, and Trace-root tail geometry', () => {
		const normal = tailGeometry({ x: 100, y: 200 }, { x: 100, y: 300 }, 11, 2);
		expect(normal).toMatchObject({
			points: '94.5,198 105.5,198 100,300',
			outlinePath: 'M 94.5 198 L 100 300 L 105.5 198',
			rootLeft: { x: 94.5, y: 198 }, rootRight: { x: 105.5, y: 198 }, target: { x: 100, y: 300 }, seamOffsetX: 0
		});
		const merged = tailGeometry({ x: 200, y: 100 }, { x: 260, y: 100 }, 9, 2);
		expect(merged).toMatchObject({
			points: '198,104.5 198,95.5 260,100',
			outlinePath: 'M 198 104.5 L 260 100 L 198 95.5',
			rootLeft: { x: 198, y: 104.5 }, rootRight: { x: 198, y: 95.5 }, target: { x: 260, y: 100 }, seamOffsetX: -2
		});
		const special = tailGeometry({ x: 100, y: 100 }, { x: 100, y: 200 }, 11, 2, 26);
		expect(special).toMatchObject({
			rootLeft: { x: 93.07, y: 71.48 }, rootRight: { x: 106.93, y: 71.48 }, target: { x: 100, y: 200 }, seamOffsetX: 0
		});
		expect(special.points).toBe('93.07,71.48 106.93,71.48 100,200');
		const traceRoot = tailGeometry({ x: 120, y: 80 }, { x: 120, y: 180 }, 11, 2);
		expect(traceRoot).toMatchObject({
			points: '114.5,78 125.5,78 120,180',
			outlinePath: 'M 114.5 78 L 120 180 L 125.5 78',
			rootLeft: { x: 114.5, y: 78 }, rootRight: { x: 125.5, y: 78 }, target: { x: 120, y: 180 }, seamOffsetX: 0
		});
	});
});
