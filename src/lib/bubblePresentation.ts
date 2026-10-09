import type { SpeechType } from './conversation';
import type { Bounds, Size, WorldPoint } from './geometry';
import { createSpeechBubbleShape, type SpeechBubbleShape } from './speechBubblePath';

export type BubbleTone = 'coral' | 'lavender' | 'mint' | 'yellow' | 'sky' | 'peach' | 'rose' | 'blue';

export const BUBBLE_TONES: readonly BubbleTone[] = ['coral', 'lavender', 'mint', 'yellow', 'sky', 'peach', 'rose', 'blue'];
export const NORMAL_TRACE_ROOT_RADIUS = 18;

const TONE_VALUES: Readonly<Record<BubbleTone, Readonly<{ background: string; outline: string }>>> = {

	coral: { background: 'hsl(12, 53%, 96%)', outline: 'hsl(12, 96%, 52%)' },
	lavender: { background: 'hsl(250, 53%, 96%)', outline: 'hsl(250, 96%, 52%)' },
	mint: { background: 'hsl(145, 43%, 96%)', outline: 'hsl(145, 90%, 42%)' },
	yellow: { background: 'hsl(48, 53%, 96%)', outline: 'hsl(48, 96%, 48%)' },
	sky: { background: 'hsl(188, 43%, 96%)', outline: 'hsl(188, 99%, 46%)' },
	peach: { background: 'hsl(28, 53%, 96%)', outline: 'hsl(28, 96%, 52%)' },
	rose: { background: 'hsl(340, 53%, 96%)', outline: 'hsl(340, 96%, 52%)' },
	blue: { background: 'hsl(210, 53%, 96%)', outline: 'hsl(210, 96%, 52%)' }
};

/** Keep the current Trace surface expression in one presentation token. */
const TRACE_SURFACE_OPACITY = '70%';

export function bubbleToneStyle(tone: BubbleTone, trace = false): string {
	const value = TONE_VALUES[tone];
	return [
		`--tone-background: ${value.background}`,
		`--tone-outline: ${value.outline}`,
		...(trace ? [`--trace-surface: color-mix(in srgb, var(--tone-background) ${TRACE_SURFACE_OPACITY}, transparent)`] : [])
	].join('; ');
}

export function traceTone(pubkey: string): BubbleTone {
	const prefix = Number.parseInt(pubkey.slice(0, 2), 16);
	return BUBBLE_TONES[(Number.isFinite(prefix) ? prefix : 0) % BUBBLE_TONES.length];
}

export function createPresentationBubbleShape(
	speechType: SpeechType,
	bubbleId: string,
	size: Size,
	viewportWidth: number,
	safeBounds: Bounds
): SpeechBubbleShape | null {
	const constraints = speechType === 'shout' ? undefined : {
		maxBleedX: Math.max(0, (viewportWidth - size.width) / 2),
		maxBleedY: Math.max(0, (safeBounds.height - size.height) / 2)
	};
	return createSpeechBubbleShape(speechType, size.width, size.height, `${bubbleId}${speechType}`, constraints);
}

export function bubbleSurfaceStyle(shape: SpeechBubbleShape): string {
	return `inset: auto; left: ${shape.bounds.x - 1}px; top: ${shape.bounds.y - 1}px; width: ${shape.bounds.width}px; height: ${shape.bounds.height}px;`;
}

export function bubbleCenter(anchor: WorldPoint, size: Size): WorldPoint {
	return { x: anchor.x + size.width / 2, y: anchor.y + size.height / 2 };
}

export type TaperedBandGeometry = Readonly<{
	startLeft: WorldPoint;
	startRight: WorldPoint;
	endLeft: WorldPoint;
	endRight: WorldPoint;
	points: string;
}>;

/**
 * The shared directional primitive for tails and Trace relations.  Keep it
 * independent of any bubble-specific overlap, masking, or seam behavior.
 */
export function taperedBandGeometry(
	start: WorldPoint,
	end: WorldPoint,
	startWidth: number,
	endWidth: number
): TaperedBandGeometry {
	const dx = end.x - start.x;
	const dy = end.y - start.y;
	const length = Math.hypot(dx, dy) || 1;
	const ux = dx / length;
	const uy = dy / length;
	const edge = (center: WorldPoint, width: number, side: 1 | -1): WorldPoint => ({
		x: center.x - uy * (width / 2) * side,
		y: center.y + ux * (width / 2) * side
	});
	const startLeft = edge(start, startWidth, 1);
	const startRight = edge(start, startWidth, -1);
	const endLeft = edge(end, endWidth, 1);
	const endRight = edge(end, endWidth, -1);
	return {
		startLeft,
		startRight,
		endLeft,
		endRight,
		points: `${startLeft.x},${startLeft.y} ${startRight.x},${startRight.y} ${endRight.x},${endRight.y} ${endLeft.x},${endLeft.y}`
	};
}

