import { describe, expect, it } from 'vitest';
import { DEV_SCENARIOS, resolveDevScenario } from './devScenarios';

describe('DEV Scenario registry', () => {
	it('contains unique IDs and required metadata', () => {
		const ids = DEV_SCENARIOS.map((scenario) => scenario.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(DEV_SCENARIOS.every((scenario) => scenario.id && scenario.category && scenario.label && scenario.description && scenario.fixture.kind)).toBe(true);
	});

	it('resolves missing and valid scenario IDs', () => {
		expect(resolveDevScenario(new URLSearchParams()).id).toBe('default');
		expect(resolveDevScenario(new URLSearchParams('devScenario=trace-replies')).fixture.kind).toBe('trace');
	});

	it('does not silently fall back for an unknown ID', () => {
		expect(() => resolveDevScenario(new URLSearchParams('devScenario=removed-fixture'))).toThrow('Unknown DEV Scenario');
	});
});
