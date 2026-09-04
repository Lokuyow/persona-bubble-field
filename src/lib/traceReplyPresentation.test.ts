import { describe, expect, it } from 'vitest';
import { CHARACTER_CATALOG } from './character';
import { deriveCharacterFromPubkey } from './characterAssignment';
import type { Bounds } from './geometry';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationState } from './traceConversation';
import {
	deriveTraceReplyCharacter,
	EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE,
	projectPointToViewportEdge,
	projectTraceReplyCell,
	reconcileTraceReplyPresentation,
	resolveTraceGhostPlacement
} from './traceReplyPresentation';

const ROOT_ID = 'a'.repeat(64);
const ROOT: ParsedWorldMessage = {
	id: ROOT_ID,
	pubkey: 'b'.repeat(64),
	createdAt: 100,
	content: 'root',
	speechType: 'normal',
	position: { x: 2, y: 2 }
};

function reply(options: Readonly<{
	id: string;
	createdAt: number;
	x?: number;
	y?: number;
	parentId?: string;
	parentKind?: 42 | 1111;
	rootId?: string;
	pubkey?: string;
}>): ParsedTraceReply {
	return {
		id: options.id,
		pubkey: options.pubkey ?? 'c'.repeat(64),
		createdAt: options.createdAt,
		content: options.id,
		speechType: 'normal',
		position: { x: options.x ?? 3, y: options.y ?? 2 },
		rootId: options.rootId ?? ROOT_ID,
		rootPubkey: ROOT.pubkey,
		parentId: options.parentId ?? ROOT_ID,
		parentKind: options.parentKind ?? 42,
		parentPubkey: ROOT.pubkey
	};
}

function open(replies: readonly ParsedTraceReply[], currentId = ROOT_ID): TraceConversationState {
	return {
		kind: 'open',
		root: ROOT,
		config: { rootId: ROOT_ID, currentId },
		replies,
		replyRefresh: 'settled'
	};
}