function mergedTailFraction(index: number, count: number): number {
	if (count <= 1) return 0.5;
	const edgeInset = count === 2 ? 0.28 : count === 3 ? 0.22 : 0.18;
	return edgeInset + (1 - edgeInset * 2) * (index / (count - 1));
}

export function mergedBubbleStyle(memberCount: number): string {
	const level = Math.min(Math.max(memberCount, 2), 4) - 2;
	return [
		`--merged-bubble-min-width: ${100 + level * 20}px`,
		`--merged-bubble-max-width: ${330 + level * 15}px`,
		`--merged-bubble-padding-y: ${14 + level}px`,
		`--merged-bubble-padding-x: ${20 + level * 2}px`,
		`--merged-bubble-font-size: ${22 + level}px`,
		`--merged-bubble-mobile-min-width: ${72 + level * 16}px`,
		`--merged-bubble-mobile-max-width: ${220 + level * 12}px`,
		`--merged-bubble-mobile-padding-y: ${9 + level}px`,
		`--merged-bubble-mobile-padding-x: ${12 + level * 2}px`,
		`--merged-bubble-mobile-font-size: ${15 + level}px`
	].join('; ');
}

export function tailGeometry(start: WorldPoint, target: WorldPoint, width = 11, overlap = 2, bodyExtension = 0) {
	const dx = target.x - start.x;
	const dy = target.y - start.y;
	const length = Math.hypot(dx, dy) || 1;
	const ux = dx / length;
	const uy = dy / length;
	const baseCenter = { x: start.x - ux * overlap, y: start.y - uy * overlap };
	const band = taperedBandGeometry(baseCenter, target, width, 0);
	const extendIntoBody = (point: WorldPoint): WorldPoint => ({
		x: point.x + (point.x - target.x) / length * bodyExtension,
		y: point.y + (point.y - target.y) / length * bodyExtension
	});
	const rootLeft = extendIntoBody(band.startLeft);
	const rootRight = extendIntoBody(band.startRight);
	const seamProgress = Math.min(1, Math.max(0, (start.y - baseCenter.y) / (target.y - baseCenter.y || 1)));
	const seamCenterX = baseCenter.x + (target.x - baseCenter.x) * seamProgress;
	return {
		points: `${rootLeft.x},${rootLeft.y} ${rootRight.x},${rootRight.y} ${target.x},${target.y}`,
		outlinePath: `M ${rootLeft.x} ${rootLeft.y} L ${target.x} ${target.y} L ${rootRight.x} ${rootRight.y}`,
		rootLeft,
		rootRight,
		target,
		seamOffsetX: seamCenterX - start.x
	};
}

export type BubbleTailConnection = Readonly<{
	participantId: string;
	edge: 'top' | 'right' | 'bottom' | 'left';
	seam: WorldPoint;
	tail: ReturnType<typeof tailGeometry>;
}>;

function facingEdge(size: Size, dx: number, dy: number): BubbleTailConnection['edge'] {
	return Math.abs(dx) / size.width > Math.abs(dy) / size.height
		? dx > 0 ? 'right' : 'left' : dy > 0 ? 'bottom' : 'top';
}

/** Prefer the separating axis when footprints overlap on the other axis. */
function connectionEdges(anchor: WorldPoint, size: Size, source: Bounds) {
	const center = bubbleCenter(anchor, size), target = bubbleCenter(source, source);
	const dx = target.x - center.x, dy = target.y - center.y;
	const overlapsX = anchor.x < source.x + source.width && anchor.x + size.width > source.x;
	const overlapsY = anchor.y < source.y + source.height && anchor.y + size.height > source.y;
	if (overlapsX && anchor.y + size.height <= source.y) return { edge: 'bottom', sourceEdge: 'top' } as const;
	if (overlapsX && anchor.y >= source.y + source.height) return { edge: 'top', sourceEdge: 'bottom' } as const;
	if (overlapsY && anchor.x + size.width <= source.x) return { edge: 'right', sourceEdge: 'left' } as const;
	if (overlapsY && anchor.x >= source.x + source.width) return { edge: 'left', sourceEdge: 'right' } as const;
	const edge = facingEdge(size, dx, dy);
	const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
	return { edge, sourceEdge: opposite[edge] };
}

