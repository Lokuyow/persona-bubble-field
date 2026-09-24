import { describe, expect, it } from 'vitest';
import {
	createInitialPersonaGameState,
	getAbilityUpgrade,
	getContextCapacityMinutes,
	getHallucinationExtensionHundredths,
	getInferenceRateHundredths,
	isValidPersonaGameState,
	upgradeAbility
} from './personaGameState';
import { POINT_PROGRESS_SCALE } from './mending';

const PUBKEY = 'a'.repeat(64);
const BIRTH = 1_700_000_000_000;

describe('Run ability growth and costs', () => {
	it('starts all abilities at Lv1 and applies a constant effect per level', () => {
		const state = createInitialPersonaGameState(PUBKEY, BIRTH);
		expect(state.abilities).toEqual({ inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		expect([1, 2, 10, 50, 100].map(getInferenceRateHundredths)).toEqual([100, 110, 190, 590, 1090]);
		expect([1, 2, 10, 50, 100].map(getContextCapacityMinutes)).toEqual([5, 20, 140, 740, 1490]);
		expect([1, 2, 10, 50, 100].map(getHallucinationExtensionHundredths)).toEqual([10, 12, 28, 108, 208]);
	});

	it('accepts an explicit initial lifespan without changing the production default', () => {
		const deathDev = createInitialPersonaGameState(PUBKEY, BIRTH, 3_000);
		expect(deathDev.lifespanExpiresAtMs).toBe(BIRTH + 3_000);
		expect(createInitialPersonaGameState(PUBKEY, BIRTH).lifespanExpiresAtMs).toBe(BIRTH + 7 * 24 * 60 * 60 * 1000);
	});

	it('charges by the level reached at every ten-level boundary', () => {
		const costAt = (level: number) => getAbilityUpgrade('inferenceEfficiency', { inferenceEfficiency: level, contextCapacity: 1, hallucinationSuppression: 1 }).cost;
		expect([1, 9, 10, 19, 20, 29, 30, 89, 90, 99, 100].map(costAt))
			.toEqual([1, 1, 2, 2, 4, 4, 8, 256, 512, 512, 0]);
	});

	it('has a total cost of 10,229pt per ability and 30,687pt for all abilities', () => {
		let state = { ...createInitialPersonaGameState(PUBKEY, BIRTH), points: 100_000 };
		const spentByAbility: number[] = [];
		for (const key of ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'] as const) {
			let spent = 0;
			for (let level = 1; level < 100; level += 1) {
				const upgrade = getAbilityUpgrade(key, state.abilities);
				spent += upgrade.cost;
				state = upgradeAbility(state, key)!;
			}
			spentByAbility.push(spent);
		}
		expect(spentByAbility).toEqual([10_229, 10_229, 10_229]);
		expect(spentByAbility.reduce((sum, cost) => sum + cost, 0)).toBe(30_687);
		expect(state.abilities).toEqual({ inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 });
		expect(getAbilityUpgrade('inferenceEfficiency', state.abilities).nextEffect).toBeNull();
		expect(upgradeAbility(state, 'inferenceEfficiency')).toBeNull();
	});

	it('rejects levels outside Lv1-Lv100 and unsafe carry', () => {
		const initial = createInitialPersonaGameState(PUBKEY, BIRTH);
		expect(upgradeAbility(initial, 'contextCapacity')).toBeNull();
		expect(isValidPersonaGameState({ ...initial, abilities: { ...initial.abilities, inferenceEfficiency: 0 } })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, abilities: { ...initial.abilities, contextCapacity: 101 } })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, pointProgressTicks: POINT_PROGRESS_SCALE })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, version: 3 })).toBe(false);
	});
});
