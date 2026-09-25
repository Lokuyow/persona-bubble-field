import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
	TAG_GAME_ACTION_KIND,
	TAG_GAME_BENEFIT_POINTS_PER_SECOND,
	TAG_GAME_GAME_MS,
	TAG_GAME_INDEX,
	TAG_GAME_KIND,
	buildTagGameActionTemplate,
	buildTagGameActionFilter,
	buildTagGameFilter,
	buildTagGameTemplate,
	createTagGameSchedule,
	finalizeTagGameState,
	isFreshTagGameLobby,
	isValidTagGameState,
	parseTagGameActionEvent,
	parseTagGameEvent,
	tagGameHolderResponseState,
	tagGamePredictedRemainingLifespanMinutes,
	cumulativeTagGameSettlement,
	type TagGameState
} from './tagGame';

const HOST = new Uint8Array(32).fill(31);
const JOINER = new Uint8Array(32).fill(32);
const CHANNEL = 'c'.repeat(64);
const HOST_PUBKEY = getPublicKey(HOST);
const GAME_ID = `${HOST_PUBKEY}:1:${'a'.repeat(64)}`;

function lobby(): TagGameState {
	return {
		gameId: GAME_ID,
		hostPubkey: HOST_PUBKEY,
		phase: 'lobby',
		revision: 0,
		updatedAt: 100,
		participant: [{ pubkey: HOST_PUBKEY, runNumber: 1, registeredAt: 100, status: 'registered', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }],
		settledAtMs: 100_000
	};
}

describe('player-hosted tag-game protocol and rules', () => {
	it('uses one discoverable kind-37070 filter and one action filter in the supplemental REQ', () => {
		expect(buildTagGameFilter(CHANNEL, 10)).toEqual({ kinds: [TAG_GAME_KIND], '#e': [CHANNEL], '#t': [TAG_GAME_INDEX], since: 10 });
		expect(buildTagGameActionFilter(CHANNEL, 10)).toEqual({ kinds: [TAG_GAME_ACTION_KIND], '#e': [CHANNEL], since: 10 });
	});

	it('binds first discovery to the signed author and unique game d-tag', () => {
		const event = finalizeTagGameState(lobby(), CHANNEL, 100, HOST);
		expect(event.tags).toContainEqual(['d', GAME_ID]);
		expect(parseTagGameEvent(event, CHANNEL)?.state.gameId).toBe(GAME_ID);
		expect(parseTagGameEvent({ ...event, pubkey: 'e'.repeat(64) }, CHANNEL)).toBeNull();
		expect(parseTagGameEvent(event, 'f'.repeat(64))).toBeNull();
		expect(parseTagGameEvent({ ...event, tags: [...event.tags, ['d', 'other']] }, CHANNEL)).toBeNull();
	});

	it('renews unbounded lobbies and rejects expired ones using the event timestamp', () => {
		const state = lobby();
		expect(isFreshTagGameLobby(state, 190)).toBe(true);
		expect(isFreshTagGameLobby(state, 191)).toBe(false);
		expect(isFreshTagGameLobby({ ...state, phase: 'ended' }, 100)).toBe(false);
	});

	it('creates seven deterministic reversals over exactly 180 seconds with 90 seconds per effect', () => {
		const first = createTagGameSchedule('public-seed');
		const second = createTagGameSchedule('public-seed');
		expect(first).toEqual(second);
		expect(first).toHaveLength(8);
		expect(first.reduce((sum, part) => sum + part.durationMs, 0)).toBe(TAG_GAME_GAME_MS);
		expect(first.filter((part) => part.effect === 'benefit').reduce((sum, part) => sum + part.durationMs, 0)).toBe(90_000);
		expect(first.filter((part) => part.effect === 'calamity').reduce((sum, part) => sum + part.durationMs, 0)).toBe(90_000);
		expect(first.every((part) => part.durationMs >= 10_000 && part.durationMs <= 40_000)).toBe(true);
		expect(first.every((part, index) => index === 0 || part.effect !== first[index - 1].effect)).toBe(true);
		expect(TAG_GAME_BENEFIT_POINTS_PER_SECOND * 90).toBe(4_500);
	});

	it('validates per-player cumulative caps before settlement', () => {
		const state = lobby();
		expect(cumulativeTagGameSettlement(state)).toEqual({ points: 0, lifespanLossMs: 0 });
		expect(isValidTagGameState({ ...state, participant: [{ ...state.participant[0], points: 4_501 }] })).toBe(false);
		expect(isValidTagGameState({ ...state, participant: [{ ...state.participant[0], lifespanLossMs: 324_000_001 }] })).toBe(false);
		expect(isValidTagGameState({ ...state, participant: [{ ...state.participant[0], benefitMs: 90_001 }] })).toBe(false);
	});

	it('predicts lifespan from the already-effective remainder and only un-applied tag-game loss', () => {
		const effectiveRemainingMs = 90 * 60_000;
		const unAppliedLossMs = 20 * 60_000;
		expect(tagGamePredictedRemainingLifespanMinutes(effectiveRemainingMs, unAppliedLossMs)).toBe(70);
		expect(tagGamePredictedRemainingLifespanMinutes(5 * 60_000, 10 * 60_000)).toBe(0);
	});

	it('uses normal World activity and tag-game acknowledgements, then challenges a holder again after silence', () => {
		expect(tagGameHolderResponseState({ nowMs: 20_000, normalActivityAtMs: 15_000, acknowledgedAtMs: null, challengeStartedAtMs: null })).toBe('active');
		expect(tagGameHolderResponseState({ nowMs: 20_000, normalActivityAtMs: null, acknowledgedAtMs: 15_000, challengeStartedAtMs: null })).toBe('active');
		expect(tagGameHolderResponseState({ nowMs: 25_001, normalActivityAtMs: null, acknowledgedAtMs: 15_000, challengeStartedAtMs: null })).toBe('challenge');
		expect(tagGameHolderResponseState({ nowMs: 27_000, normalActivityAtMs: null, acknowledgedAtMs: 15_000, challengeStartedAtMs: 22_000 })).toBe('unresponsive');
		expect(tagGameHolderResponseState({ nowMs: 26_000, normalActivityAtMs: null, acknowledgedAtMs: 25_500, challengeStartedAtMs: null })).toBe('active');
		expect(tagGameHolderResponseState({ nowMs: 35_501, normalActivityAtMs: null, acknowledgedAtMs: 25_500, challengeStartedAtMs: null })).toBe('challenge');
	});

	it('signs action Run data and rejects malformed action scope', () => {
		const signed = finalizeEvent(buildTagGameActionTemplate({ channelId: CHANNEL, gameId: GAME_ID, action: 'join', runNumber: 4, nonce: 'a'.repeat(32), createdAt: 100 }), JOINER);
		const parsed = parseTagGameActionEvent(signed, CHANNEL);
		expect(parsed).toMatchObject({ action: 'join', runNumber: 4 });
		expect(parseTagGameActionEvent({ ...signed, tags: signed.tags.filter((tag) => tag[0] !== 'r') }, CHANNEL)).toBeNull();
		expect(() => buildTagGameTemplate({ ...lobby(), phase: 'running' }, CHANNEL, 100)).toThrow();
	});
});
