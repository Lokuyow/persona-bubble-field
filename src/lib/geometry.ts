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

export type BubblePlacementInput = {
	id: string;
	preferred: WorldPoint;
	size: Size;
};

export type BubblePlacement = {
	id: string;
	anchor: WorldPoint;
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

export function getActualFieldTop(fieldArea: Bounds, camera: WorldPoint): number {
	return fieldArea.y + Math.max(0, -camera.y);
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

export function logicalFieldYToSpeechY(
	logicalY: number,
	rowCount: number,
	bubble: Size,
	speechArea: Bounds
): number {
	const minY = speechArea.y;
	const maxY = Math.max(minY, speechArea.y + speechArea.height - bubble.height);
	const normalizedY = rowCount <= 1 ? 0.5 : Math.min(Math.max(logicalY / (rowCount - 1), 0), 1);

	return minY + (maxY - minY) * normalizedY;
}

export function normalBubblePreferredAnchor(
	speakerX: number,
	logicalY: number,
	rowCount: number,
	bubble: Size,
	speechArea: Bounds
): WorldPoint {
	return {
		x: speakerX - bubble.width / 2,
		y: logicalFieldYToSpeechY(logicalY, rowCount, bubble, speechArea)
	};
}

export function mergedBubblePreferredAnchor(
	members: readonly WorldPoint[],
	rowCount: number,
	bubble: Size,
	speechArea: Bounds
): WorldPoint {
	if (members.length === 0) {
		return { x: 0, y: 0 };
	}

	const centerX = members.reduce((sum, member) => sum + member.x, 0) / members.length;
	const averageY = members.reduce((sum, member) => sum + member.y, 0) / members.length;

	return {
		x: centerX - bubble.width / 2,
		y: logicalFieldYToSpeechY(averageY, rowCount, bubble, speechArea)
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

const BUBBLE_PLACEMENT_GAP = 8;

function bubbleRect(anchor: WorldPoint, size: Size): Bounds {
	return { ...anchor, ...size };
}

function gapOverlapArea(first: Bounds, second: Bounds, gap: number): number {
	const overlapWidth = Math.min(first.x + first.width, second.x + second.width + gap) -
		Math.max(first.x, second.x - gap);
	const overlapHeight = Math.min(first.y + first.height, second.y + second.height + gap) -
		Math.max(first.y, second.y - gap);

	return Math.max(0, overlapWidth) * Math.max(0, overlapHeight);
}

function candidateOffsets(size: Size, cellSize: number, gap: number): readonly WorldPoint[] {
	const verticalStep = size.height + gap;
	const horizontalStep = Math.max(1, cellSize);

	return [
		{ x: 0, y: 0 },
		{ x: 0, y: -verticalStep },
		{ x: 0, y: verticalStep },
		{ x: -horizontalStep, y: 0 },
		{ x: horizontalStep, y: 0 },
		{ x: -horizontalStep, y: -verticalStep },
		{ x: horizontalStep, y: -verticalStep },
		{ x: -horizontalStep, y: verticalStep },
		{ x: horizontalStep, y: verticalStep },
		{ x: 0, y: -2 * verticalStep },
		{ x: 0, y: 2 * verticalStep },
		{ x: -horizontalStep, y: -2 * verticalStep },
		{ x: horizontalStep, y: -2 * verticalStep },
		{ x: -horizontalStep, y: 2 * verticalStep },
		{ x: horizontalStep, y: 2 * verticalStep }
	];
}

function getCandidates(
	item: BubblePlacementInput,
	bounds: Bounds,
	cellSize: number,
	gap: number
): WorldPoint[] {
	const preferred = clampToBounds(item.preferred, item.size, bounds);
	const seen = new Set<string>();
	const candidates: WorldPoint[] = [];

	for (const offset of candidateOffsets(item.size, cellSize, gap)) {
		const candidate = clampToBounds(
			{ x: preferred.x + offset.x, y: preferred.y + offset.y },
			item.size,
			bounds
		);
		const key = `${candidate.x}:${candidate.y}`;

		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(candidate);
	}

	return candidates;
}

/**
 * Places bubbles in a stable order using a bounded set of candidates around
 * their already-clamped preferred anchors. It intentionally makes no attempt
 * at global packing: a candidate that cannot avoid earlier bubbles is chosen
 * by minimum gap-aware overlap area.
 */
export function placeBubbles(
	items: readonly BubblePlacementInput[],
	bounds: Bounds,
	cellSize: number,
	gap = BUBBLE_PLACEMENT_GAP
): BubblePlacement[] {
	const orderedItems = [...items].sort((first, second) =>
		first.preferred.y - second.preferred.y ||
		first.preferred.x - second.preferred.x ||
		(first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
	);
	const placed: Array<{ anchor: WorldPoint; size: Size }> = [];
	const results: BubblePlacement[] = [];

	for (const item of orderedItems) {
		const preferred = clampToBounds(item.preferred, item.size, bounds);
		const candidates = getCandidates(item, bounds, cellSize, gap);
		let bestCandidate = candidates[0] ?? preferred;
		let bestOverlap = Number.POSITIVE_INFINITY;
		let bestDistance = Number.POSITIVE_INFINITY;
		let hasNonOverlap = false;

		for (const candidate of candidates) {
			const overlap = placed.reduce(
				(total, previous) => total + gapOverlapArea(bubbleRect(candidate, item.size), bubbleRect(previous.anchor, previous.size), gap),
				0
			);
			const distance = Math.hypot(candidate.x - preferred.x, candidate.y - preferred.y);
			const isNonOverlap = overlap === 0;

			if (isNonOverlap && !hasNonOverlap) {
				hasNonOverlap = true;
				bestCandidate = candidate;
				bestOverlap = overlap;
				bestDistance = distance;
				continue;
			}

			if (hasNonOverlap && !isNonOverlap) continue;
			if (hasNonOverlap && distance > bestDistance) continue;
			if (!hasNonOverlap && overlap > bestOverlap) continue;
			if (!hasNonOverlap && overlap === bestOverlap) continue;

			bestCandidate = candidate;
			bestOverlap = overlap;
			bestDistance = distance;
		}

		placed.push({ anchor: bestCandidate, size: item.size });
		results.push({ id: item.id, anchor: bestCandidate });
	}

	const placementById = new Map(results.map((result) => [result.id, result]));

	return items.map((item) => placementById.get(item.id)!);
}
