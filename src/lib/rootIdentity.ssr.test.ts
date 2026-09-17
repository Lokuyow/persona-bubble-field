import { afterEach, describe, expect, it, vi } from 'vitest';

describe('rootIdentity SSR contract', () => {
	afterEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
	});

	it('imports without browser storage globals and fails only on persistence', async () => {
		vi.stubGlobal('window', undefined);
		vi.stubGlobal('indexedDB', undefined);
		vi.resetModules();

		const rootIdentity = await import('./rootIdentity');
		expect(rootIdentity.DATABASE_VERSION).toBe(6);
		expect(typeof globalThis.window).toBe('undefined');
		expect(typeof globalThis.indexedDB).toBe('undefined');
		await expect(rootIdentity.loadOrCreateLifecycle()).rejects.toThrow('Lifecycle storage could not be opened.');
	});
});
