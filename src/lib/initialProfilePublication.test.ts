import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import { CHARACTER_CATALOG } from './character';
import {
	prepareInitialProfilePublication,
	publishInitialProfile,
	reachedAuthoritativeRelay
} from './initialProfilePublication';
import type { AccountSnapshot } from './nostrAccount';
import type { PublishRelayResult } from './nostrRelayTransport';

const mocked = vi.hoisted(() => ({ markInitialProfilePublished: vi.fn() }));

vi.mock('./nostrAccount', async (importOriginal) => ({
	...(await importOriginal<typeof import('./nostrAccount')>()),
	markInitialProfilePublished: mocked.markInitialProfilePublished
}));

const SECRET_KEY = new Uint8Array(32).fill(11);
const account: AccountSnapshot = {
	secretKey: SECRET_KEY,
	pubkey: getPublicKey(SECRET_KEY),
	lastChangedAtMs: 1_700_000_000_789,
	initialProfilePublished: false
};

function prepare() {
	return prepareInitialProfilePublication({
		account,
		character: CHARACTER_CATALOG[0],
		absolutePictureUrl: 'https://field.example.test/persona-bubble-field/characters/001.webp'
	});
}

function relay(outcome: PublishRelayResult['outcome'], notice?: string): PublishRelayResult {
	return { relayUrl: 'wss://relay.example.test/', outcome, ...(notice ? { notice } : {}) };
}

describe('initial profile publication', () => {
	it('retries with the same created_at and signed event ID for the same account and asset URL', () => {
		const first = prepare();
		const retry = prepare();

		expect(first.event.created_at).toBe(1_700_000_000);
		expect(retry.event.created_at).toBe(first.event.created_at);
		expect(retry.event.id).toBe(first.event.id);
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
		mocked.markInitialProfilePublished.mockReset().mockResolvedValue({ kind: 'recorded' });

		await expect(publishInitialProfile(prepare(), vi.fn().mockResolvedValue(results))).resolves.toEqual({ kind: 'recorded' });
		expect(mocked.markInitialProfilePublished).toHaveBeenCalledWith(account);
	});

	it('keeps rejected and no-response publication retryable without writing a marker', async () => {
		mocked.markInitialProfilePublished.mockReset();

		await expect(publishInitialProfile(prepare(), vi.fn().mockResolvedValue([relay('rejected', 'rate-limited: later')]))).resolves.toEqual({ kind: 'retryable' });
		await expect(publishInitialProfile(prepare(), vi.fn().mockResolvedValue([relay('no-response')]))).resolves.toEqual({ kind: 'retryable' });
		expect(mocked.markInitialProfilePublished).not.toHaveBeenCalled();
	});

	it('absorbs a disposed transport rejection without marking or leaking a detached rejection', async () => {
		mocked.markInitialProfilePublished.mockReset();
		const publish = vi.fn().mockRejectedValue(new Error('disposed'));

		const detached = publishInitialProfile(prepare(), publish);

		await expect(detached).resolves.toEqual({ kind: 'retryable' });
		expect(mocked.markInitialProfilePublished).not.toHaveBeenCalled();
	});

	it('keeps marker persistence failure retryable after an accepted publication', async () => {
		mocked.markInitialProfilePublished.mockReset().mockRejectedValue(new Error('storage failed'));

		await expect(publishInitialProfile(prepare(), vi.fn().mockResolvedValue([relay('accepted')]))).resolves.toEqual({ kind: 'retryable' });
	});
});
