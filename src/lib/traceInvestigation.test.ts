import { describe, expect, it } from 'vitest';
import { createPresenceState, debugTimeoutParticipant, getParticipant } from './presence';
import type { ParsedWorldMessage } from './nostrProtocol';
import {
	groupTraceRoots,
	isWithinTraceInvestigationRange,
	newestTraceRootSelection,
	prepareTraceInspectionActivity,
	reconcileTraceRootSelection,
	stepTraceRootSelection,
	traceSelectionDetails
} from './traceInvestigation';

function root(id: string, createdAt: number, x = 1, y = 1): ParsedWorldMessage {
	return { id, pubkey: id.padEnd(64, '0'), createdAt, content: id, speechType: 'normal', position: { x, y } };
}

describe('trace investigation', () => {
	it('uses the logical surrounding 3x3 cells as the investigation range', () => {
		for (const target of [
			{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }
		]) expect(isWithinTraceInvestigationRange({ x: 1, y: 1 }, target)).toBe(true);
		expect(isWithinTraceInvestigationRange({ x: 1, y: 1 }, { x: 3, y: 1 })).toBe(false);
		expect(isWithinTraceInvestigationRange({ x: 1, y: 1 }, { x: 2, y: 3 })).toBe(false);
	});

	it('groups cells deterministically and sorts roots newest-first with lexical ties', () => {
		const cells = groupTraceRoots([
			root('c', 2, 2, 1), root('b', 3), root('a', 3), root('z', 1, 0, 0), root('a', 3)
		]);
		expect(cells.map((cell) => `${cell.position.x},${cell.position.y}`)).toEqual(['0,0', '1,1', '2,1']);
		expect(cells[1].roots.map((candidate) => candidate.id)).toEqual(['a', 'b']);
	});

	it('opens newest, bounds previous and next, and preserves selection across reorder', () => {
		const cells = groupTraceRoots([root('old', 1), root('new', 2), root('middle', 1.5)]);
		const opened = newestTraceRootSelection(cells[0])!;
		expect(opened.rootId).toBe('new');
		expect(stepTraceRootSelection(opened, cells, -1)).toEqual(opened);
		const second = stepTraceRootSelection(opened, cells, 1);
		expect(traceSelectionDetails(second, cells)?.index).toBe(1);
		const last = stepTraceRootSelection(stepTraceRootSelection(second, cells, 1), cells, 1);
		expect(traceSelectionDetails(last, cells)?.index).toBe(2);
		expect(reconcileTraceRootSelection(second, groupTraceRoots([root('latest', 4), ...cells[0].roots]))).toEqual(second);
	});

	it('falls back to newest only after eviction and closes when the cell disappears', () => {
		const selected = { position: { x: 1, y: 1 }, rootId: 'selected' };
		expect(reconcileTraceRootSelection(selected, groupTraceRoots([root('newest', 4), root('other', 3)])))
			.toEqual({ position: { x: 1, y: 1 }, rootId: 'newest' });
		expect(reconcileTraceRootSelection(selected, groupTraceRoots([root('elsewhere', 4, 2, 2)]))).toBeNull();
	});

	it('prepares active activity without moving and safely coalesces only the same second', () => {
		const presence = createPresenceState({ columns: 4, rows: 4 }, 1_100, [{ id: 'self', position: { x: 1, y: 1 } }]);
		const coalesced = prepareTraceInspectionActivity({ presence, selfId: 'self', target: { x: 2, y: 2 }, nowMs: 1_900 });
		expect(coalesced).toMatchObject({ kind: 'ready', position: { x: 1, y: 1 }, coalesced: true });
		if (coalesced.kind === 'ready') expect(coalesced.nextPresence).toBe(presence);
		const refreshed = prepareTraceInspectionActivity({ presence, selfId: 'self', target: { x: 2, y: 2 }, nowMs: 2_000 });
		expect(refreshed).toMatchObject({ kind: 'ready', coalesced: false });
	});

	it('checks both current switch range and the actual post-reactivation position', () => {
		let presence = createPresenceState({ columns: 4, rows: 2 }, 10, [
			{ id: 'self', position: { x: 2, y: 1 } },
			{ id: 'other', position: { x: 2, y: 1 } }
		]);
		presence = debugTimeoutParticipant(presence, 'self');
		expect(prepareTraceInspectionActivity({
			presence, selfId: 'self', target: { x: 2, y: 1 }, nowMs: 20,
			requireCurrentRange: true, random: () => 0
		})).toEqual({ kind: 'blocked' });
		expect(prepareTraceInspectionActivity({
			presence, selfId: 'self', target: { x: 0, y: 0 }, nowMs: 20,
			requireCurrentRange: true, random: () => 0
		})).toEqual({ kind: 'blocked' });
		expect(getParticipant(presence, 'self')?.status).toBe('inactive');
	});
});
