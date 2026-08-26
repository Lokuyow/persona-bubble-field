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
import { projectPresence } from './presenceProjection';

const message = (id: string, pubkey: string, content: string, createdAt: number): ConversationMessage => ({
	id,
	pubkey,
	content,
	createdAt
});

const receive = (state: ReturnType<typeof createConversationState>, input: ConversationMessage, now: number) =>
	receiveMessage(state, input, { isSpeakerVisible: true, duration: 1000, now });

describe('presence and conversation boundary', () => {
	const projectionOptions = {
		cellSize: 56,
		fieldAreaBounds: { x: 0, y: 260, width: 328, height: 100 },
		fieldWorldSize: { width: 896, height: 448 }
	};
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

	it('projects reactivated self with the new position and camera context', () => {
		let presence = createPresenceState({ columns: 16, rows: 8 }, 0, [
			{ id: 'you', position: { x: 15, y: 7 } },
			{ id: 'bob', position: { x: 15, y: 7 } }
		]);
		const oldProjection = projectPresence(presence, [{ id: 'you' }, { id: 'bob' }], projectionOptions);
		presence = recordPresenceActivity(presence, 'bob', 'message', 100);
		presence = prunePresence(presence, PRESENCE_TIMEOUT_MS + 1);
		presence = recordPresenceActivity(presence, 'you', 'message', PRESENCE_TIMEOUT_MS + 2, () => 0);
		const nextProjection = projectPresence(presence, [{ id: 'you' }, { id: 'bob' }], projectionOptions);
		const conversation = receiveMessage(createConversationState(), message('reactivated', 'you', 'hello', PRESENCE_TIMEOUT_MS + 2), {
			isSpeakerVisible: nextProjection.visibleParticipantIds.has('you'),
			duration: 1000,
			now: PRESENCE_TIMEOUT_MS + 2
		});

		expect(presence.participants[0]).toMatchObject({ position: { x: 0, y: 0 }, status: 'active' });
		expect(nextProjection.camera).not.toEqual(oldProjection.camera);
		expect(nextProjection.visibleParticipantIds.has('you')).toBe(true);
		expect(nextProjection.participants.find((participant) => participant.id === 'you')?.screen.y).toBeGreaterThanOrEqual(260);
		expect(conversation.normalBubbles).toMatchObject([{ pubkey: 'you', id: 'reactivated' }]);
	});

	it('keeps merged membership while projecting only the active member as a tail target', () => {
		let presence = createPresenceState({ columns: 2, rows: 2 }, 0, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'bob', position: { x: 1, y: 0 } }
		]);
		let conversation = receive(createConversationState(), message('m1', 'alice', 'hello', 0), 0);
		conversation = receive(conversation, message('m2', 'bob', 'hello', 1), 1);
		presence = recordPresenceActivity(presence, 'bob', 'message', 1);
		presence = prunePresence(presence, PRESENCE_TIMEOUT_MS);
		conversation = applyVisibility(conversation, getActiveParticipantIds(presence));
		const projection = projectPresence(presence, [{ id: 'alice' }, { id: 'bob' }], {
			...projectionOptions,
			fieldWorldSize: { width: 112, height: 112 }
		});

		expect(conversation.mergedBubbles[0].memberPubkeys).toEqual(['alice', 'bob']);
		expect(projection.participants.map((participant) => participant.id)).toEqual(['bob']);
		expect(getActiveParticipantIds(presence)).toEqual(new Set(['bob']));
	});
});
