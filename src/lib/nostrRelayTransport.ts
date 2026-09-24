import {
	Nip11Registry,
	createRxForwardReq,
	createRxNostr,
	createRxOneshotReq,
	noopSigner,
	type ConnectionState,
	type EventPacket,
	type IWebSocketConstructor,
	type LazyFilter,
	type OutgoingMessagePacket,
	type RxReq,
	type RxNostr
} from 'rx-nostr';
import { Subscription } from 'rxjs';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import {
	buildWorldStateFilter,
	buildTraceDirectReplyFilter,
	buildTraceNotificationFilter,
	buildTraceReplyFilter,
	buildTraceRootBootstrapFilters,
	buildWorldMessageFilters,
	parseWorldStateEvent,
	parseWorldMessage,
	parseTraceEvent,
	CHANNEL_MESSAGE_KIND,
	WORLD_STATE_KIND,
	type ParsedWorldStateEvent,
	type ParsedWorldMessage,
	type ParsedTraceEvent,
	worldStateIdentifiers,
	PROTOTYPE_NAMESPACE,
	RECENT_MESSAGE_TIMELINE_LIMIT
} from './nostrProtocol';
import {
	buildRealtimeControlFilter,
	buildRealtimeInstanceFilter,
	normalizeRealtimeInstanceFilterConfigurations,
	parseRealtimeControlEnvelope,
	REALTIME_CONTROL_PROTOCOL_KEY,
	REALTIME_EVENT_KIND,
	type RealtimeControlEnvelope,
	type RealtimeEventRegistry,
	type RealtimeInstanceFilterConfiguration
} from './realtimeEvents';
import { assertPrototypeWorldConfig, type PrototypeWorldConfig } from './prototypeWorld';

const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const EARLY_SELF_READ_DEADLINE_MS = 750;
const TRACE_REPLY_RESUME_OVERLAP_SECONDS = 300;

export type LogicalPrimarySubscription = 'world-messages' | 'world-state';
export type PrimaryPairStatus = 'pending' | 'eose' | 'closed' | 'unavailable' | 'timeout';
export type RelayCapacity = 'insufficient' | 'primary-only' | 'trace-capable' | 'unknown';
export type RelayQueryStatus = 'eose' | 'closed' | 'unavailable' | 'timeout';
export type RelayQueryDiagnostic = Readonly<{
	relayUrl: string;
	status: RelayQueryStatus;
	notice?: string;
}>;

export type PrimaryPairDiagnostic = Readonly<{
	relayUrl: string;
	subscription: LogicalPrimarySubscription;
	/** start() returns a bootstrap snapshot; getDiagnostics() also reflects later CLOSED. */
	status: PrimaryPairStatus;
	notice?: string;
}>;

export type RelayConnectionDiagnostic = Readonly<{
	relayUrl: string;
	state: ConnectionState;
}>;

export type Nip11Diagnostic = Readonly<{
	relayUrl: string;
	maxSubscriptions: number | null;
	capacity: RelayCapacity;
}>;

export type TraceReplyRelayDiagnostic = Readonly<{
	relayUrl: string;
	status: 'pending' | RelayQueryStatus;
	notice?: string;
}>;

export type RealtimeRelayDiagnostic = Readonly<{
	relayUrl: string;
	status: 'pending' | RelayQueryStatus;
	notice?: string;
}>;

export type RealtimeEventBatch = Readonly<{
	events: readonly Event[];
	relays: readonly RealtimeRelayDiagnostic[];
}>;

export type TraceReplyBatch = Readonly<{
	events: readonly Event[];
	relays: readonly TraceReplyRelayDiagnostic[];
}>;

export type TraceReplyNotificationConfig = Readonly<{
	personaPubkey: string;
	effectiveRootIds?: readonly string[];
	initialSince: number;
}>;

export type TraceReplyConversationConfig = Readonly<{
	rootId: string;
	currentId: string;
}>;

export type TraceReplyConfiguration = Readonly<{
	notification?: TraceReplyNotificationConfig;
	conversation?: TraceReplyConversationConfig;
	onBatch: (batch: TraceReplyBatch) => void;
	onLiveEvent: (event: Event) => void;
}>;

export type TraceReplyConfigurationResult =
	| Readonly<{ status: 'active'; generation: number; initialBatch: TraceReplyBatch }>
	| Readonly<{ status: 'inactive'; generation: number }>
	| Readonly<{ status: 'superseded'; generation: number }>;

export type TraceReplyDiagnostics = Readonly<{
	generation: number;
	status: 'initializing' | 'active' | 'inactive';
	relays: readonly TraceReplyRelayDiagnostic[];
}>;

export type NostrRelayTransportDiagnostics = Readonly<{
	primaryPairs: readonly PrimaryPairDiagnostic[];
	connections: readonly RelayConnectionDiagnostic[];
	nip11: readonly Nip11Diagnostic[];
	traceReplies: TraceReplyDiagnostics | null;
	realtime: Readonly<{ status: 'inactive' | 'initializing' | 'active'; relays: readonly RealtimeRelayDiagnostic[] }>;
}>;

export type PrimaryStartInput = Readonly<{
	messageSince: number;
	worldStateSince: number;
	/**
	 * A validated primary event received while the finite bootstrap is still in
	 * progress. Consumers may project presence from it, but must not treat it as
	 * a canonical conversation handoff until start() resolves.
	 */
	onBootstrapMessage: (event: ParsedWorldMessage) => void;
	onBootstrapWorldState: (event: ParsedWorldStateEvent) => void;
	onBootstrapTrace?: (event: ParsedTraceEvent) => void;
	/** A verified, event-ID-deduped live message and its cache-authoritative wire event. */
	onLiveMessage: (event: ParsedWorldMessage, rawEvent: Event) => void;
	onLiveWorldState: (event: ParsedWorldStateEvent) => void;
	onLiveTrace?: (event: ParsedTraceEvent, rawEvent: Event) => void;
	onPrimaryClosed: (diagnostic: PrimaryPairDiagnostic) => void;
	/** Primary reads continue after this bounded self-read boundary. */
	onEarlySelfReadReady?: () => void;
}>;

export type PrimaryStartResult = Readonly<{
	channel: Readonly<{ channelId: string; relayHint: string }>;
	messages: readonly ParsedWorldMessage[];
	worldStates: readonly ParsedWorldStateEvent[];
	traces: readonly ParsedTraceEvent[];
	primaryPairs: readonly PrimaryPairDiagnostic[];
	nip11: readonly Nip11Diagnostic[];
}>;

export type SelfPublishHandle = Readonly<{
	firstSuccess: Promise<boolean>;
	settled: Promise<readonly PublishRelayResult[]>;
}>;

export type TraceRootBootstrapResult = Readonly<{
	rawEvents: readonly Event[];
	relays: readonly RelayQueryDiagnostic[];
}>;

export type RealtimeStartInput = Readonly<{
	eventTypes: RealtimeEventRegistry;
	controlSince: number;
	instanceFilters: readonly RealtimeInstanceFilterConfiguration[];
	onBootstrapEvent: (event: Event) => void;
	onLiveEvent: (event: Event) => void;
	onBootstrapControl?: (control: RealtimeControlEnvelope) => void;
	onLiveControl?: (control: RealtimeControlEnvelope) => void;
}>;

export type RealtimeStartResult = Readonly<{
	status: 'active' | 'inactive';
	events: readonly Event[];
	controls: readonly RealtimeControlEnvelope[];
	relays: readonly RealtimeRelayDiagnostic[];
}>;

export type RealtimePublishResult = Readonly<{
	outcome: 'accepted' | 'echoed' | 'unconfirmed';
	results: readonly PublishRelayResult[];
}>;

export type PublishRelayResult = Readonly<{
	relayUrl: string;
	outcome: 'accepted' | 'rejected' | 'no-response';
	notice?: string;
}>;

export type NostrRelayTransportOptions = Readonly<{
	operationTimeoutMs?: number;
	websocketCtor?: IWebSocketConstructor;
}>;

type TransportState = 'new' | 'starting' | 'started' | 'failed' | 'disposed';
type PrimaryPairKey = `${string}\u0000${LogicalPrimarySubscription}`;
type TraceScopeKind = 'notification' | 'root' | 'direct';
type TraceScopeForm = 'initial' | 'continuation';
type TraceCycleKind = 'initial' | 'catch-up';

type TraceScope = Readonly<{
	key: string;
	kind: TraceScopeKind;
	initialFilter: Filter;
	initialSince?: number;
}>;

