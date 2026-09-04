import type { Event } from 'nostr-tools/pure';
import { parseWorldMessage, type ParsedTraceReply, type ParsedWorldMessage } from './nostrProtocol';
import {
	openTraceDatabase,
	TRACE_DATABASE_STORES,
	TRACE_REPLY_LRU_STORE,
	TRACE_REPLY_STORE,
	TRACE_ROOT_STORE,
	type TraceReadwriteTransaction,
	type TraceReplyLruRecord
} from './traceDatabase';
import {
	parseTraceReplyEvents,
	resolveTraceReplyCandidates,
	type AcceptedTraceReplyEvent,
	type TraceReplyEventCandidate
} from './traceReplies';
import { assertTraceRootChannelId } from './traceRoots';

const TRACE_REPLY_HARD_CAP = 1000;
const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/;

export type ReconcileTraceReplyCacheInput = Readonly<{
	channelId: string;
	effectiveRoots: readonly ParsedWorldMessage[];
	rawEvents: readonly Event[];
	currentOpenRootId?: string;
}>;

export type TouchTraceReplyTreeInput = Readonly<{
	channelId: string;
	rootId: string;
}>;

type RootAuthority = Readonly<{
	channelId: string;
	root: ParsedWorldMessage;
}>;

type ReplyTree = {
	channelId: string;
	rootId: string;
	replies: AcceptedTraceReplyEvent[];
};

function treeKey(channelId: string, rootId: string): string {
	return `${channelId}\u0000${rootId}`;
}

function assertEventId(eventId: string, name: string): void {
	if (!NOSTR_EVENT_ID.test(eventId)) {
		throw new TypeError(`${name} must be a 64-character lowercase hexadecimal Nostr event ID.`);
	}
}

async function openReplyDatabase() {
	if (typeof indexedDB === 'undefined') {
		throw new Error('Trace reply storage is unavailable.');
	}
	try {
		return await openTraceDatabase();
	} catch {
		throw new Error('Trace reply storage could not be opened.');
	}
}

function recordObject(value: unknown): Readonly<Record<string, unknown>> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: null;
}

function parsePersistedRoot(record: unknown, key: IDBValidKey): RootAuthority | null {
	if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || typeof key[1] !== 'string') return null;
	const value = recordObject(record);
	if (!value || value.channelId !== key[0] || value.eventId !== key[1] || value.rawEvent === undefined) return null;
	try {
		const root = parseWorldMessage(value.rawEvent as Event, key[0]);
		return root && root.id === key[1] ? { channelId: key[0], root } : null;
	} catch {
		return null;
	}
}

function rootAuthorities(
	records: readonly unknown[],
	keys: readonly IDBValidKey[],
	input: ReconcileTraceReplyCacheInput
): Map<string, RootAuthority> {
	const persisted = new Map<string, RootAuthority>();
	for (let index = 0; index < keys.length; index += 1) {
		const authority = parsePersistedRoot(records[index], keys[index]);
		if (authority) persisted.set(treeKey(authority.channelId, authority.root.id), authority);
	}

	const effective = new Map(input.effectiveRoots.map((root) => [root.id, root]));
	for (const [key, authority] of persisted) {
		if (authority.channelId !== input.channelId) continue;
		const root = effective.get(authority.root.id);
		if (!root || root.pubkey !== authority.root.pubkey) persisted.delete(key);
		else persisted.set(key, { channelId: input.channelId, root });
	}
	return persisted;
}

function parsePersistedReply(
	record: unknown,
	key: IDBValidKey
): Readonly<{ channelId: string; rootId: string; event: TraceReplyEventCandidate }> | null {
	if (
		!Array.isArray(key) || key.length !== 3 ||
		typeof key[0] !== 'string' || typeof key[1] !== 'string' || typeof key[2] !== 'string'
	) return null;
	const value = recordObject(record);
	if (
		!value || value.channelId !== key[0] || value.rootId !== key[1] ||
		value.eventId !== key[2] || value.rawEvent === undefined
	) return null;
	const event = parseTraceReplyEvents([value.rawEvent as Event])[0];
	return event && event.candidate.id === key[2] && event.candidate.rootId === key[1]
		? { channelId: key[0], rootId: key[1], event }
		: null;
}

