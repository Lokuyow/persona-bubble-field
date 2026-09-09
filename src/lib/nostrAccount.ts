import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

const DATABASE_NAME = 'persona-bubble-field-account';
const STORE_NAME = 'persona-bubble-field-account-state';
const LEGACY_SECRET_KEY = 'secret-key';
const WRAPPING_KEY = 'secret-wrapping-key';
const ENCRYPTED_SECRET_KEY = 'encrypted-secret-key';
const ACCOUNT_PUBKEY = 'account-pubkey';
const TIMESTAMP_KEY = 'last-changed-at-ms';
// Keep the existing key so legacy pubkey-only values can be recognized as revision 1.
const CHARACTER_PROFILE_PUBLICATION_MARKER_KEY = 'initial-profile-published-pubkey';
const DATABASE_VERSION = 2;
const ENCRYPTED_SECRET_VERSION = 1;
const AES_KEY_LENGTH = 256;
const AES_GCM_IV_BYTES = 12;

export const CURRENT_CHARACTER_PROFILE_REVISION = 2;

interface AccountDatabase extends DBSchema {
	[STORE_NAME]: {
		key: string;
		// Persisted data is untrusted, even when the TypeScript writer is typed.
		value: unknown;
	};
}

type AccountTransaction = IDBPTransaction<AccountDatabase, [typeof STORE_NAME], 'readwrite'>;
type AccountReadTransaction = IDBPTransaction<AccountDatabase, [typeof STORE_NAME], 'readonly'>;

/** Keep one snapshot for the whole account-dependent operation; do not mutate its key. */
export type AccountSnapshot = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	personaCreatedAtMs: number;
	characterProfileRevision: number | null;
}>;

export type CorruptAccountState = Readonly<{
	kind: 'corrupt';
	reason: 'missing-timestamp' | 'invalid-timestamp' | 'invalid-secret';
}>;

export type LoadAccountResult =
	| Readonly<{ kind: 'created' | 'restored'; account: AccountSnapshot }>
	| Readonly<{ kind: 'missing-secret'; personaCreatedAtMs: number }>
	| CorruptAccountState;

export type MarkCharacterProfilePublicationResult = Readonly<{ kind: 'recorded' | 'stale' }>;

type EncryptedSecretRecord = Readonly<{
	version: 1;
	iv: Uint8Array;
	ciphertext: Uint8Array;
}>;

type LegacyReadyState = Readonly<{
	kind: 'legacy-ready';
	secretKey: Uint8Array;
	pubkey: string;
	personaCreatedAtMs: number;
	characterProfileRevision: number | null;
}>;

type ProtectedReadyState = Readonly<{
	kind: 'protected-ready';
	wrappingKey: CryptoKey;
	encryptedSecret: EncryptedSecretRecord;
	pubkey: string;
	personaCreatedAtMs: number;
	characterProfileRevision: number | null;
}>;

type StoredAccountState =
	| Readonly<{ kind: 'fresh' }>
	| LegacyReadyState
	| ProtectedReadyState
	| Readonly<{ kind: 'missing-secret'; personaCreatedAtMs: number }>
	| CorruptAccountState;

type ProtectedCandidate = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	wrappingKey: CryptoKey;
	encryptedSecret: EncryptedSecretRecord;
}>;

function isAccountTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertAccountTimestamp(value: number): void {
	if (!isAccountTimestamp(value)) throw new TypeError('Invalid account timestamp.');
}

function characterProfileRevisionForMarker(marker: unknown, pubkey: string): number | null {
	if (marker === pubkey) return 1;
	if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return null;
	const candidate = marker as Readonly<Record<string, unknown>>;
	return candidate.pubkey === pubkey && typeof candidate.revision === 'number' &&
		Number.isSafeInteger(candidate.revision) && candidate.revision > 0 ? candidate.revision : null;
}

function hasValidProtectedKey(value: unknown): value is CryptoKey {
	if (typeof CryptoKey === 'undefined' || !(value instanceof CryptoKey)) return false;
	const usages = new Set(value.usages);
	return value.type === 'secret' && value.algorithm.name === 'AES-GCM' &&
		(value.algorithm as AesKeyAlgorithm).length === AES_KEY_LENGTH &&
		value.extractable === false && usages.has('encrypt') && usages.has('decrypt') && usages.size === 2;
}

function isEncryptedSecretRecord(value: unknown): value is EncryptedSecretRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Readonly<Record<string, unknown>>;
	return candidate.version === ENCRYPTED_SECRET_VERSION &&
		candidate.iv instanceof Uint8Array && candidate.iv.length === AES_GCM_IV_BYTES &&
		candidate.ciphertext instanceof Uint8Array && candidate.ciphertext.length >= 16;
}

function isCanonicalPubkey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function webCrypto(): Crypto {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) throw new Error('Web Crypto is unavailable.');
	return cryptoApi;
}

