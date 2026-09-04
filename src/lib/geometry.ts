export type GridPosition = {
	x: number;
	y: number;
};

const CANONICAL_GRID_POSITION = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

function isCanonicalGridCoordinate(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Encodes a logical field cell in the single canonical representation used by
 * the Nostr protocol layer. Field-size validation intentionally remains with
 * the field domain because the product's final dimensions are not set yet.
 */
export function formatCanonicalGridPosition(position: GridPosition): string {
	if (!isCanonicalGridCoordinate(position.x) || !isCanonicalGridCoordinate(position.y)) {
		throw new TypeError('Grid position must contain non-negative safe integers.');
	}

	return `${position.x}:${position.y}`;
}

/**
 * Parses only the canonical decimal cell form. Equivalent alternate spellings
 * such as leading zeros and signed coordinates are deliberately rejected.
 */
export function parseCanonicalGridPosition(value: string): GridPosition | null {
	const match = CANONICAL_GRID_POSITION.exec(value);
	if (!match) return null;

	const x = Number(match[1]);
	const y = Number(match[2]);
	if (!isCanonicalGridCoordinate(x) || !isCanonicalGridCoordinate(y)) return null;

	return { x, y };
}

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
	/** The rendered silhouette relative to the unchanged body anchor. */
	visualBounds?: Bounds;
};

export type BubblePlacement = {
	id: string;
	anchor: WorldPoint;
};

export type FixedBubblePlacement = BubblePlacementInput & {
	anchor: WorldPoint;
};

export type Direction = 'up' | 'down' | 'left' | 'right';

export type FieldSize = {
	columns: number;
	rows: number;
	cellSize: number;
};

export const DESKTOP_CELL_SIZE = 76;
export const MOBILE_CELL_SIZE = 50;
export const MOBILE_FIELD_BREAKPOINT = 700;
export const DESKTOP_FIELD_SIDE_MARGIN = 8;
export const MOBILE_FIELD_SIDE_MARGIN = 8;

export function getResponsiveCellSize(viewportWidth: number): number {
	return viewportWidth <= MOBILE_FIELD_BREAKPOINT ? MOBILE_CELL_SIZE : DESKTOP_CELL_SIZE;
}

export function gridToWorld(cell: GridPosition, cellSize: number): WorldPoint {
	return {
		x: (cell.x + 0.5) * cellSize,
		y: (cell.y + 0.5) * cellSize
	};
}

