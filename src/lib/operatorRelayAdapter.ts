import { SimplePool } from 'nostr-tools/pool';
import type { Event, VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';

export type OperatorRelayQueryStatus = 'eose' | 'closed' | 'timeout' | 'connection-failure';

export type OperatorRelayQueryDiagnostic = Readonly<{
	relayUrl: string;
	status: OperatorRelayQueryStatus;
	notice?: string;
}>;

export type OperatorRelayQueryResult = Readonly<{
	events: readonly Event[];
	eventSources: readonly Readonly<{ event: Event; relayUrl: string }>[];
	relays: readonly OperatorRelayQueryDiagnostic[];
	eoseCount: number;
}>;

export type OperatorRelayPublishOutcome = 'accepted' | 'rejected' | 'timeout' | 'connection-failure';

export type OperatorRelayPublishResult = Readonly<{
	relayUrl: string;
	outcome: OperatorRelayPublishOutcome;
	notice?: string;
}>;

type RelaySubscription = Readonly<{
	close: (reason?: string) => void;
}>;

export type OperatorRelayConnection = {
	readonly connected?: boolean;
	onnotice: (message: string) => void;
	subscribe: (filters: Filter[], params: Readonly<{
		onevent: (event: Event) => void;
		oneose: () => void;
		onclose: (reason: string) => void;
		eoseTimeout?: number;
	}>) => RelaySubscription;
	publish: (event: VerifiedEvent) => Promise<string>;
};

export type OperatorRelayPool = Readonly<{
	ensureRelay: (url: string, params?: Readonly<{ connectionTimeout?: number }>) => Promise<OperatorRelayConnection>;
	close: (relays: string[]) => void;
}>;

export type OperatorRelayAdapter = Readonly<{
	query: (filter: Filter, relays: readonly string[]) => Promise<OperatorRelayQueryResult>;
	publish: (event: VerifiedEvent, relays: readonly string[]) => Promise<readonly OperatorRelayPublishResult[]>;
	close: () => void;
}>;

export type OperatorRelayAdapterOptions = Readonly<{
	operationTimeoutMs?: number;
	poolFactory?: () => OperatorRelayPool;
}>;

const DEFAULT_OPERATOR_TIMEOUT_MS = 10_000;

function isErrorWithMessage(value: unknown): value is { message: string } {
	return value instanceof Error && typeof value.message === 'string';
}

function classifyPublishFailure(error: unknown, relay: OperatorRelayConnection): Readonly<{ outcome: 'rejected' | 'timeout' | 'connection-failure'; notice?: string }> {
	const message = isErrorWithMessage(error) ? error.message : '';
	if (/timed? out|timeout/i.test(message)) return { outcome: 'timeout', notice: message };
	if (relay.connected === false || /sending .*closed|(?:socket|websocket).*(?:closed|not open)|connection (?:closed|reset|lost|failed)|econn|enotfound|eai_again|network (?:error|unreachable)/i.test(message)) {
		return { outcome: 'connection-failure', notice: message || undefined };
	}
	return { outcome: 'rejected', notice: message || undefined };
}

function classifySubscriptionClose(reason: string): Readonly<{ status: 'closed' | 'connection-failure'; notice?: string }> {
	if (/relay connection (?:closed|failed|timed out)/i.test(reason)) return { status: 'connection-failure', notice: reason };
	return { status: 'closed', notice: reason };
}

/** Disable nostr-tools' default raw NOTICE logger at the operator boundary. */
export function prepareOperatorRelayConnection(relay: OperatorRelayConnection): OperatorRelayConnection {
	relay.onnotice = () => {};
	return relay;
}

export function createOperatorRelayAdapter(options: OperatorRelayAdapterOptions = {}): OperatorRelayAdapter {
	const timeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATOR_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('operationTimeoutMs must be a positive safe integer.');
	const pool = options.poolFactory?.() ?? new SimplePool();
	const usedRelays = new Set<string>();
	let closed = false;

	async function queryRelay(
		filter: Filter,
		relayUrl: string,
		events: Map<string, Event>,
		eventSources: Map<string, Readonly<{ event: Event; relayUrl: string }>>
	): Promise<OperatorRelayQueryDiagnostic> {
		usedRelays.add(relayUrl);
		let subscription: RelaySubscription | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let terminal = false;
		return await new Promise<OperatorRelayQueryDiagnostic>((resolve) => {
			const finish = (diagnostic: OperatorRelayQueryDiagnostic) => {
				if (terminal) return;
				terminal = true;
				if (timer) clearTimeout(timer);
				try { subscription?.close('operator finite query terminal'); } catch { /* final adapter cleanup owns the connection */ }
				resolve(diagnostic);
			};
			void (async () => {
				try {
						const relay = prepareOperatorRelayConnection(await pool.ensureRelay(relayUrl, { connectionTimeout: timeoutMs }));
					if (terminal) return;
					timer = setTimeout(() => finish({ relayUrl, status: 'timeout' }), timeoutMs);
					subscription = relay.subscribe([filter], {
						onevent: (event) => {
							if (terminal) return;
							events.set(event.id, event);
							if (!eventSources.has(event.id)) eventSources.set(event.id, { event, relayUrl });
						},
						oneose: () => finish({ relayUrl, status: 'eose' }),
						onclose: (reason) => {
							const diagnostic = classifySubscriptionClose(reason);
							finish({ relayUrl, ...diagnostic });
						},
						eoseTimeout: timeoutMs + 1
					});
				} catch (error) {
					const notice = isErrorWithMessage(error) ? error.message : undefined;
					finish({ relayUrl, status: 'connection-failure', ...(notice ? { notice } : {}) });
				}
			})();
		});
	}

	async function query(filter: Filter, relays: readonly string[]): Promise<OperatorRelayQueryResult> {
		if (closed) throw new Error('Operator Relay adapter is closed.');
		const events = new Map<string, Event>();
		const eventSources = new Map<string, Readonly<{ event: Event; relayUrl: string }>>();
		const diagnostics = await Promise.all(relays.map((relayUrl) => queryRelay(filter, relayUrl, events, eventSources)));
		return { events: [...events.values()], eventSources: [...eventSources.values()], relays: diagnostics, eoseCount: diagnostics.filter((diagnostic) => diagnostic.status === 'eose').length };
	}

	async function publish(event: VerifiedEvent, relays: readonly string[]): Promise<readonly OperatorRelayPublishResult[]> {
		if (closed) throw new Error('Operator Relay adapter is closed.');
		return await Promise.all(relays.map(async (relayUrl): Promise<OperatorRelayPublishResult> => {
			usedRelays.add(relayUrl);
			let relay: OperatorRelayConnection;
			try {
				relay = prepareOperatorRelayConnection(await pool.ensureRelay(relayUrl, { connectionTimeout: timeoutMs }));
			} catch (error) {
				const notice = isErrorWithMessage(error) ? error.message : undefined;
				return { relayUrl, outcome: 'connection-failure', ...(notice ? { notice } : {}) };
			}
			try {
				await relay.publish(event);
				return { relayUrl, outcome: 'accepted' };
			} catch (error) {
				return { relayUrl, ...classifyPublishFailure(error, relay) };
			}
		}));
	}

	function close(): void {
		if (closed) return;
		closed = true;
		try { pool.close([...usedRelays]); } catch { /* cleanup must not mask the command result */ }
	}

	return { query, publish, close };
}
