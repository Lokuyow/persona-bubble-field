import { describe, expect, it } from 'vitest';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL, RANKING_TERMINAL, isBlockedFacilityCell, isWithinFacilityInteractionRange } from './fieldFacilities';

describe('fixed field facilities', () => {
	it('defines the terminal placements and protects their cells', () => {
		expect(MENDING_TERMINAL.position).toEqual({ x: 12, y: 3 });
		expect(ADJUSTMENT_TERMINAL.position).toEqual({ x: 14, y: 3 });
		expect(isBlockedFacilityCell(MENDING_TERMINAL.position)).toBe(true);
		expect(isBlockedFacilityCell(ADJUSTMENT_TERMINAL.position)).toBe(true);
		expect(RANKING_TERMINAL.position).toEqual({ x: 8, y: 0 });
		expect(isBlockedFacilityCell(RANKING_TERMINAL.position)).toBe(true);
		expect(isWithinFacilityInteractionRange({ x: 7, y: 0 }, RANKING_TERMINAL)).toBe(true);
		expect(isWithinFacilityInteractionRange({ x: 9, y: 1 }, RANKING_TERMINAL)).toBe(true);
		expect(isWithinFacilityInteractionRange(RANKING_TERMINAL.position, RANKING_TERMINAL)).toBe(false);
		expect(isWithinFacilityInteractionRange({ x: 11, y: 3 }, MENDING_TERMINAL)).toBe(true);
		expect(isWithinFacilityInteractionRange({ x: 13, y: 3 }, ADJUSTMENT_TERMINAL)).toBe(true);
		expect(isWithinFacilityInteractionRange(MENDING_TERMINAL.position, MENDING_TERMINAL)).toBe(false);
	});
});
