import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
import { CHARACTER_CATALOG } from './character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from './characterAssignment';
import { deriveBip85NostrEntropy, assertBip85Index, BIP85_INDEX_MAX, BIP85_INDEX_MIN } from './bip85';
import {
	createInitialPersonaGameState,
	isPersonaExpired,
	isValidPersonaGameState,
	upgradeAbility,
	type PersonaAbilityKey,
	type PersonaGameState
} from './personaGameState';
import { createMendingJob, settleMending, projectMending, type MendingJob } from './mending';
import { isRootBuildAllocatable, isValidRootBuild, type RootBuild, rootBuildCost } from './rootProgression';

export const DATABASE_NAME = 'persona-bubble-field-account';
export const DATABASE_VERSION = 8;
export const ROOT_SECRET_STORE_NAME = 'persona-bubble-field-root-secret';
export const PLAYER_LIFECYCLE_STORE_NAME = 'persona-bubble-field-player-state';
export const WORLD_WRITE_JOURNAL_STORE_NAME = 'persona-bubble-field-world-write-journal';
export const LIFECYCLE_UPGRADE_BLOCKED_MESSAGE = 'Close other open Hako tabs, then reload to finish account storage upgrade.';
export const CURRENT_CHARACTER_PROFILE_REVISION = 2;

const ROOT_WRAPPING_KEY = 'root-wrapping-key';
const ENCRYPTED_ROOT_ENTROPY = 'encrypted-root-entropy';
const PLAYER_STATE = 'player-lifecycle';
const ROOT_RECORD_VERSION = 1;
const PLAYER_SCHEMA_VERSION = 2;
const AES_KEY_LENGTH = 256;
const AES_GCM_IV_BYTES = 12;
const ROOT_ENTROPY_BYTES = 16;
const MAX_CANDIDATE_SCAN = 100_000;
export const NORMAL_CLEAR_THRESHOLD = 100_000;

interface LifecycleDatabase extends DBSchema {
	[ROOT_SECRET_STORE_NAME]: { key: string; value: unknown };
	[PLAYER_LIFECYCLE_STORE_NAME]: { key: string; value: unknown };
	[WORLD_WRITE_JOURNAL_STORE_NAME]: { key: string; value: unknown };
}

export type IdentityReference = Readonly<{ generation: number; accountIndex: number; pubkey: string }>;

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
	status: 'alive' | 'dead' | 'cleared';
	characterProfileRevision: number | null;
	runHistory: readonly RunHistorySummary[];
}>;

export type IdentityCandidate = Readonly<{ accountIndex: number; pubkey: string; characterId: string }>;
export type ClearedIdentityCandidate = IdentityCandidate & Readonly<{ generation: number }>;
export type SelectionCandidate = IdentityCandidate | ClearedIdentityCandidate;

export type SelectIdentityOptions = Readonly<{
	initialLifespanMs?: number;
	initialPoints?: number;
}>;

export type PendingSelection = Readonly<{
	generation: number;
	candidates: readonly [IdentityCandidate, IdentityCandidate, IdentityCandidate];
	reusableIdentities: readonly ClearedIdentityCandidate[];
}>;

export type ActiveRun = Readonly<{
	runNumber: number;
	revision: number;
	startedAtMs: number;
	identity: IdentityReference;
	rootBuild: RootBuild;
	gameState: PersonaGameState;
}>;

export type RealtimeSettlementLedger = Readonly<{
	schemaVersion: 1;
	identity: IdentityReference;
	runNumber: number;
	pendingInstanceIds: readonly string[];
	appliedOutcomeIds: readonly string[];
}>;

export type RealtimeOutcome = Readonly<{ id: string; kind: 'points' | 'death' | 'lifespan-loss'; points?: number; lifespanLossMs?: number; instanceId: string }>;

export type PlayerLifecycle = Readonly<{
	schemaVersion: 2;
	rootPoints: number;
	identities: readonly IdentityRecord[];
	mode:
		| Readonly<{ kind: 'selecting'; pendingSelection: PendingSelection }>
		| Readonly<{ kind: 'running'; activeRun: ActiveRun }>;
	realtimeSettlementLedger?: RealtimeSettlementLedger;
}>;

export type ActiveSignerSnapshot = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	identityCreatedAtMs: number;
	characterProfileRevision: number | null;
	identity: IdentityReference;
}>;

export type ActiveRunAuthorization = Readonly<{ identity: IdentityReference; runNumber: number }>;
export type SelfWriteAuthorizationResult = 'authorized' | 'superseded' | 'corrupt';
export type WorldWriteJournalScope = ActiveRunAuthorization & Readonly<{ channelId: string }>;
export type WorldWriteJournalSnapshot = Readonly<{
	lastReservedSecond: number | null;
	consumedSlots: 0 | 1 | 2;
	lastPositiveSecond: number | null;
	exitSecond: number | null;
	confirmedPosition: VerifiedEvent | null;
}>;
export type WorldWriteReservation = Readonly<{ token: number; createdAt: number; slot: 0 | 1 | null }>;
export type WorldWriteReservationResult =
	| Readonly<{ kind: 'reserved'; reservation: WorldWriteReservation }>
	| Readonly<{ kind: 'wait'; untilSecond: number }>
	| Readonly<{ kind: 'duplicate' | 'stale' | 'corrupt' | 'clock-regressed' }>;
export type TerminalExitJournalRequest = Readonly<{
	channelId: string;
	position: Readonly<{ x: number; y: number }>;
	lastPositiveCreatedAt: number;
}>;
export type CommittedTerminalExit = Readonly<{ createdAt: number; position: Readonly<{ x: number; y: number }> }>;
export type PersonaSnapshot = Readonly<{ rootPoints: number; signer: ActiveSignerSnapshot; identity: IdentityRecord; activeRun: ActiveRun; gameState: PersonaGameState }>;

export type CorruptLifecycleState = Readonly<{
	kind: 'corrupt';
	reason: 'root-record' | 'root-decrypt' | 'root-entropy' | 'partial-state' | 'player-state' | 'identity-reference' |
		'derivation-mismatch' | 'invalid-candidate' | 'ambiguous-lifecycle' | 'selection-unavailable';
}>;

export type LoadLifecycleResult =
	| Readonly<{ kind: 'created' | 'selecting'; selection: PendingSelection; rootPoints: number }>
	| Readonly<{ kind: 'restored'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type SelectionResult =
	| Readonly<{ kind: 'selected'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'superseded'; lifecycle: LoadLifecycleResult }>
	| Readonly<{ kind: 'blocked'; reason: 'root-build' | 'candidate' }>
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
	| Readonly<{ kind: 'transitioned'; exit?: CommittedTerminalExit }>
	| Readonly<{ kind: 'superseded' }>
	| Readonly<{ kind: 'not-expired'; persona: PersonaSnapshot }>
	| CorruptLifecycleState;

export type ClearResult =
	| Readonly<{ kind: 'cleared'; exit?: CommittedTerminalExit }>
	| Readonly<{ kind: 'blocked'; reason: 'points' | 'expired' | 'pending-realtime' }>
	| Readonly<{ kind: 'superseded'; lifecycle: LoadLifecycleResult }>
	| CorruptLifecycleState;

export type MarkCharacterProfilePublicationResult = Readonly<{ kind: 'recorded' | 'stale' }>;
export type RealtimeSettlementResult =
	| Readonly<{ kind: 'applied'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'duplicate'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'expired'; persona: PersonaSnapshot }>
	| Readonly<{ kind: 'stale' }>
	| CorruptLifecycleState;
export type RealtimeDeathResult = Readonly<{ kind: 'transitioned'; exit?: CommittedTerminalExit }> | Readonly<{ kind: 'duplicate' | 'stale' }> | CorruptLifecycleState;
export type RealtimeLifespanLossResult = Readonly<{ kind: 'survived' | 'duplicate'; persona: PersonaSnapshot }> | Readonly<{ kind: 'transitioned'; exit?: CommittedTerminalExit }> | Readonly<{ kind: 'stale' }> | CorruptLifecycleState;

type EncryptedRootEntropy = Readonly<{ version: 1; iv: Uint8Array; ciphertext: Uint8Array }>;
type PreparedRoot = Readonly<{ entropy: Uint8Array; wrappingKey: CryptoKey; encryptedEntropy: EncryptedRootEntropy }>;
type StoredRecords = Readonly<{ rootKeys: readonly IDBValidKey[]; rootWrappingKey: unknown; encryptedEntropy: unknown; playerKeys: readonly IDBValidKey[]; player: unknown }>;
type HydratedStorage = Readonly<{ entropy: Uint8Array; player: PlayerLifecycle }>;
type LegacyPlayerReset = Readonly<{ kind: 'legacy-player-reset'; entropy: Uint8Array }>;
type ReadStorage = HydratedStorage | LegacyPlayerReset | CorruptLifecycleState | null;

function isCorruptLifecycle(value: unknown): value is CorruptLifecycleState {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'corrupt';
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
	return Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 && isSafeTimestamp(candidate.startedAtMs) &&
		isSafeTimestamp(candidate.endedAtMs) && candidate.endedAtMs >= candidate.startedAtMs && (candidate.outcome === 'dead' || candidate.outcome === 'cleared');
}

function isValidIdentityRecord(value: unknown): value is IdentityRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isPositiveIndex(candidate.generation) && isPositiveIndex(candidate.accountIndex) && isCanonicalPubkey(candidate.pubkey) &&
		typeof candidate.characterId === 'string' && Boolean(CHARACTER_CATALOG.find((character) => character.characterId === candidate.characterId)) &&
		isSafeTimestamp(candidate.identityCreatedAtMs) && (candidate.status === 'alive' || candidate.status === 'dead' || candidate.status === 'cleared') &&
		(candidate.characterProfileRevision === null || (Number.isSafeInteger(candidate.characterProfileRevision) && (candidate.characterProfileRevision as number) > 0)) &&
		Array.isArray(candidate.runHistory) && candidate.runHistory.every(isValidRunHistorySummary) &&
		candidate.runHistory.every((run, index) => run.runNumber === index + 1) &&
		(candidate.status === 'alive' || candidate.runHistory.length > 0) &&
		(candidate.status !== 'cleared' || candidate.runHistory.at(-1)?.outcome === 'cleared') &&
		(candidate.status !== 'dead' || candidate.runHistory.at(-1)?.outcome === 'dead');
}

