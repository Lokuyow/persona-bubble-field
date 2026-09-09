import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CURRENT_CHARACTER_PROFILE_REVISION,
	loadOrCreateAccount,
	markCharacterProfilePublication,
	type AccountSnapshot,
	type LoadAccountResult
} from './nostrAccount';

vi.mock('nostr-tools/pure', async (importOriginal) => {
	const actual = await importOriginal<typeof import('nostr-tools/pure')>();
	return { ...actual, generateSecretKey: vi.fn(actual.generateSecretKey) };
});

const DATABASE_NAME = 'persona-bubble-field-account';
const STORE_NAME = 'persona-bubble-field-account-state';
const LEGACY_SECRET_KEY = 'secret-key';
const WRAPPING_KEY = 'secret-wrapping-key';
const ENCRYPTED_SECRET_KEY = 'encrypted-secret-key';
const ACCOUNT_PUBKEY = 'account-pubkey';
const TIMESTAMP_KEY = 'last-changed-at-ms';
const MARKER_KEY = 'initial-profile-published-pubkey';
const TIME = 1_700_000_000_000;
const SECRET = new Uint8Array(32).fill(11);
const connections: IDBPDatabase[] = [];

function accountFrom(result: LoadAccountResult): AccountSnapshot {
	if (!('account' in result)) throw new Error('Expected an account result.');
	return result.account;
}

async function database(version = 2): Promise<IDBPDatabase> {
	const db = await openDB(DATABASE_NAME, version, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
		}
	});
	connections.push(db);
	return db;
}

async function seed(records: Record<string, unknown>, version = 2): Promise<void> {
	const db = await database(version);
	const tx = db.transaction(STORE_NAME, 'readwrite');
	for (const [key, value] of Object.entries(records)) await tx.store.put(value, key);
	await tx.done;
	db.close();
	connections.splice(connections.indexOf(db), 1);
}

async function storedRecords(): Promise<Record<string, unknown>> {
	const db = await database();
	const tx = db.transaction(STORE_NAME, 'readonly');
	const keys = await tx.store.getAllKeys();
	const values = await tx.store.getAll();
	await tx.done;
	return Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
}

async function protectedRecords(secret = SECRET, pubkey = getPublicKey(secret)) {
	const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, secret));
	return {
		[WRAPPING_KEY]: wrappingKey,
		[ENCRYPTED_SECRET_KEY]: { version: 1, iv, ciphertext },
		[ACCOUNT_PUBKEY]: pubkey,
		[TIMESTAMP_KEY]: TIME
	};
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

describe('protected account creation and restore', () => {
	it('creates v2 protected records without a plaintext secret', async () => {
		const result = await loadOrCreateAccount();
		expect(result.kind).toBe('created');
		const account = accountFrom(result);
		const records = await storedRecords();
		expect(account.secretKey instanceof Uint8Array && account.secretKey.length === 32).toBe(true);
		expect(getPublicKey(account.secretKey)).toBe(account.pubkey);
		expect(account.personaCreatedAtMs).toBe(TIME);
		expect(Object.keys(records).sort()).toEqual([ACCOUNT_PUBKEY, ENCRYPTED_SECRET_KEY, TIMESTAMP_KEY, WRAPPING_KEY].sort());
		expect(records[LEGACY_SECRET_KEY]).toBeUndefined();
		const key = records[WRAPPING_KEY] as CryptoKey;
		expect({ name: key.algorithm.name, length: (key.algorithm as AesKeyAlgorithm).length, extractable: key.extractable, usages: key.usages.sort() })
			.toEqual({ name: 'AES-GCM', length: 256, extractable: false, usages: ['decrypt', 'encrypt'] });
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeDefined();
	});

	it('restores the same identity after reload and isolates snapshot secret copies', async () => {
		const first = accountFrom(await loadOrCreateAccount());
		const second = accountFrom(await loadOrCreateAccount());
		expect(second.pubkey).toBe(first.pubkey);
		expect(second.personaCreatedAtMs).toBe(TIME);
		expect(second.secretKey).not.toBe(first.secretKey);
		first.secretKey.fill(0);
		const third = accountFrom(await loadOrCreateAccount());
		expect(third.pubkey).toBe(second.pubkey);
		expect(getPublicKey(third.secretKey)).toBe(third.pubkey);
	});

	it('converges concurrent creation calls on one committed identity', async () => {
		const results = await Promise.all(Array.from({ length: 5 }, () => loadOrCreateAccount()));
		expect(results.filter((result) => result.kind === 'created')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'restored')).toHaveLength(4);
		expect(new Set(results.map((result) => accountFrom(result).pubkey)).size).toBe(1);
		expect((await storedRecords())[LEGACY_SECRET_KEY]).toBeUndefined();
	});
});

