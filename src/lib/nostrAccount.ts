import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
	createInitialPersonaGameState,
	isPersonaExpired,
	isValidPersonaGameState,
	type PersonaGameState
} from './personaGameState';

const DATABASE_NAME = 'persona-bubble-field-account';
const ACCOUNT_STORE_NAME = 'persona-bubble-field-account-state';
const GAME_STORE_NAME = 'persona-bubble-field-game-state';
const LEGACY_SECRET_KEY = 'secret-key';
const WRAPPING_KEY = 'secret-wrapping-key';
const ENCRYPTED_SECRET_KEY = 'encrypted-secret-key';
const ACCOUNT_PUBKEY = 'account-pubkey';
const TIMESTAMP_KEY = 'last-changed-at-ms';
// Keep the existing key so legacy pubkey-only values can be recognized as revision 1.
const CHARACTER_PROFILE_PUBLICATION_MARKER_KEY = 'initial-profile-published-pubkey';
const GAME_STATE_KEY = 'game-state';
const LIFECYCLE_MIGRATION_PENDING_KEY = 'lifecycle-migration-pending';
const DATABASE_VERSION = 3;
const ENCRYPTED_SECRET_VERSION = 1;
const AES_KEY_LENGTH = 256;
const AES_GCM_IV_BYTES = 12;

export const CURRENT_CHARACTER_PROFILE_REVISION = 2;

interface AccountDatabase extends DBSchema {
	[ACCOUNT_STORE_NAME]: { key: string; value: unknown };
	[GAME_STORE_NAME]: { key: string; value: unknown };
}

type AccountOnlyTransaction = IDBPTransaction<AccountDatabase, [typeof ACCOUNT_STORE_NAME], 'readwrite'>;
type ReadTransaction = IDBPTransaction<AccountDatabase, [typeof ACCOUNT_STORE_NAME, typeof GAME_STORE_NAME], 'readonly'>;
type LifecycleTransaction = IDBPTransaction<AccountDatabase, [typeof ACCOUNT_STORE_NAME, typeof GAME_STORE_NAME], 'readwrite'>;
type AccountReadTransaction = AccountOnlyTransaction | ReadTransaction | LifecycleTransaction;

/** Keep one snapshot for the whole account-dependent operation; do not mutate its key. */
export type AccountSnapshot = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	personaCreatedAtMs: number;
	characterProfileRevision: number | null;
}>;

export type CorruptAccountState = Readonly<{
	kind: 'corrupt';
	reason:
		| 'missing-timestamp'
		| 'invalid-timestamp'
		| 'invalid-secret'
		| 'missing-game-state'
		| 'invalid-game-state'
		| 'game-account-mismatch'
		| 'orphan-game-state'
		| 'ambiguous-game-state';
}>;

export type LoadAccountResult =
	| Readonly<{ kind: 'created' | 'restored'; account: AccountSnapshot }>
	| Readonly<{ kind: 'missing-secret'; personaCreatedAtMs: number }>
	| CorruptAccountState;

export type PersonaSnapshot = Readonly<{
	account: AccountSnapshot;
	gameState: PersonaGameState;
}>;

export type LoadPersonaResult =
	| Readonly<{ kind: 'created' | 'restored'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'missing-secret'; personaCreatedAtMs: number }>
	| CorruptAccountState;

export type ReincarnateExpiredResult =
	| Readonly<{ kind: 'reincarnated' | 'superseded' | 'not-expired'; persona: PersonaSnapshot }>
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

type StoredGameState =
	| Readonly<{ kind: 'missing' }>
	| Readonly<{ kind: 'pending' }>
	| Readonly<{ kind: 'ready'; gameState: PersonaGameState }>
	| Readonly<{ kind: 'malformed'; reason: 'invalid-game-state' | 'ambiguous-game-state' }>;

type StoredLifecycleState =
	| Readonly<{ kind: 'fresh'; pending: boolean }>
	| Readonly<{ kind: 'ready'; account: LegacyReadyState | ProtectedReadyState; game: StoredGameState }>
	| Readonly<{ kind: 'missing-secret'; personaCreatedAtMs: number }>
	| CorruptAccountState;

