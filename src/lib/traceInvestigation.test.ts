import { describe, expect, it } from 'vitest';
import { createPresenceState, debugTimeoutParticipant, getParticipant } from './presence';
import type { ParsedWorldMessage } from './nostrProtocol';
import {
	groupTraceRoots,
	isWithinTraceInvestigationRange,
	prepareTraceInspectionActivity
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

	it('groups effective roots deterministically by logical cell', () => {
		const cells = groupTraceRoots([
			root('c', 2, 2, 1), root('b', 3), root('z', 1, 0, 0), root('a', 3, 1, 2)
		]);
		expect(cells.map((cell) => `${cell.position.x},${cell.position.y}`)).toEqual(['0,0', '1,1', '2,1', '1,2']);
		expect(cells.every((cell) => cell.roots)).toBe(true);
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
