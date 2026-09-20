import { describe, expect, it } from 'vitest';
import { DEATH_DEV_INITIAL_LIFESPAN_MS, isDeathDevMode, resolveInitialLifespanMs } from './deathDevMode';
import { INITIAL_LIFESPAN_MS } from './personaGameState';

describe('death DEV mode resolver', () => {
	it('is enabled only for development death mode', () => {
		expect(isDeathDevMode(true, 'death')).toBe(true);
		expect(isDeathDevMode(true, 'development')).toBe(false);
		expect(isDeathDevMode(false, 'death')).toBe(false);
	});

	it('keeps production lifespan outside the development death mode', () => {
		expect(resolveInitialLifespanMs(true, 'death', INITIAL_LIFESPAN_MS)).toBe(DEATH_DEV_INITIAL_LIFESPAN_MS);
		expect(resolveInitialLifespanMs(true, 'development', INITIAL_LIFESPAN_MS)).toBe(INITIAL_LIFESPAN_MS);
		expect(resolveInitialLifespanMs(false, 'death', INITIAL_LIFESPAN_MS)).toBe(INITIAL_LIFESPAN_MS);
	});
});
