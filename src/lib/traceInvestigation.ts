import type { GridPosition } from './geometry';
import type { ParsedWorldMessage } from './nostrProtocol';
import {
	getParticipant,
	recordPresenceActivity,
	type PresenceState,
	type RandomSource
} from './presence';

export type TraceRootCell = Readonly<{
	position: GridPosition;
	roots: readonly ParsedWorldMessage[];
}>;

export type TraceRootSelection = Readonly<{
	position: GridPosition;
	rootId: string;
}>;

export type TraceSelectionDetails = Readonly<{
	cell: TraceRootCell;
	root: ParsedWorldMessage;
	index: number;
	total: number;
}>;

export type TraceInspectionPreparation =
	| Readonly<{ kind: 'blocked' }>
	| Readonly<{
		kind: 'ready';
		position: GridPosition;
		nextPresence: PresenceState;
		coalesced: boolean;
	}>;

function compareRoots(first: ParsedWorldMessage, second: ParsedWorldMessage): number {
	return second.createdAt - first.createdAt ||
		(first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}

export function traceCellKey(position: GridPosition): string {
	return `${position.x},${position.y}`;
}

export function sameGridPosition(first: GridPosition, second: GridPosition): boolean {
	return first.x === second.x && first.y === second.y;
}

export function groupTraceRoots(roots: readonly ParsedWorldMessage[]): readonly TraceRootCell[] {
	const byCell = new Map<string, ParsedWorldMessage[]>();
	for (const root of roots) {
		const key = traceCellKey(root.position);
		const cell = byCell.get(key) ?? [];
		if (!cell.some((candidate) => candidate.id === root.id)) cell.push(root);
		byCell.set(key, cell);
	}
	return [...byCell.values()]
		.map((cellRoots) => ({
			position: { ...cellRoots[0].position },
			roots: [...cellRoots].sort(compareRoots)
		}))
		.sort((first, second) => first.position.y - second.position.y || first.position.x - second.position.x);
}

export function isWithinTraceInvestigationRange(self: GridPosition, target: GridPosition): boolean {
	return Math.max(Math.abs(self.x - target.x), Math.abs(self.y - target.y)) <= 1;
}

export function newestTraceRootSelection(cell: TraceRootCell): TraceRootSelection | null {
	const root = cell.roots[0];
	return root ? { position: { ...cell.position }, rootId: root.id } : null;
}

export function traceSelectionDetails(
	selection: TraceRootSelection | null,
	cells: readonly TraceRootCell[]
): TraceSelectionDetails | null {
	if (!selection) return null;
	const cell = cells.find((candidate) => sameGridPosition(candidate.position, selection.position));
	if (!cell) return null;
	const index = cell.roots.findIndex((root) => root.id === selection.rootId);
	if (index < 0) return null;
	return { cell, root: cell.roots[index], index, total: cell.roots.length };
}

export function reconcileTraceRootSelection(
	selection: TraceRootSelection | null,
	cells: readonly TraceRootCell[]
): TraceRootSelection | null {
	if (!selection) return null;
	if (traceSelectionDetails(selection, cells)) return selection;
	const cell = cells.find((candidate) => sameGridPosition(candidate.position, selection.position));
	return cell ? newestTraceRootSelection(cell) : null;
}

export function stepTraceRootSelection(
	selection: TraceRootSelection,
	cells: readonly TraceRootCell[],
	delta: -1 | 1
): TraceRootSelection {
	const details = traceSelectionDetails(selection, cells);
	if (!details) return selection;
	const index = Math.min(details.total - 1, Math.max(0, details.index + delta));
	return { position: { ...details.cell.position }, rootId: details.cell.roots[index].id };
}

export function prepareTraceInspectionActivity(input: Readonly<{
	presence: PresenceState;
	selfId: string;
	target: GridPosition;
	nowMs: number;
	requireCurrentRange?: boolean;
	random?: RandomSource;
}>): TraceInspectionPreparation {
	const current = getParticipant(input.presence, input.selfId);
	if (!current) return { kind: 'blocked' };
	if (input.requireCurrentRange && !isWithinTraceInvestigationRange(current.position, input.target)) {
		return { kind: 'blocked' };
	}
	const nextPresence = recordPresenceActivity(
		input.presence,
		input.selfId,
		'trace-inspection',
		input.nowMs,
		input.random
	);
	const next = getParticipant(nextPresence, input.selfId);
	if (!next || !isWithinTraceInvestigationRange(next.position, input.target)) return { kind: 'blocked' };
	const coalesced = current.status === 'active' &&
		Math.floor(current.lastActivityAt / 1000) === Math.floor(input.nowMs / 1000) &&
		sameGridPosition(current.position, next.position);
	return {
		kind: 'ready',
		position: { ...next.position },
		nextPresence: coalesced ? input.presence : nextPresence,
		coalesced
	};
}
