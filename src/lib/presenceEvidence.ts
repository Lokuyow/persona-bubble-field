import type { GridPosition } from './geometry';
import type { ParsedWorldStateEvent, ParsedWorldMessage } from './nostrProtocol';

export type PresenceEvidenceSource = 'message' | 'world-state-slot-0' | 'world-state-slot-1' | 'world-state-exit';

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
	lastPositiveActivityCreatedAt: number | null;
	latestExitCreatedAt: number | null;
}>;

function sourceRank(source: PresenceEvidenceSource): number {
	if (source === 'message') return 0;
	if (source === 'world-state-slot-0') return 1;
	if (source === 'world-state-slot-1') return 2;
	return 3;
}

function isPositiveSource(source: PresenceEvidenceSource): boolean {
	return source !== 'world-state-exit';
}

export function comparePresenceEvidence(first: PresenceEvidence, second: PresenceEvidence): number {
	if (first.createdAt !== second.createdAt) return first.createdAt - second.createdAt;
	const rankDifference = sourceRank(first.source) - sourceRank(second.source);
	if (rankDifference !== 0) return rankDifference;
	if (first.eventId < second.eventId) return 1;
	if (first.eventId > second.eventId) return -1;
	return 0;
}

function copyPosition(position: GridPosition): GridPosition { return { x: position.x, y: position.y }; }
function copyEvidence(evidence: PresenceEvidence): PresenceEvidence { return { ...evidence, position: copyPosition(evidence.position) }; }

function copyReducedParticipant(participant: ReducedPresenceParticipant): ReducedPresenceParticipant {
	return {
		pubkey: participant.pubkey,
		position: copyPosition(participant.position),
		positionEvidence: { ...participant.positionEvidence },
		lastPositiveActivityCreatedAt: participant.lastPositiveActivityCreatedAt,
		latestExitCreatedAt: participant.latestExitCreatedAt
	};
}

function reducedParticipant(evidence: PresenceEvidence): ReducedPresenceParticipant {
	return {
		pubkey: evidence.pubkey,
		position: copyPosition(evidence.position),
		positionEvidence: { eventId: evidence.eventId, createdAt: evidence.createdAt, source: evidence.source },
		lastPositiveActivityCreatedAt: isPositiveSource(evidence.source) ? evidence.createdAt : null,
		latestExitCreatedAt: evidence.source === 'world-state-exit' ? evidence.createdAt : null
	};
}

export function presenceEvidenceFromMessage(message: ParsedWorldMessage): PresenceEvidence | null {
	if (message.source === 'death') return null;
	return { eventId: message.id, pubkey: message.pubkey, createdAt: message.createdAt, position: copyPosition(message.position), source: 'message' };
}

export function presenceEvidenceFromWorldState(event: ParsedWorldStateEvent): PresenceEvidence {
	return {
		eventId: event.id,
		pubkey: event.pubkey,
		createdAt: event.createdAt,
		position: copyPosition(event.position),
		source: event.state === 'exit' ? 'world-state-exit' : event.slot === 0 ? 'world-state-slot-0' : 'world-state-slot-1'
	};
}

export function applyPresenceEvidence(current: ReducedPresenceParticipant | undefined, evidence: PresenceEvidence): ReducedPresenceParticipant {
	if (!current) return reducedParticipant(evidence);
	if (current.pubkey !== evidence.pubkey) throw new TypeError('Presence evidence pubkey must match the current participant pubkey.');
	const currentEvidence: PresenceEvidence = {
		eventId: current.positionEvidence.eventId,
		pubkey: current.pubkey,
		createdAt: current.positionEvidence.createdAt,
		position: current.position,
		source: current.positionEvidence.source
	};
	const nextEvidence = comparePresenceEvidence(evidence, currentEvidence) > 0 ? copyEvidence(evidence) : currentEvidence;
	const currentPositive = current.lastPositiveActivityCreatedAt;
	const positive = isPositiveSource(evidence.source) ? Math.max(currentPositive ?? -1, evidence.createdAt) : currentPositive;
	const exit = evidence.source === 'world-state-exit' ? Math.max(current.latestExitCreatedAt ?? -1, evidence.createdAt) : (current.latestExitCreatedAt ?? null);
	return {
		pubkey: current.pubkey,
		position: copyPosition(nextEvidence.position),
		positionEvidence: { eventId: nextEvidence.eventId, createdAt: nextEvidence.createdAt, source: nextEvidence.source },
		lastPositiveActivityCreatedAt: positive,
		latestExitCreatedAt: exit
	};
}

export function reconstructPresenceEvidence(messages: readonly ParsedWorldMessage[], worldStates: readonly ParsedWorldStateEvent[]): ReducedPresenceParticipant[] {
	const participants = new Map<string, ReducedPresenceParticipant>();
	const evidence = [...messages.map(presenceEvidenceFromMessage).filter((item): item is PresenceEvidence => item !== null), ...worldStates.map(presenceEvidenceFromWorldState)];
	for (const item of evidence) participants.set(item.pubkey, applyPresenceEvidence(participants.get(item.pubkey), item));
	return [...participants.values()]
		.sort((first, second) => first.pubkey < second.pubkey ? -1 : first.pubkey > second.pubkey ? 1 : 0)
		.map(copyReducedParticipant);
}
