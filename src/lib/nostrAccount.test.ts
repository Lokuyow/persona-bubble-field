import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ACCOUNT_REINCARNATION_COOLDOWN_MS,
	getReincarnationEligibility,
	loadOrCreateAccount,
	markInitialProfilePublished,
	reincarnateAccount,
	type AccountSnapshot,
	type LoadAccountResult,
	type ReincarnateAccountResult
} from './nostrAccount';
import { buildWorldMessageTemplate, finalizeWorldEvent } from './nostrProtocol';

// Only the public randomness boundary is controlled; storage and key derivation stay real.
vi.mock('nostr-tools/pure', async (importOriginal) => {
	const actual = await importOriginal<typeof import('nostr-tools/pure')>();
	return { ...actual, generateSecretKey: vi.fn(actual.generateSecretKey) };
});

const DATABASE_NAME = 'persona-bubble-field-account';
const STORE_NAME = 'persona-bubble-field-account-state';
const SECRET_KEY = 'secret-key';
const TIMESTAMP_KEY = 'last-changed-at-ms';
const INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY = 'initial-profile-published-pubkey';
const TIME = 1_700_000_000_000;
const DAY = ACCOUNT_REINCARNATION_COOLDOWN_MS;
const MAX_TIME = Number.MAX_SAFE_INTEGER - DAY;
// Publicly known dummy keys only; never use real account material as fixtures.
const DUMMY_SECRET = new Uint8Array(32).fill(11);
const connections: IDBPDatabase[] = [];

async function database(): Promise<IDBPDatabase> {
	const db = await openDB(DATABASE_NAME, 1, {
		upgrade(db) { db.createObjectStore(STORE_NAME); }
	});
	connections.push(db);
	return db;
}

async function seed(records: Record<string, unknown>): Promise<void> {
	const tx = (await database()).transaction(STORE_NAME, 'readwrite');
	for (const [key, value] of Object.entries(records)) await tx.store.put(value, key);
	await tx.done;
}

async function storedRecords(): Promise<Record<string, unknown>> {
	const tx = (await database()).transaction(STORE_NAME, 'readonly');
	const keys = await tx.store.getAllKeys();
	const values = await tx.store.getAll();
	await tx.done;
	return Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
}

function accountFrom(result: LoadAccountResult | ReincarnateAccountResult): AccountSnapshot {
	if (!('account' in result)) throw new Error('Expected an account result.');
	return result.account;
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.spyOn(Date, 'now').mockReturnValue(TIME);
	let sequence = 0;
	vi.mocked(generateSecretKey).mockReset().mockImplementation(() => new Uint8Array(32).fill(++sequence));
});

afterEach(() => {
	while (connections.length) connections.pop()!.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('initial creation and restore', () => {
	it('creates a valid account using the real generator and atomically stores just two records', async () => {
		const actual = await vi.importActual<typeof import('nostr-tools/pure')>('nostr-tools/pure');
		vi.mocked(generateSecretKey).mockImplementationOnce(actual.generateSecretKey);
		const result = await loadOrCreateAccount();
		expect(result.kind).toBe('created');
		const account = accountFrom(result);
		const records = await storedRecords();
		// Boolean assertions avoid printing generated secret bytes on a failure.
		expect(account.secretKey instanceof Uint8Array && account.secretKey.length === 32).toBe(true);
		expect(getPublicKey(account.secretKey) === account.pubkey).toBe(true);
		expect(/^[0-9a-f]{64}$/.test(account.pubkey)).toBe(true);
		expect(account.lastChangedAtMs).toBe(TIME);
		expect(Object.keys(records).sort()).toEqual([TIMESTAMP_KEY, SECRET_KEY]);
		const secret = records[SECRET_KEY];
		expect(secret instanceof Uint8Array && secret.every((byte, i) => byte === account.secretKey[i])).toBe(true);
		expect(records[TIMESTAMP_KEY]).toBe(TIME);
		const db = await database();
		expect([...db.objectStoreNames]).toEqual([STORE_NAME]);
		const store = db.transaction(STORE_NAME).store;
		expect(store.keyPath).toBeNull();
		expect(store.autoIncrement).toBe(false);
		expect([...store.indexNames]).toEqual([]);
	});

	it('reopens and restores the same account without generating or changing its timestamp', async () => {
		const original = accountFrom(await loadOrCreateAccount());
		vi.mocked(Date.now).mockReturnValue(TIME + DAY * 3);
		const result = await loadOrCreateAccount();
		expect(result.kind).toBe('restored');
		expect(accountFrom(result)).toEqual(original);
		expect(accountFrom(result).secretKey).not.toBe(original.secretKey);
		expect(generateSecretKey).toHaveBeenCalledTimes(1);
		expect((await storedRecords())[TIMESTAMP_KEY]).toBe(TIME);
	});

	it('serializes concurrent initial calls on independent connections into one created account', async () => {
		const results = await Promise.all(Array.from({ length: 5 }, () => loadOrCreateAccount()));
		expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'restored')).toHaveLength(4);
		expect(new Set(results.map((result) => accountFrom(result).pubkey)).size).toBe(1);
		expect(generateSecretKey).toHaveBeenCalledTimes(1);
		const account = accountFrom(results[0]);
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: account.secretKey, [TIMESTAMP_KEY]: TIME });
	});

	it('does not create an uninitialized account through the reincarnation API', async () => {
		expect(await reincarnateAccount()).toEqual({ kind: 'uninitialized' });
		expect(await storedRecords()).toEqual({});
		expect(generateSecretKey).not.toHaveBeenCalled();
	});
});

