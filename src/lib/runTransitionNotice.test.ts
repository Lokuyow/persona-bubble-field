import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeRunTransitionNotice, storeRunTransitionNotice } from './runTransitionNotice';

function storage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() { return values.size; },
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => { values.delete(key); },
		setItem: (key, value) => { values.set(key, value); }
	};
}

afterEach(() => vi.unstubAllGlobals());

describe('run transition notice handoff', () => {
	it('stores and consumes each supported outcome once', () => {
		vi.stubGlobal('sessionStorage', storage());
		storeRunTransitionNotice('dead');
		expect(consumeRunTransitionNotice()).toBe('dead');
		expect(consumeRunTransitionNotice()).toBeNull();
		storeRunTransitionNotice('cleared');
		expect(consumeRunTransitionNotice()).toBe('cleared');
	});

	it('fails closed for invalid values and removes them', () => {
		const current = storage();
		current.setItem('persona-bubble-field:run-transition-notice:v1', 'invalid');
		vi.stubGlobal('sessionStorage', current);
		expect(consumeRunTransitionNotice()).toBeNull();
		expect(current.getItem('persona-bubble-field:run-transition-notice:v1')).toBeNull();
	});

	it('does not leak storage failures', () => {
		const failing = {
			getItem: () => { throw new Error('blocked'); },
			removeItem: () => { throw new Error('blocked'); },
			setItem: () => { throw new Error('blocked'); }
		} as unknown as Storage;
		vi.stubGlobal('sessionStorage', failing);
		expect(() => storeRunTransitionNotice('dead')).not.toThrow();
		expect(consumeRunTransitionNotice()).toBeNull();
	});
});
