export type GridPosition = {
	x: number;
	y: number;
};

export type WorldPoint = {
	x: number;
	y: number;
};

export type Size = {
	width: number;
	height: number;
};

export type Direction = 'up' | 'down' | 'left' | 'right';

export type FieldSize = {
	columns: number;
	rows: number;
	cellSize: number;
};

export function gridToWorld(cell: GridPosition, cellSize: number): WorldPoint {
	return {
		x: (cell.x + 0.5) * cellSize,
		y: (cell.y + 0.5) * cellSize
	};
}

export function getFieldWorldSize(field: FieldSize): Size {
	return {
		width: field.columns * field.cellSize,
		height: field.rows * field.cellSize
	};
}

export function clampCamera(target: WorldPoint, viewport: Size, fieldWorldSize: Size): WorldPoint {
	const x = fieldWorldSize.width <= viewport.width
		? (fieldWorldSize.width - viewport.width) / 2
		: Math.min(Math.max(target.x - viewport.width / 2, 0), fieldWorldSize.width - viewport.width);
	const y = fieldWorldSize.height <= viewport.height
		? (fieldWorldSize.height - viewport.height) / 2
		: Math.min(Math.max(target.y - viewport.height / 2, 0), fieldWorldSize.height - viewport.height);

	return { x, y };
}

export function worldToScreen(world: WorldPoint, camera: WorldPoint): WorldPoint {
	return {
		x: world.x - camera.x,
		y: world.y - camera.y
	};
}

export function moveOneCell(
	current: GridPosition,
	direction: Direction,
	field: Pick<FieldSize, 'columns' | 'rows'>,
	occupied: readonly GridPosition[] = []
): GridPosition | null {
	const delta: Record<Direction, GridPosition> = {
		up: { x: 0, y: -1 },
		down: { x: 0, y: 1 },
		left: { x: -1, y: 0 },
		right: { x: 1, y: 0 }
	};
	const next = {
		x: current.x + delta[direction].x,
		y: current.y + delta[direction].y
	};

	if (next.x < 0 || next.x >= field.columns || next.y < 0 || next.y >= field.rows) {
		return null;
	}

	if (occupied.some((cell) => cell.x === next.x && cell.y === next.y)) {
		return null;
	}

	return next;
}

export function normalBubblePreferredAnchor(
	speaker: WorldPoint,
	bubble: Size,
	tailGap: number
): WorldPoint {
	return {
		x: speaker.x - bubble.width / 2,
		y: speaker.y - bubble.height - tailGap
	};
}

export function mergedBubblePreferredAnchor(
	members: readonly WorldPoint[],
	bubble: Size,
	tailGap: number
): WorldPoint {
	if (members.length === 0) {
		return { x: 0, y: 0 };
	}

	const centerX = members.reduce((sum, member) => sum + member.x, 0) / members.length;
	const highestMemberY = Math.min(...members.map((member) => member.y));

	return {
		x: centerX - bubble.width / 2,
		y: highestMemberY - bubble.height - tailGap
	};
}

export function clampToViewport(anchor: WorldPoint, bubble: Size, viewport: Size, margin = 12): WorldPoint {
	const maxX = Math.max(margin, viewport.width - bubble.width - margin);
	const maxY = Math.max(margin, viewport.height - bubble.height - margin);

	return {
		x: Math.min(Math.max(anchor.x, margin), maxX),
		y: Math.min(Math.max(anchor.y, margin), maxY)
	};
}
