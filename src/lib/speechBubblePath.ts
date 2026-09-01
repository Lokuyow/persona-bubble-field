import type { SpeechType } from './conversation';

const PATH_INSET = 2;
const SUPERELLIPSE_EXPONENT = 4;

type Point = Readonly<{ x: number; y: number }>;

function safeDimension(value: number): number {
	return Number.isFinite(value) ? Math.max(PATH_INSET * 2 + 1, value) : PATH_INSET * 2 + 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function formatPoint(point: Point): string {
	return `${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
}

function superellipsePoint(width: number, height: number, angle: number, inwardDistance = 0): Point {
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	const exponent = 2 / SUPERELLIPSE_EXPONENT;
	const radiusX = Math.max(0.5, width / 2 - PATH_INSET);
	const radiusY = Math.max(0.5, height / 2 - PATH_INSET);
	const vector = {
		x: Math.sign(cosine) * Math.pow(Math.abs(cosine), exponent) * radiusX,
		y: Math.sign(sine) * Math.pow(Math.abs(sine), exponent) * radiusY
	};
	const distance = Math.hypot(vector.x, vector.y) || 1;
	const scale = Math.max(0, (distance - inwardDistance) / distance);
	return {
		x: width / 2 + vector.x * scale,
		y: height / 2 + vector.y * scale
	};
}

function perimeterCount(width: number, height: number, minimum: number, maximum: number, spacing: number): number {
	return clamp(Math.round((width + height) / spacing), minimum, maximum);
}

function shoutPath(width: number, height: number): string {
	const tipCount = perimeterCount(width, height, 12, 20, 20);
	const step = (Math.PI * 2) / tipCount;
	const valleyDepth = clamp(Math.min(width, height) * 0.16, 4, 8);
	const variation = [1, 0.76, 0.9, 0.82] as const;
	const points: Point[] = [];
	for (let index = 0; index < tipCount; index += 1) {
		const tipAngle = -Math.PI / 2 + index * step;
		points.push(superellipsePoint(width, height, tipAngle));
		points.push(superellipsePoint(width, height, tipAngle + step / 2, valleyDepth * variation[index % variation.length]));
	}
	return `${points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${formatPoint(point)}`).join(' ')} Z`;
}

function monologuePath(width: number, height: number): string {
	const lobeCount = perimeterCount(width, height, 10, 18, 26);
	const step = (Math.PI * 2) / lobeCount;
	const valleyInset = clamp(Math.min(width, height) * 0.16, 4, 9);
	const controlInset = 0.68;
	const start = superellipsePoint(width, height, -Math.PI / 2 - step / 2, valleyInset);
	let path = `M ${formatPoint(start)}`;
	for (let index = 0; index < lobeCount; index += 1) {
		const angle = -Math.PI / 2 + index * step;
		const from = index === 0 ? start : superellipsePoint(width, height, angle - step / 2, valleyInset);
		const end = superellipsePoint(width, height, angle + step / 2, valleyInset);
		const outer = superellipsePoint(width, height, angle);
		path += ` C ${formatPoint({ x: from.x + (outer.x - from.x) * controlInset, y: from.y + (outer.y - from.y) * controlInset })} ${formatPoint({ x: end.x + (outer.x - end.x) * controlInset, y: end.y + (outer.y - end.y) * controlInset })} ${formatPoint(end)}`;
	}
	return `${path} Z`;
}

export function createSpeechBubblePath(speechType: SpeechType, width: number, height: number): string | null {
	if (speechType === 'normal') return null;
	const safeWidth = safeDimension(width);
	const safeHeight = safeDimension(height);
	return speechType === 'shout'
		? shoutPath(safeWidth, safeHeight)
		: monologuePath(safeWidth, safeHeight);
}
