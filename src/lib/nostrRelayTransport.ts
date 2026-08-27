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
import { type Observable, type Subscription } from 'rxjs';
import { verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import {
	buildPositionFilter,
	buildTraceMessageFilter,
	buildWorldMessageFilter,
	parsePositionEvent,
	parseWorldMessage,
	type ParsedPositionEvent,
	type ParsedWorldMessage,
	POSITION_SLOT_IDENTIFIERS
} from './nostrProtocol';
import { resolveChannelMetadata, type ResolvedChannelMetadata } from './nostrChannelMetadata';
import type { PrototypeWorldConfig } from './prototypeWorld';

const CHANNEL_CREATE_KIND = 40;
const CHANNEL_METADATA_KIND = 41;
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;

export type LogicalPrimarySubscription = 'world-messages' | 'world-positions';
export type PrimaryPairStatus = 'pending' | 'eose' | 'closed' | 'unavailable' | 'timeout';
export type RelayCapacity = 'insufficient' | 'primary-only' | 'trace-capable' | 'unknown';

export type MetadataDiscoveryRelayDiagnostic = Readonly<{
	relayUrl: string;
	status: 'pending' | 'eose' | 'unavailable' | 'timeout';
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
	if (!Array.isArray(values) || values.length !== expected.length) return false;
	const actual = new Set(values);
	const target = new Set(expected);
	return actual.size === values.length && actual.size === target.size && [...target].every((value) => actual.has(value));
}

function classifyPrimaryFilter(
	filters: readonly unknown[],
	channelId: string,
	positionSlots: readonly string[]
): LogicalPrimarySubscription | null {
	if (filters.length !== 1) return null;
	const entries = filterEntries(filters[0]);
	if (!entries) return null;
	const filter = Object.fromEntries(entries) as Record<string, unknown>;
	if (!Number.isSafeInteger(filter.since) || (filter.since as number) < 0) return null;

	const allowedMessageKeys = new Set(['kinds', '#e', '#L', '#l', 'since']);
	const isMessage = entries.every(([key]) => allowedMessageKeys.has(key)) &&
		hasExactly(filter.kinds, [42]) &&
		hasExactly(filter['#e'], [channelId]) &&
		hasExactly(filter['#L'], ['io.github.lokuyow.persona-bubble-field']) &&
		hasExactly(filter['#l'], ['chat']);
	if (isMessage) return 'world-messages';

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
	let initialMessages: ParsedWorldMessage[] = [];
	let initialPositions: ParsedPositionEvent[] = [];
	const messageIds = new Set<string>();
	const positionIds = new Set<string>();
	const primaryPairs = new Map<PrimaryPairKey, PrimaryPairDiagnostic>();
	const connections = new Map<string, RelayConnectionDiagnostic>();
	const relayAliases = new Map<string, string>();
	const subscriptions: Subscription[] = [];

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
		while (subscriptions.length > 0) subscriptions.pop()?.unsubscribe();
		rxNostr?.dispose();
		rxNostr = null;
	}

	async function discoverMetadata(): Promise<{ metadata: ResolvedChannelMetadata; diagnostics: MetadataDiscoveryDiagnostics }> {
		const client = requireRxNostr();
		const events = new Map<string, Event>();
		const relayDiagnostics = new Map<string, MetadataDiscoveryRelayDiagnostic>(world.metadataDiscoveryRelays.map((relayUrl) => [relayUrl, {
			relayUrl,
			status: 'pending' as const,
			receivedKind40: false,
			receivedKind41Candidates: 0
		}]));
		const aliases = new Map(world.metadataDiscoveryRelays.map((relayUrl) => [relayUrl.replace(/\/$/, ''), relayUrl]));
		const rawSubscription = client.createAllMessageObservable().subscribe((packet) => {
			const relayUrl = aliases.get(packet.from);
			if (!relayUrl) return;
			const current = relayDiagnostics.get(relayUrl);
			if (!current || current.status !== 'pending') return;
			if (packet.type === 'EOSE') relayDiagnostics.set(relayUrl, { ...current, status: 'eose' });
		});
		const connectionSubscription = client.createConnectionStateObservable().subscribe((packet) => {
			const relayUrl = aliases.get(packet.from);
			const current = relayUrl ? relayDiagnostics.get(relayUrl) : undefined;
			if (current && current.status === 'pending' && isConnectionUnavailable(packet.state)) {
				relayDiagnostics.set(relayUrl!, { ...current, status: 'unavailable' });
			}
		});

		const collect = (packet: EventPacket) => {
			events.set(packet.event.id, packet.event);
			const relayUrl = aliases.get(packet.from);
			const current = relayUrl ? relayDiagnostics.get(relayUrl) : undefined;
			if (!relayUrl || !current) return;
			if (packet.event.id === world.channelId && packet.event.kind === CHANNEL_CREATE_KIND) {
				relayDiagnostics.set(relayUrl, { ...current, receivedKind40: true });
			} else if (packet.event.kind === CHANNEL_METADATA_KIND) {
				relayDiagnostics.set(relayUrl, {
					...current,
					receivedKind41Candidates: current.receivedKind41Candidates + 1
				});
			}
		};
		const eventSubscription = client.createAllEventObservable().subscribe(collect);
		const kind40 = createRxOneshotReq({ filters: { ids: [world.channelId], kinds: [CHANNEL_CREATE_KIND] } });
		const kind41 = createRxOneshotReq({ filters: { kinds: [CHANNEL_METADATA_KIND], '#e': [world.channelId] } });
		const completion = (observable: Observable<unknown>) =>
			new Promise<void>((resolve) => observable.subscribe({ complete: resolve }));

		try {
			await Promise.all([
				completion(client.use(kind40, { on: { relays: [...world.metadataDiscoveryRelays] } })),
				completion(client.use(kind41, { on: { relays: [...world.metadataDiscoveryRelays] } }))
			]);
		} finally {
			rawSubscription.unsubscribe();
			eventSubscription.unsubscribe();
			connectionSubscription.unsubscribe();
		}

		for (const [relayUrl, current] of relayDiagnostics) {
			if (current.status === 'pending') relayDiagnostics.set(relayUrl, { ...current, status: 'timeout' });
		}
		const resolved = resolveChannelMetadata([...events.values()], world.channelId, world.preferredRelayHint);
		const result = {
			relays: [...relayDiagnostics.values()],
			uniqueEventCount: events.size
		};
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
		if (initialPhase) initialMessages.push(parsed);
		else startInput?.onLiveMessage(parsed);
	}

	function receivePosition(event: Event): void {
		if (!metadata) return;
		const parsed = parsePositionEvent(event, metadata.channelId);
		if (!parsed || positionIds.has(parsed.id)) return;
		positionIds.add(parsed.id);
		if (initialPhase) initialPositions.push(parsed);
		else startInput?.onLivePosition(parsed);
	}

	async function startPrimary(): Promise<readonly PrimaryPairDiagnostic[]> {
		const client = requireRxNostr();
		if (!metadata || !startInput) throw new Error('Primary startup is missing resolved metadata or callbacks.');
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
			const finish = () => {
				if (settled || ![...primaryPairs.values()].every((pair) => isTerminal(pair.status))) return;
				settled = true;
				if (deadline) clearTimeout(deadline);
				initialPhase = false;
				resolve(copyPairDiagnostics(primaryPairs));
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				if (deadline) clearTimeout(deadline);
				initialPhase = false;
				reject(error);
			};
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
				primarySubIds.set(`${relayUrl}\u0000${request.subId}`, logical);
			});
			const rawSubscription = client.createAllMessageObservable().subscribe((packet) => {
				if ((packet.type !== 'EOSE' && packet.type !== 'CLOSED') || !canonicalRelay(packet.from)) return;
				const relayUrl = canonicalRelay(packet.from)!;
				const logical = primarySubIds.get(`${relayUrl}\u0000${packet.subId}`);
				if (!logical) return;
				const key = pairKey(relayUrl, logical);
				const pair = primaryPairs.get(key);
				if (!pair || pair.status !== 'pending') return;
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
			subscriptions.push(outgoingSubscription, rawSubscription, stateSubscription);

			const messageRequest = createRxForwardReq();
			const positionRequest = createRxForwardReq();
			subscriptions.push(client.use(messageRequest).subscribe((packet) => receiveMessage(packet.event)));
			subscriptions.push(client.use(positionRequest).subscribe((packet) => receivePosition(packet.event)));
			deadline = setTimeout(() => {
				for (const [key, pair] of primaryPairs) {
					if (pair.status === 'pending') primaryPairs.set(key, { ...pair, status: 'timeout' });
				}
				finish();
			}, timeoutMs);
			messageRequest.emit(buildWorldMessageFilter({ channelId: metadata!.channelId, since: startInput!.messageSince }));
			positionRequest.emit(buildPositionFilter({ channelId: metadata!.channelId, since: startInput!.positionSince }));
		});
	}

	return {
		async start(input: PrimaryStartInput): Promise<PrimaryStartResult> {
			if (state !== 'new') throw new Error('Relay transport start is only allowed once.');
			assertTimestamp(input.messageSince, 'messageSince');
			assertTimestamp(input.positionSince, 'positionSince');
			state = 'starting';
			startInput = input;
			initialPhase = true;
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
				state = 'failed';
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

		async queryTrace(input: TraceQueryInput): Promise<readonly ParsedWorldMessage[]> {
			if (state !== 'started' || !metadata) throw new Error('Relay transport must start before querying trace events.');
			const filter = buildTraceMessageFilter({ channelId: metadata.channelId, ...input });
			const request = createRxOneshotReq({ filters: filter });
			const events = new Map<string, ParsedWorldMessage>();
			await new Promise<void>((resolve) => requireRxNostr().use(request).subscribe({
				next: (packet) => {
					const parsed = parseWorldMessage(packet.event, metadata!.channelId);
					if (parsed) events.set(parsed.id, parsed);
				},
				complete: resolve
			}));
			return [...events.values()];
		},

		dispose(): void {
			if (state === 'disposed') return;
			state = 'disposed';
			initialPhase = false;
			disposeRxNostr();
		}
	};
}
