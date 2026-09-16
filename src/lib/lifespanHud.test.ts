import { describe, expect, it } from 'vitest';
import { formatElapsedDuration, formatMendingRate, formatRemainingDuration, formatRemainingLifespan } from './lifespanHud';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

describe('formatRemainingLifespan', () => {
	it('shows days and hours at the 24-hour boundary', () => {
		expect(formatRemainingLifespan(10 * DAY_MS + 18 * HOUR_MS, 3 * DAY_MS)).toBe('寿命 7日 18時間');
		expect(formatRemainingLifespan(24 * HOUR_MS, 0)).toBe('寿命 1日 0時間');
	});

	it('shows hours and minutes below one day', () => {
		expect(formatRemainingLifespan(23 * HOUR_MS + 59 * MINUTE_MS, 0)).toBe('寿命 23時間 59分');
	});

	it('shows only minutes below one hour and floors remaining time', () => {
		expect(formatRemainingLifespan(42 * MINUTE_MS + 59 * 1000, 0)).toBe('寿命 42分');
		expect(formatRemainingLifespan(59 * 1000, 0)).toBe('寿命 0分');
	});
});

describe('formatMendingRate', () => {
	it.each([
		[{ numerator: 4, denominator: 5 }, '0.8'],
		[{ numerator: 9, denominator: 10 }, '0.9'],
		[{ numerator: 1, denominator: 1 }, '1.0'],
		[{ numerator: 11, denominator: 10 }, '1.1'],
		[{ numerator: 5, denominator: 4 }, '1.25']
	] as const)('preserves the snapshot rate %s as %s', (rate, expected) => {
		expect(formatMendingRate(rate.numerator, rate.denominator)).toBe(expected);
	});
});

describe('mending duration formatting', () => {
	it('floors elapsed duration and shows sub-minute progress clearly', () => {
		expect(formatElapsedDuration(0)).toBe('0分');
		expect(formatElapsedDuration(4 * MINUTE_MS + 59 * 1000)).toBe('4分');
		expect(formatElapsedDuration(30 * 1000)).toBe('1分未満');
		expect(formatElapsedDuration(2 * HOUR_MS + 5 * MINUTE_MS)).toBe('2時間5分');
		expect(formatElapsedDuration(3 * HOUR_MS)).toBe('3時間');
	});

	it('ceils remaining duration for wait-time display', () => {
		expect(formatRemainingDuration(0)).toBe('0分');
		expect(formatRemainingDuration(59 * 1000)).toBe('1分');
		expect(formatRemainingDuration(7 * HOUR_MS + 56 * MINUTE_MS - 1)).toBe('7時間56分');
	});
});
