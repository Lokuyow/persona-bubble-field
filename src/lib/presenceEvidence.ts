import type { GridPosition } from './geometry';
import type { ParsedPositionEvent, ParsedWorldMessage } from './nostrProtocol';

export type PresenceEvidenceSource = 'message' | 'position-slot-0' | 'position-slot-1';

export type PresenceEvidence = Readonly<{
	eventId: string;
	pubkey: string;
	createdAt: number;
	position: GridPosition;
	source: PresenceEvidenceSource;
}>;

export type ReducedPresenceParticipant = Readonly<{
	pubkey: string;
	position: GridPosition;
	positionEvidence: Readonly<Pick<PresenceEvidence, 'eventId' | 'createdAt' | 'source'>>;
	lastActivityCreatedAt: number;
}>;

function sourceRank(source: PresenceEvidenceSource): number {
	if (source === 'message') return 0;
	if (source === 'position-slot-0') return 1;
	return 2;
}

function comparePositionEvidence(first: PresenceEvidence, second: PresenceEvidence): number {
	if (first.createdAt !== second.createdAt) return first.createdAt - second.createdAt;

	const rankDifference = sourceRank(first.source) - sourceRank(second.source);
	if (rankDifference !== 0) return rankDifference;
	if (first.eventId < second.eventId) return 1;
	if (first.eventId > second.eventId) return -1;
	return 0;
}

function copyPosition(position: GridPosition): GridPosition {
	return { x: position.x, y: position.y };
}

function copyEvidence(evidence: PresenceEvidence): PresenceEvidence {
	return { ...evidence, position: copyPosition(evidence.position) };
}

function copyReducedParticipant(participant: ReducedPresenceParticipant): ReducedPresenceParticipant {
	return {
		pubkey: participant.pubkey,
		position: copyPosition(participant.position),
		positionEvidence: { ...participant.positionEvidence },
		lastActivityCreatedAt: participant.lastActivityCreatedAt
	};
}

function reducedParticipant(evidence: PresenceEvidence): ReducedPresenceParticipant {
	return {
		pubkey: evidence.pubkey,
		position: copyPosition(evidence.position),
		positionEvidence: {
			eventId: evidence.eventId,
			createdAt: evidence.createdAt,
			source: evidence.source
		},
		lastActivityCreatedAt: evidence.createdAt
	};
}

function messageEvidence(message: ParsedWorldMessage): PresenceEvidence {
	return {
		eventId: message.id,
		pubkey: message.pubkey,
		createdAt: message.createdAt,
		position: copyPosition(message.position),
		source: 'message'
	};
}

function positionEvidence(event: ParsedPositionEvent): PresenceEvidence {
	return {
		eventId: event.id,
		pubkey: event.pubkey,
		createdAt: event.createdAt,
		position: copyPosition(event.position),
		source: event.slot === 0 ? 'position-slot-0' : 'position-slot-1'
	};
}

/** Applies one already-validated evidence item without mutating the input. */
export function applyPresenceEvidence(
	current: ReducedPresenceParticipant | undefined,
	evidence: PresenceEvidence
): ReducedPresenceParticipant {
	if (!current) return reducedParticipant(evidence);
	if (current.pubkey !== evidence.pubkey) {
		throw new TypeError('Presence evidence pubkey must match the current participant pubkey.');
	}

	const currentEvidence: PresenceEvidence = {
		eventId: current.positionEvidence.eventId,
		pubkey: current.pubkey,
		createdAt: current.positionEvidence.createdAt,
		position: current.position,
		source: current.positionEvidence.source
	};
	const nextEvidence = comparePositionEvidence(evidence, currentEvidence) > 0
		? copyEvidence(evidence)
		: currentEvidence;

	return {
		pubkey: current.pubkey,
		position: copyPosition(nextEvidence.position),
		positionEvidence: {
			eventId: nextEvidence.eventId,
			createdAt: nextEvidence.createdAt,
			source: nextEvidence.source
		},
		lastActivityCreatedAt: Math.max(current.lastActivityCreatedAt, evidence.createdAt)
	};
}

/** Reconstructs deterministic per-pubkey presence evidence from parsed events. */
export function reconstructPresenceEvidence(
	messages: readonly ParsedWorldMessage[],
	positions: readonly ParsedPositionEvent[]
): ReducedPresenceParticipant[] {
	const participants = new Map<string, ReducedPresenceParticipant>();
	const evidence = [
		...messages.map(messageEvidence),
		...positions.map(positionEvidence)
	];

	for (const item of evidence) {
		participants.set(item.pubkey, applyPresenceEvidence(participants.get(item.pubkey), item));
	}

	return [...participants.values()].sort((first, second) =>
		first.pubkey < second.pubkey ? -1 : first.pubkey > second.pubkey ? 1 : 0
	).map(copyReducedParticipant);
}
