import type { Character } from './character';
import type { SpeechType } from './conversation';
import {
	clampToBounds,
	sourceAboveBubblePreferredAnchor,
	BUBBLE_PLACEMENT_GAP,
	correctBubbleAnchor,
	gridToWorld,
	placeBubblesWithFixed,
	type Bounds,
	type FixedBubblePlacement,
	type Size,
	type WorldPoint,
	type GridPosition,
	type BubblePlacementInput
} from './geometry';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationProjection } from './traceReplyPresentation';
import { distinctTraceAnchor, traceChildPreferred } from './traceTreeLayout';
import {
	createPresentationBubbleShape,
	type BubbleTone
} from './bubblePresentation';
import type { SpeechBubbleShape } from './speechBubblePath';

export type TraceCardRole = 'parent' | 'current' | 'child';

export type TraceRootPresentation = Readonly<{
	id: string;
	event: ParsedWorldMessage;
	anchor: WorldPoint;
	size: Size;
	footprint: Size;
	shape: SpeechBubbleShape | null;
	tone: BubbleTone;
	character: Character;
	compact: boolean;
}>;

export type TraceReplyPresentation = Readonly<{
	id: string;
	reply: ParsedTraceReply;
	role: TraceCardRole;
	anchor: WorldPoint;
	size: Size;
	footprint: Size;
	shape: SpeechBubbleShape | null;
	tone: BubbleTone;
	character: Character;
	hasContinuation: boolean;
}>;

export type TraceBubblePresentationLayout = Readonly<{
	root: TraceRootPresentation;
	cards: readonly TraceReplyPresentation[];
	context: string;
	replyContext: string;
	rootPreferred: WorldPoint;
	fixedContext: string;
}>;

export type TraceBubblePresentationInput = Readonly<{
	projection: TraceConversationProjection | null;
	fixedBubbles: readonly Readonly<{ id: string; anchor: WorldPoint; size: Size; speechType: SpeechType; shape: SpeechBubbleShape | null }>[];
	fixedObstacles: readonly FixedBubblePlacement[];
	bubbleSizes: Readonly<Record<string, Size>>;
	traceReplyCardFootprints: Readonly<Record<string, Size>>;
	traceSafeBounds: Bounds;
	traceVisualRegion: Bounds;
	cellSize: number;
	camera: WorldPoint;
	fieldAreaBounds: Bounds;
	rootSourceBounds: Bounds;
	fieldRows: number;
	viewportWidth: number;
	defaultBubbleSize: Size;
	characterFor: (pubkey: string) => Character;
	toneFor: (pubkey: string) => BubbleTone;
	previousLayout?: TraceBubblePresentationLayout | null;
}>;

/** The same footprint drives ghost rendering, root placement, and facing tails. */
export function traceRootGhostGeometry(position: GridPosition, cellSize: number, occupied: boolean) {
	const center = gridToWorld(position, cellSize);
	return {
		world: { x: center.x - (occupied ? cellSize * 0.29 : 0), y: center.y + (occupied ? cellSize * 0.27 : 0) },
		size: { width: cellSize * (occupied ? 0.58 : 1), height: cellSize * (occupied ? 0.58 : 1) },
		compact: occupied
	};
}

function placeTraceRoot(item: BubblePlacementInput, source: Bounds, fixed: readonly FixedBubblePlacement[], bounds: Bounds, visualRegion: Bounds): WorldPoint {
	const uiObstacles = fixed.map((obstacle) => {
		const footprint = obstacle.visualBounds ?? { x: 0, y: 0, ...obstacle.size };
		return { x: obstacle.anchor.x + footprint.x - BUBBLE_PLACEMENT_GAP, y: obstacle.anchor.y + footprint.y - BUBBLE_PLACEMENT_GAP,
			width: footprint.width + BUBBLE_PLACEMENT_GAP * 2, height: footprint.height + BUBBLE_PLACEMENT_GAP * 2 };
	});
	const constraints = { uiObstacles, characterObstacles: [source] };
	const visual = item.visualBounds ?? { x: 0, y: 0, ...item.size };
	const valid = (anchor: WorldPoint) => {
		const rect = { x: anchor.x + visual.x, y: anchor.y + visual.y, width: visual.width, height: visual.height };
		return [...uiObstacles, source].every((other) => rect.x >= other.x + other.width || rect.x + rect.width <= other.x || rect.y >= other.y + other.height || rect.y + rect.height <= other.y);
	};
	// Shorten the connection before abandoning the space above the source.
	const above = { ...bounds, height: Math.min(bounds.y + bounds.height, source.y) - bounds.y };
	const minimumY = Math.max(above.y, visualRegion.y - visual.y);
	const maximumY = Math.min(above.y + above.height - item.size.height, visualRegion.y + visualRegion.height - visual.y - visual.height);
	if (minimumY <= maximumY) {
		const anchor = correctBubbleAnchor(item, above, visualRegion, constraints);
		if (valid(anchor)) return anchor;
	}
	return correctBubbleAnchor(item, bounds, visualRegion, constraints);
}

