import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { getPublicKey } from 'nostr-tools/pure';
import { CHARACTER_CATALOG } from './character';
import { deriveCharacterFromPubkey } from './characterAssignment';
import { deriveBip85NostrEntropy, assertBip85Index, BIP85_INDEX_MAX, BIP85_INDEX_MIN } from './bip85';
import {
	createInitialPersonaGameState,
	isPersonaExpired,
	isValidPersonaGameState,
	upgradeAbility,
	type PersonaAbilityKey,
	type PersonaGameState
} from './personaGameState';
import { createMendingJob, materializeMending, projectMending } from './mending';

export const DATABASE_NAME = 'persona-bubble-field-account';
export const DATABASE_VERSION = 5;
export const ROOT_SECRET_STORE_NAME = 'persona-bubble-field-root-secret';
export const PLAYER_LIFECYCLE_STORE_NAME = 'persona-bubble-field-player-state';
export const CURRENT_CHARACTER_PROFILE_REVISION = 2;

const ROOT_WRAPPING_KEY = 'root-wrapping-key';
const ENCRYPTED_ROOT_ENTROPY = 'encrypted-root-entropy';
const PLAYER_STATE = 'player-lifecycle';
const ROOT_RECORD_VERSION = 1;
const AES_KEY_LENGTH = 256;
const AES_GCM_IV_BYTES = 12;
const ROOT_ENTROPY_BYTES = 16;
const MAX_CANDIDATE_SCAN = 100_000;

interface LifecycleDatabase extends DBSchema {
	[ROOT_SECRET_STORE_NAME]: { key: string; value: unknown };
	[PLAYER_LIFECYCLE_STORE_NAME]: { key: string; value: unknown };
}

export type IdentityReference = Readonly<{
	generation: number;
	accountIndex: number;
	pubkey: string;
}>;

export type RunHistorySummary = Readonly<{
	runNumber: number;
	startedAtMs: number;
	endedAtMs: number;
	outcome: 'dead' | 'cleared';
}>;

export type IdentityRecord = Readonly<{
	generation: number;
	accountIndex: number;
	pubkey: string;
	characterId: string;
	identityCreatedAtMs: number;
	status: 'alive' | 'dead';
	characterProfileRevision: number | null;
	runHistory: readonly RunHistorySummary[];
}>;

export type IdentityCandidate = Readonly<{
	accountIndex: number;
	pubkey: string;
	characterId: string;
}>;

export type PendingSelection = Readonly<{
	generation: number;
	candidates: readonly [IdentityCandidate, IdentityCandidate, IdentityCandidate];
}>;

export type ActiveRun = Readonly<{
	runNumber: number;
	revision: number;
	startedAtMs: number;
	identity: IdentityReference;
	gameState: PersonaGameState;
}>;

export type RealtimeSettlementLedger = Readonly<{
	schemaVersion: 1;
	identity: IdentityReference;
	runNumber: number;
	pendingInstanceIds: readonly string[];
	appliedOutcomeIds: readonly string[];
}>;

export type RealtimeOutcome = Readonly<{
	id: string;
	kind: 'points' | 'death';
	points?: number;
	instanceId: string;
}>;

export type PlayerLifecycle = Readonly<{
	schemaVersion: 1;
	identities: readonly IdentityRecord[];
	mode:
		| Readonly<{ kind: 'selecting'; pendingSelection: PendingSelection }>
		| Readonly<{ kind: 'running'; activeRun: ActiveRun }>;
	realtimeSettlementLedger?: RealtimeSettlementLedger;
}>;

/** The only signer shape exposed to world, profile, and composer code. */
export type ActiveSignerSnapshot = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	identityCreatedAtMs: number;
	characterProfileRevision: number | null;
	identity: IdentityReference;
}>;

export type ActiveRunAuthorization = Readonly<{
	identity: IdentityReference;
	runNumber: number;
}>;

export type SelfWriteAuthorizationResult = 'authorized' | 'superseded' | 'corrupt';

export type PersonaSnapshot = Readonly<{
	signer: ActiveSignerSnapshot;
	identity: IdentityRecord;
	activeRun: ActiveRun;
	gameState: PersonaGameState;
}>;

export type CorruptLifecycleState = Readonly<{
	kind: 'corrupt';
	reason:
		| 'root-record'
		| 'root-decrypt'
		| 'root-entropy'
		| 'partial-state'
		| 'player-state'
		| 'identity-reference'
		| 'derivation-mismatch'
		| 'invalid-candidate'
		| 'ambiguous-lifecycle'
		| 'selection-unavailable';
}>;