function isValidCandidate(value: unknown): value is IdentityCandidate {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isPositiveIndex(candidate.accountIndex) && isCanonicalPubkey(candidate.pubkey) && typeof candidate.characterId === 'string' &&
		Boolean(CHARACTER_CATALOG.find((character) => character.characterId === candidate.characterId));
}

function isValidClearedCandidate(value: unknown): value is ClearedIdentityCandidate {
	return isValidCandidate(value) && isPositiveIndex((value as Record<string, unknown>).generation);
}

function isValidPendingSelection(value: unknown): value is PendingSelection {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (!isPositiveIndex(candidate.generation) || !Array.isArray(candidate.candidates) || candidate.candidates.length !== 3 || !candidate.candidates.every(isValidCandidate) ||
		!Array.isArray(candidate.reusableIdentities) || !candidate.reusableIdentities.every(isValidClearedCandidate)) return false;
	const candidates = candidate.candidates as IdentityCandidate[];
	const reusable = candidate.reusableIdentities as ClearedIdentityCandidate[];
	return new Set(candidates.map((item) => item.accountIndex)).size === 3 && new Set(candidates.map((item) => item.pubkey)).size === 3 &&
		new Set(candidates.map((item) => item.characterId)).size === 3 && new Set(reusable.map((item) => `${item.generation}:${item.accountIndex}`)).size === reusable.length;
}

function isValidRealtimeSettlementLedger(value: unknown): value is RealtimeSettlementLedger {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.schemaVersion === 1 && isValidIdentityReference(candidate.identity) && Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 &&
		Array.isArray(candidate.pendingInstanceIds) && candidate.pendingInstanceIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160) &&
		new Set(candidate.pendingInstanceIds).size === candidate.pendingInstanceIds.length && Array.isArray(candidate.appliedOutcomeIds) &&
		candidate.appliedOutcomeIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 240) && new Set(candidate.appliedOutcomeIds).size === candidate.appliedOutcomeIds.length;
}

function isValidActiveRun(value: unknown): value is ActiveRun {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return Number.isSafeInteger(candidate.runNumber) && (candidate.runNumber as number) > 0 && Number.isSafeInteger(candidate.revision) && (candidate.revision as number) >= 0 &&
		isSafeTimestamp(candidate.startedAtMs) && isValidIdentityReference(candidate.identity) && isValidRootBuild(candidate.rootBuild) &&
		isValidPersonaGameState(candidate.gameState) && candidate.gameState.personaPubkey === (candidate.identity as IdentityReference).pubkey;
}

function isValidPlayerLifecycle(value: unknown): value is PlayerLifecycle {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.schemaVersion !== PLAYER_SCHEMA_VERSION || !Number.isSafeInteger(candidate.rootPoints) || (candidate.rootPoints as number) < 0 ||
		!Array.isArray(candidate.identities) || !candidate.identities.every(isValidIdentityRecord) ||
		(candidate.realtimeSettlementLedger !== undefined && !isValidRealtimeSettlementLedger(candidate.realtimeSettlementLedger))) return false;
	const identities = candidate.identities as IdentityRecord[];
	if (new Set(identities.map((item) => item.generation)).size !== identities.length || new Set(identities.map((item) => `${item.generation}:${item.accountIndex}`)).size !== identities.length ||
		new Set(identities.map((item) => item.pubkey)).size !== identities.length || new Set(identities.map((item) => item.characterId)).size !== identities.length) return false;
	if (typeof candidate.mode !== 'object' || candidate.mode === null || Array.isArray(candidate.mode)) return false;
	const mode = candidate.mode as Record<string, unknown>;
	if (mode.kind === 'selecting') {
		if (identities.some((identity) => identity.status === 'alive') || !isValidPendingSelection(mode.pendingSelection)) return false;
		const pending = mode.pendingSelection as PendingSelection;
		const highestGeneration = Math.max(...identities.map((identity) => identity.generation), 0);
		if (pending.generation !== highestGeneration + 1 || identities.some((identity) => pending.candidates.some((item) => item.characterId === identity.characterId || item.pubkey === identity.pubkey))) return false;
		return pending.reusableIdentities.every((item) => {
			const identity = identities.find((candidate) => candidate.generation === item.generation && candidate.accountIndex === item.accountIndex && candidate.pubkey === item.pubkey);
			return Boolean(identity && identity.status === 'cleared' && identity.characterId === item.characterId);
		});
	}
	if (mode.kind !== 'running' || !isValidActiveRun(mode.activeRun)) return false;
	const activeRun = mode.activeRun as ActiveRun;
	const identity = identities.find((item) => item.pubkey === activeRun.identity.pubkey && item.generation === activeRun.identity.generation && item.accountIndex === activeRun.identity.accountIndex);
	return identities.filter((item) => item.status === 'alive').length === 1 && Boolean(identity && identity.status === 'alive' && identity.runHistory.length === activeRun.runNumber - 1 &&
		activeRun.startedAtMs >= identity.identityCreatedAtMs && identity.runHistory.every((run, index) => run.runNumber === index + 1) &&
		isRootBuildAllocatable(activeRun.rootBuild, candidate.rootPoints as number));
}

function hasValidWrappingKey(value: unknown): value is CryptoKey {
	const CryptoKeyConstructor = globalThis.CryptoKey;
	if (!CryptoKeyConstructor || !(value instanceof CryptoKeyConstructor)) return false;
	const usages = new Set(value.usages);
	return value.type === 'secret' && value.algorithm.name === 'AES-GCM' && (value.algorithm as AesKeyAlgorithm).length === AES_KEY_LENGTH && !value.extractable && usages.size === 2 && usages.has('encrypt') && usages.has('decrypt');
}

function isEncryptedRootEntropy(value: unknown): value is EncryptedRootEntropy {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.version === ROOT_RECORD_VERSION && candidate.iv instanceof Uint8Array && candidate.iv.length === AES_GCM_IV_BYTES && candidate.ciphertext instanceof Uint8Array && candidate.ciphertext.length >= 16;
}

function isLegacyPlayerResetMarker(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).kind === 'legacy-player-reset' && (value as Record<string, unknown>).sourceVersion === 1;
}

function sameIdentityReference(first: IdentityReference, second: IdentityReference): boolean {
	return first.generation === second.generation && first.accountIndex === second.accountIndex && first.pubkey === second.pubkey;
}

function sameGameState(first: PersonaGameState, second: PersonaGameState): boolean {
	return first.version === second.version && first.personaPubkey === second.personaPubkey && first.lifespanExpiresAtMs === second.lifespanExpiresAtMs && first.points === second.points &&
		first.pointProgressTicks === second.pointProgressTicks && first.inferenceAccelerationUsedMs === second.inferenceAccelerationUsedMs &&
		first.abilities.inferenceEfficiency === second.abilities.inferenceEfficiency && first.abilities.contextCapacity === second.abilities.contextCapacity && first.abilities.hallucinationSuppression === second.abilities.hallucinationSuppression &&
		first.mendingJob?.startedAtMs === second.mendingJob?.startedAtMs && first.mendingJob?.checkpointAtMs === second.mendingJob?.checkpointAtMs && first.mendingJob?.processedDurationMs === second.mendingJob?.processedDurationMs && first.mendingJob?.unclaimedPoints === second.mendingJob?.unclaimedPoints;
}

function sameRootBuild(first: RootBuild, second: RootBuild): boolean {
	return first.inferenceAcceleration === second.inferenceAcceleration && first.contextCompression === second.contextCompression && first.hallucinationResistance === second.hallucinationResistance;
}

