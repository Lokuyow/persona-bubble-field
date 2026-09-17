import { CHARACTER_CATALOG, type Character } from './character';

export const CHARACTER_SLOT_COUNT = 1024;
const NOSTR_PUBKEY = /^[0-9a-f]{64}$/;

/** Derives a fixed assignment slot from a canonical Nostr pubkey. */
export function deriveCharacterSlotFromPubkey(pubkey: string): number {
	if (!NOSTR_PUBKEY.test(pubkey)) {
		throw new TypeError('Pubkey must be a 64-character lowercase hexadecimal Nostr public key.');
	}
	return Number(BigInt(`0x${pubkey}`) % BigInt(CHARACTER_SLOT_COUNT));
}

/** Resolves a fixed slot without treating catalog order as assignment metadata. */
export function getCharacterBySlot(slot: number, catalog: readonly Character[] = CHARACTER_CATALOG): Character | undefined {
	if (!Number.isInteger(slot) || slot < 0 || slot >= CHARACTER_SLOT_COUNT) return undefined;
	return catalog.find((character) => character.slot === slot);
}

/** Returns undefined for a valid pubkey whose fixed slot is not assigned. */
export function resolveCharacterFromPubkey(pubkey: string, catalog: readonly Character[] = CHARACTER_CATALOG): Character | undefined {
	return getCharacterBySlot(deriveCharacterSlotFromPubkey(pubkey), catalog);
}

/** Resolves an assigned pubkey and fails closed for an unassigned slot. */
export function requireCharacterFromPubkey(pubkey: string, catalog: readonly Character[] = CHARACTER_CATALOG): Character {
	const character = resolveCharacterFromPubkey(pubkey, catalog);
	if (!character) throw new Error('Pubkey does not resolve to an assigned character slot.');
	return character;
}