function defaultTraceReplyCardFootprint(surface: Size): Size { return surface; }

function tracePresentationContext(input: TraceBubblePresentationInput): string {
	return JSON.stringify({
		root: { id: input.projection?.root.id ?? null, position: input.projection?.root.position ?? null },
		camera: input.camera,
		cellSize: input.cellSize,
		fieldAreaBounds: input.fieldAreaBounds,
		traceSafeBounds: input.traceSafeBounds,
		traceVisualRegion: input.traceVisualRegion,
		rootSourceBounds: input.rootSourceBounds,
		fixedObstacles: input.fixedObstacles,
		viewportWidth: input.viewportWidth
	});
}

function traceReplyContinuityContext(input: TraceBubblePresentationInput): string {
	return JSON.stringify({
		root: { id: input.projection?.root.id ?? null, position: input.projection?.root.position ?? null },
		camera: input.camera,
		cellSize: input.cellSize,
		fieldAreaBounds: input.fieldAreaBounds,
		fieldRows: input.fieldRows,
		viewportWidth: input.viewportWidth
	});
}

function traceFixedContext(input: TraceBubblePresentationInput): string {
	return JSON.stringify([
		...input.fixedBubbles.map((bubble) => ({
			id: bubble.id,
			anchor: bubble.anchor,
			size: bubble.size,
			speechType: bubble.speechType,
			visualBounds: bubble.shape?.bounds ?? null
		})),
		...input.fixedObstacles.map((obstacle) => ({ id: obstacle.id, anchor: obstacle.anchor, size: obstacle.size, visualBounds: obstacle.visualBounds ?? null }))
	]
		.sort((first, second) => first.id.localeCompare(second.id)));
}

function sameSize(first: Size, second: Size): boolean {
	return first.width === second.width && first.height === second.height;
}

function samePoint(first: WorldPoint, second: WorldPoint): boolean {
	return Math.abs(first.x - second.x) < 0.5 && Math.abs(first.y - second.y) < 0.5;
}

function continuityAnchor(
	previous: TraceBubblePresentationLayout | null | undefined,
	eventId: string,
	size: Size,
	footprint: Size,
	bounds: Bounds
): WorldPoint | null {
	if (!previous) return null;
	const previousNode = previous.root.event.id === eventId
		? previous.root
		: previous.cards.find((card) => card.reply.id === eventId);
	if (!previousNode || !sameSize(previousNode.size, size) || !sameSize(previousNode.footprint, footprint)) return null;
	const clamped = clampToBounds(previousNode.anchor, footprint, bounds);
	return clamped.x === previousNode.anchor.x && clamped.y === previousNode.anchor.y ? previousNode.anchor : null;
}

