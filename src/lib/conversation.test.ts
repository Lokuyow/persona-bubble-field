import { describe, expect, it } from 'vitest';
import {
	applyVisibility,
	createConversationState,
	pruneExpired,
	receiveMessage,
	type ConversationMessage,
	type ConversationState,
	type SpeechType
} from './conversation';

const DURATION = 100;

function message(
	id: string,
	pubkey: string,
	content: string,
	speechType: SpeechType = 'normal',
	createdAt = 0
): ConversationMessage {
	return { id, pubkey, content, speechType, createdAt };
}

function receive(
	state: ConversationState,
	input: ConversationMessage,
	isSpeakerVisible = true,
	now = input.createdAt,
	duration = DURATION
) {
	return receiveMessage(state, input, { isSpeakerVisible, duration, now });
}

function normalState(content = 'hello', pubkey = 'alice') {
	return receive(createConversationState(), message('m1', pubkey, content));
}

function mergedState() {
	const first = receive(createConversationState(), message('m1', 'alice', 'hello'));
	return receive(first, message('m2', 'bob', 'hello', 'normal', 10), true, 10);
}

describe('conversation lifecycle', () => {
	it('creates a normal bubble for a visible speaker', () => {
		const state = normalState();

		expect(state.normalBubbles).toHaveLength(1);
		expect(state.normalBubbles[0]).toMatchObject({
			id: 'm1',
			pubkey: 'alice',
			content: 'hello',
			speechType: 'normal',
			expiresAt: DURATION
		});
	});

	it('does not create a normal bubble for an offscreen message', () => {
		const state = receive(createConversationState(), message('m1', 'alice', 'hello'), false);

		expect(state.normalBubbles).toEqual([]);
		expect(state.processedMessageIds.has('m1')).toBe(true);
	});

	it('does not replay an offscreen message when the speaker later becomes visible', () => {
		const received = receive(createConversationState(), message('m1', 'alice', 'hello'), false);
		const visibleAgain = applyVisibility(received, new Set(['alice']));
		const replayed = receive(visibleAgain, message('m1', 'alice', 'hello'));

		expect(replayed.normalBubbles).toEqual([]);
	});

	it('keeps an event-created expiry instead of granting a delayed message a fresh duration', () => {
		const delayed = receive(createConversationState(), message('m1', 'alice', 'hello', 'normal', 1_000), true, 1_000);

		expect(pruneExpired(delayed, 1_099).normalBubbles).toHaveLength(1);
		expect(pruneExpired(delayed, 1_100).normalBubbles).toEqual([]);
	});

	it('does not admit an expired relay message into viewer-local conversation state', () => {
		const naturalExpiresAt = 1_000 + DURATION;
		const now = naturalExpiresAt;
		let state = createConversationState();
		if (naturalExpiresAt > now) state = receive(state, message('m1', 'alice', 'hello', 'normal', 1_000), true, 1_000);

		expect(state.normalBubbles).toEqual([]);
		expect(state.processedMessageIds.size).toBe(0);
	});

	it('removes an active normal bubble when its speaker goes offscreen', () => {
		const state = applyVisibility(normalState(), new Set(['bob']));

		expect(state.normalBubbles).toEqual([]);
		expect(state.dismissedNormalMessageIds.has('m1')).toBe(true);
	});

	it('does not restore a dismissed normal bubble when the speaker returns', () => {
		const dismissed = applyVisibility(normalState(), new Set());
		const returned = applyVisibility(dismissed, new Set(['alice']));

		expect(returned.normalBubbles).toEqual([]);
	});

	it('replaces a visible speaker\'s old normal bubble with a new content', () => {
		const state = receive(normalState('old'), message('m2', 'alice', 'new', 'normal', 10), true, 10);

		expect(state.normalBubbles).toHaveLength(1);
		expect(state.normalBubbles[0]).toMatchObject({ id: 'm2', content: 'new' });
	});

	it('retires the speaker\'s old normal before that speaker joins an existing merge', () => {
		let state = normalState('old', 'alice');
		state = receive(state, message('m2', 'bob', 'hello', 'normal', 10), true, 10);
		state = receive(state, message('m3', 'alice', 'hello', 'normal', 20), true, 20);

		expect(state.normalBubbles).toEqual([]);
		expect(state.mergedBubbles).toMatchObject([{ content: 'hello', memberPubkeys: ['bob', 'alice'] }]);
	});

	it('retires only the joining speaker normal while preserving the established merge', () => {
		let state = mergedState();
		state = receive(state, message('m3', 'charlie', 'other', 'normal', 20), true, 20);
		state = receive(state, message('m4', 'charlie', 'hello', 'normal', 30), true, 30);

		expect(state.mergedBubbles).toHaveLength(1);
		expect(state.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob', 'charlie']);
		expect(state.normalBubbles).toEqual([]);
	});

	it('removes a member\'s different normal when they repeat the established merge content', () => {
		let state = mergedState();
		state = receive(state, message('m3', 'alice', 'other', 'normal', 20), true, 20);
		const expiresAt = state.mergedBubbles[0].expiresAt;
		state = receive(state, message('m4', 'alice', 'hello', 'normal', 30), true, 30);

		expect(state.normalBubbles).toEqual([]);
		expect(state.mergedBubbles).toHaveLength(1);
		expect(state.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob']);
		expect(state.mergedBubbles[0].expiresAt).toBe(expiresAt);
	});

	it('merges exact content and speech type from two different pubkeys', () => {
		const state = mergedState();

		expect(state.normalBubbles).toEqual([]);
		expect(state.mergedBubbles[0]).toMatchObject({
		id: 'merged:m1',
		content: 'hello',
		memberPubkeys: ['alice', 'bob'],
		messageIds: ['m1', 'm2']
		});
	});

	it('does not merge two messages from the same pubkey', () => {
		const state = receive(normalState(), message('m2', 'alice', 'hello', 'normal', 10), true, 10);

		expect(state.mergedBubbles).toEqual([]);
		expect(state.normalBubbles).toHaveLength(1);
		expect(state.normalBubbles[0].id).toBe('m1');
	});

	it('does not merge content that differs by one character', () => {
		const state = receive(normalState('hello'), message('m2', 'bob', 'hellO', 'normal', 10), true, 10);

		expect(state.mergedBubbles).toEqual([]);
		expect(state.normalBubbles).toHaveLength(2);
	});

	it('treats leading or trailing whitespace as distinct content', () => {
		const state = receive(normalState('hello'), message('m2', 'bob', ' hello', 'normal', 10), true, 10);

		expect(state.mergedBubbles).toEqual([]);
	});

	it('does not merge different speech types', () => {
		const state = receive(normalState('hello'), message('m2', 'bob', 'hello', 'shout', 10), true, 10);

		expect(state.mergedBubbles).toEqual([]);
		expect(state.normalBubbles).toHaveLength(2);
	});

	it('counts merged members by unique pubkey', () => {
		const state = mergedState();
		const withDuplicate = receive(state, message('m3', 'bob', 'hello', 'normal', 20), true, 20);

		expect(withDuplicate.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob']);
	});

	it('resets merged expiry when a new unique member joins', () => {
		const state = mergedState();
		const joined = receive(state, message('m3', 'charlie', 'hello', 'normal', 50), true, 50);

		expect(joined.mergedBubbles[0].expiresAt).toBe(50 + DURATION);
		expect(joined.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob', 'charlie']);
	});

	it('does not extend expiry for a duplicate message from an existing member', () => {
		const state = mergedState();
		const resent = receive(state, message('m3', 'bob', 'hello', 'normal', 50), true, 50);

		expect(resent.mergedBubbles[0].expiresAt).toBe(state.mergedBubbles[0].expiresAt);
		expect(resent.mergedBubbles[0].memberPubkeys).toHaveLength(2);
	});

	it('keeps an established merge when a member speaks different content', () => {
		const state = receive(mergedState(), message('m3', 'alice', 'different', 'normal', 20), true, 20);

		expect(state.mergedBubbles).toHaveLength(1);
		expect(state.normalBubbles).toMatchObject([{ pubkey: 'alice', content: 'different' }]);
	});

	it('keeps merged members when visibility changes', () => {
		const state = applyVisibility(mergedState(), new Set());

		expect(state.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob']);
		expect(state.mergedBubbles).toHaveLength(1);
	});

	it('keeps an all-offscreen merged bubble until expiry', () => {
		const state = applyVisibility(mergedState(), new Set());

		expect(state.mergedBubbles[0].expiresAt).toBeGreaterThan(10);
	});

	it('prunes normal and merged bubbles after expiry', () => {
		const state = mergedState();

		expect(pruneExpired(state, state.mergedBubbles[0].expiresAt)).toMatchObject({
			normalBubbles: [],
			mergedBubbles: []
		});
	});

	it('processes the same message ID idempotently', () => {
		const initial = createConversationState();
		const once = receive(initial, message('m1', 'alice', 'hello'));
		const twice = receive(once, message('m1', 'alice', 'hello'), true, 50);

		expect(twice).toBe(once);
	});

	it('produces the same transition for the same inputs', () => {
		const input = message('m1', 'alice', 'hello');
		const first = receive(receive(createConversationState(), input), message('m2', 'bob', 'hello', 'normal', 10), true, 10);
		const second = receive(receive(createConversationState(), input), message('m2', 'bob', 'hello', 'normal', 10), true, 10);

		expect(second).toEqual(first);
	});
});