function resolveTrees(
	authorities: ReadonlyMap<string, RootAuthority>,
	storedRecords: readonly unknown[],
	storedKeys: readonly IDBValidKey[],
	incoming: readonly TraceReplyEventCandidate[],
	inputChannelId: string
): Map<string, ReplyTree> {
	const candidates = new Map<string, TraceReplyEventCandidate[]>();
	for (let index = 0; index < storedKeys.length; index += 1) {
		const stored = parsePersistedReply(storedRecords[index], storedKeys[index]);
		if (!stored) continue;
		const key = treeKey(stored.channelId, stored.rootId);
		if (!authorities.has(key)) continue;
		const events = candidates.get(key) ?? [];
		events.push(stored.event);
		candidates.set(key, events);
	}
	for (const event of incoming) {
		const key = treeKey(inputChannelId, event.candidate.rootId);
		if (!authorities.has(key)) continue;
		const events = candidates.get(key) ?? [];
		events.push(event);
		candidates.set(key, events);
	}

	const trees = new Map<string, ReplyTree>();
	for (const [key, events] of candidates) {
		const authority = authorities.get(key)!;
		const replies = resolveTraceReplyCandidates({
			effectiveRoots: [authority.root],
			candidates: events
		});
		if (replies.length > 0) {
			trees.set(key, {
				channelId: authority.channelId,
				rootId: authority.root.id,
				replies: [...replies]
			});
		}
	}
	return trees;
}

function validLruRecords(
	records: readonly unknown[],
	keys: readonly IDBValidKey[],
	authorities: ReadonlyMap<string, RootAuthority>
): Map<string, TraceReplyLruRecord> {
	const result = new Map<string, TraceReplyLruRecord>();
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index];
		if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'string' || typeof key[1] !== 'string') continue;
		const value = recordObject(records[index]);
		if (
			!value || value.channelId !== key[0] || value.rootId !== key[1] ||
			!Number.isSafeInteger(value.accessOrder) || (value.accessOrder as number) < 0
		) continue;
		const id = treeKey(key[0], key[1]);
		if (authorities.has(id)) {
			result.set(id, { channelId: key[0], rootId: key[1], accessOrder: value.accessOrder as number });
		}
	}
	return result;
}

function compareTreeEviction(
	first: ReplyTree,
	second: ReplyTree,
	lru: ReadonlyMap<string, TraceReplyLruRecord>
): number {
	const firstOrder = lru.get(treeKey(first.channelId, first.rootId))?.accessOrder;
	const secondOrder = lru.get(treeKey(second.channelId, second.rootId))?.accessOrder;
	if (firstOrder === undefined && secondOrder !== undefined) return -1;
	if (firstOrder !== undefined && secondOrder === undefined) return 1;
	if (firstOrder !== secondOrder) return firstOrder! - secondOrder!;
	return first.channelId < second.channelId ? -1 : first.channelId > second.channelId ? 1 :
		first.rootId < second.rootId ? -1 : first.rootId > second.rootId ? 1 : 0;
}

function trimSingleTree(tree: ReplyTree): void {
	const kept = new Map(tree.replies.map((event) => [event.reply.id, event]));
	const childCounts = new Map<string, number>();
	for (const event of kept.values()) {
		if (event.reply.parentKind === 1111 && kept.has(event.reply.parentId)) {
			childCounts.set(event.reply.parentId, (childCounts.get(event.reply.parentId) ?? 0) + 1);
		}
	}
	while (kept.size > TRACE_REPLY_HARD_CAP) {
		const leaf = [...kept.values()]
			.filter((event) => (childCounts.get(event.reply.id) ?? 0) === 0)
			.sort((first, second) => first.reply.createdAt - second.reply.createdAt ||
				(first.reply.id < second.reply.id ? -1 : first.reply.id > second.reply.id ? 1 : 0))[0];
		if (!leaf) throw new Error('Trace reply tree has no removable leaf.');
		kept.delete(leaf.reply.id);
		if (leaf.reply.parentKind === 1111 && kept.has(leaf.reply.parentId)) {
			childCounts.set(leaf.reply.parentId, (childCounts.get(leaf.reply.parentId) ?? 1) - 1);
		}
	}
	tree.replies = tree.replies.filter((event) => kept.has(event.reply.id));
}

function enforceGlobalCap(
	trees: Map<string, ReplyTree>,
	lru: Map<string, TraceReplyLruRecord>,
	currentOpenKey: string | null
): void {
	let total = [...trees.values()].reduce((sum, tree) => sum + tree.replies.length, 0);
	while (total > TRACE_REPLY_HARD_CAP && trees.size > 1) {
		let candidates = [...trees.values()];
		if (currentOpenKey && trees.has(currentOpenKey) && candidates.length > 1) {
			candidates = candidates.filter((tree) => treeKey(tree.channelId, tree.rootId) !== currentOpenKey);
		}
		const evicted = candidates.sort((first, second) => compareTreeEviction(first, second, lru))[0];
		const key = treeKey(evicted.channelId, evicted.rootId);
		trees.delete(key);
		lru.delete(key);
		total -= evicted.replies.length;
	}
	if (total > TRACE_REPLY_HARD_CAP) {
		const remaining = [...trees.values()][0];
		trimSingleTree(remaining);
	}
}

