import { describe, expect, it } from 'vitest';
import { CHARACTER_CATALOG } from './character';
import {
	CHARACTER_SLOT_COUNT,
	deriveCharacterSlotFromPubkey,
	getCharacterBySlot,
	requireCharacterFromPubkey,
	resolveCharacterFromPubkey
} from './characterAssignment';

function pubkeyWithValue(value: number): string {
	return value.toString(16).padStart(64, '0');
}

describe('fixed character slot assignment', () => {
	it('derives the same fixed slot for the same canonical pubkey', () => {
		const pubkey = pubkeyWithValue(9);
		expect(deriveCharacterSlotFromPubkey(pubkey)).toBe(9);
		expect(deriveCharacterSlotFromPubkey(pubkey)).toBe(deriveCharacterSlotFromPubkey(pubkey));
	});

	it.each([...Array(40).keys()])('maps low canonical pubkey value %s to the matching current character', (value) => {
		expect(resolveCharacterFromPubkey(pubkeyWithValue(value))?.characterId)
			.toBe(String(value + 1).padStart(3, '0'));
	});

	it('uses 1024 fixed slots and wraps at the slot count', () => {
		expect(CHARACTER_SLOT_COUNT).toBe(1024);
		expect(deriveCharacterSlotFromPubkey(pubkeyWithValue(1024))).toBe(0);
		expect(resolveCharacterFromPubkey(pubkeyWithValue(1024))?.characterId).toBe('001');
		expect(deriveCharacterSlotFromPubkey(pubkeyWithValue(1024 + 39))).toBe(39);
	});

	it('does not derive assignment from catalog length or array order', () => {
		const reordered = [...CHARACTER_CATALOG].reverse();
		expect(resolveCharacterFromPubkey(pubkeyWithValue(9), reordered)?.characterId).toBe('010');
		expect(getCharacterBySlot(9, reordered)?.characterId).toBe('010');
		expect(resolveCharacterFromPubkey(pubkeyWithValue(39), CHARACTER_CATALOG.slice(0, 5))).toBeUndefined();
	});

	it('returns no character for an unassigned slot and never falls back', () => {
		expect(deriveCharacterSlotFromPubkey(pubkeyWithValue(40))).toBe(40);
		expect(resolveCharacterFromPubkey(pubkeyWithValue(40))).toBeUndefined();
		expect(getCharacterBySlot(40)).toBeUndefined();
		expect(() => requireCharacterFromPubkey(pubkeyWithValue(40))).toThrow('assigned character slot');
	});

	it.each(['', 'A'.repeat(64), 'g'.repeat(64), 'f'.repeat(63), 'f'.repeat(65)])(
		'fails closed for invalid canonical pubkeys: %s',
		(pubkey) => {
			expect(() => deriveCharacterSlotFromPubkey(pubkey)).toThrow(TypeError);
		}
	);
});
