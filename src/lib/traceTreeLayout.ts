import { clampToBounds, type Bounds, type Size, type WorldPoint } from './geometry';

export type TraceTreeAnchor = Readonly<{ anchor: WorldPoint; footprint: Size }>;

/** The stable clockwise slot order used for every visible reply sibling set. */
export function traceChildPreferred(parent: TraceTreeAnchor, child: Size, index: number): WorldPoint {
	const ring = Math.floor(index / 4);
	const slot = index % 4;
	const gap = 10;
	const horizontal = child.width + gap;
	const vertical = child.height + gap;
	if (slot === 0) return { x: parent.anchor.x + parent.footprint.width + gap + ring * horizontal, y: parent.anchor.y + parent.footprint.height + gap + ring * vertical };
	if (slot === 1) return { x: parent.anchor.x - child.width - gap - ring * horizontal, y: parent.anchor.y + parent.footprint.height + gap + ring * vertical };
	if (slot === 2) return { x: parent.anchor.x + parent.footprint.width + gap + ring * horizontal, y: parent.anchor.y - child.height - gap - ring * vertical };
	return { x: parent.anchor.x - child.width - gap - ring * horizontal, y: parent.anchor.y - child.height - gap - ring * vertical };
}

/**
 * A fixed-placement pass can clamp several cards to the same point. Keep the
 * first collision-free result, then try deterministic outer and edge anchors.
 */
export function distinctTraceAnchor(preferred: WorldPoint, footprint: Size, bounds: Bounds, occupied: readonly WorldPoint[], rank: number): WorldPoint {
	const base = clampToBounds(preferred, footprint, bounds);
	const step = Math.max(12, Math.min(footprint.width, footprint.height) / 2);
	const ring = Math.floor(rank / 4) + 1;
	const direction = [
		{ x: 1, y: 1 }, { x: -1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: -1 }
	][rank % 4];
	const candidates = [
		base,
		clampToBounds({ x: base.x + direction.x * step * ring, y: base.y + direction.y * step * ring }, footprint, bounds),
		clampToBounds({ x: base.x + direction.x * step * (ring + 1), y: base.y + direction.y * step * (ring + 1) }, footprint, bounds),
		clampToBounds({ x: direction.x > 0 ? bounds.x + bounds.width - footprint.width : bounds.x, y: base.y }, footprint, bounds),
		clampToBounds({ x: base.x, y: direction.y > 0 ? bounds.y + bounds.height - footprint.height : bounds.y }, footprint, bounds)
	];
	return candidates.find((candidate) => !occupied.some((anchor) => Math.abs(anchor.x - candidate.x) < 1 && Math.abs(anchor.y - candidate.y) < 1)) ?? base;
}
