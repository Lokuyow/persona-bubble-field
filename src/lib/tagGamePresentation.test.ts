import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { resolveCharacterFromPubkey } from './characterAssignment';
import { isOwnTagGameStartTransition, newlyConfirmedTagGameParticipants, tagGameCharacterName, tagGameParticipantLabel } from './tagGamePresentation';
import type { TagGameState } from './tagGame';

function secret(seed: number): Uint8Array { return new Uint8Array(32).fill(seed); }
function findAssignedPubkey(): string {
	for (let value = 1; value < 256; value++) {
		try { const pubkey = getPublicKey(secret(value)); if (resolveCharacterFromPubkey(pubkey)) return pubkey; }
		catch { /* Repeated-byte values outside the secp256k1 scalar range are skipped. */ }
	}
	throw new Error('Expected a deterministic assigned fixture pubkey.');
}
const host = findAssignedPubkey();
const duplicateA = getPublicKey(secret(52));
const duplicateB = getPublicKey(secret(53));

const game: TagGameState = {
	gameId: `${host}:1:${'a'.repeat(64)}`, hostPubkey: host, phase: 'lobby', revision: 0, updatedAt: 1, settledAtMs: 1_000,
	participant: [host, duplicateA, duplicateB].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: 1, status: 'registered', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }))
};

describe('tag-game character presentation', () => {
	it('uses the World character name and calls the local player あなた', () => {
		expect(tagGameCharacterName(host, host)).toBe('あなた');
		expect(tagGameCharacterName(host, null)).toBe(resolveCharacterFromPubkey(host)!.name);
	});

	it('uses the existing World fallback for an unassigned character slot', () => {
		for (let value = 1; value < 256; value++) {
			let pubkey: string;
			try { pubkey = getPublicKey(secret(value)); } catch { continue; }
			if (tagGameCharacterName(pubkey, null) === '不明なキャラクター') {
				expect(tagGameCharacterName(pubkey, null)).not.toContain(pubkey.slice(0, 8));
				return;
			}
		}
		throw new Error('Expected deterministic test keys to include an unassigned character slot.');
	});

	it('distinguishes same-name participants with stable in-game ordinals', () => {
		const sharedSlot = new Map<string, string>();
		for (let value = 1; value < 256; value++) {
			let pubkey: string;
			try { pubkey = getPublicKey(secret(value)); } catch { continue; }
			const name = tagGameCharacterName(pubkey, null);
			if (name === '不明なキャラクター') continue;
			if (sharedSlot.has(name)) {
				const first = sharedSlot.get(name)!;
				const duplicateGame = { ...game, participant: [
					{ ...game.participant[0], pubkey: first },
					{ ...game.participant[1], pubkey },
				] };
				expect(tagGameParticipantLabel(duplicateGame, first, host)).toBe(`${name}（同名1）`);
				expect(tagGameParticipantLabel(duplicateGame, pubkey, host)).toBe(`${name}（同名2）`);
				return;
			}
			sharedSlot.set(name, pubkey);
		}
		throw new Error('Expected deterministic test keys to include two pubkeys for one assigned character.');
	});

	it('finds all additions in one confirmed state and treats a departed participant who rejoins as new', () => {
		const joinedA = getPublicKey(secret(54));
		const joinedB = getPublicKey(secret(55));
		const previous = { ...game, participant: [game.participant[0]] };
		const joined = { ...game, participant: [...previous.participant, ...[joinedA, joinedB].map((pubkey) => ({ pubkey, runNumber: 1, registeredAt: 2, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }))] };
		expect(newlyConfirmedTagGameParticipants(null, joined)).toEqual([]);
		expect(newlyConfirmedTagGameParticipants(previous, joined)).toEqual([joinedA, joinedB]);
		const departed = { ...joined, participant: joined.participant.map((member) => member.pubkey === joinedA ? { ...member, status: 'left' as const } : member) };
		expect(newlyConfirmedTagGameParticipants(departed, joined)).toEqual([joinedA]);
	});

	it('recognizes only an observed running transition for the exact local Run', () => {
		const hostMember = game.participant[0];
		const countdown: TagGameState = { ...game, phase: 'countdown', participant: [{ ...hostMember, status: 'active' }] };
		const running: TagGameState = { ...countdown, phase: 'running', startedAt: 2, endsAt: 182, seed: 'seed', ownerPubkey: host, effect: 'benefit' };
		expect(isOwnTagGameStartTransition(countdown, running, host, 1)).toBe(true);
		expect(isOwnTagGameStartTransition(null, running, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition(running, { ...running, revision: 1 }, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition(countdown, running, host, 2)).toBe(false);
		expect(isOwnTagGameStartTransition(countdown, { ...running, participant: [] }, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition({ ...countdown, gameId: `${host}:2:${'b'.repeat(64)}` }, running, host, 1)).toBe(false);
	});
});
