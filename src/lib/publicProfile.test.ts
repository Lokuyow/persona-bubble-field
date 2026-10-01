import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState } from './personaGameState';
import { createMendingJob, projectMending } from './mending';
import { INFERENCE_ACCELERATION_BUDGET_MS } from './rootProgression';
import { projectPublicLifespan, publicLifespanProjection } from './publicProfile';
import type { PersonaSnapshot } from './rootIdentity';
import type { RootBuild } from './rootProgression';

const PUBKEY = 'a'.repeat(64);
const HOUR = 60 * 60 * 1_000;

function persona(rootBuild: RootBuild, abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number }, usedMs = 0, processedMs = 0): PersonaSnapshot {
	const base = createInitialPersonaGameState(PUBKEY, 1_000);
	const gameState = { ...base, abilities, inferenceAccelerationUsedMs: usedMs,
		mendingJob: { ...createMendingJob(1_000), processedDurationMs: processedMs } };
	return { gameState, activeRun: { rootBuild } } as unknown as PersonaSnapshot;
}

function publicState(source: PersonaSnapshot) {
	return { id: 'd'.repeat(64), pubkey: PUBKEY, createdAt: 1, runNumber: 1, version: 1 as const,
		points: 0, abilities: source.gameState.abilities, rootPoints: 0, lifespan: publicLifespanProjection(source) };
}

describe('public lifespan projection', () => {
	it('matches projectMending across ability levels, overflow rates, caps, and acceleration boundaries', () => {
		for (let level = 1; level <= 100; level++) {
			for (let contextCompression = 0; contextCompression <= 3; contextCompression++) {
				for (let hallucinationResistance = 0; hallucinationResistance <= 3; hallucinationResistance++) {
					for (const usedMs of [0, Math.max(0, INFERENCE_ACCELERATION_BUDGET_MS - 1), INFERENCE_ACCELERATION_BUDGET_MS]) {
						const rootBuild = { inferenceAcceleration: 2, contextCompression, hallucinationResistance };
						const source = persona(rootBuild, { inferenceEfficiency: 1, contextCapacity: level, hallucinationSuppression: level }, usedMs);
						const profile = publicState(source);
						const capacityMs = profile.lifespan.extension!.regularUntilMs - 1_000;
						const boundaryMs = profile.lifespan.extension!.roundingBoundaryAtMs - 1_000;
						for (const elapsed of [0, 1, 9, 10, Math.max(0, boundaryMs - 1), boundaryMs,
							Math.max(0, capacityMs - 1), capacityMs, capacityMs + 1, capacityMs + HOUR]) {
							const viewerAt = 1_000 + elapsed;
							expect(projectPublicLifespan(profile, viewerAt)).toBe(projectMending(source.gameState, viewerAt, rootBuild).effectiveExpiresAtMs);
						}
					}
				}
			}
		}
	});

	it('keeps rounding anchored to the checkpoint when a snapshot is cut mid-segment', () => {
		const rootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };
		const source = persona(rootBuild, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		const profile = publicState(source);
		const checkpoint = projectPublicLifespan(profile, 1_000);
		const checkpointPlusOne = projectPublicLifespan(profile, 1_001);
		expect(checkpointPlusOne).toBe(checkpoint);
		expect(projectPublicLifespan(profile, 1_010)).toBe(projectMending(source.gameState, 1_010, rootBuild).effectiveExpiresAtMs);
		expect(projectPublicLifespan(profile, 1_010)).toBeGreaterThan(checkpointPlusOne);
	});

	it('keeps a non-mending lifespan fixed as wall time passes', () => {
		const rootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };
		const source = { ...persona(rootBuild, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }),
			gameState: createInitialPersonaGameState(PUBKEY, 1_000) } as PersonaSnapshot;
		const projection = publicLifespanProjection(source);
		expect(projection.extension).toBeNull();
		expect(projectPublicLifespan(publicState(source), 10_000 + HOUR)).toBe(source.gameState.lifespanExpiresAtMs);
	});
});
