import {
	openTraceDatabase,
	TRACE_DATABASE_STORES,
	TRACE_REPLY_READ_STORE,
	TRACE_REPLY_STORE,
	TRACE_ROOT_READ_STORE,
	TRACE_ROOT_STORE,
	type TraceReadwriteTransaction,
	type TraceReplyReadRecord,
	type TraceRootReadRecord
} from './traceDatabase';

const EVENT_ID = /^[0-9a-f]{64}$/;

export type TraceReadSnapshot = Readonly<{
	readRootIds: readonly string[];
	unreadReplyRootIds: readonly string[];
	hasUnreadReplies: boolean;
}>;

export type TraceReadScope = Readonly<{
	channelId: string;
	personaPubkey: string;
}>;

function assertEventId(value: string, name: string): void {
	if (!EVENT_ID.test(value)) throw new TypeError(`${name} must be a lowercase Nostr event ID.`);
}

function assertPubkey(value: string, name: string): void {
	if (!EVENT_ID.test(value)) throw new TypeError(`${name} must be a lowercase Nostr public key.`);
}

function recordObject(value: unknown): Readonly<Record<string, unknown>> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>> : null;
}

function validRootRead(value: unknown): value is TraceRootReadRecord {
	const record = recordObject(value);
	return Boolean(record && typeof record.channelId === 'string' && typeof record.eventId === 'string' &&
		EVENT_ID.test(record.eventId) && record.read === true);
}

function validReplyRead(value: unknown): value is TraceReplyReadRecord {
	const record = recordObject(value);
	return Boolean(record && typeof record.channelId === 'string' && typeof record.personaPubkey === 'string' &&
		typeof record.rootId === 'string' && typeof record.replyId === 'string' &&
		EVENT_ID.test(record.personaPubkey) && EVENT_ID.test(record.rootId) && EVENT_ID.test(record.replyId) &&
		(record.state === 'read' || record.state === 'unread'));
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort();
}

export async function loadTraceReadSnapshot(input: TraceReadScope): Promise<TraceReadSnapshot> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	const db = await openTraceDatabase();
	try {
		const [roots, replies] = await Promise.all([
			db.getAll(TRACE_ROOT_READ_STORE),
			db.getAll(TRACE_REPLY_READ_STORE)
		]);
		const readRootIds = roots.filter(validRootRead)
			.filter((record) => record.channelId === input.channelId)
			.map((record) => record.eventId);
		const unreadReplyRootIds = replies.filter(validReplyRead)
			.filter((record) => record.channelId === input.channelId && record.personaPubkey === input.personaPubkey && record.state === 'unread')
			.map((record) => record.rootId);
		return {
			readRootIds: uniqueSorted(readRootIds),
			unreadReplyRootIds: uniqueSorted(unreadReplyRootIds),
			hasUnreadReplies: unreadReplyRootIds.length > 0
		};
	} finally {
		db.close();
	}
}

export async function markTraceRootRead(input: TraceReadScope & Readonly<{ rootId: string }>): Promise<boolean> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	assertEventId(input.rootId, 'Root ID');
	const db = await openTraceDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const root = await tx.objectStore(TRACE_ROOT_STORE).get([input.channelId, input.rootId]);
		if (!root) { await tx.done; return false; }
		const store = tx.objectStore(TRACE_ROOT_READ_STORE);
		if (await store.get([input.channelId, input.rootId])) { await tx.done; return false; }
		await store.put({ channelId: input.channelId, eventId: input.rootId, read: true });
		await tx.done;
		return true;
	} finally {
		if (tx) await tx.done.catch(() => {});
		db.close();
	}
}

export async function markTraceReplyRead(input: TraceReadScope & Readonly<{ rootId: string; replyId: string }>): Promise<boolean> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	assertEventId(input.rootId, 'Root ID');
	assertEventId(input.replyId, 'Reply ID');
	return setTraceReplyReadState({ ...input, state: 'read' });
}

export async function setTraceReplyReadState(input: TraceReadScope & Readonly<{ rootId: string; replyId: string; state: 'read' | 'unread' }>): Promise<boolean> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	assertEventId(input.rootId, 'Root ID');
	assertEventId(input.replyId, 'Reply ID');
	const db = await openTraceDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const reply = await tx.objectStore(TRACE_REPLY_STORE).get([input.channelId, input.rootId, input.replyId]);
		if (!reply) { await tx.done; return false; }
		const store = tx.objectStore(TRACE_REPLY_READ_STORE);
		const key: [string, string, string, string] = [input.channelId, input.personaPubkey, input.rootId, input.replyId];
		const existing = await store.get(key);
		if (validReplyRead(existing) && existing.state === input.state) { await tx.done; return false; }
		await store.put({ ...keyRecord(input), state: input.state });
		await tx.done;
		return true;
	} finally {
		if (tx) await tx.done.catch(() => {});
		db.close();
	}
}

function keyRecord(input: TraceReadScope & Readonly<{ rootId: string; replyId: string }>): Omit<TraceReplyReadRecord, 'state'> {
	return { channelId: input.channelId, personaPubkey: input.personaPubkey, rootId: input.rootId, replyId: input.replyId };
}

export async function deleteTraceRootReadState(tx: TraceReadwriteTransaction, channelId: string, rootId: string): Promise<void> {
	await tx.objectStore(TRACE_ROOT_READ_STORE).delete([channelId, rootId]);
	const store = tx.objectStore(TRACE_REPLY_READ_STORE);
	for (const key of await store.getAllKeys()) {
		if (Array.isArray(key) && key[0] === channelId && key[2] === rootId) await store.delete(key as [string, string, string, string]);
	}
}

export async function deleteTraceReplyReadState(
	tx: TraceReadwriteTransaction, channelId: string, rootId: string, replyId: string
): Promise<void> {
	const store = tx.objectStore(TRACE_REPLY_READ_STORE);
	for (const key of await store.getAllKeys()) {
		if (Array.isArray(key) && key[0] === channelId && key[2] === rootId && key[3] === replyId) {
			await store.delete(key as [string, string, string, string]);
		}
	}
}

export async function reconcileTraceReplyUnreadState(
	tx: TraceReadwriteTransaction,
	input: TraceReadScope & Readonly<{ acceptedReplies: readonly Readonly<{ id: string; rootId: string; parentPubkey: string; pubkey: string }>[] }>
): Promise<void> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	const store = tx.objectStore(TRACE_REPLY_READ_STORE);
	for (const reply of input.acceptedReplies) {
		if (reply.parentPubkey !== input.personaPubkey || reply.pubkey === input.personaPubkey) continue;
		const key: [string, string, string, string] = [input.channelId, input.personaPubkey, reply.rootId, reply.id];
		const existing = await store.get(key);
		if (!validReplyRead(existing)) await store.put({ ...keyRecord({ ...input, rootId: reply.rootId, replyId: reply.id }), state: 'unread' });
	}
}
