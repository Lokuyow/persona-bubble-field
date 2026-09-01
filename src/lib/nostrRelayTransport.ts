import {
	Nip11Registry,
	createRxForwardReq,
	createRxNostr,
	createRxOneshotReq,
	noopSigner,
	type ConnectionState,
	type EventPacket,
	type IWebSocketConstructor,
	type OutgoingMessagePacket,
	type RxNostr
} from 'rx-nostr';
import { Subscription } from 'rxjs';
import type { Filter } from 'nostr-tools/filter';
import { verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import {
	buildPositionFilter,
	buildTraceMessageFilter,
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

export type NostrRelayTransportDiagnostics = Readonly<{
	metadataDiscovery: MetadataDiscoveryDiagnostics | null;
	primaryPairs: readonly PrimaryPairDiagnostic[];
	connections: readonly RelayConnectionDiagnostic[];
	nip11: readonly Nip11Diagnostic[];
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
	onLiveMessage: (event: ParsedWorldMessage) => void;
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

export type PublishRelayResult = Readonly<{
	relayUrl: string;
	outcome: 'accepted' | 'rejected' | 'no-response';
	notice?: string;
}>;

export type TraceQueryInput = Readonly<{
	positions: Parameters<typeof buildTraceMessageFilter>[0]['positions'];
	since?: number;
	until?: number;
}>;

export type TraceQueryResult = Readonly<{
	messages: readonly ParsedWorldMessage[];
	relays: readonly RelayQueryDiagnostic[];
}>;

export type NostrRelayTransportOptions = Readonly<{
	operationTimeoutMs?: number;
	websocketCtor?: IWebSocketConstructor;
}>;

type TransportState = 'new' | 'starting' | 'started' | 'failed' | 'disposed';
type PrimaryPairKey = `${string}\u0000${LogicalPrimarySubscription}`;

function assertTimestamp(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer in Unix seconds.`);
	}
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

function copyPairDiagnostics(pairs: ReadonlyMap<PrimaryPairKey, PrimaryPairDiagnostic>): readonly PrimaryPairDiagnostic[] {
	return [...pairs.values()].map((pair) => ({ ...pair }));
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
	const pendingTraces: { filter: Filter; result: Promise<TraceQueryResult> }[] = [];

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
		if (!initialPhase || !isConnectionUnavailable(connectionState)) return;
		for (const subscription of ['world-messages', 'world-positions'] as const) {
			const key = pairKey(canonical, subscription);
			const pair = primaryPairs.get(key);
			if (pair && pair.status === 'pending') {
				primaryPairs.set(key, { ...pair, status: 'unavailable' });
			}
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
			nip11: nip11Diagnostics()
		};
	}

	function disposeRxNostr(): void {
		cancelPrimaryStart?.();
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
		else startInput?.onLiveMessage(parsed);
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

		async queryTrace(input: TraceQueryInput): Promise<TraceQueryResult> {
			if (state !== 'started' || !metadata) throw new Error('Relay transport must start before querying trace events.');
			const filter = buildTraceMessageFilter({ channelId: metadata.channelId, ...input });
			// Identical in-flight filters cannot identify two different logical
			// requests through outgoing semantics. Share that finite query only.
			const existing = pendingTraces.find((query) => matchesQueryFilter([filter], query.filter));
			if (existing) return existing.result;
			const events = new Map<string, ParsedWorldMessage>();
			const result = queryRelays(filter, metadata.relays, (packet) => {
				const parsed = parseWorldMessage(packet.event, metadata!.channelId);
				if (parsed) events.set(parsed.id, parsed);
			}).then((relays) => ({ messages: [...events.values()], relays }));
			const pending = { filter, result };
			pendingTraces.push(pending);
			try {
				return await result;
			} finally {
				pendingTraces.splice(pendingTraces.indexOf(pending), 1);
			}
		},

		dispose(): void {
			if (state === 'disposed') return;
			state = 'disposed';
			initialPhase = false;
			disposeRxNostr();
		}
	};
}