describe('cooldown and reincarnation', () => {
	it.each([0, DAY - 1, -1, -DAY])('blocks at offset %i without changing data or generating a key', async (offset) => {
		await loadOrCreateAccount();
		const before = await storedRecords();
		vi.mocked(Date.now).mockReturnValue(TIME + offset);
		expect(await reincarnateAccount()).toEqual({ kind: 'cooldown', nextAllowedAtMs: TIME + DAY });
		expect(await storedRecords()).toEqual(before);
		expect(generateSecretKey).toHaveBeenCalledTimes(1);
	});

	it.each([DAY, DAY + 1])('replaces the account at offset %i without retaining history', async (offset) => {
		const original = accountFrom(await loadOrCreateAccount());
		vi.mocked(Date.now).mockReturnValue(TIME + offset);
		const result = await reincarnateAccount();
		expect(result.kind).toBe('reincarnated');
		const next = accountFrom(result);
		expect(next.secretKey).not.toEqual(original.secretKey);
		expect(next.pubkey).not.toBe(original.pubkey);
		expect(next.pubkey).toBe(getPublicKey(next.secretKey));
		expect(next.lastChangedAtMs).toBe(TIME + offset);
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: next.secretKey, [TIMESTAMP_KEY]: TIME + offset });
		expect(accountFrom(await loadOrCreateAccount())).toEqual(next);
		expect(await reincarnateAccount()).toEqual({ kind: 'cooldown', nextAllowedAtMs: TIME + offset + DAY });
	});

	it.each(['ready', 'missing-secret'] as const)('allows only one concurrent replacement of %s state', async (state) => {
		await seed({ [TIMESTAMP_KEY]: TIME, ...(state === 'ready' ? { [SECRET_KEY]: DUMMY_SECRET } : {}) });
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const results = await Promise.all([reincarnateAccount(), reincarnateAccount(), reincarnateAccount()]);
		expect(results.filter((result) => result.kind === 'reincarnated')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'cooldown')).toEqual([
			{ kind: 'cooldown', nextAllowedAtMs: TIME + DAY * 2 },
			{ kind: 'cooldown', nextAllowedAtMs: TIME + DAY * 2 }
		]);
		expect(generateSecretKey).toHaveBeenCalledTimes(1);
		const next = accountFrom(results.find((result) => result.kind === 'reincarnated')!);
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: next.secretKey, [TIMESTAMP_KEY]: TIME + DAY });
	});

	it('samples the clock after reading persisted state and uses that sample for the new timestamp', async () => {
		await seed({ [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME });
		const originalGetAll = IDBObjectStore.prototype.getAll;
		const read = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, key, count) {
			const request = originalGetAll.call(this, key, count);
			if (key === TIMESTAMP_KEY) request.addEventListener('success', () => {
				vi.mocked(Date.now).mockReturnValue(TIME + DAY);
			});
			return request;
		});
		vi.mocked(Date.now).mockClear();
		const result = await reincarnateAccount();
		read.mockRestore();
		expect(result.kind).toBe('reincarnated');
		expect(accountFrom(result).lastChangedAtMs).toBe(TIME + DAY);
	});

	it('calculates eligibility without calendar rounding or clock regression recovery', () => {
		expect(DAY).toBe(86_400_000);
		expect(getReincarnationEligibility(TIME, TIME + DAY - 1)).toEqual({ canReincarnate: false, nextAllowedAtMs: TIME + DAY });
		expect(getReincarnationEligibility(TIME, TIME + DAY)).toEqual({ canReincarnate: true, nextAllowedAtMs: TIME + DAY });
		expect(getReincarnationEligibility(TIME, TIME - 1).canReincarnate).toBe(false);
		expect(getReincarnationEligibility(0, DAY).canReincarnate).toBe(true);
		expect(getReincarnationEligibility(MAX_TIME, MAX_TIME)).toEqual({ canReincarnate: false, nextAllowedAtMs: Number.MAX_SAFE_INTEGER });
	});

	it.each([-1, 1.5, NaN, Infinity, MAX_TIME + 1])('rejects invalid time %s in the pure check and mutations', async (time) => {
		expect(() => getReincarnationEligibility(time, TIME)).toThrow(TypeError);
		expect(() => getReincarnationEligibility(TIME, time)).toThrow(TypeError);
		vi.mocked(Date.now).mockReturnValue(time);
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		expect(await storedRecords()).toEqual({});
		await seed({ [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME });
		await expect(reincarnateAccount()).rejects.toThrow('Account operation failed.');
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME });
		expect(generateSecretKey).not.toHaveBeenCalled();
	});
});