export type LoadLifecycleResult =
	| Readonly<{ kind: 'created' | 'selecting'; selection: PendingSelection }>
	| Readonly<{ kind: 'restored'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type SelectionResult =
	| Readonly<{ kind: 'selected'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'superseded'; lifecycle: LoadLifecycleResult }>
	| CorruptLifecycleState;

export type MendingMutationResult =
	| Readonly<{ kind: 'started' | 'collected'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'superseded'; lifecycle: LoadLifecycleResult }>
	| Readonly<{ kind: 'blocked' | 'expired'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type AbilityUpgradeResult =
	| Readonly<{ kind: 'upgraded'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'superseded'; lifecycle: LoadLifecycleResult }>
	| Readonly<{ kind: 'blocked' | 'expired'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type DeathTransitionResult =
	| Readonly<{ kind: 'transitioned' | 'superseded' }>
	| Readonly<{ kind: 'not-expired'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type MarkCharacterProfilePublicationResult = Readonly<{ kind: 'recorded' | 'stale' }>;

export type RealtimeSettlementResult =
	| Readonly<{ kind: 'applied'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'duplicate'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'expired'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'stale' }>
	| CorruptLifecycleState;

export type RealtimeDeathResult =
	| Readonly<{ kind: 'transitioned' | 'duplicate' | 'stale' }>
	| CorruptLifecycleState;

type EncryptedRootEntropy = Readonly<{
	version: 1;
	iv: Uint8Array;
	ciphertext: Uint8Array;
}>;

type PreparedRoot = Readonly<{
	entropy: Uint8Array;
	wrappingKey: CryptoKey;
	encryptedEntropy: EncryptedRootEntropy;
}>;

type StoredRecords = Readonly<{
	rootKeys: readonly IDBValidKey[];
	rootWrappingKey: unknown;
	encryptedEntropy: unknown;
	playerKeys: readonly IDBValidKey[];
	player: unknown;
}>;

type HydratedStorage = Readonly<{ entropy: Uint8Array; player: PlayerLifecycle }>;

function isCorruptLifecycle(value: unknown): value is CorruptLifecycleState {
	return typeof value === 'object' && value !== null && !Array.isArray(value) &&
		(value as Record<string, unknown>).kind === 'corrupt';
}

function webCrypto(): Crypto {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) throw new Error('Web Crypto is unavailable.');
	return cryptoApi;
}

function cryptoBytes(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalPubkey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isPositiveIndex(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= BIP85_INDEX_MIN && value <= BIP85_INDEX_MAX;
}

function isValidIdentityReference(value: unknown): value is IdentityReference {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isPositiveIndex(candidate.generation) && isPositiveIndex(candidate.accountIndex) && isCanonicalPubkey(candidate.pubkey);
}

function isValidRunHistorySummary(value: unknown): value is RunHistorySummary {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 &&
		isSafeTimestamp(candidate.startedAtMs) && isSafeTimestamp(candidate.endedAtMs) && candidate.endedAtMs >= candidate.startedAtMs &&
		(candidate.outcome === 'dead' || candidate.outcome === 'cleared');
}

function isValidIdentityRecord(value: unknown): value is IdentityRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isPositiveIndex(candidate.generation) && isPositiveIndex(candidate.accountIndex) && isCanonicalPubkey(candidate.pubkey) &&
		typeof candidate.characterId === 'string' && Boolean(CHARACTER_CATALOG.find((character) => character.characterId === candidate.characterId)) &&
		isSafeTimestamp(candidate.identityCreatedAtMs) && (candidate.status === 'alive' || candidate.status === 'dead') &&
		(candidate.characterProfileRevision === null || (Number.isSafeInteger(candidate.characterProfileRevision) && (candidate.characterProfileRevision as number) > 0)) &&
		Array.isArray(candidate.runHistory) && candidate.runHistory.every(isValidRunHistorySummary) &&
		candidate.runHistory.every((run, index) => run.runNumber === index + 1) &&
		(candidate.status === 'alive' || candidate.runHistory.length > 0);
}

function isValidCandidate(value: unknown): value is IdentityCandidate {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isPositiveIndex(candidate.accountIndex) && isCanonicalPubkey(candidate.pubkey) &&
		typeof candidate.characterId === 'string' && Boolean(CHARACTER_CATALOG.find((character) => character.characterId === candidate.characterId));
}

function isValidPendingSelection(value: unknown): value is PendingSelection {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (!isPositiveIndex(candidate.generation) || !Array.isArray(candidate.candidates) || candidate.candidates.length !== 3 ||
		!candidate.candidates.every(isValidCandidate)) return false;
	const candidates = candidate.candidates as IdentityCandidate[];
	return new Set(candidates.map((item) => item.accountIndex)).size === 3 && new Set(candidates.map((item) => item.pubkey)).size === 3 &&
		new Set(candidates.map((item) => item.characterId)).size === 3;
}

function isValidRealtimeSettlementLedger(value: unknown): value is RealtimeSettlementLedger {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.schemaVersion === 1 && isValidIdentityReference(candidate.identity) &&
		Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 &&
		Array.isArray(candidate.pendingInstanceIds) && candidate.pendingInstanceIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160) &&
		new Set(candidate.pendingInstanceIds).size === candidate.pendingInstanceIds.length &&
		Array.isArray(candidate.appliedOutcomeIds) && candidate.appliedOutcomeIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 240) &&
		new Set(candidate.appliedOutcomeIds).size === candidate.appliedOutcomeIds.length;
}

function isValidActiveRun(value: unknown): value is ActiveRun {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 &&
		Number.isSafeInteger(candidate.revision) && (candidate.revision as number) >= 0 &&
		isSafeTimestamp(candidate.startedAtMs) && isValidIdentityReference(candidate.identity) &&
		isValidPersonaGameState(candidate.gameState) && candidate.gameState.personaPubkey === (candidate.identity as IdentityReference).pubkey;
}

function isValidPlayerLifecycle(value: unknown): value is PlayerLifecycle {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.identities) || !candidate.identities.every(isValidIdentityRecord) ||
		(candidate.realtimeSettlementLedger !== undefined && !isValidRealtimeSettlementLedger(candidate.realtimeSettlementLedger))) return false;
	const identities = candidate.identities as IdentityRecord[];
	if (new Set(identities.map((item) => item.generation)).size !== identities.length ||
		new Set(identities.map((item) => `${item.generation}:${item.accountIndex}`)).size !== identities.length ||
		new Set(identities.map((item) => item.pubkey)).size !== identities.length ||
		new Set(identities.map((item) => item.characterId)).size !== identities.length) return false;
	if (typeof candidate.mode !== 'object' || candidate.mode === null || Array.isArray(candidate.mode)) return false;
	const mode = candidate.mode as Record<string, unknown>;
	if (mode.kind === 'selecting') {
		if (identities.some((identity) => identity.status === 'alive') || !isValidPendingSelection(mode.pendingSelection)) return false;
		const pending = mode.pendingSelection as PendingSelection;
		const highestGeneration = Math.max(...identities.map((identity) => identity.generation), 0);
		return pending.generation === highestGeneration + 1 && !(identities.some((identity) =>
			pending.candidates.some((item) => item.characterId === identity.characterId || item.pubkey === identity.pubkey)
		));
	}
	if (mode.kind !== 'running' || !isValidActiveRun(mode.activeRun)) return false;
	const activeRun = mode.activeRun as ActiveRun;
	const identity = identities.find((item) => item.pubkey === activeRun.identity.pubkey && item.generation === activeRun.identity.generation && item.accountIndex === activeRun.identity.accountIndex);
	return identities.filter((item) => item.status === 'alive').length === 1 &&
		Boolean(identity && identity.status === 'alive' && identity.runHistory.length === activeRun.runNumber - 1 &&
			activeRun.startedAtMs >= identity.identityCreatedAtMs &&
			identity.runHistory.every((run, index) => run.runNumber === index + 1));
}

