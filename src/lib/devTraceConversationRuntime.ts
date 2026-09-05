import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import { getParticipant, type PresenceState, type RandomSource } from './presence';
import {
	groupTraceRoots,
	isWithinTraceInvestigationRange,
	prepareTraceInspectionActivity,
	sameGridPosition
} from './traceInvestigation';
import type {
	TraceConversationConfig,
	TraceConversationController,
	TraceConversationOpenResult,
	TraceConversationState,
	TraceReplyPublication,
	TraceReplyPublishResult
} from './traceConversation';
import {
	adjacentTraceSpeech,
	resolveTraceConversationProjection
} from './traceReplyPresentation';

export type DevTraceConversationRuntime = TraceConversationController & Readonly<{
	reconcileEffectiveRoots(roots: readonly ParsedWorldMessage[]): void;
	reconcileReplies(replies: readonly ParsedTraceReply[]): void;
	publishTraceReply(input: TraceReplyPublication): Promise<TraceReplyPublishResult>;
	dispose(): void;
}>;

export function createDevTraceConversationRuntime(options: Readonly<{
	selfId: string;
	getPresence: () => PresenceState;
	setPresence: (presence: PresenceState) => void;
	getEffectiveRoots: () => readonly ParsedWorldMessage[];
	getReplies: () => readonly ParsedTraceReply[];
	setReplies?: (replies: readonly ParsedTraceReply[]) => void;
	onStateChanged?: (state: TraceConversationState) => void;
	now?: () => number;
	random?: RandomSource;
}>): DevTraceConversationRuntime {
	let disposed = false;
	let publicationSequence = 0;
	let state: TraceConversationState = { kind: 'closed' };
	const now = options.now ?? Date.now;

	function emit(next: TraceConversationState): void {
		state = next;
		if (!disposed) options.onStateChanged?.(next);
	}

	function activate(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		emit({
			kind: 'open',
			root,
			config,
			replies: options.getReplies().filter((reply) => reply.rootId === root.id),
			replyRefresh: 'settled'
		});
	}

	function openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
		if (disposed) return { kind: 'unavailable' };
		const root = options.getEffectiveRoots().find((candidate) => candidate.id === config.rootId);
		if (!root || config.currentId !== root.id) return { kind: 'blocked' };
		if (state.kind === 'open' && state.root.id === root.id) {
			return state.config.currentId === config.currentId ? selectTraceConversationSpeech(config.currentId) : { kind: 'blocked' };
		}
		const sameCellSwitch = state.kind === 'open' && state.root.id !== root.id &&
			sameGridPosition(state.root.position, root.position);
		const prepared = prepareTraceInspectionActivity({
			presence: options.getPresence(),
			selfId: options.selfId,
			target: root.position,
			nowMs: now(),
			requireCurrentRange: sameCellSwitch,
			random: options.random
		});
		if (prepared.kind === 'blocked') return { kind: 'blocked' };
		if (!prepared.coalesced) options.setPresence(prepared.nextPresence);
		activate(root, config);
		return { kind: 'opened' };
	}

	function selectTraceConversationSpeech(targetId: string): TraceConversationOpenResult {
		if (disposed) return { kind: 'unavailable' };
		if (state.kind === 'closed') return { kind: 'blocked' };
		const projection = resolveTraceConversationProjection(state);
		const target = projection ? projection.current.event.id === targetId
			? projection.current : adjacentTraceSpeech(projection, targetId) : null;
		if (!target) return { kind: 'blocked' };
		const prepared = prepareTraceInspectionActivity({
			presence: options.getPresence(),
			selfId: options.selfId,
			target: target.event.position,
			nowMs: now(),
			requireCurrentRange: true,
			random: options.random
		});
		if (prepared.kind === 'blocked') return { kind: 'blocked' };
		if (!prepared.coalesced) options.setPresence(prepared.nextPresence);
		if (state.config.currentId === targetId) return { kind: 'opened' };
		emit({
			...state,
			config: { rootId: state.root.id, currentId: target.event.id },
			replyRefresh: 'settled'
		});
		return { kind: 'opened' };
	}

	function closeTraceConversation(): void {
		if (disposed || state.kind === 'closed') return;
		emit({ kind: 'closed' });
	}

	function reconcileEffectiveRoots(roots: readonly ParsedWorldMessage[]): void {
		if (disposed || state.kind === 'closed') return;
		const current = state;
		const retained = roots.find((root) => root.id === current.root.id);
		if (retained) {
			if (retained !== current.root) activate(retained, current.config);
			return;
		}
		const fallback = groupTraceRoots(roots)
			.find((cell) => sameGridPosition(cell.position, current.root.position))?.roots[0];
		const self = getParticipant(options.getPresence(), options.selfId);
		if (!fallback || !self || !isWithinTraceInvestigationRange(self.position, fallback.position)) {
			closeTraceConversation();
			return;
		}
		activate(fallback, { rootId: fallback.id, currentId: fallback.id });
	}

	function reconcileReplies(replies: readonly ParsedTraceReply[]): void {
		if (disposed || state.kind === 'closed') return;
		const rootId = state.root.id;
		const next: TraceConversationState = {
			...state,
			replies: replies.filter((reply) => reply.rootId === rootId)
		};
		emit(resolveTraceConversationProjection(next) ? next : {
			...next,
			config: { rootId, currentId: rootId }
		});
	}

	return {
		async publishTraceReply(input): Promise<TraceReplyPublishResult> {
			if (disposed || !options.setReplies) return { kind: 'unavailable' };
			if (state.kind !== 'open' || state.root.id !== input.rootId) return { kind: 'blocked' };
			const { root } = state;
			const target = root.id === input.targetId ? root : state.replies.find((reply) => reply.id === input.targetId);
			if (!target) return { kind: 'blocked' };
			const nowMs = now();
			const prepared = prepareTraceInspectionActivity({
				presence: options.getPresence(), selfId: options.selfId, target: target.position,
				nowMs, requireCurrentRange: true, activity: 'trace-reply', random: options.random
			});
			if (prepared.kind === 'blocked') return { kind: 'out-of-range' };
			if (!prepared.coalesced) options.setPresence(prepared.nextPresence);
			const eventId = (++publicationSequence).toString(16).padStart(64, '0');
			options.setReplies([...options.getReplies(), {
				id: eventId, pubkey: options.selfId, createdAt: Math.floor(nowMs / 1000),
				content: input.content, speechType: input.speechType, position: { ...prepared.position },
				rootId: root.id, rootPubkey: root.pubkey, parentId: target.id,
				parentKind: 'rootId' in target ? 1111 : 42, parentPubkey: target.pubkey
			}]);
			return { kind: 'succeeded', eventId };
		},
		openTraceConversation,
		selectTraceConversationSpeech,
		closeTraceConversation,
		reconcileEffectiveRoots,
		reconcileReplies,
		getTraceConversationState: () => state,
		dispose(): void {
			disposed = true;
		}
	};
}
