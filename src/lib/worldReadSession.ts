import {
	createNostrRelayTransport,
	type PrimaryPairDiagnostic,
	type PrimaryStartResult,
	type PublishRelayResult,
	type TraceReplyBatch
} from './nostrRelayTransport';
import { normalizeRealtimeInstanceFilterConfigurations, parseRealtimeEnvelope, type RealtimeControlEnvelope, type RealtimeEnvelope, type RealtimeEventRegistry, type RealtimeInstanceFilterConfiguration } from './realtimeEvents';
import { reconcileTraceRootCache } from './traceRootCache';
import { loadTracePreviewEvent, reconcileTraceReplyCache, touchTraceReplyTree } from './traceReplyCache';
import {
	loadTraceReadSnapshot,
	markTraceReplyRead,
	markTraceRootRead,
	type TraceReadSnapshot
} from './traceReadState';
import {
	buildWorldStateEventTemplate,
	buildDeathTraceEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	parseWorldStateEvent,
	parseWorldMessage,
	type ChannelReference,
	type ParsedWorldStateEvent,
	type ParsedTraceReply,
	type ParsedWorldMessage,
	type ParsedTraceEvent
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
import { isBlockedFacilityCell } from './fieldFacilities';
import type { Event as NostrEvent, VerifiedEvent } from 'nostr-tools/pure';
import {
	confirmWorldPosition,
	loadWorldWriteJournal,
	reserveWorldPositive,
	type ActiveSignerSnapshot,
	type CommittedTerminalExit,
	type SelfWriteAuthorizationResult,
	type WorldWriteJournalScope,
	type WorldWriteJournalSnapshot,
	type WorldWriteReservation
} from './rootIdentity';
import type { SpeechType } from './conversation';
import { reachedAuthoritativeRelay } from './initialProfilePublication';
import {
	createPositionPublishState,
	planPositionPublish,
	reconstructPositionPublishState,
	retainPositionPublishEvidence,
	type PositionPublishEvidence,
	type PositionPublishState
} from './positionPublish';
import { resolvePrototypeWorldConfig } from './prototypeWorld';
import {
	applyWorldPresenceMessage,
	applyWorldPresenceWorldState,
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
	TraceConversationState,
	TraceReplyPublication,
	TraceReplyPublishResult
} from './traceConversation';
import {
	adjacentTraceSpeech,
	resolveTraceConversationProjection
} from './traceReplyPresentation';

const BOOTSTRAP_SAFETY_MARGIN_MS = 60_000;

export type WorldReadConnectionStatus =
	| Readonly<{ kind: 'bootstrapping' }>
	| Readonly<{ kind: 'available' }>
	| Readonly<{ kind: 'degraded'; issueCount: number }>
	| Readonly<{ kind: 'failed'; message: string }>;

export type WorldReadBootstrap = Readonly<{
	messages: readonly ParsedWorldMessage[];
	timelineMessages: readonly ParsedWorldMessage[];
	worldStates: readonly ParsedWorldStateEvent[];
	presence: PresenceState;
	status: WorldReadConnectionStatus;
	realtimeEvents: readonly RealtimeEnvelope[];
	realtimeStatus: 'inactive' | 'active' | 'degraded';
}>;

export type RealtimeSessionOptions = Readonly<{
	registry: RealtimeEventRegistry;
	controlSince: number;
	instanceFilters: readonly RealtimeInstanceFilterConfiguration[];
	getStartConfiguration?: () => RealtimeStartConfiguration;
	prepareStartConfiguration?: (configuration: RealtimeStartConfiguration, nowMs: number) => RealtimeStartConfiguration;
	startImmediately?: boolean;
	onEvent: (event: RealtimeEnvelope) => void;
	onControl?: (control: RealtimeControlEnvelope) => void;
	onBootstrapComplete?: (configuration: RealtimeStartConfiguration) => void;
	onStatusChanged?: (status: 'inactive' | 'active' | 'degraded') => void;
}>;

export type RealtimeStartConfiguration = Readonly<{
	controlSince: number;
	instanceFilters: readonly RealtimeInstanceFilterConfiguration[];
}>;

export type SelfPositionWriteState =
	| Readonly<{ kind: 'ready' }>
	| Readonly<{ kind: 'pending'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'succeeded'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'retryable'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'unavailable' }>;

export type SelfPositionOperationKind = 'entry' | 'movement' | 'reactivation' | 'trace-inspection' | 'trace-reply' | 'game-action';

export type SelfPositionWriteResult =
	| Readonly<{ kind: 'not-needed' | 'blocked' | 'unavailable' | 'pending' }>
	| Readonly<{ kind: 'succeeded'; operation: SelfPositionOperationKind }>
	| Readonly<{ kind: 'retryable'; operation: SelfPositionOperationKind }>;

export type SelfMessageAvailability = Readonly<{ kind: 'ready' | 'unavailable' }>;

export type SelfMessagePublishResult =
	| Readonly<{ kind: 'succeeded'; eventId: string }>
	| Readonly<{ kind: 'blocked' | 'duplicate' | 'pending' | 'retryable' | 'unavailable' }>;

export type TerminalExitPreparation =
	| Readonly<{ kind: 'prepared'; event: VerifiedEvent; parsed: ParsedWorldStateEvent }>
	| Readonly<{ kind: 'unavailable'; reason: 'disposed' | 'not-ready' | 'missing-self' | 'missing-position' | 'identity-mismatch' }>;

export type TerminalExitPublishResult =
	| Readonly<{ kind: 'published'; results: readonly PublishRelayResult[] }>
	| Readonly<{ kind: 'failed' | 'unavailable' }>;

export type DeathLastWordsPublishResult =
	| Readonly<{ kind: 'published'; eventId: string; results: readonly PublishRelayResult[] }>
	| Readonly<{ kind: 'failed' | 'unavailable' }>;

export type WorldReadSessionOptions = Readonly<{
	field: PresenceField;
	selfSigner?: ActiveSignerSnapshot | null;
	selfRunNumber?: number;
	onPresenceChanged: (presence: PresenceState) => void;
	onLiveMessage: (message: ParsedWorldMessage, presence: PresenceState) => void;
	onTimelineMessage?: (message: ParsedWorldMessage) => void;
	onEffectiveTraceRootsChanged?: (roots: readonly ParsedWorldMessage[]) => void;
	onTraceReadSnapshotChanged?: (snapshot: TraceReadSnapshot) => void;
	onTraceConversationChanged?: (state: TraceConversationState) => void;
	onStatusChanged: (status: WorldReadConnectionStatus) => void;
	onSelfPositionWriteStateChanged?: (state: SelfPositionWriteState) => void;
	onSelfMessageAvailabilityChanged?: (state: SelfMessageAvailability) => void;
	authorizeSelfWrite?: () => Promise<SelfWriteAuthorizationResult>;
	onSelfWriteAuthorizationLost?: () => void;
	realtime?: RealtimeSessionOptions;
}>;

export type WorldReadSessionSelfAttachment = Readonly<{
	signer: ActiveSignerSnapshot;
	runNumber?: number;
	authorizeSelfWrite?: () => Promise<SelfWriteAuthorizationResult>;
	onSelfWriteAuthorizationLost?: () => void;
}>;

type BufferedLiveEvent =
	| Readonly<{ kind: 'message'; event: ParsedWorldMessage; rawEvent: NostrEvent }>
	| Readonly<{ kind: 'world-state'; event: ParsedWorldStateEvent }>
	| Readonly<{ kind: 'trace'; event: ParsedTraceEvent; rawEvent: NostrEvent }>;

type SelfPositionOperation = Readonly<{
	id: string;
	operation: SelfPositionOperationKind;
	reservation?: WorldWriteReservation;
	event?: VerifiedEvent;
	onEcho?: () => void;
}>;

type SelfMessageOperation = {
	id: string;
	echoConfirmed: boolean;
	onEcho?: () => void;
};

function bootstrapSince(nowMs: number): number {
	return Math.max(0, Math.floor((nowMs - PRESENCE_TIMEOUT_MS - BOOTSTRAP_SAFETY_MARGIN_MS) / 1000));
}

function hasRelayIssue(result: PrimaryStartResult): number {
	const primaryIssues = result.primaryPairs.filter((pair) => pair.status !== 'eose').length;
	return primaryIssues;
}

/**
 * Owns only the real-world read lifecycle. Viewer-local geometry and conversation
 * state stay in the page because their semantics depend on the current viewport.
 */
export function createWorldReadSession(input: WorldReadSessionOptions) {
	const options = input;
	let selfSigner = options.selfSigner ?? null;
	let authorizeSelfWriteCallback = options.authorizeSelfWrite;
	let onSelfWriteAuthorizationLostCallback = options.onSelfWriteAuthorizationLost;
	let disposed = false;
	let terminal = false;
	let started = false;
	let bootstrapComplete = false;
	let selfReadReady = false;
	let resolveSelfReadReady!: () => void;
	let rejectSelfReadReady!: (error: Error) => void;
	const selfReadReadyPromise = new Promise<void>((resolve, reject) => { resolveSelfReadReady = resolve; rejectSelfReadReady = reject; });
	void selfReadReadyPromise.catch(() => {});
	let journalScope: WorldWriteJournalScope | null = null;
	let journalSnapshot: WorldWriteJournalSnapshot | null = null;
	let journalLoaded = false;
	let journalLoadPromise: Promise<void> | null = null;
	let selfEvidenceReconciliation: Promise<void> = Promise.resolve();
	let selfEvidenceChecksPending = 0;
	let startupSecond = 0;
	const locallyConfirmedPositions: ParsedWorldStateEvent[] = [];
	const locallyConfirmedMessages: ParsedWorldMessage[] = [];
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
	let selfPositionWriteState: SelfPositionWriteState = selfSigner ? { kind: 'ready' } : { kind: 'unavailable' };
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let pendingSelfMessage: SelfMessageOperation | null = null;
	// Owns the entire reply pipeline, including coalesced position and post-position publication.
	let pendingTraceReply: { eventId: string | null } | null = null;
	let effectiveTraceRoots: readonly ParsedWorldMessage[] = [];
	let traceReadSnapshot: TraceReadSnapshot = { readRootIds: [], unreadReplyRootIds: [], hasUnreadReplies: false };
	let traceRootBootstrapReadiness: Promise<'ready' | 'failed'> | null = null;
	let traceStartupReadiness: Promise<'ready' | 'failed' | 'not-needed'> | null = null;
	let traceNotificationStartup: Promise<'ready' | 'failed' | 'not-needed'> | null = null;
	let traceConversationState: TraceConversationState = { kind: 'closed' };
	let traceConversationGeneration = 0;
	let realtimeEvents: RealtimeEnvelope[] = [];
	const realtimeControlIds = new Set<string>();
	let realtimeStatus: 'inactive' | 'active' | 'degraded' = 'inactive';
	let realtimeStartPromise: Promise<void> | null = null;
	let realtimeStartConfiguration: RealtimeStartConfiguration | null = null;
	let realtimeGeneration = 0;
	let traceReplyReconcileTail: Promise<void> = Promise.resolve();
	const pendingLiveEvents: BufferedLiveEvent[] = [];
	let selfPositionEvidence: PositionPublishEvidence = [];
	const positionEvidenceByPubkey = new Map<string, PositionPublishEvidence>();
	const retryableSelfOperations = new Map<string, SelfPositionOperation>();
	const appliedCanonicalPositionEventIds = new Set<string>();
	const appliedCanonicalMessageEventIds = new Set<string>();
	let preparedTerminalExit: Extract<TerminalExitPreparation, { kind: 'prepared' }> | null = null;
	let terminalExitCommitted = false;
	let terminalExitAttempted = false;
	let deathTraceEnabled = false;
	let deathTraceAttempted = false;

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
		const next: SelfMessageAvailability = !disposed && !terminal && selfEvidenceChecksPending === 0 &&
			Boolean(selfSigner && transport && channel && selfJoinedThisSession &&
				presence.participants.some((participant) => participant.id === selfSigner?.pubkey))
			? { kind: 'ready' }
			: { kind: 'unavailable' };
		if (next.kind === selfMessageAvailability.kind) return;
		selfMessageAvailability = next;
		if (!disposed) options.onSelfMessageAvailabilityChanged?.(next);
	}

	function receiveRealtimeEvent(rawEvent: NostrEvent): void {
		if (!channel || !options.realtime || disposed) return;
		const parsed = parseRealtimeEnvelope(rawEvent, channel.channelId, options.realtime.registry);
		if (!parsed || realtimeEvents.some((event) => event.event.id === parsed.event.id)) return;
		realtimeEvents = [...realtimeEvents, parsed];
		options.realtime.onEvent(parsed);
	}

	function receiveRealtimeControl(control: RealtimeControlEnvelope): void {
		if (disposed || realtimeControlIds.has(control.event.id)) return;
		realtimeControlIds.add(control.event.id);
		options.realtime?.onControl?.(control);
	}

	function sameRealtimeConfiguration(first: RealtimeStartConfiguration, second: RealtimeStartConfiguration): boolean {
		const normalize = (configuration: RealtimeStartConfiguration) => [
			configuration.controlSince,
			...normalizeRealtimeInstanceFilterConfigurations(configuration.instanceFilters)
				.map((filter) => [filter.protocolKey, filter.instanceIds, filter.since])
		];
		return JSON.stringify(normalize(first)) === JSON.stringify(normalize(second));
	}

	function stopRealtimeSubscription(): void {
		realtimeGeneration += 1;
		realtimeStartPromise = null;
		realtimeStartConfiguration = null;
		if (transport && 'stopRealtime' in transport && typeof transport.stopRealtime === 'function') transport.stopRealtime();
		realtimeStatus = 'inactive';
		options.realtime?.onStatusChanged?.(realtimeStatus);
	}

	function suspendRealtimeForTrace(): void {
		if (realtimeStartPromise || realtimeStatus !== 'inactive') stopRealtimeSubscription();
	}

	function startRealtimeSubscription(configuration?: RealtimeStartConfiguration): Promise<void> {
		const realtimeOptions = options.realtime;
		if (disposed || journalScope && !bootstrapComplete || !transport || !channel || !realtimeOptions?.registry.length) return Promise.resolve();
		const candidateConfiguration = configuration ?? realtimeOptions.getStartConfiguration?.() ?? {
			controlSince: realtimeOptions.controlSince,
			instanceFilters: realtimeOptions.instanceFilters
		};
		if (realtimeStartPromise && realtimeStartConfiguration && sameRealtimeConfiguration(realtimeStartConfiguration, candidateConfiguration)) return realtimeStartPromise;
		if (realtimeStartPromise) stopRealtimeSubscription();
		const nextConfiguration = realtimeOptions.prepareStartConfiguration?.(candidateConfiguration, Date.now()) ?? candidateConfiguration;
		const generation = realtimeGeneration;
		realtimeStartConfiguration = nextConfiguration;
		realtimeStatus = 'degraded';
		realtimeOptions.onStatusChanged?.(realtimeStatus);
		realtimeStartPromise = transport.startRealtime({
			eventTypes: realtimeOptions.registry,
		controlSince: nextConfiguration.controlSince,
		instanceFilters: nextConfiguration.instanceFilters,
		onBootstrapEvent: receiveRealtimeEvent,
		onLiveEvent: receiveRealtimeEvent,
		onBootstrapControl: receiveRealtimeControl,
		onLiveControl: receiveRealtimeControl
	}).then((realtime) => {
		if (disposed || generation !== realtimeGeneration) return;
		realtimeStatus = realtime.status === 'active' ? 'active' : 'degraded';
		realtimeOptions.onStatusChanged?.(realtimeStatus);
		for (const event of realtime.events) receiveRealtimeEvent(event);
		realtimeOptions.onBootstrapComplete?.(nextConfiguration);
	}).catch(() => {
		if (disposed || generation !== realtimeGeneration) return;
		realtimeStatus = 'degraded';
		realtimeOptions.onStatusChanged?.(realtimeStatus);
	});
		return realtimeStartPromise;
	}

	function prepareTerminalExit(expectedPubkey?: string): TerminalExitPreparation {
		if (disposed) return { kind: 'unavailable', reason: 'disposed' };
		terminal = true;
		if (!selfSigner || !channel) return { kind: 'unavailable', reason: 'missing-self' };
		if (expectedPubkey !== undefined && expectedPubkey !== selfSigner.pubkey) return { kind: 'unavailable', reason: 'identity-mismatch' };
		if (!started || !selfReadReady || !transport) return { kind: 'unavailable', reason: 'not-ready' };
		const self = worldPresence.participants.find((participant) => participant.pubkey === selfSigner!.pubkey);
		if (!self) return { kind: 'unavailable', reason: 'missing-position' };
		const latestPositionEvidence = Math.max(
			self.positionEvidence.createdAt,
			...selfPositionEvidence.map((event) => event.createdAt),
			0
		);
		const createdAt = Math.max(
			Math.floor(Date.now() / 1000),
			self.lastPositiveActivityCreatedAt ?? 0,
			latestPositionEvidence
		);
		const event = finalizeWorldEvent(buildWorldStateEventTemplate({
			channel,
			position: self.position,
			slot: 'exit',
			createdAt
		}), selfSigner.secretKey);
		const parsed = parseWorldStateEvent(event, channel.channelId);
		if (!parsed) throw new Error('Locally signed terminal exit did not pass the project parser.');
		preparedTerminalExit = { kind: 'prepared', event, parsed };
		return preparedTerminalExit;
	}

	function commitTerminalExit(exit: CommittedTerminalExit): void {
		if (!terminal || !preparedTerminalExit || !selfSigner || !channel || disposed) throw new Error('Terminal exit was not prepared.');
		const event = finalizeWorldEvent(buildWorldStateEventTemplate({
			channel, position: exit.position, slot: 'exit', createdAt: exit.createdAt
		}), selfSigner.secretKey);
		const parsed = parseWorldStateEvent(event, channel.channelId);
		if (!parsed || parsed.state !== 'exit') throw new Error('Committed terminal exit is invalid.');
		preparedTerminalExit = { kind: 'prepared', event, parsed };
		terminalExitCommitted = true;
	}

	async function publishTerminalExit(): Promise<TerminalExitPublishResult> {
		if (disposed || !terminal || !transport || !preparedTerminalExit || !terminalExitCommitted || terminalExitAttempted) return { kind: 'unavailable' };
		terminalExitAttempted = true;
		try {
			const handle = transport.publishSelf?.(preparedTerminalExit.event, selfSigner!.pubkey);
			return { kind: 'published', results: handle ? await handle.settled : await transport.publish(preparedTerminalExit.event) };
		} catch {
			return { kind: 'failed' };
		}
	}

	async function publishDeathLastWords(content: string): Promise<DeathLastWordsPublishResult> {
		if (disposed || !deathTraceEnabled || !terminal || !transport || !channel || !selfSigner || !preparedTerminalExit || deathTraceAttempted) {
			return { kind: 'unavailable' };
		}
		const trimmed = content.trim();
		if (!trimmed) return { kind: 'unavailable' };
		deathTraceAttempted = true;
		try {
			const event = finalizeWorldEvent(buildDeathTraceEventTemplate({
				channel,
				content: trimmed,
				position: preparedTerminalExit.parsed.position,
				createdAt: Math.max(
					Math.floor(Date.now() / 1000),
					preparedTerminalExit.parsed.createdAt
				)
			}), selfSigner.secretKey);
			const results = await transport.publish(event);
			if (!reachedAuthoritativeRelay(results)) return { kind: 'failed' };
			return { kind: 'published', eventId: event.id, results };
		} catch {
			return { kind: 'failed' };
		}
	}

	function enableDeathLastWords(): boolean {
		if (disposed || !terminal || !preparedTerminalExit || deathTraceAttempted) return false;
		deathTraceEnabled = true;
		return true;
	}

	async function authorizeSelfWrite(): Promise<boolean> {
		if (selfEvidenceChecksPending) await selfEvidenceReconciliation;
		if (terminal) return false;
		if (!authorizeSelfWriteCallback) return !terminal;
		const result = await authorizeSelfWriteCallback();
		if (selfEvidenceChecksPending) await selfEvidenceReconciliation;
		if (terminal) return false;
		if (result === 'authorized') return true;
		if (!disposed) {
			disposed = true;
			traceConversationGeneration += 1;
			pendingLiveEvents.splice(0);
			transport?.dispose();
			onSelfWriteAuthorizationLostCallback?.();
		}
		return false;
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

	function refreshTraceReadSnapshot(): void {
		if (!channel || !selfSigner || disposed) return;
		void loadTraceReadSnapshot({ channelId: channel.channelId, personaPubkey: selfSigner.pubkey }).then((snapshot) => {
			if (disposed) return;
			traceReadSnapshot = snapshot;
			options.onTraceReadSnapshotChanged?.(snapshot);
		}).catch(() => {});
	}

	function reconcileTraceRoots(rawEvents: readonly NostrEvent[]): Promise<void> {
		if (!channel || disposed) return Promise.resolve();
		return reconcileTraceRootCache({
			channelId: channel.channelId,
			field: options.field,
			rawEvents
		}).then((roots) => {
			if (disposed) return;
			effectiveTraceRoots = roots;
			reconcileOpenTraceRoot(roots);
			options.onEffectiveTraceRootsChanged?.(roots);
			refreshTraceReadSnapshot();
		}).catch(() => {
			// Trace is viewer-local supplemental state and never changes world status.
		});
	}

	function startTraceNotification(): Promise<'ready' | 'failed' | 'not-needed'> {
		if (!traceRootBootstrapReadiness || !selfSigner) return Promise.resolve('not-needed');
		if (traceNotificationStartup) return traceNotificationStartup;
		traceNotificationStartup = traceRootBootstrapReadiness.then(async (readiness) => {
			if (readiness !== 'ready' || disposed || !transport) return 'failed' as const;
			if (typeof transport.configureTraceReplies !== 'function') return 'not-needed' as const;
			const notification = traceNotificationConfig();
			if (!notification) return 'not-needed' as const;
			const result = await transport.configureTraceReplies({
				notification,
				onBatch: (batch) => { void reconcileTraceReplies(traceConversationGeneration, undefined, batch.events); },
				onLiveEvent: (event) => { void reconcileTraceReplies(traceConversationGeneration, undefined, [event]); }
			}).catch(() => {});
			if (result?.status === 'active') await reconcileTraceReplies(traceConversationGeneration, undefined, result.initialBatch.events);
			return result?.status === 'active' ? 'ready' as const : 'failed' as const;
		}).catch(() => 'failed' as const);
		return traceNotificationStartup;
	}

	function startTraceBackground(): void {
		void reconcileTraceRoots([]);
		if (!transport) return;
		traceRootBootstrapReadiness = transport.bootstrapTraceRootCandidates().then(async (result) => {
			await reconcileTraceRoots(result.rawEvents);
			return 'ready' as const;
		}).catch(() => {
			return 'failed' as const;
		});
		traceStartupReadiness = startTraceNotification();
	}

	function traceNotificationConfig() {
		if (!selfSigner || !options.onTraceReadSnapshotChanged) return undefined;
		return {
			personaPubkey: selfSigner.pubkey,
			initialSince: Math.floor(selfSigner.identityCreatedAtMs / 1000)
		};
	}

	function applyCanonicalMessage(message: ParsedWorldMessage, nowMs: number, rawEvent?: NostrEvent): boolean {
		if (appliedCanonicalMessageEventIds.has(message.id)) return false;
		if (terminal && pendingSelfMessage?.id === message.id) return false;
		appliedCanonicalMessageEventIds.add(message.id);
		if (!disposed) options.onTimelineMessage?.(message);
		if (pendingSelfMessage?.id === message.id) {
			pendingSelfMessage.echoConfirmed = true;
			pendingSelfMessage.onEcho?.();
			if (!locallyConfirmedMessages.some((known) => known.id === message.id)) locallyConfirmedMessages.push(message);
		}
		if (message.createdAt < messageSince) return true;
		worldPresence = applyWorldPresenceMessage(worldPresence, message);
		const nextPresence = project(nowMs);
		if (!disposed) options.onLiveMessage(message, nextPresence);
		if (rawEvent) reconcileTraceRoots([rawEvent]);
		return true;
	}

	function applyLiveMessage(message: ParsedWorldMessage, rawEvent: NostrEvent, nowMs: number): void {
		if (journalScope && pendingSelfMessage?.id === message.id) {
			void authorizeSelfWrite().then((authorized) => {
				if (authorized && !disposed && !terminal) applyCanonicalMessage(message, Date.now(), rawEvent);
			}).catch(() => {});
			return;
		}
		applyCanonicalMessage(message, nowMs, rawEvent);
	}

	function applyLivePosition(event: ParsedWorldStateEvent, nowMs: number): void {
		reconcileSelfWorldState(event);
		observeLivePosition(event);
		const ownOperation = pendingSelfOperation?.id === event.id ? pendingSelfOperation : retryableSelfOperations.get(event.id);
		if (journalScope && ownOperation?.reservation && ownOperation.event) {
			void confirmWorldPosition(journalScope, ownOperation.reservation, ownOperation.event).then((confirmed) => {
				if (confirmed && !disposed && !terminal) applyCanonicalPosition(event, Date.now());
			}).catch(() => {});
			return;
		}
		applyCanonicalPosition(event, nowMs);
	}

	// Bootstrap evidence is already parser/signature-verified by the transport.
	// It can safely improve the visible field before final EOSE, but it must not
	// produce conversation or make self writes available before canonical handoff.
	function applyBootstrapMessage(message: ParsedWorldMessage, nowMs: number): void {
		if (journalScope && pendingSelfMessage?.id === message.id) {
			void authorizeSelfWrite().then((authorized) => {
				if (authorized && !disposed && !terminal) applyCanonicalMessage(message, Date.now());
			}).catch(() => {});
			return;
		}
		if (message.createdAt < messageSince) return;
		worldPresence = applyWorldPresenceMessage(worldPresence, message);
		project(nowMs);
	}

	function applyBootstrapPosition(event: ParsedWorldStateEvent, nowMs: number): void {
		reconcileSelfWorldState(event);
		if (journalScope && (pendingSelfOperation?.id === event.id || retryableSelfOperations.has(event.id))) {
			applyLivePosition(event, nowMs);
			return;
		}
		observeLivePosition(event);
		worldPresence = applyWorldPresenceWorldState(worldPresence, event);
		project(nowMs);
	}

	function observeLivePosition(event: ParsedWorldStateEvent): void {
		const retained = retainPositionPublishEvidence(positionEvidenceByPubkey.get(event.pubkey) ?? [], event, event.pubkey);
		positionEvidenceByPubkey.set(event.pubkey, retained);
		if (!selfSigner || event.pubkey !== selfSigner.pubkey) return;
		selfPositionEvidence = retained;
		positionPublishState = reconstructPositionPublishState(selfPositionEvidence, selfSigner.pubkey);
	}

	function applyCanonicalPosition(event: ParsedWorldStateEvent, nowMs: number): boolean {
		if (appliedCanonicalPositionEventIds.has(event.id)) return false;
		if (terminal && event.state === 'active' && selfSigner && event.pubkey === selfSigner.pubkey &&
			(pendingSelfOperation?.id === event.id || retryableSelfOperations.has(event.id))) return false;
		appliedCanonicalPositionEventIds.add(event.id);
		worldPresence = applyWorldPresenceWorldState(worldPresence, event);
		const nextPresence = project(nowMs);
		if (selfSigner && event.pubkey === selfSigner.pubkey) {
			selfJoinedThisSession = nextPresence.participants.some((participant) =>
				participant.id === event.pubkey && participant.status === 'active'
			);
			const pendingOperation = pendingSelfOperation?.id === event.id ? pendingSelfOperation : null;
			const retryableOperation = retryableSelfOperations.get(event.id);
			if (pendingOperation || retryableOperation) {
				if (!locallyConfirmedPositions.some((known) => known.id === event.id)) locallyConfirmedPositions.push(event);
				pendingOperation?.onEcho?.();
				if (retryableOperation?.reservation && retryableOperation.event && journalScope) {
					void confirmWorldPosition(journalScope, retryableOperation.reservation, retryableOperation.event).catch(() => {});
				}
			}
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

	function journalCoversWorldState(event: ParsedWorldStateEvent, snapshot: WorldWriteJournalSnapshot | null): boolean {
		if (!snapshot) return false;
		if (event.createdAt <= (snapshot.exitSecond ?? -1) || event.createdAt < (snapshot.lastPositiveSecond ?? -1)) return true;
		if (event.state === 'exit') return false;
		const confirmed = snapshot.confirmedPosition && channel ? parseWorldStateEvent(snapshot.confirmedPosition, channel.channelId) : null;
		if (snapshot.confirmedPosition && !confirmed) return false;
		if (confirmed && confirmed.createdAt === event.createdAt && confirmed.slot === event.slot && confirmed.id !== event.id) return false;
		return event.createdAt < (snapshot.lastReservedSecond ?? -1) ||
			event.createdAt === snapshot.lastReservedSecond && event.slot !== null && event.slot < snapshot.consumedSlots;
	}

	function conflictResyncStorageKey(): string | null {
		if (typeof window === 'undefined' || !journalScope) return null;
		return `world-self-conflict-resync:${journalScope.channelId}:${journalScope.identity.pubkey}:${journalScope.runNumber}`;
	}

	function conflictResyncAlreadyAttempted(): boolean {
		const key = conflictResyncStorageKey();
		if (!key) return false;
		try { return window.sessionStorage.getItem(key) === 'attempted'; } catch { return false; }
	}

	function markConflictResyncAttempted(): boolean {
		const key = conflictResyncStorageKey();
		if (!key) return false;
		try {
			if (window.sessionStorage.getItem(key) === 'attempted') return false;
			window.sessionStorage.setItem(key, 'attempted');
			return true;
		} catch {
			// Keep the writer stopped when the per-tab reload latch cannot be persisted.
			return false;
		}
	}

	function stopConflictingSelfWriter(requestResync = true): void {
		if (disposed || terminal) return;
		terminal = true;
		refreshSelfMessageAvailability();
		emitSelfPositionWriteState({ kind: 'unavailable' });
		if (requestResync && markConflictResyncAttempted()) onSelfWriteAuthorizationLostCallback?.();
	}

	function reconcileSelfWorldState(event: ParsedWorldStateEvent): void {
		if (disposed || terminal || !journalScope || !journalLoaded || !selfSigner || event.pubkey !== selfSigner.pubkey) return;
		if (pendingSelfOperation?.id === event.id || retryableSelfOperations.has(event.id) ||
			locallyConfirmedPositions.some((known) => known.id === event.id) ||
			journalSnapshot?.confirmedPosition?.id === event.id || journalCoversWorldState(event, journalSnapshot)) return;
		selfEvidenceChecksPending += 1;
		refreshSelfMessageAvailability();
		selfEvidenceReconciliation = selfEvidenceReconciliation.then(async () => {
			if (disposed || terminal || !journalScope) return;
			const latest = await loadWorldWriteJournal(journalScope);
			if (disposed || terminal) return;
			if (latest?.confirmedPosition?.id === event.id || journalCoversWorldState(event, latest)) {
				journalSnapshot = latest;
				return;
			}
			stopConflictingSelfWriter();
		}).catch(stopConflictingSelfWriter).finally(() => {
			selfEvidenceChecksPending -= 1;
			refreshSelfMessageAvailability();
		});
	}

	function ensureJournalLoaded(): Promise<void> {
		if (journalLoaded) return Promise.resolve();
		if (journalLoadPromise) return journalLoadPromise;
		journalLoadPromise = (async () => {
			if (journalScope) {
				journalSnapshot = await loadWorldWriteJournal(journalScope);
				const confirmed = journalSnapshot?.confirmedPosition;
				const parsed = confirmed && channel ? parseWorldStateEvent(confirmed, channel.channelId) : null;
				if (confirmed && (!parsed || parsed.pubkey !== journalScope.identity.pubkey)) throw new Error('World write journal is invalid.');
				if (parsed && parsed.state === 'active' && parsed.createdAt > (journalSnapshot?.exitSecond ?? -1)) {
					if (!locallyConfirmedPositions.some((known) => known.id === parsed.id)) locallyConfirmedPositions.push(parsed);
					observeLivePosition(parsed);
					worldPresence = applyWorldPresenceWorldState(worldPresence, parsed);
					project(Date.now());
				}
			}
			journalLoaded = true;
			if (conflictResyncAlreadyAttempted()) stopConflictingSelfWriter(false);
	})();
		return journalLoadPromise;
	}

	function requiresNewRunEntry(): boolean {
		return Boolean(journalScope && journalScope.runNumber > 1 && !selfJoinedThisSession && !journalSnapshot?.confirmedPosition);
	}

	async function waitForActualSecond(afterSecond: number): Promise<boolean> {
		while (!disposed && !terminal && Math.floor(Date.now() / 1000) <= afterSecond) {
			const until = (afterSecond + 1) * 1000 - Date.now();
			await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.min(until, 1000))));
		}
		return !disposed && !terminal;
	}

	function selfOperationCandidate(
		operation: Exclude<SelfPositionOperationKind, 'trace-inspection' | 'trace-reply'>,
		direction?: Direction
	): Readonly<{ event: VerifiedEvent; parsed: ParsedWorldStateEvent; previousState: PositionPublishState }> | null {
		if (!selfSigner || !channel) return null;
		const nowMs = Date.now();
		const state = currentPresence();
		let candidate: PresenceState;
		if (operation === 'entry') {
			candidate = enterParticipant(state, selfSigner.pubkey, nowMs);
		} else if (operation === 'reactivation') {
			candidate = recordPresenceActivity(state, selfSigner.pubkey, 'movement', nowMs);
		} else {
			if (!direction) return null;
			const movement = moveParticipant(state, selfSigner.pubkey, direction, nowMs);
			if (!movement.moved) return null;
			candidate = movement.state;
		}
		const participant = getParticipant(candidate, selfSigner.pubkey);
		if (!participant) return null;
		const latestExitCreatedAt = operation === 'entry'
			? worldPresence.participants.find((known) => known.pubkey === selfSigner!.pubkey)?.latestExitCreatedAt ?? null
			: null;
		return positionCandidate(participant.position, nowMs, latestExitCreatedAt === null ? 0 : latestExitCreatedAt + 1);
	}

	function positionCandidate(
		position: ParsedWorldStateEvent['position'],
		nowMs: number,
		minimumCreatedAt = 0
	): Readonly<{ event: VerifiedEvent; parsed: ParsedWorldStateEvent; previousState: PositionPublishState }> | null {
		if (!selfSigner || !channel) return null;
		const createdAt = journalScope ? Math.floor(nowMs / 1000) : Math.max(Math.floor(nowMs / 1000), minimumCreatedAt);
		if (createdAt < minimumCreatedAt) return null;
		const previousState = positionPublishState;
		const plan = planPositionPublish(positionPublishState, createdAt);
		if (plan.kind === 'unavailable') return null;
		const signed = finalizeWorldEvent(buildWorldStateEventTemplate({
			channel,
			position,
			slot: plan.slot,
			createdAt
		}), selfSigner.secretKey);
		const parsed = parseWorldStateEvent(signed, channel.channelId);
		if (!parsed) throw new Error('Locally signed position event did not pass the project parser.');
		positionPublishState = plan.nextState;
		selfPositionEvidence = retainPositionPublishEvidence(selfPositionEvidence, parsed, selfSigner.pubkey);
		positionEvidenceByPubkey.set(selfSigner.pubkey, selfPositionEvidence);
		return { event: signed, parsed, previousState };
	}

	function selfMessageCandidate(content: string, speechType: SpeechType, createdAt = Math.floor(Date.now() / 1000)): Readonly<{ event: VerifiedEvent; parsed: ParsedWorldMessage }> | null {
		if (!selfSigner || !channel || !selfJoinedThisSession) return null;
		const nowMs = Date.now();
		const state = currentPresence();
		const current = getParticipant(state, selfSigner.pubkey);
		if (!current) return null;
		const candidate = current.status === 'inactive'
			? recordPresenceActivity(state, selfSigner.pubkey, 'message', nowMs)
			: state;
		const participant = getParticipant(candidate, selfSigner.pubkey);
		if (!participant) return null;
		const signed = finalizeWorldEvent(buildWorldMessageTemplate({
			channel,
			content,
			speechType,
			position: participant.position,
			createdAt
		}), selfSigner.secretKey);
		const parsed = parseWorldMessage(signed, channel.channelId);
		if (!parsed) throw new Error('Locally signed world message did not pass the project parser.');
		return { event: signed, parsed };
	}

	async function publishMessage(content: string, speechType: SpeechType, messageDedupeId?: string): Promise<SelfMessagePublishResult> {
		if (disposed || terminal || !selfSigner || !transport || !channel) return { kind: 'unavailable' };
		if (pendingSelfMessage || pendingTraceReply) return { kind: 'pending' };
		if (journalScope) await ensureJournalLoaded();
		let createdAt = Math.floor(Date.now() / 1000);
		if (journalScope) {
			for (;;) {
				const observedExitSecond = worldPresence.participants.find((known) => known.pubkey === selfSigner?.pubkey)?.latestExitCreatedAt ?? null;
				const reserved = await reserveWorldPositive({ scope: journalScope, kind: 'message', nowSecond: createdAt,
					observedSecond: positionPublishState.lastPublishSecond, observedConsumedSlots: positionPublishState.consumedSlots,
					observedExitSecond, ...(messageDedupeId ? { messageDedupeId } : {}) });
				if (reserved.kind === 'wait') {
					if (!await waitForActualSecond(reserved.untilSecond - 1)) return { kind: 'unavailable' };
					createdAt = Math.floor(Date.now() / 1000);
					continue;
				}
				if (reserved.kind === 'duplicate') return { kind: 'duplicate' };
				if (reserved.kind !== 'reserved') {
					if (reserved.kind === 'stale') await authorizeSelfWrite();
					else {
						terminal = true;
						refreshSelfMessageAvailability();
						emitSelfPositionWriteState({ kind: 'unavailable' });
					}
					return { kind: 'unavailable' };
				}
				createdAt = reserved.reservation.createdAt;
				break;
			}
		}
		const candidate = selfMessageCandidate(content, speechType, createdAt);
		if (!candidate) return { kind: 'blocked' };
		const { event, parsed } = candidate;
		let resolveEcho!: () => void;
		const echoed = new Promise<void>((resolve) => { resolveEcho = resolve; });
		pendingSelfMessage = { id: parsed.id, echoConfirmed: false, onEcho: resolveEcho };
		if (!await authorizeSelfWrite() || terminal) {
			if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
			return { kind: 'unavailable' };
		}

		try {
			if (journalScope && transport.publishSelf) {
				const handle = transport.publishSelf(event, selfSigner.pubkey);
				void handle.settled.catch(() => {});
				const confirmed = await Promise.race([handle.firstSuccess.then((success) => success ? 'ack' as const : 'none' as const),
					echoed.then(() => 'echo' as const)]);
				if (disposed || terminal || !await authorizeSelfWrite().catch(() => false)) {
					if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
					return { kind: 'unavailable' };
				}
				if (confirmed === 'ack' || confirmed === 'echo') {
					applyCanonicalMessage(parsed, Date.now(), event);
					if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
					return { kind: 'succeeded', eventId: parsed.id };
				}
				await handle.settled.catch(() => []);
				if (disposed || terminal || !await authorizeSelfWrite().catch(() => false)) {
					if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
					return { kind: 'unavailable' };
				}
				const echoConfirmed = pendingSelfMessage?.id === parsed.id && pendingSelfMessage.echoConfirmed;
				if (echoConfirmed) {
					applyCanonicalMessage(parsed, Date.now(), event);
					pendingSelfMessage = null;
					return { kind: 'succeeded', eventId: parsed.id };
				}
				if (pendingSelfMessage?.id === parsed.id) pendingSelfMessage = null;
				return { kind: 'retryable' };
			}
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
		candidate: Readonly<{ event: VerifiedEvent; parsed: ParsedWorldStateEvent; previousState: PositionPublishState }>
	): Promise<SelfPositionWriteResult> {
		const { event, parsed } = candidate;
		let reservation: WorldWriteReservation | undefined;
		if (journalScope) {
			const observedExitSecond = worldPresence.participants.find((known) => known.pubkey === selfSigner?.pubkey)?.latestExitCreatedAt ?? null;
			const reserved = await reserveWorldPositive({ scope: journalScope, kind: 'position', nowSecond: parsed.createdAt,
				observedSecond: candidate.previousState.lastPublishSecond, observedConsumedSlots: candidate.previousState.consumedSlots,
				observedExitSecond,
				...(operation === 'entry' && requiresNewRunEntry()
					? { freshAfterSecond: candidate.previousState.lastPublishSecond ?? -1 }
					: operation === 'entry' && !bootstrapComplete && !journalSnapshot ? { freshAfterSecond: startupSecond } : {}) });
			if (reserved.kind === 'wait' && operation === 'entry') {
				if (!await waitForActualSecond(reserved.untilSecond - 1)) return { kind: 'unavailable' };
				const active = getParticipant(currentPresence(), selfSigner!.pubkey);
				if (bootstrapComplete && !requiresNewRunEntry() && active?.status === 'active' && !isBlockedFacilityCell(active.position)) {
					selfJoinedThisSession = true;
					refreshSelfMessageAvailability();
					return { kind: 'not-needed' };
				}
				const next = selfOperationCandidate('entry');
				return next ? publishPreparedSelfPosition('entry', next) : { kind: 'blocked' };
			}
			if (reserved.kind !== 'reserved') {
				if (reserved.kind === 'stale') await authorizeSelfWrite();
				else if (reserved.kind !== 'wait') {
					terminal = true;
					refreshSelfMessageAvailability();
					emitSelfPositionWriteState({ kind: 'unavailable' });
				}
				return { kind: reserved.kind === 'wait' ? 'blocked' : 'unavailable' };
			}
			if (reserved.reservation.createdAt !== parsed.createdAt || reserved.reservation.slot !== parsed.slot) {
				onSelfWriteAuthorizationLostCallback?.();
				return { kind: 'unavailable' };
			}
			reservation = reserved.reservation;
			journalSnapshot = { lastReservedSecond: parsed.createdAt, consumedSlots: parsed.slot === 0 ? 1 : 2,
				lastPositiveSecond: parsed.createdAt, exitSecond: journalSnapshot?.exitSecond ?? null,
				confirmedPosition: journalSnapshot?.confirmedPosition ?? null };
		}
		// The planner was consumed before this call. It must never be rolled back.
		let resolveEcho!: () => void;
		const echoed = new Promise<void>((resolve) => { resolveEcho = resolve; });
		pendingSelfOperation = { id: parsed.id, operation, event, ...(reservation ? { reservation } : {}), onEcho: resolveEcho };
		latestSelfOperationId = parsed.id;
		emitSelfPositionWriteState({ kind: 'pending', operation });
		if (!await authorizeSelfWrite() || terminal) {
			if (pendingSelfOperation?.id === parsed.id) pendingSelfOperation = null;
			emitSelfPositionWriteState({ kind: 'unavailable' });
			return { kind: 'unavailable' };
		}
		try {
			const publishSelf = (transport as Partial<NonNullable<typeof transport>>).publishSelf;
			const handle = reservation && publishSelf ? publishSelf(event, selfSigner!.pubkey) : null;
			if (handle) {
				void handle.settled.catch(() => {});
				const confirmed = await Promise.race([handle.firstSuccess.then((success) => success ? 'ack' as const : 'none' as const),
					echoed.then(() => 'echo' as const)]);
				if (confirmed === 'ack' || confirmed === 'echo') {
					if (disposed || terminal) return { kind: 'unavailable' };
					if (journalScope && reservation) {
						let confirmedPosition = false;
						try { confirmedPosition = await confirmWorldPosition(journalScope, reservation, event); } catch { /* Fail closed below. */ }
						if (!confirmedPosition) {
							await authorizeSelfWrite().catch(() => false);
							terminal = true;
							if (pendingSelfOperation?.id === parsed.id) pendingSelfOperation = null;
							refreshSelfMessageAvailability();
							emitSelfPositionWriteState({ kind: 'unavailable' });
							return { kind: 'unavailable' };
						}
					}
					applyCanonicalPosition(parsed, Date.now());
					return { kind: 'succeeded', operation };
				}
				await handle.settled.catch(() => []);
				if (disposed || terminal) return { kind: 'unavailable' };
				if (pendingSelfOperation?.id !== parsed.id) return { kind: 'succeeded', operation };
				retryableSelfOperations.set(parsed.id, pendingSelfOperation);
				pendingSelfOperation = null;
				emitSelfPositionWriteState({ kind: 'retryable', operation });
				return { kind: 'retryable', operation };
			}
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
		operation: Exclude<SelfPositionOperationKind, 'trace-inspection' | 'trace-reply'>,
		direction?: Direction
	): Promise<SelfPositionWriteResult> {
		if (!selfSigner) {
			emitSelfPositionWriteState({ kind: 'unavailable' });
			return { kind: 'unavailable' };
		}
		if (disposed || terminal) return { kind: 'unavailable' };
		if (pendingSelfOperation || pendingTraceReply) return { kind: 'pending' };
		const candidate = selfOperationCandidate(operation, direction);
		if (!candidate) return { kind: 'blocked' };
		return publishPreparedSelfPosition(operation, candidate);
	}

	/** Best-effort positive activity refresh for successful browser-local actions. */
	async function refreshSelfActivity(): Promise<SelfPositionWriteResult> {
		if (disposed || terminal || !selfSigner || !transport || !channel) return { kind: 'unavailable' };
		if ((!bootstrapComplete && !(journalScope && selfReadReady)) || !selfJoinedThisSession) return { kind: 'blocked' };
		if (pendingSelfOperation || pendingSelfMessage || pendingTraceReply) return { kind: 'pending' };
		const participant = getParticipant(currentPresence(), selfSigner.pubkey);
		if (!participant || participant.status !== 'active') return { kind: 'blocked' };
		const nowMs = Date.now();
		const createdAt = Math.floor(nowMs / 1000);
		const coalesced = selfPositionEvidence.some((event) =>
			event.state === 'active' && event.createdAt === createdAt && event.position.x === participant.position.x && event.position.y === participant.position.y
		);
		if (coalesced) return { kind: 'not-needed' };
		const candidate = positionCandidate(participant.position, nowMs);
		if (!candidate) return { kind: 'not-needed' };
		return publishPreparedSelfPosition('game-action', candidate);
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

	function applyTraceReplySnapshot(generation: number, replies: readonly ParsedTraceReply[]): void {
		if (disposed || generation !== traceConversationGeneration || traceConversationState.kind !== 'open') return;
		const next: TraceConversationState = { ...traceConversationState, replies };
		if (resolveTraceConversationProjection(next)) {
			emitTraceConversationState(next);
			return;
		}
		const fallbackGeneration = ++traceConversationGeneration;
		const config = { rootId: next.root.id, currentId: next.root.id };
		emitTraceConversationState({ ...next, config, replyRefresh: 'loading' });
		void startTraceConversationWork(fallbackGeneration, next.root, config);
	}

	function reconcileTraceReplies(
		generation: number,
		rootId: string | undefined,
		rawEvents: readonly NostrEvent[]
	): Promise<boolean> {
		let success = false;
		traceReplyReconcileTail = traceReplyReconcileTail.then(async () => {
			if (!channel) return;
			try {
				const currentOpenRootId = traceConversationState.kind === 'open'
					? traceConversationState.root.id
					: undefined;
				const replies = await reconcileTraceReplyCache({
					channelId: channel.channelId,
					effectiveRoots: effectiveTraceRoots,
					rawEvents,
					...(selfSigner ? { personaPubkey: selfSigner.pubkey } : {}),
					...(currentOpenRootId ? { currentOpenRootId } : {})
				});
				success = true;
				refreshTraceReadSnapshot();
				const visibleRootId = rootId ?? (traceConversationState.kind === 'open' ? traceConversationState.root.id : null);
				if (visibleRootId) applyTraceReplySnapshot(generation, replies.filter((reply) => reply.rootId === visibleRootId));
			} catch {
				// A supplemental cache failure does not affect primary world reads.
			}
		});
		return traceReplyReconcileTail.then(() => success);
	}

	function receiveTraceBatch(generation: number, rootId: string, batch: TraceReplyBatch): void {
		void receiveTraceReplies(generation, rootId, batch.events);
	}

	function receiveTraceReplies(generation: number, rootId: string, events: readonly NostrEvent[]): Promise<boolean> {
		// Filter before enqueue: terminal completion must not admit a previously withheld echo.
		const admitted = events.filter((event) => event.id !== pendingTraceReply?.eventId);
		if (events.length > 0 && admitted.length === 0) return Promise.resolve(true);
		return reconcileTraceReplies(generation, rootId, admitted);
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
		await reconcileTraceReplies(generation, config.rootId, []);
		if (disposed || generation !== traceConversationGeneration) return;
		const readiness = traceRootBootstrapReadiness ? await traceRootBootstrapReadiness : 'failed';
		if (disposed || generation !== traceConversationGeneration) return;
		if (readiness !== 'ready') {
			updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
			return;
		}
		try {
			suspendRealtimeForTrace();
			if (disposed || generation !== traceConversationGeneration) return;
			const result = await transport.configureTraceReplies({
				...(traceNotificationConfig() ? { notification: traceNotificationConfig() } : {}),
				conversation: config,
				onBatch: (batch) => receiveTraceBatch(generation, config.rootId, batch),
				onLiveEvent: (event) => { void receiveTraceReplies(generation, config.rootId, [event]); }
			});
			if (disposed || generation !== traceConversationGeneration || result.status === 'superseded') return;
			if (result.status !== 'active') {
				updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
				void startRealtimeSubscription();
				return;
			}
			const reconciled = await receiveTraceReplies(generation, config.rootId, result.initialBatch.events);
			updateTraceConversation(generation, (current) => ({
				...current,
				replyRefresh: reconciled ? 'settled' : 'unavailable'
			}));
			void startRealtimeSubscription();
		} catch {
			updateTraceConversation(generation, (current) => ({ ...current, replyRefresh: 'unavailable' }));
			void startRealtimeSubscription();
		}
	}

	function activateTraceConversation(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		const generation = ++traceConversationGeneration;
		emitTraceConversationState(traceStateFor(root, config, [], 'loading'));
		void startTraceConversationWork(generation, root, config);
	}

	function activateDeathTraceConversation(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		const generation = ++traceConversationGeneration;
		emitTraceConversationState(traceStateFor(root, config, [], 'settled'));
		reconfigureTraceBackground(generation, () =>
			traceConversationState.kind === 'open' &&
			traceConversationState.root.id === root.id &&
			traceConversationState.root.source === 'death'
		);
	}

	function activateTraceRootConversation(root: ParsedWorldMessage, config: TraceConversationConfig): void {
		if (root.source === 'death') activateDeathTraceConversation(root, config);
		else activateTraceConversation(root, config);
	}

	function openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
		if (disposed || !selfSigner || !transport || !channel) return { kind: 'unavailable' };
		if (!bootstrapComplete) return { kind: 'blocked' };
		const root = effectiveTraceRoots.find((candidate) => candidate.id === config.rootId);
		if (!root || config.currentId !== root.id) return { kind: 'blocked' };
		if (traceConversationState.kind === 'open' && traceConversationState.root.id === root.id) {
			return traceConversationState.config.currentId === config.currentId
				? selectTraceConversationSpeech(config.currentId)
				: { kind: 'blocked' };
		}
		if (pendingSelfOperation || pendingTraceReply) return { kind: 'pending' };
		const nowMs = Date.now();
		const prepared = prepareTraceInspectionActivity({
			presence: currentPresence(),
			selfId: selfSigner.pubkey,
			target: root.position,
			nowMs,
		});
		if (prepared.kind === 'blocked') return { kind: 'blocked' };
		if (!prepared.coalesced) {
			const candidate = positionCandidate(prepared.position, nowMs);
			if (!candidate) return { kind: 'blocked' };
			void publishPreparedSelfPosition('trace-inspection', candidate);
		}
		activateTraceRootConversation(root, config);
		return { kind: 'opened' };
	}

	function selectTraceConversationSpeech(targetId: string): TraceConversationOpenResult {
		if (disposed || !selfSigner || !transport || !channel) return { kind: 'unavailable' };
		if (!bootstrapComplete || traceConversationState.kind === 'closed') return { kind: 'blocked' };
		const pendingTraceInspection = pendingSelfOperation?.operation === 'trace-inspection';
		if (pendingTraceReply || (pendingSelfOperation && !pendingTraceInspection)) return { kind: 'pending' };
		const current = traceConversationState;
		if (current.root.source === 'death') return targetId === current.root.id ? { kind: 'opened' } : { kind: 'blocked' };
		const projection = resolveTraceConversationProjection(current);
		const target = projection ? projection.current.event.id === targetId
			? projection.current : adjacentTraceSpeech(projection, targetId) : null;
		if (!target) return { kind: 'blocked' };
		const nowMs = Date.now();
		const prepared = prepareTraceInspectionActivity({
			presence: currentPresence(),
			selfId: selfSigner.pubkey,
			target: current.root.position,
			nowMs,
			requireCurrentRange: true
		});
		if (prepared.kind === 'blocked') return { kind: 'blocked' };
		if (!prepared.coalesced && !pendingTraceInspection) {
			const candidate = positionCandidate(prepared.position, nowMs);
			if (!candidate) return { kind: 'blocked' };
			void publishPreparedSelfPosition('trace-inspection', candidate);
		}
		if (current.config.currentId === targetId) return { kind: 'opened' };
		const config = { rootId: current.root.id, currentId: target.event.id };
		const generation = ++traceConversationGeneration;
		emitTraceConversationState({ ...current, config, replyRefresh: 'loading' });
		void startTraceConversationWork(generation, current.root, config);
		return { kind: 'opened' };
	}

	function reconfigureTraceBackground(generation: number, isCurrent: () => boolean): void {
		const reconfigure = async () => {
			const readiness = traceRootBootstrapReadiness ? await traceRootBootstrapReadiness : 'failed';
			if (disposed || generation !== traceConversationGeneration || !isCurrent() || readiness !== 'ready') return;
			const notification = traceNotificationConfig();
			suspendRealtimeForTrace();
			if (disposed || generation !== traceConversationGeneration || !isCurrent()) return;
			try {
				if (typeof transport?.configureTraceReplies === 'function') {
					await transport.configureTraceReplies({
						...(notification ? { notification } : {}),
						onBatch: (batch) => { void reconcileTraceReplies(traceConversationGeneration, undefined, batch.events); },
						onLiveEvent: (event) => { void reconcileTraceReplies(traceConversationGeneration, undefined, [event]); }
					});
				}
			} catch {
				// Trace configuration is supplemental; realtime still owns its independent recovery.
			} finally {
				if (!disposed && generation === traceConversationGeneration && isCurrent()) void startRealtimeSubscription();
			}
		};
		void reconfigure();
	}

	function deactivateTraceSubscription(generation: number): void {
		reconfigureTraceBackground(generation, () => traceConversationState.kind === 'closed');
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
		const self = selfSigner
			? getParticipant(projectWorldPresenceState(worldPresence, Date.now()), selfSigner.pubkey)
			: undefined;
		if (!fallback || !self || !isWithinTraceInvestigationRange(self.position, fallback.position)) {
			closeTraceConversation();
			return;
		}
		activateTraceRootConversation(fallback, { rootId: fallback.id, currentId: fallback.id });
	}

	function receiveLive(event: BufferedLiveEvent): void {
		if (disposed) return;
		if (!bootstrapComplete) {
			pendingLiveEvents.push(event);
			return;
		}
		if (event.kind === 'message') applyLiveMessage(event.event, event.rawEvent, Date.now());
		else if (event.kind === 'world-state') applyLivePosition(event.event, Date.now());
		else void reconcileTraceRoots([event.rawEvent]);
	}

	function resolveReplyTarget(rootId: string, targetId: string) {
		if (traceConversationState.kind !== 'open' || traceConversationState.root.id !== rootId) return null;
		const { root, replies } = traceConversationState;
		const target = targetId === root.id ? root : replies.find((reply) => reply.id === targetId);
		return target ? { root, target, replies } : null;
	}

	async function publishTraceReply(input: TraceReplyPublication): Promise<TraceReplyPublishResult> {
		if (disposed || terminal || !selfSigner || !transport || !channel) return { kind: 'unavailable' };
		if (!bootstrapComplete || !selfJoinedThisSession) return { kind: 'blocked' };
		if (pendingSelfOperation || pendingSelfMessage || pendingTraceReply) return { kind: 'pending' };
		const accepted = resolveReplyTarget(input.rootId, input.targetId);
		if (!accepted) return { kind: 'blocked' };
		if (accepted.root.source === 'death') return { kind: 'blocked' };
		const operation = { eventId: null as string | null };
		pendingTraceReply = operation;
		try {
			if (!await authorizeSelfWrite() || terminal) return { kind: 'unavailable' };
			const nowMs = Date.now();
			const prepared = prepareTraceInspectionActivity({
				presence: currentPresence(), selfId: selfSigner.pubkey,
				target: accepted.root.position, nowMs, requireCurrentRange: true, activity: 'trace-reply'
			});
			if (prepared.kind === 'blocked') return { kind: 'out-of-range' };
			if (!prepared.coalesced) {
				const candidate = positionCandidate(prepared.position, nowMs);
				if (!candidate) return { kind: 'blocked' };
				const positionResult = await publishPreparedSelfPosition('trace-reply', candidate);
				if (disposed) return { kind: 'unavailable' };
				if (positionResult.kind !== 'succeeded') return { kind: 'position-failed' };
			}
			const self = getParticipant(currentPresence(), selfSigner.pubkey);
			if (!self || !isWithinTraceInvestigationRange(self.position, accepted.root.position)) return { kind: 'out-of-range' };
			if (self.status !== 'active') return { kind: 'blocked' };
			const event = finalizeWorldEvent(buildTraceReplyTemplate({
				root: accepted.root, parent: accepted.target, content: input.content, speechType: input.speechType,
				createdAt: Math.floor(Date.now() / 1000)
			}), selfSigner.secretKey);
			if (!await authorizeSelfWrite() || terminal) return { kind: 'unavailable' };
			operation.eventId = event.id;
			const results = await transport.publish(event);
			if (disposed) return { kind: 'unavailable' };
			if (!reachedAuthoritativeRelay(results)) return { kind: 'reply-failed' };
			// Use the current generation only for the same open root. Cache semantics decide retention.
			const generation = traceConversationState.kind === 'open' && traceConversationState.root.id === accepted.root.id
				? traceConversationGeneration : -1;
			await reconcileTraceReplies(generation, accepted.root.id, [event]);
			return { kind: 'succeeded', eventId: event.id };
		} catch {
			return { kind: disposed ? 'unavailable' : 'reply-failed' };
		} finally {
			if (pendingTraceReply === operation) pendingTraceReply = null;
		}
	}

	return {
		async start(): Promise<WorldReadBootstrap> {
			if (started) throw new Error('World read session start is only allowed once.');
			started = true;
			const world = resolvePrototypeWorldConfig();
			channel = { channelId: world.channelId, relayHint: world.preferredRelayHint };
			transport = createNostrRelayTransport(world);
			emitStatus({ kind: 'bootstrapping' });
			const nowMs = Date.now();
			startupSecond = Math.floor(nowMs / 1000);
			if (selfSigner && options.selfRunNumber !== undefined) journalScope = {
				identity: selfSigner.identity, runNumber: options.selfRunNumber, channelId: world.channelId
			};
			const since = bootstrapSince(nowMs);
			messageSince = since;

			try {
				const result = await transport.start({
					messageSince: since,
					worldStateSince: since,
					onEarlySelfReadReady: () => {
						if (disposed || selfReadReady) return;
						selfReadReady = true;
						resolveSelfReadReady();
					},
					onBootstrapMessage: (event) => applyBootstrapMessage(event, Date.now()),
					onBootstrapWorldState: (event) => applyBootstrapPosition(event, Date.now()),
					onBootstrapTrace: () => {},
					onLiveMessage: (event, rawEvent) => receiveLive({ kind: 'message', event, rawEvent }),
					onLiveWorldState: (event) => receiveLive({ kind: 'world-state', event }),
					onLiveTrace: (event, rawEvent) => receiveLive({ kind: 'trace', event, rawEvent }),
					onPrimaryClosed: markDegraded
				});
				if (!selfReadReady) {
					selfReadReady = true;
					resolveSelfReadReady();
				}
				if (disposed) throw new Error('World read session was disposed during startup.');

				const recentMessages = result.messages.filter((message) => message.createdAt >= messageSince);
				worldPresence = reconstructWorldPresenceState(options.field,
					[...new Map([...recentMessages, ...locallyConfirmedMessages].map((event) => [event.id, event])).values()],
					[...new Map([...result.worldStates, ...locallyConfirmedPositions].map((event) => [event.id, event])).values()]);
				for (const event of result.messages) appliedCanonicalMessageEventIds.add(event.id);
				for (const event of result.worldStates) {
					appliedCanonicalPositionEventIds.add(event.id);
					observeLivePosition(event);
				}
				channel = result.channel;
				const nextPresence = project(Date.now());
				const issueCount = hasRelayIssue(result);
				emitStatus(issueCount === 0 ? { kind: 'available' } : { kind: 'degraded', issueCount });
				startTraceBackground();
				if (options.realtime?.registry.length && options.realtime.startImmediately !== false) {
					void (traceStartupReadiness ?? Promise.resolve<'not-needed'>('not-needed')).then(() => {
						if (!disposed) return startRealtimeSubscription();
						return undefined;
					});
				}
				return {
					messages: recentMessages,
					timelineMessages: result.messages,
					worldStates: result.worldStates,
					presence: nextPresence,
					status,
					realtimeEvents: [...realtimeEvents],
					realtimeStatus
				};
			} catch (error) {
				rejectSelfReadReady(error instanceof Error ? error : new Error('Relay startup failed.'));
				if (!disposed) {
					const message = error instanceof Error ? error.message : 'Relay startup failed.';
					emitStatus({ kind: 'failed', message });
				}
				throw error;
			}
		},

		whenSelfReadReady(): Promise<void> {
			return selfReadReadyPromise;
		},

		async attachSelf(attachment: WorldReadSessionSelfAttachment): Promise<void> {
			if (disposed) throw new Error('Cannot attach self to a disposed world session.');
			if (!started || !selfReadReady || !transport || !channel) {
				throw new Error('World session must reach the bounded primary read boundary before attaching self.');
			}
			if (selfSigner) throw new Error('World session already has a self attached.');
			selfSigner = attachment.signer;
			if (attachment.runNumber !== undefined) journalScope = { identity: attachment.signer.identity,
				runNumber: attachment.runNumber, channelId: channel.channelId };
			authorizeSelfWriteCallback = attachment.authorizeSelfWrite;
			onSelfWriteAuthorizationLostCallback = attachment.onSelfWriteAuthorizationLost;
			selfPositionEvidence = positionEvidenceByPubkey.get(selfSigner.pubkey) ?? [];
			positionPublishState = reconstructPositionPublishState(selfPositionEvidence, selfSigner.pubkey);
			for (const pubkey of positionEvidenceByPubkey.keys()) {
				if (pubkey !== selfSigner.pubkey) positionEvidenceByPubkey.delete(pubkey);
			}
			await ensureJournalLoaded();
			if (terminal) return;
			emitSelfPositionWriteState({ kind: 'ready' });
			refreshSelfMessageAvailability();
			refreshTraceReadSnapshot();
			if (bootstrapComplete) {
				traceStartupReadiness = startTraceNotification();
				void traceStartupReadiness.then(() => {
					if (!disposed && options.realtime?.registry.length) void startRealtimeSubscription();
				}).catch(() => {});
			}
		},

		completeBootstrap(): void {
			if (disposed || !started || bootstrapComplete) return;
			bootstrapComplete = true;
			const buffered = pendingLiveEvents.splice(0);
			for (const event of buffered) receiveLive(event);
			if (selfSigner && !traceStartupReadiness) {
				traceStartupReadiness = startTraceNotification();
				void traceStartupReadiness.then(() => {
					if (!disposed && options.realtime?.registry.length) void startRealtimeSubscription();
				}).catch(() => {});
			}
		},

		async enterSelf(): Promise<SelfPositionWriteResult> {
			if (disposed || terminal) return Promise.resolve({ kind: 'unavailable' });
			if (!bootstrapComplete && !(journalScope && selfReadReady)) return { kind: 'blocked' };
			if (pendingTraceReply) return Promise.resolve({ kind: 'pending' });
			if (!selfSigner) return publishSelfPosition('entry');
			if (journalScope) await ensureJournalLoaded();
			const alreadyActive = getParticipant(currentPresence(), selfSigner.pubkey);
			if (!requiresNewRunEntry() && alreadyActive?.status === 'active' && !isBlockedFacilityCell(alreadyActive.position)) {
				selfJoinedThisSession = true;
				refreshSelfMessageAvailability();
				emitSelfPositionWriteState({ kind: 'ready' });
				return { kind: 'not-needed' };
			}
			if (journalScope && !journalSnapshot && !bootstrapComplete) {
				if (!await waitForActualSecond(startupSecond)) return { kind: 'unavailable' };
			}
			const participant = getParticipant(currentPresence(), selfSigner.pubkey);
			if (!requiresNewRunEntry() && participant?.status === 'active' && !isBlockedFacilityCell(participant.position)) {
				selfJoinedThisSession = true;
				refreshSelfMessageAvailability();
				emitSelfPositionWriteState({ kind: 'ready' });
				return { kind: 'not-needed' };
			}
			return publishSelfPosition('entry');
		},

		moveSelf(direction: Direction): Promise<SelfPositionWriteResult> {
			if (disposed || terminal) return Promise.resolve({ kind: 'unavailable' });
			if (!bootstrapComplete && !(journalScope && selfReadReady)) return Promise.resolve({ kind: 'blocked' });
			if (!selfSigner) return publishSelfPosition('movement', direction);
			const participant = getParticipant(currentPresence(), selfSigner.pubkey);
			if (!participant) return publishSelfPosition('entry');
			return publishSelfPosition(
				participant.status === 'inactive' && selfJoinedThisSession ? 'reactivation' : 'movement',
				direction
			);
		},

		publishMessage(content: string, speechType: SpeechType, messageDedupeId?: string): Promise<SelfMessagePublishResult> {
			return publishMessage(content, speechType, messageDedupeId);
		},

		refreshSelfActivity,

		publishTraceReply,

		async getTracePreviewEvent(rootId: string, targetId: string): Promise<NostrEvent | null> {
			if (disposed || !channel) return null;
			const accepted = resolveReplyTarget(rootId, targetId);
			if (!accepted) return null;
			const parent = 'parentId' in accepted.target && accepted.target.parentId !== accepted.root.id
				? accepted.replies.find((reply) => reply.id === (accepted.target as ParsedTraceReply).parentId)
				: accepted.root;
			if (!parent) return null;
			try {
				return await loadTracePreviewEvent({ channelId: channel.channelId, root: accepted.root, target: accepted.target, parent });
			} catch { return null; }
		},

		openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult {
			return openTraceConversation(config);
		},
		selectTraceConversationSpeech(targetId: string): TraceConversationOpenResult {
			return selectTraceConversationSpeech(targetId);
		},

		closeTraceConversation(): void {
			closeTraceConversation();
		},

		refresh(nowMs: number): PresenceState {
			if (disposed) return presence;
			return project(nowMs);
		},

		publish(event: VerifiedEvent): Promise<readonly PublishRelayResult[]> {
			if (disposed || terminal || !transport) throw new Error('World read session must start before publishing.');
			return authorizeSelfWrite().then((authorized) => {
				if (!authorized || terminal) throw new Error('Self-write authorization was lost.');
				return transport!.publish(event);
			});
		},

		publishRealtime(event: VerifiedEvent) {
			if (disposed || terminal || !transport) throw new Error('World read session must start before publishing.');
			return authorizeSelfWrite().then((authorized) => {
				if (!authorized || terminal) throw new Error('Self-write authorization was lost.');
				return transport!.publishRealtime(event);
			});
		},

		prepareTerminalExit,
		commitTerminalExit,

		publishTerminalExit,

		enableDeathLastWords,

		publishDeathLastWords,

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
		},

		markTraceRootRead(rootId: string): Promise<boolean> {
			if (disposed || !channel || !selfSigner) return Promise.resolve(false);
			return markTraceRootRead({ channelId: channel.channelId, personaPubkey: selfSigner.pubkey, rootId })
				.then((changed) => {
					if (changed) refreshTraceReadSnapshot();
					return changed;
				}).catch(() => false);
		},

		markTraceReplyRead(rootId: string, replyId: string): Promise<boolean> {
			if (disposed || !channel || !selfSigner) return Promise.resolve(false);
			return markTraceReplyRead({ channelId: channel.channelId, personaPubkey: selfSigner.pubkey, rootId, replyId })
				.then((changed) => {
					if (changed) refreshTraceReadSnapshot();
					return changed;
				}).catch(() => false);
		},

		getTraceReadSnapshot(): TraceReadSnapshot {
			return traceReadSnapshot;
		},

		getRealtimeEvents(): readonly RealtimeEnvelope[] {
			return realtimeEvents;
		},

		getRealtimeStatus(): 'inactive' | 'active' | 'degraded' {
			return realtimeStatus;
		},

		startRealtime(): Promise<void> {
			return startRealtimeSubscription();
		},

		stopRealtime(): void {
			stopRealtimeSubscription();
		},

		getChannel(): ChannelReference | null {
			return channel;
		}
	};
}