function hasValidWrappingKey(value: unknown): value is CryptoKey {
	const CryptoKeyConstructor = globalThis.CryptoKey;
	if (!CryptoKeyConstructor || !(value instanceof CryptoKeyConstructor)) return false;
	const usages = new Set(value.usages);
	return value.type === 'secret' && value.algorithm.name === 'AES-GCM' &&
		(value.algorithm as AesKeyAlgorithm).length === AES_KEY_LENGTH && !value.extractable && usages.size === 2 &&
		usages.has('encrypt') && usages.has('decrypt');
}

function isEncryptedRootEntropy(value: unknown): value is EncryptedRootEntropy {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.version === ROOT_RECORD_VERSION && candidate.iv instanceof Uint8Array && candidate.iv.length === AES_GCM_IV_BYTES &&
		candidate.ciphertext instanceof Uint8Array && candidate.ciphertext.length >= 16;
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((value, index) => value === second[index]);
}

function sameGameState(first: PersonaGameState, second: PersonaGameState): boolean {
	return first.version === second.version && first.personaPubkey === second.personaPubkey && first.lifespanExpiresAtMs === second.lifespanExpiresAtMs &&
		first.points === second.points && first.pointProgressTicks === second.pointProgressTicks && first.abilities.inferenceEfficiency === second.abilities.inferenceEfficiency &&
		first.abilities.contextCapacity === second.abilities.contextCapacity && first.abilities.hallucinationSuppression === second.abilities.hallucinationSuppression &&
		first.mendingJob?.startedAtMs === second.mendingJob?.startedAtMs && first.mendingJob?.maximumDurationMs === second.mendingJob?.maximumDurationMs &&
		first.mendingJob?.lifespanExtensionPerHour.numerator === second.mendingJob?.lifespanExtensionPerHour.numerator &&
		first.mendingJob?.lifespanExtensionPerHour.denominator === second.mendingJob?.lifespanExtensionPerHour.denominator &&
		first.mendingJob?.pointIntervalMs === second.mendingJob?.pointIntervalMs;
}

function sameIdentityReference(first: IdentityReference, second: IdentityReference): boolean {
	return first.generation === second.generation && first.accountIndex === second.accountIndex && first.pubkey === second.pubkey;
}

function openLifecycleDatabase(): Promise<IDBPDatabase<LifecycleDatabase>> {
	try {
		if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
		return openDB<LifecycleDatabase>(DATABASE_NAME, DATABASE_VERSION, {
			upgrade(db) {
				for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
				db.createObjectStore(ROOT_SECRET_STORE_NAME);
				db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
			}
		});
	} catch {
		return Promise.reject(new Error('Lifecycle storage could not be opened.'));
	}
}

async function readStoredRecords(db: IDBPDatabase<LifecycleDatabase>): Promise<StoredRecords> {
	const tx = db.transaction([ROOT_SECRET_STORE_NAME, PLAYER_LIFECYCLE_STORE_NAME], 'readonly');
	const root = tx.objectStore(ROOT_SECRET_STORE_NAME);
	const player = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
	const rootKeys = await root.getAllKeys();
	const playerKeys = await player.getAllKeys();
	const rootWrappingKey = await root.get(ROOT_WRAPPING_KEY);
	const encryptedEntropy = await root.get(ENCRYPTED_ROOT_ENTROPY);
	const playerState = await player.get(PLAYER_STATE);
	await tx.done;
	return { rootKeys, rootWrappingKey, encryptedEntropy, playerKeys, player: playerState };
}

async function decryptRootEntropy(wrappingKey: CryptoKey, encryptedEntropy: EncryptedRootEntropy): Promise<Uint8Array> {
	try {
		const entropy = new Uint8Array(await webCrypto().subtle.decrypt(
			{ name: 'AES-GCM', iv: cryptoBytes(encryptedEntropy.iv) }, wrappingKey, cryptoBytes(encryptedEntropy.ciphertext)
		));
		if (entropy.length !== ROOT_ENTROPY_BYTES) throw new Error('Invalid root entropy.');
		return entropy;
	} catch {
		throw new Error('Root decrypt failed.');
	}
}

async function readRootAndPlayer(db: IDBPDatabase<LifecycleDatabase>): Promise<HydratedStorage | CorruptLifecycleState | null> {
	const stored = await readStoredRecords(db);
	const rootEmpty = stored.rootKeys.length === 0;
	const playerEmpty = stored.playerKeys.length === 0;
	if (rootEmpty && playerEmpty) return null;
	if (rootEmpty !== playerEmpty || stored.rootKeys.some((key) => key !== ROOT_WRAPPING_KEY && key !== ENCRYPTED_ROOT_ENTROPY) ||
		stored.rootKeys.length !== 2 || stored.playerKeys.length !== 1 || stored.playerKeys[0] !== PLAYER_STATE) {
		return { kind: 'corrupt', reason: 'partial-state' };
	}
	if (!hasValidWrappingKey(stored.rootWrappingKey) || !isEncryptedRootEntropy(stored.encryptedEntropy) || !isValidPlayerLifecycle(stored.player)) {
		return { kind: 'corrupt', reason: !isValidPlayerLifecycle(stored.player) ? 'player-state' : 'root-record' };
	}
	try {
		return { entropy: await decryptRootEntropy(stored.rootWrappingKey, stored.encryptedEntropy), player: stored.player };
	} catch {
		return { kind: 'corrupt', reason: 'root-decrypt' };
	}
}