type TraceCycle = {
	kind: TraceCycleKind;
	cycleBoundary: number;
	events: Event[];
	timer: ReturnType<typeof setTimeout> | null;
};

type TraceRelayState = {
	relayUrl: string;
	req: RxReq<'forward'> & { emit(filters: LazyFilter | LazyFilter[]): void };
	subscription: Subscription;
	subId: string | null;
	forms: Map<string, TraceScopeForm>;
	stableCursors: Map<string, number>;
	provisionalCursors: Map<string, number>;
	initialStatus: TraceReplyRelayDiagnostic;
	cycle: TraceCycle | null;
};

type TraceGeneration = {
	id: number;
	semanticKey: string;
	scopes: readonly TraceScope[];
	states: Map<string, TraceRelayState>;
	resources: Subscription;
	seenIds: Set<string>;
	initialEvents: Event[];
	initialSettled: boolean;
	active: boolean;
	initialDeadline: ReturnType<typeof setTimeout> | null;
	callbacks: Pick<TraceReplyConfiguration, 'onBatch' | 'onLiveEvent'>;
	resolve: (result: TraceReplyConfigurationResult) => void;
	reject: (error: Error) => void;
	settledResult: TraceReplyConfigurationResult | null;
	initialPromise: Promise<TraceReplyConfigurationResult>;
};

