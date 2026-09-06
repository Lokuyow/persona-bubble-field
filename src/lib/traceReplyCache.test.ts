import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import type { Event } from 'nostr-tools/pure';
import { matchFilter } from 'nostr-tools/filter';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildTraceReplyTemplate,
	buildTraceDirectReplyFilter,
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
import { loadTracePreviewEvent, reconcileTraceReplyCache, touchTraceReplyTree } from './traceReplyCache';
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
		root, parent, content, createdAt, speechType: 'normal'
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

async function seedRootForChannel(channelId: string, root: RootFixture, field = { columns: 20, rows: 1 }): Promise<void> {
	await reconcileTraceRootCache({ channelId, field, rawEvents: [root.raw] });
}

async function replyRecords() {
	return (await database()).getAll(TRACE_REPLY_STORE);
}

async function lruRecords() {
	return (await database()).getAll(TRACE_REPLY_LRU_STORE);
}

function observeWrites() {
	const writes: Array<{ store: string; operation: 'delete' | 'put'; key: unknown }> = [];
	const originalPut = IDBObjectStore.prototype.put;
	const originalDelete = IDBObjectStore.prototype.delete;
	vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
		const record = value as Record<string, unknown>;
		writes.push({ store: this.name, operation: 'put', key: (this.keyPath as string[]).map((field) => record[field]) });
		return originalPut.call(this, value, key);
	});
	vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
		writes.push({ store: this.name, operation: 'delete', key });
		return originalDelete.call(this, key);
	});
	return writes;
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
	it('rejects a signed wrong-root candidate matching the direct query even when both roots are effective', async () => {
		const root = capRoot;
		const otherRoot = makeRoot(CHANNEL_ID, 'other-effective-root');
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 20, rows: 1 }, rawEvents: [root.raw, otherRoot.raw] });
		const valid = capReplies[0];
		const template = buildTraceReplyTemplate({
			root: root.parsed, parent: root.parsed, content: 'wrong tree', createdAt: 201,
			speechType: 'normal'
		});
		// The lower-case parent remains root A; the upper-case root claims B.
		template.tags = template.tags.map((tag) => tag[0] === 'E' ? ['E', otherRoot.raw.id, '', otherRoot.raw.pubkey] : tag);
		const wrong = finalizeWorldEvent(template, SECRET_KEY);
		expect(parseTraceReplyCandidate(wrong)).not.toBeNull();
		expect(matchFilter(buildTraceDirectReplyFilter({ currentId: root.raw.id }), wrong)).toBe(true);
		const result = await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed, otherRoot.parsed], rawEvents: [wrong, valid.raw]
		});
		expect(result.map((reply) => reply.id)).toEqual([valid.raw.id]);
		expect((await replyRecords()).map((record) => record.eventId)).toEqual([valid.raw.id]);
	});

	it('hydrates accepted root and nested reply previews from signed records without writes', async () => {
		const root = capRoot;
		const parent = capReplies[999];
		const child = capReplies[1000];
		await seedRootForChannel(CHANNEL_ID, root);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [parent.raw, child.raw] });
		const writes = observeWrites();
		expect(await loadTracePreviewEvent({ channelId: CHANNEL_ID, root: root.parsed, target: root.parsed, parent: root.parsed })).toEqual(root.raw);
		expect(await loadTracePreviewEvent({ channelId: CHANNEL_ID, root: root.parsed, target: child.parsed, parent: parent.parsed })).toEqual(child.raw);
		expect(await loadTracePreviewEvent({ channelId: CHANNEL_ID, root: root.parsed, target: child.parsed, parent: root.parsed })).toBeNull();
		expect(await loadTracePreviewEvent({ channelId: CHANNEL_ID, root: root.parsed, target: capReplies[0].parsed, parent: root.parsed })).toBeNull();
		expect(writes).toEqual([]);
	});

	it('rejects corrupt preview signatures and evicted records without repairing persistence', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: [capReplies[0].raw] });
		const db = await database();
		const key = [CHANNEL_ID, capRoot.parsed.id, capReplies[0].parsed.id] as [string, string, string];
		const record = (await db.get(TRACE_REPLY_STORE, key))!;
		await db.put(TRACE_REPLY_STORE, { ...record, rawEvent: { ...capReplies[0].raw, sig: '0'.repeat(128) } });
		const writes = observeWrites();
		const input = { channelId: CHANNEL_ID, root: capRoot.parsed, target: capReplies[0].parsed, parent: capRoot.parsed };
		expect(await loadTracePreviewEvent(input)).toBeNull();
		expect(writes).toEqual([]);
		await db.delete(TRACE_REPLY_STORE, key);
		expect(await loadTracePreviewEvent(input)).toBeNull();
	});

	it('performs no writes for unchanged or duplicate persisted replies and LRU', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		const input = { channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: [] as Event[] };
		const snapshot = await reconcileTraceReplyCache({ ...input, rawEvents: capReplies.slice(0, 100).map((reply) => reply.raw) });
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: capRoot.parsed.id });
		const records = await replyRecords();
		const lru = await lruRecords();
		const writes = observeWrites();
		expect(await reconcileTraceReplyCache(input)).toEqual(snapshot);
		expect(writes).toEqual([]);
		expect(await reconcileTraceReplyCache({ ...input, rawEvents: records.map((record) => structuredClone(record.rawEvent) as Event) })).toEqual(snapshot);
		expect(writes).toEqual([]);
		expect(await replyRecords()).toEqual(records);
		expect(await lruRecords()).toEqual(lru);
	});

	it('writes only the added reply among 100 persisted replies', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		const input = { channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: [] as Event[] };
		await reconcileTraceReplyCache({ ...input, rawEvents: capReplies.slice(0, 100).map((reply) => reply.raw) });
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: capRoot.parsed.id });
		const writes = observeWrites();
		const snapshot = await reconcileTraceReplyCache({ ...input, rawEvents: [capReplies[100].raw] });
		expect(snapshot).toHaveLength(101);
		expect(new Set(snapshot.map((reply) => reply.id))).toEqual(new Set(capReplies.slice(0, 101).map((reply) => reply.parsed.id)));
		expect(writes).toEqual([{ store: TRACE_REPLY_STORE, operation: 'put', key: [CHANNEL_ID, capRoot.parsed.id, capReplies[100].parsed.id] }]);
		writes.length = 0;
		expect(await reconcileTraceReplyCache(input)).toEqual(snapshot);
		expect(writes).toEqual([]);
	});

	it('returns the full current-channel snapshot across two effective roots', async () => {
		const firstRoot = makeRoot(CHANNEL_ID, 'first-root');
		const secondRoot = makeRoot(CHANNEL_ID, 'second-root');
		await reconcileTraceRootCache({
			channelId: CHANNEL_ID,
			field: { columns: 20, rows: 1 },
			rawEvents: [firstRoot.raw, secondRoot.raw]
		});
		const firstReply = makeReply(firstRoot.parsed, firstRoot.parsed, 'first reply', 101);
		const secondReply = makeReply(secondRoot.parsed, secondRoot.parsed, 'second reply', 102);

		const replies = await reconcileTraceReplyCache({
			channelId: CHANNEL_ID,
			effectiveRoots: [firstRoot.parsed, secondRoot.parsed],
			rawEvents: [firstReply.raw, secondReply.raw]
		});

		expect(new Set(replies.map((reply) => reply.rootId))).toEqual(new Set([
			firstRoot.parsed.id,
			secondRoot.parsed.id
		]));
		expect(replies.map((reply) => reply.id)).toHaveLength(2);
	});

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

	it('repairs only changed reply and LRU envelopes and a corrupt same-key raw event', async () => {
		const root = makeRoot(CHANNEL_ID, 'repair');
		await seedRootForChannel(CHANNEL_ID, root);
		const replies = [makeReply(root.parsed, root.parsed, 'repair raw', 101), makeReply(root.parsed, root.parsed, 'repair envelope', 102)];
		const input = { channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: replies.map((reply) => reply.raw) };
		const snapshot = await reconcileTraceReplyCache(input);
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: root.parsed.id });
		const db = await database();
		const records = await replyRecords();
		const rawRecord = records.find((record) => record.eventId === replies[0].parsed.id)!;
		const envelopeRecord = records.find((record) => record.eventId === replies[1].parsed.id)!;
		await db.put(TRACE_REPLY_STORE, { ...rawRecord, rawEvent: { ...replies[0].raw, content: 'tampered' } });
		const extraRaw = { ...replies[1].raw, relayMetadata: { source: 'stored' } };
		await db.put(TRACE_REPLY_STORE, Object.assign({ ...envelopeRecord, rawEvent: extraRaw }, { obsolete: true }));
		await db.put(TRACE_REPLY_LRU_STORE, Object.assign({ channelId: CHANNEL_ID, rootId: root.parsed.id, accessOrder: 1 }, { obsolete: true }));
		const writes = observeWrites();
		expect(await reconcileTraceReplyCache(input)).toEqual(snapshot);
		expect(writes).toHaveLength(3);
		expect(writes).toEqual(expect.arrayContaining([
			...replies.map((reply) => ({ store: TRACE_REPLY_STORE, operation: 'put', key: [CHANNEL_ID, root.parsed.id, reply.parsed.id] })),
			{ store: TRACE_REPLY_LRU_STORE, operation: 'put', key: [CHANNEL_ID, root.parsed.id] }
		]));
		expect(await db.get(TRACE_REPLY_STORE, [CHANNEL_ID, root.parsed.id, envelopeRecord.eventId])).toEqual({ ...envelopeRecord, rawEvent: structuredClone(extraRaw) });
		expect(await lruRecords()).toEqual([{ channelId: CHANNEL_ID, rootId: root.parsed.id, accessOrder: 1 }]);
		writes.length = 0;
		expect(await reconcileTraceReplyCache({ ...input, rawEvents: [] })).toEqual(snapshot);
		expect(writes).toEqual([]);
	});

	it('deletes malformed keys and invalid LRU while retaining an empty effective tree touch', async () => {
		const root = makeRoot(CHANNEL_ID, 'empty touched');
		await seedRootForChannel(CHANNEL_ID, root);
		await seedRootForChannel(OTHER_CHANNEL_ID, capOtherRoot);
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: root.parsed.id });
		const db = await database();
		await db.put(TRACE_REPLY_STORE, { channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: 7 as unknown as string, rawEvent: null });
		await db.put(TRACE_REPLY_LRU_STORE, { channelId: CHANNEL_ID, rootId: 7 as unknown as string, accessOrder: 1 });
		await db.put(TRACE_REPLY_LRU_STORE, { channelId: OTHER_CHANNEL_ID, rootId: capOtherRoot.parsed.id, accessOrder: -1 });
		await db.put(TRACE_REPLY_LRU_STORE, { channelId: CHANNEL_ID, rootId: 'e'.repeat(64), accessOrder: 2 });
		const writes = observeWrites();
		expect(await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [] })).toEqual([]);
		expect(writes).toHaveLength(4);
		expect(writes).toEqual(expect.arrayContaining([
			{ store: TRACE_REPLY_STORE, operation: 'delete', key: [CHANNEL_ID, root.parsed.id, 7] },
			{ store: TRACE_REPLY_LRU_STORE, operation: 'delete', key: [OTHER_CHANNEL_ID, capOtherRoot.parsed.id] },
			...[7, 'e'.repeat(64)].map((rootId) => ({ store: TRACE_REPLY_LRU_STORE, operation: 'delete', key: [CHANNEL_ID, rootId] }))
		]));
		expect(await replyRecords()).toEqual([]);
		expect(await lruRecords()).toEqual([{ channelId: CHANNEL_ID, rootId: root.parsed.id, accessOrder: 1 }]);
	});

	it('cleans corrupt raw replies and their broken orphan descendants without rewriting survivors', async () => {
		const root = makeRoot(CHANNEL_ID, 'corrupt');
		await seedRootForChannel(CHANNEL_ID, root);
		const parent = makeReply(root.parsed, root.parsed, 'parent', 101);
		const child = makeReply(root.parsed, parent.parsed, 'child', 102);
		const survivor = makeReply(root.parsed, root.parsed, 'survivor', 103);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [parent.raw, child.raw, survivor.raw]
		});
		const db = await database();
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: parent.parsed.id,
			rawEvent: { ...parent.raw, content: 'tampered' }
		});
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: 'f'.repeat(64), rawEvent: null
		});
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: 'e'.repeat(64), rawEvent: survivor.raw
		});
		await db.put(TRACE_REPLY_STORE, {
			channelId: CHANNEL_ID, rootId: 'd'.repeat(64), eventId: survivor.parsed.id, rawEvent: survivor.raw
		});
		const writes = observeWrites();
		expect(await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: []
		})).toEqual([survivor.parsed]);
		expect(writes).toHaveLength(5);
		expect(writes).toEqual(expect.arrayContaining([
			...[parent.parsed.id, child.parsed.id, 'f'.repeat(64), 'e'.repeat(64)].map((eventId) => ({ store: TRACE_REPLY_STORE, operation: 'delete', key: [CHANNEL_ID, root.parsed.id, eventId] })),
			{ store: TRACE_REPLY_STORE, operation: 'delete', key: [CHANNEL_ID, 'd'.repeat(64), survivor.parsed.id] }
		]));
		expect(await replyRecords()).toEqual([expect.objectContaining({ eventId: survivor.parsed.id })]);
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

	it('rolls back mixed reply deletes and puts when a later LRU repair fails', async () => {
		const root = makeRoot(CHANNEL_ID, 'rollback');
		await seedRootForChannel(CHANNEL_ID, root);
		const old = makeReply(root.parsed, root.parsed, 'old', 101);
		const next = makeReply(root.parsed, root.parsed, 'next', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [old.raw] });
		const db = await database();
		await db.put(TRACE_REPLY_STORE, { channelId: CHANNEL_ID, rootId: root.parsed.id, eventId: 'f'.repeat(64), rawEvent: null });
		await db.put(TRACE_REPLY_LRU_STORE, Object.assign({ channelId: CHANNEL_ID, rootId: root.parsed.id, accessOrder: 1 }, { obsolete: true }));
		const beforeReplies = await replyRecords();
		const beforeLru = await lruRecords();
		const beforeKeys = await db.getAllKeys(TRACE_REPLY_STORE);
		const writes = observeWrites();
		const originalPut = vi.mocked(IDBObjectStore.prototype.put).getMockImplementation()!;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (this.name === TRACE_REPLY_LRU_STORE) {
				throw new DOMException('Simulated write failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [next.raw]
		})).rejects.toThrow('Trace reply cache operation failed.');
		put.mockRestore();
		expect(writes).toEqual([
			{ store: TRACE_REPLY_STORE, operation: 'delete', key: [CHANNEL_ID, root.parsed.id, 'f'.repeat(64)] },
			{ store: TRACE_REPLY_STORE, operation: 'put', key: [CHANNEL_ID, root.parsed.id, next.parsed.id] }
		]);
		expect(await replyRecords()).toEqual(beforeReplies);
		expect(await lruRecords()).toEqual(beforeLru);
		expect(await db.getAllKeys(TRACE_REPLY_STORE)).toEqual(beforeKeys);
	});

	it('does not report success or leave partial state when the transaction aborts after writes', async () => {
		const root = makeRoot(CHANNEL_ID, 'abort');
		await seedRootForChannel(CHANNEL_ID, root);
		const old = makeReply(root.parsed, root.parsed, 'abort old', 101);
		const next = makeReply(root.parsed, root.parsed, 'abort next', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root.parsed], rawEvents: [old.raw] });
		const beforeReplies = await replyRecords();
		const beforeLru = await lruRecords();
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
		expect(await replyRecords()).toEqual(beforeReplies);
		expect(await lruRecords()).toEqual(beforeLru);
	});

	it('does not persist replies or LRU metadata for an evicted root supplied by a stale caller', async () => {
		const old = makeRoot(CHANNEL_ID, 'stale-old', 100);
		const next = makeRoot(CHANNEL_ID, 'stale-next', 101);
		await seedRootForChannel(CHANNEL_ID, old, { columns: 10, rows: 1 });
		const reply = makeReply(old.parsed, old.parsed, 'stale reply', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [old.parsed], rawEvents: [reply.raw] });
		expect(await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: old.parsed.id })).toBe(true);
		await seedRootForChannel(CHANNEL_ID, next, { columns: 10, rows: 1 });
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

		const writes = observeWrites();
		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID, effectiveRoots: [capOtherRoot.parsed], rawEvents: [capOtherReplies[400].raw]
		});
		records = await replyRecords();
		expect(records).toHaveLength(401);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([OTHER_CHANNEL_ID]));
		expect(writes.filter((write) => write.operation === 'delete')).toHaveLength(600);
		expect(writes.filter((write) => write.operation === 'delete').every((write) => write.store === TRACE_REPLY_STORE && (write.key as string[])[0] === CHANNEL_ID)).toBe(true);
		expect(writes.filter((write) => write.operation === 'put')).toEqual([
			{ store: TRACE_REPLY_STORE, operation: 'put', key: [OTHER_CHANNEL_ID, capOtherRoot.parsed.id, capOtherReplies[400].parsed.id] }
		]);
	}, 20_000);

	it('uses persistent touches for LRU priority', async () => {
		await seedRootForChannel(CHANNEL_ID, capRoot);
		await seedRootForChannel(OTHER_CHANNEL_ID, capOtherRoot);
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID, effectiveRoots: [capRoot.parsed], rawEvents: capReplies.slice(0, 600).map((reply) => reply.raw)
		});
		expect(await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: capRoot.parsed.id })).toBe(true);
		const writes = observeWrites();
		await reconcileTraceReplyCache({
			channelId: OTHER_CHANNEL_ID, effectiveRoots: [capOtherRoot.parsed], rawEvents: capOtherReplies.map((reply) => reply.raw)
		});
		const records = await replyRecords();
		expect(records).toHaveLength(600);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([CHANNEL_ID]));
		expect(await lruRecords()).toEqual([expect.objectContaining({ rootId: capRoot.parsed.id, accessOrder: 1 })]);
		expect(writes).toEqual([]);
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
		const writes = observeWrites();
		await reconcileTraceReplyCache({
			channelId: CHANNEL_ID,
			effectiveRoots: [capRoot.parsed],
			rawEvents: [capReplies[599].raw],
			currentOpenRootId: capRoot.parsed.id
		});
		const records = await replyRecords();
		expect(records).toHaveLength(600);
		expect(new Set(records.map((record) => record.channelId))).toEqual(new Set([CHANNEL_ID]));
		expect(writes.filter((write) => write.operation === 'delete')).toHaveLength(402);
		expect(writes.filter((write) => write.operation === 'delete').every((write) => (write.key as string[])[0] === OTHER_CHANNEL_ID)).toBe(true);
		expect(writes.filter((write) => write.store === TRACE_REPLY_LRU_STORE)).toEqual([
			{ store: TRACE_REPLY_LRU_STORE, operation: 'delete', key: [OTHER_CHANNEL_ID, capOtherRoot.parsed.id] }
		]);
		expect(writes.filter((write) => write.operation === 'put')).toEqual([
			{ store: TRACE_REPLY_STORE, operation: 'put', key: [CHANNEL_ID, capRoot.parsed.id, capReplies[599].parsed.id] }
		]);
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
		await seedRootForChannel(CHANNEL_ID, old, { columns: 10, rows: 1 });
		const reply = makeReply(old.parsed, old.parsed, 'atomic reply', 102);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [old.parsed], rawEvents: [reply.raw] });
		await touchTraceReplyTree({ channelId: CHANNEL_ID, rootId: old.parsed.id });
		const originalDelete = IDBObjectStore.prototype.delete;
		const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
			if (this.name === TRACE_REPLY_STORE) throw new DOMException('Simulated delete failure.', 'AbortError');
			return originalDelete.call(this, key);
		});
		await expect(seedRootForChannel(CHANNEL_ID, next, { columns: 10, rows: 1 })).rejects.toThrow('Trace root cache operation failed.');
		deletion.mockRestore();
		const db = await database();
		expect(await db.get(TRACE_ROOT_STORE, [CHANNEL_ID, old.parsed.id])).toBeDefined();
		expect(await db.get(TRACE_ROOT_STORE, [CHANNEL_ID, next.parsed.id])).toBeUndefined();
		expect(await replyRecords()).toHaveLength(1);
		expect(await lruRecords()).toHaveLength(1);
	});
});
