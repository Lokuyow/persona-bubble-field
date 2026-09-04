import type { Bounds, Direction, FieldSize, GridPosition, WorldPoint } from './geometry';

export type FieldCellAction =
	| Readonly<{ kind: 'participant'; participantId: string }>
	| Readonly<{ kind: 'trace'; rootId: string; behavior: 'open-root' | 'select-current' }>
	| Readonly<{ kind: 'reply'; replyId: string }>;

export type FieldCellActionResolution =
	| Readonly<{ kind: 'none' }>
	| Readonly<{ kind: 'direct'; action: FieldCellAction }>
	| Readonly<{ kind: 'menu'; actions: readonly FieldCellAction[] }>;

export function viewportPointToLogicalCell(input: Readonly<{
	point: WorldPoint;
	fieldArea: Bounds;
	camera: WorldPoint;
	field: FieldSize;
}>): GridPosition | null {
	const worldX = input.point.x - input.fieldArea.x + input.camera.x;
	const worldY = input.point.y - input.fieldArea.y + input.camera.y;
	const position = {
		x: Math.floor(worldX / input.field.cellSize),
		y: Math.floor(worldY / input.field.cellSize)
	};
	return position.x >= 0 && position.x < input.field.columns &&
		position.y >= 0 && position.y < input.field.rows ? position : null;
}

export function buildFieldCellActions(input: Readonly<{
	participantIds?: readonly string[];
	trace?: Extract<FieldCellAction, { kind: 'trace' }> | null;
	replyIds?: readonly string[];
}>): readonly FieldCellAction[] {
	const participantIds = [...new Set(input.participantIds ?? [])].sort();
	const replyIds = [...new Set(input.replyIds ?? [])];
	return [
		...participantIds.map((participantId) => ({
			kind: 'participant' as const,
			participantId
		})),
		...(input.trace ? [input.trace] : []),
		...replyIds.map((replyId) => ({ kind: 'reply' as const, replyId }))
	];
}

export function resolveFieldCellActions(actions: readonly FieldCellAction[]): FieldCellActionResolution {
	if (actions.length === 0) return { kind: 'none' };
	if (actions.length === 1) return { kind: 'direct', action: actions[0] };
	return { kind: 'menu', actions: [...actions] };
}
