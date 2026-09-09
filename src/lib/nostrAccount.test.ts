import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CURRENT_CHARACTER_PROFILE_REVISION,
	loadOrCreateAccount,
	loadOrCreatePersona,
	markCharacterProfilePublication,
	reincarnateExpiredPersona,
	type AccountSnapshot,
	type LoadAccountResult
} from './nostrAccount';
import { INITIAL_LIFESPAN_MS, createInitialPersonaGameState } from './personaGameState';

vi.mock('nostr-tools/pure', async (importOriginal) => {
	const actual = await importOriginal<typeof import('nostr-tools/pure')>();
	return { ...actual, generateSecretKey: vi.fn(actual.generateSecretKey) };
});

const DATABASE_NAME = 'persona-bubble-field-account';
const STORE_NAME = 'persona-bubble-field-account-state';
const GAME_STORE_NAME = 'persona-bubble-field-game-state';
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

async function database(version = 3): Promise<IDBPDatabase> {
	const db = await openDB(DATABASE_NAME, version, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
			if (version >= 3 && !db.objectStoreNames.contains(GAME_STORE_NAME)) db.createObjectStore(GAME_STORE_NAME);
		}
	});
	connections.push(db);
	return db;
}

async function seed(records: Record<string, unknown>, version = 3): Promise<void> {
	const db = await database(version);
	const tx = db.transaction(STORE_NAME, 'readwrite');
	for (const [key, value] of Object.entries(records)) await tx.store.put(value, key);
	await tx.done;
	db.close();
	connections.splice(connections.indexOf(db), 1);
}

async function seedGameState(pubkey = getPublicKey(SECRET)): Promise<void> {
	await seedRawGameState(createInitialPersonaGameState(pubkey, TIME));
}