function deriveMaster(entropy: Uint8Array): HDKey {
	const mnemonic = entropyToMnemonic(entropy, englishWordlist);
	const seed = mnemonicToSeedSync(mnemonic, '');
	try {
		return HDKey.fromMasterSeed(seed);
	} finally {
		seed.fill(0);
	}
}

function candidateFromSecret(accountIndex: number, secret: Uint8Array): IdentityCandidate | null {
	try {
		const pubkey = getPublicKey(secret);
		const characterId = deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG).characterId;
		return { accountIndex, pubkey, characterId };
	} catch {
		return null;
	}
}

async function preparePendingSelection(entropy: Uint8Array, generation: number, selectedCharacterIds: ReadonlySet<string>): Promise<PendingSelection> {
	assertBip85Index(generation, 'generation');
	if (CHARACTER_CATALOG.length - selectedCharacterIds.size < 3) throw new Error('Selection is unavailable.');
	const master = deriveMaster(entropy);
	const candidates: IdentityCandidate[] = [];
	try {
		for (let accountIndex = BIP85_INDEX_MIN; accountIndex <= Math.min(MAX_CANDIDATE_SCAN, BIP85_INDEX_MAX) && candidates.length < 3; accountIndex += 1) {
			let childEntropy: Uint8Array;
			try {
				childEntropy = await deriveBip85NostrEntropy(master, generation, accountIndex);
			} catch {
				continue;
			}
			const secret = childEntropy.slice();
			const candidate = candidateFromSecret(accountIndex, secret);
			childEntropy.fill(0);
			secret.fill(0);
			if (!candidate || selectedCharacterIds.has(candidate.characterId) || candidates.some((item) => item.characterId === candidate.characterId)) continue;
			candidates.push(candidate);
		}
	} finally {
		master.wipePrivateData();
	}
	if (candidates.length !== 3) throw new Error('Selection is unavailable.');
	return { generation, candidates: [candidates[0], candidates[1], candidates[2]] as PendingSelection['candidates'] };
}

async function prepareRoot(): Promise<PreparedRoot> {
	const cryptoApi = webCrypto();
	const entropy = cryptoApi.getRandomValues(new Uint8Array(ROOT_ENTROPY_BYTES));
	try {
		const wrappingKey = await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_LENGTH }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const iv = cryptoApi.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
		const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: cryptoBytes(iv) }, wrappingKey, cryptoBytes(entropy)));
		return { entropy, wrappingKey, encryptedEntropy: { version: ROOT_RECORD_VERSION, iv, ciphertext } };
	} catch (error) {
		entropy.fill(0);
		throw error;
	}
}

function freshPlayer(selection: PendingSelection): PlayerLifecycle {
	return { schemaVersion: 1, identities: [], mode: { kind: 'selecting', pendingSelection: selection } };
}

async function commitFresh(db: IDBPDatabase<LifecycleDatabase>, root: PreparedRoot, player: PlayerLifecycle): Promise<boolean> {
	const tx = db.transaction([ROOT_SECRET_STORE_NAME, PLAYER_LIFECYCLE_STORE_NAME], 'readwrite');
	try {
		const rootStore = tx.objectStore(ROOT_SECRET_STORE_NAME);
		const playerStore = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
		if ((await rootStore.getAllKeys()).length !== 0 || (await playerStore.getAllKeys()).length !== 0) {
			await tx.done;
			return false;
		}
		await rootStore.put(root.wrappingKey, ROOT_WRAPPING_KEY);
		await rootStore.put(root.encryptedEntropy, ENCRYPTED_ROOT_ENTROPY);
		await playerStore.put(player, PLAYER_STATE);
		await tx.done;
		return true;
	} catch (error) {
		try { tx.abort(); } catch { /* already aborted */ }
		await tx.done.catch(() => {});
		throw error;
	}
}

async function deriveSignerFromMaster(master: HDKey, identity: IdentityRecord): Promise<ActiveSignerSnapshot> {
	const childEntropy = await deriveBip85NostrEntropy(master, identity.generation, identity.accountIndex);
	try {
		const secretKey = childEntropy.slice();
		const pubkey = getPublicKey(secretKey);
		if (pubkey !== identity.pubkey || deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG).characterId !== identity.characterId) {
			secretKey.fill(0);
			throw new Error('Derivation mismatch.');
		}
		return { secretKey, pubkey, identityCreatedAtMs: identity.identityCreatedAtMs, characterProfileRevision: identity.characterProfileRevision, identity: { generation: identity.generation, accountIndex: identity.accountIndex, pubkey: identity.pubkey } };
	} finally {
		childEntropy.fill(0);
	}
}

async function validateIdentityDerivations(master: HDKey, identities: readonly IdentityRecord[]): Promise<void> {
	for (const identity of identities) {
		const signer = await deriveSignerFromMaster(master, identity);
		signer.secretKey.fill(0);
	}
}

