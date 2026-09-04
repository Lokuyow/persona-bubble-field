import {
	createNostrRelayTransport,
	type PrimaryPairDiagnostic,
	type PrimaryStartResult,
	type PublishRelayResult,
	type TraceReplyBatch
} from './nostrRelayTransport';
import { reconcileTraceRootCache } from './traceRootCache';
import { reconcileTraceReplyCache, touchTraceReplyTree } from './traceReplyCache';
import {
	buildPositionEventTemplate,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	parsePositionEvent,
	parseWorldMessage,
	type ChannelReference,
	type ParsedPositionEvent,
	type ParsedTraceReply,
	type ParsedWorldMessage
} from './nostrProtocol';
import {
	enterParticipant,
	getParticipant,
	moveParticipant,
	PRESENCE_TIMEOUT_MS,
	recordPresenceActivity,
	type PresenceField,
	type PresenceState
} from './presence';
import type { Direction } from './geometry';
import type { Event as NostrEvent, VerifiedEvent } from 'nostr-tools/pure';
import type { AccountSnapshot } from './nostrAccount';
import type { SpeechType } from './conversation';
import { reachedAuthoritativeRelay } from './initialProfilePublication';
import {
	createPositionPublishState,
	planPositionPublish,
	reconstructPositionPublishState,
	type PositionPublishState
} from './positionPublish';
import { PROTOTYPE_WORLD_CONFIG } from './prototypeWorld';
import {
	applyWorldPresenceMessage,
	applyWorldPresencePosition,
	projectWorldPresenceState,
	reconstructWorldPresenceState,
	type WorldPresenceState
} from './worldPresence';
import {
	groupTraceRoots,
	isWithinTraceInvestigationRange,
	prepareTraceInspectionActivity,
	sameGridPosition
} from './traceInvestigation';
import type {
	TraceConversationConfig,
	TraceConversationOpenResult,
	TraceConversationState
} from './traceConversation';

const BOOTSTRAP_SAFETY_MARGIN_MS = 60_000;

export type WorldReadConnectionStatus =
	| Readonly<{ kind: 'bootstrapping' }>
	| Readonly<{ kind: 'available' }>
	| Readonly<{ kind: 'degraded'; issueCount: number }>
	| Readonly<{ kind: 'failed'; message: string }>;

export type WorldReadBootstrap = Readonly<{
	messages: readonly ParsedWorldMessage[];
	timelineMessages: readonly ParsedWorldMessage[];
	positions: readonly ParsedPositionEvent[];
	presence: PresenceState;
	status: WorldReadConnectionStatus;
}>;

export type SelfPositionWriteState =
	| Readonly<{ kind: 'ready' }>
	| Readonly<{ kind: 'pending'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'succeeded'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'retryable'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'unavailable' }>;

export type SelfPositionOperationKind = 'entry' | 'movement' | 'reactivation' | 'trace-inspection';

export type SelfPositionWriteResult =
	| Readonly<{ kind: 'not-needed' | 'blocked' | 'unavailable' | 'pending' }>
	| Readonly<{ kind: 'succeeded'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'retryable'; operation: SelfPositionOperationKind }>;

export type SelfMessageAvailability = Readonly<{ kind: 'ready' | 'unavailable' }>;

export type SelfMessagePublishResult =
	| Readonly<{ kind: 'succeeded'; eventId: string }>
	| Readonly<{ kind: 'blocked' | 'pending' | 'retryable' | 'unavailable' }>;

export type WorldReadSessionOptions = Readonly<{
	field: PresenceField;
	selfAccount?: AccountSnapshot | null;
	onPresenceChanged: (presence: PresenceState) => void;
	onLiveMessage: (message: ParsedWorldMessage, presence: PresenceState) => void;
	onTimelineMessage?: (message: ParsedWorldMessage) => void;
	onEffectiveTraceRootsChanged?: (roots: readonly ParsedWorldMessage[]) => void;
	onTraceConversationChanged?: (state: TraceConversationState) => void;
	onStatusChanged: (status: WorldReadConnectionStatus) => void;
	onSelfPositionWriteStateChanged?: (state: SelfPositionWriteState) => void;
	onSelfMessageAvailabilityChanged?: (state: SelfMessageAvailability) => void;
}>;

type BufferedLiveEvent =
	| Readonly<{ kind: 'message'; event: ParsedWorldMessage; rawEvent: NostrEvent }>
	| Readonly<{ kind: 'position'; event: ParsedPositionEvent }>;