describe('missing and corrupt records', () => {
	it('never auto-creates after secret deletion, but permits explicit replacement at the boundary', async () => {
		await loadOrCreateAccount();
		await (await database()).delete(STORE_NAME, SECRET_KEY);
		for (const now of [TIME, TIME + DAY - 1, TIME + DAY, TIME + DAY * 2]) {
			vi.mocked(Date.now).mockReturnValue(now);
			expect(await loadOrCreateAccount()).toEqual({ kind: 'missing-secret', lastChangedAtMs: TIME });
			expect(await storedRecords()).toEqual({ [TIMESTAMP_KEY]: TIME });
		}
		expect(generateSecretKey).toHaveBeenCalledTimes(1);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY - 1);
		expect(await reincarnateAccount()).toEqual({ kind: 'cooldown', nextAllowedAtMs: TIME + DAY });
		expect(await storedRecords()).toEqual({ [TIMESTAMP_KEY]: TIME });
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const result = await reincarnateAccount();
		expect(result.kind).toBe('reincarnated');
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: accountFrom(result).secretKey, [TIMESTAMP_KEY]: TIME + DAY });
	});

	const corruptCases: { name: string; records: Record<string, unknown>; reason: string }[] = [
		{ name: 'missing timestamp', records: { [SECRET_KEY]: DUMMY_SECRET }, reason: 'missing-timestamp' },
		{ name: 'present undefined secret without timestamp', records: { [SECRET_KEY]: undefined }, reason: 'missing-timestamp' },
		...[undefined, null, '1700000000000', -1, 0.5, NaN, Infinity, MAX_TIME + 1].map((value, i) => ({
			name: `invalid timestamp ${i}`, records: { [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: value }, reason: 'invalid-timestamp'
		})),
		{ name: 'present undefined timestamp without secret', records: { [TIMESTAMP_KEY]: undefined }, reason: 'invalid-timestamp' },
		...[undefined, null, NaN, 'not-a-secret', Array(32).fill(1), new Uint8Array(31), new Uint8Array(33), new Uint8Array(32), new Uint8Array(32).fill(255)].map((value, i) => ({
			name: `invalid secret ${i}`, records: { [SECRET_KEY]: value, [TIMESTAMP_KEY]: TIME }, reason: 'invalid-secret'
		})),
		{ name: 'timestamp validation precedes secret validation', records: { [SECRET_KEY]: null, [TIMESTAMP_KEY]: null }, reason: 'invalid-timestamp' }
	];
	it.each(corruptCases)('fails closed for $name', async ({ records, reason }) => {
		await seed(records);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY * 2);
		expect(await loadOrCreateAccount()).toEqual({ kind: 'corrupt', reason });
		expect(await reincarnateAccount()).toEqual({ kind: 'corrupt', reason });
		expect(await storedRecords()).toEqual(records);
		expect(generateSecretKey).not.toHaveBeenCalled();
	});
});

