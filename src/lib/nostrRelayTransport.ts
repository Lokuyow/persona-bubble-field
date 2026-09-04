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
	buildPositionFilter,
	buildTraceDirectReplyFilter,
	buildTraceNotificationFilter,
	buildTraceReplyFilter,
	buildTraceRootBootstrapFilter,
	buildWorldMessageFilters,
	parsePositionEvent,
	parseWorldMessage,
	type ParsedPositionEvent,
	type ParsedWorldMessage,
	POSITION_SLOT_IDENTIFIERS,
	PROTOTYPE_NAMESPACE,
	RECENT_MESSAGE_TIMELINE_LIMIT
} from './nostrProtocol';
import { resolveChannelMetadata, type ResolvedChannelMetadata } from './nostrChannelMetadata';
import type { PrototypeWorldConfig } from './prototypeWorld';

const CHANNEL_CREATE_KIND = 40;
const CHANNEL_METADATA_KIND = 41;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const TRACE_REPLY_RESUME_OVERLAP_SECONDS = 300;

export type LogicalPrimarySubscription = 'world-messages' | 'world-positions';
export type PrimaryPairStatus = 'pending' | 'eose' | 'closed' | 'unavailable' | 'timeout';
export type RelayCapacity = 'insufficient' | 'primary-only' | 'trace-capable' | 'unknown';
export type RelayQueryStatus = 'eose' | 'closed' | 'unavailable' | 'timeout';
export type RelayQueryDiagnostic = Readonly<{
	relayUrl: string;
	status: RelayQueryStatus;
	notice?: string;
}>;

export type MetadataDiscoveryRelayDiagnostic = Readonly<{
	relayUrl: string;
	status: 'pending' | RelayQueryStatus;
	receivedKind40: boolean;
	receivedKind41Candidates: number;
}>;

export type MetadataDiscoveryDiagnostics = Readonly<{
	relays: readonly MetadataDiscoveryRelayDiagnostic[];
	uniqueEventCount: number;
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
	metadataDiscovery: MetadataDiscoveryDiagnostics | null;
	primaryPairs: readonly PrimaryPairDiagnostic[];
	connections: readonly RelayConnectionDiagnostic[];
	nip11: readonly Nip11Diagnostic[];
	traceReplies: TraceReplyDiagnostics | null;
}>;

export type PrimaryStartInput = Readonly<{
	messageSince: number;
	positionSince: number;
	/**
	 * A validated primary event received while the finite bootstrap is still in
	 * progress. Consumers may project presence from it, but must not treat it as
	 * a canonical conversation handoff until start() resolves.
	 */
	onBootstrapMessage: (event: ParsedWorldMessage) => void;
	onBootstrapPosition: (event: ParsedPositionEvent) => void;
	/** A verified, event-ID-deduped live message and its cache-authoritative wire event. */
	onLiveMessage: (event: ParsedWorldMessage, rawEvent: Event) => void;
	onLivePosition: (event: ParsedPositionEvent) => void;
	onPrimaryClosed: (diagnostic: PrimaryPairDiagnostic) => void;
}>;

export type PrimaryStartResult = Readonly<{
	metadata: ResolvedChannelMetadata;
	metadataDiscovery: MetadataDiscoveryDiagnostics;
	messages: readonly ParsedWorldMessage[];
	positions: readonly ParsedPositionEvent[];
	primaryPairs: readonly PrimaryPairDiagnostic[];
	nip11: readonly Nip11Diagnostic[];
}>;

