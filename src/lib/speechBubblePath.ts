import type { SpeechType } from './conversation';

const PATH_INSET = 1;
const OUTLINE_WIDTH = 1;
const SHOUT_SPACING = 22;
const SHOUT_BASE_LENGTH = 14;
const SHOUT_VARIANCE = 0.2;
const CLOUD_SPACING = 50;
const CLOUD_BASE_SIZE = 10;
const CLOUD_VARIANCE = 0.7;

type Point = Readonly<{ x: number; y: number }>;

export type SpeechBubbleVisualBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
export type SpeechBubbleShapeConstraints = Readonly<{ maxBleedX: number; maxBleedY: number }>;
export type SpeechBubbleShape = Readonly<{
	path: string;
	bounds: SpeechBubbleVisualBounds;
	metadata: Readonly<{
		count: number;
		minimumOutwardSize: number;
		maximumOutwardSize: number;
		outwardSizes: readonly number[];
		points: readonly Point[];
		valleys: readonly Point[];
		center?: Point;
		outwardRays?: readonly Readonly<{ base: Point; point: Point; direction: Point }>[];
	}>;
}>;

type PerimeterSampler = Readonly<{
	total: number;
	pointAt: (distance: number) => Point;
	frameAt: (distance: number) => Readonly<{ point: Point; normal: Point }>;
}>;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function mod(value: number, divisor: number): number {
	return ((value % divisor) + divisor) % divisor;
}

function safeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(PATH_INSET * 2 + 1, value) : PATH_INSET * 2 + 1;
}

function formatNumber(value: number): string {
	return String(Number(value.toFixed(2)));
}

function formatPoint(point: Point): string {
	return `${formatNumber(point.x)} ${formatNumber(point.y)}`;
}

function hash32(value: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let value = Math.imul(state ^ (state >>> 15), 1 | state);
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
		return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function normalize(x: number, y: number): Point {
	const length = Math.hypot(x, y) || 1;
	return { x: x / length, y: y / length };
}

function roundedRectPoints(width: number, height: number, radius: number): Point[] {
	const x0 = PATH_INSET;
	const y0 = PATH_INSET;
	const x1 = width - PATH_INSET;
	const y1 = height - PATH_INSET;
	const clampedRadius = clamp(radius, 5, Math.max(5, Math.min(width, height) / 2 - 2));
	const top = x1 - x0 - clampedRadius * 2;
	const side = y1 - y0 - clampedRadius * 2;
	const topCount = Math.max(10, Math.round(top / 4));
	const sideCount = Math.max(4, Math.round(side / 4));
	const arcCount = 16;
	const points: Point[] = [];
	const add = (x: number, y: number) => points.push({ x, y });

	for (let index = 0; index <= topCount; index += 1) add(x0 + clampedRadius + top * (index / topCount), y0);
	for (let index = 1; index <= arcCount; index += 1) {
		const angle = -Math.PI / 2 + (Math.PI / 2) * (index / arcCount);
		add(x1 - clampedRadius + Math.cos(angle) * clampedRadius, y0 + clampedRadius + Math.sin(angle) * clampedRadius);
	}
	for (let index = 1; index <= sideCount; index += 1) add(x1, y0 + clampedRadius + side * (index / sideCount));
	for (let index = 1; index <= arcCount; index += 1) {
		const angle = (Math.PI / 2) * (index / arcCount);
		add(x1 - clampedRadius + Math.cos(angle) * clampedRadius, y1 - clampedRadius + Math.sin(angle) * clampedRadius);
	}
	for (let index = 1; index <= topCount; index += 1) add(x1 - clampedRadius - top * (index / topCount), y1);
	for (let index = 1; index <= arcCount; index += 1) {
		const angle = Math.PI / 2 + (Math.PI / 2) * (index / arcCount);
		add(x0 + clampedRadius + Math.cos(angle) * clampedRadius, y1 - clampedRadius + Math.sin(angle) * clampedRadius);
	}
	for (let index = 1; index <= sideCount; index += 1) add(x0, y1 - clampedRadius - side * (index / sideCount));
	for (let index = 1; index <= arcCount; index += 1) {
		const angle = Math.PI + (Math.PI / 2) * (index / arcCount);
		add(x0 + clampedRadius + Math.cos(angle) * clampedRadius, y0 + clampedRadius + Math.sin(angle) * clampedRadius);
	}
	return points;
}

function makeSampler(points: readonly Point[]): PerimeterSampler {
	const cumulative = [0];
	for (let index = 1; index <= points.length; index += 1) {
		const first = points[index - 1];
		const second = points[index % points.length];
		cumulative.push(cumulative[index - 1] + Math.hypot(second.x - first.x, second.y - first.y));
	}
	const total = cumulative[cumulative.length - 1];
	const pointAt = (distance: number): Point => {
		const normalizedDistance = mod(distance, total);
		let low = 0;
		let high = points.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			if (cumulative[middle + 1] <= normalizedDistance) low = middle + 1;
			else if (cumulative[middle] > normalizedDistance) high = middle - 1;
			else {
				const first = points[middle];
				const second = points[(middle + 1) % points.length];
				const length = cumulative[middle + 1] - cumulative[middle] || 1;
				const progress = (normalizedDistance - cumulative[middle]) / length;
				return { x: first.x + (second.x - first.x) * progress, y: first.y + (second.y - first.y) * progress };
			}
		}
		return points[0];
	};
	return {
		total,
		pointAt,
		frameAt(distance: number) {
			const epsilon = Math.max(1, (total / points.length) * 2);
			const point = pointAt(distance);
			const before = pointAt(distance - epsilon);
			const after = pointAt(distance + epsilon);
			const tangent = normalize(after.x - before.x, after.y - before.y);
			return { point, normal: { x: tangent.y, y: -tangent.x } };
		}
	};
}

