import type { Event } from 'nostr-tools/pure';
import {
	parseTraceReplyCandidate,
	validateTraceReplyCandidate,
	type ParsedTraceReply,
	type ParsedTraceReplyCandidate,
	type ParsedWorldMessage
} from './nostrProtocol';

export type TraceReplyEventCandidate = Readonly<{
	rawEvent: Event;
	candidate: ParsedTraceReplyCandidate;
}>;

export type AcceptedTraceReplyEvent = Readonly<{
	rawEvent: Event;
	reply: ParsedTraceReply;
}>;

export type ResolveTraceReplyBatchInput = Readonly<{
	effectiveRoots: readonly ParsedWorldMessage[];
	rawEvents: readonly Event[];
}>;

export type ResolveLiveTraceReplyInput = Readonly<{
	effectiveRoots: readonly ParsedWorldMessage[];
	acceptedReplies: readonly AcceptedTraceReplyEvent[];
	rawEvent: Event;
}>;

function compareCandidates(first: TraceReplyEventCandidate, second: TraceReplyEventCandidate): number {
	return first.candidate.createdAt - second.candidate.createdAt ||
		(first.candidate.id < second.candidate.id ? -1 : first.candidate.id > second.candidate.id ? 1 : 0);
}

function compareRoots(first: ParsedWorldMessage, second: ParsedWorldMessage): number {
	return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

/** Parses, signature-checks, and deterministically deduplicates raw kind 1111 events. */
export function parseTraceReplyEvents(rawEvents: readonly Event[]): readonly TraceReplyEventCandidate[] {
	const candidates = new Map<string, TraceReplyEventCandidate>();
	for (const rawEvent of rawEvents) {
		try {
			const candidate = parseTraceReplyCandidate(rawEvent);
			if (candidate && !candidates.has(candidate.id)) candidates.set(candidate.id, { rawEvent, candidate });
		} catch {
			// Raw Relay and IndexedDB values are untrusted.
		}
	}
	return [...candidates.values()].sort(compareCandidates);
}

export function resolveTraceReplyCandidates(input: Readonly<{
	effectiveRoots: readonly ParsedWorldMessage[];
	candidates: readonly TraceReplyEventCandidate[];
}>): readonly AcceptedTraceReplyEvent[] {
	const roots = new Map<string, ParsedWorldMessage>();
	for (const root of [...input.effectiveRoots].sort(compareRoots)) {
		if (!roots.has(root.id)) roots.set(root.id, root);
	}

	const unresolved = new Map<string, TraceReplyEventCandidate>();
	for (const candidate of [...input.candidates].sort(compareCandidates)) {
		if (!unresolved.has(candidate.candidate.id)) unresolved.set(candidate.candidate.id, candidate);
	}
	const accepted = new Map<string, AcceptedTraceReplyEvent>();
	const ordered: AcceptedTraceReplyEvent[] = [];

	while (unresolved.size > 0) {
		const ready: Array<Readonly<{
			event: TraceReplyEventCandidate;
			reply: ParsedTraceReply;
		}>> = [];
		for (const event of unresolved.values()) {
			const root = roots.get(event.candidate.rootId);
			if (!root) continue;
			const parent = event.candidate.parentKind === 42
				? root
				: accepted.get(event.candidate.parentId)?.reply;
			if (!parent) continue;
			const reply = validateTraceReplyCandidate(event.candidate, root, parent);
			if (reply) ready.push({ event, reply });
		}

		if (ready.length === 0) break;
		ready.sort((first, second) => compareCandidates(first.event, second.event));
		for (const item of ready) {
			if (!unresolved.delete(item.reply.id)) continue;
			const acceptedEvent = { rawEvent: item.event.rawEvent, reply: item.reply };
			accepted.set(item.reply.id, acceptedEvent);
			ordered.push(acceptedEvent);
		}
	}

	return ordered;
}

/** Resolves a bounded history batch independently of Relay arrival order. */
export function resolveTraceReplyBatch(
	input: ResolveTraceReplyBatchInput
): readonly AcceptedTraceReplyEvent[] {
	return resolveTraceReplyCandidates({
		effectiveRoots: input.effectiveRoots,
		candidates: parseTraceReplyEvents(input.rawEvents)
	});
}

/** Resolves one live event only against roots and already accepted parents. */
export function resolveLiveTraceReply(
	input: ResolveLiveTraceReplyInput
): AcceptedTraceReplyEvent | null {
	const event = parseTraceReplyEvents([input.rawEvent])[0];
	if (!event) return null;
	const root = input.effectiveRoots.find((candidate) => candidate.id === event.candidate.rootId);
	if (!root) return null;
	const parent = event.candidate.parentKind === 42
		? root
		: input.acceptedReplies.find((candidate) => candidate.reply.id === event.candidate.parentId)?.reply;
	if (!parent) return null;
	const reply = validateTraceReplyCandidate(event.candidate, root, parent);
	return reply ? { rawEvent: event.rawEvent, reply } : null;
}
