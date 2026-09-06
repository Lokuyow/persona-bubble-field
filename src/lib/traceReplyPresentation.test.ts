import { describe, expect, it } from 'vitest';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import { adjacentTraceSpeech, compareTraceReplies, resolveTraceConversationProjection } from './traceReplyPresentation';

const root: ParsedWorldMessage = {
	id: 'r'.repeat(64), pubkey: 'a'.repeat(64), createdAt: 1, content: 'root', speechType: 'normal', position: { x: 2, y: 2 }
};

function reply(id: string, parent: ParsedWorldMessage | ParsedTraceReply, createdAt: number): ParsedTraceReply {
	return {
		id, pubkey: 'b'.repeat(64), createdAt, content: id, speechType: 'normal', rootId: root.id,
		rootPubkey: root.pubkey, parentId: parent.id, parentKind: 'rootId' in parent ? 1111 : 42, parentPubkey: parent.pubkey
	};
}

describe('Trace reply presentation', () => {
	it('keeps only root, immediate parent, current and sorted direct children', () => {
		const parent = reply('p'.repeat(64), root, 2);
		const current = reply('c'.repeat(64), parent, 3);
		const newer = reply('z'.repeat(64), current, 5);
		const older = reply('a'.repeat(64), current, 4);
		const projection = resolveTraceConversationProjection({
			kind: 'open', root, replies: [older, newer, parent, current], replyRefresh: 'settled',
			config: { rootId: root.id, currentId: current.id }
		});
		expect(projection?.parent?.event.id).toBe(parent.id);
		expect(projection?.directReplies.map((item) => item.id)).toEqual([newer.id, older.id]);
		expect(adjacentTraceSpeech(projection!, root.id)?.kind).toBe('root');
		expect(adjacentTraceSpeech(projection!, older.id)?.event.id).toBe(older.id);
	});

	it('orders children by newest timestamp then event ID', () => {
		const left = reply('a'.repeat(64), root, 4);
		const right = reply('b'.repeat(64), root, 4);
		expect([right, left].sort(compareTraceReplies).map((item) => item.id)).toEqual([left.id, right.id]);
	});
});
