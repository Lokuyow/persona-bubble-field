import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

export const ACCOUNT_REINCARNATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const DATABASE_NAME = 'persona-bubble-field-account';
const STORE_NAME = 'persona-bubble-field-account-state';
const SECRET_KEY = 'secret-key';
const TIMESTAMP_KEY = 'last-changed-at-ms';

interface AccountDatabase extends DBSchema {
	[STORE_NAME]: {
		key: typeof SECRET_KEY | typeof TIMESTAMP_KEY;
		// Persisted data is untrusted, even when the TypeScript writer is typed.
		value: unknown;
	};
}

type AccountTransaction = IDBPTransaction<AccountDatabase, [typeof STORE_NAME], 'readwrite'>;

/** Keep one snapshot for the whole account-dependent operation; do not mutate its key. */
export type AccountSnapshot = Readonly<{
	secretKey: Uint8Array;
	pubkey: string;
	lastChangedAtMs: number;
}>;

export type CorruptAccountState = Readonly<{
	kind: 'corrupt';
	reason: 'missing-timestamp' | 'invalid-timestamp' | 'invalid-secret';
}>;

export type LoadAccountResult =
	| Readonly<{ kind: 'created' | 'restored'; account: AccountSnapshot }>
	| Readonly<{ kind: 'missing-secret'; lastChangedAtMs: number }>
	| CorruptAccountState;

export type ReincarnateAccountResult =
	| Readonly<{ kind: 'reincarnated'; account: AccountSnapshot }>
	| Readonly<{ kind: 'cooldown'; nextAllowedAtMs: number }>
	| Readonly<{ kind: 'uninitialized' }>
	| CorruptAccountState;

type StoredAccountState =
	| Readonly<{ kind: 'fresh' }>
	| Readonly<{ kind: 'ready'; account: AccountSnapshot }>
	| Readonly<{ kind: 'missing-secret'; lastChangedAtMs: number }>
	| CorruptAccountState;

function isAccountTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 &&
		value <= Number.MAX_SAFE_INTEGER - ACCOUNT_REINCARNATION_COOLDOWN_MS;
}

function assertAccountTimestamp(value: number): void {
	if (!isAccountTimestamp(value)) {
		throw new TypeError('Account time must be non-negative safe Unix milliseconds with room for cooldown.');
	}
}

/** A display-time check only. Reincarnation rechecks the persisted timestamp in its transaction. */
export function getReincarnationEligibility(
	lastChangedAtMs: number,
	nowMs: number
): Readonly<{ canReincarnate: boolean; nextAllowedAtMs: number }> {
	assertAccountTimestamp(lastChangedAtMs);
	assertAccountTimestamp(nowMs);
	const nextAllowedAtMs = lastChangedAtMs + ACCOUNT_REINCARNATION_COOLDOWN_MS;
	return { canReincarnate: nowMs >= nextAllowedAtMs, nextAllowedAtMs };
}

async function openAccountDatabase() {
	try {
		// Neither this check nor openDB runs at module import time.
		if (typeof indexedDB === 'undefined') {
			throw new Error('IndexedDB is unavailable.');
		}
		return await openDB<AccountDatabase>(DATABASE_NAME, 1, {
			upgrade(db) {
				db.createObjectStore(STORE_NAME);
			}
		});
	} catch {
		throw new Error('Account storage could not be opened.');
	}
}

