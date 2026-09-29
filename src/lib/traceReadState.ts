import {
	openTraceDatabase,
	TRACE_DATABASE_STORES,
	TRACE_REPLY_READ_STORE,
	TRACE_REPLY_STORE,
	TRACE_ROOT_READ_STORE,
	TRACE_ROOT_STORE,
	TRACE_REWARD_OUTBOX_STORE,
	type TraceRewardIdentity,
	type TraceRewardOutboxRecord,
	type TraceReadwriteTransaction,
	type TraceReplyReadRecord,
	type TraceRootReadRecord
} from './traceDatabase';
import type { Event } from 'nostr-tools/pure';
import { parseTraceEvent, parseWorldMessage } from './nostrProtocol';

const EVENT_ID = /^[0-9a-f]{64}$/;

export type TraceReadSnapshot = Readonly<{
	readRootIds: readonly string[];
	unreadReplyRootIds: readonly string[];
	hasUnreadReplies: boolean;
}>;

export type TraceReadScope = Readonly<{
	channelId: string;
	personaPubkey: string;
	rewardTarget?: Readonly<{ identity: TraceRewardIdentity; runNumber: number }>;
}>;

export type TraceReplyRewardEvidence = Readonly<{ id: string; pubkey: string; parentPubkey: string }>;

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

function validTraceRewardOutbox(value: unknown): value is TraceRewardOutboxRecord {
	const record = recordObject(value);
	const identity = recordObject(record?.identity);
	return Boolean(record && typeof record.key === 'string' &&
		(record.kind === 'trace-root-read' || record.kind === 'trace-reply-read') &&
		typeof record.channelId === 'string' && EVENT_ID.test(record.channelId) &&
		typeof record.eventId === 'string' && EVENT_ID.test(record.eventId) &&
		identity && Number.isSafeInteger(identity.generation) && Number.isSafeInteger(identity.accountIndex) &&
		typeof identity.pubkey === 'string' && EVENT_ID.test(identity.pubkey) &&
		Number.isSafeInteger(record.runNumber) && (record.runNumber as number) > 0 &&
		(record.status === 'pending' || record.status === 'processed' || record.status === 'stale'));
}

function queueTraceReward(
	tx: TraceReadwriteTransaction,
	input: TraceReadScope & Readonly<{ rootId: string; eventId: string; kind: TraceRewardOutboxRecord['kind'] }>
): Promise<void> {
	if (!input.rewardTarget || !Number.isSafeInteger(input.rewardTarget.runNumber) || input.rewardTarget.runNumber < 1) return Promise.resolve();
	const key = `${input.kind}\u0000${input.channelId}\u0000${input.eventId}`;
	return tx.objectStore(TRACE_REWARD_OUTBOX_STORE).get(key).then(async (existing) => {
		if (existing !== undefined) {
			if (!validTraceRewardOutbox(existing)) throw new Error('Trace reward outbox is corrupt.');
			return;
		}
		await tx.objectStore(TRACE_REWARD_OUTBOX_STORE).put({
			key, kind: input.kind, channelId: input.channelId, eventId: input.eventId,
			identity: input.rewardTarget!.identity, runNumber: input.rewardTarget!.runNumber, status: 'pending'
		});
	});
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
		const rawEvent = root.rawEvent as Event;
		const parsedRoot = parseWorldMessage(rawEvent, input.channelId) ?? parseTraceEvent(rawEvent, input.channelId);
		await store.put({ channelId: input.channelId, eventId: input.rootId, read: true });
		if (parsedRoot && parsedRoot.pubkey !== input.personaPubkey) {
			await queueTraceReward(tx, { ...input, rootId: input.rootId, eventId: input.rootId, kind: 'trace-root-read' });
		}
		await tx.done;
		return true;
	} finally {
		if (tx) await tx.done.catch(() => {});
		db.close();
	}
}

export async function markTraceReplyRead(input: TraceReadScope & Readonly<{ rootId: string; replyId: string; rewardEvidence?: TraceReplyRewardEvidence }>): Promise<boolean> {
	assertEventId(input.channelId, 'Channel ID');
	assertPubkey(input.personaPubkey, 'Persona pubkey');
	assertEventId(input.rootId, 'Root ID');
	assertEventId(input.replyId, 'Reply ID');
	return setTraceReplyReadState({ ...input, state: 'read' });
}

export async function setTraceReplyReadState(input: TraceReadScope & Readonly<{ rootId: string; replyId: string; state: 'read' | 'unread'; rewardEvidence?: TraceReplyRewardEvidence }>): Promise<boolean> {
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
		if (input.state === 'read' && validReplyRead(existing) && existing.state === 'unread' &&
			input.rewardTarget && input.rewardEvidence?.id === input.replyId &&
			input.rewardEvidence.parentPubkey === input.personaPubkey && input.rewardEvidence.pubkey !== input.personaPubkey) {
			await queueTraceReward(tx, { ...input, eventId: input.replyId, kind: 'trace-reply-read' });
		}
		await tx.done;
		return true;
	} finally {
		if (tx) await tx.done.catch(() => {});
		db.close();
	}
}

export async function loadPendingTraceRewardOutbox(): Promise<readonly TraceRewardOutboxRecord[]> {
	const db = await openTraceDatabase();
	try {
		return (await db.getAll(TRACE_REWARD_OUTBOX_STORE)).filter((record) => validTraceRewardOutbox(record) && record.status === 'pending');
	} finally { db.close(); }
}

export async function settleTraceRewardOutbox(key: string, status: 'processed' | 'stale'): Promise<boolean> {
	const db = await openTraceDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const store = tx.objectStore(TRACE_REWARD_OUTBOX_STORE);
		const current = await store.get(key);
		if (!validTraceRewardOutbox(current) || current.status !== 'pending') { await tx.done; return false; }
		await store.put({ ...current, status });
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
