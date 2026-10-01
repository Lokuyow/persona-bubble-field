import type { ParsedWorldStateEvent } from './nostrProtocol';
import { comparePresenceEvidence, presenceEvidenceFromWorldState } from './presenceEvidence';

/** Session-owned Run evidence used only to label a participant's presentation. */
export function createProfileRunEvidenceStore() {
	let session = 0;
	let events = new Map<string, ParsedWorldStateEvent>();
	return {
		beginSession(): number {
			session += 1;
			events = new Map();
			return session;
		},
		accept(sessionId: number, event: ParsedWorldStateEvent): boolean {
			if (sessionId !== session) return false;
			const previous = events.get(event.pubkey);
			if (previous && comparePresenceEvidence(presenceEvidenceFromWorldState(event), presenceEvidenceFromWorldState(previous)) <= 0) return false;
			events.set(event.pubkey, event);
			return true;
		},
		snapshot(): ReadonlyMap<string, ParsedWorldStateEvent> {
			return new Map(events);
		}
	};
}

export function profileRunNumberForActiveParticipant(
	evidence: ParsedWorldStateEvent | null,
	participant: Readonly<{ id: string; status: string; lastActivityAt: number | null }> | null,
	presenceTimeoutMs: number
): number | null {
	if (!evidence || !participant || participant.id !== evidence.pubkey || participant.status !== 'active' ||
		evidence.state !== 'active' || !Number.isSafeInteger(evidence.runNumber) || !evidence.runNumber ||
		participant.lastActivityAt === null || evidence.createdAt * 1_000 > participant.lastActivityAt ||
		participant.lastActivityAt - evidence.createdAt * 1_000 >= presenceTimeoutMs) return null;
	return evidence.runNumber;
}
