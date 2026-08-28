import type { Direction } from './geometry';
import {
	createPresenceState,
	moveParticipant,
	type MovementResult,
	type PresenceField,
	type PresenceState
} from './presence';

export const DEV_WORLD_SELF_ID = 'you';

export const DEV_WORLD_SELF_PRESENTATION = {
	name: 'Dev Wanderer',
	initials: 'DEV',
	color: 'sky'
} as const;

function initialPosition(field: PresenceField) {
	return {
		x: Math.floor((field.columns - 1) / 2),
		y: Math.floor((field.rows - 1) / 2)
	};
}

/** Returns whether the explicit local-only sandbox request is available in this build. */
export function isDevWorldSandboxEnabled(isDev: boolean, search: URLSearchParams): boolean {
	return isDev && search.get('devWorld') === '1';
}

/** Creates the deterministic local presence used by the DEV world sandbox. */
export function createDevWorldPresence(field: PresenceField, now: number): PresenceState {
	return createPresenceState(field, now, [{ id: DEV_WORLD_SELF_ID, position: initialPosition(field) }]);
}

/** Restores the local-only sandbox to its deterministic initial presence. */
export function resetDevWorldPresence(field: PresenceField, now: number): PresenceState {
	return createDevWorldPresence(field, now);
}

/** Moves only the sandbox self through the existing field/presence domain. */
export function moveDevWorldSelf(
	state: PresenceState,
	direction: Direction,
	now: number
): MovementResult {
	return moveParticipant(state, DEV_WORLD_SELF_ID, direction, now);
}
