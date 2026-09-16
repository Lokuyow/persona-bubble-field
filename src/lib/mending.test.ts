import { describe, expect, it } from 'vitest';
import { MAX_LIFESPAN_MS } from './personaGameState';
import {
	POINT_PROGRESS_SCALE,
	createMendingJob,
	isValidMendingJob,
	materializeMending,
	projectMending
} from './mending';

const minute = 60 * 1000;
const hour = 60 * minute;
const abilities = { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 } as const;

function state(startedAtMs = 1_000, pointProgressTicks = 0) {
	return {
		lifespanExpiresAtMs: startedAtMs + MAX_LIFESPAN_MS,
		points: 0,
		pointProgressTicks,
		abilities,
		mendingJob: createMendingJob(abilities, startedAtMs)
	};
}

describe('mending integer point projection', () => {
	it('snapshots the point interval for each hallucination level', () => {
		expect([0, 1, 2, 3, 4].map((hallucinationSuppression) => createMendingJob({ ...abilities, hallucinationSuppression }, 100).pointIntervalMs))
			.toEqual([60, 55, 50, 45, 40].map((minutes) => minutes * minute));
		expect([0, 1, 2, 3, 4].map((hallucinationSuppression) => projectMending({ ...state(), mendingJob: createMendingJob({ ...abilities, hallucinationSuppression }, 1_000) }, 1_001).pointProgressTicks))
			.toEqual([330, 360, 396, 440, 495]);
	});

	it('keeps the point immediately before a 60-minute boundary unclaimed', () => {
		const projection = projectMending(state(), 1_000 + hour - 1);
		expect(projection.points).toBe(0);
		expect(projection.pointProgressTicks).toBe(POINT_PROGRESS_SCALE - 330);
	});

	it('credits exactly one point at the 60-minute boundary and remains integer after it', () => {
		const exact = projectMending(state(), 1_000 + hour);
		const after = projectMending(state(), 1_000 + hour + 1);
		expect(exact).toMatchObject({ points: 1, pointProgressTicks: 0 });
		expect(after).toMatchObject({ points: 1, pointProgressTicks: 330 });
	});

	it('carries a 40-minute partial collection into a later 20-minute collection', () => {
		const firstState = state();
		const first = materializeMending(firstState, 1_000 + 40 * minute);
		expect(first).toMatchObject({ points: 0, pointProgressTicks: 792_000_000 });
		const second = materializeMending({ ...firstState, ...first!, mendingJob: first!.mendingJob }, 1_000 + 40 * minute + 20 * minute);
		expect(second).toMatchObject({ points: 1, pointProgressTicks: 0 });
	});

	it('matches continuous processing when small partial collections are repeated', () => {
		let current = state();
		const firstAt = 1_000 + 20 * minute;
		const first = materializeMending(current, firstAt)!;
		current = { ...current, ...first };
		const second = materializeMending(current, firstAt + 20 * minute)!;
		current = { ...current, ...second };
		const third = materializeMending(current, firstAt + 40 * minute)!;
		const continuous = projectMending(state(), 1_000 + 60 * minute);
		expect(third.points).toBe(continuous.points);
		expect(third.pointProgressTicks).toBe(continuous.pointProgressTicks);
	});

	it('materializes lifespan and progress even when a partial collection awards zero points', () => {
		const before = state();
		const result = materializeMending(before, 1_000 + 40 * minute);
		expect(result).toMatchObject({ points: 0, pointProgressTicks: 792_000_000 });
		expect(result!.lifespanExpiresAtMs).toBeGreaterThan(before.lifespanExpiresAtMs);
		expect(result!.mendingJob.startedAtMs).toBe(1_000 + 40 * minute);
	});

	it('blocks an immediate re-collection with zero processed duration', () => {
		expect(materializeMending(state(), 1_000)).toBeNull();
	});

	it('does not add point credit after the bucket cap', () => {
		const before = state();
		const capped = projectMending(before, 1_000 + 8 * hour);
		const later = projectMending(before, 1_000 + 10 * hour);
		expect(later).toMatchObject({ processedDurationMs: capped.processedDurationMs, points: capped.points, pointProgressTicks: capped.pointProgressTicks });
	});

	it('keeps the active bucket snapshot while the next bucket uses upgraded abilities', () => {
		const before = state();
		const upgraded = { ...before, abilities: { ...abilities, hallucinationSuppression: 1 } };
		const active = projectMending(before, 1_000 + 55 * minute);
		const next = createMendingJob(upgraded.abilities, 1_000 + 55 * minute);
		expect(before.mendingJob.pointIntervalMs).toBe(60 * minute);
		expect(active.points).toBe(0);
		expect(next.pointIntervalMs).toBe(55 * minute);
	});

	it('does not revalue carried progress when the interval changes', () => {
		const carried = state(1_000, 792_000_000);
		const nextJob = createMendingJob({ ...abilities, hallucinationSuppression: 1 }, 1_000);
		const projection = projectMending({ ...carried, mendingJob: nextJob }, 1_000 + 20 * minute);
		expect(projection).toMatchObject({ points: 1, pointProgressTicks: 36_000_000 });
	});

	it('uses processedThrough for the lifespan cap', () => {
		const before = { ...state(), lifespanExpiresAtMs: 1_000 + MAX_LIFESPAN_MS };
		const capped = projectMending(before, 1_000 + 8 * hour);
		const later = projectMending(before, 1_000 + 100 * hour);
		expect(later).toMatchObject({ processedThroughMs: capped.processedThroughMs, effectiveExpiresAtMs: capped.effectiveExpiresAtMs, points: capped.points });
	});

	it('accepts only current interval snapshots and rejects the old fractional field', () => {
		expect(isValidMendingJob(createMendingJob({ inferenceEfficiency: 4, contextCapacity: 3, hallucinationSuppression: 4 }, 100))).toBe(true);
		expect(isValidMendingJob({
		startedAtMs: 100,
		maximumDurationMs: 8 * hour,
		lifespanExtensionPerHour: { numerator: 4, denominator: 5 },
		pointsPerHour: { numerator: 1, denominator: 1 }
	})).toBe(false);
	});

	it('rejects malformed persisted jobs', () => {
		expect(isValidMendingJob({
			startedAtMs: 100,
			maximumDurationMs: 8 * hour,
			lifespanExtensionPerHour: { numerator: 4, denominator: 5 },
			pointIntervalMs: 0
		})).toBe(false);
	});
});
