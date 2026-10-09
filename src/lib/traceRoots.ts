import type { Event } from 'nostr-tools/pure';
import type { FieldSize } from './geometry';
import { parseTraceEvent, parseWorldMessage, type ParsedWorldMessage } from './nostrProtocol';

export type TraceRootField = Pick<FieldSize, 'columns' | 'rows'>;

/** A semantic root paired with the raw event that must remain the cache authority. */
export type TraceRootCandidate = Readonly<{
	rawEvent: Event;
	root: ParsedWorldMessage;
}>;

const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/;

export function assertTraceRootChannelId(channelId: string): void {
	if (!NOSTR_EVENT_ID.test(channelId)) {
		throw new TypeError('Trace root channel ID must be a 64-character lowercase hexadecimal Nostr event ID.');
	}
}

export function assertTraceRootField(field: TraceRootField): void {
	if (
		!Number.isSafeInteger(field.columns) || field.columns <= 0 ||
		!Number.isSafeInteger(field.rows) || field.rows <= 0 ||
		!Number.isSafeInteger(field.columns * field.rows)
	) {
		throw new TypeError('Trace root field dimensions must be positive safe integers with a safe cell count.');
	}
}

function isWithinField(root: ParsedWorldMessage, field: TraceRootField): boolean {
	return root.position.x >= 0 && root.position.x < field.columns &&
		root.position.y >= 0 && root.position.y < field.rows;
}

function winsTraceRootLottery(eventId: string): boolean {
	return BigInt(`0x${eventId}`) % 5n === 0n;
}

function compareRoots(first: TraceRootCandidate, second: TraceRootCandidate): number {
	return second.root.createdAt - first.root.createdAt ||
		(first.root.id < second.root.id ? -1 : first.root.id > second.root.id ? 1 : 0);
}

function parseCandidate(event: Event, channelId: string, field: TraceRootField): TraceRootCandidate | null {
	try {
		const message = parseWorldMessage(event, channelId);
		const trace = parseTraceEvent(event, channelId);
		const root = message ?? trace;
		if (!root || !isWithinField(root, field) || (root.source !== 'death' && root.source !== 'manual' && !winsTraceRootLottery(root.id))) return null;
		return { rawEvent: event, root };
	} catch {
		// IndexedDB is untrusted and malformed values must never become effective roots.
		return null;
	}
}

/**
 * Applies ID dedupe and the deterministic per-cell/global root limits to already
 * semantic-valid candidates. It deliberately does not parse or verify events.
 */
export function capTraceRootCandidates(
	candidates: readonly TraceRootCandidate[],
	field: TraceRootField
): readonly TraceRootCandidate[] {
	assertTraceRootField(field);
	const unique = new Map<string, TraceRootCandidate>();
	for (const candidate of [...candidates].sort(compareRoots)) {
		if (!unique.has(candidate.root.id)) unique.set(candidate.root.id, candidate);
	}

	const perCell = new Map<string, TraceRootCandidate[]>();
	for (const candidate of unique.values()) {
		const cell = `${candidate.root.position.x}:${candidate.root.position.y}`;
		const cellCandidates = perCell.get(cell) ?? [];
		cellCandidates.push(candidate);
		perCell.set(cell, cellCandidates);
	}

	const perCellSurvivors = [...perCell.values()].map((cellCandidates) => {
		const explicit = cellCandidates.filter(({ root }) => root.source === 'manual' || root.source === 'death');
		return (explicit.length ? explicit : cellCandidates).sort(compareRoots)[0];
	});
	const cellCount = BigInt(field.columns) * BigInt(field.rows);
	const quota = Number(cellCount / 20n);
	const totalLimit = Number(cellCount * 3n / 20n);
	const selected = new Map<string, TraceRootCandidate>();
	for (const source of ['message', 'manual', 'death'] as const) {
		const reserved = perCellSurvivors.filter(({ root }) => (root.source ?? 'message') === source).sort(compareRoots).slice(0, quota);
		for (const candidate of reserved) selected.set(candidate.root.id, candidate);
	}
	for (const candidate of perCellSurvivors.sort(compareRoots)) {
		if (selected.size >= totalLimit) break;
		selected.set(candidate.root.id, candidate);
	}
	return [...selected.values()].sort(compareRoots);
}

/** Keeps only the newest candidate for each source and logical cell. */
export function selectTraceRootCandidatePool(
	rawEvents: readonly Event[],
	channelId: string,
	field: TraceRootField
): readonly TraceRootCandidate[] {
	assertTraceRootChannelId(channelId);
	assertTraceRootField(field);
	const bySourceAndCell = new Map<string, TraceRootCandidate>();
	for (const event of rawEvents) {
		const candidate = parseCandidate(event, channelId, field);
		if (!candidate) continue;
		const source = candidate.root.source ?? 'message';
		const key = `${source}:${candidate.root.position.x}:${candidate.root.position.y}`;
		const previous = bySourceAndCell.get(key);
		if (!previous || compareRoots(candidate, previous) < 0) bySourceAndCell.set(key, candidate);
	}
	return [...bySourceAndCell.values()].sort(compareRoots);
}

/**
 * Validates supported trace-root events for one world and selects its effective roots.
 * The boundary validation is intentional even when rawEvents is empty.
 */
function selectTraceRootCandidates(
	rawEvents: readonly Event[],
	channelId: string,
	field: TraceRootField
): readonly TraceRootCandidate[] {
	assertTraceRootChannelId(channelId);
	assertTraceRootField(field);
	return capTraceRootCandidates(selectTraceRootCandidatePool(rawEvents, channelId, field), field);
}

/** Public parsed snapshot for callers that do not need raw persistence records. */
export function selectEffectiveTraceRoots(
	rawEvents: readonly Event[],
	channelId: string,
	field: TraceRootField
): readonly ParsedWorldMessage[] {
	return selectTraceRootCandidates(rawEvents, channelId, field).map((candidate) => candidate.root);
}
