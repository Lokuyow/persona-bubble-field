import { describe, expect, it } from 'vitest';
import {
	applyPresenceEvidence,
	reconstructPresenceEvidence,
	type PresenceEvidence,
	type ReducedPresenceParticipant
} from './presenceEvidence';
import type { ParsedPositionEvent, ParsedWorldMessage } from './nostrProtocol';

function message(
	id: string,
	pubkey: string,
	createdAt: number,
	position = { x: 1, y: 1 }
): ParsedWorldMessage {
	return { id, pubkey, createdAt, content: 'message', speechType: 'normal', position };
}

function position(
	id: string,
	pubkey: string,
	createdAt: number,
	slot: 0 | 1,
	cell = { x: 2, y: 2 }
): ParsedPositionEvent {
	return { id, pubkey, createdAt, slot, position: cell };
}

function evidence(
	eventId: string,
	pubkey: string,
	createdAt: number,
	source: PresenceEvidence['source'],
	positionValue = { x: 1, y: 1 }
): PresenceEvidence {
	return { eventId, pubkey, createdAt, source, position: positionValue };
}

function participant(
	pubkey: string,
	positionValue: { x: number; y: number },
	positionEvidence: ReducedPresenceParticipant['positionEvidence'],
	lastActivityCreatedAt: number
): ReducedPresenceParticipant {
	return { pubkey, position: positionValue, positionEvidence, lastActivityCreatedAt };
}