async function seedRawGameState(value: unknown, key = 'game-state'): Promise<void> {
	const db = await database();
	const tx = db.transaction(GAME_STORE_NAME, 'readwrite');
	await tx.store.put(value, key);
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

async function storedGameRecords(): Promise<Record<string, unknown>> {
	const db = await database();
	const tx = db.transaction(GAME_STORE_NAME, 'readonly');
	const keys = await tx.store.getAllKeys();
	const values = await tx.store.getAll();
	await tx.done;
	db.close();
	connections.splice(connections.indexOf(db), 1);
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
	it('creates v3 protected records and initial game state without a plaintext secret', async () => {
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
		await seed({ [LEGACY_SECRET_KEY]: SECRET, [TIMESTAMP_KEY]: TIME, [MARKER_KEY]: pubkey }, 1);
		const result = await loadOrCreateAccount();
		const account = accountFrom(result);
		expect(result.kind).toBe('restored');
		expect(account.pubkey).toBe(pubkey);
		expect(account.personaCreatedAtMs).toBe(TIME);
		expect(account.characterProfileRevision).toBe(1);
		const records = await storedRecords();
		expect(records[LEGACY_SECRET_KEY]).toBeUndefined();
		expect(records[ACCOUNT_PUBKEY]).toBe(pubkey);
		expect(records[WRAPPING_KEY]).toBeInstanceOf(CryptoKey);
		expect(records[MARKER_KEY]).toBe(pubkey);
	});

	it('gives a protected v2 account its lifecycle starting at v3 migration time', async () => {
		const pubkey = getPublicKey(SECRET);
		await seed({ ...(await protectedRecords()), [MARKER_KEY]: { pubkey, revision: 2 } }, 2);
		const result = await loadOrCreatePersona();
		expect(result.kind).toBe('restored');
		if (result.kind !== 'restored') return;
		expect(result.persona.account.pubkey).toBe(pubkey);
		expect(result.persona.account.personaCreatedAtMs).toBe(TIME);
		expect(result.persona.gameState).toMatchObject({
			personaPubkey: pubkey, lifespanExpiresAtMs: TIME + INITIAL_LIFESPAN_MS, points: 0,
			abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }
		});
		expect((await storedRecords())[MARKER_KEY]).toEqual({ pubkey, revision: 2 });
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
	it.each([
		['timestamp + wrapping key only', 'wrapping'],
		['timestamp + account pubkey only', 'pubkey'],
		['legacy plaintext secret + protected record', 'mixed']
	] as const)('rejects %s without repair or account creation', async (_name, stateKind) => {
		const wrapping = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const records = stateKind === 'wrapping' ?
			{ [TIMESTAMP_KEY]: TIME, [WRAPPING_KEY]: wrapping } :
			stateKind === 'pubkey' ?
				{ [TIMESTAMP_KEY]: TIME, [ACCOUNT_PUBKEY]: 'a'.repeat(64) } :
				{ [TIMESTAMP_KEY]: TIME, [LEGACY_SECRET_KEY]: SECRET, [WRAPPING_KEY]: wrapping };
		await seed(records);
		expect(await loadOrCreateAccount()).toEqual({ kind: 'corrupt', reason: 'invalid-secret' });
		expect(await storedRecords()).toEqual(records);
	});

	it('fails closed when ciphertext is tampered or the persisted pubkey mismatches', async () => {
		const records = await protectedRecords();
		(records[ENCRYPTED_SECRET_KEY] as { ciphertext: Uint8Array }).ciphertext[0] ^= 1;
		await seed(records);
		await seedGameState();
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		await seed(await protectedRecords(SECRET, 'f'.repeat(64)));
		await seedGameState('f'.repeat(64));
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
	});

	it('rolls back fresh creation when a successful request is followed by transaction abort', async () => {
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			if (key === TIMESTAMP_KEY) request.addEventListener('success', () => this.transaction.abort(), { once: true });
			return request;
		});
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(await storedRecords()).toEqual({});
		expect(await storedGameRecords()).toEqual({});
		expect((await loadOrCreateAccount()).kind).toBe('created');
		expect((await storedRecords())[LEGACY_SECRET_KEY]).toBeUndefined();
	});

	it('rolls back v1 migration after a successful request abort and allows retry', async () => {
		const pubkey = getPublicKey(SECRET);
		await seed({ [LEGACY_SECRET_KEY]: SECRET, [TIMESTAMP_KEY]: TIME, [MARKER_KEY]: pubkey }, 1);
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			if (key === ACCOUNT_PUBKEY) request.addEventListener('success', () => this.transaction.abort(), { once: true });
			return request;
		});
		await expect(loadOrCreateAccount()).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(await storedRecords()).toEqual({ [LEGACY_SECRET_KEY]: SECRET, [TIMESTAMP_KEY]: TIME, [MARKER_KEY]: pubkey });
		expect(await storedGameRecords()).toEqual({ 'lifecycle-migration-pending': true });
		const retry = await loadOrCreateAccount();
		expect(retry.kind).toBe('restored');
		expect(accountFrom(retry).pubkey).toBe(pubkey);
		expect(accountFrom(retry).personaCreatedAtMs).toBe(TIME);
		expect(accountFrom(retry).characterProfileRevision).toBe(1);
		const records = await storedRecords();
		expect(records[LEGACY_SECRET_KEY]).toBeUndefined();
		expect(records[MARKER_KEY]).toBe(pubkey);
		expect((await storedGameRecords())['game-state']).toMatchObject({ personaPubkey: pubkey, points: 0 });
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
	it('opens v3 and rejects the old v2 open path', async () => {
		await loadOrCreateAccount();
		await expect(database(2)).rejects.toMatchObject({ name: 'VersionError' });
	});
});

