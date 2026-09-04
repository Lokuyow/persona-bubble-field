import { openDB, type DBSchema, type IDBPTransaction } from 'idb';

export const TRACE_DATABASE_NAME = 'persona-bubble-field-trace';
export const TRACE_DATABASE_VERSION = 2;
export const TRACE_ROOT_STORE = 'trace-roots';
export const TRACE_REPLY_STORE = 'trace-replies';
export const TRACE_REPLY_LRU_STORE = 'trace-reply-lru';
export const TRACE_DATABASE_STORES = [
	TRACE_ROOT_STORE,
	TRACE_REPLY_STORE,
	TRACE_REPLY_LRU_STORE
] as const;

export type TraceRootRecord = Readonly<{
	channelId: string;
	eventId: string;
	rawEvent: unknown;
}>;

export type TraceReplyRecord = Readonly<{
	channelId: string;
	rootId: string;
	eventId: string;
	rawEvent: unknown;
}>;

export type TraceReplyLruRecord = Readonly<{
	channelId: string;
	rootId: string;
	accessOrder: number;
}>;

export interface TraceDatabase extends DBSchema {
	[TRACE_ROOT_STORE]: {
		key: [string, string];
		value: TraceRootRecord;
	};
	[TRACE_REPLY_STORE]: {
		key: [string, string, string];
		value: TraceReplyRecord;
	};
	[TRACE_REPLY_LRU_STORE]: {
		key: [string, string];
		value: TraceReplyLruRecord;
	};
}

export type TraceReadwriteTransaction = IDBPTransaction<
	TraceDatabase,
	typeof TRACE_DATABASE_STORES,
	'readwrite'
>;

export async function openTraceDatabase() {
	return openDB<TraceDatabase>(TRACE_DATABASE_NAME, TRACE_DATABASE_VERSION, {
		upgrade(db) {
			if (!db.objectStoreNames.contains(TRACE_ROOT_STORE)) {
				db.createObjectStore(TRACE_ROOT_STORE, { keyPath: ['channelId', 'eventId'] });
			}
			if (!db.objectStoreNames.contains(TRACE_REPLY_STORE)) {
				db.createObjectStore(TRACE_REPLY_STORE, { keyPath: ['channelId', 'rootId', 'eventId'] });
			}
			if (!db.objectStoreNames.contains(TRACE_REPLY_LRU_STORE)) {
				db.createObjectStore(TRACE_REPLY_LRU_STORE, { keyPath: ['channelId', 'rootId'] });
			}
		}
	});
}
