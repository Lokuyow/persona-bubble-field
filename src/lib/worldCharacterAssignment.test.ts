import { describe, expect, it } from 'vitest';
import { deriveCharacterSlotFromPubkey, resolveCharacterFromPubkey } from './characterAssignment';
import { requireWorldCharacterFromPubkey, resolveWorldCharacterFromPubkey, WORLD_CHARACTER_OVERRIDES } from './worldCharacterAssignment';

const HAIKU_BOT_PUBKEY = '4afc021c034d6fc25aa7989f24f83d1ba214ca0aaf45e090efc98e4d866076b1';
const SAME_SLOT_OTHER_PUBKEY = `${'0'.repeat(61)}2b1`;
const UNASSIGNED_PUBKEY = '1'.repeat(64);

describe('world character assignment', () => {
	it('keeps the Haiku bot in fixed slot 689 while explicitly overriding its world character', () => {
		expect(deriveCharacterSlotFromPubkey(HAIKU_BOT_PUBKEY)).toBe(689);
		expect(resolveCharacterFromPubkey(HAIKU_BOT_PUBKEY)).toBeUndefined();
		expect(resolveWorldCharacterFromPubkey(HAIKU_BOT_PUBKEY)?.characterId).toBe('002');
		expect(WORLD_CHARACTER_OVERRIDES[HAIKU_BOT_PUBKEY]).toBe('002');
	});

	it('does not treat another pubkey in slot 689 as the explicit actor', () => {
		expect(deriveCharacterSlotFromPubkey(SAME_SLOT_OTHER_PUBKEY)).toBe(689);
		expect(resolveCharacterFromPubkey(SAME_SLOT_OTHER_PUBKEY)).toBeUndefined();
		expect(resolveWorldCharacterFromPubkey(SAME_SLOT_OTHER_PUBKEY)).toBeUndefined();
	});

	it('keeps generic unassigned pubkeys unresolved and strict world resolution fail-closed', () => {
		expect(resolveWorldCharacterFromPubkey(UNASSIGNED_PUBKEY)).toBeUndefined();
		expect(() => requireWorldCharacterFromPubkey(UNASSIGNED_PUBKEY)).toThrow('assigned world character');
	});
});