function samePersonaExpected(expected: PersonaSnapshot, activeRun: ActiveRun): boolean {
	return sameIdentityReference(expected.activeRun.identity, activeRun.identity) && expected.activeRun.runNumber === activeRun.runNumber && expected.activeRun.revision === activeRun.revision && sameRootBuild(expected.activeRun.rootBuild, activeRun.rootBuild) && sameGameState(expected.gameState, activeRun.gameState);
}

function openLifecycleDatabase(): Promise<IDBPDatabase<LifecycleDatabase>> {
	try {
		if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable.');
		return new Promise((resolve, reject) => {
			let blocked = false;
			void openDB<LifecycleDatabase>(DATABASE_NAME, DATABASE_VERSION, {
			blocked() {
				blocked = true;
				reject(new Error(LIFECYCLE_UPGRADE_BLOCKED_MESSAGE));
			},
			async upgrade(db, oldVersion, _newVersion, transaction) {
				const hasRootStore = db.objectStoreNames.contains(ROOT_SECRET_STORE_NAME);
				const hasPlayerStore = db.objectStoreNames.contains(PLAYER_LIFECYCLE_STORE_NAME);
				// v7 is the current lifecycle format. Preserve it when adding the journal.
				if (oldVersion === 7 && hasRootStore && hasPlayerStore) {
					db.createObjectStore(WORLD_WRITE_JOURNAL_STORE_NAME);
					return;
				}
				if (oldVersion >= 6 && hasRootStore && hasPlayerStore) {
					if (!db.objectStoreNames.contains(WORLD_WRITE_JOURNAL_STORE_NAME)) db.createObjectStore(WORLD_WRITE_JOURNAL_STORE_NAME);
					const rootStore = transaction.objectStore(ROOT_SECRET_STORE_NAME);
					const playerStore = transaction.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
					const [rootKeys, rootWrappingKey, encryptedEntropy, playerKeys] = await Promise.all([
						rootStore.getAllKeys(),
						rootStore.get(ROOT_WRAPPING_KEY),
						rootStore.get(ENCRYPTED_ROOT_ENTROPY),
						playerStore.getAllKeys()
					]);
					const rootRecordsPresent = rootKeys.length === 2 && rootKeys.every((key) => key === ROOT_WRAPPING_KEY || key === ENCRYPTED_ROOT_ENTROPY) && hasValidWrappingKey(rootWrappingKey) && isEncryptedRootEntropy(encryptedEntropy);
					if (rootRecordsPresent && playerKeys.includes(PLAYER_STATE)) {
						db.deleteObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
						db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
						transaction.objectStore(PLAYER_LIFECYCLE_STORE_NAME).put({ kind: 'legacy-player-reset', sourceVersion: 1 }, PLAYER_STATE);
					}
					return;
				}
				if (oldVersion >= 6 && hasRootStore !== hasPlayerStore) return;
				for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
				db.createObjectStore(ROOT_SECRET_STORE_NAME);
				db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
				db.createObjectStore(WORLD_WRITE_JOURNAL_STORE_NAME);
			}
			}).then((db) => {
				if (blocked) db.close();
				else resolve(db);
			}, reject);
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
		const entropy = new Uint8Array(await webCrypto().subtle.decrypt({ name: 'AES-GCM', iv: cryptoBytes(encryptedEntropy.iv) }, wrappingKey, cryptoBytes(encryptedEntropy.ciphertext)));
		if (entropy.length !== ROOT_ENTROPY_BYTES) throw new Error('Invalid root entropy.');
		return entropy;
	} catch {
		throw new Error('Root decrypt failed.');
	}
}

async function readRootAndPlayer(db: IDBPDatabase<LifecycleDatabase>): Promise<ReadStorage> {
	const hasRootStore = db.objectStoreNames.contains(ROOT_SECRET_STORE_NAME);
	const hasPlayerStore = db.objectStoreNames.contains(PLAYER_LIFECYCLE_STORE_NAME);
	if (hasRootStore !== hasPlayerStore) return { kind: 'corrupt', reason: 'partial-state' };
	if (!hasRootStore && !hasPlayerStore) return null;
	const stored = await readStoredRecords(db);
	const rootEmpty = stored.rootKeys.length === 0;
	const playerEmpty = stored.playerKeys.length === 0;
	if (rootEmpty && playerEmpty) return null;
	const validRootShape = stored.rootKeys.length === 2 && stored.rootKeys.every((key) => key === ROOT_WRAPPING_KEY || key === ENCRYPTED_ROOT_ENTROPY) && hasValidWrappingKey(stored.rootWrappingKey) && isEncryptedRootEntropy(stored.encryptedEntropy);
	if (validRootShape && !stored.playerKeys.includes(PLAYER_STATE)) return { kind: 'corrupt', reason: 'partial-state' };
	if (validRootShape && stored.playerKeys.length === 1 && stored.playerKeys[0] === PLAYER_STATE && isLegacyPlayerResetMarker(stored.player)) {
		try {
			return { kind: 'legacy-player-reset', entropy: await decryptRootEntropy(stored.rootWrappingKey, stored.encryptedEntropy) };
		} catch {
			return { kind: 'corrupt', reason: 'root-decrypt' };
		}
	}
	if (rootEmpty !== playerEmpty || !validRootShape || stored.playerKeys.length !== 1 || stored.playerKeys[0] !== PLAYER_STATE) return { kind: 'corrupt', reason: rootEmpty !== playerEmpty ? 'partial-state' : 'root-record' };
	if (!isValidPlayerLifecycle(stored.player)) return { kind: 'corrupt', reason: 'player-state' };
	try {
		return { entropy: await decryptRootEntropy(stored.rootWrappingKey, stored.encryptedEntropy), player: stored.player };
	} catch {
		return { kind: 'corrupt', reason: 'root-decrypt' };
	}
}

function deriveMaster(entropy: Uint8Array): HDKey {
	const mnemonic = entropyToMnemonic(entropy, englishWordlist);
	const seed = mnemonicToSeedSync(mnemonic, '');
	try { return HDKey.fromMasterSeed(seed); } finally { seed.fill(0); }
}

function candidateFromSecret(accountIndex: number, secret: Uint8Array): IdentityCandidate | null {
	try {
		const pubkey = getPublicKey(secret);
		const character = resolveCharacterFromPubkey(pubkey);
		return character ? { accountIndex, pubkey, characterId: character.characterId } : null;
	} catch { return null; }
}

function reusableIdentityCandidates(identities: readonly IdentityRecord[]): readonly ClearedIdentityCandidate[] {
	return identities.filter((identity) => identity.status === 'cleared').map((identity) => ({ generation: identity.generation, accountIndex: identity.accountIndex, pubkey: identity.pubkey, characterId: identity.characterId }));
}

async function preparePendingSelection(entropy: Uint8Array, generation: number, selectedCharacterIds: ReadonlySet<string>, reusableIdentities: readonly ClearedIdentityCandidate[] = []): Promise<PendingSelection> {
	assertBip85Index(generation, 'generation');
	if (CHARACTER_CATALOG.length - selectedCharacterIds.size < 3) throw new Error('Selection is unavailable.');
	const master = deriveMaster(entropy);
	const candidates: IdentityCandidate[] = [];
	try {
		for (let accountIndex = BIP85_INDEX_MIN; accountIndex <= Math.min(MAX_CANDIDATE_SCAN, BIP85_INDEX_MAX) && candidates.length < 3; accountIndex += 1) {
			let childEntropy: Uint8Array;
			try { childEntropy = await deriveBip85NostrEntropy(master, generation, accountIndex); } catch { continue; }
			const secret = childEntropy.slice();
			const candidate = candidateFromSecret(accountIndex, secret);
			childEntropy.fill(0);
			secret.fill(0);
			if (!candidate || selectedCharacterIds.has(candidate.characterId) || candidates.some((item) => item.characterId === candidate.characterId)) continue;
			candidates.push(candidate);
		}
	} finally { master.wipePrivateData(); }
	if (candidates.length !== 3) throw new Error('Selection is unavailable.');
	return { generation, candidates: [candidates[0], candidates[1], candidates[2]], reusableIdentities };
}

async function prepareRoot(): Promise<PreparedRoot> {
	const cryptoApi = webCrypto();
	const entropy = cryptoApi.getRandomValues(new Uint8Array(ROOT_ENTROPY_BYTES));
	try {
		const wrappingKey = await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: AES_KEY_LENGTH }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const iv = cryptoApi.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
		const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv: cryptoBytes(iv) }, wrappingKey, cryptoBytes(entropy)));
		return { entropy, wrappingKey, encryptedEntropy: { version: ROOT_RECORD_VERSION, iv, ciphertext } };
	} catch (error) { entropy.fill(0); throw error; }
}

function freshPlayer(selection: PendingSelection): PlayerLifecycle {
	return { schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: 0, identities: [], mode: { kind: 'selecting', pendingSelection: selection } };
}