function cryptoBytes(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function openAccountDatabase() {
	try {
		// Neither this check nor openDB runs at module import time.
		if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
		return await openDB<AccountDatabase>(DATABASE_NAME, DATABASE_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
			}
		});
	} catch {
		throw new Error('Account storage could not be opened.');
	}
}

async function readAccountState(tx: AccountReadTransaction | AccountTransaction): Promise<StoredAccountState> {
	const keys = [LEGACY_SECRET_KEY, WRAPPING_KEY, ENCRYPTED_SECRET_KEY, ACCOUNT_PUBKEY, TIMESTAMP_KEY,
		CHARACTER_PROFILE_PUBLICATION_MARKER_KEY];
	const records = new Map<string, unknown>();
	const present = new Set<string>();
	for (const key of keys) {
		if (await tx.store.getKey(key) !== undefined) {
			present.add(key);
			const [value]: unknown[] = await tx.store.getAll(key, 1);
			records.set(key, value);
		}
	}

	const hasLegacy = present.has(LEGACY_SECRET_KEY);
	const hasProtected = present.has(WRAPPING_KEY) || present.has(ENCRYPTED_SECRET_KEY) || present.has(ACCOUNT_PUBKEY);
	const hasTimestamp = present.has(TIMESTAMP_KEY);
	if (!hasTimestamp && !hasLegacy && !hasProtected) return { kind: 'fresh' };
	if (!hasTimestamp) return { kind: 'corrupt', reason: 'missing-timestamp' };
	const timestamp = records.get(TIMESTAMP_KEY);
	if (!isAccountTimestamp(timestamp)) return { kind: 'corrupt', reason: 'invalid-timestamp' };
	const markerRevision = (pubkey: string) => characterProfileRevisionForMarker(
		records.get(CHARACTER_PROFILE_PUBLICATION_MARKER_KEY), pubkey
	);

	if (hasLegacy && hasProtected) return { kind: 'corrupt', reason: 'invalid-secret' };
	if (hasProtected) {
		const wrappingKey = records.get(WRAPPING_KEY);
		const encryptedSecret = records.get(ENCRYPTED_SECRET_KEY);
		const pubkey = records.get(ACCOUNT_PUBKEY);
		if (!hasValidProtectedKey(wrappingKey) || !isEncryptedSecretRecord(encryptedSecret) || !isCanonicalPubkey(pubkey)) {
			return { kind: 'corrupt', reason: 'invalid-secret' };
		}
		return {
			kind: 'protected-ready', wrappingKey, encryptedSecret, pubkey,
			personaCreatedAtMs: timestamp, characterProfileRevision: markerRevision(pubkey)
		};
	}

	if (!hasLegacy) return { kind: 'missing-secret', personaCreatedAtMs: timestamp };
	const secret = records.get(LEGACY_SECRET_KEY);
	if (!(secret instanceof Uint8Array) || secret.length !== 32) return { kind: 'corrupt', reason: 'invalid-secret' };
	let pubkey: string;
	try {
		pubkey = getPublicKey(secret);
	} catch {
		return { kind: 'corrupt', reason: 'invalid-secret' };
	}
	return {
		kind: 'legacy-ready', secretKey: secret.slice(), pubkey,
		personaCreatedAtMs: timestamp, characterProfileRevision: markerRevision(pubkey)
	};
}

async function readState(db: Awaited<ReturnType<typeof openAccountDatabase>>): Promise<StoredAccountState> {
	const tx = db.transaction(STORE_NAME, 'readonly');
	const state = await readAccountState(tx);
	await tx.done;
	return state;
}

async function prepareProtectedCandidate(secretKey: Uint8Array): Promise<ProtectedCandidate> {
	const cryptoApi = webCrypto();
	const wrappingKey = await cryptoApi.subtle.generateKey(
		{ name: 'AES-GCM', length: AES_KEY_LENGTH }, false, ['encrypt', 'decrypt']
	) as CryptoKey;
	const iv = cryptoApi.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
	const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt(
		{ name: 'AES-GCM', iv: cryptoBytes(iv) }, wrappingKey, cryptoBytes(secretKey)
	));
	return { secretKey: secretKey.slice(), pubkey: getPublicKey(secretKey), wrappingKey, encryptedSecret: { version: 1, iv, ciphertext } };
}

async function prepareFreshCandidate(): Promise<ProtectedCandidate> {
	return prepareProtectedCandidate(generateSecretKey().slice());
}

function snapshotFromSecret(secretKey: Uint8Array, pubkey: string, personaCreatedAtMs: number,
	characterProfileRevision: number | null): AccountSnapshot {
	return { secretKey: secretKey.slice(), pubkey, personaCreatedAtMs, characterProfileRevision };
}

