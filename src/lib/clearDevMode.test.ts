import { describe, expect, it } from 'vitest';
import { CLEAR_DEV_INITIAL_POINTS, isClearDevMode } from './clearDevMode';
import { NORMAL_CLEAR_THRESHOLD } from './rootIdentity';

describe('clear DEV mode resolver', () => {
	it('is enabled only for development clear mode', () => {
		expect(isClearDevMode(true, 'clear')).toBe(true);
		expect(isClearDevMode(true, 'death')).toBe(false);
		expect(isClearDevMode(true, 'development')).toBe(false);
		expect(isClearDevMode(false, 'clear')).toBe(false);
	});

	it('uses the canonical clear threshold as the initial point value', () => {
		expect(CLEAR_DEV_INITIAL_POINTS).toBe(NORMAL_CLEAR_THRESHOLD);
	});
});
