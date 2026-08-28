import { describe, expect, it } from 'vitest';
import { CHARACTER_CATALOG } from './character';
import { deriveCharacterFromPubkey } from './characterAssignment';

function pubkeyWithValue(value: number): string {
	return value.toString(16).padStart(64, '0');
}

describe('prototype character assignment', () => {
	it('returns a stable character for the same pubkey and catalog', () => {
		const pubkey = pubkeyWithValue(9);

		expect(deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG)).toBe(CHARACTER_CATALOG[9]);
		expect(deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG)).toBe(CHARACTER_CATALOG[9]);
	});

	it.each([
		[0, '001'],
		[1, '002'],
		[9, '010']
	])('uses the current catalog index for canonical pubkey value %s', (value, characterId) => {
		expect(deriveCharacterFromPubkey(pubkeyWithValue(value), CHARACTER_CATALOG).characterId)
			.toBe(characterId);
	});

	it('uses the same rule with a changed candidate count without preserving old assignments', () => {
		const pubkey = pubkeyWithValue(9);
		const shortCatalog = CHARACTER_CATALOG.slice(0, 5);

		expect(deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG).characterId).toBe('010');
		expect(deriveCharacterFromPubkey(pubkey, shortCatalog).characterId).toBe('005');
	});

	it('maps each direct catalog index without per-character weights', () => {
		expect(CHARACTER_CATALOG.map((character, index) =>
			deriveCharacterFromPubkey(pubkeyWithValue(index), CHARACTER_CATALOG)
		)).toEqual(CHARACTER_CATALOG);
	});

	it.each([
		'',
		'A'.repeat(64),
		'g'.repeat(64),
		'f'.repeat(63),
		'f'.repeat(65)
	])('fails closed for invalid pubkeys: %s', (pubkey) => {
		expect(() => deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG)).toThrow(TypeError);
	});

	it('fails closed for an empty catalog without changing a caller catalog', () => {
		const catalogBefore = [...CHARACTER_CATALOG];

		expect(() => deriveCharacterFromPubkey(pubkeyWithValue(0), [])).toThrow(TypeError);
		expect(CHARACTER_CATALOG).toEqual(catalogBefore);
	});
});
