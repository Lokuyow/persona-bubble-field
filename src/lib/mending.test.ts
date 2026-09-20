import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState } from './personaGameState';
import { createMendingJob, isValidMendingJob, materializeMending, projectMending, settleMending } from './mending';
import { INFERENCE_ACCELERATION_BUDGET_MS, rootMaximumLifespanMs, type RootBuild } from './rootProgression';

const minute = 60 * 1000;
const hour = 60 * minute;
const PUBKEY = 'a'.repeat(64);
const ZERO_BUILD: RootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };

function state(startedAtMs = 1_000) {
	const initial = createInitialPersonaGameState(PUBKEY, startedAtMs);
	return { ...initial, mendingJob: createMendingJob(startedAtMs) };
}

describe('checkpoint-settled asynchronous work', () => {
	it('starts at 1pt/min, 5min Context, and +0.10h/h', () => {
		const projection = projectMending(state(), 1_000 + hour, ZERO_BUILD);
		expect(projection.points).toBe(5);
		expect(projection.contextCapacityMs).toBe(5 * minute);
		expect(projection.lifespanExtensionMs).toBe(30_000);
	});

	it('applies an upgraded inference effect only after its checkpoint', () => {
		const before = { ...state(), abilities: { ...state().abilities, contextCapacity: 20 } };
		const checkpointed = settleMending(before, 1_000 + hour, ZERO_BUILD, false)!;
		const afterUpgrade = { ...before, ...checkpointed, abilities: { ...before.abilities, inferenceEfficiency: 2 } };
		const projection = projectMending(afterUpgrade, 1_000 + 2 * hour, ZERO_BUILD);
		expect(checkpointed.mendingJob.processedDurationMs).toBe(hour);
		expect(projection.points).toBeGreaterThan(1);
		expect(projectMending(before, 1_000 + 2 * hour, ZERO_BUILD).points).not.toBe(projection.points);
	});

	it('applies an upgraded hallucination effect only after its checkpoint', () => {
		const before = { ...state(), abilities: { ...state().abilities, contextCapacity: 20 } };
		const checkpointed = settleMending(before, 1_000 + hour, ZERO_BUILD, false)!;
		const afterUpgrade = { ...before, ...checkpointed, abilities: { ...before.abilities, hallucinationSuppression: 2 } };
		const projection = projectMending(afterUpgrade, 1_000 + 2 * hour, ZERO_BUILD);
		expect(projection.lifespanExtensionMs).toBeGreaterThan(0);
		expect(projection.lifespanExtensionMs).toBeGreaterThan(projectMending({ ...before, ...checkpointed }, 1_000 + 2 * hour, ZERO_BUILD).lifespanExtensionMs);
	});

	it('caps a checkpointed next segment at its actual wall-clock end', () => {
		const before = { ...state(), abilities: { ...state().abilities, contextCapacity: 20, hallucinationSuppression: 100 } };
		const checkpoint = settleMending(before, 1_000 + minute, ZERO_BUILD, false)!;
		const checkpointed = { ...before, ...checkpoint };
		const now = 1_000 + 2 * minute;
		const projection = projectMending(checkpointed, now, ZERO_BUILD);
		expect(checkpointed.mendingJob.processedDurationMs).toBe(minute);
		expect(projection.effectiveExpiresAtMs).toBeLessThanOrEqual(now + rootMaximumLifespanMs(0));
	});

	it('keeps the maximum lifespan cap correct across multiple ability checkpoints', () => {
		const before = { ...state(), abilities: { ...state().abilities, contextCapacity: 20, hallucinationSuppression: 100 } };
		const first = settleMending(before, 1_000 + minute, ZERO_BUILD, false)!;
		const afterFirst = { ...before, ...first, abilities: { ...before.abilities, hallucinationSuppression: 2 } };
		const second = settleMending(afterFirst, 1_000 + 2 * minute, ZERO_BUILD, false)!;
		const afterSecond = { ...afterFirst, ...second, abilities: { ...afterFirst.abilities, hallucinationSuppression: 3 } };
		const now = 1_000 + 3 * minute;
		const projection = projectMending(afterSecond, now, ZERO_BUILD);
		expect(afterSecond.mendingJob.processedDurationMs).toBe(2 * minute);
		expect(projection.effectiveExpiresAtMs).toBeLessThanOrEqual(now + rootMaximumLifespanMs(0));
	});

	it('keeps the actual-end cap invariant for every Root hallucination resistance rank', () => {
		for (const rank of [0, 1, 2, 3]) {
			const rootBuild = { ...ZERO_BUILD, hallucinationResistance: rank };
			const before = { ...state(), abilities: { ...state().abilities, contextCapacity: 20, hallucinationSuppression: 100 } };
			const checkpoint = settleMending(before, 1_000 + minute, rootBuild, false)!;
			const checkpointed = { ...before, ...checkpoint };
			const now = 1_000 + 2 * minute;
			const projection = projectMending(checkpointed, now, rootBuild);
			expect(projection.effectiveExpiresAtMs).toBeLessThanOrEqual(now + rootMaximumLifespanMs(rank));
		}
	});

	it('does not backfill time lost at the old Context cap', () => {
		const before = state();
		const checkpointed = settleMending(before, 1_000 + hour, ZERO_BUILD, false)!;
		const upgraded = { ...before, ...checkpointed, abilities: { ...before.abilities, contextCapacity: 20 } };
		const projection = projectMending(upgraded, 1_000 + hour + 1 * hour, ZERO_BUILD);
		expect(checkpointed.mendingJob.processedDurationMs).toBe(5 * minute);
		expect(projection.regularDurationMs).toBe(60 * minute);
	});

	it('splits the acceleration budget when it ends mid-segment', () => {
		const work = { ...state(), abilities: { ...state().abilities, contextCapacity: 100 }, inferenceAccelerationUsedMs: 23 * hour };
		const projection = projectMending(work, 1_000 + 2 * hour, { ...ZERO_BUILD, inferenceAcceleration: 3 });
		expect(projection.regularDurationMs).toBe(2 * hour);
		expect(projection.accelerationRemainingMs).toBe(0);
		expect(projection.points).toBe(180);
	});

	it('does not spend acceleration budget in overflow and keeps overflow points at zero', () => {
		const work = { ...state(), abilities: { ...state().abilities, contextCapacity: 1 } };
		const projection = projectMending(work, 1_000 + hour, { ...ZERO_BUILD, contextCompression: 3 });
		expect(projection.regularDurationMs).toBe(15 * minute);
		expect(projection.overflowDurationMs).toBe(45 * minute);
		expect(projection.points).toBe(15);
		expect(projection.accelerationRemainingMs).toBe(INFERENCE_ACCELERATION_BUDGET_MS - 15 * minute);
		expect(projection.lifespanExtensionMs).toBeGreaterThan(30_000);
	});

	it('keeps overflow lifespan extension active after the Context cap for Root compression ranks 1 through 3', () => {
		const work = { ...state(), abilities: { ...state().abilities, contextCapacity: 1 } };
		for (const rank of [1, 3]) {
			const projection = projectMending(work, 1_000 + hour, { ...ZERO_BUILD, contextCompression: rank });
			expect(projection.completed).toBe(true);
			expect(projection.lifespanExtensionRateHundredthsPerHour).toBeGreaterThan(0);
		}
		const stopped = projectMending(work, 1_000 + hour, ZERO_BUILD);
		expect(stopped.completed).toBe(true);
		expect(stopped.lifespanExtensionRateHundredthsPerHour).toBe(0);
	});

	it('keeps fractional carry and transfers integer unclaimed points only on collection', () => {
		const before = state();
		const checkpoint = settleMending(before, 1_000 + 30 * 1000, ZERO_BUILD, false)!;
		expect(checkpoint.points).toBe(0);
		expect(checkpoint.pointProgressTicks).toBeGreaterThan(0);
		expect(checkpoint.mendingJob.unclaimedPoints).toBe(0);
		const collected = materializeMending({ ...before, ...checkpoint }, 1_000 + 60 * 1000, ZERO_BUILD)!;
		expect(collected.points).toBe(1);
		expect(collected.pointProgressTicks).toBe(0);
		expect(collected.mendingJob.processedDurationMs).toBe(0);
		expect(collected.mendingJob.unclaimedPoints).toBe(0);
	});

	it('rejects immediate recollection and prevents free lifespan from a sliding cap', () => {
		const active = state();
		expect(materializeMending(active, 1_000, ZERO_BUILD)).toBeNull();
		const projection = projectMending(active, active.lifespanExpiresAtMs + hour, { ...ZERO_BUILD, contextCompression: 3 });
		expect(projection.lifespanExtensionMs).toBeGreaterThan(0);
		const noOverflow = { ...active, abilities: { ...active.abilities, contextCapacity: 1 } };
		const capped = projectMending(noOverflow, noOverflow.lifespanExpiresAtMs + hour, ZERO_BUILD);
		expect(capped.lifespanExtensionMs).toBe(30_000);
	});

	it('validates the new checkpoint job shape', () => {
		expect(isValidMendingJob(createMendingJob(1_000))).toBe(true);
		expect(isValidMendingJob({ startedAtMs: 1, checkpointAtMs: 0, processedDurationMs: 0, unclaimedPoints: 0 })).toBe(false);
	});
});
