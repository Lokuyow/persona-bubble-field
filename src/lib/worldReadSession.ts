import {
	createNostrRelayTransport,
	type PrimaryPairDiagnostic,
	type PrimaryStartResult,
	type PublishRelayResult
} from './nostrRelayTransport';
import {
	buildPositionEventTemplate,
	finalizeWorldEvent,
	parsePositionEvent,
	type ChannelReference,
	type ParsedPositionEvent,
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
import type { VerifiedEvent } from 'nostr-tools/pure';
import type { AccountSnapshot } from './nostrAccount';
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

const BOOTSTRAP_SAFETY_MARGIN_MS = 60_000;

export type WorldReadConnectionStatus =
	| Readonly<{ kind: 'bootstrapping' }>
	| Readonly<{ kind: 'available' }>
	| Readonly<{ kind: 'degraded'; issueCount: number }>
	| Readonly<{ kind: 'failed'; message: string }>;

export type WorldReadBootstrap = Readonly<{
	messages: readonly ParsedWorldMessage[];
	positions: readonly ParsedPositionEvent[];
	presence: PresenceState;
	status: WorldReadConnectionStatus;
}>;

export type SelfPositionWriteState =
	| Readonly<{ kind: 'ready' }>
	| Readonly<{ kind: 'pending'; operation: 'entry' | 'movement' | 'reactivation' }>
	| Readonly<{ kind: 'succeeded'; operation: 'entry' | 'movement' | 'reactivation' }>
	| Readonly<{ kind: 'retryable'; operation: 'entry' | 'movement' | 'reactivation' }>
	| Readonly<{ kind: 'unavailable' }>;

export type SelfPositionWriteResult =
	| Readonly<{ kind: 'not-needed' | 'blocked' | 'unavailable' | 'pending' }>
	| Readonly<{ kind: 'succeeded'; operation: 'entry' | 'movement' | 'reactivation' }>
	| Readonly<{ kind: 'retryable'; operation: 'entry' | 'movement' | 'reactivation' }>;

export type WorldReadSessionOptions = Readonly<{
	field: PresenceField;
	selfAccount?: AccountSnapshot | null;
	onPresenceChanged: (presence: PresenceState) => void;
	onLiveMessage: (message: ParsedWorldMessage, presence: PresenceState) => void;
	onStatusChanged: (status: WorldReadConnectionStatus) => void;
	onSelfPositionWriteStateChanged?: (state: SelfPositionWriteState) => void;
}>;

type BufferedLiveEvent =
	| Readonly<{ kind: 'message'; event: ParsedWorldMessage }>
	| Readonly<{ kind: 'position'; event: ParsedPositionEvent }>;

type SelfPositionOperation = Readonly<{
	id: string;
	operation: 'entry' | 'movement' | 'reactivation';
}>;

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
	let worldPresence: WorldPresenceState = reconstructWorldPresenceState(options.field, [], []);
	let presence = projectWorldPresenceState(worldPresence, Date.now());
	let status: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let positionPublishState: PositionPublishState = createPositionPublishState();
	let selfJoinedThisSession = false;
	let pendingSelfOperation: SelfPositionOperation | null = null;
	let latestSelfOperationId: string | null = null;
	let selfPositionWriteState: SelfPositionWriteState = options.selfAccount ? { kind: 'ready' } : { kind: 'unavailable' };
	const pendingLiveEvents: BufferedLiveEvent[] = [];
	const knownSelfPositionEvents = new Map<string, ParsedPositionEvent>();
	const handedOffSelfPositionEvents = new Map<string, ParsedPositionEvent>();
	const retryableSelfOperations = new Map<string, SelfPositionOperation>();
	const appliedCanonicalPositionEventIds = new Set<string>();

	function emitStatus(next: WorldReadConnectionStatus): void {
		status = next;
		if (!disposed) options.onStatusChanged(status);
	}

	function emitSelfPositionWriteState(next: SelfPositionWriteState): void {
		selfPositionWriteState = next;
		if (!disposed) options.onSelfPositionWriteStateChanged?.(next);
	}

	function project(nowMs: number): PresenceState {
		presence = projectWorldPresenceState(worldPresence, nowMs);
		if (!disposed) options.onPresenceChanged(presence);
		return presence;
	}

	function markDegraded(_diagnostic: PrimaryPairDiagnostic): void {
		if (disposed || status.kind === 'failed') return;
		const issueCount = status.kind === 'degraded' ? status.issueCount + 1 : 1;
		emitStatus({ kind: 'degraded', issueCount });
	}

	function applyLiveMessage(message: ParsedWorldMessage, nowMs: number): void {
		worldPresence = applyWorldPresenceMessage(worldPresence, message);
		const nextPresence = project(nowMs);
		if (!disposed) options.onLiveMessage(message, nextPresence);
	}

	function applyLivePosition(event: ParsedPositionEvent, nowMs: number): void {
		observeLivePosition(event);
		applyCanonicalPosition(event, nowMs);
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
		}
		return true;
	}

	function currentPresence(): PresenceState {
		return project(Date.now());
	}

	function selfOperationCandidate(
		operation: 'entry' | 'movement' | 'reactivation',
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
		const createdAt = Math.floor(nowMs / 1000);
		const plan = planPositionPublish(positionPublishState, createdAt);
		if (plan.kind === 'unavailable') return null;
		const signed = finalizeWorldEvent(buildPositionEventTemplate({
			channel,
			position: participant.position,
			slot: plan.slot,
			createdAt
		}), options.selfAccount.secretKey);
		const parsed = parsePositionEvent(signed, channel.channelId);
		if (!parsed) throw new Error('Locally signed position event did not pass the project parser.');
		positionPublishState = plan.nextState;
		handedOffSelfPositionEvents.set(parsed.id, parsed);
		return { event: signed, parsed };
	}

	async function publishSelfPosition(operation: 'entry' | 'movement' | 'reactivation', direction?: Direction): Promise<SelfPositionWriteResult> {
		if (!options.selfAccount) {
			emitSelfPositionWriteState({ kind: 'unavailable' });
			return { kind: 'unavailable' };
		}
		if (disposed) return { kind: 'unavailable' };
		if (pendingSelfOperation) return { kind: 'pending' };
		const candidate = selfOperationCandidate(operation, direction);
		if (!candidate) return { kind: 'blocked' };
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

	function receiveLive(event: BufferedLiveEvent): void {
		if (disposed) return;
		if (!bootstrapComplete) {
			pendingLiveEvents.push(event);
			return;
		}
		if (event.kind === 'message') applyLiveMessage(event.event, Date.now());
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

			try {
				const result = await transport.start({
					messageSince: since,
					positionSince: since,
					onLiveMessage: (event) => receiveLive({ kind: 'message', event }),
					onLivePosition: (event) => receiveLive({ kind: 'position', event }),
					onPrimaryClosed: markDegraded
				});
				if (disposed) throw new Error('World read session was disposed during startup.');

				worldPresence = reconstructWorldPresenceState(options.field, result.messages, result.positions);
				for (const event of result.positions) {
					appliedCanonicalPositionEventIds.add(event.id);
					observeLivePosition(event);
				}
				channel = result.metadata.channel;
				const nextPresence = project(Date.now());
				const issueCount = hasRelayIssue(result);
				emitStatus(issueCount === 0 ? { kind: 'available' } : { kind: 'degraded', issueCount });
				return { messages: result.messages, positions: result.positions, presence: nextPresence, status };
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
			if (!options.selfAccount) return publishSelfPosition('entry');
			const participant = getParticipant(currentPresence(), options.selfAccount.pubkey);
			if (participant?.status === 'active') {
				selfJoinedThisSession = true;
				emitSelfPositionWriteState({ kind: 'ready' });
				return Promise.resolve({ kind: 'not-needed' });
			}
			return publishSelfPosition('entry');
		},

		moveSelf(direction: Direction): Promise<SelfPositionWriteResult> {
			if (!options.selfAccount) return publishSelfPosition('movement', direction);
			const participant = getParticipant(currentPresence(), options.selfAccount.pubkey);
			if (!participant) return publishSelfPosition('entry');
			return publishSelfPosition(
				participant.status === 'inactive' && selfJoinedThisSession ? 'reactivation' : 'movement',
				direction
			);
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
			pendingLiveEvents.splice(0);
			transport?.dispose();
		},

		getStatus(): WorldReadConnectionStatus {
			return status;
		},

		getSelfPositionWriteState(): SelfPositionWriteState {
			return selfPositionWriteState;
		}
	};
}