async function commitFresh(db: IDBPDatabase<LifecycleDatabase>, root: PreparedRoot, player: PlayerLifecycle): Promise<boolean> {
	const tx = db.transaction([ROOT_SECRET_STORE_NAME, PLAYER_LIFECYCLE_STORE_NAME], 'readwrite');
	try {
		const rootStore = tx.objectStore(ROOT_SECRET_STORE_NAME);
		const playerStore = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
		if ((await rootStore.getAllKeys()).length !== 0 || (await playerStore.getAllKeys()).length !== 0) { await tx.done; return false; }
		await rootStore.put(root.wrappingKey, ROOT_WRAPPING_KEY);
		await rootStore.put(root.encryptedEntropy, ENCRYPTED_ROOT_ENTROPY);
		await playerStore.put(player, PLAYER_STATE);
		await tx.done;
		return true;
	} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}

async function deriveSignerFromMaster(master: HDKey, identity: IdentityRecord): Promise<ActiveSignerSnapshot> {
	const childEntropy = await deriveBip85NostrEntropy(master, identity.generation, identity.accountIndex);
	try {
		const secretKey = childEntropy.slice();
		const pubkey = getPublicKey(secretKey);
		if (pubkey !== identity.pubkey || requireCharacterFromPubkey(pubkey).characterId !== identity.characterId) { secretKey.fill(0); throw new Error('Derivation mismatch.'); }
		return { secretKey, pubkey, identityCreatedAtMs: identity.identityCreatedAtMs, characterProfileRevision: identity.characterProfileRevision, identity: { generation: identity.generation, accountIndex: identity.accountIndex, pubkey: identity.pubkey } };
	} finally { childEntropy.fill(0); }
}

async function validateIdentityDerivations(master: HDKey, identities: readonly IdentityRecord[]): Promise<void> {
	for (const identity of identities) {
		const signer = await deriveSignerFromMaster(master, identity);
		signer.secretKey.fill(0);
	}
}

function candidateMatches(first: IdentityCandidate, second: IdentityCandidate): boolean {
	return first.accountIndex === second.accountIndex && first.pubkey === second.pubkey && first.characterId === second.characterId;
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
				} finally { childEntropy.fill(0); }
			}
			for (const candidate of player.mode.pendingSelection.reusableIdentities) {
				const identity = player.identities.find((item) => item.generation === candidate.generation && item.accountIndex === candidate.accountIndex && item.pubkey === candidate.pubkey && item.status === 'cleared');
				if (!identity || identity.characterId !== candidate.characterId) return { kind: 'corrupt', reason: 'invalid-candidate' };
			}
			const expected: PendingSelection = { generation: player.mode.pendingSelection.generation, candidates: expectedCandidates as unknown as PendingSelection['candidates'], reusableIdentities: player.mode.pendingSelection.reusableIdentities };
		if (JSON.stringify(expected) !== JSON.stringify(player.mode.pendingSelection)) return { kind: 'corrupt', reason: 'invalid-candidate' };
		return { kind: 'selecting', selection: player.mode.pendingSelection, rootPoints: player.rootPoints };
		}
		const activeRun = player.mode.activeRun;
		const identity = player.identities.find((candidate) => candidate.generation === activeRun.identity.generation && candidate.accountIndex === activeRun.identity.accountIndex && candidate.pubkey === activeRun.identity.pubkey);
		if (!identity || identity.status !== 'alive') return { kind: 'corrupt', reason: 'identity-reference' };
		const signer = await deriveSignerFromMaster(master, identity);
		return { kind: 'restored', persona: { rootPoints: player.rootPoints, signer, identity, activeRun, gameState: activeRun.gameState } };
	} catch (error) {
		return { kind: 'corrupt', reason: error instanceof Error && error.message === 'Selection is unavailable.' ? 'selection-unavailable' : 'derivation-mismatch' };
	} finally { master?.wipePrivateData(); entropy.fill(0); }
}

async function withLifecycle<T>(callback: (db: IDBPDatabase<LifecycleDatabase>) => Promise<T>): Promise<T> {
	const db = await openLifecycleDatabase();
	try { return await callback(db); } catch (error) { if (error instanceof Error && error.message === 'Account operation failed.') throw error; throw new Error('Account operation failed.'); } finally { db.close(); }
}

async function replaceLegacyPlayer(db: IDBPDatabase<LifecycleDatabase>, selection: PendingSelection): Promise<boolean> {
	const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
	try {
		const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
		const current = await store.get(PLAYER_STATE);
		if (!isLegacyPlayerResetMarker(current)) { await tx.done; return false; }
		await store.put(freshPlayer(selection), PLAYER_STATE);
		await tx.done;
		return true;
	} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
}

export async function loadOrCreateLifecycle(): Promise<LoadLifecycleResult> {
	for (;;) {
		const observed = await withLifecycle((db) => readRootAndPlayer(db));
		if (observed === null) {
			const root = await prepareRoot();
			try {
				const selection = await preparePendingSelection(root.entropy, 1, new Set());
				const committed = await withLifecycle((db) => commitFresh(db, root, freshPlayer(selection)));
				if (committed) return { kind: 'created', selection, rootPoints: 0 };
			} finally { root.entropy.fill(0); }
			continue;
		}
		if (isCorruptLifecycle(observed)) return observed;
		if ('kind' in observed && observed.kind === 'legacy-player-reset') {
			try {
				const selection = await preparePendingSelection(observed.entropy, 1, new Set());
				const replaced = await withLifecycle((db) => replaceLegacyPlayer(db, selection));
				if (replaced) return { kind: 'selecting', selection, rootPoints: 0 };
			} finally { observed.entropy.fill(0); }
			continue;
		}
		return hydrateLifecycle(observed.entropy, observed.player);
	}
}

export async function authorizeActiveRun(expected: ActiveRunAuthorization): Promise<SelfWriteAuthorizationResult> {
	if (!isValidIdentityReference(expected.identity) || !Number.isSafeInteger(expected.runNumber) || expected.runNumber < 1) return 'corrupt';
	return withLifecycle(async (db) => {
		const stored = await readStoredRecords(db);
		if (stored.rootKeys.length !== 2 || stored.playerKeys.length !== 1 || stored.playerKeys[0] !== PLAYER_STATE || !hasValidWrappingKey(stored.rootWrappingKey) || !isEncryptedRootEntropy(stored.encryptedEntropy) || !isValidPlayerLifecycle(stored.player)) return 'corrupt';
		if (stored.player.mode.kind !== 'running') return 'superseded';
		const activeRun = stored.player.mode.activeRun;
		return sameIdentityReference(activeRun.identity, expected.identity) && activeRun.runNumber === expected.runNumber ? 'authorized' : 'superseded';
	});
}

type WorldWriteJournalRecord = Readonly<{
	version: 1;
	channelId: string;
	pubkey: string;
	runNumber: number;
	lastReservedSecond: number | null;
	consumedSlots: 0 | 1 | 2;
	lastPositiveSecond: number | null;
	exitSecond: number | null;
	nextToken: number;
	confirmedPosition: VerifiedEvent | null;
	messageDedupeIds?: readonly string[];
}>;

function journalKey(channelId: string, pubkey: string): string {
	return `${channelId}\u0000${pubkey}`;
}

function validJournal(value: unknown, channelId: string, pubkey: string): value is WorldWriteJournalRecord {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const second = (item: unknown) => item === null || Number.isSafeInteger(item) && (item as number) >= 0;
	return record.version === 1 && record.channelId === channelId && record.pubkey === pubkey &&
		Number.isSafeInteger(record.runNumber) && (record.runNumber as number) > 0 &&
		second(record.lastReservedSecond) && second(record.lastPositiveSecond) && second(record.exitSecond) &&
		(record.consumedSlots === 0 || record.consumedSlots === 1 || record.consumedSlots === 2) &&
		Number.isSafeInteger(record.nextToken) && (record.nextToken as number) >= 0 &&
		(record.messageDedupeIds === undefined || Array.isArray(record.messageDedupeIds) && record.messageDedupeIds.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) && new Set(record.messageDedupeIds).size === record.messageDedupeIds.length) &&
		(record.confirmedPosition === null || typeof record.confirmedPosition === 'object' && !Array.isArray(record.confirmedPosition));
}

function emptyJournal(scope: WorldWriteJournalScope): WorldWriteJournalRecord {
	return { version: 1, channelId: scope.channelId, pubkey: scope.identity.pubkey, runNumber: scope.runNumber,
		lastReservedSecond: null, consumedSlots: 0, lastPositiveSecond: null, exitSecond: null,
		nextToken: 0, confirmedPosition: null, messageDedupeIds: [] };
}

function journalScopeIsActive(player: unknown, scope: WorldWriteJournalScope): player is PlayerLifecycle {
	return isValidPlayerLifecycle(player) && player.mode.kind === 'running' &&
		sameIdentityReference(player.mode.activeRun.identity, scope.identity) && player.mode.activeRun.runNumber === scope.runNumber;
}

