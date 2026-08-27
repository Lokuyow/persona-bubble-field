import { describe, expect, it, vi } from 'vitest';

// Deliberately do not install fake-indexeddb or browser globals in this test file.
describe('account module in Node / SSR', () => {
	it('imports without browser APIs and permits the pure cooldown check', async () => {
		expect(typeof window).toBe('undefined');
		expect(typeof indexedDB).toBe('undefined');
		const account = await import('./nostrAccount');
		expect(account.getReincarnationEligibility(0, 86_400_000)).toEqual({
			canReincarnate: true, nextAllowedAtMs: 86_400_000
		});
	});

	it('rejects account I/O without storage instead of creating a memory-only account', async () => {
		const account = await import('./nostrAccount');
		const localStorageAccess = vi.fn(() => { throw new Error('Unexpected fallback.'); });
		vi.stubGlobal('localStorage', { getItem: localStorageAccess, setItem: localStorageAccess });
		try {
			await expect(account.loadOrCreateAccount()).rejects.toThrow('Account storage could not be opened.');
			await expect(account.reincarnateAccount()).rejects.toThrow('Account storage could not be opened.');
			expect(localStorageAccess).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
