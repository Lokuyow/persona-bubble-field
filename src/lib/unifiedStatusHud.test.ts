import { describe, expect, it } from 'vitest';
import { projectUnifiedStatusMeterValues, STATUS_HUD_POINTS_MAX } from './unifiedStatusHud';
import { rootMaximumLifespanMs } from './rootProgression';

describe('unified status meter values', () => {
	it.each([[0, 7], [1, 14], [2, 21], [3, 30]])('uses Root Rank %i maximum %i-day lifespan without changing a fresh Run\'s seven day fill', (rank, days) => {
		const maximum = rootMaximumLifespanMs(rank);
		const initial = rootMaximumLifespanMs(0);
		expect(projectUnifiedStatusMeterValues(0, initial, maximum).lifespan).toBe(initial);
		expect(maximum).toBe(days * 24 * 60 * 60 * 1_000);
	});

	it.each([0, 50_000, 99_999, 100_000, 125_000])('clamps %i owned points to the linear 100,000pt meter range', (points) => {
		expect(projectUnifiedStatusMeterValues(points, 0, 7 * 24 * 60 * 60 * 1_000).points).toBe(Math.min(points, STATUS_HUD_POINTS_MAX));
	});

	it('clamps expired and over-cap lifespan values while preserving the valid range', () => {
		const maximum = 7 * 24 * 60 * 60 * 1_000;
		expect(projectUnifiedStatusMeterValues(0, 0, maximum).lifespan).toBe(0);
		expect(projectUnifiedStatusMeterValues(0, maximum / 2, maximum).lifespan).toBe(maximum / 2);
		expect(projectUnifiedStatusMeterValues(0, maximum * 2, maximum).lifespan).toBe(maximum);
	});
});
