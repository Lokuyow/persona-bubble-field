import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConversationState, type ConversationState } from '../conversation';
import type { PresenceState } from '../presence';
import type { RecentMessageTimeline } from '../recentMessageTimeline';
import type { ParsedTraceReply, ParsedWorldMessage } from '../nostrProtocol';
import { applyDevPageFixtures, createDevTraceLiveReply } from './devPageFixtures';

const nowMs = 1_800_000_123_456;

function fixtures(query: string): {
	calls: string[];
	presence: PresenceState | null;
	conversation: ConversationState;
	timeline: RecentMessageTimeline;
	roots: readonly ParsedWorldMessage[];
	replies: readonly ParsedTraceReply[];
} {
	vi.spyOn(Date, 'now').mockReturnValue(nowMs);
	const calls: string[] = [];
	let presence: PresenceState | null = null;
	let conversation: ConversationState = createConversationState();
	let timeline: RecentMessageTimeline = [];
	let roots: readonly ParsedWorldMessage[] = [];
	let replies: readonly ParsedTraceReply[] = [];
	applyDevPageFixtures(new URLSearchParams(query), {
		field: { columns: 16, rows: 8 },
		setPresence(next) { calls.push('presence'); presence = next; },
		getConversation: () => conversation,
		setConversation(next) { calls.push('conversation'); conversation = next; },
		setRecentMessageTimeline(next) { calls.push('timeline'); timeline = next; },
		setEffectiveTraceRoots(next) { calls.push('roots'); roots = next; },
		setDevTraceReplies(next) { calls.push('replies'); replies = next; },
		enableTraceReplyFixture() { calls.push('enable-replies'); }
	});
	return { calls, presence, conversation, timeline, roots, replies };
}

afterEach(() => vi.restoreAllMocks());

describe('DEV page fixtures', () => {
	it('applies speech before Trace fixtures and enables replies before setting them, synchronously', () => {
		const result = fixtures('devSpeech=timeline&devTrace=replies');
		expect(result.calls).toEqual([
			'presence', 'timeline', 'presence', 'conversation', 'roots', 'enable-replies', 'replies'
		]);
		expect(result.timeline).toHaveLength(24);
		expect(result.timeline.find((message) => message.id === 'dev-timeline-duplicate')?.content)
			.toBe('timeline message 24');
		expect(result.roots.map((root) => root.id)).toEqual(['1', '2', '3', '4'].map((id) => id.repeat(64)));
		expect(result.replies).toHaveLength(9);
		expect(result.replies.every((reply) => reply.rootId === '2'.repeat(64))).toBe(true);
		const byId = new Map(result.replies.map((reply) => [reply.id, reply]));
		for (const reply of result.replies) {
			if (reply.parentKind === 42) {
				expect(reply.parentId).toBe(reply.rootId);
				expect(reply.parentPubkey).toBe(reply.rootPubkey);
			} else {
				expect(byId.get(reply.parentId)?.pubkey).toBe(reply.parentPubkey);
			}
			expect(reply).not.toHaveProperty('position');
		}
	});

	it('preserves merged query member count, speech type, duration and long body', () => {
		const { conversation, presence } = fixtures('devSpeech=merged3-shout-long');
		expect(conversation.normalBubbles).toHaveLength(1);
		expect(conversation.mergedBubbles).toHaveLength(1);
		const merged = conversation.mergedBubbles[0];
		expect(merged.memberPubkeys).toEqual(['b', 'c', 'd'].map((id) => id.repeat(64)));
		expect(merged.speechType).toBe('shout');
		expect(merged.expiresAt).toBe(nowMs + 60_000);
		expect(merged.content).toBe('Merged bubble content grows naturally until its size limit. '.repeat(8).trim());
		expect(presence?.participants.filter((participant) => merged.memberPubkeys.includes(participant.id))
			.map((participant) => participant.position)).toEqual([{ x: 5, y: 2 }, { x: 8, y: 2 }, { x: 11, y: 2 }]);
	});

	it('preserves explicit five-line fixture content', () => {
		const { conversation } = fixtures('devSpeech=linebreak-five');
		expect(conversation.normalBubbles[0].content).toBe('normal line 1\nnormal line 2\nnormal line 3\nnormal line 4\nnormal line 5');
		expect(conversation.mergedBubbles[0].content).toBe('merged line 1\nmerged line 2\nmerged line 3\nmerged line 4\nmerged line 5');
	});

	it('leaves presence overrides and unsupported queries to the caller', () => {
		expect(fixtures('devSpeech=unknown&devTrace=unknown&devPresence=inactive').calls).toEqual([]);
		expect(fixtures('devTrace=lights').calls).toEqual(['presence', 'conversation', 'roots']);
	});

	it('creates the same direct live reply using the supplied clock', () => {
		expect(createDevTraceLiveReply(nowMs)).toEqual({
			id: 'c'.repeat(64), pubkey: 'c'.repeat(64), createdAt: Math.floor(nowMs / 1000) + 1,
			content: 'live newest same-cell direct reply', speechType: 'normal',
			rootId: '2'.repeat(64), rootPubkey: 'b'.repeat(64),
			parentId: '2'.repeat(64), parentKind: 42, parentPubkey: 'b'.repeat(64)
		});
	});
});
