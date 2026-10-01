import { describe, expect, it } from 'vitest';
import { createProfileRunEvidenceStore, profileRunNumberForActiveParticipant } from './profileRunEvidence';
import type { ParsedWorldStateEvent } from './nostrProtocol';

const pubkey = 'a'.repeat(64);
const runEvidence = (runNumber: number, id: string): ParsedWorldStateEvent => ({
	id, pubkey, createdAt: runNumber, state: 'active', slot: 0, position: { x: 2, y: 1 }, runNumber, exitReason: null
});

describe('Profile Run evidence session ownership', () => {
	it('drops old-session Run evidence before accepting the replacement session events', () => {
		const store = createProfileRunEvidenceStore();
		const oldSession = store.beginSession();
		const oldRun = runEvidence(1, 'old-run');
		expect(store.accept(oldSession, oldRun)).toBe(true);
		expect(store.snapshot().get(pubkey)).toBe(oldRun);

		const currentSession = store.beginSession();
		const newSessionMessagesAndPresenceArrived = true;
		expect(newSessionMessagesAndPresenceArrived).toBe(true);
		expect(store.snapshot().has(pubkey)).toBe(false);
		const newSessionPresence = { id: pubkey, status: 'active', lastActivityAt: 2_000 };
		expect(profileRunNumberForActiveParticipant(store.snapshot().get(pubkey) ?? null, newSessionPresence, 600_000)).toBeNull();
		expect(store.accept(oldSession, runEvidence(1, 'late-old-session-run'))).toBe(false);
		expect(store.snapshot().has(pubkey)).toBe(false);
		expect(store.accept(currentSession, runEvidence(2, 'new-run'))).toBe(true);
		expect(store.snapshot().get(pubkey)?.runNumber).toBe(2);
	});
});
