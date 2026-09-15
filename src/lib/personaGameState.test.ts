import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState, getAbilityUpgrade, upgradeAbility } from './personaGameState';

const PUBKEY = 'a'.repeat(64);

describe('persona ability upgrades', () => {
	it.each([
		['inferenceEfficiency', ['0.8h/h', '0.9h/h', '1.0h/h', '1.1h/h', '1.25h/h'], [5, 10, 20, 40]],
		['contextCapacity', ['8h', '12h', '18h', '24h'], [10, 20, 40]],
		['hallucinationSuppression', ['1.0pt/h', '1.1pt/h', '1.2pt/h', '1.35pt/h', '1.5pt/h'], [10, 20, 30, 40]]
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
});
