import { describe, expect, it, vi } from 'vitest';

describe('trace reply cache module in Node / SSR', () => {
	it('imports without browser APIs and rejects storage I/O without a fallback', async () => {
		expect(typeof indexedDB).toBe('undefined');
		const cache = await import('./traceReplyCache');
		const localStorageAccess = vi.fn(() => { throw new Error('Unexpected fallback.'); });
		vi.stubGlobal('localStorage', { getItem: localStorageAccess, setItem: localStorageAccess });
		try {
			await expect(cache.reconcileTraceReplyCache({
				channelId: 'a'.repeat(64), effectiveRoots: [], rawEvents: []
			})).rejects.toThrow('Trace reply storage is unavailable.');
			expect(localStorageAccess).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
