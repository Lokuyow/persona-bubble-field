import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState, getAbilityUpgrade, isValidPersonaGameState, upgradeAbility } from './personaGameState';
import { POINT_PROGRESS_SCALE } from './mending';

const PUBKEY = 'a'.repeat(64);

describe('persona ability upgrades', () => {
	it.each([
		['inferenceEfficiency', ['0.8h/h', '0.9h/h', '1.0h/h', '1.1h/h', '1.25h/h'], [5, 10, 20, 40]],
		['contextCapacity', ['8h', '12h', '18h', '24h'], [10, 20, 40]],
		['hallucinationSuppression', ['60分 / 1pt', '55分 / 1pt', '50分 / 1pt', '45分 / 1pt', '40分 / 1pt'], [10, 20, 30, 40]]
	] as const)('%s uses the specified effects and costs for every transition', (key, effects, costs) => {
		let state = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		for (let level = 0; level < costs.length; level += 1) {
			const upgrade = getAbilityUpgrade(key, state.abilities);
			expect(upgrade.currentEffect).toBe(effects[level]);
			expect(upgrade.nextEffect).toBe(effects[level + 1]);
			expect(upgrade.cost).toBe(costs[level]);
			state = { ...state, points: upgrade.cost };
			state = upgradeAbility(state, key)!;
			expect(state.abilities[key]).toBe(level + 1);
			expect(state.points).toBe(0);
		}
		expect(getAbilityUpgrade(key, state.abilities).currentEffect).toBe(effects.at(-1));
		expect(getAbilityUpgrade(key, state.abilities).nextEffect).toBeNull();
	});

	it('leaves state unchanged when points are insufficient or level is maxed', () => {
		const initial = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		expect(upgradeAbility(initial, 'contextCapacity')).toBeNull();
		const maxed = { ...initial, abilities: { ...initial.abilities, contextCapacity: 3 }, points: 999 };
		expect(upgradeAbility(maxed, 'contextCapacity')).toBeNull();
	});

	it('accepts only integer safe owned points and bounded progress ticks', () => {
		const initial = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		expect(isValidPersonaGameState({ ...initial, points: 1.5 })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, points: Number.MAX_SAFE_INTEGER + 1 })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, pointProgressTicks: -1 })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, pointProgressTicks: POINT_PROGRESS_SCALE })).toBe(false);
		expect(isValidPersonaGameState({ ...initial, pointProgressTicks: POINT_PROGRESS_SCALE - 1 })).toBe(true);
	});

	it('rejects the previous game-state version instead of migrating it', () => {
		const initial = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		expect(isValidPersonaGameState({ ...initial, version: 2 })).toBe(false);
	});
});
