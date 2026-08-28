import type { Character } from './character';

const NOSTR_PUBKEY = /^[0-9a-f]{64}$/;

/** Derives one catalog character from a canonical Nostr pubkey without storing an assignment. */
export function deriveCharacterFromPubkey(
	pubkey: string,
	catalog: readonly Character[]
): Character {
	if (!NOSTR_PUBKEY.test(pubkey)) {
		throw new TypeError('Pubkey must be a 64-character lowercase hexadecimal Nostr public key.');
	}
	if (catalog.length === 0) {
		throw new TypeError('Character catalog must not be empty.');
	}

	const index = Number(BigInt(`0x${pubkey}`) % BigInt(catalog.length));
	return catalog[index];
}
