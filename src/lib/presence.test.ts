import { describe, expect, it } from 'vitest';
import { getSameCellVisualOffset, type Direction } from './geometry';
import {
	PRESENCE_TIMEOUT_MS,
	createPresenceState,
	debugTimeoutParticipant,
	enterParticipant,
	getActiveOccupancy,
	getParticipant,
	moveParticipant,
	prunePresence,
	recordPresenceActivity,
	reconstructPresenceState,
	spawnParticipant,
	type PresenceState
} from './presence';

const field = { columns: 3, rows: 3 };
const smallField = { columns: 3, rows: 2 };
const at = (state: PresenceState, id: string) => getParticipant(state, id)!;
const rng = (value: number) => () => value;

function seeded(position: { x: number; y: number } = { x: 0, y: 0 }, now = 1): PresenceState {
	return createPresenceState(field, now, [{ id: 'alice', position }]);
}

describe('local position and presence domain', () => {
	it('spawns a participant in an empty field', () => {
		const state = spawnParticipant(createPresenceState(smallField, 10), 'alice', 10, rng(0));

		expect(at(state, 'alice')).toMatchObject({ position: { x: 0, y: 0 }, status: 'active', lastActivityAt: 10 });
	});

	it('avoids occupied cells when spawning', () => {
		let state = createPresenceState(smallField, 1, [{ id: 'alice', position: { x: 0, y: 0 } }]);
		state = spawnParticipant(state, 'bob', 10, rng(0));

		expect(at(state, 'bob').position).not.toEqual(at(state, 'alice').position);
	});

	it('uses injected RNG to choose a deterministic spawn', () => {
		const initial = createPresenceState(smallField, 1, [{ id: 'alice', position: { x: 0, y: 0 } }]);
		const first = spawnParticipant(initial, 'bob', 10, rng(0.99));
		const second = spawnParticipant(initial, 'bob', 10, rng(0.99));

		expect(second).toEqual(first);
		expect(at(first, 'bob').position).toEqual({ x: 2, y: 1 });
	});

	it('spawns on an existing cell when the field is full', () => {
		let state = createPresenceState(smallField, 10, [
			{ id: 'a', position: { x: 0, y: 0 } },
			{ id: 'b', position: { x: 1, y: 0 } },
			{ id: 'c', position: { x: 2, y: 0 } },
			{ id: 'd', position: { x: 0, y: 1 } },
			{ id: 'e', position: { x: 1, y: 1 } },
			{ id: 'f', position: { x: 2, y: 1 } }
		]);
		state = spawnParticipant(state, 'g', 10, rng(0));

		expect(state.participants).toHaveLength(7);
		expect(at(state, 'g').position).toEqual({ x: 0, y: 0 });
	});

	it('treats an expired participant as a new entry instead of restoring its old cell', () => {
		let state = createPresenceState(smallField, 10, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'bob', position: { x: 0, y: 0 } }
		]);
		state = debugTimeoutParticipant(state, 'alice');

		const entered = enterParticipant(state, 'alice', 20, rng(0));

		expect(at(entered, 'alice')).toMatchObject({ position: { x: 1, y: 0 }, status: 'active', lastActivityAt: 20 });
	});

	it.each([
		['up', { x: 1, y: 0 }],
		['up-right', { x: 2, y: 0 }],
		['down', { x: 1, y: 2 }],
		['down-right', { x: 2, y: 2 }],
		['left', { x: 0, y: 1 }],
		['down-left', { x: 0, y: 2 }],
		['right', { x: 2, y: 1 }],
		['up-left', { x: 0, y: 0 }]
	] as const)('moves an active participant one cell %s', (direction: Direction, expected) => {
		const result = moveParticipant(seeded({ x: 1, y: 1 }, 10), 'alice', direction, 20);

		expect(result.moved).toBe(true);
		expect(at(result.state, 'alice')).toMatchObject({ position: expected, lastActivityAt: 20, status: 'active' });
	});

	it('rejects movement outside the field', () => {
		const result = moveParticipant(seeded({ x: 0, y: 0 }, 10), 'alice', 'up', 20);

		expect(result.moved).toBe(false);
		expect(result.state).toEqual(seeded({ x: 0, y: 0 }, 10));
	});

	it('rejects movement into an occupied active cell', () => {
		const state = createPresenceState(field, 10, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'bob', position: { x: 1, y: 0 } }
		]);
		const result = moveParticipant(state, 'alice', 'right', 20);

		expect(result.moved).toBe(false);
		expect(result.state).toEqual(state);
	});

	it('does not update activity on failed movement', () => {
		const result = moveParticipant(seeded({ x: 0, y: 0 }, 10), 'alice', 'left', 20);

		expect(at(result.state, 'alice').lastActivityAt).toBe(10);
	});

	it('updates activity on successful movement', () => {
		const result = moveParticipant(seeded({ x: 0, y: 0 }, 10), 'alice', 'right', 20);

		expect(at(result.state, 'alice').lastActivityAt).toBe(20);
	});

	it.each(['message', 'trace-inspection'] as const)('records %s activity without moving an active participant', (activity) => {
		const state = recordPresenceActivity(seeded({ x: 1, y: 1 }, 10), 'alice', activity, 20);

		expect(at(state, 'alice')).toMatchObject({ position: { x: 1, y: 1 }, lastActivityAt: 20, status: 'active' });
	});

	it('stays active before the ten minute timeout', () => {
		const state = prunePresence(seeded({ x: 1, y: 1 }, 10), 10 + PRESENCE_TIMEOUT_MS - 1);

		expect(at(state, 'alice').status).toBe('active');
	});

	it('times out exactly at ten minutes', () => {
		const state = prunePresence(seeded({ x: 1, y: 1 }, 10), 10 + PRESENCE_TIMEOUT_MS);

		expect(at(state, 'alice').status).toBe('inactive');
	});

	it('removes timed out participants from occupancy but retains the last position', () => {
		const state = prunePresence(seeded({ x: 1, y: 1 }, 10), 10 + PRESENCE_TIMEOUT_MS);

		expect(getActiveOccupancy(state)).toEqual([]);
		expect(at(state, 'alice')).toMatchObject({ position: { x: 1, y: 1 }, status: 'inactive' });
	});

	it('reactivates at the retained position when it is free', () => {
		let state = prunePresence(seeded({ x: 1, y: 1 }, 10), 10 + PRESENCE_TIMEOUT_MS);
		state = recordPresenceActivity(state, 'alice', 'message', 100, rng(0));

		expect(at(state, 'alice')).toMatchObject({ position: { x: 1, y: 1 }, lastActivityAt: 100, status: 'active' });
	});

	it('reactivates at an empty cell when the retained position is occupied', () => {
		let state = createPresenceState(smallField, 10, [
			{ id: 'alice', position: { x: 1, y: 1 } },
			{ id: 'bob', position: { x: 1, y: 1 } }
		]);
		state = debugTimeoutParticipant(state, 'alice');
		state = recordPresenceActivity(state, 'alice', 'message', 100, rng(0));

		expect(at(state, 'alice').position).toEqual({ x: 0, y: 0 });
		expect(at(state, 'alice').status).toBe('active');
	});

	it('allows duplicate reactivation when the field is full', () => {
		let state = createPresenceState(smallField, 10, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'b', position: { x: 0, y: 0 } },
			{ id: 'c', position: { x: 1, y: 0 } },
			{ id: 'd', position: { x: 2, y: 0 } },
			{ id: 'e', position: { x: 0, y: 1 } },
			{ id: 'f', position: { x: 1, y: 1 } },
			{ id: 'g', position: { x: 2, y: 1 } }
		]);
		state = debugTimeoutParticipant(state, 'alice');
		state = recordPresenceActivity(state, 'alice', 'message', 100, rng(0.5));

		expect(at(state, 'alice').position).toEqual({ x: 0, y: 1 });
	});

	it('reconstructs active and inactive state from last activity time', () => {
		const snapshot = seeded({ x: 2, y: 1 }, 10);
		const active = reconstructPresenceState(snapshot, 10 + PRESENCE_TIMEOUT_MS - 1);
		const inactive = reconstructPresenceState(snapshot, 10 + PRESENCE_TIMEOUT_MS);

		expect(at(active, 'alice')).toMatchObject({ status: 'active', position: { x: 2, y: 1 } });
		expect(at(inactive, 'alice')).toMatchObject({ status: 'inactive', position: { x: 2, y: 1 } });
	});

	it('preserves existing same-cell conflicts', () => {
		const state = createPresenceState(field, 10, [
			{ id: 'alice', position: { x: 0, y: 0 } },
			{ id: 'bob', position: { x: 0, y: 0 } }
		]);

		expect(state.participants.map((participant) => participant.position)).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
	});

	it('is deterministic for the same state, input, and RNG', () => {
		const first = moveParticipant(seeded({ x: 1, y: 1 }, 10), 'alice', 'right', 20, rng(0.3));
		const second = moveParticipant(seeded({ x: 1, y: 1 }, 10), 'alice', 'right', 20, rng(0.3));

		expect(second).toEqual(first);
	});

	it('assigns deterministic offsets to same-cell peers without changing logical positions', () => {
		const first = getSameCellVisualOffset('alice', ['bob', 'alice'], 56);
		const second = getSameCellVisualOffset('alice', ['alice', 'bob'], 56);

		expect(first).toEqual(second);
		expect(first).not.toEqual({ x: 0, y: 0 });
	});
});
