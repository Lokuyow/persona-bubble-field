import { describe, expect, it } from 'vitest';
import { createTagGameSchedule, type TagGameState } from './tagGame';
import { canLeaveTagGame, formatTagGameRemainingTime, isOrganizerConfirmedTagGameEffectCurrent, projectTagGameHud, tagGameTransferStatus } from './tagGameHud';
import { createInitialPersonaGameState } from './personaGameState';
import { createMendingJob, projectMending } from './mending';
import type { RootBuild } from './rootProgression';

const SELF = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const GAME_ID = `${SELF}:100:${'c'.repeat(64)}`;
const ZERO_BUILD: RootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };
const benefitSeed = Array.from({ length: 1_000 }, (_, index) => `benefit-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'benefit')!;
const calamitySeed = Array.from({ length: 1_000 }, (_, index) => `calamity-${index}`).find((candidate) => createTagGameSchedule(candidate)[0].effect === 'calamity')!;

function running(effect: 'benefit' | 'calamity' = 'benefit'): TagGameState {
	const player = { pubkey: SELF, runNumber: 4, registeredAt: 99, status: 'active' as const, points: 100, lifespanLossMs: 7_200_000, benefitMs: 2_000, calamityMs: 2_000 };
	const seed = effect === 'benefit' ? benefitSeed : calamitySeed;
	return {
		gameId: GAME_ID, hostPubkey: OTHER, phase: 'running', revision: 1, updatedAt: 100, startedAt: 100, endsAt: 280,
		seed, ownerPubkey: SELF, effect, transferAt: 100_000, participant: [player], settledAtMs: 100_000
	};
}

const baseInput = (game: TagGameState) => ({
	game, selfPubkey: SELF, selfRunNumber: 4, localLockGameId: GAME_ID, localAppliedPoints: 40,
	localAppliedLossMs: 1_000_000, savedPoints: 1_000, effectiveExpiresAtMs: 900_000_000, nowMs: 101_000
});

describe('tag-game HUD projection', () => {
	it('adds organizer-confirmed but unapplied cumulative values and only the currently confirmed effect prediction', () => {
		const game = running('benefit');
		const projected = projectTagGameHud(baseInput(game));
		expect(projected.confirmedPointsNotSaved).toBe(60);
		expect(projected.predictedPoints).toBe(50);
		expect(projected.points).toBe(1_110);
		expect(projected.benefitRateActive).toBe(true);
		expect(projected.calamityRateActive).toBe(false);
	});

	it('does not re-add the cumulative value after the lifecycle lock and saved balance advance', () => {
		const game = { ...running('benefit'), participant: [{ ...running('benefit').participant[0], points: 150, benefitMs: 3_000 }] };
		const projected = projectTagGameHud({ ...baseInput(game), localAppliedPoints: 150, savedPoints: 1_110, nowMs: 101_000 });
		expect(projected.confirmedPointsNotSaved).toBe(0);
		expect(projected.points).toBe(1_110 + 50);
	});

	it('keeps work-adjusted expiry and subtracts confirmed-unapplied and current calamity prediction once', () => {
		const projected = projectTagGameHud(baseInput(running('calamity')));
		expect(projected.confirmedLossNotSavedMs).toBe(6_200_000);
		expect(projected.predictedLossMs).toBe(3_600_000);
		expect(projected.expiresAtMs).toBe(890_200_000);
		expect(projected.calamityRateActive).toBe(true);
	});

	it('does not apply another game receipt, project another player, or advance through a stale scheduled effect', () => {
		const game = running('benefit');
		const mismatchedLock = projectTagGameHud({ ...baseInput(game), localLockGameId: `${OTHER}:100:${'d'.repeat(64)}` });
		expect(mismatchedLock.confirmedPointsNotSaved).toBe(100);
		const spectator = projectTagGameHud({ ...baseInput(game), selfPubkey: OTHER });
		expect(spectator.points).toBe(1_000);
		expect(spectator.predictedPoints).toBe(0);
		const schedule = createTagGameSchedule(game.seed!);
		const boundaryMs = 100_000 + schedule[0].durationMs;
		const staleGame = { ...game, settledAtMs: boundaryMs - 1_000 };
		const staleEffect = projectTagGameHud({ ...baseInput(game), nowMs: boundaryMs + 1_000, game: staleGame });
		expect(staleEffect.predictedPoints).toBe(50);
		expect(staleEffect.benefitRateActive).toBe(false);
		expect(isOrganizerConfirmedTagGameEffectCurrent(staleGame, boundaryMs + 1_000)).toBe(false);
		expect(isOrganizerConfirmedTagGameEffectCurrent({ ...staleGame, settledAtMs: boundaryMs }, boundaryMs + 1_000)).toBe(false);
	});

	it('stops rate and unconfirmed accumulation during holder challenges and after game time reaches its limit', () => {
		const game = running('benefit');
		const challenge = projectTagGameHud({ ...baseInput(game), game: { ...game, holderChallengeId: 'd'.repeat(32) } });
		expect(challenge.predictedPoints).toBe(0);
		expect(challenge.benefitRateActive).toBe(false);
		const ended = projectTagGameHud({ ...baseInput(game), nowMs: 280_000 });
		expect(ended.predictedPoints).toBe(0);
		expect(ended.benefitRateActive).toBe(false);
	});

	it('formats a stable minute-second countdown and clamps at zero', () => {
		expect(formatTagGameRemainingTime(180_000, 13_000)).toBe('02:47');
		expect(formatTagGameRemainingTime(180_000, 180_000)).toBe('00:00');
		expect(formatTagGameRemainingTime(180_000, 181_001)).toBe('00:00');
	});

	it('shows cooldown only during active effects, then distinguishes available restrictions from stopped effects', () => {
		const game = running('benefit');
		expect(tagGameTransferStatus(game, true, 101_000)).toBe('転移禁止 2秒');
		expect(tagGameTransferStatus(game, false, 101_000)).toBe('効果停止中');
		expect(tagGameTransferStatus(game, true, 103_000)).toBe('転移禁止なし');
		expect(tagGameTransferStatus(game, false, 103_000)).toBe('効果停止中');
	});

	it('does not show transfer availability during organizer waits or final settlement and ends leaving at 180 seconds', () => {
		const game = running('benefit');
		const effectBoundary = 100_000 + createTagGameSchedule(game.seed!)[0].durationMs;
		const organizerWait = { ...game, settledAtMs: effectBoundary - 1_000 };
		expect(tagGameTransferStatus(organizerWait, false, effectBoundary + 1_000)).toBe('効果停止中');
		expect(tagGameTransferStatus(game, false, game.endsAt! * 1_000)).toBe('最終精算中');
		expect(tagGameTransferStatus({ ...game, transferAt: game.endsAt! * 1_000 - 1_000 }, true, game.endsAt! * 1_000)).toBe('最終精算中');
		expect(tagGameTransferStatus({ ...game, phase: 'settling' }, false, 200_000)).toBe('最終精算中');
		expect(canLeaveTagGame(game, 'active', game.endsAt! * 1_000 - 1)).toBe(true);
		expect(canLeaveTagGame(game, 'active', game.endsAt! * 1_000)).toBe(false);
		expect(canLeaveTagGame({ ...game, phase: 'settling' }, 'active', 200_000)).toBe(false);
		// A stopped effect does not by itself prevent a member from leaving before game time ends.
		expect(canLeaveTagGame(organizerWait, 'active', effectBoundary + 1_000)).toBe(true);
	});

	it('subtracts tag-game loss from the existing work-adjusted effective expiry', () => {
		const workStartedAtMs = 100_000;
		const state = { ...createInitialPersonaGameState(SELF, workStartedAtMs), mendingJob: createMendingJob(workStartedAtMs) };
		const nowMs = workStartedAtMs + 60_000;
		const work = projectMending(state, nowMs, ZERO_BUILD);
		const game = running('calamity');
		const noWork = projectTagGameHud({ ...baseInput(game), effectiveExpiresAtMs: state.lifespanExpiresAtMs, nowMs });
		const projection = projectTagGameHud({ ...baseInput(game), effectiveExpiresAtMs: work.effectiveExpiresAtMs, nowMs });
		expect(work.effectiveExpiresAtMs).toBeGreaterThan(state.lifespanExpiresAtMs);
		expect(projection.expiresAtMs).toBe(work.effectiveExpiresAtMs - state.lifespanExpiresAtMs + noWork.expiresAtMs);
	});
});