function assertTimestamp(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer in Unix seconds.`);
	}
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

function pairKey(relayUrl: string, subscription: LogicalPrimarySubscription): PrimaryPairKey {
	return `${relayUrl}\u0000${subscription}`;
}

function isTerminal(status: PrimaryPairStatus): boolean {
	return status !== 'pending';
}

function isConnectionUnavailable(state: ConnectionState): boolean {
	return state === 'error' || state === 'rejected';
}

function isInitialConnectionUnavailable(state: ConnectionState, requestSent: boolean): boolean {
	return isConnectionUnavailable(state)
		|| !requestSent && (state === 'waiting-for-retrying' || state === 'retrying');
}

function filterEntries(filter: unknown): readonly [string, unknown][] | null {
	if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return null;
	return Object.entries(filter as Record<string, unknown>).filter(([, value]) => value !== undefined);
}

function hasExactly(values: unknown, expected: readonly (string | number)[]): boolean {
	if (!Array.isArray(values)) return false;
	const actual = new Set(values);
	const target = new Set(expected);
	return actual.size === target.size && [...target].every((value) => actual.has(value));
}

function classifyPrimaryFilter(
	filters: readonly unknown[],
	channelId: string,
	worldStateIds: readonly string[]
): LogicalPrimarySubscription | null {
	const isMessageFilter = (candidate: unknown, kind: 'recent' | 'history'): boolean => {
		const entries = filterEntries(candidate);
		if (!entries) return false;
		const filter = Object.fromEntries(entries) as Record<string, unknown>;
		const allowedKeys = new Set(['kinds', '#e', '#L', '#l', kind === 'recent' ? 'since' : 'limit']);
		if (!entries.every(([key]) => allowedKeys.has(key)) ||
			!hasExactly(filter.kinds, [CHANNEL_MESSAGE_KIND]) ||
			!hasExactly(filter['#e'], [channelId]) ||
			!hasExactly(filter['#L'], [PROTOTYPE_NAMESPACE]) ||
			!hasExactly(filter['#l'], kind === 'recent' ? ['chat', 'trace'] : ['chat'])) return false;
		if (kind === 'recent') return Number.isSafeInteger(filter.since) && (filter.since as number) >= 0;
		return filter.limit === RECENT_MESSAGE_TIMELINE_LIMIT;
	};

	if (filters.length === 2 &&
		filters.some((filter) => isMessageFilter(filter, 'recent')) &&
		filters.some((filter) => isMessageFilter(filter, 'history'))) return 'world-messages';

	if (filters.length !== 1) return null;
	const entries = filterEntries(filters[0]);
	if (!entries) return null;
	const filter = Object.fromEntries(entries) as Record<string, unknown>;
	if (!Number.isSafeInteger(filter.since) || (filter.since as number) < 0) return null;
	const allowedPositionKeys = new Set(['kinds', '#e', '#d', 'since']);
	const isWorldState = entries.every(([key]) => allowedPositionKeys.has(key)) &&
		hasExactly(filter.kinds, [WORLD_STATE_KIND]) &&
		hasExactly(filter['#e'], [channelId]) &&
		hasExactly(filter['#d'], worldStateIds);
	return isWorldState ? 'world-state' : null;
}

function reqFromOutgoing(packet: OutgoingMessagePacket): { subId: string; filters: readonly unknown[] } | null {
	if (!Array.isArray(packet.message) || packet.message[0] !== 'REQ' || typeof packet.message[1] !== 'string') {
		return null;
	}
	return { subId: packet.message[1], filters: packet.message.slice(2) };
}

/** Compare query conditions, ignoring key order and semantically absent values. */

function matchesQueryFilter(filters: readonly unknown[], expected: Filter): boolean {
		return filters.some((candidate) => matchesFilter(candidate, expected));
}

function matchesFilter(candidate: unknown, expected: Filter): boolean {
	const actualEntries = filterEntries(candidate);
	const expectedEntries = filterEntries(expected);
	if (!actualEntries || !expectedEntries || actualEntries.length !== expectedEntries.length) return false;
	const actual = Object.fromEntries(actualEntries);
	return expectedEntries.every(([key, value]) => Array.isArray(value)
		? hasExactly(actual[key], value)
		: actual[key] === value);
}

function matchesRealtimeFilterBundle(actual: readonly unknown[], expected: readonly Filter[]): boolean {
	return actual.length === expected.length && expected.every((filter) => matchesQueryFilter(actual, filter));
}

function matchesRealtimeEventFilter(event: Event, filter: Filter): boolean {
	const candidate = filter as Record<string, unknown>;
	if (Array.isArray(candidate.kinds) && !candidate.kinds.includes(event.kind)) return false;
	if (Array.isArray(candidate.authors) && !candidate.authors.includes(event.pubkey)) return false;
	if (typeof candidate.since === 'number' && event.created_at < candidate.since) return false;
	for (const [key, value] of Object.entries(candidate)) {
		if (!key.startsWith('#') || !Array.isArray(value)) continue;
		const tagValues = event.tags.filter((tag) => tag[0] === key.slice(1)).map((tag) => tag[1]);
		if (!value.some((expected) => tagValues.includes(expected as string))) return false;
	}
	return true;
}

function matchesFilterBundle(filters: readonly unknown[], expected: readonly Filter[]): boolean {
	return filters.length === expected.length && expected.every((filter) => filters.some((candidate) => matchesFilter(candidate, filter)));
}

function copyPairDiagnostics(pairs: ReadonlyMap<PrimaryPairKey, PrimaryPairDiagnostic>): readonly PrimaryPairDiagnostic[] {
	return [...pairs.values()].map((pair) => ({ ...pair }));
}

function compareEventIds(first: Event, second: Event): number {
	return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

function eventRepresentation(event: Event): string {
	return JSON.stringify([event.id, event.pubkey, event.created_at, event.kind, event.tags, event.content, event.sig]);
}

function compareRepresentations(first: Event, second: Event): number {
	const firstRepresentation = eventRepresentation(first);
	const secondRepresentation = eventRepresentation(second);
	return firstRepresentation < secondRepresentation ? -1 : firstRepresentation > secondRepresentation ? 1 : 0;
}

export function createNostrRelayTransport(
	world: PrototypeWorldConfig,
	options: NostrRelayTransportOptions = {}
) {
	assertPrototypeWorldConfig(world);
	const timeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError('operationTimeoutMs must be a positive safe integer.');
	}

	let state: TransportState = 'new';
	let rxNostr: RxNostr | null = null;
	let startInput: PrimaryStartInput | null = null;
	let initialPhase = false;
	let earlySelfReadReady = false;
	const primaryRequestsSent = new Set<PrimaryPairKey>();
	const initialMessages: ParsedWorldMessage[] = [];
	const initialWorldStates: ParsedWorldStateEvent[] = [];
	const initialTraces: ParsedTraceEvent[] = [];
	const messageIds = new Set<string>();
	const positionIds = new Set<string>();
	const traceIds = new Set<string>();
	const primaryPairs = new Map<PrimaryPairKey, PrimaryPairDiagnostic>();
	const connections = new Map<string, RelayConnectionDiagnostic>();
	const relayAliases = new Map<string, string>();
	const subscriptions = new Subscription();
	let cancelPrimaryStart: (() => void) | null = null;
	let traceRootBootstrapStarted = false;
	let traceRootBootstrapComplete = false;
	let traceGenerationSequence = 0;
	let traceGeneration: TraceGeneration | null = null;
	let traceDiagnostics: TraceReplyDiagnostics | null = null;
	let realtimeStarted = false;
	let realtimeGeneration = 0;
	let realtimeDiagnostics: { status: 'inactive' | 'initializing' | 'active'; relays: RealtimeRelayDiagnostic[] } = { status: 'inactive', relays: [] };
	let realtimeResources: Subscription | null = null;
	let realtimeFilters: readonly Filter[] = [];
	const realtimeSubIds = new Map<string, string>();
	const realtimeSeenIds = new Set<string>();
	const realtimeReadableRelays = new Set<string>();
	const realtimeEchoWaiters = new Map<string, Set<(echoed: boolean) => void>>();
	const stableTraceCursors = new Map<string, Map<string, number>>();
	function requireRxNostr(): RxNostr {
		if (!rxNostr) throw new Error('Relay transport has not been initialized.');
		return rxNostr;
	}

	function canonicalRelay(url: string): string | null {
		if (relayAliases.has(url)) return relayAliases.get(url)!;
		try {
			return relayAliases.get(new URL(url).toString()) ?? null;
		} catch {
			return null;
		}
	}

	function updateConnection(relayUrl: string, connectionState: ConnectionState): void {
		const canonical = canonicalRelay(relayUrl);
		if (!canonical) return;
		connections.set(canonical, { relayUrl: canonical, state: connectionState });
		if (initialPhase) {
			for (const subscription of ['world-messages', 'world-state'] as const) {
				const key = pairKey(canonical, subscription);
				const pair = primaryPairs.get(key);
				if (pair && pair.status === 'pending' && isInitialConnectionUnavailable(connectionState, primaryRequestsSent.has(key))) {
					primaryPairs.set(key, { ...pair, status: 'unavailable' });
				}
			}
		}
		if (!isConnectionUnavailable(connectionState)) return;
		const realtimePair = realtimeDiagnostics.relays.find((relay) => relay.relayUrl === canonical);
		if (realtimePair?.status === 'pending') updateRealtimeDiagnostic(canonical, { relayUrl: canonical, status: 'unavailable' });
		const generation = traceGeneration;
		const traceState = generation?.states.get(canonical);
		if (!generation || !traceState) return;
		if (!generation.initialSettled && traceState.initialStatus.status === 'pending') {
			finishTraceInitialRelay(generation, traceState, { relayUrl: canonical, status: 'unavailable' });
			return;
		}
		if (generation.initialSettled && traceState.cycle) {
			finishTraceCatchUp(generation, traceState, { relayUrl: canonical, status: 'unavailable' });
		}
	}

	function nip11Diagnostics(): readonly Nip11Diagnostic[] {
		return world.authoritativeRelays.map((relayUrl) => {
			const maxSubscriptions = Nip11Registry.get(relayUrl)?.limitation?.max_subscriptions;
			const numericLimit = typeof maxSubscriptions === 'number' ? maxSubscriptions : null;
			const capacity: RelayCapacity = numericLimit === null
				? 'unknown'
				: numericLimit < 2
					? 'insufficient'
					: numericLimit === 2 ? 'primary-only' : 'trace-capable';
			return { relayUrl, maxSubscriptions: numericLimit, capacity };
		});
	}

	function diagnostics(): NostrRelayTransportDiagnostics {
		return {
			primaryPairs: copyPairDiagnostics(primaryPairs),
			connections: [...connections.values()].map((connection) => ({ ...connection })),
			nip11: nip11Diagnostics(),
			traceReplies: traceDiagnostics,
			realtime: { status: realtimeDiagnostics.status, relays: realtimeDiagnostics.relays.map((relay) => ({ ...relay })) }
		};
	}

	function disposeRxNostr(): void {
		cancelPrimaryStart?.();
		disposeTraceGeneration(true);
		stopRealtime();
		subscriptions.unsubscribe();
		rxNostr?.dispose();
		rxNostr = null;
	}

	// Trace queries need real per-relay terminal messages. use()'s
	// completion includes synthetic EOSE/timeouts, so it cannot provide this status.
	function queryRelays(
		filter: Filter | readonly Filter[],
		relays: readonly string[],
		onEvent: (packet: EventPacket, relayUrl: string) => void
	): Promise<readonly RelayQueryDiagnostic[]> {
		const client = requireRxNostr();
		const aliases = new Map(relays.map((relayUrl) => [new URL(relayUrl).toString(), relayUrl]));
		const configuredRelay = (url: string) => aliases.get(new URL(url).toString());
		const results = new Map<string, RelayQueryDiagnostic>();
		const subIds = new Map<string, string>();
		const requestsSent = new Set<string>();
		return new Promise((resolve, reject) => {
			let settled = false;
			const resources = new Subscription();
			subscriptions.add(resources);
			resources.add(() => {
				if (!settled) {
					settled = true;
					reject(new Error('Relay transport disposed during finite query.'));
				}
			});
			const finish = () => {
				if (settled || results.size !== relays.length) return;
				settled = true;
				resources.unsubscribe();
				resolve(relays.map((relayUrl) => ({ ...results.get(relayUrl)! })));
			};
			const deadline = setTimeout(() => {
				for (const relayUrl of relays) {
					if (!results.has(relayUrl)) results.set(relayUrl, { relayUrl, status: 'timeout' });
				}
				finish();
			}, timeoutMs);
			resources.add(() => clearTimeout(deadline));
			resources.add(client.createOutgoingMessageObservable().subscribe((packet) => {
				const request = reqFromOutgoing(packet);
				const queryFilters = Array.isArray(filter) ? filter : [filter];
				if (!request || !matchesFilterBundle(request.filters, queryFilters)) return;
				const relayUrl = configuredRelay(packet.to);
				if (relayUrl && !results.has(relayUrl)) {
					subIds.set(relayUrl, request.subId);
					requestsSent.add(relayUrl);
				}
			}));
			resources.add(client.createAllEventObservable().subscribe((packet) => {
				const relayUrl = configuredRelay(packet.from);
				if (relayUrl && !results.has(relayUrl) && subIds.get(relayUrl) === packet.subId) onEvent(packet, relayUrl);
			}));
			resources.add(client.createAllMessageObservable().subscribe((packet) => {
				if (packet.type !== 'EOSE' && packet.type !== 'CLOSED') return;
				const relayUrl = configuredRelay(packet.from);
				if (!relayUrl || results.has(relayUrl) || subIds.get(relayUrl) !== packet.subId) return;
				results.set(relayUrl, packet.type === 'EOSE'
					? { relayUrl, status: 'eose' }
					: { relayUrl, status: 'closed', notice: packet.notice });
				finish();
			}));
			const unavailable = (relayUrl: string, connection: ConnectionState | undefined) => {
				if (connection && isInitialConnectionUnavailable(connection, requestsSent.has(relayUrl)) && !results.has(relayUrl)) {
					results.set(relayUrl, { relayUrl, status: 'unavailable' });
				}
			};
			resources.add(client.createConnectionStateObservable().subscribe((packet) => {
				const relayUrl = configuredRelay(packet.from);
				if (relayUrl) unavailable(relayUrl, packet.state);
				finish();
			}));
			const queryFilters = Array.isArray(filter) ? filter : [filter];
			resources.add(client.use(createRxOneshotReq({ filters: queryFilters }), { on: { relays: [...relays] } }).subscribe());
			for (const relayUrl of relays) unavailable(relayUrl, client.getRelayStatus(relayUrl)?.connection);
			finish();
		});
	}

	function registerAuthoritativeRelays(): void {
		const client = requireRxNostr();
		client.setDefaultRelays([...world.authoritativeRelays]);
		for (const relayUrl of world.authoritativeRelays) {
			const normalized = client.getDefaultRelay(relayUrl)?.url;
			if (!normalized) throw new Error(`Resolved relay was not registered: ${relayUrl}`);
			relayAliases.set(relayUrl, relayUrl);
			relayAliases.set(normalized, relayUrl);
			relayAliases.set(new URL(normalized).toString(), relayUrl);
			connections.set(relayUrl, { relayUrl, state: client.getRelayStatus(relayUrl)?.connection ?? 'initialized' });
		}
	}

	function receiveMessage(event: Event): void {
		const parsed = parseWorldMessage(event, world.channelId);
		if (!parsed || messageIds.has(parsed.id)) return;
		messageIds.add(parsed.id);
		if (initialPhase) {
			initialMessages.push(parsed);
			startInput?.onBootstrapMessage(parsed);
		}
		else startInput?.onLiveMessage(parsed, event);
	}

	function receiveWorldState(event: Event): void {
		const parsed = parseWorldStateEvent(event, world.channelId);
		if (!parsed || positionIds.has(parsed.id)) return;
		positionIds.add(parsed.id);
		if (initialPhase) {
			initialWorldStates.push(parsed);
			startInput?.onBootstrapWorldState(parsed);
		} else {
			startInput?.onLiveWorldState(parsed);
		}
	}

	function receiveTrace(event: Event): void {
		const parsed = parseTraceEvent(event, world.channelId);
		if (!parsed || traceIds.has(parsed.id)) return;
		traceIds.add(parsed.id);
		if (initialPhase) {
			initialTraces.push(parsed);
			startInput?.onBootstrapTrace?.(parsed);
		} else {
			startInput?.onLiveTrace?.(parsed, event);
		}
	}

	function receiveWorldMessageOrTrace(event: Event): void {
		if (parseWorldMessage(event, world.channelId)) {
			receiveMessage(event);
			return;
		}
		if (parseTraceEvent(event, world.channelId)) receiveTrace(event);
	}

	async function startPrimary(): Promise<readonly PrimaryPairDiagnostic[]> {
		const client = requireRxNostr();
		if (!startInput) throw new Error('Primary startup is missing callbacks.');
		initialPhase = true;
		primaryRequestsSent.clear();
		const worldStateIds = worldStateIdentifiers(world.channelId);
		for (const relayUrl of world.authoritativeRelays) {
			for (const subscription of ['world-messages', 'world-state'] as const) {
				primaryPairs.set(pairKey(relayUrl, subscription), { relayUrl, subscription, status: 'pending' });
			}
		}

		return await new Promise<readonly PrimaryPairDiagnostic[]>((resolve, reject) => {
			let settled = false;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			let earlyDeadline: ReturnType<typeof setTimeout> | undefined;
			let earlyDeadlineReached = false;
			const primarySubIds = new Map<string, LogicalPrimarySubscription>();
			const activeSubIds = new Map<PrimaryPairKey, string>();
			const closedSubIds = new Set<string>();
			const maybeEarlyReady = () => {
				if (settled || earlySelfReadReady || !startInput) return;
				const eosePairs = world.authoritativeRelays.filter((relayUrl) =>
					primaryPairs.get(pairKey(relayUrl, 'world-messages'))?.status === 'eose' &&
					primaryPairs.get(pairKey(relayUrl, 'world-state'))?.status === 'eose').length;
				const messageEose = [...primaryPairs.values()].some((pair) => pair.subscription === 'world-messages' && pair.status === 'eose');
				const stateEose = [...primaryPairs.values()].some((pair) => pair.subscription === 'world-state' && pair.status === 'eose');
				if ((eosePairs >= 3 || earlyDeadlineReached && messageEose && stateEose) && primaryRequestsSent.size > 0) {
					earlySelfReadReady = true;
					startInput.onEarlySelfReadReady?.();
				}
			};
			const finish = () => {
				if (settled || ![...primaryPairs.values()].every((pair) => isTerminal(pair.status))) return;
				settled = true;
				cancelPrimaryStart = null;
				if (deadline) clearTimeout(deadline);
				if (earlyDeadline) clearTimeout(earlyDeadline);
				initialPhase = false;
				if (!earlySelfReadReady) {
					earlySelfReadReady = true;
					startInput?.onEarlySelfReadReady?.();
				}
				resolve(copyPairDiagnostics(primaryPairs));
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cancelPrimaryStart = null;
				if (deadline) clearTimeout(deadline);
				if (earlyDeadline) clearTimeout(earlyDeadline);
				initialPhase = false;
				reject(error);
			};
			cancelPrimaryStart = () => fail(new Error('Relay transport disposed during primary initialization.'));
			const outgoingSubscription = client.createOutgoingMessageObservable().subscribe((packet) => {
				const request = reqFromOutgoing(packet);
				if (!request) return;
				const relayUrl = canonicalRelay(packet.to);
				if (!relayUrl) return;
				const classified = classifyPrimaryFilter(request.filters, world.channelId, worldStateIds);
				const logical = classified;
				if (!logical) {
					if (initialPhase) fail(new Error('Unexpected outgoing REQ during primary initialization.'));
					return;
				}
				const key = pairKey(relayUrl, logical);
				if (!primaryPairs.has(key)) {
					fail(new Error('Outgoing primary REQ targeted an unexpected relay.'));
					return;
				}
				// The subId remains opaque. Repeated mapping is a normal reconnect resend.
				const mappingKey = `${relayUrl}\u0000${request.subId}`;
				primarySubIds.set(mappingKey, logical);
				activeSubIds.set(key, request.subId);
				primaryRequestsSent.add(key);
				if (!earlyDeadline) earlyDeadline = setTimeout(() => {
					earlyDeadlineReached = true;
					maybeEarlyReady();
				}, EARLY_SELF_READ_DEADLINE_MS);
				closedSubIds.delete(mappingKey);
			});
			// Consume the public, filter-matched event stream synchronously. The
			// project parsers verify signatures; async use() verification must not
			// move an EVENT received before EOSE across the bootstrap/live boundary.
			const eventSubscription = client.createAllEventObservable().subscribe((packet) => {
				const relayUrl = canonicalRelay(packet.from);
				if (!relayUrl) return;
				const logical = primarySubIds.get(`${relayUrl}\u0000${packet.subId}`);
				if (!logical || activeSubIds.get(pairKey(relayUrl, logical)) !== packet.subId) return;
				if (logical === 'world-messages') {
					receiveWorldMessageOrTrace(packet.event);
				}
				else receiveWorldState(packet.event);
			});
			const rawSubscription = client.createAllMessageObservable().subscribe((packet) => {
				if ((packet.type !== 'EOSE' && packet.type !== 'CLOSED') || !canonicalRelay(packet.from)) return;
				const relayUrl = canonicalRelay(packet.from)!;
				const mappingKey = `${relayUrl}\u0000${packet.subId}`;
				const logical = primarySubIds.get(mappingKey);
				if (!logical) return;
				const key = pairKey(relayUrl, logical);
				if (activeSubIds.get(key) !== packet.subId || closedSubIds.has(mappingKey)) return;
				const pair = primaryPairs.get(key);
				if (!pair || (packet.type === 'EOSE' && pair.status !== 'pending')) return;
				if (packet.type === 'CLOSED') closedSubIds.add(mappingKey);
				const next = packet.type === 'EOSE'
					? { ...pair, status: 'eose' as const }
					: { ...pair, status: 'closed' as const, notice: packet.notice };
				primaryPairs.set(key, next);
				maybeEarlyReady();
				if (packet.type === 'CLOSED') startInput?.onPrimaryClosed(next);
				finish();
			});
			const stateSubscription = client.createConnectionStateObservable().subscribe((packet) => {
				updateConnection(packet.from, packet.state);
				finish();
			});
			for (const subscription of [outgoingSubscription, eventSubscription, rawSubscription, stateSubscription]) subscriptions.add(subscription);

			const messageRequest = createRxForwardReq();
			const positionRequest = createRxForwardReq();
			subscriptions.add(client.use(messageRequest).subscribe());
			subscriptions.add(client.use(positionRequest).subscribe());
			deadline = setTimeout(() => {
				for (const [key, pair] of primaryPairs) {
					if (pair.status === 'pending') primaryPairs.set(key, { ...pair, status: 'timeout' });
				}
				finish();
			}, timeoutMs);
			messageRequest.emit(buildWorldMessageFilters({ channelId: world.channelId, since: startInput!.messageSince }));
			positionRequest.emit(buildWorldStateFilter({ channelId: world.channelId, since: startInput!.worldStateSince }));
			for (const relayUrl of world.authoritativeRelays) {
				const connection = client.getRelayStatus(relayUrl)?.connection;
				if (connection) updateConnection(relayUrl, connection);
			}
			finish();
		});
	}

	function copyTraceDiagnostic(diagnostic: TraceReplyRelayDiagnostic): TraceReplyRelayDiagnostic {
		return { ...diagnostic };
	}

	function realtimeCapacityAllows(relayUrl: string): boolean {
		const maxSubscriptions = Nip11Registry.get(relayUrl)?.limitation?.max_subscriptions;
		// Reserve room for the two primary subscriptions and the existing Trace
		// supplemental subscription before opening realtime events.
		return typeof maxSubscriptions !== 'number' || maxSubscriptions >= 4;
	}

	function updateRealtimeDiagnostic(relayUrl: string, next: RealtimeRelayDiagnostic): void {
		realtimeDiagnostics = {
			...realtimeDiagnostics,
			relays: realtimeDiagnostics.relays.map((relay) => relay.relayUrl === relayUrl ? { ...next } : relay)
		};
		if (next.status === 'eose') realtimeReadableRelays.add(relayUrl);
		else realtimeReadableRelays.delete(relayUrl);
	}

	function waitForRealtimeEcho(eventId: string, waitMs: number): Readonly<{ promise: Promise<boolean>; cancel: () => void }> {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let settled = false;
		let resolvePromise!: (echoed: boolean) => void;
		const promise = new Promise<boolean>((resolve) => { resolvePromise = resolve; });
		const listeners = realtimeEchoWaiters.get(eventId) ?? new Set<(echoed: boolean) => void>();
		const finish = (echoed: boolean) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			listeners.delete(finish);
			if (listeners.size === 0) realtimeEchoWaiters.delete(eventId);
			resolvePromise(echoed);
		};
		listeners.add(finish);
		realtimeEchoWaiters.set(eventId, listeners);
		timer = setTimeout(() => finish(false), waitMs);
		return { promise, cancel: () => finish(false) };
	}

	function notifyRealtimeEcho(eventId: string): void {
		for (const listener of realtimeEchoWaiters.get(eventId) ?? []) listener(true);
	}

	/**
	 * Starts the event stream as a supplemental Forward request. It deliberately
	 * has its own terminal/error accounting and never changes primary status.
	 */
	async function startRealtime(input: RealtimeStartInput): Promise<RealtimeStartResult> {
		if (state !== 'started') throw new Error('Relay transport must start before realtime events.');
		if (realtimeStarted) throw new Error('Realtime event startup is only allowed once.');
		realtimeStarted = true;
		const generation = ++realtimeGeneration;
		if (input.eventTypes.length === 0) {
			realtimeDiagnostics = { status: 'inactive', relays: [] };
			return { status: 'inactive', events: [], controls: [], relays: [] };
		}
		assertTimestamp(input.controlSince, 'realtime control since');
		const enabledProtocolKeys = new Set(input.eventTypes.map((definition) => definition.protocolKey));
		const instanceFilters = normalizeRealtimeInstanceFilterConfigurations(input.instanceFilters).map((configuration) => {
			if (!enabledProtocolKeys.has(configuration.protocolKey)) throw new TypeError('Realtime instance filter targets a disabled protocol.');
			return buildRealtimeInstanceFilter({ channelId: world.channelId, configuration });
		});
		const controlFilter = buildRealtimeControlFilter({ channelId: world.channelId, creatorPubkey: world.creatorPubkey, since: input.controlSince });
		realtimeFilters = [controlFilter, ...instanceFilters];
		const capableRelays = world.authoritativeRelays.filter(realtimeCapacityAllows);
		const skipped = world.authoritativeRelays.filter((relayUrl) => !capableRelays.includes(relayUrl)).map((relayUrl) => ({ relayUrl, status: 'unavailable' as const, notice: 'Relay subscription capacity is reserved for primary world reads.' }));
		if (capableRelays.length === 0) {
			realtimeDiagnostics = { status: 'inactive', relays: skipped };
			return { status: 'inactive', events: [], controls: [], relays: skipped };
		}
		realtimeDiagnostics = { status: 'initializing', relays: [...capableRelays.map((relayUrl) => ({ relayUrl, status: 'pending' as const })), ...skipped] };
		const client = requireRxNostr();
		const initialEvents: Event[] = [];
		const initialControls: RealtimeControlEnvelope[] = [];
		let settled = false;
		let deadline: ReturnType<typeof setTimeout> | null = null;
		const resources = new Subscription();
		realtimeResources = resources;
		const finish = (resolve: (result: RealtimeStartResult) => void) => {
			if (settled || realtimeDiagnostics.relays.some((relay) => relay.status === 'pending')) return;
			settled = true;
			if (deadline) clearTimeout(deadline);
			realtimeDiagnostics = { ...realtimeDiagnostics, status: capableRelays.some((relayUrl) => realtimeDiagnostics.relays.find((relay) => relay.relayUrl === relayUrl)?.status === 'eose') ? 'active' : 'inactive' };
			resolve({ status: realtimeDiagnostics.status === 'active' ? 'active' : 'inactive', events: [...initialEvents], controls: [...initialControls], relays: realtimeDiagnostics.relays.map((relay) => ({ ...relay })) });
		};
		return await new Promise<RealtimeStartResult>((resolve, reject) => {
			resources.add(() => {
				if (!settled) {
					settled = true;
					reject(new Error('Relay transport disposed during realtime startup.'));
				}
			});
			resources.add(client.createOutgoingMessageObservable().subscribe((packet) => {
				const request = reqFromOutgoing(packet);
				const relayUrl = canonicalRelay(packet.to);
				if (!request || !relayUrl || generation !== realtimeGeneration || !capableRelays.includes(relayUrl) || !matchesRealtimeFilterBundle(request.filters, realtimeFilters)) return;
				realtimeSubIds.set(relayUrl, request.subId);
			}));
			resources.add(client.createAllEventObservable().subscribe((packet) => {
				const relayUrl = canonicalRelay(packet.from);
				if (generation !== realtimeGeneration || !relayUrl || realtimeSubIds.get(relayUrl) !== packet.subId || packet.event.kind !== REALTIME_EVENT_KIND) return;
				const control = matchesRealtimeEventFilter(packet.event, controlFilter)
					? parseRealtimeControlEnvelope(packet.event, world.channelId, world.creatorPubkey)
					: null;
				const isInstanceEvent = instanceFilters.some((filter) => matchesRealtimeEventFilter(packet.event, filter));
				if (!control && !isInstanceEvent) return;
				notifyRealtimeEcho(packet.event.id);
				if (realtimeSeenIds.has(packet.event.id)) return;
				realtimeSeenIds.add(packet.event.id);
				if (!settled) {
					if (control) { initialControls.push(control); input.onBootstrapControl?.(control); }
					else { initialEvents.push(packet.event); input.onBootstrapEvent(packet.event); }
				} else if (control) input.onLiveControl?.(control);
				else input.onLiveEvent(packet.event);
			}));
			resources.add(client.createAllMessageObservable().subscribe((packet) => {
				if (packet.type !== 'EOSE' && packet.type !== 'CLOSED') return;
				const relayUrl = canonicalRelay(packet.from);
				if (!relayUrl || realtimeSubIds.get(relayUrl) !== packet.subId) return;
				const diagnostic: RealtimeRelayDiagnostic = packet.type === 'EOSE'
					? { relayUrl, status: 'eose' }
					: { relayUrl, status: 'closed', ...(packet.notice ? { notice: packet.notice } : {}) };
				updateRealtimeDiagnostic(relayUrl, diagnostic);
				if (!settled) finish(resolve);
			}));
			resources.add(client.createConnectionStateObservable().subscribe((packet) => {
				const relayUrl = canonicalRelay(packet.from);
				if (!relayUrl || !capableRelays.includes(relayUrl) || !isConnectionUnavailable(packet.state)) return;
				const current = realtimeDiagnostics.relays.find((relay) => relay.relayUrl === relayUrl);
				if (current?.status === 'pending') {
					updateRealtimeDiagnostic(relayUrl, { relayUrl, status: 'unavailable' });
					finish(resolve);
				}
			}));
			const requests = capableRelays.map((relayUrl) => {
				const req = createRxForwardReq();
				resources.add(client.use(req, { on: { relays: [relayUrl] } }).subscribe());
				return req;
			});
			deadline = setTimeout(() => {
				for (const relayUrl of capableRelays) {
					const current = realtimeDiagnostics.relays.find((relay) => relay.relayUrl === relayUrl);
					if (current?.status === 'pending') updateRealtimeDiagnostic(relayUrl, { relayUrl, status: 'timeout' });
				}
				finish(resolve);
			}, timeoutMs);
			for (const request of requests) request.emit([...realtimeFilters] as Filter[]);
			for (const relayUrl of capableRelays) {
				const connection = client.getRelayStatus(relayUrl)?.connection;
				if (connection && isConnectionUnavailable(connection)) updateRealtimeDiagnostic(relayUrl, { relayUrl, status: 'unavailable' });
			}
			finish(resolve);
		});
	}

	function stopRealtime(): void {
		if (!realtimeStarted) return;
		realtimeGeneration += 1;
		realtimeStarted = false;
		realtimeResources?.unsubscribe();
		realtimeResources = null;
		realtimeSubIds.clear();
		realtimeFilters = [];
		realtimeReadableRelays.clear();
		for (const listeners of realtimeEchoWaiters.values()) for (const listener of listeners) listener(false);
		realtimeEchoWaiters.clear();
		realtimeDiagnostics = { status: 'inactive', relays: [] };
	}

	function refreshTraceDiagnostics(generation: TraceGeneration | null, status: TraceReplyDiagnostics['status']): void {
		traceDiagnostics = generation
			? {
				generation: generation.id,
				status,
				relays: world.authoritativeRelays.map((relayUrl) => copyTraceDiagnostic(generation.states.get(relayUrl)!.initialStatus))
			}
			: { generation: traceGenerationSequence, status: 'inactive', relays: [] };
	}

	function traceScopes(input: TraceReplyConfiguration): { scopes: readonly TraceScope[]; semanticKey: string } {
		const scopes: TraceScope[] = [];
		const notification = input.notification;
		if (notification) {
			assertTimestamp(notification.initialSince, 'notification initialSince');
			const initialFilter = buildTraceNotificationFilter({
				personaPubkey: notification.personaPubkey
			});
			scopes.push({
				key: `notification\u0000${notification.personaPubkey}`,
				kind: 'notification',
				initialFilter: { ...initialFilter, since: notification.initialSince },
				initialSince: notification.initialSince
			});
		}
		if (input.conversation) {
			const { rootId, currentId } = input.conversation;
			scopes.push({ key: `root\u0000${rootId}`, kind: 'root', initialFilter: buildTraceReplyFilter({ rootId }) });
			scopes.push({ key: `direct\u0000${rootId}\u0000${currentId}`, kind: 'direct', initialFilter: buildTraceDirectReplyFilter({ currentId }) });
		}
		return { scopes, semanticKey: JSON.stringify(scopes.map((scope) => [scope.key, scope.initialFilter])) };
	}

	function traceConcreteFilters(generation: TraceGeneration, relay: TraceRelayState): Filter[] {
		return generation.scopes.map((scope) => {
			if (relay.forms.get(scope.key) !== 'continuation') return { ...scope.initialFilter };
			const cursor = relay.stableCursors.get(scope.key);
			if (cursor === undefined) throw new Error('Trace continuation is missing a stable cursor.');
			const filter = { ...scope.initialFilter, since: cursor } as Record<string, unknown>;
			if (scope.kind !== 'notification') delete filter.limit;
			return filter as Filter;
		});
	}

	function traceFilters(generation: TraceGeneration, relay: TraceRelayState): LazyFilter[] {
		return generation.scopes.map((scope) => {
			if (relay.forms.get(scope.key) !== 'continuation') return { ...scope.initialFilter };
			const filter = { ...scope.initialFilter } as Record<string, unknown>;
			if (scope.kind !== 'notification') delete filter.limit;
			filter.since = () => {
				const cursor = relay.stableCursors.get(scope.key);
				if (cursor === undefined) throw new Error('Trace continuation is missing a stable cursor.');
				return cursor;
			};
			return filter as LazyFilter;
		});
	}

	function traceBoundary(scope: TraceScope, cycleBoundary: number): number {
		const overlap = Math.max(0, cycleBoundary - TRACE_REPLY_RESUME_OVERLAP_SECONDS);
		return scope.kind === 'notification' ? Math.max(scope.initialSince!, overlap) : overlap;
	}

	function traceInitialTerminal(generation: TraceGeneration, relay: TraceRelayState): boolean {
		return relay.initialStatus.status !== 'pending';
	}

	function armTraceCatchUpTimer(generation: TraceGeneration, relay: TraceRelayState, cycle: TraceCycle): void {
		if (cycle.timer) clearTimeout(cycle.timer);
		cycle.timer = setTimeout(() => {
			if (generation === traceGeneration && generation.active && relay.cycle === cycle) {
				finishTraceCatchUp(generation, relay, { relayUrl: relay.relayUrl, status: 'timeout' });
			}
		}, timeoutMs);
	}

	function startTraceCycle(generation: TraceGeneration, relay: TraceRelayState, kind: TraceCycleKind): void {
		if (generation !== traceGeneration || !generation.active) return;
		const cycle = relay.cycle?.kind === kind
			? relay.cycle
			: { kind, cycleBoundary: unixNow(), events: [], timer: null };
		// A reconnect resends the ongoing Forward REQ. It is still the same
		// unacknowledged batch, so keep its buffered raw events and only move the
		// boundary to the latest wire REQ that its eventual EOSE acknowledges.
		cycle.cycleBoundary = unixNow();
		if (cycle.timer) clearTimeout(cycle.timer);
		relay.cycle = cycle;
		if (kind === 'catch-up') armTraceCatchUpTimer(generation, relay, cycle);
	}

	function convertTimedOutInitialCycleToCatchUp(generation: TraceGeneration, relay: TraceRelayState): void {
		const initialCycle = relay.cycle;
		if (relay.initialStatus.status !== 'timeout' || initialCycle?.kind !== 'initial') return;
		// Events before initial settlement were delivered in initialBatch. Keep the
		// wire-observed boundary, but begin a fresh callback-only batch and timer.
		const catchUpCycle: TraceCycle = {
			kind: 'catch-up',
			cycleBoundary: initialCycle.cycleBoundary,
			events: [],
			timer: null
		};
		relay.cycle = catchUpCycle;
		armTraceCatchUpTimer(generation, relay, catchUpCycle);
	}

	function invalidateTraceRelayTerminal(relay: TraceRelayState): void {
		if (relay.cycle?.timer) clearTimeout(relay.cycle.timer);
		relay.cycle = null;
		relay.subId = null;
	}

	function finishTraceInitialRelay(
		generation: TraceGeneration,
		relay: TraceRelayState,
		diagnostic: TraceReplyRelayDiagnostic
	): void {
		if (generation !== traceGeneration || generation.initialSettled || traceInitialTerminal(generation, relay)) return;
		relay.initialStatus = diagnostic;
		if (diagnostic.status === 'eose' && relay.cycle) {
			for (const scope of generation.scopes) relay.provisionalCursors.set(scope.key, traceBoundary(scope, relay.cycle.cycleBoundary));
		}
		if (diagnostic.status === 'closed' || diagnostic.status === 'unavailable') invalidateTraceRelayTerminal(relay);
		if ([...generation.states.values()].every((state) => traceInitialTerminal(generation, state))) finishTraceInitial(generation);
	}

	function finishTraceInitial(generation: TraceGeneration): void {
		if (generation !== traceGeneration || generation.initialSettled) return;
		generation.initialSettled = true;
		if (generation.initialDeadline) clearTimeout(generation.initialDeadline);
		generation.initialDeadline = null;
		for (const relay of generation.states.values()) {
			for (const [scopeKey, cursor] of relay.provisionalCursors) {
				relay.stableCursors.set(scopeKey, cursor);
				const retained = stableTraceCursors.get(scopeKey) ?? new Map<string, number>();
				retained.set(relay.relayUrl, cursor);
				stableTraceCursors.set(scopeKey, retained);
			}
			relay.provisionalCursors.clear();
		}
		const result: TraceReplyConfigurationResult = {
			status: 'active', generation: generation.id, initialBatch: {
				events: [...generation.initialEvents],
				relays: world.authoritativeRelays.map((relayUrl) => copyTraceDiagnostic(generation.states.get(relayUrl)!.initialStatus))
			}
		};
		generation.settledResult = result;
		refreshTraceDiagnostics(generation, 'active');
		generation.resolve(result);
		queueMicrotask(() => {
			if (generation !== traceGeneration || !generation.active) return;
			for (const relay of generation.states.values()) {
				if (relay.initialStatus.status === 'eose') {
					transitionTraceRelay(generation, relay);
					continue;
				}
				// A timed-out initial REQ may still be ongoing. Its pre-settlement
				// events were returned above; retain its actual wire boundary while a
				// fresh callback-only catch-up batch waits for a terminal message.
				convertTimedOutInitialCycleToCatchUp(generation, relay);
			}
		});
	}

	function transitionTraceRelay(generation: TraceGeneration, relay: TraceRelayState): void {
		if (generation !== traceGeneration || !generation.active) return;
		let changed = false;
		for (const scope of generation.scopes) {
			if (relay.forms.get(scope.key) === 'initial') {
				relay.forms.set(scope.key, 'continuation');
				changed = true;
			}
		}
		if (!changed) return;
		relay.req.emit(traceFilters(generation, relay));
	}

	function finishTraceCatchUp(
		generation: TraceGeneration,
		relay: TraceRelayState,
		diagnostic: TraceReplyRelayDiagnostic
	): void {
		if (generation !== traceGeneration || !generation.active || !generation.initialSettled || !relay.cycle) return;
		const cycle = relay.cycle;
		relay.cycle = null;
		if (cycle.timer) clearTimeout(cycle.timer);
		const batch: TraceReplyBatch = { events: [...cycle.events], relays: [diagnostic] };
		generation.callbacks.onBatch(batch);
		if (generation !== traceGeneration || !generation.active) return;
		relay.initialStatus = diagnostic;
		refreshTraceDiagnostics(generation, 'active');
		if (diagnostic.status === 'eose') {
			for (const scope of generation.scopes) {
				const cursor = traceBoundary(scope, cycle.cycleBoundary);
				relay.stableCursors.set(scope.key, cursor);
				const retained = stableTraceCursors.get(scope.key) ?? new Map<string, number>();
				retained.set(relay.relayUrl, cursor);
				stableTraceCursors.set(scope.key, retained);
			}
			transitionTraceRelay(generation, relay);
		} else if (diagnostic.status === 'closed' || diagnostic.status === 'unavailable') {
			relay.subId = null;
		}
	}

	function finishTraceLiveClosed(
		generation: TraceGeneration,
		relay: TraceRelayState,
		diagnostic: TraceReplyRelayDiagnostic
	): void {
		if (generation !== traceGeneration || !generation.active || !generation.initialSettled || relay.cycle || !relay.subId) return;
		invalidateTraceRelayTerminal(relay);
		relay.initialStatus = diagnostic;
		refreshTraceDiagnostics(generation, 'active');
		// Commit the terminal state before the consumer can reconfigure this generation.
		generation.callbacks.onBatch({ events: [], relays: [diagnostic] });
	}

	function receiveTraceEvent(generation: TraceGeneration, relay: TraceRelayState, event: Event): void {
		if (generation !== traceGeneration || !generation.active || generation.seenIds.has(event.id)) return;
		generation.seenIds.add(event.id);
		if (!generation.initialSettled) {
			generation.initialEvents.push(event);
			return;
		}
		if (relay.cycle) {
			relay.cycle.events.push(event);
			return;
		}
		generation.callbacks.onLiveEvent(event);
	}

	function disposeTraceGeneration(disposed: boolean): void {
		const generation = traceGeneration;
		if (!generation) return;
		traceGeneration = null;
		generation.active = false;
		if (generation.initialDeadline) clearTimeout(generation.initialDeadline);
		for (const relay of generation.states.values()) if (relay.cycle?.timer) clearTimeout(relay.cycle.timer);
		generation.resources.unsubscribe();
		if (!generation.initialSettled) {
			if (disposed) generation.reject(new Error('Relay transport disposed during trace reply configuration.'));
			else generation.resolve({ status: 'superseded', generation: generation.id });
		}
	}

	function configureTraceReplies(input: TraceReplyConfiguration): Promise<TraceReplyConfigurationResult> {
		if (state !== 'started' || !traceRootBootstrapComplete) {
			return Promise.reject(new Error('Relay transport must complete trace root bootstrap before configuring trace replies.'));
		}
		const configured = traceScopes(input);
		if (configured.scopes.length === 0) {
			disposeTraceGeneration(false);
			stableTraceCursors.clear();
			traceGenerationSequence += 1;
			const result: TraceReplyConfigurationResult = { status: 'inactive', generation: traceGenerationSequence };
			refreshTraceDiagnostics(null, 'inactive');
			return Promise.resolve(result);
		}
		if (traceGeneration?.semanticKey === configured.semanticKey) {
			traceGeneration.callbacks = { onBatch: input.onBatch, onLiveEvent: input.onLiveEvent };
			return traceGeneration.initialSettled
				? Promise.resolve(traceGeneration.settledResult!)
				: traceGeneration.initialPromise;
		}
		disposeTraceGeneration(false);
		const scopeKeys = new Set(configured.scopes.map((scope) => scope.key));
		for (const key of [...stableTraceCursors.keys()]) if (!scopeKeys.has(key)) stableTraceCursors.delete(key);
		let resolve!: (result: TraceReplyConfigurationResult) => void;
		let reject!: (error: Error) => void;
		const initialPromise = new Promise<TraceReplyConfigurationResult>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
		const generation: TraceGeneration = {
			id: ++traceGenerationSequence,
			semanticKey: configured.semanticKey,
			scopes: configured.scopes,
			states: new Map(),
			resources: new Subscription(),
			seenIds: new Set(),
			initialEvents: [],
			initialSettled: false,
			active: true,
			initialDeadline: null,
			callbacks: { onBatch: input.onBatch, onLiveEvent: input.onLiveEvent },
			resolve,
			reject,
			settledResult: null,
			initialPromise
		};
		traceGeneration = generation;
		for (const relayUrl of world.authoritativeRelays) {
			const retained = new Map<string, number>();
			for (const scope of configured.scopes) {
				const cursor = stableTraceCursors.get(scope.key)?.get(relayUrl);
				if (cursor !== undefined) retained.set(scope.key, cursor);
			}
			const req = createRxForwardReq();
			const relay: TraceRelayState = {
				relayUrl,
				req,
				subscription: new Subscription(),
				subId: null,
				forms: new Map(configured.scopes.map((scope) => [scope.key, retained.has(scope.key) ? 'continuation' : 'initial'])),
				stableCursors: retained,
				provisionalCursors: new Map(),
				initialStatus: { relayUrl, status: 'pending' },
				cycle: null
			};
			generation.states.set(relayUrl, relay);
			relay.subscription = clientUseTraceRequest(req, relayUrl);
			generation.resources.add(relay.subscription);
		}
		const client = requireRxNostr();
		generation.resources.add(client.createOutgoingMessageObservable().subscribe((packet) => {
			const request = reqFromOutgoing(packet);
			const relayUrl = canonicalRelay(packet.to);
			if (!request || !relayUrl || generation !== traceGeneration || !generation.active) return;
			const relay = generation.states.get(relayUrl);
			if (!relay || !matchesFilterBundle(request.filters, traceConcreteFilters(generation, relay))) return;
			relay.subId = request.subId;
			if (!generation.initialSettled) {
				if (!traceInitialTerminal(generation, relay)) startTraceCycle(generation, relay, 'initial');
			} else startTraceCycle(generation, relay, 'catch-up');
		}));
		generation.resources.add(client.createAllEventObservable().subscribe((packet) => {
			const relayUrl = canonicalRelay(packet.from);
			const relay = relayUrl ? generation.states.get(relayUrl) : undefined;
			if (generation !== traceGeneration || !relay || relay.subId !== packet.subId) return;
			receiveTraceEvent(generation, relay, packet.event);
		}));
		generation.resources.add(client.createAllMessageObservable().subscribe((packet) => {
			if (packet.type !== 'EOSE' && packet.type !== 'CLOSED') return;
			const relayUrl = canonicalRelay(packet.from);
			const relay = relayUrl ? generation.states.get(relayUrl) : undefined;
			if (generation !== traceGeneration || !relay || relay.subId !== packet.subId) return;
			const diagnostic: TraceReplyRelayDiagnostic = packet.type === 'EOSE'
				? { relayUrl: relay.relayUrl, status: 'eose' }
				: { relayUrl: relay.relayUrl, status: 'closed', notice: packet.notice };
			if (!generation.initialSettled) finishTraceInitialRelay(generation, relay, diagnostic);
			else if (relay.cycle) finishTraceCatchUp(generation, relay, diagnostic);
			else if (packet.type === 'CLOSED') finishTraceLiveClosed(generation, relay, diagnostic);
		}));
		generation.initialDeadline = setTimeout(() => {
			if (generation !== traceGeneration || generation.initialSettled) return;
			for (const relay of generation.states.values()) {
				finishTraceInitialRelay(generation, relay, { relayUrl: relay.relayUrl, status: 'timeout' });
			}
		}, timeoutMs);
		refreshTraceDiagnostics(generation, 'initializing');
		for (const relay of generation.states.values()) relay.req.emit(traceFilters(generation, relay));
		for (const relayUrl of world.authoritativeRelays) {
			const connection = client.getRelayStatus(relayUrl)?.connection;
			if (connection) updateConnection(relayUrl, connection);
		}
		return generation.initialPromise;
	}

	function clientUseTraceRequest(req: TraceRelayState['req'], relayUrl: string): Subscription {
		return requireRxNostr().use(req, { on: { relays: [relayUrl] } }).subscribe();
	}

	async function publishEvent(event: VerifiedEvent): Promise<readonly PublishRelayResult[]> {
		if (state !== 'started') throw new Error('Relay transport must start before publishing.');
		const client = requireRxNostr();
		const results = new Map<string, PublishRelayResult>(world.authoritativeRelays.map((relayUrl) => [relayUrl, {
			relayUrl,
			outcome: 'no-response'
		}]));
		await new Promise<void>((resolve, reject) => {
			client.send(event).subscribe({
				next: (packet) => {
					const relayUrl = canonicalRelay(packet.from);
					if (!relayUrl) return;
					results.set(relayUrl, {
						relayUrl,
						outcome: packet.ok ? 'accepted' : 'rejected',
						...(packet.notice ? { notice: packet.notice } : {})
					});
				},
				complete: resolve,
				error: reject
			});
		});
		return [...results.values()];
	}

	function publishSelfEvent(event: VerifiedEvent, selfPubkey: string): SelfPublishHandle {
		if ((state !== 'started' && !(state === 'starting' && earlySelfReadReady)) ||
			event.pubkey !== selfPubkey || (event.kind !== CHANNEL_MESSAGE_KIND && event.kind !== WORLD_STATE_KIND)) {
			throw new Error('Self publication is unavailable before the bounded primary read boundary.');
		}
		const client = requireRxNostr();
		const results = new Map<string, PublishRelayResult>(world.authoritativeRelays.map((relayUrl) => [relayUrl, {
			relayUrl, outcome: 'no-response'
		}]));
		let resolveFirst!: (success: boolean) => void;
		let firstResolved = false;
		const firstSuccess = new Promise<boolean>((resolve) => { resolveFirst = resolve; });
		const finishFirst = (success: boolean) => {
			if (firstResolved) return;
			firstResolved = true;
			resolveFirst(success);
		};
		const settled = new Promise<readonly PublishRelayResult[]>((resolve, reject) => {
			let finished = false;
			let subscription: Subscription | undefined;
			const onDispose = () => {
				if (!finished) {
					finished = true;
					finishFirst(false);
					reject(new Error('Relay transport disposed during self publication.'));
				}
			};
			const removePending = () => {
				if (subscription) subscriptions.remove(subscription);
				subscriptions.remove(onDispose);
			};
			subscription = client.send(event).subscribe({
				next: (packet) => {
					const relayUrl = canonicalRelay(packet.from);
					if (!relayUrl) return;
					results.set(relayUrl, { relayUrl, outcome: packet.ok ? 'accepted' : 'rejected',
						...(packet.notice ? { notice: packet.notice } : {}) });
					if (packet.ok || packet.notice?.startsWith('duplicate:')) finishFirst(true);
				},
				complete: () => {
					finished = true;
					removePending();
					finishFirst(false);
					resolve([...results.values()]);
				},
				error: (error) => {
					finished = true;
					removePending();
					finishFirst(false);
					reject(error);
				}
			});
			if (!finished) {
				subscriptions.add(subscription);
				subscriptions.add(onDispose);
			}
		});
		return { firstSuccess, settled };
	}

	async function publishRealtimeEvent(event: VerifiedEvent): Promise<RealtimePublishResult> {
		if (state !== 'started' || !realtimeStarted) throw new Error('Realtime event subscription is not active.');
		const echo = waitForRealtimeEcho(event.id, timeoutMs);
		let results: readonly PublishRelayResult[];
		try {
			results = await publishEvent(event);
		} catch (error) {
			echo.cancel();
			throw error;
		}
		const acceptedByReadableRelay = results.some((result) => result.outcome === 'accepted' && realtimeReadableRelays.has(result.relayUrl));
		if (acceptedByReadableRelay) {
			echo.cancel();
			return { outcome: 'accepted', results };
		}
		if (await echo.promise) return { outcome: 'echoed', results };
		return { outcome: 'unconfirmed', results };
	}

	return {
		async start(input: PrimaryStartInput): Promise<PrimaryStartResult> {
			if (state !== 'new') throw new Error('Relay transport start is only allowed once.');
			assertTimestamp(input.messageSince, 'messageSince');
			assertTimestamp(input.worldStateSince, 'worldStateSince');
			state = 'starting';
			startInput = input;
			rxNostr = createRxNostr({
				connectionStrategy: 'lazy',
				signer: noopSigner(),
				verifier: async (event) => verifyEvent(event),
				skipExpirationCheck: true,
				skipFetchNip11: false,
				eoseTimeout: timeoutMs,
				okTimeout: timeoutMs,
				disconnectTimeout: timeoutMs,
				...(options.websocketCtor ? { websocketCtor: options.websocketCtor } : {})
			});
			try {
				registerAuthoritativeRelays();
				const pairs = await startPrimary();
				state = 'started';
				return {
					channel: { channelId: world.channelId, relayHint: world.preferredRelayHint },
					messages: [...initialMessages],
					worldStates: [...initialWorldStates],
					traces: [...initialTraces],
					primaryPairs: pairs,
					nip11: nip11Diagnostics()
				};
			} catch (error) {
				if ((state as TransportState) !== 'disposed') state = 'failed';
				disposeRxNostr();
				throw error;
			}
		},

		startRealtime(input: RealtimeStartInput): Promise<RealtimeStartResult> {
			return startRealtime(input);
		},

		getDiagnostics(): NostrRelayTransportDiagnostics {
			return diagnostics();
		},
		publishSelf: publishSelfEvent,

		async bootstrapTraceRootCandidates(): Promise<TraceRootBootstrapResult> {
			if (state !== 'started') {
				throw new Error('Relay transport must start before trace root bootstrap.');
			}
			if (traceRootBootstrapStarted) {
				throw new Error('Trace root bootstrap is only allowed once.');
			}
			traceRootBootstrapStarted = true;
			const filters = buildTraceRootBootstrapFilters({ channelId: world.channelId });
			const bootstrapLimit = filters[0].limit!;
			const eventsByRelay = new Map<string, Event[]>(world.authoritativeRelays.map((relayUrl) => [relayUrl, []]));
			const diagnostics = await queryRelays(filters, world.authoritativeRelays, (packet, relayUrl) => {
				eventsByRelay.get(relayUrl)?.push(packet.event);
			});
			const representations = new Map<string, Event[]>();
			for (const relayUrl of world.authoritativeRelays) {
				const relayEvents = eventsByRelay.get(relayUrl) ?? [];
				for (const event of relayEvents) {
					const candidates = representations.get(event.id);
					if (candidates) candidates.push(event);
					else representations.set(event.id, [event]);
				}
			}
			const uniqueEvents = [...representations.values()].map((candidates) => [...candidates].sort(compareRepresentations)[0]);
			const rawEvents = uniqueEvents
				.sort((first, second) => second.created_at - first.created_at || compareEventIds(first, second));
			const normalCandidates = rawEvents.filter((event) => parseWorldMessage(event, world.channelId));
			const traceCandidates = rawEvents.filter((event) => parseTraceEvent(event, world.channelId));
			const boundedEvents = [
				...normalCandidates.slice(0, bootstrapLimit),
				...traceCandidates.slice(0, bootstrapLimit)
			].sort((first, second) => second.created_at - first.created_at || compareEventIds(first, second));
			const result = { rawEvents: boundedEvents, relays: diagnostics };
			traceRootBootstrapComplete = true;
			return result;
		},

		configureTraceReplies(input: TraceReplyConfiguration): Promise<TraceReplyConfigurationResult> {
			return configureTraceReplies(input);
		},

		publish: publishEvent,

		publishRealtime: publishRealtimeEvent,

		stopRealtime,

		dispose(): void {
			if (state === 'disposed') return;
			state = 'disposed';
			initialPhase = false;
			disposeRxNostr();
		}
	};
}