export function getSameCellVisualOffset(
	participantId: string,
	peerIds: readonly string[],
	cellSize: number
): WorldPoint {
	const ids = [...new Set(peerIds)].sort();
	const index = ids.indexOf(participantId);
	if (index < 0 || ids.length <= 1) return { x: 0, y: 0 };

	const radius = Math.min(12, cellSize * 0.18);
	const angle = -Math.PI / 2 + (index * Math.PI * 2) / ids.length;
	return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export function getFieldWorldSize(field: FieldSize): Size {
	return {
		width: field.columns * field.cellSize,
		height: field.rows * field.cellSize
	};
}

export function getFieldAreaBounds(viewport: Size, speechArea: Pick<Bounds, 'y' | 'height'>): Bounds {
	const y = speechArea.y + speechArea.height;
	const sideMargin = viewport.width <= MOBILE_FIELD_BREAKPOINT
		? MOBILE_FIELD_SIDE_MARGIN
		: DESKTOP_FIELD_SIDE_MARGIN;

	return {
		x: sideMargin,
		y,
		width: Math.max(0, viewport.width - sideMargin * 2),
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
const MAX_PLACEMENT_CANDIDATES = 32;

function bubbleRect(anchor: WorldPoint, item: Pick<BubblePlacementInput, 'size' | 'visualBounds'>): Bounds {
	const bounds = item.visualBounds ?? { x: 0, y: 0, ...item.size };
	return { x: anchor.x + bounds.x, y: anchor.y + bounds.y, width: bounds.width, height: bounds.height };
}

function clampPlacementAnchor(
	anchor: WorldPoint,
	item: BubblePlacementInput,
	bounds: Bounds,
	visualRegion: Bounds
): WorldPoint {
	if (!item.visualBounds) return clampToBounds(anchor, item.size, bounds);
	const baseMinX = bounds.x;
	const baseMaxX = Math.max(baseMinX, bounds.x + bounds.width - item.size.width);
	const baseMinY = bounds.y;
	const baseMaxY = Math.max(baseMinY, bounds.y + bounds.height - item.size.height);
	const visualMinX = visualRegion.x - item.visualBounds.x;
	const visualMaxX = visualRegion.x + visualRegion.width - item.visualBounds.x - item.visualBounds.width;
	const visualMinY = visualRegion.y - item.visualBounds.y;
	const visualMaxY = visualRegion.y + visualRegion.height - item.visualBounds.y - item.visualBounds.height;
	const minX = Math.max(baseMinX, visualMinX);
	const maxX = Math.min(baseMaxX, visualMaxX);
	const minY = Math.max(baseMinY, visualMinY);
	const maxY = Math.min(baseMaxY, visualMaxY);
	if (minX > maxX + 1e-6 || minY > maxY + 1e-6) {
		throw new RangeError(`Bubble ${item.id} cannot fit its visual bounds inside the placement region.`);
	}
	return {
		x: Math.min(Math.max(anchor.x, minX), Math.max(minX, maxX)),
		y: Math.min(Math.max(anchor.y, minY), Math.max(minY, maxY))
	};
}

function gapOverlapArea(first: Bounds, second: Bounds, gap: number): number {
	const overlapWidth = Math.min(first.x + first.width, second.x + second.width + gap) -
		Math.max(first.x, second.x - gap);
	const overlapHeight = Math.min(first.y + first.height, second.y + second.height + gap) -
		Math.max(first.y, second.y - gap);

	return Math.max(0, overlapWidth) * Math.max(0, overlapHeight);
}

function candidateOffsets(item: BubblePlacementInput, cellSize: number, gap: number): readonly WorldPoint[] {
	const visualSize = item.visualBounds ?? { x: 0, y: 0, ...item.size };
	const verticalStep = visualSize.height + gap;
	const horizontalStep = Math.max(1, cellSize, visualSize.width / 2);

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

type PlacedBubble = BubblePlacementInput & {
	anchor: WorldPoint;
};

function addCandidate(candidates: WorldPoint[], seen: Set<string>, candidate: WorldPoint): void {
	if (candidates.length >= MAX_PLACEMENT_CANDIDATES) return;
	const key = `${candidate.x}:${candidate.y}`;

	if (seen.has(key)) return;
	seen.add(key);
	candidates.push(candidate);
}

function getCandidates(
	item: BubblePlacementInput,
	bounds: Bounds,
	visualRegion: Bounds,
	cellSize: number,
	gap: number,
	references: readonly PlacedBubble[] = []
): WorldPoint[] {
	const preferred = clampPlacementAnchor(item.preferred, item, bounds, visualRegion);
	const seen = new Set<string>();
	const candidates: WorldPoint[] = [];

	for (const offset of candidateOffsets(item, cellSize, gap)) {
		addCandidate(candidates, seen, clampPlacementAnchor(
			{ x: preferred.x + offset.x, y: preferred.y + offset.y },
			item,
			bounds,
			visualRegion
		));
	}

	for (const candidate of [
		{ x: bounds.x, y: preferred.y },
		{ x: bounds.x + bounds.width - item.size.width, y: preferred.y },
		{ x: preferred.x, y: bounds.y },
		{ x: preferred.x, y: bounds.y + bounds.height - item.size.height }
	]) {
		addCandidate(candidates, seen, clampPlacementAnchor(candidate, item, bounds, visualRegion));
	}

	for (const reference of references) {
		const previous = bubbleRect(reference.anchor, reference);
		const currentVisual = item.visualBounds ?? { x: 0, y: 0, ...item.size };
		for (const candidate of [
			{ x: preferred.x, y: previous.y - currentVisual.height - gap - currentVisual.y },
			{ x: preferred.x, y: previous.y + previous.height + gap - currentVisual.y },
			{ x: previous.x - currentVisual.width - gap - currentVisual.x, y: preferred.y },
			{ x: previous.x + previous.width + gap - currentVisual.x, y: preferred.y }
		]) {
			addCandidate(candidates, seen, clampPlacementAnchor(candidate, item, bounds, visualRegion));
		}
	}

	return candidates;
}

function chooseCandidate(
	item: BubblePlacementInput,
	candidates: readonly WorldPoint[],
	placed: readonly PlacedBubble[],
	gap: number
): { anchor: WorldPoint; overlap: number } {
	let bestCandidate = candidates[0] ?? item.preferred;
	let bestOverlap = Number.POSITIVE_INFINITY;
	let bestDistance = Number.POSITIVE_INFINITY;
	let hasNonOverlap = false;

	for (const candidate of candidates) {
		const overlap = placed.reduce(
			(total, previous) => total + gapOverlapArea(bubbleRect(candidate, item), bubbleRect(previous.anchor, previous), gap),
			0
		);
		const distance = Math.hypot(candidate.x - item.preferred.x, candidate.y - item.preferred.y);
		const isNonOverlap = overlap === 0;

		if (isNonOverlap && !hasNonOverlap) {
			hasNonOverlap = true;
			bestCandidate = candidate;
			bestOverlap = overlap;
			bestDistance = distance;
			continue;
		}

		if (hasNonOverlap && !isNonOverlap) continue;
		if (hasNonOverlap && distance >= bestDistance) continue;
		if (!hasNonOverlap && overlap > bestOverlap) continue;
		if (!hasNonOverlap && overlap === bestOverlap) continue;

		bestCandidate = candidate;
		bestOverlap = overlap;
		bestDistance = distance;
	}

	return { anchor: bestCandidate, overlap: bestOverlap };
}

function totalOverlap(
	group: readonly PlacedBubble[],
	fixed: readonly PlacedBubble[],
	gap: number
): number {
	let overlap = group.reduce(
		(total, current) => total + fixed.reduce(
			(fixedTotal, previous) => fixedTotal + gapOverlapArea(
				bubbleRect(current.anchor, current),
				bubbleRect(previous.anchor, previous),
				gap
			),
			0
		),
		0
	);

	for (let first = 0; first < group.length; first += 1) {
		for (let second = first + 1; second < group.length; second += 1) {
			overlap += gapOverlapArea(
				bubbleRect(group[first].anchor, group[first]),
				bubbleRect(group[second].anchor, group[second]),
				gap
			);
		}
	}

	return overlap;
}

function totalDistance(group: readonly PlacedBubble[]): number {
	return group.reduce(
		(total, item) => total + Math.hypot(item.anchor.x - item.preferred.x, item.anchor.y - item.preferred.y),
		0
	);
}

function findLocalRepair(
	current: BubblePlacementInput,
	related: readonly PlacedBubble[],
	fixed: readonly PlacedBubble[],
	bounds: Bounds,
	visualRegion: Bounds,
	cellSize: number,
	gap: number
): { group: PlacedBubble[]; overlap: number } | null {
	const groupItems = [...related, current];
	let best: { group: PlacedBubble[]; overlap: number; distance: number } | null = null;

	const search = (index: number, assigned: PlacedBubble[]) => {
		if (index === groupItems.length) {
			const overlap = totalOverlap(assigned, fixed, gap);
			const distance = totalDistance(assigned);

			if (
				!best ||
				overlap < best.overlap ||
				(overlap === best.overlap && distance < best.distance)
			) {
				best = { group: assigned.map((item) => ({ ...item, anchor: { ...item.anchor } })), overlap, distance };
			}
			return;
		}

		const item = groupItems[index];
		const unassigned = groupItems.slice(index + 1).map((candidate) => ({ ...candidate, anchor: clampPlacementAnchor(candidate.preferred, candidate, bounds, visualRegion) }));
		const localReferences = [...assigned, ...unassigned];
		const candidates = getCandidates(item, bounds, visualRegion, cellSize, gap, localReferences);

		for (const anchor of candidates) {
			search(index + 1, [...assigned, { ...item, anchor }]);
		}
	};

	search(0, []);
	if (!best) return null;
	const repaired = best as { group: PlacedBubble[]; overlap: number; distance: number };

	return { group: repaired.group, overlap: repaired.overlap };
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
	gap = BUBBLE_PLACEMENT_GAP,
	visualRegion: Bounds = bounds,
	fixedPlacements: readonly FixedBubblePlacement[] = []
): BubblePlacement[] {
	const orderedItems = [...items].sort((first, second) =>
		first.preferred.y - second.preferred.y ||
		first.preferred.x - second.preferred.x ||
		(first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
	);
	const fixedIds = new Set(fixedPlacements.map((placement) => placement.id));
	const placed: PlacedBubble[] = fixedPlacements.map((placement) => ({ ...placement }));
	const anchorsById = new Map<string, WorldPoint>();

	for (const item of orderedItems) {
		const candidates = getCandidates(item, bounds, visualRegion, cellSize, gap, placed);
		const choice = chooseCandidate(item, candidates, placed, gap);
		let anchor = choice.anchor;

		if (choice.overlap > 0 && placed.length > 0) {
			const related = placed
				.filter((previous) => !fixedIds.has(previous.id))
				.filter((previous) => candidates.some((candidate) =>
					gapOverlapArea(bubbleRect(candidate, item), bubbleRect(previous.anchor, previous), gap) > 0
				))
				.slice(-2);
			const fixed = placed.filter((previous) => !related.includes(previous));
			const repair = findLocalRepair(item, related, fixed, bounds, visualRegion, cellSize, gap);
			const greedyGroup = [...related, { ...item, anchor }];

			if (repair && repair.overlap < totalOverlap(greedyGroup, fixed, gap)) {
				for (const repaired of repair.group) {
					const existing = placed.find((previous) => previous.id === repaired.id);
					if (existing) existing.anchor = repaired.anchor;
					anchorsById.set(repaired.id, repaired.anchor);
				}
				anchor = repair.group[repair.group.length - 1].anchor;
			}
		}

		placed.push({ ...item, anchor });
		anchorsById.set(item.id, anchor);
	}

	return items.map((item) => ({ id: item.id, anchor: anchorsById.get(item.id)! }));
}

/** Places new bubbles around already-final placements without moving the fixed set. */
export function placeBubblesWithFixed(
	items: readonly BubblePlacementInput[],
	fixedPlacements: readonly FixedBubblePlacement[],
	bounds: Bounds,
	cellSize: number,
	gap = BUBBLE_PLACEMENT_GAP,
	visualRegion: Bounds = bounds
): BubblePlacement[] {
	return placeBubbles(items, bounds, cellSize, gap, visualRegion, fixedPlacements);
}
