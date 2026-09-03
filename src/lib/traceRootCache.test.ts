import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	type ChannelReference
} from './nostrProtocol';
import { reconcileTraceRootCache } from './traceRootCache';

const DATABASE_NAME = 'persona-bubble-field-trace';
const STORE_NAME = 'trace-roots';
const CHANNEL_ID = 'a'.repeat(64);
const OTHER_CHANNEL_ID = 'b'.repeat(64);
const SECRET_KEY = new Uint8Array(32).fill(8);
const connections: IDBPDatabase[] = [];

function channel(channelId = CHANNEL_ID): ChannelReference {
	return { channelId, relayHint: 'wss://relay.example.com' };
}

function root(
	options: Partial<{
		channelId: string;
		createdAt: number;
		position: { x: number; y: number };
		nonce: string;
	}> = {}
) {
	return finalizeWorldEvent(buildWorldMessageTemplate({
		channel: channel(options.channelId),
		content: options.nonce ?? 'root',
		createdAt: options.createdAt ?? 100,
		position: options.position ?? { x: 0, y: 0 },
		speechType: 'normal'
	}), SECRET_KEY);
}

function lotteryRoot(options: Parameters<typeof root>[0] = {}, wins = true) {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const event = root({ ...options, nonce: `${options.nonce ?? 'root'}-${attempt}` });
		if ((BigInt(`0x${event.id}`) % 5n === 0n) === wins) return event;
	}
	throw new Error('Could not make a deterministic lottery fixture.');
}

async function database(): Promise<IDBPDatabase> {
	const db = await openDB(DATABASE_NAME, 1, {
		upgrade(db) { db.createObjectStore(STORE_NAME, { keyPath: ['channelId', 'eventId'] }); }
	});
	connections.push(db);
	return db;
}

async function records(channelId = CHANNEL_ID): Promise<unknown[]> {
	const db = await database();
	const range = IDBKeyRange.bound([channelId, ''], [channelId, '\uffff']);
	return db.getAll(STORE_NAME, range);
}

async function seed(channelId: string, eventId: string, rawEvent: unknown): Promise<void> {
	const db = await database();
	await db.put(STORE_NAME, { channelId, eventId, rawEvent });
}

