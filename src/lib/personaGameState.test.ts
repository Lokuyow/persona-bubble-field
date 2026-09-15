import { describe, expect, it } from 'vitest';
import { createInitialPersonaGameState, getAbilityUpgrade, upgradeAbility } from './personaGameState';

const PUBKEY = 'a'.repeat(64);

describe('persona ability upgrades', () => {
	it('uses the specified effects and costs for every transition', () => {
		let state = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		const expected = [5, 10, 20, 40];
		for (const cost of expected) {
			const upgrade = getAbilityUpgrade('inferenceEfficiency', state.abilities);
			expect(upgrade.cost).toBe(cost);
			state = { ...state, points: state.points + cost };
			const next = upgradeAbility(state, 'inferenceEfficiency');
			expect(next).not.toBeNull();
			state = next!;
			expect(state.abilities.inferenceEfficiency).toBe(upgrade.level + 1);
			state = { ...state, points: 0 };
		}
		expect(getAbilityUpgrade('inferenceEfficiency', state.abilities).nextEffect).toBeNull();
	});

	it('leaves state unchanged when points are insufficient or level is maxed', () => {
		const initial = createInitialPersonaGameState(PUBKEY, 1_700_000_000_000);
		expect(upgradeAbility(initial, 'contextCapacity')).toBeNull();
		const maxed = { ...initial, abilities: { ...initial.abilities, contextCapacity: 3 }, points: 999 };
		expect(upgradeAbility(maxed, 'contextCapacity')).toBeNull();
	});
});