type SelfPositionOperation = Readonly<{
	id: string;
	operation: SelfPositionOperationKind;
}>;

type SelfMessageOperation = {
	id: string;
	echoConfirmed: boolean;
};

function bootstrapSince(nowMs: number): number {
	return Math.max(0, Math.floor((nowMs - PRESENCE_TIMEOUT_MS - BOOTSTRAP_SAFETY_MARGIN_MS) / 1000));
}

function hasRelayIssue(result: PrimaryStartResult): number {
	const metadataIssues = result.metadataDiscovery.relays.filter((relay) => relay.status !== 'eose').length;
	const primaryIssues = result.primaryPairs.filter((pair) => pair.status !== 'eose').length;
	return metadataIssues + primaryIssues;
}

/**
 * Owns only the real-world read lifecycle. Viewer-local geometry and conversation
 * state stay in the page because their semantics depend on the current viewport.
 */
export function createWorldReadSession(options: WorldReadSessionOptions) {
	let disposed = false;
	let started = false;
	let bootstrapComplete = false;
	let transport: ReturnType<typeof createNostrRelayTransport> | null = null;
	let channel: ChannelReference | null = null;
	let messageSince = 0;
	let worldPresence: WorldPresenceState = reconstructWorldPresenceState(options.field, [], []);
	let presence = projectWorldPresenceState(worldPresence, Date.now());
	let status: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let positionPublishState: PositionPublishState = createPositionPublishState();
	let selfJoinedThisSession = false;
	let pendingSelfOperation: SelfPositionOperation | null = null;
	let latestSelfOperationId: string | null = null;
	let selfPositionWriteState: SelfPositionWriteState = options.selfAccount ? { kind: 'ready' } : { kind: 'unavailable' };
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let pendingSelfMessage: SelfMessageOperation | null = null;
	let effectiveTraceRoots: readonly ParsedWorldMessage[] = [];
	let traceRootBootstrapReadiness: Promise<'ready' | 'failed'> | null = null;
	let traceConversationState: TraceConversationState = { kind: 'closed' };
	let traceConversationGeneration = 0;
	let traceReplyReconcileTail: Promise<void> = Promise.resolve();
	const pendingLiveEvents: BufferedLiveEvent[] = [];
	const knownSelfPositionEvents = new Map<string, ParsedPositionEvent>();
	const handedOffSelfPositionEvents = new Map<string, ParsedPositionEvent>();
	const retryableSelfOperations = new Map<string, SelfPositionOperation>();
	const appliedCanonicalPositionEventIds = new Set<string>();
	const appliedCanonicalMessageEventIds = new Set<string>();

	function emitStatus(next: WorldReadConnectionStatus): void {
		status = next;
		if (!disposed) options.onStatusChanged(status);
	}

	function emitSelfPositionWriteState(next: SelfPositionWriteState): void {
		selfPositionWriteState = next;
		if (!disposed) options.onSelfPositionWriteStateChanged?.(next);
	}

	function emitTraceConversationState(next: TraceConversationState): void {
		traceConversationState = next;
		if (!disposed) options.onTraceConversationChanged?.(next);
	}

	function refreshSelfMessageAvailability(): void {
		const next: SelfMessageAvailability = !disposed &&
			Boolean(options.selfAccount && transport && channel && selfJoinedThisSession &&
				presence.participants.some((participant) => participant.id === options.selfAccount?.pubkey))
			? { kind: 'ready' }
			: { kind: 'unavailable' };
		if (next.kind === selfMessageAvailability.kind) return;
		selfMessageAvailability = next;
		if (!disposed) options.onSelfMessageAvailabilityChanged?.(next);
	}

	function project(nowMs: number): PresenceState {
		presence = projectWorldPresenceState(worldPresence, nowMs);
		if (!disposed) options.onPresenceChanged(presence);
		refreshSelfMessageAvailability();
		return presence;
	}

	function markDegraded(_diagnostic: PrimaryPairDiagnostic): void {
		if (disposed || status.kind === 'failed') return;
		const issueCount = status.kind === 'degraded' ? status.issueCount + 1 : 1;
		emitStatus({ kind: 'degraded', issueCount });
	}

	function reconcileTraceRoots(rawEvents: readonly NostrEvent[]): void {
		if (!channel || disposed) return;
		void reconcileTraceRootCache({
			channelId: channel.channelId,
			field: options.field,
			rawEvents
		}).then((roots) => {
			if (disposed) return;
			effectiveTraceRoots = roots;
			reconcileOpenTraceRoot(roots);
			options.onEffectiveTraceRootsChanged?.(roots);
		}).catch(() => {
			// Trace is viewer-local supplemental state and never changes world status.
		});
	}

	function startTraceBackground(): void {
		reconcileTraceRoots([]);
		if (!transport) return;
		traceRootBootstrapReadiness = transport.bootstrapTraceRootCandidates().then((result) => {
			reconcileTraceRoots(result.rawEvents);
			return 'ready' as const;
		}).catch(() => {
			return 'failed' as const;
		});
	}

	function applyCanonicalMessage(message: ParsedWorldMessage, nowMs: number, rawEvent?: NostrEvent): boolean {
		if (appliedCanonicalMessageEventIds.has(message.id)) return false;
		appliedCanonicalMessageEventIds.add(message.id);
		if (!disposed) options.onTimelineMessage?.(message);
		if (pendingSelfMessage?.id === message.id) pendingSelfMessage.echoConfirmed = true;
		if (message.createdAt < messageSince) return true;
		worldPresence = applyWorldPresenceMessage(worldPresence, message);
		const nextPresence = project(nowMs);
		if (!disposed) options.onLiveMessage(message, nextPresence);
		if (rawEvent) reconcileTraceRoots([rawEvent]);
		return true;
	}

	function applyLiveMessage(message: ParsedWorldMessage, rawEvent: NostrEvent, nowMs: number): void {
		applyCanonicalMessage(message, nowMs, rawEvent);
	}

	function applyLivePosition(event: ParsedPositionEvent, nowMs: number): void {
		observeLivePosition(event);
		applyCanonicalPosition(event, nowMs);
	}

	// Bootstrap evidence is already parser/signature-verified by the transport.
	// It can safely improve the visible field before final EOSE, but it must not
	// produce conversation or make self writes available before canonical handoff.
	function applyBootstrapMessage(message: ParsedWorldMessage, nowMs: number): void {
		if (message.createdAt < messageSince) return;
		worldPresence = applyWorldPresenceMessage(worldPresence, message);
		project(nowMs);
	}

	function applyBootstrapPosition(event: ParsedPositionEvent, nowMs: number): void {
		observeLivePosition(event);
		worldPresence = applyWorldPresencePosition(worldPresence, event);
		project(nowMs);
	}

	function rebuildSelfPositionPlanner(): void {
		if (!options.selfAccount) return;
		positionPublishState = reconstructPositionPublishState([
			...knownSelfPositionEvents.values(),
			...handedOffSelfPositionEvents.values()
		], options.selfAccount.pubkey);
	}

	function observeLivePosition(event: ParsedPositionEvent): void {
		if (!options.selfAccount || event.pubkey !== options.selfAccount.pubkey) return;
		knownSelfPositionEvents.set(event.id, event);
		rebuildSelfPositionPlanner();
	}

	function applyCanonicalPosition(event: ParsedPositionEvent, nowMs: number): boolean {
		if (appliedCanonicalPositionEventIds.has(event.id)) return false;
		appliedCanonicalPositionEventIds.add(event.id);
		worldPresence = applyWorldPresencePosition(worldPresence, event);
		const nextPresence = project(nowMs);
		if (options.selfAccount && event.pubkey === options.selfAccount.pubkey) {
			selfJoinedThisSession = nextPresence.participants.some((participant) =>
				participant.id === event.pubkey && participant.status === 'active'
			);
			const pendingOperation = pendingSelfOperation?.id === event.id ? pendingSelfOperation : null;
			const retryableOperation = retryableSelfOperations.get(event.id);
			if (pendingOperation) {
				retryableSelfOperations.delete(event.id);
				emitSelfPositionWriteState({ kind: 'succeeded', operation: pendingOperation.operation });
				pendingSelfOperation = null;
			} else if (retryableOperation) {
				retryableSelfOperations.delete(event.id);
				if (latestSelfOperationId === event.id) {
					emitSelfPositionWriteState({ kind: 'succeeded', operation: retryableOperation.operation });
				}
			}
			refreshSelfMessageAvailability();
		}
		return true;
	}

	function currentPresence(): PresenceState {
		return project(Date.now());
	}

	function selfOperationCandidate(
		operation: Exclude<SelfPositionOperationKind, 'trace-inspection'>,
		direction?: Direction
	): Readonly<{ event: VerifiedEvent; parsed: ParsedPositionEvent }> | null {
		if (!options.selfAccount || !channel) return null;
		const nowMs = Date.now();
		const state = currentPresence();
		let candidate: PresenceState;
		if (operation === 'entry') {
			candidate = enterParticipant(state, options.selfAccount.pubkey, nowMs);
		} else if (operation === 'reactivation') {
			candidate = recordPresenceActivity(state, options.selfAccount.pubkey, 'movement', nowMs);
		} else {
			if (!direction) return null;
			const movement = moveParticipant(state, options.selfAccount.pubkey, direction, nowMs);
			if (!movement.moved) return null;
			candidate = movement.state;
		}
		const participant = getParticipant(candidate, options.selfAccount.pubkey);
		if (!participant) return null;
		return positionCandidate(participant.position, nowMs);
	}

	function positionCandidate(
		position: ParsedPositionEvent['position'],
		nowMs: number
	): Readonly<{ event: VerifiedEvent; parsed: ParsedPositionEvent }> | null {
		if (!options.selfAccount || !channel) return null;
		const createdAt = Math.floor(nowMs / 1000);
		const plan = planPositionPublish(positionPublishState, createdAt);
		if (plan.kind === 'unavailable') return null;
		const signed = finalizeWorldEvent(buildPositionEventTemplate({
			channel,
			position,
			slot: plan.slot,
			createdAt
		}), options.selfAccount.secretKey);
		const parsed = parsePositionEvent(signed, channel.channelId);
		if (!parsed) throw new Error('Locally signed position event did not pass the project parser.');
		positionPublishState = plan.nextState;
		handedOffSelfPositionEvents.set(parsed.id, parsed);
		return { event: signed, parsed };
	}

	function selfMessageCandidate(content: string, speechType: SpeechType): Readonly<{ event: VerifiedEvent; parsed: ParsedWorldMessage }> | null {
		if (!options.selfAccount || !channel || !selfJoinedThisSession) return null;
		const nowMs = Date.now();
		const state = currentPresence();
		const current = getParticipant(state, options.selfAccount.pubkey);
		if (!current) return null;
		const candidate = current.status === 'inactive'
			? recordPresenceActivity(state, options.selfAccount.pubkey, 'message', nowMs)
			: state;
		const participant = getParticipant(candidate, options.selfAccount.pubkey);
		if (!participant) return null;
		const signed = finalizeWorldEvent(buildWorldMessageTemplate({
			channel,
			content,
			speechType,
			position: participant.position,
			createdAt: Math.floor(nowMs / 1000)
		}), options.selfAccount.secretKey);
		const parsed = parseWorldMessage(signed, channel.channelId);
		if (!parsed) throw new Error('Locally signed world message did not pass the project parser.');
		return { event: signed, parsed };
	}

	async function publishMessage(content: string, speechType: SpeechType): Promise<SelfMessagePublishResult> {
		if (disposed || !options.selfAccount || !transport || !channel) return { kind: 'unavailable' };
		if (pendingSelfMessage) return { kind: 'pending' };
		const candidate = selfMessageCandidate(content, speechType);
		if (!candidate) return { kind: 'blocked' };
		const { event, parsed } = candidate;
		pendingSelfMessage = { id: parsed.id, echoConfirmed: false };

		try {
			const results = await transport.publish(event);
			if (disposed) return { kind: 'unavailable' };
			const echoConfirmed = pendingSelfMessage?.id === parsed.id && pendingSelfMessage.echoConfirmed;
			if (reachedAuthoritativeRelay(results) || echoConfirmed) {
				applyCanonicalMessage(parsed, Date.now(), event);
				if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
				return { kind: 'succeeded', eventId: parsed.id };
			}
			if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
			return { kind: 'retryable' };
		} catch {
			if (disposed) return { kind: 'unavailable' };
			const echoConfirmed = pendingSelfMessage?.id === parsed.id && pendingSelfMessage.echoConfirmed;
			if (echoConfirmed) {
				applyCanonicalMessage(parsed, Date.now(), event);
				pendingSelfMessage = null;
				return { kind: 'succeeded', eventId: parsed.id };
			}
			if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
			return { kind: 'retryable' };
		}
	}

	async function publishPreparedSelfPosition(
		operation: SelfPositionOperationKind,
		candidate: Readonly<{ event: VerifiedEvent; parsed: ParsedPositionEvent }>
	): Promise<SelfPositionWriteResult> {
		const { event, parsed } = candidate;
		// The planner was consumed before this call. It must never be rolled back.
		pendingSelfOperation = { id: parsed.id, operation };
		latestSelfOperationId = parsed.id;
		emitSelfPositionWriteState({ kind: 'pending', operation });
		try {
			const results = await transport!.publish(event);
			if (disposed) return { kind: 'unavailable' };
			if (pendingSelfOperation?.id !== parsed.id) {
				return { kind: 'succeeded', operation };
			}
			if (reachedAuthoritativeRelay(results)) {
				applyCanonicalPosition(parsed, Date.now());
				return { kind: 'succeeded', operation };
			}
			retryableSelfOperations.set(parsed.id, pendingSelfOperation);
			pendingSelfOperation = null;
			emitSelfPositionWriteState({ kind: 'retryable', operation });
			return { kind: 'retryable', operation };
		} catch {
			if (disposed) return { kind: 'unavailable' };
			if (pendingSelfOperation?.id !== parsed.id) return { kind: 'succeeded', operation };
			retryableSelfOperations.set(parsed.id, pendingSelfOperation);
			pendingSelfOperation = null;
			emitSelfPositionWriteState({ kind: 'retryable', operation });
			return { kind: 'retryable', operation };
		}
	}

	async function publishSelfPosition(
		operation: Exclude<SelfPositionOperationKind, 'trace-inspection'>,
		direction?: Direction
	): Promise<SelfPositionWriteResult> {
		if (!options.selfAccount) {
			emitSelfPositionWriteState({ kind: 'unavailable' });
			return { kind: 'unavailable' };
		}
		if (disposed) return { kind: 'unavailable' };
		if (pendingSelfOperation) return { kind: 'pending' };
		const candidate = selfOperationCandidate(operation, direction);
		if (!candidate) return { kind: 'blocked' };
		return publishPreparedSelfPosition(operation, candidate);
	}

	function traceStateFor(
		root: ParsedWorldMessage,
		config: TraceConversationConfig,
		replies: readonly ParsedTraceReply[],
		replyRefresh: 'loading' | 'settled' | 'unavailable'
	): TraceConversationState {
		return { kind: 'open', root, config, replies, replyRefresh };
	}

	function updateTraceConversation(
		generation: number,
		update: (current: Extract<TraceConversationState, { kind: 'open' }>) => TraceConversationState
	): void {
		if (disposed || generation !== traceConversationGeneration || traceConversationState.kind !== 'open') return;
		emitTraceConversationState(update(traceConversationState));
	}

	function reconcileTraceReplies(
		generation: number,
		rawEvents: readonly NostrEvent[]
	): Promise<boolean> {
		let success = false;
		traceReplyReconcileTail = traceReplyReconcileTail.then(async () => {
			if (!channel) return;
			try {
				const currentOpenRootId = generation === traceConversationGeneration && traceConversationState.kind === 'open'
					? traceConversationState.root.id
					: undefined;
				const replies = await reconcileTraceReplyCache({
					channelId: channel.channelId,
					effectiveRoots: effectiveTraceRoots,
					rawEvents,
					...(currentOpenRootId ? { currentOpenRootId } : {})
				});
				success = true;
				updateTraceConversation(generation, (current) => ({ ...current, replies }));
			} catch {
				// A supplemental cache failure does not affect primary world reads.
			}
		});
		return traceReplyReconcileTail.then(() => success);
	}

	function receiveTraceBatch(generation: number, batch: TraceReplyBatch): void {
		void reconcileTraceReplies(generation, batch.events);
	}

	async function startTraceConversationWork(
		generation: number,
		root: ParsedWorldMessage,
		config: TraceConversationConfig
	): Promise<void> {
		if (!channel || !transport) return;
		try {
			const touched = await touchTraceReplyTree({ channelId: channel.channelId, rootId: root.id });
			if (!touched) {
				if (generation === traceConversationGeneration) closeTraceConversation();
				return;
			}
		} catch {
			// Continue: a later reconciliation may still restore or repair the cache.
		}
		await reconcileTraceReplies(generation, []);
		if (disposed || generation !== traceConversationGeneration) return;
		const readiness = traceRootBootstrapReadiness ? await traceRootBootstrapReadiness : 'failed';
		if (disposed || generation !== traceConversationGeneration) return;
		if (readiness !== 'ready') {
			updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
			return;
		}
		try {
			const result = await transport.configureTraceReplies({
				conversation: config,
				onBatch: (batch) => receiveTraceBatch(generation, batch),
				onLiveEvent: (event) => { void reconcileTraceReplies(generation, [event]); }
			});
			if (disposed || generation !== traceConversationGeneration || result.status === 'superseded') return;
			if (result.status !== 'active') {
				updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
				return;
			}
			const reconciled = await reconcileTraceReplies(generation, result.initialBatch.events);
			updateTraceConversation(generation, (current) => ({
				...current,
				replyRefresh: reconciled ? 'settled' : 'unavailable'
			}));
		} catch {
			updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
		}
	}

	function activateTraceConversation(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		const generation = ++traceConversationGeneration;
		emitTraceConversationState(traceStateFor(root, config, [], 'loading'));
		void startTraceConversationWork(generation, root, config);
	}

	function openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
		if (disposed || !options.selfAccount || !transport || !channel) return { kind: 'unavailable' };
		if (!bootstrapComplete) return { kind: 'blocked' };
		const root = effectiveTraceRoots.find((candidate) => candidate.id === config.rootId);
		if (!root) return { kind: 'blocked' };
		if (traceConversationState.kind === 'open' && traceConversationState.root.id === root.id &&
			traceConversationState.config.currentId === config.currentId) return { kind: 'opened' };
		if (pendingSelfOperation) return { kind: 'pending' };
		const sameCellSwitch = traceConversationState.kind === 'open' && traceConversationState.root.id !== root.id &&
			sameGridPosition(traceConversationState.root.position, root.position);
		const nowMs = Date.now();
		const prepared = prepareTraceInspectionActivity({
			presence: currentPresence(),
			selfId: options.selfAccount.pubkey,
			target: root.position,
			nowMs,
			requireCurrentRange: sameCellSwitch
		});
		if (prepared.kind === 'blocked') return { kind: 'blocked' };
		if (!prepared.coalesced) {
			const candidate = positionCandidate(prepared.position, nowMs);
			if (!candidate) return { kind: 'blocked' };
			void publishPreparedSelfPosition('trace-inspection', candidate);
		}
		activateTraceConversation(root, config);
		return { kind: 'opened' };
	}

	function deactivateTraceSubscription(generation: number): void {
		const deactivate = async () => {
			const readiness = traceRootBootstrapReadiness ? await traceRootBootstrapReadiness : 'failed';
			if (disposed || generation !== traceConversationGeneration || traceConversationState.kind !== 'closed' || readiness !== 'ready') return;
			await transport?.configureTraceReplies({ onBatch: () => {}, onLiveEvent: () => {} }).catch(() => {});
		};
		void deactivate();
	}

	function closeTraceConversation(): void {
		if (disposed || traceConversationState.kind === 'closed') return;
		const generation = ++traceConversationGeneration;
		emitTraceConversationState({ kind: 'closed' });
		deactivateTraceSubscription(generation);
	}

	function reconcileOpenTraceRoot(roots: readonly ParsedWorldMessage[]): void {
		if (traceConversationState.kind === 'closed') return;
		const current = traceConversationState;
		const retained = roots.find((root) => root.id === current.root.id);
		if (retained) {
			if (retained !== current.root) {
				emitTraceConversationState({ ...current, root: retained });
			}
			return;
		}
		const fallback = groupTraceRoots(roots)
			.find((cell) => sameGridPosition(cell.position, current.root.position))?.roots[0];
		const self = options.selfAccount
			? getParticipant(projectWorldPresenceState(worldPresence, Date.now()), options.selfAccount.pubkey)
			: undefined;
		if (!fallback || !self || !isWithinTraceInvestigationRange(self.position, fallback.position)) {
			closeTraceConversation();
			return;
		}
		activateTraceConversation(fallback, { rootId: fallback.id, currentId: fallback.id });
	}

	function receiveLive(event: BufferedLiveEvent): void {
		if (disposed) return;
		if (!bootstrapComplete) {
			pendingLiveEvents.push(event);
			return;
		}
		if (event.kind === 'message') applyLiveMessage(event.event, event.rawEvent, Date.now());
		else applyLivePosition(event.event, Date.now());
	}

	return {
		async start(): Promise<WorldReadBootstrap> {
			if (started) throw new Error('World read session start is only allowed once.');
			started = true;
			transport = createNostrRelayTransport(PROTOTYPE_WORLD_CONFIG);
			emitStatus({ kind: 'bootstrapping' });
			const nowMs = Date.now();
			const since = bootstrapSince(nowMs);
			messageSince = since;

			try {
				const result = await transport.start({
					messageSince: since,
					positionSince: since,
					onBootstrapMessage: (event) => applyBootstrapMessage(event, Date.now()),
					onBootstrapPosition: (event) => applyBootstrapPosition(event, Date.now()),
					onLiveMessage: (event, rawEvent) => receiveLive({ kind: 'message', event, rawEvent }),
					onLivePosition: (event) => receiveLive({ kind: 'position', event }),
					onPrimaryClosed: markDegraded
				});
				if (disposed) throw new Error('World read session was disposed during startup.');

				const recentMessages = result.messages.filter((message) => message.createdAt >= messageSince);
				worldPresence = reconstructWorldPresenceState(options.field, recentMessages, result.positions);
				for (const event of result.messages) appliedCanonicalMessageEventIds.add(event.id);
				for (const event of result.positions) {
					appliedCanonicalPositionEventIds.add(event.id);
					observeLivePosition(event);
				}
				channel = result.metadata.channel;
				const nextPresence = project(Date.now());
				const issueCount = hasRelayIssue(result);
				emitStatus(issueCount === 0 ? { kind: 'available' } : { kind: 'degraded', issueCount });
				startTraceBackground();
				return {
					messages: recentMessages,
					timelineMessages: result.messages,
					positions: result.positions,
					presence: nextPresence,
					status
				};
			} catch (error) {
				if (!disposed) {
					const message = error instanceof Error ? error.message : 'Relay startup failed.';
					emitStatus({ kind: 'failed', message });
				}
				throw error;
			}
		},

		completeBootstrap(): void {
			if (disposed || !started || bootstrapComplete) return;
			bootstrapComplete = true;
			const buffered = pendingLiveEvents.splice(0);
			for (const event of buffered) receiveLive(event);
		},

		enterSelf(): Promise<SelfPositionWriteResult> {
			if (!bootstrapComplete) return Promise.resolve({ kind: 'blocked' });
			if (!options.selfAccount) return publishSelfPosition('entry');
			const participant = getParticipant(currentPresence(), options.selfAccount.pubkey);
			if (participant?.status === 'active') {
				selfJoinedThisSession = true;
				refreshSelfMessageAvailability();
				emitSelfPositionWriteState({ kind: 'ready' });
				return Promise.resolve({ kind: 'not-needed' });
			}
			return publishSelfPosition('entry');
		},

		moveSelf(direction: Direction): Promise<SelfPositionWriteResult> {
			if (!bootstrapComplete) return Promise.resolve({ kind: 'blocked' });
			if (!options.selfAccount) return publishSelfPosition('movement', direction);
			const participant = getParticipant(currentPresence(), options.selfAccount.pubkey);
			if (!participant) return publishSelfPosition('entry');
			return publishSelfPosition(
				participant.status === 'inactive' && selfJoinedThisSession ? 'reactivation' : 'movement',
				direction
			);
		},

		publishMessage(content: string, speechType: SpeechType): Promise<SelfMessagePublishResult> {
			return publishMessage(content, speechType);
		},

		openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
			return openTraceConversation(config);
		},

		closeTraceConversation(): void {
			closeTraceConversation();
		},

		refresh(nowMs: number): PresenceState {
			if (disposed) return presence;
			return project(nowMs);
		},

		publish(event: VerifiedEvent): Promise<readonly PublishRelayResult[]> {
			if (disposed || !transport) throw new Error('World read session must start before publishing.');
			return transport.publish(event);
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			traceConversationGeneration += 1;
			pendingLiveEvents.splice(0);
			transport?.dispose();
		},

		getStatus(): WorldReadConnectionStatus {
			return status;
		},

		getSelfPositionWriteState(): SelfPositionWriteState {
			return selfPositionWriteState;
		},

		getSelfMessageAvailability(): SelfMessageAvailability {
			return selfMessageAvailability;
		},

		getTraceConversationState(): TraceConversationState {
			return traceConversationState;
		}
	};
}
