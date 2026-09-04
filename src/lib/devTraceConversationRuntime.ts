import type { ParsedWorldMessage } from './nostrProtocol';
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
	TraceConversationState
} from './traceConversation';

export type DevTraceConversationRuntime = TraceConversationController & Readonly<{
	reconcileEffectiveRoots(roots: readonly ParsedWorldMessage[]): void;
	dispose(): void;
}>;

export function createDevTraceConversationRuntime(options: Readonly<{
	selfId: string;
	getPresence: () => PresenceState;
	setPresence: (presence: PresenceState) => void;
	getEffectiveRoots: () => readonly ParsedWorldMessage[];
	onStateChanged?: (state: TraceConversationState) => void;
	now?: () => number;
	random?: RandomSource;
}>): DevTraceConversationRuntime {
	let disposed = false;
	let state: TraceConversationState = { kind: 'closed' };
	const now = options.now ?? Date.now;

	function emit(next: TraceConversationState): void {
		state = next;
		if (!disposed) options.onStateChanged?.(next);
	}

	function activate(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		emit({ kind: 'open', root, config, replies: [], replyRefresh: 'settled' });
	}

	function openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
		if (disposed) return { kind: 'unavailable' };
		const root = options.getEffectiveRoots().find((candidate) => candidate.id === config.rootId);
		if (!root) return { kind: 'blocked' };
		if (state.kind === 'open' && state.root.id === root.id && state.config.currentId === config.currentId) {
			return { kind: 'opened' };
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

	return {
		openTraceConversation,
		closeTraceConversation,
		reconcileEffectiveRoots,
		getTraceConversationState: () => state,
		dispose(): void {
			disposed = true;
		}
	};
}