export async function loadWorldWriteJournal(scope: WorldWriteJournalScope): Promise<WorldWriteJournalSnapshot | null> {
	return withLifecycle(async (db) => {
		const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readonly');
		const player = await tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME).get(PLAYER_STATE);
		const raw = await tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME).get(journalKey(scope.channelId, scope.identity.pubkey));
		await tx.done;
		if (!journalScopeIsActive(player, scope)) throw new Error('Account operation failed.');
		if (raw === undefined) return null;
		if (!validJournal(raw, scope.channelId, scope.identity.pubkey)) throw new Error('Account operation failed.');
		return { lastReservedSecond: raw.lastReservedSecond, consumedSlots: raw.consumedSlots,
			lastPositiveSecond: raw.lastPositiveSecond, exitSecond: raw.exitSecond,
			confirmedPosition: raw.runNumber === scope.runNumber ? raw.confirmedPosition : null };
	});
}

/** The Player check and timestamp/slot consumption share one cross-tab transaction. */
export async function reserveWorldPositive(input: Readonly<{
	scope: WorldWriteJournalScope;
	kind: 'position' | 'message';
	nowSecond: number;
	observedSecond: number | null;
	observedConsumedSlots: 0 | 1 | 2;
	observedExitSecond: number | null;
	freshAfterSecond?: number;
	messageDedupeId?: string;
}>): Promise<WorldWriteReservationResult> {
	const { scope } = input;
	if (!Number.isSafeInteger(input.nowSecond) || input.nowSecond < 0 || input.messageDedupeId !== undefined &&
		(input.kind !== 'message' || !/^[0-9a-f]{64}$/.test(input.messageDedupeId))) return { kind: 'corrupt' };
	return withLifecycle(async (db) => {
		const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
		try {
			const player = await tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME).get(PLAYER_STATE);
			if (!journalScopeIsActive(player, scope)) { await tx.done; return { kind: 'stale' } as const; }
			const store = tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME);
			const key = journalKey(scope.channelId, scope.identity.pubkey);
			const raw = await store.get(key);
			if (raw !== undefined && !validJournal(raw, scope.channelId, scope.identity.pubkey)) { await tx.done; return { kind: 'corrupt' } as const; }
			const record = (raw ?? emptyJournal(scope)) as WorldWriteJournalRecord;
			const messageDedupeIds = record.runNumber === scope.runNumber ? record.messageDedupeIds ?? [] : [];
			if (input.messageDedupeId && messageDedupeIds.includes(input.messageDedupeId)) { await tx.done; return { kind: 'duplicate' } as const; }
			if (input.observedSecond !== null && input.observedSecond > input.nowSecond ||
				record.runNumber === scope.runNumber && ((record.lastPositiveSecond ?? -1) > input.nowSecond ||
					(record.lastReservedSecond ?? -1) > input.nowSecond)) {
				await tx.done; return { kind: 'clock-regressed' } as const;
			}
			const exitSecond = Math.max(record.exitSecond ?? -1, input.observedExitSecond ?? -1);
			const positiveSecond = Math.max(record.lastPositiveSecond ?? -1, input.observedSecond ?? -1);
			let untilSecond = Math.max(exitSecond + 1, positiveSecond, (input.freshAfterSecond ?? -1) + 1);
			if (record.runNumber !== scope.runNumber) untilSecond = Math.max(untilSecond, positiveSecond + 1);
			if (input.kind === 'position') {
				const lastSecond = Math.max(record.lastReservedSecond ?? -1, input.observedSecond ?? -1);
				const consumed = lastSecond === record.lastReservedSecond && lastSecond === input.observedSecond
					? Math.max(record.consumedSlots, input.observedConsumedSlots)
					: lastSecond === record.lastReservedSecond ? record.consumedSlots : input.observedConsumedSlots;
				if (consumed === 2) untilSecond = Math.max(untilSecond, lastSecond + 1);
			}
			if (input.nowSecond < untilSecond) { await tx.done; return { kind: 'wait', untilSecond } as const; }
			const createdAt = input.nowSecond;
			const priorSecond = Math.max(record.lastReservedSecond ?? -1, input.observedSecond ?? -1);
			const priorConsumed = priorSecond === record.lastReservedSecond && priorSecond === input.observedSecond
				? Math.max(record.consumedSlots, input.observedConsumedSlots)
				: priorSecond === record.lastReservedSecond ? record.consumedSlots : input.observedConsumedSlots;
			const slot = input.kind === 'position' ? (createdAt === priorSecond && priorConsumed === 1 ? 1 : 0) : null;
			const token = record.nextToken + 1;
			if (!Number.isSafeInteger(token)) { await tx.done; return { kind: 'corrupt' } as const; }
			await store.put({ ...record, runNumber: scope.runNumber, nextToken: token,
				lastReservedSecond: slot === null ? record.lastReservedSecond : createdAt,
				consumedSlots: slot === null ? record.consumedSlots : slot === 0 ? 1 : 2,
				lastPositiveSecond: Math.max(record.lastPositiveSecond ?? -1, createdAt), exitSecond: exitSecond < 0 ? null : exitSecond,
				confirmedPosition: record.runNumber === scope.runNumber ? record.confirmedPosition : null,
				messageDedupeIds: input.messageDedupeId ? [...messageDedupeIds, input.messageDedupeId] : messageDedupeIds }, key);
			await tx.done;
			return { kind: 'reserved', reservation: { token, createdAt, slot } } as const;
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

export async function confirmWorldPosition(scope: WorldWriteJournalScope, reservation: WorldWriteReservation, event: VerifiedEvent): Promise<boolean> {
	return withLifecycle(async (db) => {
		const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
		try {
			const player = await tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME).get(PLAYER_STATE);
			const store = tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME);
			const key = journalKey(scope.channelId, scope.identity.pubkey);
			const raw = await store.get(key);
			if (!journalScopeIsActive(player, scope) || !validJournal(raw, scope.channelId, scope.identity.pubkey) ||
				raw.runNumber !== scope.runNumber || reservation.token > raw.nextToken || event.pubkey !== scope.identity.pubkey) {
				await tx.done; return false;
			}
			const previous = raw.confirmedPosition;
			const previousSlot = previous?.tags.find((tag) => tag[0] === 'd')?.[1]?.endsWith(':1') ? 1 : 0;
			const nextSlot = reservation.slot ?? 0;
			if (!previous || event.created_at > previous.created_at || event.created_at === previous.created_at && nextSlot >= previousSlot) {
				await store.put({ ...raw, confirmedPosition: event }, key);
			}
			await tx.done;
			return true;
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

function emptyRealtimeLedger(activeRun: ActiveRun): RealtimeSettlementLedger {
	return { schemaVersion: 1, identity: activeRun.identity, runNumber: activeRun.runNumber, pendingInstanceIds: [], appliedOutcomeIds: [] };
}

function scopedRealtimeLedger(player: PlayerLifecycle, activeRun: ActiveRun): RealtimeSettlementLedger {
	const ledger = player.realtimeSettlementLedger;
	return ledger && sameIdentityReference(ledger.identity, activeRun.identity) && ledger.runNumber === activeRun.runNumber ? ledger : emptyRealtimeLedger(activeRun);
}

function isValidSelectionCandidate(value: SelectionCandidate): boolean {
	return isValidCandidate(value) && (!('generation' in value) || isPositiveIndex(value.generation));
}

export async function selectIdentity(expectedGeneration: number, candidate: SelectionCandidate, rootBuild: RootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 }, options: SelectIdentityOptions = {}): Promise<SelectionResult> {
	assertBip85Index(expectedGeneration, 'generation');
	if (!isValidSelectionCandidate(candidate)) return { kind: 'corrupt', reason: 'invalid-candidate' };
	if (options.initialPoints !== undefined && (!Number.isSafeInteger(options.initialPoints) || options.initialPoints < 0)) throw new TypeError('Invalid initial points.');
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
			if (current.mode.kind !== 'selecting' || current.mode.pendingSelection.generation !== expectedGeneration) {
				await tx.done;
				const lifecycle = await restoreCurrent(db);
				return isCorruptLifecycle(lifecycle) ? lifecycle : { kind: 'superseded', lifecycle };
			}
			const pending = current.mode.pendingSelection;
			const reusable = 'generation' in candidate ? pending.reusableIdentities.some((item) => item.generation === candidate.generation && candidateMatches(item, candidate)) : false;
			const fresh = pending.candidates.some((item) => candidateMatches(item, candidate));
			if ((!reusable && !fresh) || !isRootBuildAllocatable(rootBuild, current.rootPoints)) { await tx.done; return { kind: 'blocked', reason: reusable || fresh ? 'root-build' : 'candidate' }; }
			const persistedRootBuild: RootBuild = { inferenceAcceleration: rootBuild.inferenceAcceleration, contextCompression: rootBuild.contextCompression, hallucinationResistance: rootBuild.hallucinationResistance };
			const nowMs = Date.now();
			if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
			let selected: IdentityRecord;
			let identities = current.identities;
			let runNumber = 1;
			if (reusable) {
				const existing = current.identities.find((item) => item.generation === (candidate as ClearedIdentityCandidate).generation && item.accountIndex === candidate.accountIndex && item.pubkey === candidate.pubkey && item.status === 'cleared');
				if (!existing) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
				runNumber = existing.runHistory.length + 1;
				selected = { ...existing, status: 'alive' };
				identities = current.identities.map((item) => item === existing ? selected : item);
			} else {
				selected = { generation: expectedGeneration, accountIndex: candidate.accountIndex, pubkey: candidate.pubkey, characterId: candidate.characterId, identityCreatedAtMs: nowMs, status: 'alive', characterProfileRevision: null, runHistory: [] };
				identities = [...current.identities, selected];
			}
			const identityReference: IdentityReference = { generation: selected.generation, accountIndex: selected.accountIndex, pubkey: selected.pubkey };
			const initialGameState = createInitialPersonaGameState(selected.pubkey, nowMs, options.initialLifespanMs);
			const activeRun: ActiveRun = { runNumber, revision: 0, startedAtMs: nowMs, identity: identityReference, rootBuild: persistedRootBuild, gameState: { ...initialGameState, points: options.initialPoints ?? initialGameState.points } };
			const next: PlayerLifecycle = { schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: current.rootPoints, identities, mode: { kind: 'running', activeRun }, realtimeSettlementLedger: emptyRealtimeLedger(activeRun) };
			await store.put(next, PLAYER_STATE);
			await tx.done;
			const loaded = await loadOrCreateLifecycle();
			return loaded.kind === 'restored' ? { kind: 'selected', persona: loaded.persona } : isCorruptLifecycle(loaded) ? loaded : { kind: 'corrupt', reason: 'identity-reference' };
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

async function restoreCurrent(db: IDBPDatabase<LifecycleDatabase>): Promise<LoadLifecycleResult> {
	const observed = await readRootAndPlayer(db);
	if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return { kind: 'corrupt', reason: 'partial-state' };
	return hydrateLifecycle(observed.entropy, observed.player);
}

async function mutateMending(expected: PersonaSnapshot, operation: 'start' | 'collect'): Promise<MendingMutationResult> {
	const testHook = (globalThis as typeof globalThis & { __personaBubbleFieldTestHooks?: { beforeMendingMutation?: (operation: 'start' | 'collect') => void | Promise<void> } }).__personaBubbleFieldTestHooks?.beforeMendingMutation;
	if (testHook) await testHook(operation);
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
		if (isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
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
				if (current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) { await tx.done; const latest = await restoreCurrent(db); return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest }; }
				const activeRun = current.mode.activeRun;
				const nowMs = Date.now();
				if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
				if (isPersonaExpired(activeRun.gameState, nowMs, activeRun.rootBuild)) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				let gameState = activeRun.gameState;
				let kind: MendingMutationResult['kind'];
				if (operation === 'start') {
					if (gameState.mendingJob) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
					gameState = { ...gameState, mendingJob: createMendingJob(nowMs) };
					kind = 'started';
				} else {
					if (!gameState.mendingJob) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
					const settlement = settleMending(gameState, nowMs, activeRun.rootBuild, true);
					if (!settlement) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
					gameState = { ...gameState, ...settlement };
					kind = 'collected';
				}
				const nextRun: ActiveRun = { ...activeRun, revision: activeRun.revision + 1, gameState };
				await store.put({ ...current, mode: { kind: 'running', activeRun: nextRun } }, PLAYER_STATE);
				await tx.done;
				const latest = await loadOrCreateLifecycle();
				return latest.kind === 'restored' ? { kind, persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
		} finally { observed.entropy.fill(0); }
	});
}

export function startMending(expected: PersonaSnapshot): Promise<MendingMutationResult> { return mutateMending(expected, 'start'); }
export function collectMending(expected: PersonaSnapshot): Promise<MendingMutationResult> { return mutateMending(expected, 'collect'); }

async function mutateAbilityUpgrade(expected: PersonaSnapshot, key: PersonaAbilityKey): Promise<AbilityUpgradeResult> {
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed) return { kind: 'corrupt', reason: 'partial-state' };
		if (isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
		try {
			if (observed.player.mode.kind !== 'running' || !samePersonaExpected(expected, observed.player.mode.activeRun)) { const latest = await hydrateLifecycle(observed.entropy, observed.player); return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest }; }
			const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
				if (current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) { await tx.done; const latest = await restoreCurrent(db); return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest }; }
				const activeRun = current.mode.activeRun;
				const nowMs = Date.now();
				if (isPersonaExpired(activeRun.gameState, nowMs, activeRun.rootBuild)) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				const settlement = activeRun.gameState.mendingJob ? settleMending(activeRun.gameState, nowMs, activeRun.rootBuild, false) : null;
				const settled = settlement ? { ...activeRun.gameState, ...settlement } : activeRun.gameState;
				const nextGameState = upgradeAbility(settled, key);
				if (!nextGameState) { await tx.done; const latest = await hydrateLifecycle(observed.entropy, current); return latest.kind === 'restored' ? { kind: 'blocked', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' }; }
				await store.put({ ...current, mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1, gameState: nextGameState } } }, PLAYER_STATE);
				await tx.done;
				const latest = await loadOrCreateLifecycle();
				return latest.kind === 'restored' ? { kind: 'upgraded', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
			} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
		} finally { observed.entropy.fill(0); }
	});
}

