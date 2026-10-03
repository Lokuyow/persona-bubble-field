import { describe, expect, it } from 'vitest';
import { tailGeometry, taperedBandGeometry, liveTailConnections, bubbleSourceTailConnection, tailOutlineOpeningPoints } from './bubblePresentation';

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


describe('live directional tails', () => {
	it('shortens source clearance in a narrow live gap without crossing the bubble', () => {
		const connection = liveTailConnections({ x: 100, y: 100 }, { width: 80, height: 40 }, [{ id: 'speaker', bounds: { x: 120, y: 142, width: 40, height: 40 } }], 'normal', false)[0];
		expect(connection.tail.target).toEqual({ x: 140, y: 141 });
		expect(connection.seam).toEqual({ x: 40, y: 40 });
	});
	it.each(['normal', 'shout', 'monologue'] as const)('does not cross either body after a diagonal Trace-root side fallback (%s)', (speechType) => {
		const anchor = { x: 340, y: 0 }, size = { width: 80, height: 40 };
		const source = { x: 420, y: 20, width: 100, height: 100 };
		const connection = bubbleSourceTailConnection(anchor, size, source, speechType, 'root');
		const seam = { x: anchor.x + connection.seam.x, y: anchor.y + connection.seam.y };
		for (const progress of [0.01, 0.25, 0.5, 0.75, 0.99]) {
			const point = { x: seam.x + (connection.tail.target.x - seam.x) * progress, y: seam.y + (connection.tail.target.y - seam.y) * progress };
			expect(point.x > anchor.x && point.x < anchor.x + size.width && point.y > anchor.y && point.y < anchor.y + size.height).toBe(false);
			expect(point.x > source.x && point.x < source.x + source.width && point.y > source.y && point.y < source.y + source.height).toBe(false);
		}
	});
	for (const speechType of ['normal', 'shout', 'monologue'] as const) {
		for (const [edge, screen] of [['bottom', { x: 200, y: 350 }], ['top', { x: 200, y: 50 }], ['right', { x: 400, y: 200 }], ['left', { x: 0, y: 200 }]] as const) {
			it(`connects live and Trace-root ${edge} ${speechType} tails to the facing character edge`, () => {
				for (const clearance of [4, 0]) {
					const anchor = { x: 140, y: 170 }, size = { width: 120, height: 60 };
					const bounds = { x: screen.x - 25, y: screen.y - 25, width: 50, height: 50 };
					const connection = clearance === 0 ? bubbleSourceTailConnection(anchor, size, bounds, speechType, 'speaker')
						: liveTailConnections(anchor, size, [{ id: 'speaker', bounds }], speechType, false)[0];
					expect(connection.edge).toBe(edge);
					expect(Number.isFinite(connection.seam.x) && Number.isFinite(connection.seam.y)).toBe(true);
					if (edge === 'top' || edge === 'bottom') expect(connection.seam.y).toBe(edge === 'top' ? 0 : 60);
					else expect(connection.seam.x).toBe(edge === 'left' ? 0 : 120);
					expect(connection.tail.target).toEqual(edge === 'bottom' ? { x: screen.x, y: screen.y - 25 - clearance }
						: edge === 'top' ? { x: screen.x, y: screen.y + 25 + clearance }
						: edge === 'right' ? { x: screen.x - 25 - clearance, y: screen.y } : { x: screen.x + 25 + clearance, y: screen.y });
					const seam = { x: connection.seam.x + 140, y: connection.seam.y + 170 };
					for (const progress of [0.01, 0.25, 0.5, 0.75, 1]) {
						const point = { x: seam.x + (connection.tail.target.x - seam.x) * progress, y: seam.y + (connection.tail.target.y - seam.y) * progress };
						expect(point.x > 140 && point.x < 260 && point.y > 170 && point.y < 230).toBe(false);
						expect(point.x > screen.x - 25 && point.x < screen.x + 25 && point.y > screen.y - 25 && point.y < screen.y + 25).toBe(false);
					}
					expect(tailOutlineOpeningPoints(connection.tail, { x: 140, y: 170 })).toBe([connection.tail.rootLeft, connection.tail.rootRight, connection.tail.target].map((point) => `${point.x - 140},${point.y - 170}`).join(' '));
				}
			});
		}
	}
	it('distributes merged roots on each occupied edge', () => {
		const connections = liveTailConnections({ x: 100, y: 100 }, { width: 180, height: 60 }, [120, 250].map((x, index) => ({ id: String(index), bounds: { x, y: 250, width: 50, height: 50 } })), 'normal', true);
		expect(connections.map((connection) => connection.edge)).toEqual(['bottom', 'bottom']);
		expect(new Set(connections.map((connection) => connection.seam.x)).size).toBe(2);
	});
});