function edgePoint(bounds: Bounds, edge: BubbleTailConnection['edge'], fraction: number, clearance = 0): WorldPoint {
	if (edge === 'top' || edge === 'bottom') return { x: bounds.x + bounds.width * fraction, y: edge === 'top' ? bounds.y - clearance : bounds.y + bounds.height + clearance };
	return { x: edge === 'left' ? bounds.x - clearance : bounds.x + bounds.width + clearance, y: bounds.y + bounds.height * fraction };
}

/** Shared body/source facing geometry; seam distribution remains a caller policy. */
export function bubbleSourceTailConnection(anchor: WorldPoint, size: Size, source: Bounds, speechType: SpeechType, id: string, fraction = 0.5, width = 11, sourceClearance = 0): BubbleTailConnection {
	const { edge, sourceEdge } = connectionEdges(anchor, size, source);
	const start = edgePoint({ ...anchor, ...size }, edge, fraction);
	// Short gaps must not put the source endpoint back inside the bubble.
	const gap = sourceEdge === 'top' ? source.y - anchor.y - size.height
		: sourceEdge === 'bottom' ? anchor.y - source.y - source.height
		: sourceEdge === 'left' ? source.x - anchor.x - size.width : anchor.x - source.x - source.width;
	const target = edgePoint(source, sourceEdge, 0.5, Math.min(sourceClearance, Math.max(0, gap) / 2));
	const tail = tailGeometry(start, target, width, 2, specialTailExtension(speechType));
	const base = { x: (tail.rootLeft.x + tail.rootRight.x) / 2, y: (tail.rootLeft.y + tail.rootRight.y) / 2 };
	const horizontal = edge === 'top' || edge === 'bottom';
	const progress = horizontal ? (start.y - base.y) / (target.y - base.y || 1) : (start.x - base.x) / (target.x - base.x || 1);
	return { participantId: id, edge, seam: { x: base.x + (target.x - base.x) * progress - anchor.x, y: base.y + (target.y - base.y) * progress - anchor.y }, tail };
}

/** Select and distribute merged seams without changing placement policy. */
export function liveTailConnections(anchor: WorldPoint, size: Size, members: readonly Readonly<{ id: string; bounds: Bounds }>[], speechType: SpeechType, merged: boolean): BubbleTailConnection[] {
	const facing = members.map((member) => ({ ...member, edge: connectionEdges(anchor, size, member.bounds).edge }));
	return facing.map((member) => {
		const peers = facing.filter((candidate) => candidate.edge === member.edge);
		const fraction = merged ? mergedTailFraction(peers.indexOf(member), peers.length) : 0.5;
		return bubbleSourceTailConnection(anchor, size, member.bounds, speechType, member.id, fraction, merged ? 9 : 11, 4);
	});
}

export function liveTailSeamStyle(connection: BubbleTailConnection, merged: boolean): string {
	const horizontal = connection.edge === 'top' || connection.edge === 'bottom';
	return `--tail-seam-x: ${connection.seam.x}px; --tail-seam-y: ${connection.seam.y}px; --tail-seam-width: ${horizontal ? merged ? 9 : 11 : 3}px; --tail-seam-height: ${horizontal ? 3 : merged ? 9 : 11}px;`;
}

function specialTailExtension(speechType: SpeechType): number {
	return speechType === 'normal' ? 0 : 26;
}

export function tailOutlineOpeningPoints(tail: ReturnType<typeof tailGeometry>, anchor: WorldPoint): string {
	return [tail.rootLeft, tail.rootRight, tail.target]
		.map((point) => ({ x: point.x - anchor.x, y: point.y - anchor.y }))
		.map((point) => `${point.x},${point.y}`)
		.join(' ');
}

function safeSvgId(bubbleId: string): string {
	return bubbleId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function speechOutlineMaskId(bubbleId: string): string { return `speech-tail-opening-${safeSvgId(bubbleId)}`; }
export function traceSurfaceOcclusionMaskId(rootId: string): string { return `trace-surface-occlusion-${safeSvgId(rootId)}`; }
export function liveSurfaceOcclusionMaskId(): string { return 'live-surface-occlusion'; }