async function hydrateLifecycle(entropy: Uint8Array, player: PlayerLifecycle): Promise<LoadLifecycleResult> {
	let master: HDKey | null = null;
	try {
		master = deriveMaster(entropy);
		await validateIdentityDerivations(master, player.identities);
		if (player.mode.kind === 'selecting') {
			const expectedCandidates: IdentityCandidate[] = [];
			for (const candidate of player.mode.pendingSelection.candidates) {
				const childEntropy = await deriveBip85NostrEntropy(master, player.mode.pendingSelection.generation, candidate.accountIndex);
				try {
					const derived = candidateFromSecret(candidate.accountIndex, childEntropy);
					if (!derived || !candidateMatches(derived, candidate)) return { kind: 'corrupt', reason: 'invalid-candidate' };
					expectedCandidates.push(derived);
				} finally {
					childEntropy.fill(0);
				}
			}
			const expected: PendingSelection = { generation: player.mode.pendingSelection.generation, candidates: expectedCandidates as unknown as PendingSelection['candidates'] };
			if (JSON.stringify(expected) !== JSON.stringify(player.mode.pendingSelection)) return { kind: 'corrupt', reason: 'invalid-candidate' };
			return { kind: 'selecting', selection: player.mode.pendingSelection };
		}
		const activeRun = player.mode.activeRun;
		const identity = player.identities.find((candidate) => candidate.generation === activeRun.identity.generation && candidate.accountIndex === activeRun.identity.accountIndex && candidate.pubkey === activeRun.identity.pubkey);
		if (!identity || identity.status !== 'alive') return { kind: 'corrupt', reason: 'identity-reference' };
		const signer = await deriveSignerFromMaster(master, identity);
		return { kind: 'restored', persona: { signer, identity, activeRun, gameState: activeRun.gameState } };
	} catch (error) {
		if (error instanceof Error && error.message === 'Selection is unavailable.') return { kind: 'corrupt', reason: 'selection-unavailable' };
		return { kind: 'corrupt', reason: 'derivation-mismatch' };
	} finally {
		master?.wipePrivateData();
		entropy.fill(0);
	}
}

async function withLifecycle<T>(callback: (db: IDBPDatabase<LifecycleDatabase>) => Promise<T>): Promise<T> {
	const db = await openLifecycleDatabase();
	try {
		return await callback(db);
	} catch (error) {
		if (error instanceof Error && error.message === 'Account operation failed.') throw error;
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}
}

export async function loadOrCreateLifecycle(): Promise<LoadLifecycleResult> {
	for (;;) {
		const observed = await withLifecycle((db) => readRootAndPlayer(db));
		if (observed === null) {
			const root = await prepareRoot();
			try {
				const selection = await preparePendingSelection(root.entropy, 1, new Set());
				const committed = await withLifecycle((db) => commitFresh(db, root, freshPlayer(selection)));
				if (committed) return { kind: 'created', selection };
			} finally {
				root.entropy.fill(0);
			}
			continue;
		}
		if (isCorruptLifecycle(observed)) return observed;
		const result = await hydrateLifecycle(observed.entropy, observed.player);
		observed.entropy.fill(0);
		return result;
	}
}

function candidateMatches(first: IdentityCandidate, second: IdentityCandidate): boolean {
	return first.accountIndex === second.accountIndex && first.pubkey === second.pubkey && first.characterId === second.characterId;
}

async function restoreCurrent(db: IDBPDatabase<LifecycleDatabase>): Promise<LoadLifecycleResult> {
	const observed = await readRootAndPlayer(db);
	if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
	if (isCorruptLifecycle(observed)) return observed;
	return hydrateLifecycle(observed.entropy, observed.player);
}

export async function authorizeActiveRun(expected: ActiveRunAuthorization): Promise<SelfWriteAuthorizationResult> {
	if (!isValidIdentityReference(expected.identity) || !Number.isSafeInteger(expected.runNumber) || expected.runNumber < 1) return 'corrupt';
	return withLifecycle(async (db) => {
		try {
			const stored = await readStoredRecords(db);
			const rootEmpty = stored.rootKeys.length === 0;
			const playerEmpty = stored.playerKeys.length === 0;
			if (rootEmpty !== playerEmpty || rootEmpty ||
				stored.rootKeys.some((key) => key !== ROOT_WRAPPING_KEY && key !== ENCRYPTED_ROOT_ENTROPY) ||
				stored.rootKeys.length !== 2 || stored.playerKeys.length !== 1 || stored.playerKeys[0] !== PLAYER_STATE ||
				!hasValidWrappingKey(stored.rootWrappingKey) || !isEncryptedRootEntropy(stored.encryptedEntropy) ||
				!isValidPlayerLifecycle(stored.player)) return 'corrupt';
			const player = stored.player;
			if (player.mode.kind !== 'running') return 'superseded';
			const activeRun = player.mode.activeRun;
			return sameIdentityReference(activeRun.identity, expected.identity) && activeRun.runNumber === expected.runNumber
				? 'authorized' : 'superseded';
		} catch {
			return 'corrupt';
		}
	});
}

export async function selectIdentity(expectedGeneration: number, candidate: IdentityCandidate): Promise<SelectionResult> {
	assertBip85Index(expectedGeneration, 'generation');
	if (!isValidCandidate(candidate)) return { kind: 'corrupt', reason: 'invalid-candidate' };
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
			if (current.mode.kind !== 'selecting' || current.mode.pendingSelection.generation !== expectedGeneration ||
				!current.mode.pendingSelection.candidates.some((item) => candidateMatches(item, candidate))) {
				await tx.done;
				const lifecycle = await restoreCurrent(db);
				return isCorruptLifecycle(lifecycle) ? lifecycle : { kind: 'superseded', lifecycle };
			}
			const nowMs = Date.now();
			if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
			const selected: IdentityRecord = {
				generation: expectedGeneration,
				accountIndex: candidate.accountIndex,
				pubkey: candidate.pubkey,
				characterId: candidate.characterId,
				identityCreatedAtMs: nowMs,
				status: 'alive',
				characterProfileRevision: null,
				runHistory: []
			};
			const gameState = createInitialPersonaGameState(candidate.pubkey, nowMs);
			const identityReference: IdentityReference = { generation: selected.generation, accountIndex: selected.accountIndex, pubkey: selected.pubkey };
			const activeRun: ActiveRun = { runNumber: 1, revision: 0, startedAtMs: nowMs, identity: identityReference, gameState };
			const next: PlayerLifecycle = {
				schemaVersion: 1,
				identities: [...current.identities, selected],
				mode: { kind: 'running', activeRun },
				realtimeSettlementLedger: { schemaVersion: 1, identity: identityReference, runNumber: 1, pendingInstanceIds: [], appliedOutcomeIds: [] }
			};
			await store.put(next, PLAYER_STATE);
			await tx.done;
			const loaded = await loadOrCreateLifecycle();
			return loaded.kind === 'restored' ? { kind: 'selected', persona: loaded.persona } :
				(isCorruptLifecycle(loaded) ? loaded : { kind: 'corrupt', reason: 'identity-reference' });
		} catch (error) {
			try { tx.abort(); } catch { /* already aborted */ }
			await tx.done.catch(() => {});
			throw error;
		}
	});
}