async function seedRecord(record: unknown): Promise<void> {
	const db = await database();
	const tx = db.transaction(STORE_NAME, 'readwrite');
	await tx.store.put(record as never);
	await tx.done;
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
	while (connections.length) connections.pop()!.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('trace root cache reconciliation', () => {
	it('creates an empty cache, stores raw events, and restores them after reload', async () => {
		const event = lotteryRoot({ nonce: 'persist' });
		const input = { channelId: CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: [event] };
		expect((await reconcileTraceRootCache(input)).map((root) => root.id)).toEqual([event.id]);
		const stored = await records();
		expect(stored).toEqual([expect.objectContaining({
			channelId: CHANNEL_ID, eventId: event.id, rawEvent: expect.objectContaining({ id: event.id })
		})]);
		expect((await reconcileTraceRootCache({ ...input, rawEvents: [] })).map((root) => root.id)).toEqual([event.id]);
	});

	it('revalidates persisted raw events and cleans malformed, invalid, and unrelated records', async () => {
		const valid = lotteryRoot({ nonce: 'valid' });
		const tampered = { ...valid, content: 'changed after signing' };
		const wrongChannel = lotteryRoot({ channelId: OTHER_CHANNEL_ID, nonce: 'other-channel' });
		const outside = lotteryRoot({ position: { x: 2, y: 0 }, nonce: 'outside' });
		const loser = lotteryRoot({ nonce: 'loser' }, false);
		await seed(CHANNEL_ID, valid.id, tampered);
		await seed(CHANNEL_ID, wrongChannel.id, wrongChannel);
		await seed(CHANNEL_ID, outside.id, outside);
		await seed(CHANNEL_ID, loser.id, loser);
		await seed(CHANNEL_ID, 'c'.repeat(64), null);

		expect(await reconcileTraceRootCache({
			channelId: CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: []
		})).toEqual([]);
		expect(await records()).toEqual([]);
	});

	it('keeps cached roots omitted by a later bootstrap while capacity remains', async () => {
		const old = lotteryRoot({ createdAt: 1, position: { x: 0, y: 0 }, nonce: 'old' });
		const next = lotteryRoot({ createdAt: 2, position: { x: 1, y: 0 }, nonce: 'next' });
		const field = { columns: 4, rows: 1 };
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [old] });
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [next] }))
			.map((root) => root.id)).toEqual([next.id, old.id]);
	});

	it('evicts the oldest cached root when a new root exceeds the per-cell cap', async () => {
		const roots = [1, 2, 3, 4].map((createdAt) =>
			lotteryRoot({ createdAt, position: { x: 0, y: 0 }, nonce: `cell-${createdAt}` })
		);
		const field = { columns: 8, rows: 1 };
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: roots.slice(0, 3) });
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [roots[3]] }))
			.map((root) => root.id)).toEqual([roots[3].id, roots[2].id, roots[1].id]);
	});

	it('evicts the oldest cached root when a new root exceeds the global cap', async () => {
		const roots = [1, 2, 3].map((createdAt) =>
			lotteryRoot({ createdAt, position: { x: createdAt - 1, y: 0 }, nonce: `global-${createdAt}` })
		);
		const field = { columns: 4, rows: 1 };
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: roots.slice(0, 2) });
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [roots[2]] }))
			.map((root) => root.id)).toEqual([roots[2].id, roots[1].id]);
	});

	it('does not modify another channel partition', async () => {
		const first = lotteryRoot({ nonce: 'first' });
		const other = lotteryRoot({ channelId: OTHER_CHANNEL_ID, nonce: 'other' });
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: [first] });
		await reconcileTraceRootCache({ channelId: OTHER_CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: [other] });
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: [] });
		expect((await reconcileTraceRootCache({
			channelId: OTHER_CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: []
		})).map((root) => root.id)).toEqual([other.id]);
	});

	it('cleans a same-channel non-string compound-key record without touching another channel', async () => {
		const other = lotteryRoot({ channelId: OTHER_CHANNEL_ID, nonce: 'other-key-partition' });
		await seedRecord({ channelId: CHANNEL_ID, eventId: 123, rawEvent: null });
		await seed(OTHER_CHANNEL_ID, other.id, other);

		expect(await reconcileTraceRootCache({
			channelId: CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: []
		})).toEqual([]);

		const db = await database();
		const allKeys = await db.getAllKeys(STORE_NAME);
		expect(allKeys).toEqual([[OTHER_CHANNEL_ID, other.id]]);
		expect((await reconcileTraceRootCache({
			channelId: OTHER_CHANNEL_ID, field: { columns: 2, rows: 1 }, rawEvents: []
		})).map((root) => root.id)).toEqual([other.id]);
	});

	it('serializes concurrent reconciliations without losing either valid update', async () => {
		const first = lotteryRoot({ createdAt: 1, position: { x: 0, y: 0 }, nonce: 'parallel-first' });
		const second = lotteryRoot({ createdAt: 2, position: { x: 1, y: 0 }, nonce: 'parallel-second' });
		const field = { columns: 4, rows: 1 };
		await Promise.all([
			reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [first] }),
			reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [second] })
		]);
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [] }))
			.map((root) => root.id)).toEqual([second.id, first.id]);
	});

	it('rejects an invalid channel ID before attempting IndexedDB access', async () => {
		vi.stubGlobal('indexedDB', new Proxy({}, { get() { throw new Error('Unexpected storage access.'); } }));
		await expect(reconcileTraceRootCache({
			channelId: 'A'.repeat(64), field: { columns: 1, rows: 1 }, rawEvents: []
		})).rejects.toThrow(TypeError);
	});

	it('rejects failed writes and leaves the previous snapshot intact', async () => {
		const old = lotteryRoot({ createdAt: 1, nonce: 'old' });
		const next = lotteryRoot({ createdAt: 2, nonce: 'next' });
		const field = { columns: 2, rows: 1 };
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [old] });
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if ((value as { eventId?: string }).eventId === next.id) {
				throw new DOMException('Simulated write failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [next] }))
			.rejects.toThrow('Trace root cache operation failed.');
		put.mockRestore();
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [] }))
			.map((root) => root.id)).toEqual([old.id]);
	});

	it('does not report success when a transaction aborts after writes', async () => {
		const old = lotteryRoot({ createdAt: 1, nonce: 'abort-old' });
		const next = lotteryRoot({ createdAt: 2, nonce: 'abort-next' });
		const field = { columns: 2, rows: 1 };
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [old] });
		const originalPut = IDBObjectStore.prototype.put;
		const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			const request = originalPut.call(this, value, key);
			if ((value as { eventId?: string }).eventId === next.id) {
				request.addEventListener('success', () => this.transaction.abort());
			}
			return request;
		});
		await expect(reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [next] }))
			.rejects.toThrow('Trace root cache operation failed.');
		put.mockRestore();
		expect((await reconcileTraceRootCache({ channelId: CHANNEL_ID, field, rawEvents: [] }))
			.map((root) => root.id)).toEqual([old.id]);
	});
});
