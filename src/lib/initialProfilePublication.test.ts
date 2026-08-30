import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { CHARACTER_CATALOG } from './character';
import {
	prepareCharacterProfilePublication,
	publishCharacterProfile,
	reachedAuthoritativeRelay
} from './initialProfilePublication';
import type { AccountSnapshot } from './nostrAccount';
import type { PublishRelayResult } from './nostrRelayTransport';

const mocked = vi.hoisted(() => ({ markCharacterProfilePublication: vi.fn() }));

vi.mock('./nostrAccount', async (importOriginal) => ({
	...(await importOriginal<typeof import('./nostrAccount')>()),
	markCharacterProfilePublication: mocked.markCharacterProfilePublication
}));

const SECRET_KEY = new Uint8Array(32).fill(11);
const account: AccountSnapshot = {
	secretKey: SECRET_KEY,
	pubkey: getPublicKey(SECRET_KEY),
	lastChangedAtMs: 1_700_000_000_789,
	characterProfileRevision: null
};

function prepare(createdAt = 1_700_000_000) {
	return prepareCharacterProfilePublication({
		account,
		character: CHARACTER_CATALOG[19],
		absolutePictureUrl: 'https://field.example.test/persona-bubble-field/characters/020.webp',
		createdAt
	});
}

function relay(outcome: PublishRelayResult['outcome'], notice?: string): PublishRelayResult {
	return { relayUrl: 'wss://relay.example.test/', outcome, ...(notice ? { notice } : {}) };
}

describe('character profile publication', () => {
	it('keeps one publish attempt on the same created_at and signed event ID', () => {
		const first = prepare();
		const retry = prepare();

		expect(first.event.created_at).toBe(1_700_000_000);
		expect(retry.event.created_at).toBe(first.event.created_at);
		expect(retry.event.id).toBe(first.event.id);
		expect(JSON.parse(first.event.content)).toEqual({
			name: 'アミナ',
			about: '静かな場所ではよく笑う。',
			picture: 'https://field.example.test/persona-bubble-field/characters/020.webp'
		});
	});

	it('uses the supplied current Unix second for a restored-account resync', () => {
		expect(prepare(1_800_000_123).event.created_at).toBe(1_800_000_123);
		expect(prepare(1_800_000_123).event.created_at).not.toBe(Math.floor(account.lastChangedAtMs / 1000));
	});

	it.each([
		['accepted', [relay('accepted')], true],
		['canonical duplicate rejection', [relay('rejected', 'duplicate: already have event')], true],
		['bare duplicate word', [relay('rejected', 'duplicate already have event')], false],
		['duplicate substring', [relay('rejected', 'error: duplicate event')], false],
		['blocked rejection', [relay('rejected', 'blocked: denied')], false],
		['no response', [relay('no-response')], false]
	] as const)('treats %s as publication completion: %s', (_name, results, expected) => {
		expect(reachedAuthoritativeRelay(results)).toBe(expected);
	});

	it.each([
		['accepted', [relay('accepted')]],
		['canonical duplicate', [relay('rejected', 'duplicate: already have event')]]
	] as const)('records a successful %s publication', async (_name, results) => {
		mocked.markCharacterProfilePublication.mockReset().mockResolvedValue({ kind: 'recorded' });

		await expect(publishCharacterProfile(prepare(), vi.fn().mockResolvedValue(results))).resolves.toEqual({ kind: 'recorded' });
		expect(mocked.markCharacterProfilePublication).toHaveBeenCalledWith(account);
	});

	it('keeps rejected and no-response publication retryable without writing a marker', async () => {
		mocked.markCharacterProfilePublication.mockReset();

		await expect(publishCharacterProfile(prepare(), vi.fn().mockResolvedValue([relay('rejected', 'rate-limited: later')]))).resolves.toEqual({ kind: 'retryable' });
		await expect(publishCharacterProfile(prepare(), vi.fn().mockResolvedValue([relay('no-response')]))).resolves.toEqual({ kind: 'retryable' });
		expect(mocked.markCharacterProfilePublication).not.toHaveBeenCalled();
	});

	it('absorbs a disposed transport rejection without marking or leaking a detached rejection', async () => {
		mocked.markCharacterProfilePublication.mockReset();
		const publish = vi.fn().mockRejectedValue(new Error('disposed'));

		await expect(publishCharacterProfile(prepare(), publish)).resolves.toEqual({ kind: 'retryable' });
		expect(mocked.markCharacterProfilePublication).not.toHaveBeenCalled();
	});

	it('keeps marker persistence failure retryable after an accepted publication', async () => {
		mocked.markCharacterProfilePublication.mockReset().mockRejectedValue(new Error('storage failed'));

		await expect(publishCharacterProfile(prepare(), vi.fn().mockResolvedValue([relay('accepted')]))).resolves.toEqual({ kind: 'retryable' });
	});
});