function samePersonaExpected(expected: PersonaSnapshot, activeRun: ActiveRun): boolean {
	return sameIdentityReference(expected.activeRun.identity, activeRun.identity) && expected.activeRun.runNumber === activeRun.runNumber &&
		expected.activeRun.revision === activeRun.revision && sameGameState(expected.gameState, activeRun.gameState);
}

async function mutateMending(expected: PersonaSnapshot, operation: 'start' | 'collect'): Promise<MendingMutationResult> {
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
		if (isCorruptLifecycle(observed)) return observed;
		try {
			if (observed.player.mode.kind !== 'running') {
				const latest = await hydrateLifecycle(observed.entropy, observed.player);
				return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest };
			}
			if (!samePersonaExpected(expected, observed.player.mode.activeRun)) {
				const latest = await hydrateLifecycle(observed.entropy, observed.player);
				return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest };
			}
			const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
			try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
			if (current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) {
				await tx.done;
				const latest = await restoreCurrent(db);
				return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest };
			}
			const activeRun = current.mode.activeRun;
			const nowMs = Date.now();
			if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
			if (isPersonaExpired(activeRun.gameState, nowMs)) {
				await tx.done;
				const latest = await hydrateLifecycle(observed.entropy, current);
				return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			}
			let kind: MendingMutationResult['kind'];
			let gameState = activeRun.gameState;
			if (operation === 'start') {
				if (gameState.mendingJob) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				gameState = { ...gameState, mendingJob: createMendingJob(gameState.abilities, nowMs) };
				kind = 'started';
			} else {
				if (!gameState.mendingJob) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				const reward = materializeMending(gameState, nowMs);
				if (!reward) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				gameState = { ...gameState, lifespanExpiresAtMs: reward.lifespanExpiresAtMs, points: reward.points, pointProgressTicks: reward.pointProgressTicks, mendingJob: reward.mendingJob };
				kind = 'collected';
			}
			const nextRun: ActiveRun = { ...activeRun, revision: activeRun.revision + 1, gameState };
			const next: PlayerLifecycle = { ...current, mode: { kind: 'running', activeRun: nextRun } };
			await store.put(next, PLAYER_STATE);
			await tx.done;
			const latest = await loadOrCreateLifecycle();
			return latest.kind === 'restored' ? { kind, persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			} catch (error) {
				try { tx.abort(); } catch { /* already aborted */ }
				await tx.done.catch(() => {});
				throw error;
			}
		} finally {
			observed.entropy.fill(0);
		}
	});
}

export function startMending(expected: PersonaSnapshot): Promise<MendingMutationResult> {
	return mutateMending(expected, 'start');
}

export function collectMending(expected: PersonaSnapshot): Promise<MendingMutationResult> {
	return mutateMending(expected, 'collect');
}

async function mutateAbilityUpgrade(expected: PersonaSnapshot, key: PersonaAbilityKey): Promise<AbilityUpgradeResult> {
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
		if (isCorruptLifecycle(observed)) return observed;
		try {
			if (observed.player.mode.kind !== 'running' || !samePersonaExpected(expected, observed.player.mode.activeRun)) {
				const latest = await hydrateLifecycle(observed.entropy, observed.player);
				return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest };
			}
			const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
				if (current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) {
					await tx.done;
					const latest = await restoreCurrent(db);
					return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest };
				}
				const nowMs = Date.now();
				if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
				if (isPersonaExpired(current.mode.activeRun.gameState, nowMs)) {
					await tx.done;
					const latest = await hydrateLifecycle(observed.entropy, current);
					return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
				}
				const nextGameState = upgradeAbility(current.mode.activeRun.gameState, key);
				if (!nextGameState) {
					await tx.done;
					const latest = await hydrateLifecycle(observed.entropy, current);
					return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
				}
				const activeRun = current.mode.activeRun;
				const next: PlayerLifecycle = { ...current, mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1, gameState: nextGameState } } };
				await store.put(next, PLAYER_STATE);
				await tx.done;
				const latest = await loadOrCreateLifecycle();
				return latest.kind === 'restored' ? { kind: 'upgraded', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			} catch (error) {
				try { tx.abort(); } catch { /* already aborted */ }
				await tx.done.catch(() => {});
				throw error;
			}
		} finally {
			observed.entropy.fill(0);
		}
	});
}

export function upgradePersonaAbility(expected: PersonaSnapshot, key: PersonaAbilityKey): Promise<AbilityUpgradeResult> {
	return mutateAbilityUpgrade(expected, key);
}

function sameRealtimeRunScope(expected: PersonaSnapshot, activeRun: ActiveRun): boolean {
	return sameIdentityReference(expected.activeRun.identity, activeRun.identity) && expected.activeRun.runNumber === activeRun.runNumber;
}

function emptyRealtimeLedger(activeRun: ActiveRun): RealtimeSettlementLedger {
	return { schemaVersion: 1, identity: activeRun.identity, runNumber: activeRun.runNumber, pendingInstanceIds: [], appliedOutcomeIds: [] };
}

function scopedRealtimeLedger(player: PlayerLifecycle, activeRun: ActiveRun): RealtimeSettlementLedger {
	const ledger = player.realtimeSettlementLedger;
	return ledger && sameIdentityReference(ledger.identity, activeRun.identity) && ledger.runNumber === activeRun.runNumber
		? ledger
		: emptyRealtimeLedger(activeRun);
}

