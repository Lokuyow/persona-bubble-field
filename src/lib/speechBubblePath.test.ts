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
		expect(first?.path).not.toBe(second?.path);
		expect(first?.metadata.points.some((point, index) => point.x !== second?.metadata.points[index]?.x || point.y !== second?.metadata.points[index]?.y)).toBe(true);
	});

	it.each([
		['shout', 184, 54, '49d39194'],
		['shout', 218, 58, '85a7b07d'],
		['monologue', 184, 54, 'a11eaca'],
		['monologue', 218, 58, 'd1d6ab8a']
	] as const)('matches the v10c fixed seed 72644 %s %dx%d golden shape', (speechType, width, height, digest) => {
		const shape = createSpeechBubbleShape(speechType, width, height, 72644);
		expect(shape).not.toBeNull();
		expect(pathDigest(shape!.path)).toBe(digest);
	});

	it('uses v10c shout coverage, smooth contour sections, and fixed-size center-radial spikes', () => {
		const small = createSpeechBubbleShape('shout', 184, 54, 72644)!;
		const merged = createSpeechBubbleShape('shout', 218, 58, 72644)!;
		const large = createSpeechBubbleShape('shout', 330, 128, 72644)!;
		expect(small.metadata.intervalCount).toBe(28);
		expect(small.metadata.decoratedCount).toBe(16);
		expect(small.metadata.coverage).toBe(16 / 28);
		expect(merged.metadata.intervalCount).toBe(32);
		expect(merged.metadata.decoratedCount).toBe(17);
		expect(merged.metadata.coverage).toBe(17 / 32);
		expect(small.metadata.requestedOutwardSizes.every((length) => length === 14)).toBe(true);
		expect(small.metadata.actualOutwardSizes.every((length) => length === 14)).toBe(true);
		expect(merged.metadata.requestedOutwardSizes.every((length) => Math.abs(length - 16.944176213101322) < 1e-12)).toBe(true);
		expect(large.metadata.requestedOutwardSizes.every((length) => Math.abs(length - 38.423115299022314) < 1e-12)).toBe(true);
		expect(small.metadata.spikeRootWidths?.every((width) => width <= 10 && width > 0)).toBe(true);
		expect(large.metadata.spikeRootWidths?.every((width) => width <= 10 && width > 0)).toBe(true);
		expect((small.path.match(/\bL\s/g) ?? []).length).toBeGreaterThan(100);
		expect(small.metadata.outwardRays).toHaveLength(small.metadata.decoratedCount);
		for (const ray of small.metadata.outwardRays ?? []) {
			const fromCenter = { x: ray.base.x - small.metadata.center!.x, y: ray.base.y - small.metadata.center!.y };
			const toTip = { x: ray.point.x - small.metadata.center!.x, y: ray.point.y - small.metadata.center!.y };
			expect(Math.abs(fromCenter.x * toTip.y - fromCenter.y * toTip.x)).toBeLessThan(1e-8);
			expect(fromCenter.x * toTip.x + fromCenter.y * toTip.y).toBeGreaterThan(Math.hypot(fromCenter.x, fromCenter.y) ** 2);
		}
		expect(large.metadata.sizeFactor).toBeCloseTo(2.7445082356444512, 12);
		expectBoundsToEnclose(small);
		expectBoundsToEnclose(merged);
		expectBoundsToEnclose(large);
	});

	it('uses v10c full cloud-only lobes with explicit 85 percent small and 15 percent large classes', () => {
		const small = createSpeechBubbleShape('monologue', 184, 54, 72644)!;
		const merged = createSpeechBubbleShape('monologue', 218, 58, 72644)!;
		for (const [shape, count, minimumBump, maximumBump] of [
			[small, 7, 4.033864743672777, 11.920829839027487],
			[merged, 8, 4.138020742816385, 10.64828880764125]
		] as const) {
			expect(shape.metadata.intervalCount).toBe(count);
			expect(shape.metadata.decoratedCount).toBe(count);
			expect((shape.path.match(/\bC\s/g) ?? [])).toHaveLength(count);
			expect((shape.path.match(/\bL\s/g) ?? [])).toHaveLength(0);
			expect(shape.metadata.lobeFactors?.some((factor) => factor < 0.85)).toBe(true);
			expect(shape.metadata.lobeFactors?.some((factor) => factor >= 1.45)).toBe(true);
			expect(shape.metadata.lobeFactors?.every((factor) => factor < 0.85 || factor >= 1.45)).toBe(true);
			expect(Math.min(...(shape.metadata.lobeBumps ?? []))).toBeCloseTo(minimumBump, 12);
			expect(Math.max(...(shape.metadata.lobeBumps ?? []))).toBeCloseTo(maximumBump, 12);
			expect(shape.metadata.valleyOutwardSizes?.every((distance) => distance >= 5.6 && distance <= 8.4)).toBe(true);
			expectBoundsToEnclose(shape);
		}
	});

	it.each([
		['shout', 72, 30],
		['shout', 184, 54],
		['shout', 330, 128],
		['monologue', 72, 30],
		['monologue', 184, 54],
		['monologue', 330, 128]
	] as const)('encloses the actual %s path at %dx%d in its separate visual bounds', (speechType, width, height) => {
		const shape = createSpeechBubbleShape(speechType, width, height, 72644)!;
		expect(shape.metadata.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
		expectBoundsToEnclose(shape);
	});

	it('caps only outward decoration within the supplied responsive envelope', () => {
		const constraints = { maxBleedX: 16, maxBleedY: 10 };
		for (const speechType of ['shout', 'monologue'] as const) {
			const shape = createSpeechBubbleShape(speechType, 288, 128, 72644, constraints)!;
			expect(shape.bounds.x).toBeGreaterThanOrEqual(-constraints.maxBleedX - 0.01);
			expect(shape.bounds.y).toBeGreaterThanOrEqual(-constraints.maxBleedY - 0.01);
			expect(shape.bounds.x + shape.bounds.width).toBeLessThanOrEqual(288 + constraints.maxBleedX + 0.01);
			expect(shape.bounds.y + shape.bounds.height).toBeLessThanOrEqual(128 + constraints.maxBleedY + 0.01);
		}
	});
});