export function upgradePersonaAbility(expected: PersonaSnapshot, key: PersonaAbilityKey): Promise<AbilityUpgradeResult> { return mutateAbilityUpgrade(expected, key); }

function sameRealtimeRunScope(expected: PersonaSnapshot, activeRun: ActiveRun): boolean {
	return sameIdentityReference(expected.activeRun.identity, activeRun.identity) && expected.activeRun.runNumber === activeRun.runNumber;
}

function validRealtimeOutcome(outcome: RealtimeOutcome): boolean {
	return typeof outcome.id === 'string' && outcome.id.length > 0 && outcome.id.length <= 240 && typeof outcome.instanceId === 'string' && outcome.instanceId.length > 0 && outcome.instanceId.length <= 160 &&
		(outcome.kind === 'death' || (outcome.kind === 'points' && Number.isSafeInteger(outcome.points) && (outcome.points as number) > 0) ||
			(outcome.kind === 'lifespan-loss' && Number.isSafeInteger(outcome.lifespanLossMs) && (outcome.lifespanLossMs as number) > 0));
}

export async function trackRealtimeEventInstance(expected: PersonaSnapshot, instanceId: string): Promise<boolean> {
	if (!instanceId || instanceId.length > 160) return false;
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return false; }
			const ledger = scopedRealtimeLedger(current, current.mode.activeRun);
			if (!ledger.pendingInstanceIds.includes(instanceId)) await store.put({ ...current, realtimeSettlementLedger: { ...ledger, pendingInstanceIds: [...ledger.pendingInstanceIds, instanceId] } }, PLAYER_STATE);
			await tx.done;
			return true;
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

export async function completeRealtimeEventInstance(expected: PersonaSnapshot, instanceId: string): Promise<boolean> {
	if (!instanceId || instanceId.length > 160) return false;
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return false; }
			const ledger = scopedRealtimeLedger(current, current.mode.activeRun);
			await store.put({ ...current, realtimeSettlementLedger: { ...ledger, pendingInstanceIds: ledger.pendingInstanceIds.filter((candidate) => candidate !== instanceId) } }, PLAYER_STATE);
			await tx.done;
			return true;
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

export async function getRealtimeSettlementLedger(expected: PersonaSnapshot): Promise<RealtimeSettlementLedger | null> {
	return withLifecycle(async (db) => {
		const stored = await readStoredRecords(db);
		return isValidPlayerLifecycle(stored.player) && stored.player.mode.kind === 'running' && sameRealtimeRunScope(expected, stored.player.mode.activeRun) ? scopedRealtimeLedger(stored.player, stored.player.mode.activeRun) : null;
	});
}

export async function applyRealtimeOutcome(expected: PersonaSnapshot, outcome: RealtimeOutcome): Promise<RealtimeSettlementResult> {
	if (!validRealtimeOutcome(outcome) || outcome.kind !== 'points') return { kind: 'corrupt', reason: 'player-state' };
	return withLifecycle(async (db) => {
		const tx = db.transaction(PLAYER_LIFECYCLE_STORE_NAME, 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return { kind: 'stale' }; }
			const activeRun = current.mode.activeRun;
			const ledger = scopedRealtimeLedger(current, activeRun);
			if (ledger.appliedOutcomeIds.includes(outcome.id)) { await tx.done; const latest = await loadOrCreateLifecycle(); return latest.kind === 'restored' ? { kind: 'duplicate', persona: latest.persona } : { kind: 'stale' }; }
			if (isPersonaExpired(activeRun.gameState, Date.now(), activeRun.rootBuild)) {
				await store.put({ ...current, realtimeSettlementLedger: { ...ledger, appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id] } }, PLAYER_STATE);
				await tx.done;
				const latest = await loadOrCreateLifecycle();
				return latest.kind === 'restored' ? { kind: 'expired', persona: latest.persona } : { kind: 'stale' };
			}
			if (activeRun.gameState.points > Number.MAX_SAFE_INTEGER - (outcome.points as number)) { await tx.done; return { kind: 'stale' }; }
			const nextGameState = { ...activeRun.gameState, points: activeRun.gameState.points + (outcome.points as number) };
			await store.put({ ...current, mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1, gameState: nextGameState } }, realtimeSettlementLedger: { ...ledger, appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id] } }, PLAYER_STATE);
			await tx.done;
			const latest = await loadOrCreateLifecycle();
			return latest.kind === 'restored' ? { kind: 'applied', persona: latest.persona } : { kind: 'stale' };
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

