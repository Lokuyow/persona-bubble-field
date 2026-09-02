import { describe, expect, it } from 'vitest';
import { createShoutBubbleShape, createSpeechBubbleShape, type SpeechBubbleShape } from './speechBubblePath';

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
		expect(first?.metadata.spikeIndices).toEqual(second?.metadata.spikeIndices);
		expect(first?.metadata.spikeScales).toEqual(second?.metadata.spikeScales);
		expect(first?.path).not.toBe(changed?.path);
		expect(first?.path).not.toBe(second?.path);
		expect(first?.metadata.points.some((point, index) => point.x !== second?.metadata.points[index]?.x || point.y !== second?.metadata.points[index]?.y)).toBe(true);
	});

	it.each([
		['monologue', 184, 54, 'a11eaca'],
		['monologue', 218, 58, 'd1d6ab8a']
	] as const)('keeps the fixed seed 72644 %s %dx%d golden shape', (speechType, width, height, digest) => {
		const shape = createSpeechBubbleShape(speechType, width, height, 72644);
		expect(shape).not.toBeNull();
		expect(pathDigest(shape!.path)).toBe(digest);
	});

	it.each([
		[184, 54, 'e950bba8', 28, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26], 36, 11.3595679372, 90],
		[218, 58, '31f9127f', 33, [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 19, 22, 23, 25, 27, 29, 31], 40.19178082191781, 12.6822573546, 100.4794520548],
		[330, 128, 'd7f9c290', 55, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 25, 27, 29, 31, 34, 35, 38, 39, 41, 43, 45, 47, 49, 51, 53], 54, 16.2, 135]
	] as const)('matches the prototype shout core at %dx%d', (width, height, digest, intervalCount, spikeIndices, boostedLength, minimumLength, maximumLength) => {
		const shape = createShoutBubbleShape(width, height, 72644);
		expect(pathDigest(shape.path)).toBe(digest);
		expect(shape.metadata.intervalCount).toBe(intervalCount);
		expect(shape.metadata.spikeIndices).toEqual(spikeIndices);
		expect(shape.metadata.baseLength).toBeCloseTo(boostedLength, 10);
		expect(Math.min(...shape.metadata.requestedOutwardSizes)).toBeCloseTo(minimumLength, 9);
		expect(Math.max(...shape.metadata.requestedOutwardSizes)).toBeCloseTo(maximumLength, 9);
	});

	it('uses prototype balanced placement, long/short variation, and fixed center-radial spikes', () => {
		const small = createShoutBubbleShape(184, 54, 72644);
		const merged = createShoutBubbleShape(218, 58, 72644);
		const large = createShoutBubbleShape(330, 128, 72644);
		expect(small.metadata.intervalCount).toBe(28);
		expect(small.metadata.decoratedCount).toBe(14);
		expect(small.metadata.coverage).toBe(14 / 28);
		expect(merged.metadata.intervalCount).toBe(33);
		expect(merged.metadata.decoratedCount).toBe(17);
		expect(merged.metadata.coverage).toBe(17 / 33);
		expect(small.metadata.requestedOutwardSizes.some((length) => length < 20)).toBe(true);
		expect(small.metadata.requestedOutwardSizes.some((length) => length > 80)).toBe(true);
		expect(small.metadata.actualOutwardSizes).toEqual(small.metadata.requestedOutwardSizes);
		expect(small.metadata.spikeRootWidths?.every((width) => width === 8)).toBe(true);
		expect(large.metadata.spikeRootWidths?.every((width) => width === 8)).toBe(true);
		expect((small.path.match(/\bL/g) ?? []).length).toBe(small.metadata.intervalCount + small.metadata.decoratedCount * 2 - 1);
		expect((small.path.match(/\bC/g) ?? []).length).toBe(0);
		expect(small.metadata.outwardRays).toHaveLength(small.metadata.decoratedCount);
		for (const ray of small.metadata.outwardRays ?? []) {
			const fromCenter = { x: ray.base.x - small.metadata.center!.x, y: ray.base.y - small.metadata.center!.y };
			const toTip = { x: ray.point.x - small.metadata.center!.x, y: ray.point.y - small.metadata.center!.y };
			expect(Math.abs(fromCenter.x * toTip.y - fromCenter.y * toTip.x)).toBeLessThan(1e-8);
			expect(fromCenter.x * toTip.x + fromCenter.y * toTip.y).toBeGreaterThan(Math.hypot(fromCenter.x, fromCenter.y) ** 2);
		}
		expect(large.metadata.sizeFactor).toBeCloseTo(1.5, 12);
		expectBoundsToEnclose(small);
		expectBoundsToEnclose(merged);
		expectBoundsToEnclose(large);
	});

	it.each([
		[72, 30],
		[184, 54],
		[218, 58],
		[330, 128]
	] as const)('keeps balanced spike gaps for %dx%d across deterministic seeds', (width, height) => {
		for (const seed of [1, 72644, 987654321]) {
			const shape = createShoutBubbleShape(width, height, seed);
			const indices = [...(shape.metadata.spikeIndices ?? [])];
			expect(new Set(indices).size).toBe(indices.length);
			const gaps = indices.map((index, position) => (indices[(position + 1) % indices.length] - index + shape.metadata.intervalCount) % shape.metadata.intervalCount);
			expect(Math.min(...gaps)).toBeGreaterThan(0);
			expect(Math.max(...gaps)).toBeLessThanOrEqual(4);
		}
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