describe('Trace direct reply presentation', () => {
	it('keeps only root-direct replies and orders cells and replies deterministically', () => {
		const older = reply({ id: '2'.repeat(64), createdAt: 101, x: 4, y: 2 });
		const newestLaterId = reply({ id: '9'.repeat(64), createdAt: 102, x: 4, y: 2 });
		const newestEarlierId = reply({ id: '1'.repeat(64), createdAt: 102, x: 4, y: 2 });
		const firstCell = reply({ id: '3'.repeat(64), createdAt: 99, x: 5, y: 1 });
		const deeper = reply({ id: '4'.repeat(64), createdAt: 103, parentId: older.id, parentKind: 1111 });
		const otherRoot = reply({ id: '5'.repeat(64), createdAt: 104, rootId: 'f'.repeat(64) });
		const result = reconcileTraceReplyPresentation(EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE, open([
			newestLaterId, deeper, older, firstCell, newestEarlierId, otherRoot, older
		]));

		expect(result.cells.map((cell) => cell.position)).toEqual([{ x: 5, y: 1 }, { x: 4, y: 2 }]);
		expect(result.cells[1].replies.map((candidate) => candidate.id)).toEqual([
			newestEarlierId.id, newestLaterId.id, older.id
		]);
		expect(result.cells[1]).toMatchObject({ representative: { id: newestEarlierId.id }, count: 3 });
	});

	it('preserves a representative during live updates, falls back when it disappears, and resets after close', () => {
		const older = reply({ id: '1'.repeat(64), createdAt: 101 });
		const initialNewest = reply({ id: '2'.repeat(64), createdAt: 102 });
		const liveNewest = reply({ id: '3'.repeat(64), createdAt: 103 });
		const initial = reconcileTraceReplyPresentation(EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE, open([older, initialNewest]));
		const live = reconcileTraceReplyPresentation(initial.state, open([older, initialNewest, liveNewest]));
		expect(live.cells[0].representative.id).toBe(initialNewest.id);

		const missing = reconcileTraceReplyPresentation(live.state, open([older, liveNewest]));
		expect(missing.cells[0].representative.id).toBe(liveNewest.id);
		const closed = reconcileTraceReplyPresentation(missing.state, { kind: 'closed' });
		const reopened = reconcileTraceReplyPresentation(closed.state, open([older, initialNewest, liveNewest]));
		expect(reopened.cells[0].representative.id).toBe(liveNewest.id);
	});

	it('does not expose replies for a non-root current speech', () => {
		const result = reconcileTraceReplyPresentation(
			EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE,
			open([reply({ id: '1'.repeat(64), createdAt: 101 })], 'd'.repeat(64))
		);
		expect(result.cells).toEqual([]);
	});

	it('delegates reply authors to the canonical character assignment', () => {
		const candidate = reply({ id: '1'.repeat(64), createdAt: 101, pubkey: 'e'.repeat(64) });
		expect(deriveTraceReplyCharacter(candidate, CHARACTER_CATALOG)).toEqual(
			deriveCharacterFromPubkey(candidate.pubkey, CHARACTER_CATALOG)
		);
	});

	it('projects cell centers through the camera and classifies the inclusive visible boundary', () => {
		const visibleBounds: Bounds = { x: 10, y: 20, width: 100, height: 100 };
		expect(projectTraceReplyCell({
			position: { x: 1, y: 1 }, cellSize: 20, camera: { x: 20, y: 20 },
			fieldArea: { x: 10, y: 20 }, visibleBounds
		})).toMatchObject({ screen: { x: 20, y: 30 }, visibility: 'onscreen' });
		expect(projectTraceReplyCell({
			position: { x: 8, y: 1 }, cellSize: 20, camera: { x: 20, y: 20 },
			fieldArea: { x: 10, y: 20 }, visibleBounds
		})).toMatchObject({ visibility: 'offscreen', edge: { direction: 'right' } });
	});

	it.each([
		[{ x: 50, y: -100 }, 'up'],
		[{ x: 200, y: -100 }, 'up-right'],
		[{ x: 200, y: 50 }, 'right'],
		[{ x: 200, y: 200 }, 'down-right'],
		[{ x: 50, y: 200 }, 'down'],
		[{ x: -100, y: 200 }, 'down-left'],
		[{ x: -100, y: 50 }, 'left'],
		[{ x: -100, y: -100 }, 'up-left']
	] as const)('projects %j to the %s edge direction', (target, direction) => {
		const projected = projectPointToViewportEdge(target, { x: 0, y: 0, width: 100, height: 100 }, 10);
		expect(projected.direction).toBe(direction);
		expect(projected.point.x).toBeGreaterThanOrEqual(10);
		expect(projected.point.x).toBeLessThanOrEqual(90);
		expect(projected.point.y).toBeGreaterThanOrEqual(10);
		expect(projected.point.y).toBeLessThanOrEqual(90);
	});

	it('keeps participants central and assigns distinct deterministic root/reply ghost slots', () => {
		expect(resolveTraceGhostPlacement({
			kind: 'reply', cellSize: 100, hasParticipant: false, hasRootGhost: false
		})).toEqual({ offset: { x: 0, y: 0 }, scale: 1, subdued: false });
		const root = resolveTraceGhostPlacement({
			kind: 'root', cellSize: 100, hasParticipant: true, hasRootGhost: true
		});
		const replyGhost = resolveTraceGhostPlacement({
			kind: 'reply', cellSize: 100, hasParticipant: true, hasRootGhost: true
		});
		expect(root).toMatchObject({ scale: 0.58, subdued: true });
		expect(root.offset.x).toBeCloseTo(-29);
		expect(root.offset.y).toBeCloseTo(27);
		expect(replyGhost).toMatchObject({ scale: 0.58, subdued: true });
		expect(replyGhost.offset.x).toBeCloseTo(29);
		expect(replyGhost.offset.y).toBeCloseTo(27);
	});
});
