import { describe, expect, it } from 'vitest';
import { MAX_LIFESPAN_MS, createInitialPersonaGameState, isPersonaExpired } from './personaGameState';
import { createMendingJob, isValidMendingJob, materializeMending, projectMending } from './mending';

const hour = 60 * 60 * 1000;

describe('mending time projection', () => {
	it('snapshots the ability parameters at start', () => {
		const job = createMendingJob({ inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }, 100);
		expect(job).toMatchObject({ maximumDurationMs: 8 * hour, lifespanExtensionPerHour: { numerator: 4, denominator: 5 }, pointsPerHour: { numerator: 1, denominator: 1 } });
	});

	it('uses processedThrough rather than the later collection time for the cap', () => {
		const job = createMendingJob({ inferenceEfficiency: 4, contextCapacity: 0, hallucinationSuppression: 0 }, 1_000);
		const state = { lifespanExpiresAtMs: 1_000 + MAX_LIFESPAN_MS, mendingJob: job };
		const capped = projectMending(state, 1_000 + 8 * hour);
		const later = projectMending(state, 1_000 + 100 * hour);
		expect(later).toMatchObject({ processedDurationMs: capped.processedDurationMs, processedThroughMs: capped.processedThroughMs, effectiveExpiresAtMs: capped.effectiveExpiresAtMs, points: capped.points });
	});

	it('reports the cap-limited effective lifespan extension from the same projection', () => {
		const job = createMendingJob({ inferenceEfficiency: 4, contextCapacity: 0, hallucinationSuppression: 0 }, 1_000);
		const state = { lifespanExpiresAtMs: 1_000 + MAX_LIFESPAN_MS, mendingJob: job };
		const projection = projectMending(state, 1_000 + 8 * hour);

		expect(projection.lifespanExtensionMs).toBe(8 * hour);
		expect(projection.effectiveExpiresAtMs).toBe(state.lifespanExpiresAtMs + projection.lifespanExtensionMs);
	});

	it('allows partial collection and starts a fresh bucket at collection time', () => {
		const state = {
			lifespanExpiresAtMs: 100_000,
			points: 2,
			abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 },
			mendingJob: createMendingJob({ inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }, 1_000)
		};
		const collectedAt = 1_000 + 2.48 * hour;
		const projection = projectMending(state, collectedAt);
		const next = materializeMending(state, collectedAt);
		expect(next).toMatchObject({ points: 2 + projection.points, lifespanExpiresAtMs: projection.effectiveExpiresAtMs, mendingJob: { startedAtMs: collectedAt } });
		expect(next?.mendingJob).not.toBeNull();
	});

	it('stops accumulating after the bucket duration cap', () => {
		const state = {
			lifespanExpiresAtMs: 100_000,
			points: 0,
			abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 },
			mendingJob: createMendingJob({ inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }, 1_000)
		};
		const capped = projectMending(state, 1_000 + 8 * hour);
		const later = projectMending(state, 1_000 + 10 * hour);
		expect(later).toMatchObject({ processedDurationMs: capped.processedDurationMs, points: capped.points, lifespanExtensionMs: capped.lifespanExtensionMs });
	});

	it('floors fractional lifespan milliseconds consistently while leaving points fractional', () => {
		const state = {
			lifespanExpiresAtMs: 10_000,
			points: 4,
			abilities: { inferenceEfficiency: 3, contextCapacity: 0, hallucinationSuppression: 0 },
			mendingJob: { startedAtMs: 1_000, maximumDurationMs: 5, lifespanExtensionPerHour: { numerator: 11, denominator: 10 }, pointsPerHour: { numerator: 1, denominator: 3 } }
		};
		const projection = projectMending(state, 1_005);
		expect(projection.effectiveExpiresAtMs).toBe(10_005);
		expect(projection.points).not.toBe(Math.floor(projection.points));
		const materialized = materializeMending(state, 1_005);
		expect(materialized).toMatchObject({ lifespanExpiresAtMs: projection.effectiveExpiresAtMs, points: 4 + projection.points, mendingJob: { startedAtMs: 1_005 } });

	});

	it('treats the exact active-job effective expiry as expired', () => {
		const state = createInitialPersonaGameState('a'.repeat(64), 0);
		const mendingJob = createMendingJob(state.abilities, 0);
		const active = { ...state, mendingJob };
		const expiry = projectMending(active, mendingJob.maximumDurationMs).effectiveExpiresAtMs;

		expect(isPersonaExpired(active, expiry)).toBe(true);
		expect(isPersonaExpired(active, expiry - 1)).toBe(false);
	});

	it('accepts only job snapshots that can be produced by the ability tables', () => {
		expect(isValidMendingJob(createMendingJob({ inferenceEfficiency: 4, contextCapacity: 3, hallucinationSuppression: 4 }, 100))).toBe(true);
		expect(isValidMendingJob({
			startedAtMs: 100,
			maximumDurationMs: 1,
			lifespanExtensionPerHour: { numerator: 99, denominator: 1 },
			pointsPerHour: { numerator: 99, denominator: 1 }
		})).toBe(false);
	});

	it.each([
		{ startedAtMs: 100, maximumDurationMs: 8 * hour, lifespanExtensionPerHour: { numerator: 1, denominator: 0 }, pointsPerHour: { numerator: 1, denominator: 1 } },
		{ startedAtMs: Number.MAX_SAFE_INTEGER, maximumDurationMs: 8 * hour, lifespanExtensionPerHour: { numerator: 4, denominator: 5 }, pointsPerHour: { numerator: 1, denominator: 1 } },
		{ startedAtMs: 100, maximumDurationMs: Number.MAX_SAFE_INTEGER, lifespanExtensionPerHour: { numerator: 4, denominator: 5 }, pointsPerHour: { numerator: 1, denominator: 1 } }
	])('rejects malformed persisted jobs', (job) => {
		expect(isValidMendingJob(job)).toBe(false);
	});
});