function validRealtimeOutcome(outcome: RealtimeOutcome): boolean {
	return typeof outcome.id === 'string' && outcome.id.length > 0 && outcome.id.length <= 240 &&
		typeof outcome.instanceId === 'string' && outcome.instanceId.length > 0 && outcome.instanceId.length <= 160 &&
		(outcome.kind === 'death' || (outcome.kind === 'points' && Number.isSafeInteger(outcome.points) && (outcome.points as number) > 0));
}

/** Records a known instance in the existing lifecycle record for reload recovery. */
export async function trackRealtimeEventInstance(expected: PersonaSnapshot, instanceId: string): Promise<boolean> {
	if (!instanceId || instanceId.length > 160) return false;
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) {
				await tx.done;
				return false;
			}
			const ledger = scopedRealtimeLedger(current, current.mode.activeRun);
			if (ledger.pendingInstanceIds.includes(instanceId)) {
				await tx.done;
				return true;
			}
			const next: PlayerLifecycle = {
				...current,
				realtimeSettlementLedger: { ...ledger, pendingInstanceIds: [...ledger.pendingInstanceIds, instanceId] }
			};
			await store.put(next, PLAYER_STATE);
			await tx.done;
			return true;
		} catch (error) {
			try { tx.abort(); } catch { /* already aborted */ }
			await tx.done.catch(() => {});
			throw error;
		}
	});
}

/** Removes a recovery marker once the event definition proves its instance terminal. */
export async function completeRealtimeEventInstance(expected: PersonaSnapshot, instanceId: string): Promise<boolean> {
	if (!instanceId || instanceId.length > 160) return false;
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) {
				await tx.done;
				return false;
			}
			const ledger = scopedRealtimeLedger(current, current.mode.activeRun);
			if (!ledger.pendingInstanceIds.includes(instanceId)) {
				await tx.done;
				return true;
			}
			await store.put({ ...current, realtimeSettlementLedger: {
				...ledger,
				pendingInstanceIds: ledger.pendingInstanceIds.filter((candidate) => candidate !== instanceId)
			} }, PLAYER_STATE);
			await tx.done;
			return true;
		} catch (error) {
			try { tx.abort(); } catch { /* already aborted */ }
			await tx.done.catch(() => {});
			throw error;
		}
	});
}

export async function getRealtimeSettlementLedger(expected: PersonaSnapshot): Promise<RealtimeSettlementLedger | null> {
	return withLifecycle(async (db) => {
		const stored = await readStoredRecords(db);
		if (!isValidPlayerLifecycle(stored.player) || stored.player.mode.kind !== 'running' || !sameRealtimeRunScope(expected, stored.player.mode.activeRun)) return null;
		return stored.player.realtimeSettlementLedger && sameIdentityReference(stored.player.realtimeSettlementLedger.identity, stored.player.mode.activeRun.identity) &&
			stored.player.realtimeSettlementLedger.runNumber === stored.player.mode.activeRun.runNumber
			? stored.player.realtimeSettlementLedger
			: null;
	});
}

/** Applies a small, opaque core outcome and its receipt in one IndexedDB transaction. */
export async function applyRealtimeOutcome(expected: PersonaSnapshot, outcome: RealtimeOutcome): Promise<RealtimeSettlementResult> {
	if (outcome.kind !== 'points' || !validRealtimeOutcome(outcome)) return { kind: 'corrupt', reason: 'player-state' };
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
		if (isCorruptLifecycle(observed)) return observed;
		try {
			const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) {
					await tx.done;
					return { kind: 'stale' };
				}
				const activeRun = current.mode.activeRun;
				const ledger = scopedRealtimeLedger(current, activeRun);
				if (ledger.appliedOutcomeIds.includes(outcome.id)) {
					await tx.done;
					const latest = await loadOrCreateLifecycle();
					return latest.kind === 'restored' ? { kind: 'duplicate', persona: latest.persona } : { kind: 'stale' };
				}
				const nowMs = Date.now();
				if (isPersonaExpired(activeRun.gameState, nowMs)) {
					const next: PlayerLifecycle = {
						...current,
						mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1 } },
						realtimeSettlementLedger: {
							...ledger,
							appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id]
						}
					};
					await store.put(next, PLAYER_STATE);
					await tx.done;
					const latest = await loadOrCreateLifecycle();
					return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'stale' };
				}
				if (activeRun.gameState.points + outcome.points! > Number.MAX_SAFE_INTEGER) {
					await tx.done;
					return { kind: 'corrupt', reason: 'player-state' };
				}
				const nextGameState = { ...activeRun.gameState, points: activeRun.gameState.points + outcome.points! };
				const next: PlayerLifecycle = {
					...current,
					mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1, gameState: nextGameState } },
					realtimeSettlementLedger: {
						...ledger,
						appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id]
					}
				};
				await store.put(next, PLAYER_STATE);
				await tx.done;
				const latest = await loadOrCreateLifecycle();
				return latest.kind === 'restored' ? { kind: 'applied', persona: latest.persona } : { kind: 'stale' };
			} catch (error) {
				try { tx.abort(); } catch { /* already aborted */ }
				await tx.done.catch(() => {});
				throw error;
			}
		} finally {
			observed.entropy.fill(0);
		}
	});
}

