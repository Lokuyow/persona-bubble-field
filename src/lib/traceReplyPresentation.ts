import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationState } from './traceConversation';

export type TraceSpeech =
	| Readonly<{ kind: 'root'; event: ParsedWorldMessage }>
	| Readonly<{ kind: 'reply'; event: ParsedTraceReply }>;

export type TraceConversationProjection = Readonly<{
	root: ParsedWorldMessage;
	current: TraceSpeech;
	parent: TraceSpeech | null;
	directReplies: readonly ParsedTraceReply[];
}>;

export function compareTraceReplies(first: ParsedTraceReply, second: ParsedTraceReply): number {
	return second.createdAt - first.createdAt ||
		(first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}

function acceptedReplies(state: Extract<TraceConversationState, { kind: 'open' }>): readonly ParsedTraceReply[] {
	const unique = new Map<string, ParsedTraceReply>();
	for (const reply of state.replies) {
		if (reply.rootId === state.root.id && !unique.has(reply.id)) unique.set(reply.id, reply);
	}
	return [...unique.values()].sort(compareTraceReplies);
}

/** Resolves the small, position-free window of a validated NIP-22 tree. */
export function resolveTraceConversationProjection(
	conversation: TraceConversationState
): TraceConversationProjection | null {
	if (conversation.kind === 'closed' || conversation.config.rootId !== conversation.root.id) return null;
	const replies = acceptedReplies(conversation);
	const replyById = new Map(replies.map((reply) => [reply.id, reply]));
	const current: TraceSpeech | null = conversation.config.currentId === conversation.root.id
		? { kind: 'root', event: conversation.root }
		: (() => {
			const reply = replyById.get(conversation.config.currentId);
			return reply ? { kind: 'reply' as const, event: reply } : null;
		})();
	if (!current) return null;

	let parent: TraceSpeech | null = null;
	if (current.kind === 'reply') {
		if (current.event.parentKind === 42) {
			if (current.event.parentId !== conversation.root.id) return null;
			parent = { kind: 'root', event: conversation.root };
		} else {
			const reply = replyById.get(current.event.parentId);
			if (!reply) return null;
			parent = { kind: 'reply', event: reply };
		}
	}

	const parentKind = current.kind === 'root' ? 42 : 1111;
	const directReplies = replies.filter((reply) => reply.parentKind === parentKind && reply.parentId === current.event.id);
	return { root: conversation.root, current, parent, directReplies };
}

export function adjacentTraceSpeech(projection: TraceConversationProjection, targetId: string): TraceSpeech | null {
	if (projection.root.id === targetId) return { kind: 'root', event: projection.root };
	if (projection.parent?.event.id === targetId) return projection.parent;
	const child = projection.directReplies.find((reply) => reply.id === targetId);
	return child ? { kind: 'reply', event: child } : null;
}
