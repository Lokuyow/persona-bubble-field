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

describe('Run ability curves and costs', () => {
	it('starts all abilities at Lv1 and exposes the specified checkpoints', () => {
		const state = createInitialPersonaGameState(PUBKEY, BIRTH);
		expect(state.abilities).toEqual({ inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		expect([1, 5, 10, 20, 30, 50, 75, 100].map(getInferenceRateHundredths)).toEqual([100, 170, 260, 400, 520, 700, 860, 1000]);
		expect([1, 5, 10, 15, 20, 30, 50, 75, 100].map(getContextCapacityMinutes)).toEqual([5, 12, 30, 120, 480, 600, 840, 1140, 1440]);
		expect([1, 5, 10, 20, 30, 50, 75, 100].map(getHallucinationExtensionHundredths)).toEqual([10, 25, 45, 75, 100, 125, 150, 175]);
	});

	it('accepts an explicit initial lifespan without changing the production default', () => {
		const deathDev = createInitialPersonaGameState(PUBKEY, BIRTH, 3_000);
		expect(deathDev.lifespanExpiresAtMs).toBe(BIRTH + 3_000);
		expect(createInitialPersonaGameState(PUBKEY, BIRTH).lifespanExpiresAtMs).toBe(BIRTH + 7 * 24 * 60 * 60 * 1000);
	});

	it('uses linear interpolation and the cost bands at both boundaries', () => {
		expect(getInferenceRateHundredths(2)).toBe(118);
		expect(getContextCapacityMinutes(16)).toBe(192);
		const state = createInitialPersonaGameState(PUBKEY, BIRTH);
		expect(getAbilityUpgrade('inferenceEfficiency', state.abilities).cost).toBe(1);
		expect(getAbilityUpgrade('inferenceEfficiency', { ...state.abilities, inferenceEfficiency: 5 }).cost).toBe(1);
		expect(getAbilityUpgrade('inferenceEfficiency', { ...state.abilities, inferenceEfficiency: 6 }).cost).toBe(2);
		expect(getAbilityUpgrade('inferenceEfficiency', { ...state.abilities, inferenceEfficiency: 10 }).cost).toBe(2);
		expect(getAbilityUpgrade('inferenceEfficiency', { ...state.abilities, inferenceEfficiency: 11 }).cost).toBe(4);
	});

	it('has a total cost of 20,675pt per ability and 62,025pt for all abilities', () => {
		let state = { ...createInitialPersonaGameState(PUBKEY, BIRTH), points: 100_000 };
		let spent = 0;
		for (const key of ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'] as const) {
			for (let level = 1; level < 100; level += 1) {
				const upgrade = getAbilityUpgrade(key, state.abilities);
				spent += upgrade.cost;
				state = upgradeAbility(state, key)!;
			}
		}
		expect(spent).toBe(62_025);
		expect(state.abilities).toEqual({ inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 });
		expect(getAbilityUpgrade('inferenceEfficiency', state.abilities).nextEffect).toBeNull();
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