describe('presence evidence reducer', () => {
	it('converts message, slot 0, and slot 1 into independent participant results', () => {
		expect(reconstructPresenceEvidence([message('message', 'a'.repeat(64), 100)], [])).toEqual([
			participant('a'.repeat(64), { x: 1, y: 1 }, { eventId: 'message', createdAt: 100, source: 'message' }, 100)
		]);
		expect(reconstructPresenceEvidence([], [position('slot-0', 'b'.repeat(64), 100, 0)])).toEqual([
			participant('b'.repeat(64), { x: 2, y: 2 }, { eventId: 'slot-0', createdAt: 100, source: 'position-slot-0' }, 100)
		]);
		expect(reconstructPresenceEvidence([], [position('slot-1', 'c'.repeat(64), 100, 1)])).toEqual([
			participant('c'.repeat(64), { x: 2, y: 2 }, { eventId: 'slot-1', createdAt: 100, source: 'position-slot-1' }, 100)
		]);
	});

	it('reduces multiple pubkeys independently in pubkey order', () => {
		expect(reconstructPresenceEvidence([
			message('b-message', 'b'.repeat(64), 100),
			message('a-message', 'a'.repeat(64), 101)
		], [])).toEqual([
			participant('a'.repeat(64), { x: 1, y: 1 }, { eventId: 'a-message', createdAt: 101, source: 'message' }, 101),
			participant('b'.repeat(64), { x: 1, y: 1 }, { eventId: 'b-message', createdAt: 100, source: 'message' }, 100)
		]);
	});

	it('lets newer evidence beat older evidence regardless of source', () => {
		expect(reconstructPresenceEvidence(
			[message('newer-message', 'a'.repeat(64), 100, { x: 2, y: 2 })],
			[position('older-position', 'a'.repeat(64), 99, 1, { x: 1, y: 1 })]
		)[0].position).toEqual({ x: 2, y: 2 });
		expect(reconstructPresenceEvidence(
			[message('older-message', 'a'.repeat(64), 99, { x: 1, y: 1 })],
			[position('newer-position', 'a'.repeat(64), 100, 0, { x: 2, y: 2 })]
		)[0].position).toEqual({ x: 2, y: 2 });
	});

	it('uses slot 0 over message and slot 1 over slot 0/message in the same second', () => {
		expect(reconstructPresenceEvidence([
			message('message', 'a'.repeat(64), 100, { x: 1, y: 1 })
		], [position('slot-0', 'a'.repeat(64), 100, 0, { x: 2, y: 2 })])[0].position).toEqual({ x: 2, y: 2 });
		expect(reconstructPresenceEvidence([
			message('message', 'a'.repeat(64), 100, { x: 1, y: 1 })
		], [position('slot-1', 'a'.repeat(64), 100, 1, { x: 3, y: 3 })])[0].position).toEqual({ x: 3, y: 3 });
		expect(reconstructPresenceEvidence([], [
			position('slot-0', 'a'.repeat(64), 100, 0, { x: 2, y: 2 }),
			position('slot-1', 'a'.repeat(64), 100, 1, { x: 3, y: 3 })
		])[0].position).toEqual({ x: 3, y: 3 });

		expect(reconstructPresenceEvidence([
			message('message', 'a'.repeat(64), 100, { x: 1, y: 1 })
		], [
			position('slot-0', 'a'.repeat(64), 100, 0, { x: 2, y: 2 }),
			position('slot-1', 'a'.repeat(64), 100, 1, { x: 3, y: 3 })
		])[0]).toEqual(participant(
			'a'.repeat(64),
			{ x: 3, y: 3 },
			{ eventId: 'slot-1', createdAt: 100, source: 'position-slot-1' },
			100
		));
	});

	it('keeps activity time independent from current position source', () => {
		const result = reconstructPresenceEvidence(
			[message('message', 'a'.repeat(64), 101, { x: 1, y: 1 })],
			[position('slot-1', 'a'.repeat(64), 100, 1, { x: 2, y: 2 })]
		);

		expect(result[0]).toEqual(participant(
			'a'.repeat(64),
			{ x: 1, y: 1 },
			{ eventId: 'message', createdAt: 101, source: 'message' },
			101
		));
	});

	it('uses the lowest event ID for same-rank ties independent of arrival order', () => {
		const first = evidence('b-event', 'a'.repeat(64), 100, 'message', { x: 2, y: 2 });
		const second = evidence('a-event', 'a'.repeat(64), 100, 'message', { x: 1, y: 1 });

		expect(applyPresenceEvidence(applyPresenceEvidence(undefined, first), second)).toEqual(
			applyPresenceEvidence(applyPresenceEvidence(undefined, second), first)
		);
		expect(applyPresenceEvidence(applyPresenceEvidence(undefined, first), second).position).toEqual({ x: 1, y: 1 });
		expect(reconstructPresenceEvidence([
			message('b-event', 'a'.repeat(64), 100, { x: 2, y: 2 }),
			message('a-event', 'a'.repeat(64), 100, { x: 1, y: 1 })
		], [])).toEqual(reconstructPresenceEvidence([
			message('a-event', 'a'.repeat(64), 100, { x: 1, y: 1 }),
			message('b-event', 'a'.repeat(64), 100, { x: 2, y: 2 })
		], []));
		expect(reconstructPresenceEvidence([], [
			position('b-slot-0', 'a'.repeat(64), 100, 0, { x: 2, y: 2 }),
			position('a-slot-0', 'a'.repeat(64), 100, 0, { x: 1, y: 1 })
		])).toEqual(reconstructPresenceEvidence([], [
			position('a-slot-0', 'a'.repeat(64), 100, 0, { x: 1, y: 1 }),
			position('b-slot-0', 'a'.repeat(64), 100, 0, { x: 2, y: 2 })
		]));
	});

	it('keeps the maximum activity timestamp and is idempotent for duplicate evidence', () => {
		const item = evidence('same', 'a'.repeat(64), 100, 'message');
		const once = applyPresenceEvidence(undefined, item);
		const twice = applyPresenceEvidence(once, item);

		expect(twice).toEqual(once);
		expect(twice).not.toBe(once);
		expect(reconstructPresenceEvidence(
			[message('same', 'a'.repeat(64), 100), message('same', 'a'.repeat(64), 100)],
			[]
		)).toEqual([once]);
	});

	it('is independent of mixed message and position arrival order', () => {
		const messages = [message('message-old', 'a'.repeat(64), 99), message('message-new', 'a'.repeat(64), 101)];
		const positions = [position('slot-0', 'a'.repeat(64), 100, 0), position('slot-1', 'b'.repeat(64), 100, 1)];

		expect(reconstructPresenceEvidence(messages, positions)).toEqual(
			reconstructPresenceEvidence([...messages].reverse(), [...positions].reverse())
		);
	});
});
