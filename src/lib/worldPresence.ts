import type { GridPosition } from './geometry';
import {
	applyPresenceEvidence,
	presenceEvidenceFromMessage,
	presenceEvidenceFromPosition,
	reconstructPresenceEvidence,
	type ReducedPresenceParticipant
} from './presenceEvidence';
import {
	reconstructPresenceState,
	type PresenceField,
	type PresenceSnapshot,
	type PresenceState
} from './presence';
import type { ParsedPositionEvent, ParsedWorldMessage } from './nostrProtocol';

export type WorldPresenceState = Readonly<{
	field: PresenceField;
	participants: readonly ReducedPresenceParticipant[];
}>;

function copyPosition(position: GridPosition): GridPosition {
	return { x: position.x, y: position.y };
}

function copyParticipant(participant: ReducedPresenceParticipant): ReducedPresenceParticipant {
	return {
		pubkey: participant.pubkey,
		position: copyPosition(participant.position),
		positionEvidence: { ...participant.positionEvidence },
		lastActivityCreatedAt: participant.lastActivityCreatedAt
	};
}

function compareParticipants(first: ReducedPresenceParticipant, second: ReducedPresenceParticipant): number {
	return first.pubkey < second.pubkey ? -1 : first.pubkey > second.pubkey ? 1 : 0;
}

function isWithinField(position: GridPosition, field: PresenceField): boolean {
	return position.x >= 0 && position.x < field.columns && position.y >= 0 && position.y < field.rows;
}

function sortedParticipants(participants: readonly ReducedPresenceParticipant[]): ReducedPresenceParticipant[] {
	return [...participants].sort(compareParticipants).map(copyParticipant);
}

function applyWorldPresenceEvidence(
	state: WorldPresenceState,
	evidence: Parameters<typeof applyPresenceEvidence>[1]
): WorldPresenceState {
	const current = state.participants.find((participant) => participant.pubkey === evidence.pubkey);
	const next = applyPresenceEvidence(current, evidence);
	return {
		field: { ...state.field },
		participants: sortedParticipants([
			...state.participants.filter((participant) => participant.pubkey !== evidence.pubkey),
			next
		])
	};
}

/** Reconstructs world presence after rejecting coordinates outside this field. */
export function reconstructWorldPresenceState(
	field: PresenceField,
	messages: readonly ParsedWorldMessage[],
	positions: readonly ParsedPositionEvent[]
): WorldPresenceState {
	const validMessages = messages.filter((message) => isWithinField(message.position, field));
	const validPositions = positions.filter((position) => isWithinField(position.position, field));

	return {
		field: { ...field },
		participants: reconstructPresenceEvidence(validMessages, validPositions)
	};
}

/** Applies one live message without invoking local presence lifecycle semantics. */
export function applyWorldPresenceMessage(
	state: WorldPresenceState,
	message: ParsedWorldMessage
): WorldPresenceState {
	if (!isWithinField(message.position, state.field)) return state;
	return applyWorldPresenceEvidence(state, presenceEvidenceFromMessage(message));
}

/** Applies one live position event without invoking local presence lifecycle semantics. */
export function applyWorldPresencePosition(
	state: WorldPresenceState,
	position: ParsedPositionEvent
): WorldPresenceState {
	if (!isWithinField(position.position, state.field)) return state;
	return applyWorldPresenceEvidence(state, presenceEvidenceFromPosition(position));
}

/** Projects Nostr seconds into the existing millisecond-based presence domain. */
export function projectWorldPresenceState(state: WorldPresenceState, nowMs: number): PresenceState {
	const snapshot: PresenceSnapshot = {
		field: { ...state.field },
		participants: state.participants.map((participant) => ({
			id: participant.pubkey,
			position: copyPosition(participant.position),
			lastActivityAt: participant.lastActivityCreatedAt * 1000,
			status: 'active'
		}))
	};

	return reconstructPresenceState(snapshot, nowMs);
}