describe('persona lifecycle state and reincarnation', () => {
	it('creates one initial game state and restores it unchanged across reload', async () => {
		const first = await loadOrCreateAccount();
		const firstAccount = accountFrom(first);
		const game = (await storedGameRecords())['game-state'] as Record<string, unknown>;
		expect(game).toMatchObject({
			version: 1,
			personaPubkey: firstAccount.pubkey,
			lifespanExpiresAtMs: TIME + INITIAL_LIFESPAN_MS,
			points: 0,
			abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }
		});
		const restored = accountFrom(await loadOrCreateAccount());
		expect(restored.pubkey).toBe(firstAccount.pubkey);
		expect((await storedGameRecords())['game-state']).toEqual(game);
	});

	it('returns not-expired without replacing a current persona', async () => {
		const loaded = await loadOrCreatePersona();
		if (loaded.kind !== 'created' && loaded.kind !== 'restored') throw new Error('Expected persona.');
		vi.mocked(Date.now).mockReturnValue(TIME + INITIAL_LIFESPAN_MS - 1);
		const result = await reincarnateExpiredPersona(loaded.persona);
		expect(result.kind).toBe('not-expired');
		if (result.kind === 'not-expired') expect(result.persona.account.pubkey).toBe(loaded.persona.account.pubkey);
	});

	it('reincarnates exactly at expiry with a new identity and reset state', async () => {
		const account = accountFrom(await loadOrCreateAccount());
		await markCharacterProfilePublication(account);
		const loaded = await loadOrCreatePersona();
		if (loaded.kind !== 'created' && loaded.kind !== 'restored') throw new Error('Expected persona.');
		vi.mocked(Date.now).mockReturnValue(TIME + INITIAL_LIFESPAN_MS);
		const result = await reincarnateExpiredPersona(loaded.persona);
		expect(result.kind).toBe('reincarnated');
		if (result.kind !== 'reincarnated') return;
		expect(result.persona.account.pubkey).not.toBe(account.pubkey);
		expect(result.persona.account.personaCreatedAtMs).toBe(TIME + INITIAL_LIFESPAN_MS);
		expect(result.persona.account.characterProfileRevision).toBeNull();
		expect(result.persona.gameState).toEqual(createInitialPersonaGameState(
			result.persona.account.pubkey, TIME + INITIAL_LIFESPAN_MS
		));
		expect((await storedRecords())[MARKER_KEY]).toBeUndefined();
		expect((await storedRecords())[LEGACY_SECRET_KEY]).toBeUndefined();
	});

	it('converges concurrent expiry calls on one replacement', async () => {
		const loaded = await loadOrCreatePersona();
		if (loaded.kind !== 'created' && loaded.kind !== 'restored') throw new Error('Expected persona.');
		vi.mocked(Date.now).mockReturnValue(TIME + INITIAL_LIFESPAN_MS);
		const results = await Promise.all(Array.from({ length: 4 }, () =>
			reincarnateExpiredPersona(loaded.persona)
		));
		expect(results.filter((result) => result.kind === 'reincarnated')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'superseded')).toHaveLength(3);
		const pubkeys = results.flatMap((result) => result.kind === 'reincarnated' || result.kind === 'superseded' ? [result.persona.account.pubkey] : []);
		expect(new Set(pubkeys).size).toBe(1);
	});

	it('rolls back both stores when death replacement aborts after a game request', async () => {
		const loaded = await loadOrCreatePersona();
		if (loaded.kind !== 'created' && loaded.kind !== 'restored') throw new Error('Expected persona.');
		const beforeAccount = await storedRecords();
		const beforeGame = await storedGameRecords();
		vi.mocked(Date.now).mockReturnValue(TIME + INITIAL_LIFESPAN_MS);
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			if (key === 'game-state') request.addEventListener('success', () => this.transaction.abort(), { once: true });
			return request;
		});
		await expect(reincarnateExpiredPersona(loaded.persona)).rejects.toThrow('Account operation failed.');
		put.mockRestore();
		expect(await storedRecords()).toEqual(beforeAccount);
		expect(await storedGameRecords()).toEqual(beforeGame);
		const retry = await reincarnateExpiredPersona(loaded.persona);
		expect(retry.kind).toBe('reincarnated');
	});
});

describe('lifecycle fail-close states', () => {
	it('does not recreate a markerless missing game state', async () => {
		const records = await protectedRecords();
		await seed(records);
		expect(await loadOrCreatePersona()).toEqual({ kind: 'corrupt', reason: 'missing-game-state' });
		expect(await storedRecords()).toEqual(records);
		expect(await storedGameRecords()).toEqual({});
	});

	it('rejects malformed, mismatched, orphan, and ambiguous game state', async () => {
		await seed(await protectedRecords());
		await seedRawGameState({ version: 1, personaPubkey: getPublicKey(SECRET), points: 0 });
		expect(await loadOrCreatePersona()).toEqual({ kind: 'corrupt', reason: 'invalid-game-state' });

		await seedRawGameState(createInitialPersonaGameState('f'.repeat(64), TIME));
		expect(await loadOrCreatePersona()).toEqual({ kind: 'corrupt', reason: 'game-account-mismatch' });

		vi.stubGlobal('indexedDB', new IDBFactory());
		await seedRawGameState(createInitialPersonaGameState(getPublicKey(SECRET), TIME));
		expect(await loadOrCreatePersona()).toEqual({ kind: 'corrupt', reason: 'orphan-game-state' });

		vi.stubGlobal('indexedDB', new IDBFactory());
		await seed(await protectedRecords());
		await seedRawGameState(createInitialPersonaGameState(getPublicKey(SECRET), TIME));
		const db = await database();
		const tx = db.transaction(GAME_STORE_NAME, 'readwrite');
		await tx.store.put(true, 'lifecycle-migration-pending');
		await tx.done;
		db.close();
		connections.splice(connections.indexOf(db), 1);
		expect(await loadOrCreatePersona()).toEqual({ kind: 'corrupt', reason: 'ambiguous-game-state' });
	});
});
