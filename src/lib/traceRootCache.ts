import { openDB, type DBSchema, type IDBPTransaction } from 'idb';
import type { Event } from 'nostr-tools/pure';
import type { ParsedWorldMessage } from './nostrProtocol';
import {
	assertTraceRootChannelId,
	assertTraceRootField,
	capTraceRootCandidates,
	selectTraceRootCandidates,
	type TraceRootCandidate,
	type TraceRootField
} from './traceRoots';

const DATABASE_NAME = 'persona-bubble-field-trace';
const STORE_NAME = 'trace-roots';

interface TraceDatabase extends DBSchema {
	[STORE_NAME]: {
		key: [string, string];
		value: Readonly<{ channelId: string; eventId: string; rawEvent: unknown }>;
	};
}

type TraceTransaction = IDBPTransaction<TraceDatabase, [typeof STORE_NAME], 'readwrite'>;

export type ReconcileTraceRootCacheInput = Readonly<{
	channelId: string;
	field: TraceRootField;
	rawEvents: readonly Event[];
}>;

async function openTraceDatabase() {
	if (typeof indexedDB === 'undefined') {
		throw new Error('Trace root storage is unavailable.');
	}
	try {
		return await openDB<TraceDatabase>(DATABASE_NAME, 1, {
			upgrade(db) {
				db.createObjectStore(STORE_NAME, { keyPath: ['channelId', 'eventId'] });
			}
		});
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
	tx: TraceTransaction,
	keys: readonly IDBValidKey[],
	channelId: string,
	candidates: readonly TraceRootCandidate[]
): Promise<void> {
	for (const key of keys) await tx.store.delete(key as [string, string]);
	for (const candidate of candidates) {
		await tx.store.put({
			channelId,
			eventId: candidate.root.id,
			rawEvent: candidate.rawEvent
		});
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

	const db = await openTraceDatabase();
	let tx: TraceTransaction | undefined;
	try {
		tx = db.transaction(STORE_NAME, 'readwrite');
		void tx.done.catch(() => {});
		// Enumerate the complete store: a compound-key range constrained by a
		// string eventId would hide same-channel records whose corrupt key uses a
		// different IndexedDB-valid key type (for example, a number).
		const [allRecords, allKeys] = await Promise.all([tx.store.getAll(), tx.store.getAllKeys()]);
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
		await replaceCurrentChannel(tx, currentKeys, input.channelId, survivors);
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
