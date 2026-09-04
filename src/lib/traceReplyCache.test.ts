import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { Event } from 'nostr-tools/pure';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate,
	type ChannelReference,
	type ParsedTraceReply,
	type ParsedWorldMessage
} from './nostrProtocol';
import {
	openTraceDatabase,
	TRACE_REPLY_LRU_STORE,
	TRACE_REPLY_STORE,
	TRACE_ROOT_STORE
} from './traceDatabase';
import { reconcileTraceReplyCache, touchTraceReplyTree } from './traceReplyCache';
import { reconcileTraceRootCache } from './traceRootCache';

const CHANNEL_ID = 'a'.repeat(64);
const OTHER_CHANNEL_ID = 'b'.repeat(64);
const SECRET_KEY = new Uint8Array(32).fill(7);
const connections: Array<Awaited<ReturnType<typeof openTraceDatabase>>> = [];

type RootFixture = Readonly<{ raw: Event; parsed: ParsedWorldMessage }>;
type ReplyFixture = Readonly<{ raw: Event; parsed: ParsedTraceReply }>;

function channel(channelId: string): ChannelReference {
	return { channelId, relayHint: 'wss://relay.example.com' };
}

function makeRoot(channelId: string, content: string, createdAt = 100): RootFixture {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const raw = finalizeWorldEvent(buildWorldMessageTemplate({
			channel: channel(channelId), content: `${content}-${attempt}`, createdAt,
			position: { x: 0, y: 0 }, speechType: 'normal'
		}), SECRET_KEY);
		if (BigInt(`0x${raw.id}`) % 5n !== 0n) continue;
		const parsed = parseWorldMessage(raw, channelId);
		if (parsed) return { raw, parsed };
	}
	throw new Error('Could not create a trace root fixture.');
}

function makeReply(
	root: ParsedWorldMessage,
	parent: ParsedWorldMessage | ParsedTraceReply,
	content: string,
	createdAt: number
): ReplyFixture {
	const raw = finalizeWorldEvent(buildTraceReplyTemplate({
		root, parent, content, createdAt, position: { x: createdAt % 8, y: 0 }, speechType: 'normal'
	}), SECRET_KEY);
	const candidate = parseTraceReplyCandidate(raw);
	const parsed = candidate && validateTraceReplyCandidate(candidate, root, parent);
	if (!parsed) throw new Error('Could not create a trace reply fixture.');
	return { raw, parsed };
}

async function database() {
	const db = await openTraceDatabase();
	connections.push(db);
	return db;
}

async function seedRootForChannel(channelId: string, root: RootFixture): Promise<void> {
	await reconcileTraceRootCache({ channelId, field: { columns: 2, rows: 1 }, rawEvents: [root.raw] });
}

async function replyRecords() {
	return (await database()).getAll(TRACE_REPLY_STORE);
}

async function lruRecords() {
	return (await database()).getAll(TRACE_REPLY_LRU_STORE);
}

let capRoot: RootFixture;
let capOtherRoot: RootFixture;
let capReplies: ReplyFixture[];
let capOtherReplies: ReplyFixture[];

beforeAll(() => {
	capRoot = makeRoot(CHANNEL_ID, 'cap-root');
	capOtherRoot = makeRoot(OTHER_CHANNEL_ID, 'cap-other-root');
	capReplies = [];
	for (let index = 0; index < 999; index += 1) {
		capReplies.push(makeReply(capRoot.parsed, capRoot.parsed, `cap-direct-${index}`, 200));
	}
	const parent = makeReply(capRoot.parsed, capRoot.parsed, 'cap-parent', 200);
	const child = makeReply(capRoot.parsed, parent.parsed, 'cap-child', 200);
	capReplies.push(parent, child);
	capOtherReplies = Array.from({ length: 401 }, (_, index) =>
		makeReply(capOtherRoot.parsed, capOtherRoot.parsed, `other-${index}`, 300)
	);
});

