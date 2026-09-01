import { describe, expect, it } from 'vitest';
import { createSpeechBubblePath } from './speechBubblePath';

function coordinates(path: string): number[] {
	return [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function linePoints(path: string): ReadonlyArray<Readonly<{ x: number; y: number }>> {
	return [...path.matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
		.map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
}

function commandCount(path: string, command: string): number {
	return [...path.matchAll(new RegExp(`\\b${command}\\s`, 'g'))].length;
}

function normalizedSuperellipseRadius(point: Readonly<{ x: number; y: number }>, width: number, height: number): number {
	const radiusX = width / 2 - 2;
	const radiusY = height / 2 - 2;
	return Math.pow(
		Math.pow(Math.abs((point.x - width / 2) / radiusX), 4) +
		Math.pow(Math.abs((point.y - height / 2) / radiusY), 4),
		1 / 4
	);
}

function cubicLobes(path: string): ReadonlyArray<Readonly<{ firstControl: { x: number; y: number }; secondControl: { x: number; y: number }; valley: { x: number; y: number } }>> {
	return [...path.matchAll(/C\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)]
		.map((match) => ({
			firstControl: { x: Number(match[1]), y: Number(match[2]) },
			secondControl: { x: Number(match[3]), y: Number(match[4]) },
			valley: { x: Number(match[5]), y: Number(match[6]) }
		}));
}

function expectBoundedFinitePath(speechType: 'shout' | 'monologue', width: number, height: number): void {
	const path = createSpeechBubblePath(speechType, width, height) ?? '';
	const values = coordinates(path);
	expect(values.length).toBeGreaterThan(0);
	expect(values.every(Number.isFinite)).toBe(true);
	const xs = values.filter((_, index) => index % 2 === 0);
	const ys = values.filter((_, index) => index % 2 === 1);
	expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
	expect(Math.max(...xs)).toBeLessThanOrEqual(width);
	expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
	expect(Math.max(...ys)).toBeLessThanOrEqual(height);
}

describe('createSpeechBubblePath', () => {
	it('leaves normal bubbles on their existing CSS surface', () => {
		expect(createSpeechBubblePath('normal', 184, 54)).toBeNull();
	});

	it('creates a deterministic all-perimeter shout burst with repeated tips and valleys', () => {
		const width = 184;
		const height = 54;
		const path = createSpeechBubblePath('shout', width, height) ?? '';
		expect(path).toBe(createSpeechBubblePath('shout', width, height));
		expect(commandCount(path, 'L')).toBeGreaterThanOrEqual(23);
		expect(commandCount(path, 'Q')).toBe(0);
		const points = linePoints(path);
		const tips = points.filter((_, index) => index % 2 === 0);
		const valleys = points.filter((_, index) => index % 2 === 1);
		expect(tips).toHaveLength(12);
		expect(tips.filter((point) => point.y < 14).length).toBeGreaterThanOrEqual(3);
		expect(tips.filter((point) => point.y > 40).length).toBeGreaterThanOrEqual(3);
		expect(tips.filter((point) => point.x < 46).length).toBeGreaterThanOrEqual(2);
		expect(tips.filter((point) => point.x > 138).length).toBeGreaterThanOrEqual(2);
		const tipRadii = tips.map((point) => normalizedSuperellipseRadius(point, width, height));
		const valleyRadii = valleys.map((point) => normalizedSuperellipseRadius(point, width, height));
		expect(Math.max(...tipRadii) - Math.min(...tipRadii)).toBeGreaterThanOrEqual(0.04);
		expect(Math.min(...tipRadii) - Math.max(...valleyRadii)).toBeGreaterThan(0.08);
	});

	it('creates a deterministic rounded cloud from multiple cubic lobes', () => {
		const width = 184;
		const height = 54;
		const path = createSpeechBubblePath('monologue', width, height) ?? '';
		expect(path).toBe(createSpeechBubblePath('monologue', width, height));
		expect(commandCount(path, 'C')).toBeGreaterThanOrEqual(10);
		expect(commandCount(path, 'L')).toBe(0);
		expect(commandCount(path, 'Q')).toBe(0);
		const lobes = cubicLobes(path);
		expect(lobes).toHaveLength(10);
		const controlRadii = lobes.flatMap((lobe) => [
			normalizedSuperellipseRadius(lobe.firstControl, width, height),
			normalizedSuperellipseRadius(lobe.secondControl, width, height)
		]);
		const valleyRadii = lobes.map((lobe) => normalizedSuperellipseRadius(lobe.valley, width, height));
		expect(Math.min(...controlRadii) - Math.max(...valleyRadii)).toBeGreaterThan(0.12);
	});

	it.each([
		[72, 30],
		[184, 54],
		[330, 128]
	] as const)('keeps both special paths finite and inside a %dx%d measured bubble', (width, height) => {
		expectBoundedFinitePath('shout', width, height);
		expectBoundedFinitePath('monologue', width, height);
	});
});
