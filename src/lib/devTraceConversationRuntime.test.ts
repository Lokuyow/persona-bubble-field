import { describe, expect, it, vi } from 'vitest';
import { createPresenceState, debugTimeoutParticipant, getParticipant, type PresenceState } from './presence';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import { createDevTraceConversationRuntime } from './devTraceConversationRuntime';

function root(id: string, createdAt: number, x = 1, y = 1): ParsedWorldMessage {
	return { id, pubkey: id.padEnd(64, '0'), createdAt, content: id, speechType: 'normal', position: { x, y } };
}

function reply(id: string, rootId: string, createdAt = 3): ParsedTraceReply {
	return {
		id,
		pubkey: id.padEnd(64, 'a'),
		createdAt,
		content: id,
		speechType: 'normal',
		position: { x: 2, y: 1 },
		rootId,
		rootPubkey: rootId.padEnd(64, '0'),
		parentId: rootId,
		parentKind: 42,
		parentPubkey: rootId.padEnd(64, '0')
	};
}

function fixture(initialPresence?: PresenceState) {
	let presence = initialPresence ?? createPresenceState({ columns: 4, rows: 3 }, 1_000, [
		{ id: 'self', position: { x: 1, y: 1 } }
	]);
	let roots: readonly ParsedWorldMessage[] = [root('old', 1), root('new', 2)];
	let replies: readonly ParsedTraceReply[] = [];
	const states: unknown[] = [];
	const setPresence = vi.fn((next: PresenceState) => { presence = next; });
	const runtime = createDevTraceConversationRuntime({
		selfId: 'self',
		getPresence: () => presence,
		setPresence,
		getEffectiveRoots: () => roots,
		getReplies: () => replies,
		onStateChanged: (state) => states.push(state),
		now: () => 2_000,
		random: () => 0
	});
	return {
		runtime,
		get presence() { return presence; },
		get roots() { return roots; },
		set roots(next) { roots = next; },
		get replies() { return replies; },
		set replies(next) { replies = next; },
		states,
		setPresence
	};
}

describe('DEV trace conversation runtime', () => {
	it('opens only effective roots with an empty settled reply snapshot', () => {
		const f = fixture();
		expect(f.runtime.openTraceConversation({ rootId: 'missing', currentId: 'missing' })).toEqual({ kind: 'blocked' });
		expect(f.runtime.openTraceConversation({ rootId: 'new', currentId: 'new' })).toEqual({ kind: 'opened' });
		expect(f.runtime.getTraceConversationState()).toMatchObject({
			kind: 'open', root: { id: 'new' }, replies: [], replyRefresh: 'settled'
		});
		expect(getParticipant(f.presence, 'self')).toMatchObject({ position: { x: 1, y: 1 }, lastActivityAt: 2_000 });
	});

	it('injects typed reply snapshots for the open root without network or cache ownership', () => {
		const f = fixture();
		const current = reply('current-reply', 'new');
		const other = reply('other-reply', 'old');
		f.replies = [current, other];
		f.runtime.openTraceConversation({ rootId: 'new', currentId: 'new' });
		expect(f.runtime.getTraceConversationState()).toMatchObject({ replies: [current] });
		const live = reply('live-reply', 'new', 4);
		f.replies = [current, other, live];
		f.runtime.reconcileReplies(f.replies);
		expect(f.runtime.getTraceConversationState()).toMatchObject({ replies: [current, live] });
	});

	it('keeps the current root when an explicit same-cell switch is out of range', () => {
		const f = fixture();
		f.runtime.openTraceConversation({ rootId: 'new', currentId: 'new' });
		f.roots = [root('new', 2, 3, 2), root('far', 1, 3, 2)];
		f.runtime.reconcileEffectiveRoots(f.roots);
		expect(f.runtime.openTraceConversation({ rootId: 'far', currentId: 'far' })).toEqual({ kind: 'blocked' });
		expect(f.runtime.getTraceConversationState()).toMatchObject({ kind: 'open', root: { id: 'new' } });
	});

	it('reactivates locally without network state and rejects an out-of-range post-reactivation', () => {
		let presence = createPresenceState({ columns: 4, rows: 3 }, 1_000, [
			{ id: 'self', position: { x: 2, y: 2 } },
			{ id: 'other', position: { x: 2, y: 2 } }
		]);
		presence = debugTimeoutParticipant(presence, 'self');
		const f = fixture(presence);
		f.roots = [root('target', 1, 2, 2)];
		expect(f.runtime.openTraceConversation({ rootId: 'target', currentId: 'target' })).toEqual({ kind: 'blocked' });
		expect(f.setPresence).not.toHaveBeenCalled();
	});

	it('falls back without activity only while the replacement remains in range', () => {
		const f = fixture();
		f.runtime.openTraceConversation({ rootId: 'old', currentId: 'old' });
		f.setPresence.mockClear();
		f.roots = [root('fallback', 3)];
		f.runtime.reconcileEffectiveRoots(f.roots);
		expect(f.runtime.getTraceConversationState()).toMatchObject({ kind: 'open', root: { id: 'fallback' } });
		expect(f.setPresence).not.toHaveBeenCalled();
		f.roots = [root('far', 4, 3, 2)];
		f.runtime.reconcileEffectiveRoots(f.roots);
		expect(f.runtime.getTraceConversationState()).toEqual({ kind: 'closed' });
	});

	it('closes explicitly and never notifies after dispose', () => {
		const f = fixture();
		f.runtime.openTraceConversation({ rootId: 'new', currentId: 'new' });
		f.runtime.closeTraceConversation();
		expect(f.runtime.getTraceConversationState()).toEqual({ kind: 'closed' });
		const count = f.states.length;
		f.runtime.dispose();
		f.roots = [];
		f.runtime.reconcileEffectiveRoots([]);
		expect(f.states).toHaveLength(count);
	});
});
