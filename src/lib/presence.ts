import { moveOneCell, type Direction, type FieldSize, type GridPosition } from './geometry';

export const PRESENCE_TIMEOUT_MS = 10 * 60 * 1000;

export type PresenceActivity = 'movement' | 'message' | 'trace-inspection' | 'trace-reply';
export type PresenceStatus = 'active' | 'inactive';

export type PresenceParticipant = {
	id: string;
	position: GridPosition;
	lastActivityAt: number;
	status: PresenceStatus;
};

export type PresenceField = Pick<FieldSize, 'columns' | 'rows'>;

export type PresenceState = {
	field: PresenceField;
	participants: readonly PresenceParticipant[];
};

export type PresenceSnapshot = PresenceState;
export type RandomSource = () => number;

export type MovementResult = {
	state: PresenceState;
	moved: boolean;
};

function samePosition(first: GridPosition, second: GridPosition): boolean {
	return first.x === second.x && first.y === second.y;
}

function copyPosition(position: GridPosition): GridPosition {
	return { x: position.x, y: position.y };
}

function copyParticipant(participant: PresenceParticipant): PresenceParticipant {
	return { ...participant, position: copyPosition(participant.position) };
}

function randomIndex(length: number, random: RandomSource): number {
	if (length <= 1) return 0;
	const value = Math.min(Math.max(random(), 0), 0.999999999);
	return Math.floor(value * length);
}

function activeParticipants(state: PresenceState, excludingId?: string): PresenceParticipant[] {
	return state.participants.filter((participant) =>
		participant.status === 'active' && participant.id !== excludingId
	);
}

function allCells(field: PresenceField): GridPosition[] {
	const cells: GridPosition[] = [];
	for (let y = 0; y < field.rows; y += 1) {
		for (let x = 0; x < field.columns; x += 1) cells.push({ x, y });
	}
	return cells;
}

function chooseSpawnPosition(state: PresenceState, random: RandomSource, excludingId?: string): GridPosition {
	const cells = allCells(state.field);
	const occupied = activeParticipants(state, excludingId).map((participant) => participant.position);
	const empty = cells.filter((cell) => !occupied.some((position) => samePosition(position, cell)));
	return copyPosition((empty.length > 0 ? empty : cells)[randomIndex(empty.length > 0 ? empty.length : cells.length, random)]);
}

function withParticipant(state: PresenceState, id: string, update: (participant: PresenceParticipant) => PresenceParticipant): PresenceState {
	return {
		...state,
		participants: state.participants.map((participant) =>
			participant.id === id ? update(copyParticipant(participant)) : copyParticipant(participant)
		)
	};
}

function reactivatePosition(state: PresenceState, participant: PresenceParticipant, random: RandomSource): GridPosition {
	const occupied = activeParticipants(state, participant.id).map((other) => other.position);
	if (!occupied.some((position) => samePosition(position, participant.position))) {
		return copyPosition(participant.position);
	}
	return chooseSpawnPosition(state, random, participant.id);
}

function activeWithActivity(participant: PresenceParticipant, position: GridPosition, now: number): PresenceParticipant {
	return {
		...participant,
		position: copyPosition(position),
		lastActivityAt: now,
		status: 'active'
	};
}

export function createPresenceState(
	field: PresenceField,
	now: number,
	initialParticipants: readonly Pick<PresenceParticipant, 'id' | 'position'>[] = []
): PresenceState {
	return {
		field: { ...field },
		participants: initialParticipants.map((participant) => ({
			id: participant.id,
			position: copyPosition(participant.position),
			lastActivityAt: now,
			status: 'active'
		}))
	};
}

export function getParticipant(state: PresenceState, id: string): PresenceParticipant | undefined {
	const participant = state.participants.find((candidate) => candidate.id === id);
	return participant ? copyParticipant(participant) : undefined;
}