async function restoreProtected(state: ProtectedReadyState): Promise<AccountSnapshot> {
	try {
		const secret = new Uint8Array(await webCrypto().subtle.decrypt(
			{ name: 'AES-GCM', iv: cryptoBytes(state.encryptedSecret.iv) }, state.wrappingKey,
			cryptoBytes(state.encryptedSecret.ciphertext)
		));
		if (secret.length !== 32 || getPublicKey(secret) !== state.pubkey) throw new Error('Account identity mismatch.');
		return snapshotFromSecret(secret, state.pubkey, state.personaCreatedAtMs, state.characterProfileRevision);
	} catch {
		throw new Error('Account operation failed.');
	}
}

async function commitFreshCandidate(db: Awaited<ReturnType<typeof openAccountDatabase>>, candidate: ProtectedCandidate) {
	const tx = db.transaction(STORE_NAME, 'readwrite');
	void tx.done.catch(() => {});
	try {
		const state = await readAccountState(tx);
		if (state.kind !== 'fresh') {
			await tx.done;
			return false;
		}
		const personaCreatedAtMs = Date.now();
		assertAccountTimestamp(personaCreatedAtMs);
		await tx.store.put(candidate.wrappingKey, WRAPPING_KEY);
		await tx.store.put(candidate.encryptedSecret, ENCRYPTED_SECRET_KEY);
		await tx.store.put(candidate.pubkey, ACCOUNT_PUBKEY);
		await tx.store.put(personaCreatedAtMs, TIMESTAMP_KEY);
		await tx.store.delete(CHARACTER_PROFILE_PUBLICATION_MARKER_KEY);
		await tx.done;
		return snapshotFromSecret(candidate.secretKey, candidate.pubkey, personaCreatedAtMs, null);
	} catch (error) {
		try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
		await tx.done.catch(() => {});
		throw error;
	}
}

async function commitLegacyMigration(db: Awaited<ReturnType<typeof openAccountDatabase>>, state: LegacyReadyState,
	candidate: ProtectedCandidate) {
	const tx = db.transaction(STORE_NAME, 'readwrite');
	void tx.done.catch(() => {});
	try {
		const current = await readAccountState(tx);
		const sameLegacy = current.kind === 'legacy-ready' && current.pubkey === state.pubkey &&
			current.personaCreatedAtMs === state.personaCreatedAtMs &&
			current.secretKey.length === state.secretKey.length && current.secretKey.every((byte, i) => byte === state.secretKey[i]);
		if (!sameLegacy) {
			await tx.done;
			return false;
		}
		await tx.store.put(candidate.wrappingKey, WRAPPING_KEY);
		await tx.store.put(candidate.encryptedSecret, ENCRYPTED_SECRET_KEY);
		await tx.store.put(candidate.pubkey, ACCOUNT_PUBKEY);
		await tx.store.delete(LEGACY_SECRET_KEY);
		await tx.done;
		return snapshotFromSecret(candidate.secretKey, candidate.pubkey, state.personaCreatedAtMs, state.characterProfileRevision);
	} catch (error) {
		try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
		await tx.done.catch(() => {});
		throw error;
	}
}

async function loadOrCreate(): Promise<LoadAccountResult> {
	const db = await openAccountDatabase();
	try {
		for (;;) {
			const state = await readState(db);
			if (state.kind === 'corrupt') return state;
			if (state.kind === 'missing-secret') return state;
			if (state.kind === 'protected-ready') return { kind: 'restored', account: await restoreProtected(state) };
			if (state.kind === 'legacy-ready') {
				const candidate = await prepareProtectedCandidate(state.secretKey);
				const result = await commitLegacyMigration(db, state, candidate);
				if (result) return { kind: 'restored', account: result };
				continue;
			}
			const candidate = await prepareFreshCandidate();
			const result = await commitFreshCandidate(db, candidate);
			if (result) return { kind: 'created', account: result };
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'Account operation failed.') throw error;
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}
}

/** Creates only when both legacy and protected account records are absent; missing/corrupt data is never repaired. */
export function loadOrCreateAccount(): Promise<LoadAccountResult> {
	return loadOrCreate();
}

/** Records only the current account's current character-profile revision. */
export async function markCharacterProfilePublication(
	account: AccountSnapshot
): Promise<MarkCharacterProfilePublicationResult> {
	const db = await openAccountDatabase();
	let tx: AccountTransaction | undefined;
	try {
		tx = db.transaction(STORE_NAME, 'readwrite');
		void tx.done.catch(() => {});
		const state = await readAccountState(tx);
		if (state.kind === 'corrupt' || state.kind === 'fresh' || state.kind === 'missing-secret' ||
			state.pubkey !== account.pubkey || state.personaCreatedAtMs !== account.personaCreatedAtMs) {
			await tx.done;
			return { kind: 'stale' };
		}
		await tx.store.put(
			{ pubkey: account.pubkey, revision: CURRENT_CHARACTER_PROFILE_REVISION },
			CHARACTER_PROFILE_PUBLICATION_MARKER_KEY
		);
		await tx.done;
		return { kind: 'recorded' };
	} catch {
		if (tx) {
			try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
			await tx.done.catch(() => {});
		}
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}
}