describe('v1 migration and legacy preservation', () => {
	it('migrates a valid v1 account without changing identity, timestamp, or marker', async () => {
		const pubkey = getPublicKey(SECRET);
		await seed({ [LEGACY_SECRET_KEY]: SECRET, [TIMESTAMP_KEY]: TIME, [MARKER_KEY]: { pubkey, revision: 2 } }, 1);
		const result = await loadOrCreateAccount();
		const account = accountFrom(result);
		expect(result.kind).toBe('restored');
		expect(account.pubkey).toBe(pubkey);
		expect(account.personaCreatedAtMs).toBe(TIME);
		expect(account.characterProfileRevision).toBe(2);
		const records = await storedRecords();
		expect(records[LEGACY_SECRET_KEY]).toBeUndefined();
		expect(records[ACCOUNT_PUBKEY]).toBe(pubkey);
		expect(records[WRAPPING_KEY]).toBeInstanceOf(CryptoKey);
	});

	it('converges concurrent migrations and preserves the legacy identity', async () => {
		const pubkey = getPublicKey(SECRET);
		await seed({ [LEGACY_SECRET_KEY]: SECRET, [TIMESTAMP_KEY]: TIME }, 1);
		const results = await Promise.all(Array.from({ length: 4 }, () => loadOrCreateAccount()));
		expect(results.every((result) => result.kind === 'restored')).toBe(true);
		expect(new Set(results.map((result) => accountFrom(result).pubkey)).size).toBe(1);
		expect(accountFrom(results[0]).pubkey).toBe(pubkey);
		expect((await storedRecords())[LEGACY_SECRET_KEY]).toBeUndefined();
	});

	it('preserves missing and corrupt v1 records without repairing or recreating them', async () => {
		await seed({ [TIMESTAMP_KEY]: TIME }, 1);
		expect(await loadOrCreateAccount()).toEqual({ kind: 'missing-secret', personaCreatedAtMs: TIME });
		expect(await storedRecords()).toEqual({ [TIMESTAMP_KEY]: TIME });
		await seed({ [LEGACY_SECRET_KEY]: new Uint8Array(31), [TIMESTAMP_KEY]: TIME });
		expect(await loadOrCreateAccount()).toEqual({ kind: 'corrupt', reason: 'invalid-secret' });
		expect((await storedRecords())[LEGACY_SECRET_KEY]).toEqual(new Uint8Array(31));
	});
});

describe('protected fail-close behavior', () => {
	it('rejects partial or mixed protected state without creating an account', async () => {
		const wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
		for (const records of [
			{ [TIMESTAMP_KEY]: TIME, [WRAPPING_KEY]: wrapping },
			{ [TIMESTAMP_KEY]: TIME, [ACCOUNT_PUBKEY]: 'a'.repeat(64) },
			{ [TIMESTAMP_KEY]: TIME, [LEGACY_SECRET_KEY]: SECRET, [WRAPPING_KEY]: wrapping }
		]) {
			await seed(records);
			expect(await loadOrCreateAccount()).toEqual({ kind: 'corrupt', reason: 'invalid-secret' });
			expect((await storedRecords())[LEGACY_SECRET_KEY]).toEqual(records[LEGACY_SECRET_KEY]);
		}
	});

	it('fails closed when ciphertext is tampered or the persisted pubkey mismatches', async () => {
		const records = await protectedRecords();
		(records[ENCRYPTED_SECRET_KEY] as { ciphertext: Uint8Array }).ciphertext[0] ^= 1;
		await seed(records);
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		await seed(await protectedRecords(SECRET, 'f'.repeat(64)));
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
	});

	it('treats a transaction failure as atomic and sanitized', async () => {
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (key === ENCRYPTED_SECRET_KEY) throw new DOMException('secret data should not escape', 'QuotaExceededError');
			return originalPut.call(this, value, key);
		});
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(await storedRecords()).toEqual({});
	});
});

describe('profile marker persistence and stale snapshots', () => {
	it('records the marker for the current protected account and rejects stale snapshots', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		expect(await markCharacterProfilePublication(account)).toEqual({ kind: 'recorded' });
		expect((await storedRecords())[MARKER_KEY]).toEqual({ pubkey: account.pubkey, revision: CURRENT_CHARACTER_PROFILE_REVISION });
		const stale = { ...account, pubkey: 'f'.repeat(64) };
		expect(await markCharacterProfilePublication(stale)).toEqual({ kind: 'stale' });
		expect(accountFrom(await loadOrCreateAccount()).characterProfileRevision).toBe(CURRENT_CHARACTER_PROFILE_REVISION);
	});

	it('keeps the account intact when marker persistence aborts', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (key === MARKER_KEY) throw new DOMException('marker failure', 'QuotaExceededError');
			return originalPut.call(this, value, key);
		});
		await expect(markCharacterProfilePublication(account)).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(accountFrom(await loadOrCreateAccount()).pubkey).toBe(account.pubkey);
		expect((await storedRecords())[MARKER_KEY]).toBeUndefined();
	});
});

describe('database version barrier', () => {
	it('opens v2 and rejects the old v1 open path', async () => {
		await loadOrCreateAccount();
		await expect(database(1)).rejects.toMatchObject({ name: 'VersionError' });
	});
});
