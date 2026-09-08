import type { WorldPoint } from './geometry';

const TRACE_RELATION_ENDPOINT_INSET = 10;

export type TraceRelationEndpoints = Readonly<{ start: WorldPoint; end: WorldPoint }>;

export function traceRelationEndpoints(parentCenter: WorldPoint, childCenter: WorldPoint): TraceRelationEndpoints {
	const dx = childCenter.x - parentCenter.x;
	const dy = childCenter.y - parentCenter.y;
	const distance = Math.hypot(dx, dy);
	if (distance === 0) return { start: parentCenter, end: childCenter };
	const inset = Math.min(TRACE_RELATION_ENDPOINT_INSET, Math.max(0, distance / 2 - 0.001));
	const direction = { x: dx / distance, y: dy / distance };
	return {
		start: { x: parentCenter.x + direction.x * inset, y: parentCenter.y + direction.y * inset },
		end: { x: childCenter.x - direction.x * inset, y: childCenter.y - direction.y * inset }
	};
}
