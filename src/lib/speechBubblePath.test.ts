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
		const path = createSpeechBubblePath('shout', 184, 54) ?? '';
		expect(path).toBe(createSpeechBubblePath('shout', 184, 54));
		expect(commandCount(path, 'L')).toBeGreaterThanOrEqual(23);
		expect(commandCount(path, 'Q')).toBe(0);
		const tips = linePoints(path).filter((_, index) => index % 2 === 0);
		expect(tips).toHaveLength(12);
		expect(tips.filter((point) => point.y < 14).length).toBeGreaterThanOrEqual(3);
		expect(tips.filter((point) => point.y > 40).length).toBeGreaterThanOrEqual(3);
		expect(tips.filter((point) => point.x < 46).length).toBeGreaterThanOrEqual(2);
		expect(tips.filter((point) => point.x > 138).length).toBeGreaterThanOrEqual(2);
	});

	it('creates a deterministic rounded cloud from multiple cubic lobes', () => {
		const path = createSpeechBubblePath('monologue', 184, 54) ?? '';
		expect(path).toBe(createSpeechBubblePath('monologue', 184, 54));
		expect(commandCount(path, 'C')).toBeGreaterThanOrEqual(10);
		expect(commandCount(path, 'L')).toBe(0);
		expect(commandCount(path, 'Q')).toBe(0);
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
