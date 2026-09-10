import { describe, expect, it } from 'vitest';
import { MAX_LIFESPAN_MS } from './personaGameState';
import { createMendingJob, isValidMendingJob, materializeCompletedMending, projectMending } from './mending';

const hour = 60 * 60 * 1000;

describe('mending time projection', () => {
	it('snapshots the ability parameters at start', () => {
		const job = createMendingJob({ inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }, 100);
		expect(job).toMatchObject({ maximumDurationMs: 8 * hour, lifespanExtensionPerHour: { numerator: 4, denominator: 5 }, pointsPerHour: { numerator: 1, denominator: 1 } });
	});

	it('uses processedThrough rather than the later collection time for the cap', () => {
		const job = createMendingJob({ inferenceEfficiency: 4, contextCapacity: 0, hallucinationSuppression: 0 }, 1_000);
		const state = { lifespanExpiresAtMs: 1_000 + MAX_LIFESPAN_MS, mendingJob: job };
		const completed = projectMending(state, 1_000 + 8 * hour);
		const later = projectMending(state, 1_000 + 100 * hour);
		expect(later).toMatchObject({ processedDurationMs: completed.processedDurationMs, processedThroughMs: completed.processedThroughMs, effectiveExpiresAtMs: completed.effectiveExpiresAtMs, points: completed.points });
	});

	it('floors fractional lifespan milliseconds consistently while leaving points fractional', () => {
		const state = {
			lifespanExpiresAtMs: 10_000,
			mendingJob: { startedAtMs: 1_000, maximumDurationMs: 5, lifespanExtensionPerHour: { numerator: 11, denominator: 10 }, pointsPerHour: { numerator: 1, denominator: 3 } }
		};
		const projection = projectMending(state, 1_005);
		expect(projection.effectiveExpiresAtMs).toBe(10_005);
		expect(projection.points).not.toBe(Math.floor(projection.points));
		expect(materializeCompletedMending(state).lifespanExpiresAtMs).toBe(projection.effectiveExpiresAtMs);

	});

	it('treats the exact effective expiry as expired', () => {
		const state = { lifespanExpiresAtMs: 1_000, mendingJob: null };
		expect(projectMending(state, 1_000).effectiveExpiresAtMs).toBe(1_000);
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
});
