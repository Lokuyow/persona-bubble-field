import { describe, expect, it } from 'vitest';
import {
	buildFieldCellActions,
	resolveFieldCellActions,
	viewportPointToLogicalCell
} from './fieldSelection';

describe('field logical-cell selection', () => {
	it('resolves viewport pointer coordinates through the camera into a logical cell', () => {
		expect(viewportPointToLogicalCell({
			point: { x: 75, y: 135 },
			fieldArea: { x: 10, y: 100, width: 200, height: 100 },
			camera: { x: 50, y: 0 },
			field: { columns: 4, rows: 2, cellSize: 50 }
		})).toEqual({ x: 2, y: 0 });
		expect(viewportPointToLogicalCell({
			point: { x: 0, y: 0 },
			fieldArea: { x: 10, y: 100, width: 200, height: 100 },
			camera: { x: 0, y: 0 },
			field: { columns: 4, rows: 2, cellSize: 50 }
		})).toBeNull();
	});

	it('builds deterministic cell actions and collapses every trace root into one action', () => {
		expect(buildFieldCellActions({
			participantIds: ['z', 'a', 'a'],
			trace: { kind: 'trace', rootId: 'root', behavior: 'open-root' },
			replyIds: ['newer', 'older', 'newer']
		})).toEqual([
			{ kind: 'participant', participantId: 'a' },
			{ kind: 'participant', participantId: 'z' },
			{ kind: 'trace', rootId: 'root', behavior: 'open-root' },
			{ kind: 'reply', replyId: 'newer' },
			{ kind: 'reply', replyId: 'older' }
		]);
	});

	it('executes one action directly and routes multiple actions through the shared menu', () => {
		expect(resolveFieldCellActions([])).toEqual({ kind: 'none' });
		const trace = { kind: 'trace' as const, rootId: 'root', behavior: 'open-root' as const };
		expect(resolveFieldCellActions([trace])).toEqual({ kind: 'direct', action: trace });
		expect(resolveFieldCellActions([{ kind: 'participant', participantId: 'a' }, trace])).toEqual({
			kind: 'menu', actions: [{ kind: 'participant', participantId: 'a' }, trace]
		});
	});
});
