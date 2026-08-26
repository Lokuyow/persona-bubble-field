import { describe, expect, it } from 'vitest';
import {
	applyVisibility,
	createConversationState,
	receiveMessage,
	type ConversationMessage
} from './conversation';
import {
	PRESENCE_TIMEOUT_MS,
	createPresenceState,
	getActiveParticipantIds,
	prunePresence,
	recordPresenceActivity
} from './presence';

const message = (id: string, pubkey: string, content: string, createdAt: number): ConversationMessage => ({
	id,
	pubkey,
	content,
	createdAt
});

const receive = (state: ReturnType<typeof createConversationState>, input: ConversationMessage, now: number) =>
	receiveMessage(state, input, { isSpeakerVisible: true, duration: 1000, now });

describe('presence and conversation boundary', () => {
	it('dismisses a normal bubble when presence times out', () => {
		let presence = createPresenceState({ columns: 2, rows: 2 }, 0, [{ id: 'alice', position: { x: 0, y: 0 } }]);
		let conversation = receive(createConversationState(), message('m1', 'alice', 'hello', 0), 0);

		presence = prunePresence(presence, PRESENCE_TIMEOUT_MS);
		conversation = applyVisibility(conversation, getActiveParticipantIds(presence));

		expect(conversation.normalBubbles).toEqual([]);
		expect(conversation.dismissedNormalMessageIds.has('m1')).toBe(true);
	});

	it('keeps merged member count while removing an inactive member tail target', () => {
		let presence = createPresenceState({ columns: 2, rows: 2 }, 0, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'bob', position: { x: 1, y: 0 } }
		]);
		let conversation = receive(createConversationState(), message('m1', 'alice', 'hello', 0), 0);
		conversation = receive(conversation, message('m2', 'bob', 'hello', 1), 1);

		presence = prunePresence(presence, PRESENCE_TIMEOUT_MS);
		conversation = applyVisibility(conversation, getActiveParticipantIds(presence));

		expect(conversation.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob']);
	});

	it('reactivates a timed out speaker before message visibility is projected', () => {
		let presence = createPresenceState({ columns: 2, rows: 2 }, 0, [{ id: 'alice', position: { x: 0, y: 0 } }]);
		let conversation = createConversationState();

		presence = prunePresence(presence, PRESENCE_TIMEOUT_MS);
		presence = recordPresenceActivity(presence, 'alice', 'message', PRESENCE_TIMEOUT_MS + 1);
		conversation = receiveMessage(conversation, message('m1', 'alice', 'hello', PRESENCE_TIMEOUT_MS + 1), {
			isSpeakerVisible: getActiveParticipantIds(presence).has('alice'),
			duration: 1000,
			now: PRESENCE_TIMEOUT_MS + 1
		});

		expect(conversation.normalBubbles[0]).toMatchObject({ pubkey: 'alice', id: 'm1' });
	});
});
