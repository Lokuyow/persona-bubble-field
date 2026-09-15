import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import { prepareCharacterProfilePublication, publishCharacterProfile } from './initialProfilePublication';
import type { ActiveSignerSnapshot } from './rootIdentity';
import { CHARACTER_CATALOG } from './character';

const secretKey = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(secretKey);
const signer: ActiveSignerSnapshot = {
	secretKey,
	pubkey,
	identityCreatedAtMs: 1_700_000_000_789,
	characterProfileRevision: null,
	identity: { generation: 1, accountIndex: 1, pubkey }
};

describe('initial character profile publication', () => {
	it('uses the active signer and identity time only for lifecycle state', () => {
		const publication = prepareCharacterProfilePublication({
			signer,
			character: CHARACTER_CATALOG[0],
			absolutePictureUrl: 'https://example.test/character.webp',
			createdAt: 1_800_000_123
		});
		expect(publication.event.pubkey).toBe(pubkey);
		expect(publication.event.created_at).toBe(1_800_000_123);
	});

	it('keeps publication failure retryable', async () => {
		const publication = prepareCharacterProfilePublication({
			signer,
			character: CHARACTER_CATALOG[0],
			absolutePictureUrl: 'https://example.test/character.webp',
			createdAt: 1_800_000_123
		});
		const result = await publishCharacterProfile(publication, async () => []);
		expect(result).toEqual({ kind: 'retryable' });
	});
});