/** Explicit event-death path sharing current Run/Identity closing semantics. */
export async function transitionRealtimeDeath(expected: PersonaSnapshot, outcome: RealtimeOutcome): Promise<RealtimeDeathResult> {
	if (outcome.kind !== 'death' || !validRealtimeOutcome(outcome)) return { kind: 'corrupt', reason: 'player-state' };
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
	if (isCorruptLifecycle(observed)) return observed;
	try {
		if (observed.player.mode.kind !== 'running' || !sameRealtimeRunScope(expected, observed.player.mode.activeRun)) return { kind: 'stale' };
		if (isPersonaExpired(observed.player.mode.activeRun.gameState, Date.now())) return { kind: 'stale' };
		const existingLedger = scopedRealtimeLedger(observed.player, observed.player.mode.activeRun);
		if (existingLedger.appliedOutcomeIds.includes(outcome.id)) return { kind: 'duplicate' };
		const generation = Math.max(...observed.player.identities.map((identity) => identity.generation), 0) + 1;
		let selection: PendingSelection;
		try {
			selection = await preparePendingSelection(observed.entropy, generation, new Set(observed.player.identities.map((identity) => identity.characterId)));
		} catch (error) {
			return { kind: 'corrupt', reason: error instanceof Error && error.message === 'Selection is unavailable.' ? 'selection-unavailable' : 'derivation-mismatch' };
		}
		return withLifecycle(async (db) => {
			const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
				if (current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return { kind: 'stale' }; }
				const activeRun = current.mode.activeRun;
				if (isPersonaExpired(activeRun.gameState, Date.now())) { await tx.done; return { kind: 'stale' }; }
				const ledger = scopedRealtimeLedger(current, activeRun);
				if (ledger.appliedOutcomeIds.includes(outcome.id)) { await tx.done; return { kind: 'duplicate' }; }
				const identity = current.identities.find((item) => sameIdentityReference(item, activeRun.identity));
				if (!identity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
				const nowMs = Date.now();
				const closedIdentity: IdentityRecord = {
					...identity,
					status: 'dead',
					runHistory: [...identity.runHistory, { runNumber: activeRun.runNumber, startedAtMs: activeRun.startedAtMs, endedAtMs: nowMs, outcome: 'dead' }]
				};
				const next: PlayerLifecycle = {
					schemaVersion: 1,
					identities: current.identities.map((item) => item === identity ? closedIdentity : item),
					mode: { kind: 'selecting', pendingSelection: selection },
					realtimeSettlementLedger: { ...ledger, pendingInstanceIds: [], appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id] }
				};
				await store.put(next, PLAYER_STATE);
				await tx.done;
				return { kind: 'transitioned' };
			} catch (error) {
				try { tx.abort(); } catch { /* already aborted */ }
				await tx.done.catch(() => {});
				throw error;
			}
		});
	} finally {
		observed.entropy.fill(0);
	}
}

export async function transitionExpiredPersona(expected: PersonaSnapshot): Promise<DeathTransitionResult> {
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
	if (isCorruptLifecycle(observed)) return observed;
	try {
		if (observed.player.mode.kind !== 'running' || !samePersonaExpected(expected, observed.player.mode.activeRun)) {
			const latest = await hydrateLifecycle(observed.entropy, observed.player);
			return latest.kind === 'restored' ? { kind: 'superseded', } : { kind: 'superseded' };
		}
		if (!isPersonaExpired(observed.player.mode.activeRun.gameState, Date.now())) {
			const latest = await hydrateLifecycle(observed.entropy, observed.player);
			return latest.kind === 'restored' ? { kind: 'not-expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
		}
		const generation = Math.max(...observed.player.identities.map((identity) => identity.generation), 0) + 1;
		let selection: PendingSelection;
		try {
			selection = await preparePendingSelection(observed.entropy, generation, new Set(observed.player.identities.map((identity) => identity.characterId)));
		} catch (error) {
			return { kind: error instanceof Error && error.message === 'Selection is unavailable.' ? 'corrupt' : 'corrupt', reason: error instanceof Error && error.message === 'Selection is unavailable.' ? 'selection-unavailable' : 'derivation-mismatch' };
		}
		return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
			if (current.mode.kind !== 'running') { await tx.done; return { kind: 'superseded' }; }
			const currentRun = current.mode.activeRun;
			if (!samePersonaExpected(expected, currentRun)) { await tx.done; return { kind: 'superseded' }; }
			const nowMs = Date.now();
			if (!isPersonaExpired(currentRun.gameState, nowMs)) {
				await tx.done;
				const latest = await restoreCurrent(db);
				return latest.kind === 'restored' ? { kind: 'not-expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			}
			const identity = current.identities.find((item) => sameIdentityReference(item, currentRun.identity));
			if (!identity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
			const closedIdentity: IdentityRecord = {
				...identity,
				status: 'dead',
				runHistory: [...identity.runHistory, { runNumber: currentRun.runNumber, startedAtMs: currentRun.startedAtMs, endedAtMs: nowMs, outcome: 'dead' }]
			};
			const next: PlayerLifecycle = { schemaVersion: 1, identities: current.identities.map((item) => item === identity ? closedIdentity : item), mode: { kind: 'selecting', pendingSelection: selection } };
			await store.put(next, PLAYER_STATE);
			await tx.done;
			return { kind: 'transitioned' };
		} catch (error) {
			try { tx.abort(); } catch { /* already aborted */ }
			await tx.done.catch(() => {});
			throw error;
		}
		});
	} finally {
		observed.entropy.fill(0);
	}
}

export async function markCharacterProfilePublication(signer: ActiveSignerSnapshot): Promise<MarkCharacterProfilePublicationResult> {
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameIdentityReference(current.mode.activeRun.identity, signer.identity)) { await tx.done; return { kind: 'stale' }; }
			const identity = current.identities.find((item) => sameIdentityReference(item, signer.identity) && item.status === 'alive');
			if (!identity) { await tx.done; return { kind: 'stale' }; }
			const nextIdentity: IdentityRecord = { ...identity, characterProfileRevision: CURRENT_CHARACTER_PROFILE_REVISION };
			const next: PlayerLifecycle = { ...current, identities: current.identities.map((item) => item === identity ? nextIdentity : item) };
			await store.put(next, PLAYER_STATE);
			await tx.done;
			return { kind: 'recorded' };
		} catch {
			try { tx.abort(); } catch { /* already aborted */ }
			await tx.done.catch(() => {});
			return { kind: 'stale' };
		}
	});
}
