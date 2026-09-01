import type { SpeechType } from './conversation';

const PATH_INSET = 2;

type Point = Readonly<{ x: number; y: number }>;

function safeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(PATH_INSET * 2 + 1, value) : PATH_INSET * 2 + 1;
}

function segmentCount(length: number): number {
	return Math.min(7, Math.max(3, Math.round(length / 42)));
}

function edgePoints(
	start: Point,
	end: Point,
	segments: number,
	depth: number,
	axis: 'horizontal' | 'vertical',
	baseTowardInterior: boolean
): Point[] {
	return Array.from({ length: segments + 1 }, (_, index) => {
		const progress = index / segments;
		const base = {
			x: start.x + (end.x - start.x) * progress,
			y: start.y + (end.y - start.y) * progress
		};
		if (index === 0 || index === segments) return base;
		const offset = index % 2 === 0 ? 0 : depth * (baseTowardInterior ? 1 : -1);
		return axis === 'horizontal' ? { x: base.x, y: base.y + offset } : { x: base.x + offset, y: base.y };
	});
}

function perimeterPoints(width: number, height: number, depth: number): Point[] {
	const right = width - PATH_INSET;
	const bottom = height - PATH_INSET;
	const topSegments = segmentCount(width - PATH_INSET * 2);
	const sideSegments = segmentCount(height - PATH_INSET * 2);
	return [
		...edgePoints({ x: PATH_INSET, y: PATH_INSET }, { x: right, y: PATH_INSET }, topSegments, depth, 'horizontal', true),
		...edgePoints({ x: right, y: PATH_INSET }, { x: right, y: bottom }, sideSegments, depth, 'vertical', false).slice(1),
		...edgePoints({ x: right, y: bottom }, { x: PATH_INSET, y: bottom }, topSegments, depth, 'horizontal', false).slice(1),
		...edgePoints({ x: PATH_INSET, y: bottom }, { x: PATH_INSET, y: PATH_INSET }, sideSegments, depth, 'vertical', true).slice(1, -1)
	];
}

function polygonPath(points: readonly Point[]): string {
	return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ')} Z`;
}

function quadraticCloudPath(points: readonly Point[]): string {
	const midpoint = (first: Point, second: Point): Point => ({
		x: (first.x + second.x) / 2,
		y: (first.y + second.y) / 2
	});
	const start = midpoint(points.at(-1)!, points[0]);
	let path = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)}`;
	for (let index = 0; index < points.length; index += 1) {
		const control = points[index];
		const end = midpoint(control, points[(index + 1) % points.length]);
		path += ` Q ${control.x.toFixed(2)} ${control.y.toFixed(2)} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
	}
	return `${path} Z`;
}

export function createSpeechBubblePath(speechType: SpeechType, width: number, height: number): string | null {
	if (speechType === 'normal') return null;
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	const depth = speechType === 'monologue'
		? Math.min(14, Math.max(6, Math.min(safeWidth, safeHeight) * 0.18))
		: Math.min(8, Math.max(4, Math.min(safeWidth, safeHeight) * 0.12));
	const points = perimeterPoints(safeWidth, safeHeight, depth);
	return speechType === 'shout' ? polygonPath(points) : quadraticCloudPath(points);
}
