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

export type Direction =
	| 'up'
	| 'up-right'
	| 'right'
	| 'down-right'
	| 'down'
	| 'down-left'
	| 'left'
	| 'up-left';

export type FieldSize = {
	columns: number;
	rows: number;
	cellSize: number;
};

export const DESKTOP_CELL_SIZE = 76;
export const MOBILE_CELL_SIZE = 50;
export const MOBILE_FIELD_BREAKPOINT = 700;
const DESKTOP_FIELD_SIDE_MARGIN = 8;
const MOBILE_FIELD_SIDE_MARGIN = 8;

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

export function getFieldAreaBounds(viewport: Size): Bounds {
	const y = 0;
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

export function clampCamera(target: WorldPoint, viewport: Size, cameraWorldBounds: Bounds): WorldPoint {
	const x = cameraWorldBounds.width <= viewport.width
		? cameraWorldBounds.x + (cameraWorldBounds.width - viewport.width) / 2
		: Math.min(
			Math.max(target.x - viewport.width / 2, cameraWorldBounds.x),
			cameraWorldBounds.x + cameraWorldBounds.width - viewport.width
		);
	const y = cameraWorldBounds.height <= viewport.height
		? cameraWorldBounds.y + (cameraWorldBounds.height - viewport.height) / 2
		: Math.min(
			Math.max(target.y - viewport.height / 2, cameraWorldBounds.y),
			cameraWorldBounds.y + cameraWorldBounds.height - viewport.height
		);

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
		'up-right': { x: 1, y: -1 },
		right: { x: 1, y: 0 },
		'down-right': { x: 1, y: 1 },
		down: { x: 0, y: 1 },
		'down-left': { x: -1, y: 1 },
		left: { x: -1, y: 0 },
		'up-left': { x: -1, y: -1 }
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

/** Normal character presentation, excluding effects and animation overflow. */
export function characterFootprint(screen: WorldPoint, cellSize: number): Bounds {
	return { x: screen.x - cellSize / 2, y: screen.y - cellSize / 2, width: cellSize, height: cellSize };
}

const PREFERRED_BUBBLE_CONNECTION_DISTANCE = 40;

export function sourceAboveBubblePreferredAnchor(speaker: Bounds, bubble: Size): WorldPoint {
	return {
		x: speaker.x + speaker.width / 2 - bubble.width / 2,
		y: speaker.y - PREFERRED_BUBBLE_CONNECTION_DISTANCE - bubble.height
	};
}

export function mergedBubblePreferredAnchor(members: readonly Bounds[], bubble: Size): WorldPoint {
	const centerX = members.reduce((sum, member) => sum + member.x + member.width / 2, 0) / members.length;
	return sourceAboveBubblePreferredAnchor({ x: centerX, y: Math.min(...members.map((member) => member.y)), width: 0, height: 0 }, bubble);
}

export type LivePlacementConstraints = Readonly<{
	uiObstacles: readonly Bounds[];
	characterObstacles: readonly Bounds[];
}>;

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

export const BUBBLE_PLACEMENT_GAP = 8;
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

function hardOverlap(item: BubblePlacementInput, anchor: WorldPoint, constraints: LivePlacementConstraints): readonly [number, number] {
	const rect = bubbleRect(anchor, item);
	const overlap = (obstacles: readonly Bounds[]) => obstacles.reduce(
		(total, obstacle) => total + gapOverlapArea(rect, obstacle, 0), 0
	);
	return [overlap(constraints.uiObstacles), overlap(constraints.characterObstacles)];
}

function compareHard(first: readonly number[], second: readonly number[]): number {
	return first[0] - second[0] || first[1] - second[1];
}

/**
 * The nearest point of a rectangular free anchor space lies at the preferred
 * coordinate or a forbidden-rectangle edge. Enumerate edges, never pixels, so
 * a narrow legal opening cannot be lost to the soft candidate budget.
 */
export function correctBubbleAnchor(item: BubblePlacementInput, bounds: Bounds, visualRegion: Bounds, constraints: LivePlacementConstraints): WorldPoint {
	const preferred = clampPlacementAnchor(item.preferred, item, bounds, visualRegion);
	let best = preferred;
	let bestHard = hardOverlap(item, best, constraints);
	if (bestHard.every((value) => value === 0)) return best;
	let bestDistance = Math.hypot(best.x - item.preferred.x, best.y - item.preferred.y);
	const footprint = item.visualBounds ?? { x: 0, y: 0, ...item.size };
	const min = clampPlacementAnchor({ x: -Infinity, y: -Infinity }, item, bounds, visualRegion);
	const max = clampPlacementAnchor({ x: Infinity, y: Infinity }, item, bounds, visualRegion);
	const xs = new Set([preferred.x, min.x, max.x]);
	const ys = new Set([preferred.y, min.y, max.y]);
	for (const obstacle of [...constraints.uiObstacles, ...constraints.characterObstacles]) {
		const left = obstacle.x - footprint.x - footprint.width;
		const right = obstacle.x + obstacle.width - footprint.x;
		const top = obstacle.y - footprint.y - footprint.height;
		const bottom = obstacle.y + obstacle.height - footprint.y;
		if (right < min.x || left > max.x || bottom < min.y || top > max.y) continue;
		xs.add(Math.max(min.x, Math.min(max.x, left)));
		xs.add(Math.max(min.x, Math.min(max.x, right)));
		ys.add(Math.max(min.y, Math.min(max.y, top)));
		ys.add(Math.max(min.y, Math.min(max.y, bottom)));
	}
	for (const x of [...xs].sort((a, b) => a - b)) {
		for (const y of [...ys].sort((a, b) => a - b)) {
			const anchor = { x, y };
			const hard = hardOverlap(item, anchor, constraints);
			const order = compareHard(hard, bestHard);
			const distance = Math.hypot(x - item.preferred.x, y - item.preferred.y);
			if (order < 0 || (order === 0 && distance < bestDistance)) {
				best = anchor; bestHard = hard; bestDistance = distance;
			}
		}
	}
	return best;
}

function liveScore(item: PlacedBubble, others: readonly PlacedBubble[], cellSize: number, gap: number): number {
	const overlap = others.reduce((total, previous) => previous.id === item.id ? total :
		total + gapOverlapArea(bubbleRect(item.anchor, item), bubbleRect(previous.anchor, previous), gap), 0);
	return Math.hypot(item.anchor.x - item.preferred.x, item.anchor.y - item.preferred.y) / cellSize +
		Math.min(2, overlap / Math.max(1, item.size.width * item.size.height));
}

function groupLiveScore(group: readonly PlacedBubble[], fixed: readonly PlacedBubble[], cellSize: number, gap: number): number {
	return group.reduce((total, item) => total + liveScore(item, [...group, ...fixed], cellSize, gap), 0);
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
	references: readonly PlacedBubble[] = [],
	constraints?: LivePlacementConstraints
): WorldPoint[] {
	const preferred = clampPlacementAnchor(item.preferred, item, bounds, visualRegion);
	const seen = new Set<string>();
	const candidates: WorldPoint[] = [];
	const safe = constraints ? correctBubbleAnchor(item, bounds, visualRegion, constraints) : null;
	if (safe) addCandidate(candidates, seen, safe);

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

	if (!constraints || !safe) return candidates;
	const bestHard = hardOverlap(item, safe, constraints);
	return candidates.filter((candidate) => compareHard(hardOverlap(item, candidate, constraints), bestHard) === 0);
}

function chooseCandidate(
	item: BubblePlacementInput,
	candidates: readonly WorldPoint[],
	placed: readonly PlacedBubble[],
	gap: number,
	cellSize: number,
	constraints?: LivePlacementConstraints
): { anchor: WorldPoint; overlap: number } {
	if (constraints) {
		let anchor = candidates[0];
		let score = Infinity;
		for (const candidate of candidates) {
			const next = liveScore({ ...item, anchor: candidate }, placed, cellSize, gap);
			if (next < score) { anchor = candidate; score = next; }
		}
		return { anchor, overlap: placed.reduce((total, previous) => total + gapOverlapArea(bubbleRect(anchor, item), bubbleRect(previous.anchor, previous), gap), 0) };
	}
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
	currentAnchor: WorldPoint,
	related: readonly PlacedBubble[],
	fixed: readonly PlacedBubble[],
	bounds: Bounds,
	visualRegion: Bounds,
	cellSize: number,
	gap: number,
	constraints?: LivePlacementConstraints
): { group: PlacedBubble[]; overlap: number; score: number } | null {
	const groupItems = [...related, current];
	let best: { group: PlacedBubble[]; overlap: number; distance: number; score: number } | null = null;
	if (constraints) {
		const greedy = [...related, { ...current, anchor: currentAnchor }];
		best = { group: greedy, overlap: totalOverlap(greedy, fixed, gap), distance: totalDistance(greedy),
			score: groupLiveScore(greedy, fixed, cellSize, gap) };
	}

	const search = (index: number, assigned: PlacedBubble[]) => {
		// Adding remaining bubbles can only increase each assigned bubble's live
		// score: distance is fixed and overlap is nonnegative, even with its cap.
		// Skip branches that cannot improve the incumbent without dropping any
		// candidate or changing hard tiers, traversal order, or equal-score ties.
		if (constraints && best && groupLiveScore(assigned, fixed, cellSize, gap) > best.score) return;
		if (index === groupItems.length) {
			const overlap = totalOverlap(assigned, fixed, gap);
			const distance = totalDistance(assigned);
			const score = constraints ? groupLiveScore(assigned, fixed, cellSize, gap) : overlap;

			if (
				!best ||
				score < best.score ||
				(score === best.score && distance < best.distance)
			) {
				best = { group: assigned.map((item) => ({ ...item, anchor: { ...item.anchor } })), overlap, distance, score };
			}
			return;
		}

		const item = groupItems[index];
		const unassigned = groupItems.slice(index + 1).map((candidate) => ({ ...candidate, anchor: clampPlacementAnchor(candidate.preferred, candidate, bounds, visualRegion) }));
		const localReferences = [...assigned, ...unassigned];
		const candidates = getCandidates(item, bounds, visualRegion, cellSize, gap, localReferences, constraints);

		for (const anchor of candidates) {
			search(index + 1, [...assigned, { ...item, anchor }]);
		}
	};

	search(0, []);
	if (!best) return null;
	const repaired = best as { group: PlacedBubble[]; overlap: number; distance: number; score: number };

	return { group: repaired.group, overlap: repaired.overlap, score: repaired.score };
}

/**
 * Places bubbles in a stable order using a bounded set of candidates around
 * their preferred anchors. Live constraints first select the best hard tier,
 * then trade bounded overlap improvement against speaker distance. Trace keeps
 * its existing minimum-overlap policy. Neither policy performs global packing.
 */
export function placeBubbles(
	items: readonly BubblePlacementInput[],
	bounds: Bounds,
	cellSize: number,
	gap = BUBBLE_PLACEMENT_GAP,
	visualRegion: Bounds = bounds,
	fixedPlacements: readonly FixedBubblePlacement[] = [],
	constraints?: LivePlacementConstraints
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
		const candidates = getCandidates(item, bounds, visualRegion, cellSize, gap, placed, constraints);
		const choice = chooseCandidate(item, candidates, placed, gap, cellSize, constraints);
		let anchor = choice.anchor;

		if (choice.overlap > 0 && placed.length > 0) {
			const related = placed
				.filter((previous) => !fixedIds.has(previous.id))
				.filter((previous) => candidates.some((candidate) =>
					gapOverlapArea(bubbleRect(candidate, item), bubbleRect(previous.anchor, previous), gap) > 0
				))
				.slice(-2);
			const fixed = placed.filter((previous) => !related.includes(previous));
			const repair = findLocalRepair(item, anchor, related, fixed, bounds, visualRegion, cellSize, gap, constraints);
			const greedyGroup = [...related, { ...item, anchor }];

			if (repair && repair.score < (constraints ? groupLiveScore(greedyGroup, fixed, cellSize, gap) : totalOverlap(greedyGroup, fixed, gap))) {
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
