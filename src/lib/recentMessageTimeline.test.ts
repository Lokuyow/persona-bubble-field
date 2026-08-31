import { describe, expect, it } from 'vitest';
import type { ParsedWorldMessage } from './nostrProtocol';
import { addRecentMessage, createRecentMessageTimeline } from './recentMessageTimeline';

function message(id: string, createdAt: number, content = id): ParsedWorldMessage {
	return {
		id,
		pubkey: 'a'.repeat(64),
		createdAt,
		content,
		speechType: 'normal',
		position: { x: 1, y: 1 }
	};
}

describe('recent message timeline', () => {
	it('dedupes by event ID, keeps same-content events, and sorts newest first', () => {
		const first = message('b', 10, 'same content');
		const second = message('a', 10, 'same content');
		const timeline = createRecentMessageTimeline([message('old', 9), first, second, { ...first, content: 'duplicate' }]);

		expect(timeline).toEqual([second, first, message('old', 9)]);
	});

	it('keeps at most the product limit and inserts live messages into the same order', () => {
		const bootstrap = Array.from({ length: 51 }, (_, index) => message(`message-${index}`, index));
		const timeline = createRecentMessageTimeline(bootstrap);
		const next = addRecentMessage(timeline, message('newest', 100, 'full body\nwith lines'));

		expect(timeline).toHaveLength(50);
		expect(timeline[0]).toEqual(message('message-50', 50));
		expect(next).toHaveLength(50);
		expect(next[0]).toEqual(message('newest', 100, 'full body\nwith lines'));
		expect(next.some((entry) => entry.id === 'message-0')).toBe(false);
		expect(addRecentMessage(next, message('newest', 100, 'changed duplicate'))).toBe(next);
	});
});
