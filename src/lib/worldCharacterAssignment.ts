import { getCharacterById, type Character } from './character';
import { resolveCharacterFromPubkey } from './characterAssignment';

/** Explicit project-owned exceptions for world actors outside Hako Identity assignment. */
export const WORLD_CHARACTER_OVERRIDES = {
	'4afc021c034d6fc25aa7989f24f83d1ba214ca0aaf45e090efc98e4d866076b1': '002'
} as const satisfies Readonly<Record<string, string>>;

/** Resolves a world actor without changing the fixed-slot Identity assignment. */
export function resolveWorldCharacterFromPubkey(pubkey: string): Character | undefined {
	const overrideCharacterId = WORLD_CHARACTER_OVERRIDES[pubkey as keyof typeof WORLD_CHARACTER_OVERRIDES];
	if (overrideCharacterId) return getCharacterById(overrideCharacterId);
	return resolveCharacterFromPubkey(pubkey);
}

/** Resolves a world actor and fails closed when it has no world character. */
export function requireWorldCharacterFromPubkey(pubkey: string): Character {
	const character = resolveWorldCharacterFromPubkey(pubkey);
	if (!character) throw new Error('Pubkey does not resolve to an assigned world character.');
	return character;
}
