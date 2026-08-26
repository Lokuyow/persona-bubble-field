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

export type Bounds = Size & {
	x: number;
	y: number;
};

export type Direction = 'up' | 'down' | 'left' | 'right';

export type FieldSize = {
	columns: number;
	rows: number;
	cellSize: number;
};

export const DESKTOP_CELL_SIZE = 72;
export const MOBILE_CELL_SIZE = 56;
export const MOBILE_FIELD_BREAKPOINT = 700;

export function getResponsiveCellSize(viewportWidth: number): number {
	return viewportWidth <= MOBILE_FIELD_BREAKPOINT ? MOBILE_CELL_SIZE : DESKTOP_CELL_SIZE;
}

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

export function getFieldAreaBounds(viewport: Size, speechArea: Pick<Bounds, 'y' | 'height'>): Bounds {
	const y = speechArea.y + speechArea.height;

	return {
		x: 0,
		y,
		width: viewport.width,
		height: Math.max(0, viewport.height - y)
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

export function fieldLocalToViewport(local: WorldPoint, fieldArea: Pick<Bounds, 'x' | 'y'>): WorldPoint {
	return {
		x: local.x + fieldArea.x,
		y: local.y + fieldArea.y
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

export function speechAreaBubbleY(speechArea: Bounds, bubble: Size): number {
	return speechArea.y + Math.max(0, (speechArea.height - bubble.height) / 2);
}

export function normalBubblePreferredAnchor(speakerX: number, bubble: Size, speechArea: Bounds): WorldPoint {
	return {
		x: speakerX - bubble.width / 2,
		y: speechAreaBubbleY(speechArea, bubble)
	};
}

export function mergedBubblePreferredAnchor(
	members: readonly WorldPoint[],
	bubble: Size,
	speechArea: Bounds
): WorldPoint {
	if (members.length === 0) {
		return { x: 0, y: 0 };
	}

	const centerX = members.reduce((sum, member) => sum + member.x, 0) / members.length;

	return {
		x: centerX - bubble.width / 2,
		y: speechAreaBubbleY(speechArea, bubble)
	};
}

export function clampToBounds(anchor: WorldPoint, bubble: Size, bounds: Bounds, margin = 0): WorldPoint {
	const minX = bounds.x + margin;
	const minY = bounds.y + margin;
	const maxX = Math.max(minX, bounds.x + bounds.width - bubble.width - margin);
	const maxY = Math.max(minY, bounds.y + bounds.height - bubble.height - margin);

	return {
		x: Math.min(Math.max(anchor.x, minX), maxX),
		y: Math.min(Math.max(anchor.y, minY), maxY)
	};
}

export function clampToViewport(anchor: WorldPoint, bubble: Size, viewport: Size, margin = 12): WorldPoint {
	return clampToBounds(anchor, bubble, { x: 0, y: 0, ...viewport }, margin);
}
