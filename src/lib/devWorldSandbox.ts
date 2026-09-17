import type { Direction } from './geometry';
import { isBlockedFacilityCell } from './fieldFacilities';
import { CHARACTER_CATALOG, getCharacterById, type Character } from './character';
import {
	createPresenceState,
	moveParticipant,
	type MovementResult,
	type PresenceField,
	type PresenceState
} from './presence';

export const DEV_WORLD_SELF_ID = 'you';

export const DEV_WORLD_DEFAULT_CHARACTER_ID = '001';

const DEV_WORLD_FIXTURE_CHARACTER_IDS: Readonly<Record<string, string>> = {
	['0'.repeat(64)]: '001',
	['1'.repeat(64)]: '010',
	['2'.repeat(64)]: '019',
	['3'.repeat(64)]: '028',
	['4'.repeat(64)]: '037',
	['5'.repeat(64)]: '006',
	['6'.repeat(64)]: '015',
	['7'.repeat(64)]: '024',
	['8'.repeat(64)]: '033',
	['9'.repeat(64)]: '002',
	['a'.repeat(64)]: '011',
	['b'.repeat(64)]: '020',
	['c'.repeat(64)]: '029',
	['d'.repeat(64)]: '038',
	['e'.repeat(64)]: '007',
	['f'.repeat(64)]: '016'
};

function initialPosition(field: PresenceField) {
	const preferred = {
		x: Math.floor((field.columns - 1) / 2),
		y: Math.floor((field.rows - 1) / 2)
	};
	if (!isBlockedFacilityCell(preferred)) return preferred;
	for (let y = 0; y < field.rows; y += 1) for (let x = 0; x < field.columns; x += 1) {
		if (!isBlockedFacilityCell({ x, y })) return { x, y };
	}
	throw new Error('Field has no available DEV World cells.');
}

/** Returns whether the explicit local-only sandbox request is available in this build. */
export function isDevWorldSandboxEnabled(isDev: boolean, search: URLSearchParams): boolean {
	return isDev && search.get('devWorld') === '1';
}

/** Resolves the optional DEV-only initial character without creating an assignment rule. */
export function resolveDevWorldCharacterId(search: URLSearchParams): string {
	const requestedId = search.get('devCharacter');
	return requestedId && getCharacterById(requestedId) ? requestedId : DEV_WORLD_DEFAULT_CHARACTER_ID;
}

/** Returns the catalog entry used by the DEV-only presentation. */
export function getDevWorldCharacter(characterId: string): Character {
	return getCharacterById(characterId) ?? CHARACTER_CATALOG[0];
}

/** Resolves the fixed characters used by deterministic DEV fixture pubkeys. */
export function getDevWorldFixtureCharacter(pubkey: string, fallbackCharacterId: string): Character {
	return getDevWorldCharacter(DEV_WORLD_FIXTURE_CHARACTER_IDS[pubkey] ?? fallbackCharacterId);
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