/** Applies a lifespan penalty and its receipt atomically, closing the Run if the effective expiry is reached. */
export async function applyRealtimeLifespanLoss(
	expected: PersonaSnapshot,
	outcome: RealtimeOutcome,
	prepareTerminalExit?: () => TerminalExitJournalRequest | undefined
): Promise<RealtimeLifespanLossResult> {
	if (!validRealtimeOutcome(outcome) || outcome.kind !== 'lifespan-loss') return { kind: 'corrupt', reason: 'player-state' };
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) {
		return !observed ? { kind: 'corrupt', reason: 'partial-state' } : isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
	}
	try {
		const testHook = (globalThis as typeof globalThis & { __personaBubbleFieldTestHooks?: { beforeRealtimeLifespanLossMutation?: () => void | Promise<void> } }).__personaBubbleFieldTestHooks?.beforeRealtimeLifespanLossMutation;
		if (testHook) await testHook();
		const currentPersonaForSameRun = async (): Promise<PersonaSnapshot | null> => {
			const latest = await loadOrCreateLifecycle();
			return latest.kind === 'restored' && sameRealtimeRunScope(expected, latest.persona.activeRun) ? latest.persona : null;
		};
		if (observed.player.mode.kind !== 'running' || !sameRealtimeRunScope(expected, observed.player.mode.activeRun)) return { kind: 'stale' };
		if (scopedRealtimeLedger(observed.player, observed.player.mode.activeRun).appliedOutcomeIds.includes(outcome.id)) {
			const persona = await currentPersonaForSameRun();
			return persona ? { kind: 'duplicate', persona } : { kind: 'stale' };
		}
		if (!samePersonaExpected(expected, observed.player.mode.activeRun)) return { kind: 'stale' };
		const selection = await prepareDeathSelection(observed.entropy, observed.player);
		const mutation = await withLifecycle(async (db): Promise<RealtimeLifespanLossResult | Readonly<{ kind: 'duplicate' }>> => {
			const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current)) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
				if (current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return { kind: 'stale' }; }
				const activeRun = current.mode.activeRun;
				const previousLedger = current.realtimeSettlementLedger;
				if (previousLedger && sameIdentityReference(previousLedger.identity, expected.activeRun.identity) &&
					previousLedger.runNumber === expected.activeRun.runNumber && previousLedger.appliedOutcomeIds.includes(outcome.id)) {
					await tx.done;
					return { kind: 'duplicate' };
				}
				if (!samePersonaExpected(expected, activeRun)) { await tx.done; return { kind: 'stale' }; }
				const ledger = scopedRealtimeLedger(current, activeRun);
				const nowMs = Date.now();
				if (!isSafeTimestamp(nowMs)) throw new Error('Invalid lifecycle timestamp.');
				const effectiveExpiry = projectMending(activeRun.gameState, nowMs, activeRun.rootBuild).effectiveExpiresAtMs;
				const reducedExpiry = effectiveExpiry - (outcome.lifespanLossMs as number);
				if (!Number.isSafeInteger(reducedExpiry)) throw new Error('Invalid realtime lifespan result.');
				const receipt = { ...ledger, appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcome.id] };
				if (nowMs >= reducedExpiry) {
					const identity = current.identities.find((item) => sameIdentityReference(item, activeRun.identity));
					if (!identity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
					const closedIdentity: IdentityRecord = {
						...identity,
						status: 'dead',
						runHistory: [...identity.runHistory, { runNumber: activeRun.runNumber, startedAtMs: activeRun.startedAtMs, endedAtMs: nowMs, outcome: 'dead' }]
					};
					const exitRequest = prepareTerminalExit?.();
					const exit = await commitTerminalFence(tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME), activeRun, exitRequest);
					await store.put({ schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: current.rootPoints,
						identities: current.identities.map((item) => item === identity ? closedIdentity : item),
						mode: { kind: 'selecting', pendingSelection: selection },
						realtimeSettlementLedger: { ...receipt, pendingInstanceIds: [] } }, PLAYER_STATE);
					await tx.done;
					return { kind: 'transitioned', ...(exit ? { exit } : {}) };
				}
				const checkpoint = activeRun.gameState.mendingJob
					? settleMending(activeRun.gameState, nowMs, activeRun.rootBuild, false)
					: null;
				const gameState: PersonaGameState = {
					...activeRun.gameState,
					...(checkpoint ?? {}),
					lifespanExpiresAtMs: reducedExpiry
				};
				await store.put({ ...current,
					mode: { kind: 'running', activeRun: { ...activeRun, revision: activeRun.revision + 1, gameState } },
					realtimeSettlementLedger: receipt }, PLAYER_STATE);
				await tx.done;
				return { kind: 'survived', persona: expected };
			} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
		});
		if (mutation.kind === 'duplicate') {
			const persona = await currentPersonaForSameRun();
			return persona ? { kind: 'duplicate', persona } : { kind: 'stale' };
		}
		if (mutation.kind !== 'survived') return mutation;
		const latest = await loadOrCreateLifecycle();
		return latest.kind === 'restored' ? { kind: 'survived', persona: latest.persona } : { kind: 'corrupt', reason: 'identity-reference' };
	} finally { observed.entropy.fill(0); }
}

async function prepareDeathSelection(entropy: Uint8Array, player: PlayerLifecycle): Promise<PendingSelection> {
	const generation = Math.max(...player.identities.map((identity) => identity.generation), 0) + 1;
	return preparePendingSelection(entropy, generation, new Set(player.identities.map((identity) => identity.characterId)));
}

async function prepareClearSelection(entropy: Uint8Array, player: PlayerLifecycle): Promise<PendingSelection> {
	const generation = Math.max(...player.identities.map((identity) => identity.generation), 0) + 1;
	return preparePendingSelection(entropy, generation, new Set(player.identities.map((identity) => identity.characterId)), reusableIdentityCandidates(player.identities));
}

async function commitTerminalFence(
	store: { get(key: string): Promise<unknown>; put(value: unknown, key: string): Promise<unknown> },
	activeRun: ActiveRun,
	request: TerminalExitJournalRequest | undefined
): Promise<CommittedTerminalExit | undefined> {
	if (!request) return undefined;
	if (!Number.isSafeInteger(request.lastPositiveCreatedAt) || request.lastPositiveCreatedAt < 0) throw new Error('Invalid terminal exit timestamp.');
	const scope = { identity: activeRun.identity, runNumber: activeRun.runNumber, channelId: request.channelId };
	const key = journalKey(request.channelId, activeRun.identity.pubkey);
	const raw = await store.get(key);
	if (raw !== undefined && !validJournal(raw, request.channelId, activeRun.identity.pubkey)) throw new Error('Invalid world write journal.');
	const record = (raw ?? emptyJournal(scope)) as WorldWriteJournalRecord;
	const createdAt = Math.max(Math.floor(Date.now() / 1000), request.lastPositiveCreatedAt,
		record.lastPositiveSecond ?? 0, record.exitSecond ?? 0);
	await store.put({ ...record, runNumber: activeRun.runNumber, exitSecond: createdAt }, key);
	return { createdAt, position: { ...request.position } };
}

export async function transitionRealtimeDeath(expected: PersonaSnapshot, outcome: RealtimeOutcome, terminalExit?: TerminalExitJournalRequest): Promise<RealtimeDeathResult> {
	if (!validRealtimeOutcome(outcome) || outcome.kind !== 'death') return { kind: 'corrupt', reason: 'player-state' };
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return !observed ? { kind: 'corrupt', reason: 'partial-state' } : isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
	try {
		if (observed.player.mode.kind !== 'running' || !sameRealtimeRunScope(expected, observed.player.mode.activeRun)) return { kind: 'stale' };
		const ledger = scopedRealtimeLedger(observed.player, observed.player.mode.activeRun);
		if (ledger.appliedOutcomeIds.includes(outcome.id)) return { kind: 'duplicate' };
		const selection = await prepareDeathSelection(observed.entropy, observed.player);
		return closeRunAsDeath(expected, outcome.id, selection, terminalExit);
	} finally { observed.entropy.fill(0); }
}

