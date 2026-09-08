import type { WorldPoint } from '../geometry';

export function advanceMergedAnchorHistory(
	previous: Readonly<Record<string, WorldPoint>>,
	activeMergedIds: ReadonlySet<string>,
	currentPlacedAnchors: ReadonlyMap<string, WorldPoint>
): Readonly<Record<string, WorldPoint>> {
	const next = { ...previous };
	let changed = false;
	for (const id of Object.keys(next)) {
		if (!activeMergedIds.has(id)) {
			delete next[id];
			changed = true;
		}
	}
	for (const [id, anchor] of currentPlacedAnchors) {
		if (!activeMergedIds.has(id)) continue;
		const old = next[id];
		if (!old || old.x !== anchor.x || old.y !== anchor.y) {
			next[id] = anchor;
			changed = true;
		}
	}
	return changed ? next : previous;
}
