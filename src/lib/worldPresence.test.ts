import { describe, expect, it } from 'vitest';
import type { ParsedWorldStateEvent, ParsedWorldMessage } from './nostrProtocol';
import { getActiveOccupancy, PRESENCE_TIMEOUT_MS } from './presence';
import {
	applyWorldPresenceMessage,
	applyWorldPresenceWorldState,
	projectWorldPresenceState,
	reconstructWorldPresenceState,
	type WorldPresenceState
} from './worldPresence';

const field = { columns: 4, rows: 3 };
const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);

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
): ParsedWorldStateEvent {
	return { id, pubkey, createdAt, state: 'active', slot, position: cell };
}

function participant(state: WorldPresenceState, pubkey: string) {
	return state.participants.find((candidate) => candidate.pubkey === pubkey)!;
}

describe('world presence adapter', () => {
	it('reconstructs from messages, positions, and existing evidence ordering', () => {
		const state = reconstructWorldPresenceState(
			field,
			[message('message', alice, 100, { x: 1, y: 1 })],
			[position('slot-0', alice, 100, 0, { x: 2, y: 1 })]
		);

		expect(participant(state, alice)).toMatchObject({
			position: { x: 2, y: 1 },
			positionEvidence: { source: 'world-state-slot-0', eventId: 'slot-0' },
			lastPositiveActivityCreatedAt: 100
		});
		expect(reconstructWorldPresenceState(field, [], [position('position', alice, 101, 1)])).toEqual({
			field,
			participants: [{
				pubkey: alice,
				position: { x: 2, y: 2 },
				positionEvidence: { eventId: 'position', createdAt: 101, source: 'world-state-slot-1' },
				lastPositiveActivityCreatedAt: 101,
				latestExitCreatedAt: null
			}]
		});
	});

	it('returns multiple pubkeys in deterministic order and does not mutate inputs', () => {
		const messages = [message('bob', bob, 100), message('alice', alice, 101)];
		const positions = [position('position', bob, 99, 0)];
		const messagesBefore = structuredClone(messages);
		const positionsBefore = structuredClone(positions);

		const state = reconstructWorldPresenceState(field, messages, positions);

		expect(state.participants.map((candidate) => candidate.pubkey)).toEqual([alice, bob]);
		expect(messages).toEqual(messagesBefore);
		expect(positions).toEqual(positionsBefore);
	});

	it.each([
		['message', () => reconstructWorldPresenceState(field, [message('outside', alice, 100, { x: 4, y: 1 })], [])],
		['position', () => reconstructWorldPresenceState(field, [], [position('outside', alice, 100, 0, { x: 1, y: 3 })])]
	])('ignores out-of-bounds %s evidence', (_kind, build) => {
		expect(build().participants).toEqual([]);
	});

	it('filters bounds before reduction so newer invalid evidence cannot shadow valid evidence', () => {
		const state = reconstructWorldPresenceState(field, [
			message('valid', alice, 100, { x: 3, y: 2 }),
			message('invalid', alice, 101, { x: 999, y: 999 })
		], []);

		expect(state.participants).toHaveLength(1);
		expect(participant(state, alice)).toMatchObject({
			position: { x: 3, y: 2 },
			positionEvidence: { eventId: 'valid', createdAt: 100 },
			lastPositiveActivityCreatedAt: 100
		});
	});

	it('does not depend on a fixed 16 by 8 field', () => {
		const state = reconstructWorldPresenceState(
			{ columns: 2, rows: 2 },
			[message('valid', alice, 100, { x: 1, y: 1 }), message('invalid', bob, 100, { x: 2, y: 1 })],
			[]
		);

		expect(state.participants.map((candidate) => candidate.pubkey)).toEqual([alice]);
	});

	it('retains remote Nostr evidence at the local-only terminal cell', () => {
		const state = reconstructWorldPresenceState(
			{ columns: 16, rows: 8 },
			[message('terminal-peer', alice, 100, { x: 12, y: 3 })],
			[]
		);

		expect(participant(state, alice).position).toEqual({ x: 12, y: 3 });
	});

	it('applies live evidence through the reducer and keeps deterministic ordering', () => {
		const initial = reconstructWorldPresenceState(field, [], []);
		const afterMessage = applyWorldPresenceMessage(initial, message('message', bob, 100, { x: 1, y: 1 }));
		const afterPosition = applyWorldPresenceWorldState(afterMessage, position('position', alice, 101, 0, { x: 2, y: 2 }));

		expect(afterPosition.participants.map((candidate) => candidate.pubkey)).toEqual([alice, bob]);
		expect(participant(afterPosition, alice).position).toEqual({ x: 2, y: 2 });
		expect(initial.participants).toEqual([]);
	});

	it('ignores out-of-bounds live evidence without changing state', () => {
		const initial = reconstructWorldPresenceState(field, [message('valid', alice, 100, { x: 0, y: 0 })], []);

		expect(applyWorldPresenceMessage(initial, message('outside', alice, 101, { x: 999, y: 999 }))).toBe(initial);
		expect(applyWorldPresenceWorldState(initial, position('outside', bob, 101, 0, { x: -1, y: 0 }))).toBe(initial);
	});

	it('keeps newer position and activity against old replay, including all ordering tie-breaks', () => {
		let state = reconstructWorldPresenceState(field, [], []);
		state = applyWorldPresenceWorldState(state, position('new-position', alice, 101, 0, { x: 3, y: 2 }));
		state = applyWorldPresenceMessage(state, message('old-message', alice, 99, { x: 0, y: 0 }));
		state = applyWorldPresenceWorldState(state, position('old-position', alice, 100, 1, { x: 1, y: 1 }));
		expect(participant(state, alice)).toMatchObject({ position: { x: 3, y: 2 }, lastPositiveActivityCreatedAt: 101 });

		state = applyWorldPresenceMessage(state, message('message', alice, 102, { x: 0, y: 2 }));
		state = applyWorldPresenceWorldState(state, position('slot-0', alice, 102, 0, { x: 1, y: 2 }));
		state = applyWorldPresenceWorldState(state, position('slot-1', alice, 102, 1, { x: 2, y: 2 }));
		expect(participant(state, alice).position).toEqual({ x: 2, y: 2 });

		const tieFirst = applyWorldPresenceMessage(state, message('z-event', alice, 103, { x: 0, y: 1 }));
		const tieSecond = applyWorldPresenceMessage(tieFirst, message('a-event', alice, 103, { x: 1, y: 0 }));
		const reversed = applyWorldPresenceMessage(
			applyWorldPresenceMessage(state, message('a-event', alice, 103, { x: 1, y: 0 })),
			message('z-event', alice, 103, { x: 0, y: 1 })
		);
		expect(tieSecond).toEqual(reversed);
		expect(participant(tieSecond, alice).position).toEqual({ x: 1, y: 0 });
	});

	it('keeps a new Run active when an older Run exit is delivered afterward', () => {
		const currentRun = { ...position('run-2-active', alice, 501, 0, { x: 2, y: 1 }), runNumber: 2 };
		const oldRunExit: ParsedWorldStateEvent = { id: 'run-1-exit', pubkey: alice, createdAt: 500, state: 'exit', slot: null,
			position: { x: 2, y: 1 }, runNumber: 1, exitReason: 'death' };
		const active = reconstructWorldPresenceState(field, [], [currentRun]);
		const afterOldExit = applyWorldPresenceWorldState(active, oldRunExit);
		expect(participant(afterOldExit, alice)).toMatchObject({ position: { x: 2, y: 1 }, lastPositiveActivityCreatedAt: 501, latestExitCreatedAt: 500 });
		expect(projectWorldPresenceState(afterOldExit, 501_000).participants).toMatchObject([
			{ id: alice, status: 'active', lastActivityAt: 501_000 }
		]);
	});

	it('is idempotent for exact live evidence and arrival-order independent', () => {
		const initial = reconstructWorldPresenceState(field, [], []);
		const event = message('same', alice, 100, { x: 1, y: 2 });
		const once = applyWorldPresenceMessage(initial, event);
		const twice = applyWorldPresenceMessage(once, event);
		expect(twice).toEqual(once);
		expect(twice).not.toBe(once);

		const firstOrder = applyWorldPresenceWorldState(
			applyWorldPresenceMessage(initial, message('message', alice, 100, { x: 0, y: 0 })),
			position('position', alice, 100, 1, { x: 3, y: 2 })
		);
		const secondOrder = applyWorldPresenceMessage(
			applyWorldPresenceWorldState(initial, position('position', alice, 100, 1, { x: 3, y: 2 })),
			message('message', alice, 100, { x: 0, y: 0 })
		);
		expect(firstOrder).toEqual(secondOrder);
	});

	it('projects Nostr seconds to milliseconds with the existing timeout semantics', () => {
		const state = reconstructWorldPresenceState(field, [
			message('active', alice, 100, { x: 1, y: 1 }),
			message('inactive', bob, 0, { x: 2, y: 2 })
		], []);
		const now = 100 * 1000 + PRESENCE_TIMEOUT_MS;
		const projected = projectWorldPresenceState(state, now);

		expect(projected.participants).toEqual([
			{ id: alice, position: { x: 1, y: 1 }, lastActivityAt: 100000, status: 'inactive' },
			{ id: bob, position: { x: 2, y: 2 }, lastActivityAt: 0, status: 'inactive' }
		]);
		expect(projectWorldPresenceState(state, 100 * 1000 + PRESENCE_TIMEOUT_MS - 1).participants[0].status).toBe('active');
		expect(projectWorldPresenceState(state, 100 * 1000 + PRESENCE_TIMEOUT_MS + 1).participants[0].status).toBe('inactive');
	});

	it('retains inactive position, excludes it from active occupancy, and does not mutate canonical state', () => {
		const state = reconstructWorldPresenceState(field, [message('old', alice, 100, { x: 1, y: 1 })], []);
		const before = structuredClone(state);
		const projected = projectWorldPresenceState(state, 100 * 1000 + PRESENCE_TIMEOUT_MS);

		expect(projected.participants[0]).toMatchObject({ id: alice, position: { x: 1, y: 1 }, status: 'inactive' });
		expect(projected.participants.filter((candidate) => candidate.status === 'active')).toEqual([]);
		expect(state).toEqual(before);
	});

	it('reactivates remote participants at the new evidence position without local random relocation', () => {
		const inactive = reconstructWorldPresenceState(field, [
			message('old', alice, 100, { x: 0, y: 0 }),
			message('peer', bob, 700, { x: 1, y: 1 })
		], []);
		const now = 100 * 1000 + PRESENCE_TIMEOUT_MS;
		expect(projectWorldPresenceState(inactive, now).participants.find((candidate) => candidate.id === alice)?.status).toBe('inactive');

		const reactivated = applyWorldPresenceMessage(inactive, message('new', alice, 700, { x: 1, y: 1 }));
		const projected = projectWorldPresenceState(reactivated, 700 * 1000);
		expect(projected.participants.find((candidate) => candidate.id === alice)).toMatchObject({
			position: { x: 1, y: 1 },
			status: 'active'
		});
		expect(getActiveOccupancy(projected)).toEqual([{ x: 1, y: 1 }, { x: 1, y: 1 }]);
	});

	it('projects exit as inactive with retained position, order-independent same-second precedence, and later reactivation', () => {
		const active = position('active', alice, 500, 0, { x: 2, y: 1 });
		const exit: ParsedWorldStateEvent = { id: 'exit', pubkey: alice, createdAt: 500, state: 'exit', slot: null, position: { x: 2, y: 1 } };
		const first = reconstructWorldPresenceState(field, [], [active, exit]);
		const reversed = reconstructWorldPresenceState(field, [], [exit, active]);
		const projected = projectWorldPresenceState(first, 500 * 1000);
		expect(projected).toEqual(projectWorldPresenceState(reversed, 500 * 1000));
		expect(projected.participants).toEqual([{ id: alice, position: { x: 2, y: 1 }, lastActivityAt: null, status: 'inactive' }]);
		expect(getActiveOccupancy(projected)).toEqual([]);

		const reactivated = applyWorldPresenceWorldState(first, position('new-active', alice, 501, 1, { x: 1, y: 2 }));
		const reactivatedProjection = projectWorldPresenceState(reactivated, 501 * 1000);
		expect(reactivatedProjection.participants.find((candidate) => candidate.id === alice)).toMatchObject({ position: { x: 1, y: 2 }, status: 'active' });
		expect(getActiveOccupancy(reactivatedProjection)).toEqual([{ x: 1, y: 2 }]);
	});
});
