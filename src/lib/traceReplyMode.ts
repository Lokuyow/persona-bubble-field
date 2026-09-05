import type { TraceConversationState } from './traceConversation';

export type TraceReplyIdentity = Readonly<{ rootId: string; targetId: string }>;
export type TraceReplyTarget = TraceReplyIdentity;
export type TraceReplyMode = Readonly<{
	generation: number;
	clearContentVersion: number;
	target: TraceReplyTarget | null;
	draftIdentity: TraceReplyIdentity | null;
}>;

export function createTraceReplyMode(): TraceReplyMode {
	return { generation: 0, clearContentVersion: 0, target: null, draftIdentity: null };
}

export function acceptedTraceReplyTarget(state: TraceConversationState, identity: TraceReplyIdentity): TraceReplyTarget | null {
	if (state.kind !== 'open' || state.root.id !== identity.rootId) return null;
	const event = state.root.id === identity.targetId ? state.root : state.replies.find((reply) => reply.id === identity.targetId);
	return event ? { ...identity } : null;
}

export function selectTraceReplyTarget(state: TraceReplyMode, target: TraceReplyTarget): TraceReplyMode {
	const sameDraft = state.draftIdentity?.rootId === target.rootId && state.draftIdentity.targetId === target.targetId;
	return {
		generation: state.generation + 1,
		clearContentVersion: state.clearContentVersion + (sameDraft ? 0 : 1),
		target,
		draftIdentity: { rootId: target.rootId, targetId: target.targetId }
	};
}

export function clearTraceReplyMode(state: TraceReplyMode, discardDraft = false): TraceReplyMode {
	return {
		...state,
		generation: state.generation + 1,
		clearContentVersion: state.clearContentVersion + (discardDraft ? 1 : 0),
		target: null,
		draftIdentity: discardDraft ? null : state.draftIdentity
	};
}

export function completeTraceReplySubmission(state: TraceReplyMode, generation: number): TraceReplyMode {
	return state.generation === generation
		? { ...clearTraceReplyMode(state), draftIdentity: null }
		: state;
}