describe('snapshots and the existing signing boundary', () => {
	it('does not share mutable keys across calls or with persistence', async () => {
		const first = accountFrom(await loadOrCreateAccount());
		const second = accountFrom(await loadOrCreateAccount());
		expect(first.secretKey).not.toBe(second.secretKey);
		first.secretKey.fill(0);
		expect(getPublicKey(second.secretKey)).toBe(second.pubkey);
		expect(accountFrom(await loadOrCreateAccount())).toEqual(second);
	});

	it('keeps an operation snapshot valid for signing after reincarnation', async () => {
		const operationAccount = accountFrom(await loadOrCreateAccount());
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const next = accountFrom(await reincarnateAccount());
		const signed = finalizeWorldEvent(buildWorldMessageTemplate({
			channel: { channelId: 'a'.repeat(64), relayHint: 'wss://relay.example/' },
			content: 'test', speechType: 'normal', position: { x: 1, y: 2 }, createdAt: TIME / 1000
		}), operationAccount.secretKey);
		expect(signed.pubkey).toBe(operationAccount.pubkey);
		expect(signed.pubkey).not.toBe(next.pubkey);
		expect(verifyEvent(signed)).toBe(true);
		expect((await storedRecords())[SECRET_KEY]).toEqual(next.secretKey);
	});
});

describe('initial profile publication marker', () => {
	it('recognizes and idempotently records only the current account publication', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		expect(account.initialProfilePublished).toBe(false);

		expect(await markInitialProfilePublished(account)).toEqual({ kind: 'recorded' });
		expect(await markInitialProfilePublished(account)).toEqual({ kind: 'recorded' });
		expect((await storedRecords())[INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY]).toBe(account.pubkey);
		expect(accountFrom(await loadOrCreateAccount()).initialProfilePublished).toBe(true);
	});

	it('clears the old marker during reincarnation so the replacement is unpublished', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		await markInitialProfilePublished(account);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);

		const replacement = accountFrom(await reincarnateAccount());

		expect(replacement.initialProfilePublished).toBe(false);
		expect((await storedRecords())[INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY]).toBeUndefined();
	});

	it('rejects a stale snapshot without marking the replacement account', async () => {
		const oldAccount = accountFrom(await loadOrCreateAccount());
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const replacement = accountFrom(await reincarnateAccount());

		expect(await markInitialProfilePublished(oldAccount)).toEqual({ kind: 'stale' });
		expect((await storedRecords())[INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY]).toBeUndefined();
		expect(accountFrom(await loadOrCreateAccount())).toEqual(replacement);
	});

	it('leaves a concurrent replacement unpublished regardless of marker transaction order', async () => {
		const oldAccount = accountFrom(await loadOrCreateAccount());
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);

		const [markerResult, replacementResult] = await Promise.all([
			markInitialProfilePublished(oldAccount),
			reincarnateAccount()
		]);

		expect(['recorded', 'stale']).toContain(markerResult.kind);
		const replacement = accountFrom(replacementResult);
		expect(replacement.pubkey).not.toBe(oldAccount.pubkey);
		expect(accountFrom(await loadOrCreateAccount()).initialProfilePublished).toBe(false);
		expect((await storedRecords())[INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY]).toBeUndefined();
	});

	it('preserves the account and allows retry after marker persistence fails', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (key === INITIAL_PROFILE_PUBLISHED_PUBKEY_KEY) {
				throw new DOMException('Simulated write failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});

		await expect(markInitialProfilePublished(account)).rejects.toThrow('Account operation failed.');
		put.mockRestore();

		expect(await storedRecords()).toEqual({ [SECRET_KEY]: account.secretKey, [TIMESTAMP_KEY]: TIME });
		expect(accountFrom(await loadOrCreateAccount()).initialProfilePublished).toBe(false);
		expect(await markInitialProfilePublished(account)).toEqual({ kind: 'recorded' });
	});
});

