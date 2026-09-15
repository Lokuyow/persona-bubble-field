import type { GridPosition } from './geometry';

export type FixedFieldFacility = Readonly<{
	kind: 'mending-terminal';
	position: GridPosition;
}>;

/** Prototype placement only. The facility definition owns its presentation, collision, and interaction cell. */
export const MENDING_TERMINAL: FixedFieldFacility = { kind: 'mending-terminal', position: { x: 12, y: 5 } };

export const FIXED_FIELD_FACILITIES: readonly FixedFieldFacility[] = [MENDING_TERMINAL];

export function sameFieldCell(first: GridPosition, second: GridPosition): boolean {
	return first.x === second.x && first.y === second.y;
}

export function isBlockedFacilityCell(position: GridPosition): boolean {
	return FIXED_FIELD_FACILITIES.some((facility) => sameFieldCell(facility.position, position));
}

export function isWithinFacilityInteractionRange(position: GridPosition, facility: FixedFieldFacility = MENDING_TERMINAL): boolean {
	return Math.max(Math.abs(position.x - facility.position.x), Math.abs(position.y - facility.position.y)) <= 1 &&
		!sameFieldCell(position, facility.position);
}
