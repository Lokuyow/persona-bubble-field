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
export const TRACE_SURFACE_OPACITY = '70%';

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

export function tailStart(anchor: WorldPoint, size: Size): WorldPoint {
	return { x: anchor.x + size.width / 2, y: anchor.y + size.height };
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

export function mergedTailFraction(index: number, count: number): number {
	if (count <= 1) return 0.5;
	const edgeInset = count === 2 ? 0.28 : count === 3 ? 0.22 : 0.18;
	return edgeInset + (1 - edgeInset * 2) * (index / (count - 1));
}

export function mergedTailStart(anchor: WorldPoint, size: Size, index: number, count: number): WorldPoint {
	return { x: anchor.x + size.width * mergedTailFraction(index, count), y: anchor.y + size.height };
}

export function mergedTailConnectionStyle(index: number, count: number): string {
	return `left: ${mergedTailFraction(index, count) * 100}%;`;
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

export function specialTailExtension(speechType: SpeechType): number {
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