describe('failure atomicity through public IndexedDB and crypto boundaries', () => {
	it('rejects an incompatible database version without deleting it or falling back', async () => {
		const db = await openDB(DATABASE_NAME, 2, { upgrade(db) { db.createObjectStore(STORE_NAME); } });
		await db.put(STORE_NAME, TIME, TIMESTAMP_KEY);
		db.close();
		await expect(loadOrCreateAccount()).rejects.toThrow('Account storage could not be opened.');
		await expect(reincarnateAccount()).rejects.toThrow('Account storage could not be opened.');
		const unchanged = await openDB(DATABASE_NAME);
		connections.push(unchanged);
		expect(unchanged.version).toBe(2);
		expect(await unchanged.get(STORE_NAME, TIMESTAMP_KEY)).toBe(TIME);
		expect(await unchanged.count(STORE_NAME)).toBe(1);
		expect(generateSecretKey).not.toHaveBeenCalled();
	});

	it('rejects an aborted read and leaves the stored account intact', async () => {
		await seed({ [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME });
		const originalGetAll = IDBObjectStore.prototype.getAll;
		const read = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementationOnce(function (this: IDBObjectStore, key, count) {
			const request = originalGetAll.call(this, key, count);
			this.transaction.abort();
			return request;
		});
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		read.mockRestore();
		expect(await storedRecords()).toEqual({ [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME });
		expect(generateSecretKey).not.toHaveBeenCalled();
	});

	it.each(['fresh', 'ready', 'missing-secret'] as const)('rolls back %s state when the second write throws', async (state) => {
		const before = state === 'fresh' ? {} : { [TIMESTAMP_KEY]: TIME, ...(state === 'ready' ? { [SECRET_KEY]: DUMMY_SECRET } : {}) };
		await seed(before);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (key === TIMESTAMP_KEY) throw new DOMException('Simulated write failure.', 'QuotaExceededError');
			return originalPut.call(this, value, key);
		});
		await expect(state === 'fresh' ? loadOrCreateAccount() : reincarnateAccount()).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(await storedRecords()).toEqual(before);
	});

	it.each(['fresh', 'ready'] as const)('does not report success when %s writes succeed but the transaction aborts', async (state) => {
		const before = state === 'fresh' ? {} : { [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME };
		await seed(before);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		const originalPut = IDBObjectStore.prototype.put;
		let successfulWrites = 0;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			request.addEventListener('success', () => {
				successfulWrites++;
				if (key === TIMESTAMP_KEY) this.transaction.abort();
			});
			return request;
		});
		await expect(state === 'fresh' ? loadOrCreateAccount() : reincarnateAccount()).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(successfulWrites).toBe(2);
		expect(await storedRecords()).toEqual(before);
	});

	it.each(['fresh', 'ready'] as const)('sanitizes key generation failure and preserves %s state', async (state) => {
		const before = state === 'fresh' ? {} : { [SECRET_KEY]: DUMMY_SECRET, [TIMESTAMP_KEY]: TIME };
		await seed(before);
		vi.mocked(Date.now).mockReturnValue(TIME + DAY);
		vi.mocked(generateSecretKey).mockImplementationOnce(() => { throw new Error('Untrusted crypto error detail.'); });
		const failure = await (state === 'fresh' ? loadOrCreateAccount() : reincarnateAccount()).catch((error: unknown) => error);
		expect(failure instanceof Error && failure.message === 'Account operation failed.' && failure.cause === undefined).toBe(true);
		expect(await storedRecords()).toEqual(before);
	});

	it('rejects key derivation failure without persisting a generated invalid scalar', async () => {
		vi.mocked(generateSecretKey).mockReturnValueOnce(new Uint8Array(32));
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		expect(await storedRecords()).toEqual({});
	});
});