function weightedIntervals(total: number, spacing: number, rng: () => number, variation: number, minimum: number, maximum: number): number[] {
	const count = clamp(Math.round(total / spacing), minimum, maximum);
	const weights = Array.from({ length: count }, () => Math.max(0.38, 1 + (rng() * 2 - 1) * variation));
	const sum = weights.reduce((totalWeight, weight) => totalWeight + weight, 0);
	return weights.map((weight) => weight / sum * total);
}

function capOutwardDistance(point: Point, direction: Point, requested: number, width: number, height: number, constraints?: SpeechBubbleShapeConstraints): number {
	if (!constraints) return requested;
	const outlineInset = OUTLINE_WIDTH / 2 + 0.01;
	const minX = -Math.max(0, constraints.maxBleedX) + outlineInset;
	const maxX = width + Math.max(0, constraints.maxBleedX) - outlineInset;
	const minY = -Math.max(0, constraints.maxBleedY) + outlineInset;
	const maxY = height + Math.max(0, constraints.maxBleedY) - outlineInset;
	const limits: number[] = [requested];
	if (direction.x > 0) limits.push((maxX - point.x) / direction.x);
	if (direction.x < 0) limits.push((minX - point.x) / direction.x);
	if (direction.y > 0) limits.push((maxY - point.y) / direction.y);
	if (direction.y < 0) limits.push((minY - point.y) / direction.y);
	return Math.max(0, Math.min(...limits));
}

function visualBounds(points: readonly Point[]): SpeechBubbleVisualBounds {
	const halfStroke = OUTLINE_WIDTH / 2 + 0.01;
	const xs = points.map((point) => point.x);
	const ys = points.map((point) => point.y);
	const minX = Math.min(...xs);
	const minY = Math.min(...ys);
	return {
		x: minX - halfStroke,
		y: minY - halfStroke,
		width: Math.max(...xs) - minX + halfStroke * 2,
		height: Math.max(...ys) - minY + halfStroke * 2
	};
}

function cubicPoint(first: Point, control1: Point, control2: Point, last: Point, progress: number): Point {
	const inverse = 1 - progress;
	return {
		x: inverse ** 3 * first.x + 3 * inverse ** 2 * progress * control1.x + 3 * inverse * progress ** 2 * control2.x + progress ** 3 * last.x,
		y: inverse ** 3 * first.y + 3 * inverse ** 2 * progress * control1.y + 3 * inverse * progress ** 2 * control2.y + progress ** 3 * last.y
	};
}

