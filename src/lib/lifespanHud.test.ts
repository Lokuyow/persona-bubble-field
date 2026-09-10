import { describe, expect, it } from 'vitest';
import { formatRemainingLifespan } from './lifespanHud';

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