async function readAccountState(tx: AccountTransaction): Promise<StoredAccountState> {
	const secretRecordKey = await tx.store.getKey(SECRET_KEY);
	// idb 8.0.3 wraps scalar NaN incorrectly. A keyed array read preserves malformed values
	// for validation without native request wrappers or changing the stored schema.
	const [secret]: unknown[] = await tx.store.getAll(SECRET_KEY, 1);
	const timestampRecordKey = await tx.store.getKey(TIMESTAMP_KEY);
	const [timestamp]: unknown[] = await tx.store.getAll(TIMESTAMP_KEY, 1);

	if (secretRecordKey === undefined && timestampRecordKey === undefined) return { kind: 'fresh' };
	if (timestampRecordKey === undefined) return { kind: 'corrupt', reason: 'missing-timestamp' };
	if (!isAccountTimestamp(timestamp)) return { kind: 'corrupt', reason: 'invalid-timestamp' };
	if (secretRecordKey === undefined) return { kind: 'missing-secret', lastChangedAtMs: timestamp };
	if (!(secret instanceof Uint8Array) || secret.length !== 32) {
		return { kind: 'corrupt', reason: 'invalid-secret' };
	}

	let pubkey: string;
	try {
		pubkey = getPublicKey(secret);
	} catch {
		// Invalid scalars are checked by nostr-tools; never expose the library's raw error.
		return { kind: 'corrupt', reason: 'invalid-secret' };
	}
	return {
		kind: 'ready',
		account: { secretKey: secret.slice(), pubkey, lastChangedAtMs: timestamp }
	};
}

async function writeNewAccount(tx: AccountTransaction, nowMs: number): Promise<AccountSnapshot> {
	const secretKey = generateSecretKey().slice();
	const account: AccountSnapshot = { secretKey, pubkey: getPublicKey(secretKey), lastChangedAtMs: nowMs };
	// Await only IDB work while the transaction is active. Overwrite, never archive, the old key.
	await tx.store.put(secretKey, SECRET_KEY);
	await tx.store.put(nowMs, TIMESTAMP_KEY);
	return account;
}

function accessAccount(mode: 'load-or-create'): Promise<LoadAccountResult>;
function accessAccount(mode: 'reincarnate'): Promise<ReincarnateAccountResult>;
async function accessAccount(
	mode: 'load-or-create' | 'reincarnate'
): Promise<LoadAccountResult | ReincarnateAccountResult> {
	const db = await openAccountDatabase();
	let tx: AccountTransaction | undefined;
	try {
		// Reads, eligibility and writes share one scope, including across independent tabs.
		tx = db.transaction(STORE_NAME, 'readwrite');
		// Observe early aborts as well as individual request failures; still await done below.
		void tx.done.catch(() => {});
		const state = await readAccountState(tx);
		let result: LoadAccountResult | ReincarnateAccountResult;
		if (state.kind === 'corrupt') {
			result = state;
		} else if (mode === 'load-or-create' && state.kind === 'ready') {
			result = { kind: 'restored', account: state.account };
		} else if (mode === 'load-or-create' && state.kind === 'missing-secret') {
			result = state;
		} else if (mode === 'reincarnate' && state.kind === 'fresh') {
			result = { kind: 'uninitialized' };
		} else {
			// Sample after queued transactions have finished and our state has been read.
			const nowMs = Date.now();
			assertAccountTimestamp(nowMs);
			const lastChangedAtMs = state.kind === 'ready' ? state.account.lastChangedAtMs :
				state.kind === 'missing-secret' ? state.lastChangedAtMs : null;
			const eligibility = lastChangedAtMs === null ? null :
				getReincarnationEligibility(lastChangedAtMs, nowMs);
			if (eligibility && !eligibility.canReincarnate) {
				result = { kind: 'cooldown', nextAllowedAtMs: eligibility.nextAllowedAtMs };
			} else {
				const account = await writeNewAccount(tx, nowMs);
				result = { kind: mode === 'load-or-create' ? 'created' : 'reincarnated', account };
			}
		}
		await tx.done;
		return result;
	} catch {
		if (tx) {
			try {
				tx.abort();
			} catch {
				// A request failure may already have aborted the transaction.
			}
			await tx.done.catch(() => {});
		}
		// This boundary deliberately excludes record data and raw storage/crypto messages.
		throw new Error('Account operation failed.');
	} finally {
		db.close();
	}
}

/** Creates only when both records are absent; missing/corrupt data is never repaired. */
export function loadOrCreateAccount(): Promise<LoadAccountResult> {
	return accessAccount('load-or-create');
}

/** Explicitly replaces an account (including a missing secret) after the persisted cooldown. */
export function reincarnateAccount(): Promise<ReincarnateAccountResult> {
	return accessAccount('reincarnate');
}
