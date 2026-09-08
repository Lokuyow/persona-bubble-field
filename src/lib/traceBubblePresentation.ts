import type { Character } from './character';
import type { SpeechType } from './conversation';
import {
	clampToBounds,
	fieldLocalToViewport,
	gridToWorld,
	normalBubblePreferredAnchor,
	placeBubblesWithFixed,
	type Bounds,
	type Size,
	type WorldPoint,
	worldToScreen
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
	bubbleSizes: Readonly<Record<string, Size>>;
	traceReplyCardFootprints: Readonly<Record<string, Size>>;
	bubbleSafeBounds: Bounds;
	bubbleVisualRegion: Bounds;
	cellSize: number;
	camera: WorldPoint;
	fieldAreaBounds: Bounds;
	fieldRows: number;
	viewportWidth: number;
	defaultBubbleSize: Size;
	characterFor: (pubkey: string) => Character;
	toneFor: (pubkey: string) => BubbleTone;
	previousLayout?: TraceBubblePresentationLayout | null;
}>;

function defaultTraceReplyCardFootprint(surface: Size): Size { return surface; }

function tracePresentationContext(input: TraceBubblePresentationInput): string {
	return JSON.stringify({
		root: { id: input.projection?.root.id ?? null, position: input.projection?.root.position ?? null },
		camera: input.camera,
		cellSize: input.cellSize,
		fieldAreaBounds: input.fieldAreaBounds,
		bubbleSafeBounds: input.bubbleSafeBounds,
		bubbleVisualRegion: input.bubbleVisualRegion,
		fieldRows: input.fieldRows,
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
	return JSON.stringify([...input.fixedBubbles]
		.map((bubble) => ({
			id: bubble.id,
			anchor: bubble.anchor,
			size: bubble.size,
			speechType: bubble.speechType,
			visualBounds: bubble.shape?.bounds ?? null
		}))
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
	const fixed = input.fixedBubbles.map((bubble) => ({
		id: bubble.id, preferred: bubble.anchor, anchor: bubble.anchor, size: bubble.size,
		visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
	}));
	const rootId = `trace-root-${projection.root.id}`;
	const rootSize = input.bubbleSizes[rootId] ?? input.defaultBubbleSize;
	const rootShape = createPresentationBubbleShape(projection.root.speechType, rootId, rootSize, input.viewportWidth, input.bubbleSafeBounds);
	const rootScreen = fieldLocalToViewport(
		worldToScreen(gridToWorld(projection.root.position, input.cellSize), input.camera), input.fieldAreaBounds
	);
	const rootPreferred = clampToBounds(normalBubblePreferredAnchor(
		rootScreen.x, projection.root.position.y, input.fieldRows, rootSize, input.bubbleSafeBounds
	), rootSize, input.bubbleSafeBounds);
	const previousRoot = input.previousLayout?.root.event.id === projection.root.id ? input.previousLayout : null;
	const replyContinuityLayout = input.previousLayout &&
		(input.previousLayout.replyContext === replyContext || (previousRoot && samePoint(previousRoot.rootPreferred, rootPreferred)))
		? input.previousLayout : null;
	const rootContinuity = continuityAnchor(rootContinuityLayout, projection.root.id, rootSize, rootSize, input.bubbleSafeBounds);
	const [rootPlacement] = placeBubblesWithFixed([{
		id: rootId, preferred: rootContinuity ?? rootPreferred, size: rootSize,
		visualBounds: projection.root.speechType === 'shout' ? undefined : rootShape?.bounds
	}], fixed, input.bubbleSafeBounds, input.cellSize, undefined, input.bubbleVisualRegion);
	const root: TraceRootPresentation = {
		id: rootId, event: projection.root, anchor: rootPlacement?.anchor ?? rootPreferred, size: rootSize,
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
			shape: createPresentationBubbleShape(reply.speechType, id, size, input.viewportWidth, input.bubbleSafeBounds),
			character: input.characterFor(reply.pubkey), tone: input.toneFor(reply.pubkey),
			hasContinuation: projection.continuationReplyIds.includes(reply.id)
		};
		const preserved = continuityAnchor(replyContinuityLayout, reply.id, card.size, card.footprint, input.bubbleSafeBounds);
		const preservePlacement = Boolean(preserved && input.previousLayout?.fixedContext === fixedContext &&
			samePoint(input.previousLayout.root.anchor, root.anchor));
		const [placement] = preservePlacement
			? [{ id: card.id, anchor: preserved! }]
			: placeBubblesWithFixed([{ id: card.id, preferred: preserved ?? preferred, size: card.footprint }], placed,
				input.bubbleSafeBounds, input.cellSize, undefined, input.bubbleVisualRegion);
		const anchored = {
			...card,
			anchor: distinctTraceAnchor(placement?.anchor ?? preferred, card.footprint, input.bubbleSafeBounds,
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
				x: input.bubbleSafeBounds.x + Math.max(0, (input.bubbleSafeBounds.width - parentFootprint.width) / 2),
				y: input.bubbleSafeBounds.y + Math.max(0, (input.bubbleSafeBounds.height - parentFootprint.height) / 2)
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
