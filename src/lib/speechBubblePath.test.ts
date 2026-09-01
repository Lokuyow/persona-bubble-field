import { describe, expect, it } from 'vitest';
import { createSpeechBubbleShape, type SpeechBubbleShape } from './speechBubblePath';

function pathDigest(path: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < path.length; index += 1) {
		hash ^= path.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return (hash >>> 0).toString(16);
}

function expectBoundsToEnclose(shape: SpeechBubbleShape): void {
	const { bounds } = shape;
	for (const point of shape.metadata.points) {
		expect(point.x).toBeGreaterThanOrEqual(bounds.x);
		expect(point.x).toBeLessThanOrEqual(bounds.x + bounds.width);
		expect(point.y).toBeGreaterThanOrEqual(bounds.y);
		expect(point.y).toBeLessThanOrEqual(bounds.y + bounds.height);
	}
}

describe('createSpeechBubbleShape', () => {
	it('leaves normal bubbles on their existing CSS surface', () => {
		expect(createSpeechBubbleShape('normal', 184, 54, 'normal-bubble')).toBeNull();
	});

	it('uses a deterministic rounded-size RNG key without a global production seed', () => {
		const first = createSpeechBubbleShape('shout', 189.29, 54, 'bubble-idshout');
		const second = createSpeechBubbleShape('shout', 189.31, 54, 'bubble-idshout');
		const changed = createSpeechBubbleShape('shout', 189.31, 54, 'another-idshout');
		expect(first?.metadata.count).toBe(second?.metadata.count);
		expect(first?.metadata.outwardSizes).toEqual(second?.metadata.outwardSizes);
		expect(first?.path).not.toBe(changed?.path);
	});

	it.each([
		['shout', 184, 54, 'df409c48'],
		['shout', 218, 58, 'e9ef5119'],
		['monologue', 184, 54, '1100ab48'],
		['monologue', 218, 58, '7f0ebc4']
	] as const)('keeps the approved seed 70161 %s %dx%d golden shape', (speechType, width, height, digest) => {
		const shape = createSpeechBubbleShape(speechType, width, height, 70161);
		expect(shape).not.toBeNull();
		expect(pathDigest(shape!.path)).toBe(digest);
	});

	it('creates the v7 shout distribution as center-radial short, medium, and long spikes', () => {
		const shape = createSpeechBubbleShape('shout', 184, 54, 70161)!;
		expect(shape.metadata.count).toBe(20);
		expect(createSpeechBubbleShape('shout', 330, 128, 70161)!.metadata.count).toBeGreaterThan(shape.metadata.count);
		expect(shape.metadata.outwardSizes.some((size) => size < 6)).toBe(true);
		expect(shape.metadata.outwardSizes.some((size) => size > 12 && size < 20)).toBe(true);
		expect(shape.metadata.outwardSizes.some((size) => size > 28)).toBe(true);
		expect(shape.metadata.outwardRays).toHaveLength(shape.metadata.count);
		for (const ray of shape.metadata.outwardRays ?? []) {
			const fromCenter = { x: ray.base.x - shape.metadata.center!.x, y: ray.base.y - shape.metadata.center!.y };
			const toTip = { x: ray.point.x - shape.metadata.center!.x, y: ray.point.y - shape.metadata.center!.y };
			expect(Math.abs(fromCenter.x * toTip.y - fromCenter.y * toTip.x)).toBeLessThan(1e-8);
			expect(fromCenter.x * toTip.x + fromCenter.y * toTip.y).toBeGreaterThan(Math.hypot(fromCenter.x, fromCenter.y) ** 2);
		}
		expect(shape.bounds.x).toBeLessThan(0);
		expect(shape.bounds.y).toBeLessThan(0);
		expect(shape.bounds.x + shape.bounds.width).toBeGreaterThan(184);
		expect(shape.bounds.y + shape.bounds.height).toBeGreaterThan(54);
		expect(shape.metadata.valleys.every((point) => point.x >= -1.2 && point.x <= 185.2 && point.y >= -1.2 && point.y <= 55.2)).toBe(true);
		expectBoundsToEnclose(shape);
	});

	it('creates the v5 cloud distribution with variable cubic lobes outside the body', () => {
		const shape = createSpeechBubbleShape('monologue', 218, 58, 70161)!;
		expect((shape.path.match(/\bC\s/g) ?? [])).toHaveLength(shape.metadata.count);
		expect((shape.path.match(/\bL\s/g) ?? [])).toHaveLength(0);
		expect(shape.metadata.count).toBe(10);
		expect(createSpeechBubbleShape('monologue', 330, 128, 70161)!.metadata.count).toBeGreaterThan(shape.metadata.count);
		expect(shape.metadata.maximumOutwardSize - shape.metadata.minimumOutwardSize).toBeGreaterThan(8);
		expect(shape.bounds.x).toBeLessThan(0);
		expect(shape.bounds.y).toBeLessThan(0);
		expect(shape.bounds.x + shape.bounds.width).toBeGreaterThan(218);
		expect(shape.bounds.y + shape.bounds.height).toBeGreaterThan(58);
		expect(shape.metadata.valleys.every((point) => point.x >= -2 && point.x <= 220 && point.y >= -2 && point.y <= 60)).toBe(true);
		expectBoundsToEnclose(shape);
	});

	it.each([
		['shout', 72, 30],
		['shout', 184, 54],
		['shout', 330, 128],
		['monologue', 72, 30],
		['monologue', 184, 54],
		['monologue', 330, 128]
	] as const)('encloses the actual %s path at %dx%d in its separate visual bounds', (speechType, width, height) => {
		const shape = createSpeechBubbleShape(speechType, width, height, 70161)!;
		expect(shape.metadata.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
		expectBoundsToEnclose(shape);
	});

	it('caps only outward decoration within the supplied responsive envelope', () => {
		const constraints = { maxBleedX: 16, maxBleedY: 10 };
		for (const speechType of ['shout', 'monologue'] as const) {
			const shape = createSpeechBubbleShape(speechType, 288, 128, 70161, constraints)!;
			expect(shape.bounds.x).toBeGreaterThanOrEqual(-constraints.maxBleedX - 0.01);
			expect(shape.bounds.y).toBeGreaterThanOrEqual(-constraints.maxBleedY - 0.01);
			expect(shape.bounds.x + shape.bounds.width).toBeLessThanOrEqual(288 + constraints.maxBleedX + 0.01);
			expect(shape.bounds.y + shape.bounds.height).toBeLessThanOrEqual(128 + constraints.maxBleedY + 0.01);
		}
	});
});
