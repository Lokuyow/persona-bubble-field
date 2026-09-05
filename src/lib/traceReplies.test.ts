import type { Event } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate,
	type ChannelReference,
	type ParsedTraceReply,
	type ParsedWorldMessage,
	type TraceReplyTemplate
} from './nostrProtocol';
import { resolveLiveTraceReply, resolveTraceReplyBatch } from './traceReplies';

const CHANNEL_ID = 'a'.repeat(64);
const OTHER_CHANNEL_ID = 'b'.repeat(64);
const SECRET_KEY = new Uint8Array(32).fill(9);

function makeRoot(channelId = CHANNEL_ID, content = 'root'): Readonly<{ raw: Event; parsed: ParsedWorldMessage }> {
	const channel: ChannelReference = { channelId, relayHint: 'wss://relay.example.com' };
	const raw = finalizeWorldEvent(buildWorldMessageTemplate({
		channel, content, createdAt: 100, position: { x: 0, y: 0 }, speechType: 'normal'
	}), SECRET_KEY);
	const parsed = parseWorldMessage(raw, channelId);
	if (!parsed) throw new Error('Root fixture did not parse.');
	return { raw, parsed };
}

function makeReply(
	root: ParsedWorldMessage,
	parent: ParsedWorldMessage | ParsedTraceReply,
	content: string,
	createdAt: number
): Readonly<{ raw: Event; parsed: ParsedTraceReply }> {
	const raw = finalizeWorldEvent(buildTraceReplyTemplate({
		root, parent, content, createdAt, speechType: 'normal'
	}), SECRET_KEY);
	const candidate = parseTraceReplyCandidate(raw);
	const parsed = candidate && validateTraceReplyCandidate(candidate, root, parent);
	if (!parsed) throw new Error('Reply fixture did not validate.');
	return { raw, parsed };
}

function resign(template: TraceReplyTemplate): Event {
	return finalizeWorldEvent(template, SECRET_KEY);
}

describe('trace reply semantic resolution', () => {
	it('accepts a valid direct reply and a reply-to-reply in parent-first order', () => {
		const root = makeRoot();
		const direct = makeReply(root.parsed, root.parsed, 'direct', 101);
		const child = makeReply(root.parsed, direct.parsed, 'child', 102);
		expect(resolveTraceReplyBatch({ effectiveRoots: [root.parsed], rawEvents: [direct.raw, child.raw] })
			.map((event) => event.reply.id)).toEqual([direct.parsed.id, child.parsed.id]);
	});

	it('resolves child-before-parent and arbitrary-depth shuffled batches', () => {
		const root = makeRoot();
		const first = makeReply(root.parsed, root.parsed, 'first', 104);
		const second = makeReply(root.parsed, first.parsed, 'second', 103);
		const third = makeReply(root.parsed, second.parsed, 'third', 102);
		const fourth = makeReply(root.parsed, third.parsed, 'fourth', 101);
		expect(resolveTraceReplyBatch({
			effectiveRoots: [root.parsed], rawEvents: [fourth.raw, second.raw, third.raw, first.raw]
		}).map((event) => event.reply.id)).toEqual([
			first.parsed.id, second.parsed.id, third.parsed.id, fourth.parsed.id
		]);
	});

	it('uses a cached parent included with a later history batch', () => {
		const root = makeRoot();
		const cached = makeReply(root.parsed, root.parsed, 'cached', 101);
		const fresh = makeReply(root.parsed, cached.parsed, 'fresh', 102);
		expect(resolveTraceReplyBatch({ effectiveRoots: [root.parsed], rawEvents: [fresh.raw, cached.raw] })
			.map((event) => event.reply.id)).toEqual([cached.parsed.id, fresh.parsed.id]);
	});

	it('ignores missing parents and accepts the same event when a later batch supplies the dependency', () => {
		const root = makeRoot();
		const parent = makeReply(root.parsed, root.parsed, 'parent', 101);
		const child = makeReply(root.parsed, parent.parsed, 'child', 102);
		expect(resolveTraceReplyBatch({ effectiveRoots: [root.parsed], rawEvents: [child.raw] })).toEqual([]);
		expect(resolveTraceReplyBatch({ effectiveRoots: [root.parsed], rawEvents: [child.raw, parent.raw] })
			.map((event) => event.reply.id)).toEqual([parent.parsed.id, child.parsed.id]);
	});

	it('ignores non-effective roots, wrong relations, invalid signatures, and malformed events', () => {
		const root = makeRoot();
		const other = makeRoot(OTHER_CHANNEL_ID, 'other');
		const otherReply = makeReply(other.parsed, other.parsed, 'other reply', 101);
		const wrongTemplate = buildTraceReplyTemplate({
			root: root.parsed, parent: root.parsed, content: 'wrong', createdAt: 101,
			speechType: 'normal'
		});
		wrongTemplate.tags[4][1] = '1111';
		const valid = makeReply(root.parsed, root.parsed, 'valid', 101);
		const invalidSignature: Event = {
			id: valid.raw.id, pubkey: valid.raw.pubkey, created_at: valid.raw.created_at,
			kind: valid.raw.kind, tags: valid.raw.tags.map((tag) => [...tag]),
			content: valid.raw.content, sig: '0'.repeat(128)
		};
		const malformed: Event = { ...invalidSignature, sig: valid.raw.sig, tags: [] };
		expect(resolveTraceReplyBatch({
			effectiveRoots: [root.parsed],
			rawEvents: [otherReply.raw, resign(wrongTemplate), invalidSignature, malformed]
		})).toEqual([]);
	});

	it('deduplicates event IDs and produces the same deterministic result for every arrival order', () => {
		const root = makeRoot();
		const laterId = makeReply(root.parsed, root.parsed, 'later-id', 101);
		const earlierId = makeReply(root.parsed, root.parsed, 'earlier-id', 101);
		const expected = [laterId, earlierId]
			.sort((first, second) => first.parsed.id < second.parsed.id ? -1 : 1)
			.map((event) => event.parsed.id);
		const first = resolveTraceReplyBatch({
			effectiveRoots: [root.parsed], rawEvents: [laterId.raw, earlierId.raw, laterId.raw]
		}).map((event) => event.reply.id);
		const second = resolveTraceReplyBatch({
			effectiveRoots: [root.parsed], rawEvents: [earlierId.raw, laterId.raw]
		}).map((event) => event.reply.id);
		expect(first).toEqual(expected);
		expect(second).toEqual(expected);
	});

	it('accepts live events only when their immediate dependency is already accepted', () => {
		const root = makeRoot();
		const parent = makeReply(root.parsed, root.parsed, 'parent', 101);
		const child = makeReply(root.parsed, parent.parsed, 'child', 102);
		expect(resolveLiveTraceReply({
			effectiveRoots: [root.parsed], acceptedReplies: [], rawEvent: child.raw
		})).toBeNull();
		const acceptedParent = resolveLiveTraceReply({
			effectiveRoots: [root.parsed], acceptedReplies: [], rawEvent: parent.raw
		});
		expect(acceptedParent?.reply.id).toBe(parent.parsed.id);
		expect(resolveLiveTraceReply({
			effectiveRoots: [root.parsed], acceptedReplies: [acceptedParent!], rawEvent: child.raw
		})?.reply.id).toBe(child.parsed.id);
	});
});
