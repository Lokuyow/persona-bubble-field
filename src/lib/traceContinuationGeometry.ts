import type { Size, WorldPoint } from './geometry';
import { bubbleCenter } from './bubblePresentation';
import type { SpeechBubbleShape } from './speechBubblePath';

const TRACE_CONTINUATION_VISIBLE_LENGTH = 28;
const TRACE_CONTINUATION_INSET = 10;

export type ContinuationBubble = Readonly<{ anchor: WorldPoint; size: Size; shape: SpeechBubbleShape | null }>;

/** Start inside the source bubble; the shared Trace mask reveals only its outward portion. */
export function continuationBranchGeometry(bubble: ContinuationBubble) {
	const bounds = bubble.shape?.bounds ?? { x: 0, y: 0, width: bubble.size.width, height: bubble.size.height };
	const direction = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
	const center = bubbleCenter(bubble.anchor, bubble.size);
	const start = { x: center.x + direction.x * TRACE_CONTINUATION_INSET, y: center.y + direction.y * TRACE_CONTINUATION_INSET };
	const boundsRight = bubble.anchor.x + bounds.x + bounds.width;
	const boundsBottom = bubble.anchor.y + bounds.y + bounds.height;
	const distanceToSurface = Math.min((boundsRight - center.x) / direction.x, (boundsBottom - center.y) / direction.y);
	const endDistance = distanceToSurface + TRACE_CONTINUATION_VISIBLE_LENGTH;
	const end = { x: center.x + direction.x * endDistance, y: center.y + direction.y * endDistance };
	return { start, end };
}
