import { describe, expect, it } from 'vitest';
import { getPrototypeDisplayDuration } from './conversation';
import type { ParsedWorldMessage } from './nostrProtocol';
import { replayBootstrapConversation } from './bootstrapConversation';

function message(id: string, pubkey: string, createdAt: number): ParsedWorldMessage {
	return {
		id,
		pubkey,
		createdAt,
		content: 'hello',
		speechType: 'normal',
		position: { x: 1, y: 1 }
	};
}

describe('bootstrap conversation replay', () => {
	it('reconstructs a merged bubble before pruning its final entry-time expiry', () => {
		const duration = getPrototypeDisplayDuration('hello');
		const entryNowMs = 108_000;
		const state = replayBootstrapConversation(
			[message('bob-message', 'bob', 104), message('alice-message', 'alice', 100)],
			new Set(['alice', 'bob']),
			entryNowMs
		);

		expect(duration).toBe(7_200);
		expect(100_000 + duration).toBeGreaterThan(104_000);
		expect(100_000 + duration).toBeLessThanOrEqual(entryNowMs);
		expect(104_000 + duration).toBeGreaterThan(entryNowMs);
		expect(state.normalBubbles).toEqual([]);
		expect(state.mergedBubbles).toEqual([expect.objectContaining({
			content: 'hello',
			memberPubkeys: ['alice', 'bob'],
			expiresAt: 104_000 + duration
		})]);
	});

	it('removes a bootstrap bubble only when its final merged expiry has passed at entry', () => {
		const duration = getPrototypeDisplayDuration('hello');
		const state = replayBootstrapConversation(
			[message('alice-message', 'alice', 100), message('bob-message', 'bob', 104)],
			new Set(['alice', 'bob']),
			104_000 + duration
		);

		expect(state.normalBubbles).toEqual([]);
		expect(state.mergedBubbles).toEqual([]);
	});
});