afterAll(() => {
	capReplies = [];
	capOtherReplies = [];
});

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	while (connections.length) connections.pop()!.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('trace reply cache reconciliation', () => {
	it('persists accepted replies across reopen and does not treat Relay omission as deletion', async () => {
		const root = makeRoot(CHANNEL_ID, 'persist');
		await seedRootForChannel(CHANNEL_ID, root);
		const direct = makeReply(root.parsed, root.parsed, 'direct', 101);
		expect((await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [direct.raw]
		})).map((reply) => reply.id)).toEqual([direct.parsed.id]);
		expect((await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).map((reply) => reply.id)).toEqual([direct.parsed.id]);
		expect(await replyRecords()).toEqual([expect.objectContaining({
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: direct.parsed.id,
			rawEvent: expect.objectContaining({ id: direct.parsed.id })
		})]);
	});

	it('cleans corrupt raw replies and their broken orphan descendants', async () => {
		const root = makeRoot(CHANNEL_ID, 'corrupt');
		await seedRootForChannel(CHANNEL_ID, root);
		const parent = makeReply(root.parsed, root.parsed, 'parent', 101);
		const child = makeReply(root.parsed, parent.parsed, 'child', 102);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [parent.raw, child.raw]
		});
		const db = await database();
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: parent.parsed.id,
			rawEvent: { ...parent.raw, content: 'tampered' }
		});
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: 'f'.repeat(64), rawEvent: null
		});
		expect(await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).toEqual([]);
		expect(await replyRecords()).toEqual([]);
	});

	it('serializes concurrent reconciliations without losing valid updates', async () => {
		const root = makeRoot(CHANNEL_ID, 'concurrent');
		await seedRootForChannel(CHANNEL_ID, root);
		const first = makeReply(root.parsed, root.parsed, 'first', 101);
		const second = makeReply(root.parsed, root.parsed, 'second', 102);
		await Promise.all([
			reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [first.raw] }),
			reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [second.raw] })
		]);
		expect((await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).map((reply) => reply.id)).toEqual([first.parsed.id, second.parsed.id]);
	});

	it('rolls back every reply write when a request fails', async () => {
		const root = makeRoot(CHANNEL_ID, 'rollback');
		await seedRootForChannel(CHANNEL_ID, root);
		const old = makeReply(root.parsed, root.parsed, 'old', 101);
		const next = makeReply(root.parsed, root.parsed, 'next', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [old.raw] });
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if ((value as { eventId?: string }).eventId === next.parsed.id) {
				throw new DOMException('Simulated write failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [next.raw]
		})).rejects.toThrow('Trace reply cache operation failed.');
		put.mockRestore();
		expect((await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).map((reply) => reply.id)).toEqual([old.parsed.id]);
	});

	it('does not report success or leave partial state when the transaction aborts after writes', async () => {
		const root = makeRoot(CHANNEL_ID, 'abort');
		await seedRootForChannel(CHANNEL_ID, root);
		const old = makeReply(root.parsed, root.parsed, 'abort old', 101);
		const next = makeReply(root.parsed, root.parsed, 'abort next', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [old.raw] });
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			if ((value as { eventId?: string }).eventId === next.parsed.id) {
				request.addEventListener('success', () => this.transaction.abort());
			}
			return request;
		});
		await expect(reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [next.raw]
		})).rejects.toThrow('Trace reply cache operation failed.');
		put.mockRestore();
		expect((await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).map((reply) => reply.id)).toEqual([old.parsed.id]);
	});

	it('does not persist replies or LRU metadata for an evicted root supplied by a stale caller', async () => {
		const old = makeRoot(CHANNEL_ID, 'stale-old', 100);
		const next = makeRoot(CHANNEL_ID, 'stale-next', 101);
		await seedRootForChannel(CHANNEL_ID, old);
		const reply = makeReply(old.parsed, old.parsed, 'stale reply', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [old.parsed], rawEvents: [reply.raw] });
		expect(await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: old.parsed.id })).toBe(true);
		await seedRootForChannel(CHANNEL_ID, next);
		expect(await replyRecords()).toEqual([]);
		expect(await lruRecords()).toEqual([]);
		expect(await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [old.parsed], rawEvents: [reply.raw]
		})).toEqual([]);
		expect(await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: old.parsed.id })).toBe(false);
		expect(await replyRecords()).toEqual([]);
		expect(await lruRecords()).toEqual([]);
	});

	it('keeps 1000 replies across two channels without a per-root quota, then evicts the deterministic oldest tree', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		await seedRootForChannel(OTHER_CHANNEL_ID, capOtherRoot);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: capReplies.slice(0, 600).map((reply) => reply.raw)
		});
		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID, effectiveRoots: [capOtherRoot.parsed], rawEvents: capOtherReplies.slice(0, 400).map((reply) => reply.raw)
		});
		let records = await replyRecords();
		expect(records).toHaveLength(1000);
		expect(records.filter((record) => record.channelId === CHANNEL_ID)).toHaveLength(600);
		expect(records.filter((record) => record.channelId === OTHER_CHANNEL_ID)).toHaveLength(400);

		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID, effectiveRoots: [capOtherRoot.parsed], rawEvents: [capOtherReplies[400].raw]
		});
		records = await replyRecords();
		expect(records).toHaveLength(401);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([OTHER_CHANNEL_ID]));
	}, 20_000);

	it('uses persistent touches for LRU priority', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		await seedRootForChannel(OTHER_CHANNEL_ID, capOtherRoot);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: capReplies.slice(0, 600).map((reply) => reply.raw)
		});
		expect(await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: capRoot.parsed.id })).toBe(true);
		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID, effectiveRoots: [capOtherRoot.parsed], rawEvents: capOtherReplies.map((reply) => reply.raw)
		});
		const records = await replyRecords();
		expect(records).toHaveLength(600);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([CHANNEL_ID]));
		expect(await lruRecords()).toEqual([expect.objectContaining({ rootId: capRoot.parsed.id, accessOrder: 1 })]);
	}, 20_000);

	it('protects the current open root while another tree can be evicted', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		await seedRootForChannel(OTHER_CHANNEL_ID, capOtherRoot);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: capReplies.slice(0, 599).map((reply) => reply.raw)
		});
		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID,
			effectiveRoots: [capOtherRoot.parsed],
			rawEvents: capOtherReplies.map((reply) => reply.raw)
		});
		await touchTraceReplyTree({ channelId: OTHER_CHANNEL_ID, rootId: capOtherRoot.parsed.id });
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID,
			effectiveRoots: [capRoot.parsed],
			rawEvents: [capReplies[599].raw],
			currentOpenRootId: capRoot.parsed.id
		});
		const records = await replyRecords();
		expect(records).toHaveLength(600);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([CHANNEL_ID]));
	}, 20_000);

	it('trims a single oversized tree by deterministic leaves without leaving an orphan', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		const eligibleLeaves = capReplies.filter((reply) => reply.parsed.id !== capReplies[999].parsed.id);
		const expectedEvicted = [...eligibleLeaves].sort((first, second) =>
			first.parsed.id < second.parsed.id ? -1 : first.parsed.id > second.parsed.id ? 1 : 0
		)[0];
		const result = await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: capReplies.map((reply) => reply.raw),
			currentOpenRootId: capRoot.parsed.id
		});
		expect(result).toHaveLength(1000);
		expect(result.some((reply) => reply.id === expectedEvicted.parsed.id)).toBe(false);
		const kept = new Set(result.map((reply) => reply.id));
		for (const reply of result) {
			if (reply.parentKind === 1111) expect(kept.has(reply.parentId)).toBe(true);
		}
		expect(await replyRecords()).toHaveLength(1000);
	}, 20_000);

	it('aborts root eviction cleanup atomically when a reply deletion fails', async () => {
		const old = makeRoot(CHANNEL_ID, 'atomic-old', 100);
		const next = makeRoot(CHANNEL_ID, 'atomic-next', 101);
		await seedRootForChannel(CHANNEL_ID, old);
		const reply = makeReply(old.parsed, old.parsed, 'atomic reply', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [old.parsed], rawEvents: [reply.raw] });
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: old.parsed.id });
		const originalDelete = IDBObjectStore.prototype.delete;
		const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
			if (this.name === TRACE_REPLY_STORE) throw new DOMException('Simulated delete failure.', 'AbortError');
			return originalDelete.call(this, key);
		});
		await expect(seedRootForChannel(CHANNEL_ID, next)).rejects.toThrow('Trace root cache operation failed.');
		deletion.mockRestore();
		const db = await database();
		expect(await db.get(TRACE_ROOT_STORE, [CHANNEL_ID, old.parsed.id])).toBeDefined();
		expect(await db.get(TRACE_ROOT_STORE, [CHANNEL_ID, next.parsed.id])).toBeUndefined();
		expect(await replyRecords()).toHaveLength(1);
		expect(await lruRecords()).toHaveLength(1);
	});
});