type ProtectedCandidate = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	wrappingKey: CryptoKey;
	encryptedSecret: EncryptedSecretRecord;
}>;

function accountStore(tx: AccountReadTransaction): any {
	return (tx as any).objectStore(ACCOUNT_STORE_NAME);
}

function gameStore(tx: ReadTransaction | LifecycleTransaction): any {
	return (tx as any).objectStore(GAME_STORE_NAME);
}

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

function sameSecret(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

function sameGameState(first: PersonaGameState, second: PersonaGameState): boolean {
	return first.version === second.version && first.personaPubkey === second.personaPubkey &&
		first.lifespanExpiresAtMs === second.lifespanExpiresAtMs && first.points === second.points &&
		first.abilities.inferenceEfficiency === second.abilities.inferenceEfficiency &&
		first.abilities.contextCapacity === second.abilities.contextCapacity &&
		first.abilities.hallucinationSuppression === second.abilities.hallucinationSuppression;
}

async function openAccountDatabase(): Promise<IDBPDatabase<AccountDatabase>> {
	try {
		// Neither this check nor openDB runs at module import time.
		if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
		return await openDB<AccountDatabase>(DATABASE_NAME, DATABASE_VERSION, {
			upgrade(db, oldVersion) {
				if (!db.objectStoreNames.contains(ACCOUNT_STORE_NAME)) db.createObjectStore(ACCOUNT_STORE_NAME);
				if (!db.objectStoreNames.contains(GAME_STORE_NAME)) {
					const store = db.createObjectStore(GAME_STORE_NAME);
					if (oldVersion > 0 && oldVersion < DATABASE_VERSION) store.put(true, LIFECYCLE_MIGRATION_PENDING_KEY);
				}
			}
		});
	} catch {
		throw new Error('Account storage could not be opened.');
	}
}

async function readAccountState(tx: AccountReadTransaction): Promise<StoredAccountState> {
	const store = accountStore(tx);
	const keys = [LEGACY_SECRET_KEY, WRAPPING_KEY, ENCRYPTED_SECRET_KEY, ACCOUNT_PUBKEY, TIMESTAMP_KEY,
		CHARACTER_PROFILE_PUBLICATION_MARKER_KEY];
	const records = new Map<string, unknown>();
	const present = new Set<string>();
	for (const key of keys) {
		if (await store.getKey(key) !== undefined) {
			present.add(key);
			const [value]: unknown[] = await store.getAll(key, 1);
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

async function readGameState(tx: ReadTransaction | LifecycleTransaction): Promise<StoredGameState> {
	const store = gameStore(tx);
	const keys = await store.getAllKeys();
	if (keys.some((key: IDBValidKey) => key !== GAME_STATE_KEY && key !== LIFECYCLE_MIGRATION_PENDING_KEY)) {
		return { kind: 'malformed', reason: 'ambiguous-game-state' };
	}
	const statePresent = await store.getKey(GAME_STATE_KEY) !== undefined;
	const pendingPresent = await store.getKey(LIFECYCLE_MIGRATION_PENDING_KEY) !== undefined;
	if (statePresent && pendingPresent) return { kind: 'malformed', reason: 'ambiguous-game-state' };
	if (!statePresent && !pendingPresent) return { kind: 'missing' };
	if (pendingPresent) {
		const [pending]: unknown[] = await store.getAll(LIFECYCLE_MIGRATION_PENDING_KEY, 1);
		return pending === true ? { kind: 'pending' } : { kind: 'malformed', reason: 'invalid-game-state' };
	}
	const [value]: unknown[] = await store.getAll(GAME_STATE_KEY, 1);
	return isValidPersonaGameState(value) ? { kind: 'ready', gameState: value } :
		{ kind: 'malformed', reason: 'invalid-game-state' };
}

async function readLifecycleState(tx: ReadTransaction | LifecycleTransaction): Promise<StoredLifecycleState> {
	const account = await readAccountState(tx);
	const game = await readGameState(tx);
	if (account.kind === 'corrupt') return account;
	if (account.kind === 'missing-secret') return account;
	if (account.kind === 'fresh') {
		if (game.kind === 'missing' || game.kind === 'pending') return { kind: 'fresh', pending: game.kind === 'pending' };
		if (game.kind === 'malformed' && game.reason === 'ambiguous-game-state') return { kind: 'corrupt', reason: 'ambiguous-game-state' };
		return { kind: 'corrupt', reason: 'orphan-game-state' };
	}
	if (game.kind === 'malformed') return { kind: 'corrupt', reason: game.reason };
	if (game.kind === 'missing') return { kind: 'corrupt', reason: 'missing-game-state' };
	if (game.kind === 'pending') return { kind: 'ready', account, game };
	if (game.gameState.personaPubkey !== account.pubkey) return { kind: 'corrupt', reason: 'game-account-mismatch' };
	return { kind: 'ready', account, game };
}

async function readLifecycle(db: IDBPDatabase<AccountDatabase>): Promise<StoredLifecycleState> {
	const tx = db.transaction([ACCOUNT_STORE_NAME, GAME_STORE_NAME], 'readonly');
	const state = await readLifecycleState(tx);
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

async function restoreAccount(account: LegacyReadyState | ProtectedReadyState): Promise<AccountSnapshot> {
	if (account.kind === 'legacy-ready') {
		return snapshotFromSecret(account.secretKey, account.pubkey, account.personaCreatedAtMs, account.characterProfileRevision);
	}
	try {
		const secret = new Uint8Array(await webCrypto().subtle.decrypt(
			{ name: 'AES-GCM', iv: cryptoBytes(account.encryptedSecret.iv) }, account.wrappingKey,
			cryptoBytes(account.encryptedSecret.ciphertext)
		));
		if (secret.length !== 32 || getPublicKey(secret) !== account.pubkey) throw new Error('Account identity mismatch.');
		return snapshotFromSecret(secret, account.pubkey, account.personaCreatedAtMs, account.characterProfileRevision);
	} catch {
		throw new Error('Account operation failed.');
	}
}

function sameAccountIdentity(first: LegacyReadyState | ProtectedReadyState, second: LegacyReadyState | ProtectedReadyState): boolean {
	return first.kind === second.kind && first.pubkey === second.pubkey &&
		first.personaCreatedAtMs === second.personaCreatedAtMs &&
		first.characterProfileRevision === second.characterProfileRevision &&
		(first.kind !== 'legacy-ready' || sameSecret(first.secretKey, (second as LegacyReadyState).secretKey));
}

async function commitFreshPersona(db: IDBPDatabase<AccountDatabase>, candidate: ProtectedCandidate, expectedPending: boolean) {
	const tx = db.transaction([ACCOUNT_STORE_NAME, GAME_STORE_NAME], 'readwrite');
	void tx.done.catch(() => {});
	try {
		const state = await readLifecycleState(tx);
		if (state.kind !== 'fresh' || state.pending !== expectedPending) {
			await tx.done;
			return false;
		}
		const personaCreatedAtMs = Date.now();
		assertAccountTimestamp(personaCreatedAtMs);
		const gameState = createInitialPersonaGameState(candidate.pubkey, personaCreatedAtMs);
		const accounts = accountStore(tx);
		await accounts.put(candidate.wrappingKey, WRAPPING_KEY);
		await accounts.put(candidate.encryptedSecret, ENCRYPTED_SECRET_KEY);
		await accounts.put(candidate.pubkey, ACCOUNT_PUBKEY);
		await accounts.put(personaCreatedAtMs, TIMESTAMP_KEY);
		await accounts.delete(CHARACTER_PROFILE_PUBLICATION_MARKER_KEY);
		const games = gameStore(tx);
		await games.put(gameState, GAME_STATE_KEY);
		await games.delete(LIFECYCLE_MIGRATION_PENDING_KEY);
		await tx.done;
		return {
			account: snapshotFromSecret(candidate.secretKey, candidate.pubkey, personaCreatedAtMs, null), gameState
		};
	} catch (error) {
		try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
		await tx.done.catch(() => {});
		throw error;
	}
}

async function commitExistingMigration(db: IDBPDatabase<AccountDatabase>, state: StoredLifecycleState & { kind: 'ready' },
	account: AccountSnapshot, candidate: ProtectedCandidate | null) {
	const tx = db.transaction([ACCOUNT_STORE_NAME, GAME_STORE_NAME], 'readwrite');
	void tx.done.catch(() => {});
	try {
		const current = await readLifecycleState(tx);
		if (current.kind !== 'ready' || !sameAccountIdentity(current.account, state.account)) {
			await tx.done;
			return false;
		}
		if (state.game.kind === 'pending' && current.game.kind !== 'pending') {
			await tx.done;
			return false;
		}
		if (state.game.kind === 'ready' && (current.game.kind !== 'ready' || !sameGameState(current.game.gameState, state.game.gameState))) {
			await tx.done;
			return false;
		}
		if (candidate) {
			const accounts = accountStore(tx);
			await accounts.put(candidate.wrappingKey, WRAPPING_KEY);
			await accounts.put(candidate.encryptedSecret, ENCRYPTED_SECRET_KEY);
			await accounts.put(candidate.pubkey, ACCOUNT_PUBKEY);
			await accounts.delete(LEGACY_SECRET_KEY);
		}
		let gameState: PersonaGameState;
		if (state.game.kind === 'ready') {
			gameState = state.game.gameState;
		} else if (state.game.kind === 'pending') {
			const migrationStartedAtMs = Date.now();
			assertAccountTimestamp(migrationStartedAtMs);
			gameState = createInitialPersonaGameState(state.account.pubkey, migrationStartedAtMs);
			await gameStore(tx).put(gameState, GAME_STATE_KEY);
			await gameStore(tx).delete(LIFECYCLE_MIGRATION_PENDING_KEY);
		} else {
			throw new Error('Invalid lifecycle state.');
		}
		await tx.done;
		return { account, gameState };
	} catch (error) {
		try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
		await tx.done.catch(() => {});
		throw error;
	}
}

async function loadPersona(): Promise<LoadPersonaResult> {
	const db = await openAccountDatabase();
	try {
		for (;;) {
			const state = await readLifecycle(db);
			if (state.kind === 'corrupt' || state.kind === 'missing-secret') return state;
			if (state.kind === 'fresh') {
				const candidate = await prepareFreshCandidate();
				const result = await commitFreshPersona(db, candidate, state.pending);
				if (result) return { kind: 'created', persona: result };
				continue;
			}
			const account = await restoreAccount(state.account);
			if (state.game.kind === 'ready') return { kind: 'restored', persona: { account, gameState: state.game.gameState } };
			if (state.game.kind !== 'pending') return { kind: 'corrupt', reason: 'missing-game-state' };
			const candidate = state.account.kind === 'legacy-ready' ? await prepareProtectedCandidate(state.account.secretKey) : null;
			const result = await commitExistingMigration(db, state, account, candidate);
			if (result) return { kind: 'restored', persona: result };
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'Account operation failed.') throw error;
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}
}

export function loadOrCreatePersona(): Promise<LoadPersonaResult> {
	return loadPersona();
}

/** Compatibility account-only view over the lifecycle-owned load path. */
export async function loadOrCreateAccount(): Promise<LoadAccountResult> {
	const result = await loadPersona();
	if (result.kind === 'created') return { kind: 'created', account: result.persona.account };
	if (result.kind === 'restored') return { kind: 'restored', account: result.persona.account };
	if (result.kind === 'missing-secret') return { kind: 'missing-secret', personaCreatedAtMs: result.personaCreatedAtMs };
	const corrupt = result as CorruptAccountState;
	return { kind: 'corrupt', reason: corrupt.reason };
}

export async function reincarnateExpiredPersona(expected: PersonaSnapshot): Promise<ReincarnateExpiredResult> {
	const candidate = await prepareFreshCandidate();
	const db = await openAccountDatabase();
	let outcome: 'reincarnated' | 'superseded' | 'not-expired' | 'corrupt' = 'corrupt';
	let replacement: PersonaSnapshot | null = null;
	try {
		const tx = db.transaction([ACCOUNT_STORE_NAME, GAME_STORE_NAME], 'readwrite');
		void tx.done.catch(() => {});
		try {
			const current = await readLifecycleState(tx);
			if (current.kind === 'corrupt' || current.kind === 'missing-secret' || current.kind === 'fresh' || current.game.kind !== 'ready') {
				await tx.done;
				return current.kind === 'corrupt' ? current : { kind: 'corrupt', reason: 'missing-game-state' };
			}
			const expectedAccount = expected.account;
			const currentMatches = current.account.pubkey === expectedAccount.pubkey &&
				current.account.personaCreatedAtMs === expectedAccount.personaCreatedAtMs &&
				current.game.gameState.personaPubkey === expected.gameState.personaPubkey &&
				current.game.gameState.lifespanExpiresAtMs === expected.gameState.lifespanExpiresAtMs &&
				current.game.gameState.points === expected.gameState.points &&
				sameGameState(current.game.gameState, expected.gameState);
			if (!currentMatches) {
				await tx.done;
				outcome = 'superseded';
			} else {
				const nowMs = Date.now();
				assertAccountTimestamp(nowMs);
				if (!isPersonaExpired(current.game.gameState, nowMs)) {
					await tx.done;
					replacement = { account: await restoreAccount(current.account), gameState: current.game.gameState };
					outcome = 'not-expired';
				} else {
					const gameState = createInitialPersonaGameState(candidate.pubkey, nowMs);
					const accounts = accountStore(tx);
					await accounts.put(candidate.wrappingKey, WRAPPING_KEY);
					await accounts.put(candidate.encryptedSecret, ENCRYPTED_SECRET_KEY);
					await accounts.put(candidate.pubkey, ACCOUNT_PUBKEY);
					await accounts.put(nowMs, TIMESTAMP_KEY);
					await accounts.delete(CHARACTER_PROFILE_PUBLICATION_MARKER_KEY);
					await accounts.delete(LEGACY_SECRET_KEY);
					await gameStore(tx).put(gameState, GAME_STATE_KEY);
					await tx.done;
					replacement = { account: snapshotFromSecret(candidate.secretKey, candidate.pubkey, nowMs, null), gameState };
					outcome = 'reincarnated';
				}
			}
		} catch (error) {
			try { tx.abort(); } catch { /* The transaction may already have aborted. */ }
			await tx.done.catch(() => {});
			throw error;
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'Account operation failed.') throw error;
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}

	if (outcome === 'superseded') {
		const current = await loadPersona();
		if (current.kind === 'created' || current.kind === 'restored') return { kind: 'superseded', persona: current.persona };
		if (current.kind === 'corrupt') return current;
		return { kind: 'corrupt', reason: 'invalid-secret' };
	}
	if (replacement) return { kind: outcome, persona: replacement };
	throw new Error('Account operation failed.');
}

/** Records only the current account's current character-profile revision. */
export async function markCharacterProfilePublication(
	account: AccountSnapshot
): Promise<MarkCharacterProfilePublicationResult> {
	const db = await openAccountDatabase();
	let tx: AccountOnlyTransaction | undefined;
	try {
		tx = db.transaction(ACCOUNT_STORE_NAME, 'readwrite');
		void tx.done.catch(() => {});
		const state = await readAccountState(tx);
		if (state.kind === 'corrupt' || state.kind === 'fresh' || state.kind === 'missing-secret' ||
			state.pubkey !== account.pubkey || state.personaCreatedAtMs !== account.personaCreatedAtMs) {
			await tx.done;
			return { kind: 'stale' };
		}
		await accountStore(tx).put(
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
