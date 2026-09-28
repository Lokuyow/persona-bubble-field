import { getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { resolveCharacterFromPubkey } from './characterAssignment';
import { isOwnTagGameCountdown, isOwnTagGameStartTransition, newlyConfirmedTagGameParticipants, tagGameCharacterName, tagGameCountdownSeconds, tagGameParticipantLabel, tagGameResultLifespan, tagGameResultParticipants, tagGameResultTime } from './tagGamePresentation';
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
		const running: TagGameState = { ...countdown, phase: 'running', startedAt: 2, endsAt: 122, seed: 'seed', ownerPubkey: host, effect: 'benefit' };
		expect(isOwnTagGameStartTransition(countdown, running, host, 1)).toBe(true);
		expect(isOwnTagGameStartTransition(null, running, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition(running, { ...running, revision: 1 }, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition(countdown, running, host, 2)).toBe(false);
		expect(isOwnTagGameStartTransition(countdown, { ...running, participant: [] }, host, 1)).toBe(false);
		expect(isOwnTagGameStartTransition({ ...countdown, gameId: `${host}:2:${'b'.repeat(64)}` }, running, host, 1)).toBe(false);
	});

	it('identifies only the signed countdown for the exact local participant Run', () => {
		const countdown: TagGameState = { ...game, phase: 'countdown', startAt: 10,
			participant: [{ ...game.participant[0], status: 'registered' }] };
		expect(isOwnTagGameCountdown(countdown, host, 1)).toBe(true);
		expect(isOwnTagGameCountdown(countdown, host, 2)).toBe(false);
		expect(isOwnTagGameCountdown(countdown, duplicateA, 1)).toBe(false);
		expect(isOwnTagGameCountdown({ ...countdown, phase: 'lobby' }, host, 1)).toBe(false);
	});

	it('derives only current countdown seconds from the host start time', () => {
		expect(tagGameCountdownSeconds(10, 5_000)).toBe(5);
		expect(tagGameCountdownSeconds(10, 5_001)).toBe(5);
		expect(tagGameCountdownSeconds(10, 6_000)).toBe(4);
		expect(tagGameCountdownSeconds(10, 9_999)).toBe(1);
		expect(tagGameCountdownSeconds(10, 10_000)).toBeNull();
		expect(tagGameCountdownSeconds(10, 0)).toBeNull();
	});

	it('orders result participants by registration and moves only the local player to the front', () => {
		const later = getPublicKey(secret(56));
		const earlier = getPublicKey(secret(57));
		const resultGame = { ...game, participant: [
			{ ...game.participant[0], registeredAt: 30 },
			{ ...game.participant[1], pubkey: later, registeredAt: 20 },
			{ ...game.participant[2], pubkey: earlier, registeredAt: 10 },
		] };
		expect(tagGameResultParticipants(resultGame, null).map((member) => member.pubkey)).toEqual([earlier, later, host]);
		expect(tagGameResultParticipants(resultGame, later).map((member) => member.pubkey)).toEqual([later, earlier, host]);
	});

	it('rounds effect hold time to tenths of seconds and omits a zero decimal', () => {
		expect(tagGameResultTime(35_521)).toBe('35.5');
		expect(tagGameResultTime(57_501)).toBe('57.5');
		expect(tagGameResultTime(24_479)).toBe('24.5');
		expect(tagGameResultTime(10_000)).toBe('10');
	});

	it('formats lifespan loss as rounded hours or days and carries rounded hours into days', () => {
		const hour = 3_600_000;
		expect(tagGameResultLifespan(2.499 * hour)).toBe('2.5時間');
		expect(tagGameResultLifespan(23.94 * hour)).toBe('23.9時間');
		expect(tagGameResultLifespan(23.96 * hour)).toBe('1日');
		expect(tagGameResultLifespan(24 * hour)).toBe('1日');
		expect(tagGameResultLifespan(27.56 * hour)).toBe('1日3.6時間');
		expect(tagGameResultLifespan(48 * hour)).toBe('2日');
		expect(tagGameResultLifespan(57.501 * hour)).toBe('2日9.5時間');
		expect(tagGameResultLifespan(47.96 * hour)).toBe('2日');
	});
});