export type TraceRootBootstrapResult = Readonly<{
	rawEvents: readonly Event[];
	relays: readonly RelayQueryDiagnostic[];
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
	positionSlots: readonly string[]
): LogicalPrimarySubscription | null {
	const isMessageFilter = (candidate: unknown, kind: 'recent' | 'history'): boolean => {
		const entries = filterEntries(candidate);
		if (!entries) return false;
		const filter = Object.fromEntries(entries) as Record<string, unknown>;
		const allowedKeys = new Set(['kinds', '#e', '#L', '#l', kind === 'recent' ? 'since' : 'limit']);
		if (!entries.every(([key]) => allowedKeys.has(key)) ||
			!hasExactly(filter.kinds, [42]) ||
			!hasExactly(filter['#e'], [channelId]) ||
			!hasExactly(filter['#L'], [PROTOTYPE_NAMESPACE]) ||
			!hasExactly(filter['#l'], ['chat'])) return false;
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
	const isPosition = entries.every(([key]) => allowedPositionKeys.has(key)) &&
		hasExactly(filter.kinds, [30078]) &&
		hasExactly(filter['#e'], [channelId]) &&
		hasExactly(filter['#d'], positionSlots);
	return isPosition ? 'world-positions' : null;
}

function reqFromOutgoing(packet: OutgoingMessagePacket): { subId: string; filters: readonly unknown[] } | null {
	if (!Array.isArray(packet.message) || packet.message[0] !== 'REQ' || typeof packet.message[1] !== 'string') {
		return null;
	}
	return { subId: packet.message[1], filters: packet.message.slice(2) };
}

/** Compare query conditions, ignoring key order and semantically absent values. */
function matchesQueryFilter(filters: readonly unknown[], expected: Filter): boolean {
	if (filters.length !== 1) return false;
	const actualEntries = filterEntries(filters[0]);
	const expectedEntries = filterEntries(expected)!;
	if (!actualEntries || actualEntries.length !== expectedEntries.length) return false;
	const actual = Object.fromEntries(actualEntries);
	return expectedEntries.every(([key, value]) => Array.isArray(value)
		? hasExactly(actual[key], value)
		: actual[key] === value);
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

function matchesFilterBundle(filters: readonly unknown[], expected: readonly Filter[]): boolean {
	return filters.length === expected.length && expected.every((filter) => filters.some((candidate) => matchesFilter(candidate, filter)));
}

function canonicalRootIds(rootIds: readonly string[] | undefined): readonly string[] {
	return [...new Set(rootIds ?? [])].sort((first, second) => first < second ? -1 : first > second ? 1 : 0);
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
	const timeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError('operationTimeoutMs must be a positive safe integer.');
	}

	let state: TransportState = 'new';
	let rxNostr: RxNostr | null = null;
	let metadata: ResolvedChannelMetadata | null = null;
	let metadataDiagnostics: MetadataDiscoveryDiagnostics | null = null;
	let startInput: PrimaryStartInput | null = null;
	let initialPhase = false;
	const initialMessages: ParsedWorldMessage[] = [];
	const initialPositions: ParsedPositionEvent[] = [];
	const messageIds = new Set<string>();
	const positionIds = new Set<string>();
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
		if (initialPhase && isConnectionUnavailable(connectionState)) {
			for (const subscription of ['world-messages', 'world-positions'] as const) {
				const key = pairKey(canonical, subscription);
				const pair = primaryPairs.get(key);
				if (pair && pair.status === 'pending') {
					primaryPairs.set(key, { ...pair, status: 'unavailable' });
				}
			}
		}
		const generation = traceGeneration;
		const traceState = generation?.states.get(canonical);
		if (!generation || !traceState || !isConnectionUnavailable(connectionState)) return;
		if (!generation.initialSettled && traceState.initialStatus.status === 'pending') {
			finishTraceInitialRelay(generation, traceState, { relayUrl: canonical, status: 'unavailable' });
			return;
		}
		if (generation.initialSettled && traceState.cycle) {
			finishTraceCatchUp(generation, traceState, { relayUrl: canonical, status: 'unavailable' });
		}
	}

	function nip11Diagnostics(): readonly Nip11Diagnostic[] {
		if (!metadata) return [];
		return metadata.relays.map((relayUrl) => {
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
			metadataDiscovery: metadataDiagnostics,
			primaryPairs: copyPairDiagnostics(primaryPairs),
			connections: [...connections.values()].map((connection) => ({ ...connection })),
			nip11: nip11Diagnostics(),
			traceReplies: traceDiagnostics
		};
	}

	function disposeRxNostr(): void {
		cancelPrimaryStart?.();
		disposeTraceGeneration(true);
		subscriptions.unsubscribe();
		rxNostr?.dispose();
		rxNostr = null;
	}

	// Discovery and trace both need real per-relay terminal messages. use()'s
	// completion includes synthetic EOSE/timeouts, so it cannot provide this status.
	function queryRelays(
		filter: Filter,
		relays: readonly string[],
		onEvent: (packet: EventPacket, relayUrl: string) => void
	): Promise<readonly RelayQueryDiagnostic[]> {
		const client = requireRxNostr();
		const aliases = new Map(relays.map((relayUrl) => [new URL(relayUrl).toString(), relayUrl]));
		const configuredRelay = (url: string) => aliases.get(new URL(url).toString());
		const results = new Map<string, RelayQueryDiagnostic>();
		const subIds = new Map<string, string>();
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
				if (!request || !matchesQueryFilter(request.filters, filter)) return;
				const relayUrl = configuredRelay(packet.to);
				if (relayUrl && !results.has(relayUrl)) subIds.set(relayUrl, request.subId);
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
				if (connection && isConnectionUnavailable(connection) && !results.has(relayUrl)) {
					results.set(relayUrl, { relayUrl, status: 'unavailable' });
				}
			};
			resources.add(client.createConnectionStateObservable().subscribe((packet) => {
				const relayUrl = configuredRelay(packet.from);
				if (relayUrl) unavailable(relayUrl, packet.state);
				finish();
			}));
			resources.add(client.use(createRxOneshotReq({ filters: filter }), { on: { relays: [...relays] } }).subscribe());
			for (const relayUrl of relays) unavailable(relayUrl, client.getRelayStatus(relayUrl)?.connection);
			finish();
		});
	}

	async function discoverMetadata(): Promise<{ metadata: ResolvedChannelMetadata; diagnostics: MetadataDiscoveryDiagnostics }> {
		const events = new Map<string, Event>();
		const relayDiagnostics = new Map<string, MetadataDiscoveryRelayDiagnostic>(world.metadataDiscoveryRelays.map((relayUrl) => [relayUrl, {
			relayUrl,
			status: 'pending' as const,
			receivedKind40: false,
			receivedKind41Candidates: 0
		}]));
		const collect = (packet: EventPacket, relayUrl: string) => {
			events.set(packet.event.id, packet.event);
			const current = relayDiagnostics.get(relayUrl)!;
			if (packet.event.id === world.channelId && packet.event.kind === CHANNEL_CREATE_KIND) {
				relayDiagnostics.set(relayUrl, { ...current, receivedKind40: true });
			} else if (packet.event.kind === CHANNEL_METADATA_KIND) {
				relayDiagnostics.set(relayUrl, {
					...current,
					receivedKind41Candidates: current.receivedKind41Candidates + 1
				});
			}
		};
		const [kind40, kind41] = await Promise.all([
			queryRelays({ ids: [world.channelId], kinds: [CHANNEL_CREATE_KIND] }, world.metadataDiscoveryRelays, collect),
			queryRelays({ kinds: [CHANNEL_METADATA_KIND], '#e': [world.channelId] }, world.metadataDiscoveryRelays, collect)
		]);
		world.metadataDiscoveryRelays.forEach((relayUrl, index) => {
			const statuses = [kind40[index].status, kind41[index].status];
			const status: RelayQueryStatus = statuses.every((value) => value === 'eose') ? 'eose'
				: statuses.includes('unavailable') ? 'unavailable'
					: statuses.includes('timeout') ? 'timeout' : 'closed';
			relayDiagnostics.set(relayUrl, { ...relayDiagnostics.get(relayUrl)!, status });
		});
		const resolved = resolveChannelMetadata([...events.values()], world.channelId, world.preferredRelayHint);
		const result = {
			relays: [...relayDiagnostics.values()],
			uniqueEventCount: events.size
		};
		metadataDiagnostics = result;
		if (!resolved) throw new Error('NIP-28 channel metadata resolution failed.');
		return { metadata: resolved, diagnostics: result };
	}

	function registerAuthoritativeRelays(resolved: ResolvedChannelMetadata): void {
		const client = requireRxNostr();
		client.setDefaultRelays([...resolved.relays]);
		for (const relayUrl of resolved.relays) {
			const normalized = client.getDefaultRelay(relayUrl)?.url;
			if (!normalized) throw new Error(`Resolved relay was not registered: ${relayUrl}`);
			relayAliases.set(relayUrl, relayUrl);
			relayAliases.set(normalized, relayUrl);
			relayAliases.set(new URL(normalized).toString(), relayUrl);
			connections.set(relayUrl, { relayUrl, state: client.getRelayStatus(relayUrl)?.connection ?? 'initialized' });
		}
	}

	function receiveMessage(event: Event): void {
		if (!metadata) return;
		const parsed = parseWorldMessage(event, metadata.channelId);
		if (!parsed || messageIds.has(parsed.id)) return;
		messageIds.add(parsed.id);
		if (initialPhase) {
			initialMessages.push(parsed);
			startInput?.onBootstrapMessage(parsed);
		}
		else startInput?.onLiveMessage(parsed, event);
	}

	function receivePosition(event: Event): void {
		if (!metadata) return;
		const parsed = parsePositionEvent(event, metadata.channelId);
		if (!parsed || positionIds.has(parsed.id)) return;
		positionIds.add(parsed.id);
		if (initialPhase) {
			initialPositions.push(parsed);
			startInput?.onBootstrapPosition(parsed);
		}
		else startInput?.onLivePosition(parsed);
	}

	async function startPrimary(): Promise<readonly PrimaryPairDiagnostic[]> {
		const client = requireRxNostr();
		if (!metadata || !startInput) throw new Error('Primary startup is missing resolved metadata or callbacks.');
		initialPhase = true;
		const positionSlots = POSITION_SLOT_IDENTIFIERS;
		for (const relayUrl of metadata.relays) {
			for (const subscription of ['world-messages', 'world-positions'] as const) {
				primaryPairs.set(pairKey(relayUrl, subscription), { relayUrl, subscription, status: 'pending' });
			}
		}

		return await new Promise<readonly PrimaryPairDiagnostic[]>((resolve, reject) => {
			let settled = false;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			const primarySubIds = new Map<string, LogicalPrimarySubscription>();
			const activeSubIds = new Map<PrimaryPairKey, string>();
			const closedSubIds = new Set<string>();
			const finish = () => {
				if (settled || ![...primaryPairs.values()].every((pair) => isTerminal(pair.status))) return;
				settled = true;
				cancelPrimaryStart = null;
				if (deadline) clearTimeout(deadline);
				initialPhase = false;
				resolve(copyPairDiagnostics(primaryPairs));
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cancelPrimaryStart = null;
				if (deadline) clearTimeout(deadline);
				initialPhase = false;
				reject(error);
			};
			cancelPrimaryStart = () => fail(new Error('Relay transport disposed during primary initialization.'));
			const outgoingSubscription = client.createOutgoingMessageObservable().subscribe((packet) => {
				const request = reqFromOutgoing(packet);
				if (!request) return;
				const relayUrl = canonicalRelay(packet.to);
				if (!relayUrl) return;
				const logical = classifyPrimaryFilter(request.filters, metadata!.channelId, positionSlots);
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
				if (logical === 'world-messages') receiveMessage(packet.event);
				else receivePosition(packet.event);
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
			messageRequest.emit(buildWorldMessageFilters({ channelId: metadata!.channelId, since: startInput!.messageSince }));
			positionRequest.emit(buildPositionFilter({ channelId: metadata!.channelId, since: startInput!.positionSince }));
			for (const relayUrl of metadata!.relays) {
				const connection = client.getRelayStatus(relayUrl)?.connection;
				if (connection) updateConnection(relayUrl, connection);
			}
			finish();
		});
	}

	function copyTraceDiagnostic(diagnostic: TraceReplyRelayDiagnostic): TraceReplyRelayDiagnostic {
		return { ...diagnostic };
	}

	function refreshTraceDiagnostics(generation: TraceGeneration | null, status: TraceReplyDiagnostics['status']): void {
		traceDiagnostics = generation
			? {
				generation: generation.id,
				status,
				relays: metadata!.relays.map((relayUrl) => copyTraceDiagnostic(generation.states.get(relayUrl)!.initialStatus))
			}
			: { generation: traceGenerationSequence, status: 'inactive', relays: [] };
	}

	function traceScopes(input: TraceReplyConfiguration): { scopes: readonly TraceScope[]; semanticKey: string } {
		const scopes: TraceScope[] = [];
		const notification = input.notification;
		if (notification) {
			assertTimestamp(notification.initialSince, 'notification initialSince');
			const effectiveRootIds = canonicalRootIds(notification.effectiveRootIds);
			const initialFilter = buildTraceNotificationFilter({
				personaPubkey: notification.personaPubkey,
				...(effectiveRootIds.length > 0 ? { effectiveRootIds } : {})
			});
			scopes.push({
				key: `notification\u0000${notification.personaPubkey}\u0000${effectiveRootIds.join('\u0000')}`,
				kind: 'notification',
				initialFilter: { ...initialFilter, since: notification.initialSince },
				initialSince: notification.initialSince
			});
		}
		if (input.conversation) {
			const { rootId, currentId } = input.conversation;
			scopes.push({ key: `root\u0000${rootId}`, kind: 'root', initialFilter: buildTraceReplyFilter({ rootId }) });
			scopes.push({ key: `direct\u0000${rootId}\u0000${currentId}`, kind: 'direct', initialFilter: buildTraceDirectReplyFilter({ rootId, currentId }) });
		}
		return { scopes, semanticKey: JSON.stringify(scopes.map((scope) => [scope.key, scope.initialFilter])) };
	}

	function traceFilters(generation: TraceGeneration, relay: TraceRelayState): Filter[] {
		return generation.scopes.map((scope) => {
			if (relay.forms.get(scope.key) !== 'continuation') return { ...scope.initialFilter };
			const cursor = relay.stableCursors.get(scope.key);
			if (cursor === undefined) throw new Error('Trace continuation is missing a stable cursor.');
			const filter = { ...scope.initialFilter, since: cursor } as Record<string, unknown>;
			if (scope.kind !== 'notification') delete filter.limit;
			return filter as Filter;
		});
	}

	function traceBoundary(scope: TraceScope, cycleBoundary: number): number {
		const overlap = Math.max(0, cycleBoundary - TRACE_REPLY_RESUME_OVERLAP_SECONDS);
		return scope.kind === 'notification' ? Math.max(scope.initialSince!, overlap) : overlap;
	}

	function traceInitialTerminal(generation: TraceGeneration, relay: TraceRelayState): boolean {
		return relay.initialStatus.status !== 'pending';
	}

	function startTraceCycle(generation: TraceGeneration, relay: TraceRelayState, kind: TraceCycleKind): void {
		if (generation !== traceGeneration || !generation.active) return;
		if (relay.cycle?.timer) clearTimeout(relay.cycle.timer);
		const cycle: TraceCycle = { kind, cycleBoundary: unixNow(), events: [], timer: null };
		relay.cycle = cycle;
		if (kind === 'catch-up') {
			cycle.timer = setTimeout(() => {
				if (generation === traceGeneration && generation.active && relay.cycle === cycle) {
					finishTraceCatchUp(generation, relay, { relayUrl: relay.relayUrl, status: 'timeout' });
				}
			}, timeoutMs);
		}
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
				relays: metadata!.relays.map((relayUrl) => copyTraceDiagnostic(generation.states.get(relayUrl)!.initialStatus))
			}
		};
		generation.settledResult = result;
		refreshTraceDiagnostics(generation, 'active');
		generation.resolve(result);
		queueMicrotask(() => {
			if (generation !== traceGeneration || !generation.active) return;
			for (const relay of generation.states.values()) {
				if (relay.initialStatus.status === 'eose') transitionTraceRelay(generation, relay);
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
		}
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
		if (state !== 'started' || !metadata || !traceRootBootstrapComplete) {
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
		for (const relayUrl of metadata.relays) {
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
			if (!relay || !matchesFilterBundle(request.filters, traceFilters(generation, relay))) return;
			relay.subId = request.subId;
			if (!generation.initialSettled) {
				if (!traceInitialTerminal(generation, relay) && !relay.cycle) startTraceCycle(generation, relay, 'initial');
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
			else finishTraceCatchUp(generation, relay, diagnostic);
		}));
		generation.initialDeadline = setTimeout(() => {
			if (generation !== traceGeneration || generation.initialSettled) return;
			for (const relay of generation.states.values()) {
				finishTraceInitialRelay(generation, relay, { relayUrl: relay.relayUrl, status: 'timeout' });
			}
		}, timeoutMs);
		refreshTraceDiagnostics(generation, 'initializing');
		for (const relay of generation.states.values()) relay.req.emit(traceFilters(generation, relay));
		for (const relayUrl of metadata.relays) {
			const connection = client.getRelayStatus(relayUrl)?.connection;
			if (connection) updateConnection(relayUrl, connection);
		}
		return generation.initialPromise;
	}

	function clientUseTraceRequest(req: TraceRelayState['req'], relayUrl: string): Subscription {
		return requireRxNostr().use(req, { on: { relays: [relayUrl] } }).subscribe();
	}

	return {
		async start(input: PrimaryStartInput): Promise<PrimaryStartResult> {
			if (state !== 'new') throw new Error('Relay transport start is only allowed once.');
			assertTimestamp(input.messageSince, 'messageSince');
			assertTimestamp(input.positionSince, 'positionSince');
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
				const discovered = await discoverMetadata();
				metadata = discovered.metadata;
				metadataDiagnostics = discovered.diagnostics;
				registerAuthoritativeRelays(metadata);
				const pairs = await startPrimary();
				state = 'started';
				return {
					metadata,
					metadataDiscovery: metadataDiagnostics,
					messages: [...initialMessages],
					positions: [...initialPositions],
					primaryPairs: pairs,
					nip11: nip11Diagnostics()
				};
			} catch (error) {
				if ((state as TransportState) !== 'disposed') state = 'failed';
				disposeRxNostr();
				throw error;
			}
		},

		getDiagnostics(): NostrRelayTransportDiagnostics {
			return diagnostics();
		},

		async bootstrapTraceRootCandidates(): Promise<TraceRootBootstrapResult> {
			if (state !== 'started' || !metadata) {
				throw new Error('Relay transport must start before trace root bootstrap.');
			}
			if (traceRootBootstrapStarted) {
				throw new Error('Trace root bootstrap is only allowed once.');
			}
			traceRootBootstrapStarted = true;
			const filter = buildTraceRootBootstrapFilter({ channelId: metadata.channelId });
			const eventsByRelay = new Map<string, Event[]>(metadata.relays.map((relayUrl) => [relayUrl, []]));
			const diagnostics = await queryRelays(filter, metadata.relays, (packet, relayUrl) => {
				eventsByRelay.get(relayUrl)?.push(packet.event);
			});
			const uniqueEvents = new Map<string, Event>();
			for (const relayUrl of metadata.relays) {
				const relayEvents = eventsByRelay.get(relayUrl) ?? [];
				const representations = new Map<string, Event[]>();
				for (const event of relayEvents) {
					const candidates = representations.get(event.id);
					if (candidates) candidates.push(event);
					else representations.set(event.id, [event]);
				}
				for (const candidates of representations.values()) {
					const selected = [...candidates].sort(compareRepresentations)[0];
					if (!uniqueEvents.has(selected.id)) uniqueEvents.set(selected.id, selected);
				}
			}
			const rawEvents = [...uniqueEvents.values()]
				.sort((first, second) => second.created_at - first.created_at || compareEventIds(first, second))
				.slice(0, filter.limit!);
			const result = { rawEvents, relays: diagnostics };
			traceRootBootstrapComplete = true;
			return result;
		},

		configureTraceReplies(input: TraceReplyConfiguration): Promise<TraceReplyConfigurationResult> {
			return configureTraceReplies(input);
		},

		async publish(event: VerifiedEvent): Promise<readonly PublishRelayResult[]> {
			if (state !== 'started' || !metadata) throw new Error('Relay transport must start before publishing.');
			const client = requireRxNostr();
			const results = new Map<string, PublishRelayResult>(metadata.relays.map((relayUrl) => [relayUrl, {
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
		},

		dispose(): void {
			if (state === 'disposed') return;
			state = 'disposed';
			initialPhase = false;
			disposeRxNostr();
		}
	};
}
