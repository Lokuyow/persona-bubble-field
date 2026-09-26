import { describe, expect, it } from 'vitest';
import { formatContextCapacityMinutes } from './abilityDisplay';

describe('context capacity display', () => {
	it.each([
		[5, '5分'],
		[50, '50分'],
		[60, '1時間0分'],
		[65, '1時間5分'],
		[1490, '24時間50分']
	])('formats %i minutes as %s', (minutes, expected) => {
		expect(formatContextCapacityMinutes(minutes)).toBe(expected);
	});
});
