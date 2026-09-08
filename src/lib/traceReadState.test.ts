import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTraceReplyTemplate, buildWorldMessageTemplate, finalizeWorldEvent, parseWorldMessage, type ChannelReference } from './nostrProtocol';
import { openTraceDatabase, TRACE_DATABASE_NAME, TRACE_REPLY_READ_STORE, TRACE_REPLY_STORE, TRACE_ROOT_READ_STORE, TRACE_ROOT_STORE } from './traceDatabase';
import { reconcileTraceReplyCache } from './traceReplyCache';
import { reconcileTraceRootCache } from './traceRootCache';
import { loadTraceReadSnapshot, markTraceReplyRead, markTraceRootRead, setTraceReplyReadState } from './traceReadState';

const CHANNEL_ID = 'a'.repeat(64);
const PERSONA_SECRET = new Uint8Array(32).fill(4);
const OTHER_SECRET = new Uint8Array(32).fill(5);
const PERSONA = getPublicKey(PERSONA_SECRET);

function channel(): ChannelReference { return { channelId: CHANNEL_ID, relayHint: 'wss://relay.example.com' }; }

function traceRoot(secretKey = PERSONA_SECRET, createdAt = 100) {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const event = finalizeWorldEvent(buildWorldMessageTemplate({
			channel: channel(), content: `root-${attempt}`, createdAt, position: { x: 0, y: 0 }, speechType: 'normal'
		}), secretKey);
		if (BigInt(`0x${event.id}`) % 5n === 0n) return event;
	}
	throw new Error('Could not make a trace root.');
}

async function rootAndReply() {
	const rootRaw = traceRoot();
	const root = parseWorldMessage(rootRaw, CHANNEL_ID)!;
	const reply = finalizeWorldEvent(buildTraceReplyTemplate({
		root, parent: root, content: 'reply', speechType: 'normal', createdAt: 101
	}), OTHER_SECRET);
	await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 }, rawEvents: [rootRaw] });
	await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root], rawEvents: [reply], personaPubkey: PERSONA });
	return { rootRaw, root, reply };
}

describe('Trace read state', () => {
	beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('upgrades v2 additively and keeps root, reply, and LRU records', async () => {
		const v2 = await openDB(TRACE_DATABASE_NAME, 2, {
			upgrade(db) {
				db.createObjectStore(TRACE_ROOT_STORE, { keyPath: ['channelId', 'eventId'] });
				db.createObjectStore(TRACE_REPLY_STORE, { keyPath: ['channelId', 'rootId', 'eventId'] });
				db.createObjectStore('trace-reply-lru', { keyPath: ['channelId', 'rootId'] });
			}
		});
		await v2.put(TRACE_ROOT_STORE, { channelId: CHANNEL_ID, eventId: 'b'.repeat(64), rawEvent: { legacy: true } });
		await v2.put(TRACE_REPLY_STORE, { channelId: CHANNEL_ID, rootId: 'b'.repeat(64), eventId: 'c'.repeat(64), rawEvent: { legacy: true } });
		await v2.put('trace-reply-lru', { channelId: CHANNEL_ID, rootId: 'b'.repeat(64), accessOrder: 1 });
		v2.close();
		const upgraded = await openTraceDatabase();
		expect(upgraded.version).toBe(3);
		expect(await upgraded.get(TRACE_ROOT_STORE, [CHANNEL_ID, 'b'.repeat(64)])).toBeTruthy();
		expect(await upgraded.get(TRACE_REPLY_STORE, [CHANNEL_ID, 'b'.repeat(64), 'c'.repeat(64)])).toBeTruthy();
		expect(await upgraded.get('trace-reply-lru', [CHANNEL_ID, 'b'.repeat(64)])).toBeTruthy();
		expect([...upgraded.objectStoreNames]).toEqual(expect.arrayContaining([TRACE_ROOT_READ_STORE, TRACE_REPLY_READ_STORE]));
		upgraded.close();
	});

	it('keeps root reads browser-person scoped while separating reply state by persona', async () => {
		const { root, reply } = await rootAndReply();
		await markTraceRootRead({ channelId: CHANNEL_ID, personaPubkey: PERSONA, rootId: root.id });
		await markTraceReplyRead({ channelId: CHANNEL_ID, personaPubkey: PERSONA, rootId: root.id, replyId: reply.id });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: '6'.repeat(64) })).readRootIds).toEqual([root.id]);
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: '6'.repeat(64) })).hasUnreadReplies).toBe(false);
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).hasUnreadReplies).toBe(false);
		await setTraceReplyReadState({ channelId: CHANNEL_ID, personaPubkey: '6'.repeat(64), rootId: root.id, replyId: reply.id, state: 'unread' });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: '6'.repeat(64) })).hasUnreadReplies).toBe(true);
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root], rawEvents: [reply], personaPubkey: PERSONA });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).hasUnreadReplies).toBe(false);
	});

	it('does not recreate a read reply as unread on history reconciliation', async () => {
		const { root, reply } = await rootAndReply();
		await markTraceReplyRead({ channelId: CHANNEL_ID, personaPubkey: PERSONA, rootId: root.id, replyId: reply.id });
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root], rawEvents: [reply], personaPubkey: PERSONA });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).hasUnreadReplies).toBe(false);
	});

	it('does not create notification state for a self-authored reply', async () => {
		const rootRaw = traceRoot(PERSONA_SECRET);
		const root = parseWorldMessage(rootRaw, CHANNEL_ID)!;
		const selfReply = finalizeWorldEvent(buildTraceReplyTemplate({
			root, parent: root, content: 'self reply', speechType: 'normal', createdAt: 101
		}), PERSONA_SECRET);
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 }, rawEvents: [rootRaw] });
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [root], rawEvents: [selfReply], personaPubkey: PERSONA });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).hasUnreadReplies).toBe(false);
	});

	it('cleans root read and reply metadata when the effective root is evicted', async () => {
		const first = traceRoot(PERSONA_SECRET, 100);
		const firstParsed = parseWorldMessage(first, CHANNEL_ID)!;
		const second = traceRoot(PERSONA_SECRET, 101);
		const reply = finalizeWorldEvent(buildTraceReplyTemplate({ root: firstParsed, parent: firstParsed, content: 'reply', speechType: 'normal', createdAt: 102 }), OTHER_SECRET);
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 }, rawEvents: [first] });
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots: [firstParsed], rawEvents: [reply], personaPubkey: PERSONA });
		await markTraceRootRead({ channelId: CHANNEL_ID, personaPubkey: PERSONA, rootId: firstParsed.id });
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 }, rawEvents: [second] });
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).readRootIds).not.toContain(firstParsed.id);
		expect((await loadTraceReadSnapshot({ channelId: CHANNEL_ID, personaPubkey: PERSONA })).unreadReplyRootIds).not.toContain(firstParsed.id);
	});
});
