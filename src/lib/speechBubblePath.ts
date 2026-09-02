import type { SpeechType } from './conversation';

const PATH_INSET = 1;
const OUTLINE_WIDTH = 1;
const SHOUT_SPACING = 16;
const SHOUT_BASE_LENGTH = 36;
const SHOUT_LENGTH_VARIATION = 1.3;
const SHOUT_COVERAGE = 0.5;
const SHOUT_BASE_WIDTH = 8;
const SHOUT_SIZE_BOOST = 1.5;
const SHOUT_MIN_VARIATION_RATIO = 0.3;
const SHOUT_MAX_VARIATION_RATIO = 2.5;
const SHOUT_RADIUS = 18;
const SHOUT_SEGMENT_LENGTH = 6;
const CLOUD_SPACING = 64;
const CLOUD_BASE_SIZE = 4;
const CLOUD_VARIANCE = 1.8;
const CLOUD_OFFSET = 8;
const CLOUD_SMALL_RATE = 0.85;

type Point = Readonly<{ x: number; y: number }>;

export type SpeechBubbleVisualBounds = Readonly<{ x: number; y: number; width: number; height: number }>;
export type SpeechBubbleShapeConstraints = Readonly<{ maxBleedX: number; maxBleedY: number }>;
export type SpeechBubbleShape = Readonly<{
	path: string;
	bounds: SpeechBubbleVisualBounds;
	metadata: Readonly<{
		count: number;
		intervalCount: number;
		decoratedCount: number;
		coverage?: number;
		minimumOutwardSize: number;
		maximumOutwardSize: number;
		outwardSizes: readonly number[];
		requestedOutwardSizes: readonly number[];
		actualOutwardSizes: readonly number[];
		points: readonly Point[];
		valleys: readonly Point[];
		center?: Point;
		outwardRays?: readonly Readonly<{ base: Point; point: Point; direction: Point }>[];
		spikeRootWidths?: readonly number[];
		spikeIndices?: readonly number[];
		spikeScales?: readonly number[];
		perimeter?: number;
		step?: number;
		baseLength?: number;
		valleyOutwardSizes?: readonly number[];
		sizeFactor?: number;
		lobeFactors?: readonly number[];
		lobeBumps?: readonly number[];
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

function randomInteger(rng: () => number, minimum: number, maximum: number): number {
	return Math.floor(rng() * (maximum - minimum + 1)) + minimum;
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

function shoutLerp(first: number, second: number, progress: number): number {
	return first + (second - first) * progress;
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

function rotateMask(mask: readonly boolean[], rotation: number): boolean[] {
	const count = mask.length;
	return mask.map((_, index) => mask[(index - rotation + count) % count]);
}

function buildCoverageMask(count: number, rng: () => number, targetCoverage: number): boolean[] {
	for (let attempt = 0; attempt < 48; attempt += 1) {
		const runs: Array<Readonly<{ decorated: boolean; length: number }>> = [];
		let remaining = count;
		let decorated = rng() < 0.45;
		while (remaining > 0) {
			const minimumRun = decorated ? 2 : 1;
			const maximumRun = decorated ? 4 : 3;
			const length = Math.min(randomInteger(rng, minimumRun, maximumRun), remaining);
			runs.push({ decorated, length });
			remaining -= length;
			decorated = !decorated;
		}
		const mask = runs.flatMap((run) => Array.from({ length: run.length }, () => run.decorated));
		const coverage = mask.filter(Boolean).length / count;
		if (Math.abs(coverage - targetCoverage) <= 0.08) return rotateMask(mask, randomInteger(rng, 0, count - 1));
	}
	const fallback = Array.from({ length: count }, (_, index) => index < Math.round(count * targetCoverage));
	return rotateMask(fallback, randomInteger(rng, 0, count - 1));
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

function appendBaseSegment(path: string, points: Point[], sampler: PerimeterSampler, start: number, end: number): string {
	if (end <= start) return path;
	const span = end - start;
	const steps = Math.max(2, Math.round(span / 6));
	let nextPath = path;
	for (let index = 1; index <= steps; index += 1) {
		const point = sampler.pointAt(start + span * (index / steps));
		points.push(point);
		nextPath += ` L ${formatPoint(point)}`;
	}
	return nextPath;
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

type ShoutPerimeterSegment = Readonly<{
	a: Point;
	b: Point;
	length: number;
	start: number;
	end: number;
}>;

type ShoutPerimeterData = Readonly<{
	segments: readonly ShoutPerimeterSegment[];
	perimeter: number;
}>;

function shoutRoundedRectPoints(width: number, height: number, radius: number, segmentLength: number): Point[] {
	const points: Point[] = [];
	const clampedRadius = Math.min(radius, width / 2, height / 2);
	const left = 0;
	const top = 0;
	const right = width;
	const bottom = height;

	const pushArc = (centerX: number, centerY: number, startAngle: number, endAngle: number): void => {
		const arcLength = Math.abs(endAngle - startAngle) * clampedRadius;
		const steps = Math.max(3, Math.ceil(arcLength / segmentLength));
		for (let index = 0; index < steps; index += 1) {
			const progress = index / steps;
			const angle = shoutLerp(startAngle, endAngle, progress);
			points.push({
				x: centerX + Math.cos(angle) * clampedRadius,
				y: centerY + Math.sin(angle) * clampedRadius
			});
		}
	};

	const pushLine = (x1: number, y1: number, x2: number, y2: number): void => {
		const distance = Math.hypot(x2 - x1, y2 - y1);
		const steps = Math.max(1, Math.ceil(distance / segmentLength));
		for (let index = 0; index < steps; index += 1) {
			const progress = index / steps;
			points.push({ x: shoutLerp(x1, x2, progress), y: shoutLerp(y1, y2, progress) });
		}
	};

	pushLine(left + clampedRadius, top, right - clampedRadius, top);
	pushArc(right - clampedRadius, top + clampedRadius, -Math.PI / 2, 0);
	pushLine(right, top + clampedRadius, right, bottom - clampedRadius);
	pushArc(right - clampedRadius, bottom - clampedRadius, 0, Math.PI / 2);
	pushLine(right - clampedRadius, bottom, left + clampedRadius, bottom);
	pushArc(left + clampedRadius, bottom - clampedRadius, Math.PI / 2, Math.PI);
	pushLine(left, bottom - clampedRadius, left, top + clampedRadius);
	pushArc(left + clampedRadius, top + clampedRadius, Math.PI, Math.PI * 1.5);
	return points;
}

function shoutPolygonArea(points: readonly Point[]): number {
	let area = 0;
	for (let index = 0; index < points.length; index += 1) {
		const first = points[index];
		const second = points[(index + 1) % points.length];
		area += first.x * second.y - second.x * first.y;
	}
	return area / 2;
}

function ensureShoutClockwise(points: Point[]): Point[] {
	if (shoutPolygonArea(points) > 0) points.reverse();
	return points;
}

function buildShoutPerimeterData(points: readonly Point[]): ShoutPerimeterData {
	const segments: ShoutPerimeterSegment[] = [];
	let perimeter = 0;
	for (let index = 0; index < points.length; index += 1) {
		const first = points[index];
		const second = points[(index + 1) % points.length];
		const length = Math.hypot(second.x - first.x, second.y - first.y);
		segments.push({ a: first, b: second, length, start: perimeter, end: perimeter + length });
		perimeter += length;
	}
	return { segments, perimeter };
}

function sampleShoutPointAtDistance(perimeterData: ShoutPerimeterData, distance: number): Readonly<{ point: Point; tangent: Point }> {
	const normalizedDistance = mod(distance, perimeterData.perimeter);
	for (const segment of perimeterData.segments) {
		if (normalizedDistance <= segment.end) {
			const progress = segment.length === 0 ? 0 : (normalizedDistance - segment.start) / segment.length;
			return {
				point: {
					x: shoutLerp(segment.a.x, segment.b.x, progress),
					y: shoutLerp(segment.a.y, segment.b.y, progress)
				},
				tangent: normalize(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
			};
		}
	}
	const last = perimeterData.segments[perimeterData.segments.length - 1];
	return { point: { ...last.b }, tangent: normalize(last.b.x - last.a.x, last.b.y - last.a.y) };
}

function createShoutCoverageMask(count: number, coverage: number, rng: () => number): boolean[] {
	const spikeCount = Math.max(1, Math.round(count * coverage));
	const mask = new Array(count).fill(false);
	if (spikeCount >= count) {
		mask.fill(true);
		return mask;
	}

	const idealStep = count / spikeCount;
	const jitterRatio = 0.22;
	const chosen: number[] = [];
	for (let index = 0; index < spikeCount; index += 1) {
		const base = index * idealStep;
		const jitter = (rng() * 2 - 1) * idealStep * jitterRatio;
		let chosenIndex = Math.round(base + jitter);
		chosenIndex = mod(chosenIndex, count);
		chosen.push(chosenIndex);
	}
	chosen.sort((first, second) => first - second);
	for (let index = 1; index < chosen.length; index += 1) {
		if (chosen[index] <= chosen[index - 1]) chosen[index] = chosen[index - 1] + 1;
	}
	for (let index = 0; index < chosen.length; index += 1) chosen[index] = mod(chosen[index], count);

	const used = new Set<number>();
	for (let index = 0; index < chosen.length; index += 1) {
		let chosenIndex = chosen[index];
		let guard = 0;
		while (used.has(chosenIndex) && guard < count) {
			chosenIndex = (chosenIndex + 1) % count;
			guard += 1;
		}
		used.add(chosenIndex);
		mask[chosenIndex] = true;
	}
	return mask;
}

function formatShoutPoint(point: Point): string {
	return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

type ShoutPathItem =
	| Readonly<{ kind: 'plain'; point: Point }>
	| Readonly<{ kind: 'spike'; leftRoot: Point; tip: Point; rightRoot: Point }>;

export function createShoutBubbleShape(width: number, height: number, seed: number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape {
	const perimeterData = buildShoutPerimeterData(ensureShoutClockwise(shoutRoundedRectPoints(width, height, SHOUT_RADIUS, SHOUT_SEGMENT_LENGTH)));
	const intervalCount = Math.max(8, Math.round(perimeterData.perimeter / SHOUT_SPACING));
	const step = perimeterData.perimeter / intervalCount;
	const rng = mulberry32(hash32(String(seed)));
	const decoratedMask = createShoutCoverageMask(intervalCount, SHOUT_COVERAGE, rng);
	const center = { x: width / 2, y: height / 2 };
	const largeScale = Math.max(0, (Math.max(width, height) - 184) / 146);
	const boostedLength = SHOUT_BASE_LENGTH * (1 + largeScale * (SHOUT_SIZE_BOOST - 1));
	const pathItems: ShoutPathItem[] = [];
	const points: Point[] = [];
	const valleys: Point[] = [];
	const requestedLengths: number[] = [];
	const actualLengths: number[] = [];
	const rootWidths: number[] = [];
	const spikeIndices: number[] = [];
	const spikeScales: number[] = [];
	const rays: Array<Readonly<{ base: Point; point: Point; direction: Point }>> = [];

	for (let index = 0; index < intervalCount; index += 1) {
		const baseSample = sampleShoutPointAtDistance(perimeterData, index * step);
		const basePoint = baseSample.point;
		valleys.push(basePoint);
		const direction = normalize(basePoint.x - center.x, basePoint.y - center.y);
		if (!decoratedMask[index]) {
			pathItems.push({ kind: 'plain', point: basePoint });
			continue;
		}

		const raw = rng() * 2 - 1;
		const biased = raw >= 0 ? raw ** 1.1 : -(Math.abs(raw) ** 1.1);
		const spikeScale = biased >= 0
			? shoutLerp(1, SHOUT_MAX_VARIATION_RATIO, clamp(biased * SHOUT_LENGTH_VARIATION, 0, 1))
			: shoutLerp(1, SHOUT_MIN_VARIATION_RATIO, clamp(-biased * SHOUT_LENGTH_VARIATION, 0, 1));
		const requestedLength = boostedLength * spikeScale;
		const halfRoot = SHOUT_BASE_WIDTH / 2;
		const leftRoot = { x: basePoint.x - baseSample.tangent.x * halfRoot, y: basePoint.y - baseSample.tangent.y * halfRoot };
		const rightRoot = { x: basePoint.x + baseSample.tangent.x * halfRoot, y: basePoint.y + baseSample.tangent.y * halfRoot };
		const actualLength = capOutwardDistance(basePoint, direction, requestedLength, width, height, constraints);
		const tip = { x: basePoint.x + direction.x * actualLength, y: basePoint.y + direction.y * actualLength };
		pathItems.push({ kind: 'spike', leftRoot, tip, rightRoot });
		requestedLengths.push(requestedLength);
		actualLengths.push(actualLength);
		rootWidths.push(SHOUT_BASE_WIDTH);
		spikeIndices.push(index);
		spikeScales.push(spikeScale);
		rays.push({ base: basePoint, point: tip, direction });
	}

	const pathParts: string[] = [];
	let hasFirstPoint = false;
	const appendPoint = (command: 'M' | 'L', point: Point): void => {
		pathParts.push(`${command}${formatShoutPoint(point)}`);
		points.push(point);
	};
	for (const item of pathItems) {
		if (item.kind === 'plain') {
			appendPoint(hasFirstPoint ? 'L' : 'M', item.point);
			hasFirstPoint = true;
			continue;
		}
		appendPoint(hasFirstPoint ? 'L' : 'M', item.leftRoot);
		hasFirstPoint = true;
		appendPoint('L', item.tip);
		appendPoint('L', item.rightRoot);
	}
	pathParts.push('Z');

	return {
		path: pathParts.join(' '),
		bounds: visualBounds(points),
		metadata: {
			count: intervalCount,
			intervalCount,
			decoratedCount: spikeIndices.length,
			coverage: spikeIndices.length / intervalCount,
			minimumOutwardSize: Math.min(...actualLengths),
			maximumOutwardSize: Math.max(...actualLengths),
			outwardSizes: actualLengths,
			requestedOutwardSizes: requestedLengths,
			actualOutwardSizes: actualLengths,
			points,
			valleys,
			center,
			outwardRays: rays,
			spikeRootWidths: rootWidths,
			sizeFactor: boostedLength / SHOUT_BASE_LENGTH,
			spikeIndices,
			spikeScales,
			perimeter: perimeterData.perimeter,
			step,
			baseLength: boostedLength
		}
	};
}

function cloudShape(width: number, height: number, seed: string | number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape {
	const sampler = makeSampler(roundedRectPoints(width, height, clamp(Math.min(width, height) * 0.25, 9, 18)));
	const rng = mulberry32(hash32(`mono-full-cloud|${seed}|${Math.round(width)}|${Math.round(height)}`));
	const intervals = weightedIntervals(sampler.total, CLOUD_SPACING, rng, 0.16, 6, 24);
	const offset = rng() * sampler.total;
	const valleys: Array<Readonly<{ station: number; point: Point }>> = [];
	const valleyOutwardSizes: number[] = [];
	let station = offset;
	for (const interval of intervals) {
		const frame = sampler.frameAt(station);
		const distance = capOutwardDistance(frame.point, frame.normal, CLOUD_OFFSET * (0.7 + rng() * 0.35), width, height, constraints);
		valleyOutwardSizes.push(distance);
		valleys.push({ station, point: { x: frame.point.x + frame.normal.x * distance, y: frame.point.y + frame.normal.y * distance } });
		station += interval;
	}

	const points: Point[] = [valleys[0].point];
	const factors: number[] = [];
	const requestedBumps: number[] = [];
	const actualBumps: number[] = [];
	let path = `M ${formatPoint(valleys[0].point)}`;
	for (let index = 0; index < valleys.length; index += 1) {
		const current = valleys[index];
		const next = valleys[(index + 1) % valleys.length];
		const roll = rng();
		const factor = roll < CLOUD_SMALL_RATE ? 0.35 + rng() * 0.35 : 1.45 + rng() * 0.65;
		const bump = CLOUD_BASE_SIZE * (0.55 + factor * (0.55 + CLOUD_VARIANCE * 0.4));
		const firstFrame = sampler.frameAt(current.station + intervals[index] * 0.28);
		const secondFrame = sampler.frameAt(current.station + intervals[index] * 0.72);
		const firstDistance = capOutwardDistance(firstFrame.point, firstFrame.normal, CLOUD_OFFSET + bump, width, height, constraints);
		const secondDistance = capOutwardDistance(secondFrame.point, secondFrame.normal, CLOUD_OFFSET + bump, width, height, constraints);
		const control1 = { x: firstFrame.point.x + firstFrame.normal.x * firstDistance, y: firstFrame.point.y + firstFrame.normal.y * firstDistance };
		const control2 = { x: secondFrame.point.x + secondFrame.normal.x * secondDistance, y: secondFrame.point.y + secondFrame.normal.y * secondDistance };
		for (const progress of [0, 1, ...cubicExtrema(current.point.x, control1.x, control2.x, next.point.x), ...cubicExtrema(current.point.y, control1.y, control2.y, next.point.y)]) {
			if (progress >= 0 && progress <= 1) points.push(cubicPoint(current.point, control1, control2, next.point, progress));
		}
		factors.push(factor);
		requestedBumps.push(bump);
		actualBumps.push(Math.min(firstDistance, secondDistance) - CLOUD_OFFSET);
		path += ` C ${formatPoint(control1)} ${formatPoint(control2)} ${formatPoint(next.point)}`;
	}
	return {
		path: `${path} Z`,
		bounds: visualBounds(points),
		metadata: {
			count: intervals.length,
			intervalCount: intervals.length,
			decoratedCount: intervals.length,
			minimumOutwardSize: Math.min(...actualBumps),
			maximumOutwardSize: Math.max(...actualBumps),
			outwardSizes: actualBumps,
			requestedOutwardSizes: requestedBumps,
			actualOutwardSizes: actualBumps,
			points,
			valleys: valleys.map((valley) => valley.point),
			valleyOutwardSizes,
			lobeFactors: factors,
			lobeBumps: requestedBumps
		}
	};
}

export function createSpeechBubbleShape(speechType: SpeechType, width: number, height: number, seed: string | number, constraints?: SpeechBubbleShapeConstraints): SpeechBubbleShape | null {
	if (speechType === 'normal') return null;
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	if (speechType === 'shout') {
		const coreSeed = hash32(`shout|${seed}|${Math.round(safeWidth)}|${Math.round(safeHeight)}`);
		return createShoutBubbleShape(safeWidth, safeHeight, coreSeed, constraints);
	}
	return cloudShape(safeWidth, safeHeight, seed, constraints);
}
