import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState } from './personaGameState';
import { createMendingJob, projectMending } from './mending';
import { projectPublicLifespan, publicLifespanProjection } from './publicProfile';
import type { PersonaSnapshot } from './rootIdentity';
import type { RootBuild } from './rootProgression';

const PUBKEY = 'a'.repeat(64);
const HOUR = 60 * 60 * 1_000;

function persona(rootBuild: RootBuild, nowMs: number): PersonaSnapshot {
	const gameState = {
		...createInitialPersonaGameState(PUBKEY, 1_000),
		abilities: { inferenceEfficiency: 1, contextCapacity: 2, hallucinationSuppression: 100 },
		mendingJob: createMendingJob(1_000)
	};
	return { gameState, activeRun: { rootBuild } } as unknown as PersonaSnapshot;
}

describe('public lifespan projection', () => {
	it('reproduces the SelfProfile expiry through regular work, overflow, and Root caps', () => {
		for (const contextCompression of [0, 1, 2, 3]) {
			for (const hallucinationResistance of [0, 1, 2, 3]) {
				const rootBuild = { inferenceAcceleration: 2, contextCompression, hallucinationResistance };
				const source = persona(rootBuild, 1_000);
				for (const snapshotAt of [1_000, 1_000 + 4 * 60_000, 1_000 + 6 * 60_000]) {
					const projection = publicLifespanProjection(source, snapshotAt);
					for (const delta of [0, 30_000, 5 * 60_000, HOUR, 8 * HOUR]) {
						const viewerAt = snapshotAt + delta;
						expect(projectPublicLifespan({
							id: 'd'.repeat(64), pubkey: PUBKEY, createdAt: 1, runNumber: 1, version: 1,
							points: 0, abilities: source.gameState.abilities, rootPoints: 0, lifespan: projection
						}, viewerAt)).toBe(projectMending(source.gameState, viewerAt, rootBuild).effectiveExpiresAtMs);
					}
				}
			}
		}
	});

	it('keeps a non-mending lifespan fixed as wall time passes', () => {
		const rootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };
		const source = { ...persona(rootBuild, 1_000), gameState: createInitialPersonaGameState(PUBKEY, 1_000) } as PersonaSnapshot;
		const projection = publicLifespanProjection(source, 10_000);
		expect(projection.active).toBe(false);
		expect(projectPublicLifespan({ id: 'd'.repeat(64), pubkey: PUBKEY, createdAt: 1, runNumber: 1, version: 1,
			points: 0, abilities: source.gameState.abilities, rootPoints: 0, lifespan: projection }, 10_000 + HOUR)).toBe(source.gameState.lifespanExpiresAtMs);
	});
});