export function layoutTraceBubblePresentation(input: TraceBubblePresentationInput): TraceBubblePresentationLayout | null {
	const { projection } = input;
	if (!projection) return null;
	const context = tracePresentationContext(input);
	const replyContext = traceReplyContinuityContext(input);
	const fixedContext = traceFixedContext(input);
	const rootContinuityLayout = input.previousLayout?.context === context ? input.previousLayout : null;
	const fixed = [
		...input.fixedBubbles.map((bubble) => ({
		id: bubble.id, preferred: bubble.anchor, anchor: bubble.anchor, size: bubble.size,
		visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
		})),
		...input.fixedObstacles
	];
	const rootId = `trace-root-${projection.root.id}`;
	const rootSize = input.bubbleSizes[rootId] ?? input.defaultBubbleSize;
	const rootShape = createPresentationBubbleShape(projection.root.speechType, rootId, rootSize, input.viewportWidth, input.traceSafeBounds);
	const rootPreferred = sourceAboveBubblePreferredAnchor(input.rootSourceBounds, rootSize);
	const previousRoot = input.previousLayout?.root.event.id === projection.root.id ? input.previousLayout : null;
	const replyContinuityLayout = input.previousLayout &&
		(input.previousLayout.replyContext === replyContext || (previousRoot && samePoint(previousRoot.rootPreferred, rootPreferred)))
		? input.previousLayout : null;
	const rootContinuity = continuityAnchor(rootContinuityLayout, projection.root.id, rootSize, rootSize, input.traceSafeBounds);
	const visibleReplyIds = new Set([
		...(projection.current.kind === 'reply' ? [projection.current.event.id] : []),
		...(projection.parent?.kind === 'reply' ? [projection.parent.event.id] : []),
		...projection.directReplies.map((reply) => reply.id)
	]);
	// Root compaction must not push a reply out of its preserved local-tree anchor.
	const preservedReplies = input.previousLayout?.fixedContext === fixedContext
		? (replyContinuityLayout?.cards ?? []).flatMap((card) => {
			const size = input.bubbleSizes[card.id] ?? input.defaultBubbleSize;
			const footprint = input.traceReplyCardFootprints[card.id] ?? defaultTraceReplyCardFootprint(size);
			const anchor = visibleReplyIds.has(card.reply.id) ? continuityAnchor(replyContinuityLayout, card.reply.id, size, footprint, input.traceSafeBounds) : null;
			return anchor ? [{ id: card.id, preferred: anchor, anchor, size: footprint }] : [];
		}) : [];
	const rootAnchor = placeTraceRoot({
		id: rootId, preferred: rootContinuity ?? rootPreferred, size: rootSize,
		visualBounds: projection.root.speechType === 'shout' ? undefined : rootShape?.bounds
	}, input.rootSourceBounds, [...fixed, ...preservedReplies], input.traceSafeBounds, input.traceVisualRegion);
	const root: TraceRootPresentation = {
		id: rootId, event: projection.root, anchor: rootAnchor, size: rootSize,
		footprint: rootSize, shape: rootShape, tone: input.toneFor(projection.root.pubkey),
		character: input.characterFor(projection.root.pubkey),
		compact: projection.current.kind === 'reply' && projection.parent?.kind === 'reply'
	};
	const placed = [...fixed, { id: root.id, preferred: root.anchor, anchor: root.anchor, size: root.footprint }];
	const cards: TraceReplyPresentation[] = [];
	const placeCard = (reply: ParsedTraceReply, role: TraceCardRole, preferred: WorldPoint): TraceReplyPresentation => {
		const id = `trace-reply-${reply.id}`;
		const size = input.bubbleSizes[id] ?? input.defaultBubbleSize;
		const card: TraceReplyPresentation = {
			id, reply, role, anchor: preferred, size,
			footprint: input.traceReplyCardFootprints[id] ?? defaultTraceReplyCardFootprint(size),
			shape: createPresentationBubbleShape(reply.speechType, id, size, input.viewportWidth, input.traceSafeBounds),
			character: input.characterFor(reply.pubkey), tone: input.toneFor(reply.pubkey),
			hasContinuation: projection.continuationReplyIds.includes(reply.id)
		};
		const preserved = continuityAnchor(replyContinuityLayout, reply.id, card.size, card.footprint, input.traceSafeBounds);
		const preservePlacement = Boolean(preserved && input.previousLayout?.fixedContext === fixedContext &&
			samePoint(input.previousLayout.root.anchor, root.anchor));
		const [placement] = preservePlacement
			? [{ id: card.id, anchor: preserved! }]
			: placeBubblesWithFixed([{ id: card.id, preferred: preserved ?? preferred, size: card.footprint }], placed,
				input.traceSafeBounds, input.cellSize, undefined, input.traceVisualRegion);
		const anchored = {
			...card,
			anchor: distinctTraceAnchor(placement?.anchor ?? preferred, card.footprint, input.traceSafeBounds,
				placed.map((candidate) => candidate.anchor), cards.length)
		};
		cards.push(anchored);
		placed.push({ id: anchored.id, preferred: anchored.anchor, anchor: anchored.anchor, size: anchored.footprint });
		return anchored;
	};
	let currentAnchor: Readonly<{ anchor: WorldPoint; footprint: Size }> = root;
	if (projection.current.kind === 'reply') {
		if (projection.parent?.kind === 'root') {
			currentAnchor = placeCard(projection.current.event, 'current', traceChildPreferred(root, defaultTraceReplyCardFootprint(
				input.bubbleSizes[`trace-reply-${projection.current.event.id}`] ?? input.defaultBubbleSize), 0));
		} else if (projection.parent?.kind === 'reply') {
			const parent = projection.parent.event;
			const parentBody = input.bubbleSizes[`trace-reply-${parent.id}`] ?? input.defaultBubbleSize;
			const parentFootprint = input.traceReplyCardFootprints[`trace-reply-${parent.id}`] ?? defaultTraceReplyCardFootprint(parentBody);
			const parentPreferred = {
				x: input.traceSafeBounds.x + Math.max(0, (input.traceSafeBounds.width - parentFootprint.width) / 2),
				y: input.traceSafeBounds.y + Math.max(0, (input.traceSafeBounds.height - parentFootprint.height) / 2)
			};
			const parentCard = placeCard(parent, 'parent', parentPreferred);
			currentAnchor = placeCard(projection.current.event, 'current', traceChildPreferred(parentCard, defaultTraceReplyCardFootprint(
				input.bubbleSizes[`trace-reply-${projection.current.event.id}`] ?? input.defaultBubbleSize), 0));
		}
	}
	for (const [index, reply] of projection.directReplies.entries()) {
		placeCard(reply, 'child', traceChildPreferred(currentAnchor, defaultTraceReplyCardFootprint(
			input.bubbleSizes[`trace-reply-${reply.id}`] ?? input.defaultBubbleSize), index));
	}
	return { root, cards, context, replyContext, rootPreferred, fixedContext };
}

export function isTracePresentationMeasured(
	fieldGeometryReady: boolean,
	layout: TraceBubblePresentationLayout | null,
	sizes: Readonly<Record<string, Size>>,
	footprints: Readonly<Record<string, Size>>
): boolean {
	return Boolean(fieldGeometryReady && layout && sizes[layout.root.id] && layout.cards.every((card) => sizes[card.id] && footprints[card.id]));
}