async function closeRunAsDeath(expected: PersonaSnapshot, outcomeId: string, selection: PendingSelection, terminalExit?: TerminalExitJournalRequest): Promise<RealtimeDeathResult> {
	return withLifecycle(async (db) => {
		const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
		try {
			const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
			const current = await store.get(PLAYER_STATE);
			if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !sameRealtimeRunScope(expected, current.mode.activeRun)) { await tx.done; return { kind: 'stale' }; }
			const activeRun = current.mode.activeRun;
			const ledger = scopedRealtimeLedger(current, activeRun);
			if (ledger.appliedOutcomeIds.includes(outcomeId)) { await tx.done; return { kind: 'duplicate' }; }
			const identity = current.identities.find((item) => sameIdentityReference(item, activeRun.identity));
			if (!identity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
			const nowMs = Date.now();
			const closedIdentity: IdentityRecord = { ...identity, status: 'dead', runHistory: [...identity.runHistory, { runNumber: activeRun.runNumber, startedAtMs: activeRun.startedAtMs, endedAtMs: nowMs, outcome: 'dead' }] };
			const exit = await commitTerminalFence(tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME), activeRun, terminalExit);
			await store.put({ schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: current.rootPoints, identities: current.identities.map((item) => item === identity ? closedIdentity : item), mode: { kind: 'selecting', pendingSelection: selection }, realtimeSettlementLedger: { ...ledger, pendingInstanceIds: [], appliedOutcomeIds: [...ledger.appliedOutcomeIds, outcomeId] } }, PLAYER_STATE);
			await tx.done;
			return { kind: 'transitioned', ...(exit ? { exit } : {}) };
		} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
	});
}

export async function transitionExpiredPersona(expected: PersonaSnapshot, terminalExit?: TerminalExitJournalRequest): Promise<DeathTransitionResult> {
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return !observed ? { kind: 'corrupt', reason: 'partial-state' } : isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
	try {
		if (observed.player.mode.kind !== 'running' || !samePersonaExpected(expected, observed.player.mode.activeRun)) return { kind: 'superseded' };
		if (!isPersonaExpired(observed.player.mode.activeRun.gameState, Date.now(), observed.player.mode.activeRun.rootBuild)) return { kind: 'not-expired', persona: { ...expected, activeRun: observed.player.mode.activeRun, gameState: observed.player.mode.activeRun.gameState } };
		const selection = await prepareDeathSelection(observed.entropy, observed.player);
		return withLifecycle(async (db) => {
			const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) { await tx.done; return { kind: 'superseded' }; }
				if (!isPersonaExpired(current.mode.activeRun.gameState, Date.now(), current.mode.activeRun.rootBuild)) { await tx.done; return { kind: 'not-expired', persona: expected }; }
				const activeRun = current.mode.activeRun;
				const currentIdentity = current.identities.find((item) => sameIdentityReference(item, activeRun.identity));
				if (!currentIdentity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
				const nowMs = Date.now();
				const closedIdentity: IdentityRecord = { ...currentIdentity, status: 'dead', runHistory: [...currentIdentity.runHistory, { runNumber: activeRun.runNumber, startedAtMs: activeRun.startedAtMs, endedAtMs: nowMs, outcome: 'dead' }] };
				const exit = await commitTerminalFence(tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME), activeRun, terminalExit);
				await store.put({ schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: current.rootPoints, identities: current.identities.map((item) => item === currentIdentity ? closedIdentity : item), mode: { kind: 'selecting', pendingSelection: selection }, realtimeSettlementLedger: current.realtimeSettlementLedger ? { ...current.realtimeSettlementLedger, pendingInstanceIds: [] } : undefined }, PLAYER_STATE);
				await tx.done;
				return { kind: 'transitioned', ...(exit ? { exit } : {}) };
			} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
		});
	} finally { observed.entropy.fill(0); }
}

export async function clearPersona(expected: PersonaSnapshot, terminalExit?: TerminalExitJournalRequest): Promise<ClearResult> {
	const observed = await withLifecycle((db) => readRootAndPlayer(db));
	if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) return !observed ? { kind: 'corrupt', reason: 'partial-state' } : isCorruptLifecycle(observed) ? observed : { kind: 'corrupt', reason: 'partial-state' };
	try {
		if (observed.player.mode.kind !== 'running' || !samePersonaExpected(expected, observed.player.mode.activeRun)) { const latest = await hydrateLifecycle(observed.entropy, observed.player); return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest }; }
		const activeRun = observed.player.mode.activeRun;
		const ledger = scopedRealtimeLedger(observed.player, activeRun);
		if (activeRun.gameState.points < NORMAL_CLEAR_THRESHOLD) return { kind: 'blocked', reason: 'points' };
		if (isPersonaExpired(activeRun.gameState, Date.now(), activeRun.rootBuild)) return { kind: 'blocked', reason: 'expired' };
		if (ledger.pendingInstanceIds.length > 0) return { kind: 'blocked', reason: 'pending-realtime' };
		const selection = await prepareClearSelection(observed.entropy, observed.player);
		return withLifecycle(async (db) => {
			const tx = db.transaction([PLAYER_LIFECYCLE_STORE_NAME, WORLD_WRITE_JOURNAL_STORE_NAME], 'readwrite');
			try {
				const store = tx.objectStore(PLAYER_LIFECYCLE_STORE_NAME);
				const current = await store.get(PLAYER_STATE);
				if (!isValidPlayerLifecycle(current) || current.mode.kind !== 'running' || !samePersonaExpected(expected, current.mode.activeRun)) { await tx.done; const latest = await restoreCurrent(db); return isCorruptLifecycle(latest) ? latest : { kind: 'superseded', lifecycle: latest }; }
				const currentRun = current.mode.activeRun;
				const currentLedger = scopedRealtimeLedger(current, currentRun);
				if (currentRun.gameState.points < NORMAL_CLEAR_THRESHOLD) { await tx.done; return { kind: 'blocked', reason: 'points' }; }
				if (isPersonaExpired(currentRun.gameState, Date.now(), currentRun.rootBuild)) { await tx.done; return { kind: 'blocked', reason: 'expired' }; }
				if (currentLedger.pendingInstanceIds.length > 0) { await tx.done; return { kind: 'blocked', reason: 'pending-realtime' }; }
				const identity = current.identities.find((item) => sameIdentityReference(item, currentRun.identity));
				if (!identity) { await tx.done; return { kind: 'corrupt', reason: 'identity-reference' }; }
				const nowMs = Date.now();
				const clearedIdentity: IdentityRecord = { ...identity, status: 'cleared', runHistory: [...identity.runHistory, { runNumber: currentRun.runNumber, startedAtMs: currentRun.startedAtMs, endedAtMs: nowMs, outcome: 'cleared' }] };
				if (current.rootPoints >= Number.MAX_SAFE_INTEGER) { await tx.done; return { kind: 'corrupt', reason: 'player-state' }; }
				const reusableCurrentIdentity: ClearedIdentityCandidate = { generation: identity.generation, accountIndex: identity.accountIndex, pubkey: identity.pubkey, characterId: identity.characterId };
				const selectionWithClearedIdentity: PendingSelection = { ...selection, reusableIdentities: [...selection.reusableIdentities, reusableCurrentIdentity] };
				const exit = await commitTerminalFence(tx.objectStore(WORLD_WRITE_JOURNAL_STORE_NAME), currentRun, terminalExit);
				await store.put({ schemaVersion: PLAYER_SCHEMA_VERSION, rootPoints: current.rootPoints + 1, identities: current.identities.map((item) => item === identity ? clearedIdentity : item), mode: { kind: 'selecting', pendingSelection: selectionWithClearedIdentity } }, PLAYER_STATE);
				await tx.done;
				return { kind: 'cleared', ...(exit ? { exit } : {}) };
			} catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
		});
	} finally { observed.entropy.fill(0); }
}

export async function exportClearedIdentityNsec(identity: IdentityReference): Promise<string | null> {
	if (!isValidIdentityReference(identity)) return null;
	return withLifecycle(async (db) => {
		const observed = await readRootAndPlayer(db);
		if (!observed || isCorruptLifecycle(observed) || ('kind' in observed && observed.kind === 'legacy-player-reset')) throw new Error('Account operation failed.');
		let master: HDKey | null = null;
		try {
			if (observed.player.mode.kind === 'running') return null;
			const record = observed.player.identities.find((item) => sameIdentityReference(item, identity));
			if (!record || record.status !== 'cleared') return null;
			master = deriveMaster(observed.entropy);
			const signer = await deriveSignerFromMaster(master, record);
			try { return nip19.nsecEncode(signer.secretKey); } finally { signer.secretKey.fill(0); }
		} finally { master?.wipePrivateData(); observed.entropy.fill(0); }
	});
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
			await store.put({ ...current, identities: current.identities.map((item) => item === identity ? { ...identity, characterProfileRevision: CURRENT_CHARACTER_PROFILE_REVISION } : item) }, PLAYER_STATE);
			await tx.done;
			return { kind: 'recorded' };
		} catch { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); return { kind: 'stale' }; }
	});
}