function cubicExtrema(first: number, control1: number, control2: number, last: number): number[] {
	const a = -first + 3 * control1 - 3 * control2 + last;
	const b = 2 * (first - 2 * control1 + control2);
	const c = control1 - first;
	if (Math.abs(a) < 1e-8) return Math.abs(b) < 1e-8 ? [] : [-c / b];
	const discriminant = b * b - 4 * a * c;
	if (discriminant < 0) return [];
	const root = Math.sqrt(discriminant);
	return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function shoutShape(width: number, height: number, seed: string | number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape {
	const sampler = makeSampler(roundedRectPoints(width, height, clamp(Math.min(width, height) * 0.25, 9, 18)));
	const rng = mulberry32(hash32(`shout|${seed}|${Math.round(width)}|${Math.round(height)}`));
	const intervals = weightedIntervals(sampler.total, SHOUT_SPACING, rng, SHOUT_VARIANCE * 0.55, 10, 34);
	const center = { x: width / 2, y: height / 2 };
	const offset = rng() * sampler.total;
	const valleys: Array<Readonly<{ station: number; point: Point }>> = [];
	let station = offset;
	for (const interval of intervals) {
		const base = sampler.pointAt(station);
		const direction = normalize(base.x - center.x, base.y - center.y);
		const distance = capOutwardDistance(base, direction, rng() * 1.2, width, height, constraints);
		valleys.push({ station, point: { x: base.x + direction.x * distance, y: base.y + direction.y * distance } });
		station += interval;
	}

	const points: Point[] = [valleys[0].point];
	const lengths: number[] = [];
	const rays: Array<Readonly<{ base: Point; point: Point; direction: Point }>> = [];
	let path = `M ${formatPoint(valleys[0].point)}`;
	for (let index = 0; index < valleys.length; index += 1) {
		const current = valleys[index];
		const next = valleys[(index + 1) % valleys.length];
		const roll = rng();
		const classFactor = roll < 0.24 ? 0.3 + rng() * 0.2 : roll < 0.68 ? 0.9 + rng() * 0.4 : 1.9 + rng() * 1.4;
		const requestedLength = SHOUT_BASE_LENGTH * (1 + (classFactor - 1) * (0.85 + SHOUT_VARIANCE * 1.45));
		const tipStation = current.station + intervals[index] * (0.5 + (rng() - 0.5) * 0.16);
		const base = sampler.pointAt(tipStation);
		const direction = normalize(base.x - center.x, base.y - center.y);
		const length = capOutwardDistance(base, direction, requestedLength, width, height, constraints);
		const tip = { x: base.x + direction.x * length, y: base.y + direction.y * length };
		lengths.push(length);
		rays.push({ base, point: tip, direction });
		points.push(tip, next.point);
		path += ` L ${formatPoint(tip)} L ${formatPoint(next.point)}`;
	}
	return {
		path: `${path} Z`,
		bounds: visualBounds(points),
		metadata: { count: intervals.length, minimumOutwardSize: Math.min(...lengths), maximumOutwardSize: Math.max(...lengths), outwardSizes: lengths, points, valleys: valleys.map((valley) => valley.point), center, outwardRays: rays }
	};
}

function cloudShape(width: number, height: number, seed: string | number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape {
	const sampler = makeSampler(roundedRectPoints(width, height, clamp(Math.min(width, height) * 0.25, 9, 18)));
	const rng = mulberry32(hash32(`cloud|${seed}|${Math.round(width)}|${Math.round(height)}`));
	const intervals = weightedIntervals(sampler.total, CLOUD_SPACING, rng, CLOUD_VARIANCE * 0.34, 7, 20);
	const offset = rng() * sampler.total;
	const valleys: Array<Readonly<{ station: number; point: Point }>> = [];
	let station = offset;
	for (const interval of intervals) {
		const frame = sampler.frameAt(station);
		const distance = capOutwardDistance(frame.point, frame.normal, rng() * 2, width, height, constraints);
		valleys.push({ station, point: { x: frame.point.x + frame.normal.x * distance, y: frame.point.y + frame.normal.y * distance } });
		station += interval;
	}

	const points: Point[] = [valleys[0].point];
	const sizes: number[] = [];
	let path = `M ${formatPoint(valleys[0].point)}`;
	for (let index = 0; index < valleys.length; index += 1) {
		const current = valleys[index];
		const next = valleys[(index + 1) % valleys.length];
		const bump = CLOUD_BASE_SIZE * (0.62 + rng() * (0.76 + CLOUD_VARIANCE * 0.72));
		const firstFrame = sampler.frameAt(current.station + intervals[index] * 0.28);
		const secondFrame = sampler.frameAt(current.station + intervals[index] * 0.72);
		const firstDistance = capOutwardDistance(firstFrame.point, firstFrame.normal, bump, width, height, constraints);
		const secondDistance = capOutwardDistance(secondFrame.point, secondFrame.normal, bump, width, height, constraints);
		const control1 = { x: firstFrame.point.x + firstFrame.normal.x * firstDistance, y: firstFrame.point.y + firstFrame.normal.y * firstDistance };
		const control2 = { x: secondFrame.point.x + secondFrame.normal.x * secondDistance, y: secondFrame.point.y + secondFrame.normal.y * secondDistance };
		for (const progress of [0, 1, ...cubicExtrema(current.point.x, control1.x, control2.x, next.point.x), ...cubicExtrema(current.point.y, control1.y, control2.y, next.point.y)]) {
			if (progress >= 0 && progress <= 1) points.push(cubicPoint(current.point, control1, control2, next.point, progress));
		}
		sizes.push(Math.min(firstDistance, secondDistance));
		path += ` C ${formatPoint(control1)} ${formatPoint(control2)} ${formatPoint(next.point)}`;
	}
	return {
		path: `${path} Z`,
		bounds: visualBounds(points),
		metadata: { count: intervals.length, minimumOutwardSize: Math.min(...sizes), maximumOutwardSize: Math.max(...sizes), outwardSizes: sizes, points, valleys: valleys.map((valley) => valley.point) }
	};
}

export function createSpeechBubbleShape(speechType: SpeechType, width: number, height: number, seed: string | number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape | null {
	if (speechType === 'normal') return null;
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	return speechType === 'shout' ? shoutShape(safeWidth, safeHeight, seed, constraints) : cloudShape(safeWidth, safeHeight, seed, constraints);
}
