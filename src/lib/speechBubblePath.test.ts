import { describe, expect, it } from 'vitest';
import { createSpeechBubblePath } from './speechBubblePath';

function coordinates(path: string): number[] {
	return [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

describe('createSpeechBubblePath', () => {
	it('leaves normal bubbles on their existing CSS surface', () => {
		expect(createSpeechBubblePath('normal', 184, 54)).toBeNull();
	});

	it.each([
		['shout', 'L', 'Q'],
		['monologue', 'Q', 'L']
	] as const)('creates a bounded %s path', (speechType, requiredCommand, absentCommand) => {
		const path = createSpeechBubblePath(speechType, 184, 54);
		expect(path).toContain(requiredCommand);
		expect(path).not.toContain(absentCommand);
		const values = coordinates(path ?? '');
		const xs = values.filter((_, index) => index % 2 === 0);
		const ys = values.filter((_, index) => index % 2 === 1);
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...xs)).toBeLessThanOrEqual(184);
		expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...ys)).toBeLessThanOrEqual(54);
	});

	it('adapts to a smaller measured bubble without introducing an outside stroke path', () => {
		const path = createSpeechBubblePath('shout', 72, 30);
		const values = coordinates(path ?? '');
		expect(Math.max(...values.filter((_, index) => index % 2 === 0))).toBeLessThanOrEqual(72);
		expect(Math.max(...values.filter((_, index) => index % 2 === 1))).toBeLessThanOrEqual(30);
	});
});
