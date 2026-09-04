import type { Event } from 'nostr-tools/pure';
import type { ParsedWorldMessage } from './nostrProtocol';
import {
	openTraceDatabase,
	TRACE_DATABASE_STORES,
	TRACE_REPLY_LRU_STORE,
	TRACE_REPLY_STORE,
	TRACE_ROOT_STORE,
	type TraceReadwriteTransaction
} from './traceDatabase';
import {
	assertTraceRootChannelId,
	assertTraceRootField,
	capTraceRootCandidates,
	selectTraceRootCandidates,
	type TraceRootCandidate,
	type TraceRootField
} from './traceRoots';

export type ReconcileTraceRootCacheInput = Readonly<{
	channelId: string;
	field: TraceRootField;
	rawEvents: readonly Event[];
}>;

async function openRootDatabase() {
	if (typeof indexedDB === 'undefined') {
		throw new Error('Trace root storage is unavailable.');
	}
	try {
		return await openTraceDatabase();
	} catch {
		throw new Error('Trace root storage could not be opened.');
	}
}

function storedRawEvents(records: readonly unknown[]): Event[] {
	return records.flatMap((record) => {
		if (typeof record !== 'object' || record === null || Array.isArray(record)) return [];
		const rawEvent = (record as Readonly<Record<string, unknown>>).rawEvent;
		return rawEvent === undefined ? [] : [rawEvent as Event];
	});
}

async function replaceCurrentChannel(
	tx: TraceReadwriteTransaction,
	keys: readonly IDBValidKey[],
	channelId: string,
	candidates: readonly TraceRootCandidate[]
): Promise<void> {
	const store = tx.objectStore(TRACE_ROOT_STORE);
	for (const key of keys) await store.delete(key as [string, string]);
	for (const candidate of candidates) {
		await store.put({
			channelId,
			eventId: candidate.root.id,
			rawEvent: candidate.rawEvent
		});
	}
}

async function removeEvictedRootState(
	tx: TraceReadwriteTransaction,
	channelId: string,
	survivorIds: ReadonlySet<string>
): Promise<void> {
	const replyStore = tx.objectStore(TRACE_REPLY_STORE);
	for (const key of await replyStore.getAllKeys()) {
		if (!Array.isArray(key) || key.length !== 3 || key[0] !== channelId) continue;
		if (typeof key[1] !== 'string' || !survivorIds.has(key[1])) {
			await replyStore.delete(key as [string, string, string]);
		}
	}

	const lruStore = tx.objectStore(TRACE_REPLY_LRU_STORE);
	for (const key of await lruStore.getAllKeys()) {
		if (!Array.isArray(key) || key.length !== 2 || key[0] !== channelId) continue;
		if (typeof key[1] !== 'string' || !survivorIds.has(key[1])) {
			await lruStore.delete(key as [string, string]);
		}
	}
}

/**
 * Atomically reconciles persisted roots with a newly acquired batch for one
 * channel. New events are signature-checked before the write lock is acquired;
 * cache records are revalidated inside the serialized read-modify-write scope.
 */
export async function reconcileTraceRootCache(
	input: ReconcileTraceRootCacheInput
): Promise<readonly ParsedWorldMessage[]> {
	// These are caller-input validation errors, never storage-operation errors.
	assertTraceRootChannelId(input.channelId);
	assertTraceRootField(input.field);
	const selectedNewRoots = selectTraceRootCandidates(input.rawEvents, input.channelId, input.field);

	const db = await openRootDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const rootStore = tx.objectStore(TRACE_ROOT_STORE);
		// Enumerate the complete store: a compound-key range constrained by a
		// string eventId would hide same-channel records whose corrupt key uses a
		// different IndexedDB-valid key type (for example, a number).
		const [allRecords, allKeys] = await Promise.all([rootStore.getAll(), rootStore.getAllKeys()]);
		const currentRecords: unknown[] = [];
		const currentKeys: IDBValidKey[] = [];
		for (let index = 0; index < allKeys.length; index += 1) {
			const key = allKeys[index];
			if (!Array.isArray(key) || key.length !== 2 || key[0] !== input.channelId) continue;
			currentKeys.push(key);
			currentRecords.push(allRecords[index]);
		}
		const selectedStoredRoots = selectTraceRootCandidates(
			storedRawEvents(currentRecords), input.channelId, input.field
		);
		const survivors = capTraceRootCandidates([...selectedStoredRoots, ...selectedNewRoots], input.field);
		const survivorIds = new Set(survivors.map((candidate) => candidate.root.id));
		await replaceCurrentChannel(tx, currentKeys, input.channelId, survivors);
		await removeEvictedRootState(tx, input.channelId, survivorIds);
		await tx.done;
		return survivors.map((candidate) => candidate.root);
	} catch {
		if (tx) {
			try {
				tx.abort();
			} catch {
				// The request failure may have already aborted the transaction.
			}
			await tx.done.catch(() => {});
		}
		throw new Error('Trace root cache operation failed.');
	} finally {
		db.close();
	}
}
