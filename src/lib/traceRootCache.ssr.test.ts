import { describe, expect, it, vi } from 'vitest';

describe('trace root cache module in Node / SSR', () => {
	it('imports without browser APIs and rejects storage I/O without a fallback', async () => {
		expect(typeof indexedDB).toBe('undefined');
		const cache = await import('./traceRootCache');
		const localStorageAccess = vi.fn(() => { throw new Error('Unexpected fallback.'); });
		vi.stubGlobal('localStorage', { getItem: localStorageAccess, setItem: localStorageAccess });
		try {
			await expect(cache.reconcileTraceRootCache({
				channelId: 'a'.repeat(64), field: { columns: 1, rows: 1 }, rawEvents: []
			})).rejects.toThrow('Trace root storage is unavailable.');
			expect(localStorageAccess).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