async function rewriteReplies(
	tx: TraceReadwriteTransaction,
	oldReplyKeys: readonly IDBValidKey[],
	oldLruKeys: readonly IDBValidKey[],
	trees: ReadonlyMap<string, ReplyTree>,
	lru: ReadonlyMap<string, TraceReplyLruRecord>
): Promise<void> {
	const replyStore = tx.objectStore(TRACE_REPLY_STORE);
	for (const key of oldReplyKeys) await replyStore.delete(key as [string, string, string]);
	for (const tree of [...trees.values()].sort((first, second) =>
		first.channelId < second.channelId ? -1 : first.channelId > second.channelId ? 1 :
		first.rootId < second.rootId ? -1 : first.rootId > second.rootId ? 1 : 0
	)) {
		for (const event of tree.replies) {
			await replyStore.put({
				channelId: tree.channelId,
				rootId: tree.rootId,
				eventId: event.reply.id,
				rawEvent: event.rawEvent
			});
		}
	}

	const lruStore = tx.objectStore(TRACE_REPLY_LRU_STORE);
	for (const key of oldLruKeys) await lruStore.delete(key as [string, string]);
	for (const record of lru.values()) await lruStore.put(record);
}

function currentChannelSnapshot(
	trees: ReadonlyMap<string, ReplyTree>,
	input: ReconcileTraceReplyCacheInput
): readonly ParsedTraceReply[] {
	const effectiveIds = new Set(input.effectiveRoots.map((root) => root.id));
	return [...trees.values()]
		.filter((tree) => tree.channelId === input.channelId && effectiveIds.has(tree.rootId))
		.sort((first, second) => first.rootId < second.rootId ? -1 : first.rootId > second.rootId ? 1 : 0)
		.flatMap((tree) => tree.replies.map((event) => event.reply));
}

export async function reconcileTraceReplyCache(
	input: ReconcileTraceReplyCacheInput
): Promise<readonly ParsedTraceReply[]> {
	assertTraceRootChannelId(input.channelId);
	if (input.currentOpenRootId !== undefined) assertEventId(input.currentOpenRootId, 'Current open root ID');
	const incoming = parseTraceReplyEvents(input.rawEvents);

	const db = await openReplyDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const rootStore = tx.objectStore(TRACE_ROOT_STORE);
		const replyStore = tx.objectStore(TRACE_REPLY_STORE);
		const lruStore = tx.objectStore(TRACE_REPLY_LRU_STORE);
		const [rootRecords, rootKeys, replyRecords, replyKeys, lruRecords, lruKeys] = await Promise.all([
			rootStore.getAll(), rootStore.getAllKeys(),
			replyStore.getAll(), replyStore.getAllKeys(),
			lruStore.getAll(), lruStore.getAllKeys()
		]);

		const authorities = rootAuthorities(rootRecords, rootKeys, input);
		const trees = resolveTrees(authorities, replyRecords, replyKeys, incoming, input.channelId);
		const lru = validLruRecords(lruRecords, lruKeys, authorities);
		const currentOpenKey = input.currentOpenRootId === undefined
			? null
			: treeKey(input.channelId, input.currentOpenRootId);
		enforceGlobalCap(trees, lru, currentOpenKey);
		await rewriteReplies(tx, replyKeys, lruKeys, trees, lru);
		await tx.done;
		return currentChannelSnapshot(trees, input);
	} catch {
		if (tx) {
			try {
				tx.abort();
			} catch {
				// The request failure may have already aborted the transaction.
			}
			await tx.done.catch(() => {});
		}
		throw new Error('Trace reply cache operation failed.');
	} finally {
		db.close();
	}
}

export async function touchTraceReplyTree(input: TouchTraceReplyTreeInput): Promise<boolean> {
	assertTraceRootChannelId(input.channelId);
	assertEventId(input.rootId, 'Trace root ID');
	const db = await openReplyDatabase();
	let tx: TraceReadwriteTransaction | undefined;
	try {
		tx = db.transaction(TRACE_DATABASE_STORES, 'readwrite');
		void tx.done.catch(() => {});
		const rootRecord = await tx.objectStore(TRACE_ROOT_STORE).get([input.channelId, input.rootId]);
		const authority = rootRecord
			? parsePersistedRoot(rootRecord, [input.channelId, input.rootId])
			: null;
		if (!authority) {
			await tx.done;
			return false;
		}

		const lruStore = tx.objectStore(TRACE_REPLY_LRU_STORE);
		const records = await lruStore.getAll();
		const maximum = records.reduce((value, record) =>
			Number.isSafeInteger(record.accessOrder) && record.accessOrder >= 0
				? Math.max(value, record.accessOrder)
				: value, 0);
		if (!Number.isSafeInteger(maximum + 1)) throw new Error('Trace reply LRU access order is exhausted.');
		await lruStore.put({ channelId: input.channelId, rootId: input.rootId, accessOrder: maximum + 1 });
		await tx.done;
		return true;
	} catch {
		if (tx) {
			try {
				tx.abort();
			} catch {
				// The request failure may have already aborted the transaction.
			}
			await tx.done.catch(() => {});
		}
		throw new Error('Trace reply cache operation failed.');
	} finally {
		db.close();
	}
}