export function getActiveParticipantIds(state: PresenceState): Set<string> {
	return new Set(activeParticipants(state).map((participant) => participant.id));
}

export function getActiveOccupancy(state: PresenceState, excludingId?: string): readonly GridPosition[] {
	return activeParticipants(state, excludingId).map((participant) => copyPosition(participant.position));
}

export function spawnParticipant(
	state: PresenceState,
	id: string,
	now: number,
	random: RandomSource = Math.random
): PresenceState {
	if (state.participants.some((participant) => participant.id === id)) return state;
	const position = chooseSpawnPosition(state, random);
	return {
		...state,
		participants: [
			...state.participants.map(copyParticipant),
			{ id, position, lastActivityAt: now, status: 'active' }
		]
	};
}

/**
 * Places a participant for a new world entry. Unlike reactivation, an expired
 * participant is assigned from the current active occupancy instead of
 * retaining its old cell.
 */
export function enterParticipant(
	state: PresenceState,
	id: string,
	now: number,
	random: RandomSource = Math.random
): PresenceState {
	const participant = state.participants.find((candidate) => candidate.id === id);
	if (participant?.status === 'active') return state;

	const position = chooseSpawnPosition(state, random);
	if (!participant) {
		return {
			...state,
			participants: [
				...state.participants.map(copyParticipant),
				{ id, position, lastActivityAt: now, status: 'active' }
			]
		};
	}

	return withParticipant(state, id, (current) => activeWithActivity(current, position, now));
}

export function recordPresenceActivity(
	state: PresenceState,
	id: string,
	_activity: PresenceActivity,
	now: number,
	random: RandomSource = Math.random
): PresenceState {
	const participant = state.participants.find((candidate) => candidate.id === id);
	if (!participant) return state;

	const position = participant.status === 'active'
		? participant.position
		: reactivatePosition(state, participant, random);
	return withParticipant(state, id, (current) => activeWithActivity(current, position, now));
}

export function moveParticipant(
	state: PresenceState,
	id: string,
	direction: Direction,
	now: number,
	random: RandomSource = Math.random
): MovementResult {
	const participant = state.participants.find((candidate) => candidate.id === id);
	if (!participant) return { state, moved: false };

	const origin = participant.status === 'active'
		? participant.position
		: reactivatePosition(state, participant, random);
	const next = moveOneCell(origin, direction, state.field, getActiveOccupancy(state, id));
	if (!next) return { state, moved: false };

	return {
		state: withParticipant(state, id, (current) => activeWithActivity(current, next, now)),
		moved: true
	};
}

export function prunePresence(state: PresenceState, now: number): PresenceState {
	let changed = false;
	const participants = state.participants.map((participant) => {
		if (participant.status === 'inactive' || now - participant.lastActivityAt < PRESENCE_TIMEOUT_MS) {
			return copyParticipant(participant);
		}
		changed = true;
		return { ...copyParticipant(participant), status: 'inactive' as const };
	});
	return changed ? { ...state, participants } : state;
}

export function reconstructPresenceState(snapshot: PresenceSnapshot, now: number): PresenceState {
	return {
		field: { ...snapshot.field },
		participants: snapshot.participants.map((participant) => ({
			...copyParticipant(participant),
			status: now - participant.lastActivityAt < PRESENCE_TIMEOUT_MS ? 'active' : 'inactive'
		}))
	};
}

export function debugTimeoutParticipant(state: PresenceState, id: string): PresenceState {
	return withParticipant(state, id, (participant) => ({ ...participant, status: 'inactive' }));
}

export function debugSetParticipantPosition(
	state: PresenceState,
	id: string,
	position: GridPosition
): PresenceState {
	if (
		position.x < 0 ||
		position.x >= state.field.columns ||
		position.y < 0 ||
		position.y >= state.field.rows
	) return state;

	return withParticipant(state, id, (participant) => ({
		...participant,
		position: copyPosition(position),
		status: 'active'
	}));
}
