import { Server, WebSocket, type Client } from 'mock-socket';
import { finalizeEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import { map } from 'rxjs';
import {
	Nip11Registry, createRxNostr, createRxForwardReq, createRxOneshotReq,
	type RxNostr, type IWebSocketConstructor
} from 'rx-nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNostrRelayTransport } from './nostrRelayTransport';
import {
	buildTraceRootBootstrapFilter, buildWorldMessageTemplate, buildPositionEventTemplate, buildWorldMessageFilter
} from './nostrProtocol';

// Capture only the public client. Tests still use the installed package,
// real RxReqs and mock WebSockets; no internal IDs or fields are inspected.
vi.mock('rx-nostr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('rx-nostr')>();
	return { ...actual, createRxNostr: vi.fn(actual.createRxNostr), createRxForwardReq: vi.fn(actual.createRxForwardReq) };
});

const actualRxNostr = await vi.importActual<typeof import('rx-nostr')>('rx-nostr');
const CREATOR = new Uint8Array(32).fill(11);
const AUTHOR = new Uint8Array(32).fill(12);
const TIME = 1_700_000_010;
const TIMEOUT = 100;
const socketConstructor = WebSocket as unknown as IWebSocketConstructor;
const servers: Server[] = [];
const transports: ReturnType<typeof createNostrRelayTransport>[] = [];
let relaySequence = 0;
type WireRequest = ['REQ', string, ...Record<string, unknown>[]];

function filters(request: WireRequest): readonly Record<string, unknown>[] {
	return request.slice(2) as Record<string, unknown>[];
}

function kind(request: WireRequest): number | undefined {
	return (filters(request)[0].kinds as number[])[0];
}

function send(socket: Client, ...message: unknown[]): void {
	socket.send(JSON.stringify(message));
}

function mockRelay() {
	const url = `ws://relay-${++relaySequence}.test/`;
	Nip11Registry.set(url, { limitation: { max_subscriptions: 8 } });
	const server = new Server(url, { mock: false });
	servers.push(server);
	const relay = {
		url, server,
		requests: [] as WireRequest[],
		messages: [] as unknown[][],
		sockets: [] as Client[],
		onConnection: (_socket: Client) => {},
		onRequest: (socket: Client, request: WireRequest) => send(socket, 'EOSE', request[1]),
		onPublish: (_socket: Client, _event: VerifiedEvent) => {},
		primaryRequests: (): WireRequest[] => relay.requests.filter((request) => [42, 30078].includes(kind(request)!) && request[2].limit === undefined),
		traceRequests: (): WireRequest[] => relay.requests.filter((request) => filters(request).every((filter) => (filter.kinds as number[])[0] === 1111)),
		rootRequests: (): WireRequest[] => relay.requests.filter((request) => kind(request) === 42 && request[2].limit === 1000),
		primaryId: (eventKind: 42 | 30078): string => relay.primaryRequests().filter((request) => kind(request) === eventKind).at(-1)![1],
		latestSocket: (): Client => relay.sockets.at(-1)!
	};
	server.on('connection', (socket) => {
		relay.sockets.push(socket);
		socket.on('message', (data) => {
			const message = JSON.parse(data as string) as unknown[];
			relay.messages.push(message);
			if (message[0] === 'REQ') {
				const request = message as WireRequest;
				relay.requests.push(request);
				relay.onRequest(socket, request);
			} else if (message[0] === 'EVENT') relay.onPublish(socket, message[1] as VerifiedEvent);
		});
		relay.onConnection(socket);
	});
	return relay;
}

function rawEvent(id: string, createdAt = TIME, overrides: Partial<Event> = {}): Event {
	return {
		id,
		pubkey: 'd'.repeat(64),
		created_at: createdAt,
		kind: 42,
		tags: [],
		content: 'raw',
		sig: '0'.repeat(128),
		...overrides
	};
}

function fixture(authorityCount = 2, websocketCtor = socketConstructor, operationTimeoutMs = TIMEOUT) {
	const seeds = Array.from({ length: 4 }, () => mockRelay());
	const authorities = Array.from({ length: authorityCount }, () => mockRelay());
	const channel = finalizeEvent({ kind: 40, created_at: TIME - 10, tags: [], content: JSON.stringify({ relays: [authorities[0].url] }) }, CREATOR);
	const metadata = finalizeEvent({ kind: 41, created_at: TIME - 9, tags: [['e', channel.id]], content: JSON.stringify({ relays: authorities.map((relay) => relay.url) }) }, CREATOR);
	seeds.forEach((relay, index) => {
		relay.onRequest = (socket, request) => {
			if (kind(request) === 40 && index === 0) send(socket, 'EVENT', request[1], channel);
			if (kind(request) === 41 && index === 1) send(socket, 'EVENT', request[1], metadata);
			send(socket, 'EOSE', request[1]);
		};
	});
	const config = { channelId: channel.id, metadataDiscoveryRelays: seeds.map((relay) => relay.url), preferredRelayHint: authorities[0].url };
	const transport = createNostrRelayTransport(config, { operationTimeoutMs, websocketCtor });
	transports.push(transport);
	const input = {
		messageSince: TIME - 50,
		positionSince: TIME - 100,
		onBootstrapMessage: vi.fn(),
		onBootstrapPosition: vi.fn(),
		onLiveMessage: vi.fn(),
		onLivePosition: vi.fn(),
		onPrimaryClosed: vi.fn()
	};
	const reference = { channelId: channel.id, relayHint: authorities[0].url };
	const message = (content = 'hello', createdAt = TIME) => finalizeEvent(buildWorldMessageTemplate({ channel: reference, content, createdAt, speechType: 'normal', position: { x: 1, y: 2 } }), AUTHOR);
	const position = (createdAt = TIME) => finalizeEvent(buildPositionEventTemplate({ channel: reference, createdAt, slot: 0, position: { x: 1, y: 2 } }), AUTHOR);
	const start = async (elapsed = 30) => {
		const pending = transport.start(input);
		await vi.advanceTimersByTimeAsync(elapsed);
		return pending;
	};
	return { seeds, authorities, channel, metadata, config, transport, input, message, position, start };
}

async function completeTraceRootBootstrap(transport: ReturnType<typeof createNostrRelayTransport>): Promise<void> {
	const pending = transport.bootstrapTraceRootCandidates();
	await vi.advanceTimersByTimeAsync(10);
	await pending;
}

function traceInput(rootId: string, currentId = 'e'.repeat(64)) {
	return {
		notification: { personaPubkey: 'c'.repeat(64), effectiveRootIds: [rootId], initialSince: TIME - 600 },
		conversation: { rootId, currentId },
		onBatch: vi.fn(),
		onLiveEvent: vi.fn()
	};
}

function traceReply(rootId: string, id: string, createdAt = TIME, currentId = 'e'.repeat(64)): Event {
	return rawEvent(id, createdAt, {
		kind: 1111,
		tags: [
			['E', rootId], ['e', currentId], ['p', 'c'.repeat(64)],
			['L', 'io.github.lokuyow.persona-bubble-field'], ['l', 'chat']
		]
	});
}

function publicClient(): RxNostr {
	return vi.mocked(createRxNostr).mock.results.at(-1)!.value as RxNostr;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(TIME * 1000);
	vi.mocked(createRxNostr).mockReset().mockImplementation(actualRxNostr.createRxNostr);
	vi.mocked(createRxForwardReq).mockReset().mockImplementation(actualRxNostr.createRxForwardReq);
	Nip11Registry.forgetAll();
	vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('Unexpected external network in transport test.'))));
});

afterEach(async () => {
	while (transports.length) transports.pop()!.dispose();
	await vi.runOnlyPendingTimersAsync();
	while (servers.length) servers.pop()!.stop();
	Nip11Registry.forgetAll();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('primary lifecycle', () => {
	it('does not start primary REQs while metadata discovery is still non-terminal', async () => {
		const f = fixture(1);
		for (const relay of f.seeds) relay.onRequest = () => {};
		const pending = f.transport.start(f.input);
		void pending.catch(() => {});

		await vi.advanceTimersByTimeAsync(TIMEOUT - 1);

		expect(f.authorities[0].primaryRequests()).toEqual([]);
	});

	it('sends recent and timeline history filters in one world-messages REQ while keeping two logical primaries', async () => {
		const f = fixture(2);
		const result = await f.start();

		for (const relay of f.authorities) {
			const messageRequests = relay.primaryRequests().filter((request) => kind(request) === 42);
			expect(messageRequests).toHaveLength(1);
			expect(messageRequests[0]).toHaveLength(4);
			expect(messageRequests[0][2]).toMatchObject({ kinds: [42], since: f.input.messageSince });
			expect(messageRequests[0][3]).toMatchObject({ kinds: [42], limit: 50 });
			expect(messageRequests[0][3].since).toBeUndefined();
		}
		expect(result.primaryPairs).toHaveLength(4);
		expect(result.primaryPairs.map((pair) => pair.subscription)).toEqual([
			'world-messages', 'world-positions', 'world-messages', 'world-positions'
		]);
	});

	it('keeps an EVENT immediately preceding the final EOSE in the initial position batch', async () => {
		const f = fixture(1);
		const event = f.position();
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 30078) send(socket, 'EVENT', request[1], event);
			send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.positions.map((position) => position.id)).toEqual([event.id]);
		expect(f.input.onLivePosition).not.toHaveBeenCalled();
	});

	it('projects each verified primary bootstrap event before final EOSE and retains it once in the snapshot', async () => {
		const f = fixture(1);
		const event = f.message('bootstrap-before-eose');
		let messageRequestId: string | null = null;
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 42) {
				messageRequestId = request[1];
				send(socket, 'EVENT', request[1], event);
				return;
			}
			send(socket, 'EOSE', request[1]);
		};
		let settled = false;
		const pending = f.transport.start(f.input).then((result) => {
			settled = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(30);

		expect(f.input.onBootstrapMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: event.id }));
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(settled).toBe(false);
		send(f.authorities[0].latestSocket(), 'EOSE', messageRequestId!);
		await vi.advanceTimersByTimeAsync(5);

		await expect(pending).resolves.toMatchObject({ messages: [expect.objectContaining({ id: event.id })] });
		expect(f.input.onBootstrapMessage).toHaveBeenCalledTimes(1);
	});

	it('buffers stored messages/positions, then delivers each live event only once', async () => {
		const f = fixture();
		const storedMessage = f.message();
		const storedPosition = f.position();
		for (const relay of f.authorities) relay.onRequest = (socket, request) => {
			send(socket, 'EVENT', request[1], kind(request) === 42 ? storedMessage : storedPosition);
			send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.messages.map((event) => event.id)).toEqual([storedMessage.id]);
		expect(result.positions.map((event) => event.id)).toEqual([storedPosition.id]);
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(f.input.onLivePosition).not.toHaveBeenCalled();
		const liveMessage = f.message('live', TIME + 1);
		const livePosition = f.position(TIME + 1);
		for (const relay of f.authorities) {
			send(relay.latestSocket(), 'EVENT', relay.primaryId(42), liveMessage);
			send(relay.latestSocket(), 'EVENT', relay.primaryId(30078), livePosition);
			send(relay.latestSocket(), 'EVENT', relay.primaryId(42), storedMessage);
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: liveMessage.id }), expect.objectContaining({ id: liveMessage.id })
		);
		expect(f.input.onLivePosition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: livePosition.id }));
		expect(f.authorities.map((relay) => relay.sockets.length)).toEqual([1, 1]);
		expect(f.authorities.flatMap((relay) => relay.messages.filter((message) => message[0] === 'CLOSE'))).toEqual([]);
	});

	it('correlates arbitrary EOSE order and ignores unrelated subIds', async () => {
		const f = fixture();
		for (const relay of f.authorities) relay.onRequest = () => {};
		let settled = false;
		const pending = f.transport.start(f.input).then((result) => { settled = true; return result; });
		await vi.advanceTimersByTimeAsync(30);
		const [a, b] = f.authorities;
		send(a.latestSocket(), 'EOSE', 'unrelated opaque value');
		send(b.latestSocket(), 'EOSE', b.primaryId(30078));
		send(a.latestSocket(), 'EOSE', a.primaryId(42));
		send(a.latestSocket(), 'EOSE', a.primaryId(30078));
		await vi.advanceTimersByTimeAsync(5);
		expect(settled).toBe(false);
		send(b.latestSocket(), 'EOSE', b.primaryId(42));
		await vi.advanceTimersByTimeAsync(5);
		expect((await pending).primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'eose', 'eose']);
	});

	it('settles CLOSED before EOSE and notifies only once', async () => {
		const f = fixture();
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 42) {
				send(socket, 'CLOSED', request[1], 'restricted: denied');
				send(socket, 'CLOSED', request[1], 'restricted: duplicate');
			} else send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.primaryPairs.map((pair) => pair.status)).toEqual(['closed', 'eose', 'eose', 'eose']);
		expect(f.input.onPrimaryClosed).toHaveBeenCalledTimes(1);
	});

	it('starts with available relay A when relay B cannot connect or send a REQ', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => actualRxNostr.createRxNostr({ ...config, retry: { strategy: 'off' } }));
		const f = fixture();
		f.authorities[1].server.options!.verifyClient = () => false;
		const result = await f.start(150);
		expect(result.primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'unavailable', 'unavailable']);
		expect(f.authorities[1].requests).toEqual([]);
		expect(f.transport.getDiagnostics().connections[1].state).toBe('error');
	});

	it('times out unresolved pairs without losing completed pairs or initial events', async () => {
		const f = fixture();
		const event = f.message();
		f.authorities[1].onRequest = (socket, request) => {
			if (kind(request) === 42) {
				send(socket, 'EVENT', request[1], event);
				send(socket, 'EOSE', request[1]);
			}
		};
		const result = await f.start(150);
		expect(result.primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'eose', 'timeout']);
		expect(result.messages.map((message) => message.id)).toEqual([event.id]);
	});

	it('recognizes reconnect resends with fixed since and dedupes replayed event IDs', async () => {
		const f = fixture();
		const message = f.message();
		const position = f.position();
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => {
			send(socket, 'EVENT', request[1], kind(request) === 42 ? message : position);
			send(socket, 'EOSE', request[1]);
		};
		await f.start();
		relay.latestSocket().close({ code: 1001, reason: 'test reconnect', wasClean: false });
		await vi.advanceTimersByTimeAsync(5000);
		expect(relay.sockets).toHaveLength(2);
		expect(relay.primaryRequests()).toHaveLength(4);
		for (const request of relay.primaryRequests()) {
			if (kind(request) === 42) {
				expect(request).toHaveLength(4);
				expect(request[2].since).toBe(f.input.messageSince);
				expect(request[3].limit).toBe(50);
				expect(request[3].since).toBeUndefined();
			} else {
				expect(request[2].since).toBe(f.input.positionSince);
			}
		}
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(f.input.onLivePosition).not.toHaveBeenCalled();
		const live = f.message('after reconnect', TIME + 2);
		send(relay.latestSocket(), 'EVENT', relay.primaryId(42), live);
		await vi.advanceTimersByTimeAsync(5);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: live.id }), expect.objectContaining({ id: live.id })
		);
		send(relay.latestSocket(), 'CLOSED', relay.primaryId(42), 'restricted: after reconnect');
		expect(f.input.onPrimaryClosed).toHaveBeenCalledTimes(1);
	});

	it('reports live CLOSED after EOSE once and preserves the returned bootstrap snapshot', async () => {
		const f = fixture();
		const result = await f.start();
		const relay = f.authorities[0];
		send(relay.latestSocket(), 'CLOSED', relay.primaryId(42), 'blocked: live subscription ended');
		send(relay.latestSocket(), 'CLOSED', relay.primaryId(42), 'blocked: duplicate');
		await vi.advanceTimersByTimeAsync(10);
		expect(f.input.onPrimaryClosed).toHaveBeenCalledTimes(1);
		expect(f.input.onPrimaryClosed).toHaveBeenCalledWith(expect.objectContaining({ relayUrl: relay.url, subscription: 'world-messages', status: 'closed', notice: 'blocked: live subscription ended' }));
		expect(f.transport.getDiagnostics().primaryPairs[0].status).toBe('closed');
		expect(result.primaryPairs[0].status).toBe('eose');
		expect(relay.primaryRequests()).toHaveLength(2);
	});
});

describe('metadata discovery network boundary', () => {
	it('unions all seeds with kind40/kind41 on different relays and installs only the resolved defaults', async () => {
		const f = fixture();
		const defaultSnapshots: unknown[] = [];
		vi.mocked(createRxNostr).mockImplementationOnce((config) => {
			const client = actualRxNostr.createRxNostr(config);
			client.createOutgoingMessageObservable().subscribe((packet) => {
				if (packet.message[0] === 'REQ' && [40, 41].includes(packet.message[2].kinds![0])) defaultSnapshots.push(client.getDefaultRelays());
			});
			vi.spyOn(client, 'use');
			return client;
		});
		f.seeds[3].onRequest = (socket, request) => {
			if (kind(request) === 41) send(socket, 'EVENT', request[1], f.metadata);
			send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.metadata.source.eventId).toBe(f.metadata.id);
		expect(result.metadata.relays).toEqual(f.authorities.map((relay) => relay.url));
		expect(result.metadataDiscovery.uniqueEventCount).toBe(2);
		expect(result.metadataDiscovery.relays.map((relay) => relay.receivedKind40)).toEqual([true, false, false, false]);
		expect(defaultSnapshots).toEqual(Array.from({ length: 8 }, () => ({})));
		expect(vi.mocked(publicClient().use).mock.calls.slice(0, 2).map((call) => call[1])).toEqual([
			{ on: { relays: f.config.metadataDiscoveryRelays } }, { on: { relays: f.config.metadataDiscoveryRelays } }
		]);
		expect(Object.values(publicClient().getDefaultRelays()).map((relay) => new URL(relay.url).toString())).toEqual(f.authorities.map((relay) => relay.url));
		expect(f.seeds.every((relay) => relay.requests.length === 2)).toBe(true);
	});

	it('does not finish at the first valid kind40 before another seed returns kind41', async () => {
		const f = fixture();
		f.seeds[1].onRequest = (socket, request) => { if (kind(request) === 40) send(socket, 'EOSE', request[1]); };
		const pending = f.transport.start(f.input);
		await vi.advanceTimersByTimeAsync(30);
		expect(f.authorities.flatMap((relay) => relay.requests)).toEqual([]);
		const seed = f.seeds[1];
		const request = seed.requests.find((request) => kind(request) === 41)!;
		send(seed.latestSocket(), 'EVENT', request[1], f.metadata);
		send(seed.latestSocket(), 'EOSE', request[1]);
		await vi.advanceTimersByTimeAsync(15);
		expect((await pending).metadata.source.eventId).toBe(f.metadata.id);
	});

	it('resolves metadata despite one unavailable bootstrap seed', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => actualRxNostr.createRxNostr({ ...config, retry: { strategy: 'off' } }));
		const f = fixture();
		f.seeds[2].server.options!.verifyClient = () => false;
		const result = await f.start(150);
		expect(result.metadata.source.eventId).toBe(f.metadata.id);
		expect(result.metadataDiscovery.relays[2].status).toBe('unavailable');
	});

	it('fails without an exact kind40 from any seed', async () => {
		const f = fixture();
		f.seeds[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		const assertion = expect(f.transport.start(f.input)).rejects.toThrow('metadata resolution failed');
		await vi.advanceTimersByTimeAsync(150);
		await assertion;
		expect(f.authorities.flatMap((relay) => relay.requests)).toEqual([]);
		expect(f.transport.getDiagnostics().metadataDiscovery?.uniqueEventCount).toBe(1);
	});

	it('requires real EOSE for both discovery queries before reporting a seed as eose', async () => {
		const f = fixture();
		f.seeds[2].onRequest = (socket, request) => {
			if (kind(request) === 40) {
				send(socket, 'EOSE', request[1]);
				send(socket, 'EOSE', request[1]);
				send(socket, 'EOSE', 'unmapped discovery request');
			}
		};
		const result = await f.start(150);
		expect(result.metadata.source.eventId).toBe(f.metadata.id);
		expect(result.metadataDiscovery.relays.map((relay) => relay.status)).toEqual(['eose', 'eose', 'timeout', 'eose']);
	});
});

describe('NIP-11 capability and queue', () => {
	it.each([
		[1, 'insufficient'], [2, 'primary-only'], [3, 'trace-capable'], [undefined, 'unknown']
	] as const)('reports max_subscriptions=%s as %s without changing the two primary filters', async (limit, capacity) => {
		const f = fixture(1);
		const relay = f.authorities[0];
		Nip11Registry.set(relay.url, limit === undefined ? {} : { limitation: { max_subscriptions: limit } });
		const result = await f.start(150);
		expect(result.nip11).toEqual([{ relayUrl: relay.url, maxSubscriptions: limit ?? null, capacity }]);
		if (limit === 1) {
			expect(relay.primaryRequests()).toHaveLength(1);
			expect(result.primaryPairs.map((pair) => pair.status).sort()).toEqual(['eose', 'timeout']);
			const sentLogical = kind(relay.primaryRequests()[0]) === 42 ? 'world-messages' : 'world-positions';
			expect(result.primaryPairs.find((pair) => pair.subscription === sentLogical)?.status).toBe('eose');
		} else {
			expect(relay.primaryRequests()).toHaveLength(2);
			expect(result.primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		}
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
	});
});

describe('trace root bootstrap', () => {
	it('requires started transport and allows one startup operation only', async () => {
		const f = fixture(1);
		await expect(f.transport.bootstrapTraceRootCandidates()).rejects.toThrow('must start');
		await f.start();

		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		await expect(pending).resolves.toMatchObject({ rawEvents: [] });
		await expect(f.transport.bootstrapTraceRootCandidates()).rejects.toThrow('only allowed once');
	});

	it('sends the exact root filter only to authoritative relays and retains raw events', async () => {
		const f = fixture(2);
		await f.start();
		const expectedFilter = buildTraceRootBootstrapFilter({ channelId: f.channel.id });
		const invalidSignature = f.message('invalid-signature');
		invalidSignature.sig = '0'.repeat(128);
		const nip28Reply = {
			...f.message('nip28-reply'),
			tags: [['e', f.channel.id, '', 'reply'], ['L', expectedFilter['#L']![0]], ['l', 'chat'], ['w', '1:2']]
		};
		for (const relay of f.authorities) {
			relay.onRequest = (socket, request) => {
				if (request[2].limit === 1000) {
					send(socket, 'EVENT', request[1], invalidSignature);
					send(socket, 'EVENT', request[1], nip28Reply);
				}
				send(socket, 'EOSE', request[1]);
			};
		}

		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		expect(result.rawEvents.map((event) => event.id)).toEqual([nip28Reply.id, invalidSignature.id]);
		for (const relay of f.authorities) {
			expect(relay.rootRequests().map((request) => request.slice(2))).toEqual([[expectedFilter]]);
		}
		expect(f.seeds.flatMap((relay) => relay.rootRequests())).toEqual([]);
		expect(result.relays.map((diagnostic) => diagnostic.status)).toEqual(['eose', 'eose']);
	});

	it('dedupes and deterministically orders a bounded union without early termination', async () => {
		const f = fixture(2);
		await f.start();
		const rootFilter = buildTraceRootBootstrapFilter({ channelId: f.channel.id });
		const rootTags = [
			['e', rootFilter['#e']![0]],
			['L', rootFilter['#L']![0]],
			['l', rootFilter['#l']![0]]
		];
		const events = Array.from({ length: 1000 }, (_, index) => rawEvent(index.toString(16).padStart(64, '0'), TIME - index, { content: `authority-${index}`, tags: rootTags }));
		const sameRelayId = 'f'.repeat(64);
		const sameRelayFirst = rawEvent(sameRelayId, TIME + 1, { content: 'a', tags: rootTags });
		const sameRelaySecond = rawEvent(sameRelayId, TIME + 1, { content: 'z', tags: rootTags });
		const lateA = rawEvent('a'.repeat(64), TIME + 2, { content: 'late-a', tags: rootTags });
		const lateB = rawEvent('b'.repeat(64), TIME + 2, { content: 'late-b', tags: rootTags });
		let firstRootRequest: WireRequest | null = null;
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit !== 1000) return;
			firstRootRequest = request;
			for (const event of events) send(socket, 'EVENT', request[1], event);
		};
		f.authorities[1].onRequest = (socket, request) => {
			if (request[2].limit !== 1000) return;
			send(socket, 'EVENT', request[1], lateB);
			send(socket, 'EVENT', request[1], lateA);
			send(socket, 'EVENT', request[1], events[1]);
			send(socket, 'EVENT', request[1], sameRelayFirst);
			send(socket, 'EVENT', request[1], sameRelaySecond);
			send(socket, 'EOSE', request[1]);
		};

		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		expect(firstRootRequest).not.toBeNull();
		let settled = false;
		void pending.then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(false);
		send(f.authorities[0].latestSocket(), 'EOSE', firstRootRequest![1]);
		await vi.advanceTimersByTimeAsync(10);

		const result = await pending;
		expect(result.rawEvents).toHaveLength(1000);
		expect(result.rawEvents.slice(0, 2).map((event) => event.id)).toEqual([lateA.id, lateB.id]);
		expect(result.rawEvents.find((event) => event.id === events[1].id)?.content).toBe(events[1].content);
		expect(result.rawEvents.find((event) => event.id === sameRelayId)?.content).toBe('a');
		expect(result.rawEvents.some((event) => event.id === events.at(-1)!.id)).toBe(false);
	});

	it('reports mixed EOSE and CLOSED terminal diagnostics', async () => {
		const f = fixture(2);
		await f.start();
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit === 1000) send(socket, 'EOSE', request[1]);
		};
		f.authorities[1].onRequest = (socket, request) => {
			if (request[2].limit === 1000) send(socket, 'CLOSED', request[1], 'restricted: trace');
		};
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		expect((await pending).relays).toEqual([
			{ relayUrl: f.authorities[0].url, status: 'eose' },
			{ relayUrl: f.authorities[1].url, status: 'closed', notice: 'restricted: trace' }
		]);
	});

	it('reports success and timeout independently', async () => {
		const f = fixture(2);
		await f.start();
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit === 1000) send(socket, 'EOSE', request[1]);
		};
		f.authorities[1].onRequest = () => {};
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect((await pending).relays.map((diagnostic) => diagnostic.status)).toEqual(['eose', 'timeout']);
	});

	it('reports an unavailable authoritative relay', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => actualRxNostr.createRxNostr({ ...config, retry: { strategy: 'off' } }));
		const f = fixture(2);
		f.authorities[1].server.options!.verifyClient = () => false;
		await f.start(150);
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit === 1000) send(socket, 'EOSE', request[1]);
		};
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		expect((await pending).relays.map((diagnostic) => diagnostic.status)).toEqual(['eose', 'unavailable']);
	});

	it('runs as a third finite REQ when the relay capacity is three', async () => {
		const f = fixture(1);
		Nip11Registry.set(f.authorities[0].url, { limitation: { max_subscriptions: 3 } });
		await f.start();
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		expect(f.authorities[0].rootRequests()).toHaveLength(1);
		const rootSubId = f.authorities[0].rootRequests()[0][1];
		expect((await pending).relays[0].status).toBe('eose');
		expect(f.authorities[0].messages.filter((message) => message[0] === 'CLOSE' && message[1] === rootSubId)).toHaveLength(1);
		expect(f.authorities[0].primaryRequests()).toHaveLength(2);
	});

	it('times out only bootstrap at capacity two and keeps both primaries live', async () => {
		const f = fixture(1);
		Nip11Registry.set(f.authorities[0].url, { limitation: { max_subscriptions: 2 } });
		await f.start();
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect((await pending).relays[0].status).toBe('timeout');
		expect(f.authorities[0].rootRequests()).toEqual([]);
		expect(f.authorities[0].primaryRequests()).toHaveLength(2);
		const live = f.message('primary-after-trace');
		send(f.authorities[0].latestSocket(), 'EVENT', f.authorities[0].primaryId(42), live);
		await vi.advanceTimersByTimeAsync(10);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: live.id }), expect.objectContaining({ id: live.id })
		);
	});

	it('cleans up a pending finite bootstrap during dispose', async () => {
		const f = fixture(1);
		await f.start();
		f.authorities[0].onRequest = () => {};
		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		f.transport.dispose();
		await expect(pending).rejects.toThrow('disposed during finite query');
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(vi.getTimerCount()).toBe(0);
		expect(f.authorities[0].messages.filter((message) => message[0] === 'CLOSE')).not.toEqual([]);
	});
});

describe('trace reply transport', () => {
	it('rejects configuration until finite trace root bootstrap has completed', async () => {
		const f = fixture(1);
		const config = traceInput(f.channel.id);
		await expect(f.transport.configureTraceReplies(config)).rejects.toThrow('complete trace root bootstrap');
		await f.start();
		await expect(f.transport.configureTraceReplies(config)).rejects.toThrow('complete trace root bootstrap');
		await completeTraceRootBootstrap(f.transport);
		f.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(10);
		await expect(pending).resolves.toMatchObject({ status: 'active' });
	});

	it('uses one relay-scoped trace Forward request per authority and returns initial raw events only from configure', async () => {
		const f = fixture(2);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const use = vi.spyOn(publicClient(), 'use');
		const raw = finalizeEvent({
			kind: 1111,
			created_at: TIME,
			tags: [['E', f.channel.id], ['e', 'e'.repeat(64)], ['L', 'io.github.lokuyow.persona-bubble-field'], ['l', 'chat']],
			content: 'raw reply'
		}, AUTHOR);
		raw.sig = '0'.repeat(128);
		const observedRaw = vi.fn();
		publicClient().createAllEventObservable().subscribe(observedRaw);
		for (const relay of f.authorities) {
			relay.onRequest = (socket, request) => {
				if (kind(request) !== 1111) return;
				if (filters(request).some((filter) => filter.limit === 100)) {
					expect(filters(request)).toHaveLength(3);
					expect(filters(request).filter((filter) => filter.limit === 100)).toHaveLength(2);
					send(socket, 'EVENT', request[1], raw);
					send(socket, 'EOSE', request[1]);
				}
			};
		}
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		expect(observedRaw).toHaveBeenCalled();
		expect(result).toMatchObject({ status: 'active', initialBatch: { events: [expect.objectContaining({ id: raw.id })] } });
		expect(config.onBatch).not.toHaveBeenCalled();
		expect(config.onLiveEvent).not.toHaveBeenCalled();
		for (const relay of f.authorities) {
			expect(relay.traceRequests()).toHaveLength(2);
			expect(relay.sockets).toHaveLength(1);
		}
		expect(use.mock.calls.slice(-2).map(([, options]) => options)).toEqual(f.authorities.map((relay) => ({ on: { relays: [relay.url] } })));
	});

	it('transitions only EOSE-complete relays to no-limit continuation with the 300-second overlap', async () => {
		const f = fixture(2);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const [a, b] = f.authorities;
		a.onRequest = (socket, request) => {
			if (kind(request) !== 1111) return;
			if (filters(request).some((filter) => filter.limit === 100)) send(socket, 'EOSE', request[1]);
			else send(socket, 'EOSE', request[1]);
		};
		b.onRequest = () => {};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		await expect(pending).resolves.toMatchObject({
			status: 'active',
			initialBatch: { relays: [expect.objectContaining({ status: 'eose' }), expect.objectContaining({ status: 'timeout' })] }
		});
		await vi.advanceTimersByTimeAsync(1);
		const aContinuation = a.traceRequests().at(-1)!;
		expect(a.traceRequests()).toHaveLength(2);
		expect(filters(aContinuation).every((filter) => filter.limit === undefined)).toBe(true);
		expect(filters(aContinuation).every((filter) => filter.since === TIME - 300)).toBe(true);
		expect(b.traceRequests()).toHaveLength(1);
		expect(filters(b.traceRequests()[0]).filter((filter) => filter.limit === 100)).toHaveLength(2);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ relays: [expect.objectContaining({ status: 'eose' })] }));
	});

	it('times out a queued third request without closing primaries, then treats late wire delivery as catch-up', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		Nip11Registry.set(f.authorities[0].url, { limitation: { max_subscriptions: 2 } });
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		await expect(pending).resolves.toMatchObject({ status: 'active', initialBatch: { relays: [expect.objectContaining({ status: 'timeout' })] } });
		expect(f.authorities[0].traceRequests()).toEqual([]);
		expect(f.authorities[0].primaryRequests()).toHaveLength(2);
		const primaryIds = f.authorities[0].primaryRequests().map((request) => request[1]);
		const closedIds = f.authorities[0].messages.filter((message) => message[0] === 'CLOSE').map((message) => message[1]);
		expect(primaryIds.every((id) => !closedIds.includes(id))).toBe(true);
	});

	it('does not carry an EOSE cursor from a superseded initial generation', async () => {
		const f = fixture(2);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const [a, b] = f.authorities;
		a.onRequest = (socket, request) => {
			if (kind(request) === 1111) send(socket, 'EOSE', request[1]);
		};
		b.onRequest = () => {};
		const first = traceInput(f.channel.id);
		const old = f.transport.configureTraceReplies(first);
		await vi.advanceTimersByTimeAsync(10);
		const next = traceInput(f.channel.id, 'f'.repeat(64));
		const fresh = f.transport.configureTraceReplies(next);
		void fresh.catch(() => {});
		await vi.advanceTimersByTimeAsync(10);
		await expect(old).resolves.toEqual({ status: 'superseded', generation: 1 });
		expect(first.onBatch).not.toHaveBeenCalled();
		expect(first.onLiveEvent).not.toHaveBeenCalled();
		const newest = a.traceRequests().at(-1)!;
		expect(filters(newest).find((filter) => Array.isArray(filter['#e']) && filter['#e'][0] === 'f'.repeat(64))?.limit).toBe(100);
	});

	it('keeps an unacknowledged catch-up batch across an automatic reconnect and dedupes its replay', async () => {
		const f = fixture(1, socketConstructor, 6_000);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => {
			if (kind(request) !== 1111) return;
			if (filters(request).some((filter) => filter.limit === 100)) send(socket, 'EOSE', request[1]);
		};
		const config = traceInput(f.channel.id);
		const configured = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		const buffered = traceReply(f.channel.id, '1'.repeat(64));
		send(relay.latestSocket(), 'EVENT', relay.traceRequests().at(-1)![1], buffered);
		await vi.advanceTimersByTimeAsync(1);
		expect(config.onBatch).not.toHaveBeenCalled();
		relay.latestSocket().close({ code: 1001, reason: 'reconnect catch-up', wasClean: false });
		await vi.advanceTimersByTimeAsync(5_000);
		const replayed = relay.traceRequests().at(-1)!;
		expect(filters(replayed).every((filter) => filter.limit === undefined)).toBe(true);
		send(relay.latestSocket(), 'EVENT', replayed[1], buffered);
		send(relay.latestSocket(), 'EOSE', replayed[1]);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			events: [expect.objectContaining({ id: buffered.id })],
			relays: [expect.objectContaining({ status: 'eose' })]
		}));
	});

	it('evaluates continuation since lazily from the latest EOSE-stable cursor on each reconnect', async () => {
		const f = fixture(1, socketConstructor, 6_000);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		const continuationWireBoundaries: number[] = [];
		relay.onRequest = (socket, request) => {
			if (kind(request) !== 1111) return;
			if (filters(request).some((filter) => filter.limit === 100)) send(socket, 'EOSE', request[1]);
			else continuationWireBoundaries.push(Math.floor(Date.now() / 1000));
		};
		const config = traceInput(f.channel.id);
		const configured = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		relay.latestSocket().close({ code: 1001, reason: 'first reconnect', wasClean: false });
		await vi.advanceTimersByTimeAsync(5_000);
		const reconnectOne = relay.traceRequests().at(-1)!;
		const reconnectOneBoundary = continuationWireBoundaries.at(-1)!;
		const requestsBeforeEose = relay.traceRequests().length;
		send(relay.latestSocket(), 'EOSE', reconnectOne[1]);
		await vi.advanceTimersByTimeAsync(10);
		const requestsAfterEose = relay.traceRequests().length;
		expect(requestsAfterEose).toBe(requestsBeforeEose);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ relays: [expect.objectContaining({ status: 'eose' })] }));
		relay.latestSocket().close({ code: 1001, reason: 'second reconnect', wasClean: false });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(relay.traceRequests().length).toBeGreaterThan(requestsAfterEose);
		const reconnectTwo = relay.traceRequests().at(-1)!;
		const root = filters(reconnectTwo).find((filter) => !Array.isArray(filter['#p']) && !Array.isArray(filter['#e']) && Array.isArray(filter['#E']))!;
		const notification = filters(reconnectTwo).find((filter) => Array.isArray(filter['#p']))!;
		expect(root.since).toBe(reconnectOneBoundary - 300);
		expect(notification.since).toBe(reconnectOneBoundary - 300);
		expect(filters(reconnectTwo).every((filter) => filter.limit === undefined)).toBe(true);
	});

	it('reports live CLOSED after continuation EOSE and ignores duplicate and late packets', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(20);
		const result = await pending;
		const initialSnapshot = structuredClone(result);
		expect(relay.traceRequests()).toHaveLength(2);
		const continuation = relay.traceRequests().at(-1)!;
		expect(filters(continuation).every((filter) => filter.limit === undefined)).toBe(true);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith({ events: [], relays: [{ relayUrl: relay.url, status: 'eose' }] });
		const live = traceReply(f.channel.id, '6'.repeat(64));
		send(relay.latestSocket(), 'EVENT', continuation[1], live);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(live));
		config.onBatch.mockClear();
		const closed = { relayUrl: relay.url, status: 'closed', notice: 'restricted: live replies' };
		const observedDiagnostics = vi.fn();
		config.onBatch.mockImplementation(() => observedDiagnostics(f.transport.getDiagnostics().traceReplies));
		const requestCount = relay.requests.length;
		send(relay.latestSocket(), 'CLOSED', continuation[1], closed.notice);
		await vi.advanceTimersByTimeAsync(5);
		const expectedDiagnostics = { generation: 1, status: 'active', relays: [closed] };
		expect(f.transport.getDiagnostics().traceReplies).toEqual(expectedDiagnostics);
		expect(observedDiagnostics).toHaveBeenCalledExactlyOnceWith(expectedDiagnostics);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith({ events: [], relays: [closed] });
		expect(result).toEqual(initialSnapshot);
		await expect(f.transport.configureTraceReplies(config)).resolves.toEqual(initialSnapshot);

		send(relay.latestSocket(), 'CLOSED', continuation[1], 'restricted: duplicate');
		send(relay.latestSocket(), 'EOSE', continuation[1]);
		send(relay.latestSocket(), 'EVENT', continuation[1], traceReply(f.channel.id, '7'.repeat(64)));
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(f.transport.getDiagnostics().traceReplies).toEqual(expectedDiagnostics);
		expect(config.onBatch).toHaveBeenCalledTimes(1);
		expect(config.onLiveEvent).toHaveBeenCalledTimes(1);
		expect(relay.requests).toHaveLength(requestCount);
	});

	it('isolates live CLOSED to one relay without poisoning dedupe or closing primaries', async () => {
		const f = fixture(2);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(20);
		await pending;
		expect(config.onBatch).toHaveBeenCalledTimes(2);
		config.onBatch.mockClear();
		const primaryDiagnostics = f.transport.getDiagnostics().primaryPairs;
		const [a, b] = f.authorities;
		const aId = a.traceRequests().at(-1)![1];
		const bId = b.traceRequests().at(-1)![1];
		send(a.latestSocket(), 'CLOSED', aId, 'restricted: relay A');
		await vi.advanceTimersByTimeAsync(5);
		expect(f.transport.getDiagnostics().traceReplies).toMatchObject({ status: 'active', relays: [
			{ relayUrl: a.url, status: 'closed', notice: 'restricted: relay A' },
			{ relayUrl: b.url, status: 'eose' }
		] });
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith({ events: [], relays: [
			{ relayUrl: a.url, status: 'closed', notice: 'restricted: relay A' }
		] });
		const reply = traceReply(f.channel.id, '8'.repeat(64));
		send(a.latestSocket(), 'EVENT', aId, reply);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onLiveEvent).not.toHaveBeenCalled();
		send(b.latestSocket(), 'EVENT', bId, reply);
		send(b.latestSocket(), 'EVENT', bId, reply);
		const message = f.message('primary after trace closure');
		const position = f.position();
		send(a.latestSocket(), 'EVENT', a.primaryId(42), message);
		send(a.latestSocket(), 'EVENT', a.primaryId(30078), position);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(reply));
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: message.id }), expect.objectContaining(message)
		);
		expect(f.input.onLivePosition).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: position.id }));
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
		expect(f.transport.getDiagnostics().primaryPairs).toEqual(primaryDiagnostics);
	});

	it('preserves inactive reconfiguration from the live CLOSED callback', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(20);
		await pending;
		expect(config.onBatch).toHaveBeenCalledTimes(1);
		config.onBatch.mockClear();
		const inactive = { onBatch: vi.fn(), onLiveEvent: vi.fn() };
		config.onBatch.mockImplementation(() => { void f.transport.configureTraceReplies(inactive); });
		const relay = f.authorities[0];
		const subId = relay.traceRequests().at(-1)![1];
		send(relay.latestSocket(), 'CLOSED', subId, 'restricted: live');
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onBatch).toHaveBeenCalledTimes(1);
		const diagnostic = f.transport.getDiagnostics().traceReplies;
		expect(diagnostic).toMatchObject({ status: 'inactive', relays: [] });
		send(relay.latestSocket(), 'CLOSED', subId, 'restricted: duplicate');
		send(relay.latestSocket(), 'EOSE', subId);
		send(relay.latestSocket(), 'EVENT', subId, traceReply(f.channel.id, '9'.repeat(64)));
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(f.transport.getDiagnostics().traceReplies).toEqual(diagnostic);
		expect(config.onBatch).toHaveBeenCalledTimes(1);
		expect(config.onLiveEvent).not.toHaveBeenCalled();
		expect(inactive.onBatch).not.toHaveBeenCalled();
		expect(inactive.onLiveEvent).not.toHaveBeenCalled();
	});

	it('fails closed for late packets after initial and catch-up CLOSED terminals', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		let initial = true;
		relay.onRequest = (socket, request) => {
			if (kind(request) !== 1111) return;
			if (initial) {
				initial = false;
				send(socket, 'CLOSED', request[1], 'restricted: initial');
			}
		};
		const initialConfig = traceInput(f.channel.id);
		const initialPending = f.transport.configureTraceReplies(initialConfig);
		await vi.advanceTimersByTimeAsync(5);
		await initialPending;
		const initialSubId = relay.traceRequests()[0][1];
		send(relay.latestSocket(), 'EVENT', initialSubId, traceReply(f.channel.id, '8'.repeat(64)));
		send(relay.latestSocket(), 'EOSE', initialSubId);
		await vi.advanceTimersByTimeAsync(5);
		expect(initialConfig.onBatch).not.toHaveBeenCalled();
		expect(initialConfig.onLiveEvent).not.toHaveBeenCalled();

		const next = traceInput(f.channel.id, 'f'.repeat(64));
		relay.onRequest = (socket, request) => {
			if (kind(request) === 1111 && filters(request).some((filter) => filter.limit === 100)) send(socket, 'EOSE', request[1]);
		};
		const nextPending = f.transport.configureTraceReplies(next);
		await vi.advanceTimersByTimeAsync(5);
		await nextPending;
		const catchUp = relay.traceRequests().at(-1)!;
		send(relay.latestSocket(), 'CLOSED', catchUp[1], 'restricted: catch-up');
		await vi.advanceTimersByTimeAsync(5);
		expect(next.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ relays: [expect.objectContaining({ status: 'closed' })] }));
		send(relay.latestSocket(), 'EVENT', catchUp[1], traceReply(f.channel.id, '9'.repeat(64), TIME + 1, 'f'.repeat(64)));
		send(relay.latestSocket(), 'EOSE', catchUp[1]);
		await vi.advanceTimersByTimeAsync(5);
		expect(next.onBatch).toHaveBeenCalledTimes(1);
		expect(next.onLiveEvent).not.toHaveBeenCalled();
	});

	it('turns a wire-visible initial timeout into one bounded post-initial catch-up without duplicate initial delivery', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = () => {};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(5);
		const initial = traceReply(f.channel.id, '2'.repeat(64));
		send(relay.latestSocket(), 'EVENT', relay.traceRequests()[0][1], initial);
		await vi.advanceTimersByTimeAsync(TIMEOUT);
		const result = await pending;
		expect(result).toMatchObject({ initialBatch: { events: [expect.objectContaining({ id: initial.id })] } });
		expect(config.onBatch).not.toHaveBeenCalled();
		const catchUp = traceReply(f.channel.id, '3'.repeat(64));
		send(relay.latestSocket(), 'EVENT', relay.traceRequests()[0][1], catchUp);
		send(relay.latestSocket(), 'EOSE', relay.traceRequests()[0][1]);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
			events: [expect.objectContaining({ id: catchUp.id })],
			relays: [expect.objectContaining({ status: 'eose' })]
		}));
	});

	it('keeps the actual initial wire boundary when a timed-out initial REQ later reaches EOSE', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = () => {};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		const actualWireBoundary = Math.floor(Date.now() / 1000);
		await vi.advanceTimersByTimeAsync(TIMEOUT);
		await pending;
		vi.setSystemTime((actualWireBoundary + TIMEOUT + 301) * 1000);
		send(relay.latestSocket(), 'EOSE', relay.traceRequests()[0][1]);
		await vi.advanceTimersByTimeAsync(5);
		const continuation = relay.traceRequests().at(-1)!;
		const root = filters(continuation).find((filter) => !Array.isArray(filter['#e']) && !Array.isArray(filter['#p']) && Array.isArray(filter['#E']))!;
		expect(root.since).toBe(actualWireBoundary - 300);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ relays: [expect.objectContaining({ status: 'eose' })] }));
	});

	it('does not create an artificial catch-up after an initial CLOSED terminal', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => {
			if (kind(request) === 1111) send(socket, 'CLOSED', request[1], 'restricted: replies');
		};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(5);
		await expect(pending).resolves.toMatchObject({ initialBatch: { relays: [{ relayUrl: relay.url, status: 'closed', notice: 'restricted: replies' }] } });
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(config.onBatch).not.toHaveBeenCalled();
		expect(f.transport.getDiagnostics().traceReplies?.relays).toEqual([{ relayUrl: relay.url, status: 'closed', notice: 'restricted: replies' }]);
	});

	it('does not create an artificial catch-up after an initial unavailable terminal', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => actualRxNostr.createRxNostr({ ...config, retry: { strategy: 'off' } }));
		const f = fixture(2);
		f.authorities[1].server.options!.verifyClient = () => false;
		await f.start(150);
		await completeTraceRootBootstrap(f.transport);
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 1111) send(socket, 'CLOSED', request[1], 'restricted: replies');
		};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(5);
		await pending;
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(config.onBatch).not.toHaveBeenCalled();
		expect(f.transport.getDiagnostics().traceReplies?.relays).toEqual([
			{ relayUrl: f.authorities[0].url, status: 'closed', notice: 'restricted: replies' },
			{ relayUrl: f.authorities[1].url, status: 'unavailable' }
		]);
	});

	it('delivers a previously queued max-two third REQ as one late catch-up before that relay alone continues', async () => {
		const f = fixture(1, socketConstructor, 6_000);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		Nip11Registry.set(relay.url, { limitation: { max_subscriptions: 2 } });
		relay.onRequest = () => {};
		const config = traceInput(f.channel.id);
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(6_010);
		await pending;
		expect(relay.traceRequests()).toEqual([]);
		expect(relay.primaryRequests()).toHaveLength(2);
		Nip11Registry.set(relay.url, { limitation: { max_subscriptions: 3 } });
		// SubQueue re-evaluates dynamic NIP-11 capacity when work is queued. The
		// wake request stays queued behind the now-active product third REQ; the
		// transport itself never creates a fourth request.
		const wake = createRxForwardReq();
		const wakeSubscription = publicClient().use(wake, { on: { relays: [relay.url] } }).subscribe();
		wake.emit({ kinds: [9_999] });
		await vi.advanceTimersByTimeAsync(10);
		const late = relay.traceRequests().at(-1)!;
		expect(filters(late).filter((filter) => filter.limit === 100)).toHaveLength(2);
		wakeSubscription.unsubscribe();
		const event = traceReply(f.channel.id, '6'.repeat(64));
		send(relay.latestSocket(), 'EVENT', late[1], event);
		send(relay.latestSocket(), 'EOSE', late[1]);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onBatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ events: [expect.objectContaining({ id: event.id })] }));
	});

	it('uses only EOSE boundaries as cursors, never raw timestamps, live events, CLOSED, timeout, or unavailable', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => actualRxNostr.createRxNostr({ ...config, retry: { strategy: 'off' } }));
		const f = fixture(3);
		f.authorities[2].server.options!.verifyClient = () => false;
		await f.start(150);
		await completeTraceRootBootstrap(f.transport);
		const [a, b] = f.authorities;
		a.onRequest = (socket, request) => {
			if (kind(request) !== 1111) return;
			if (filters(request).some((filter) => filter.limit === 100)) {
				send(socket, 'EVENT', request[1], traceReply(f.channel.id, '7'.repeat(64), TIME + 9_999));
				send(socket, 'EOSE', request[1]);
			}
		};
		b.onRequest = (socket, request) => { if (kind(request) === 1111) send(socket, 'CLOSED', request[1], 'blocked'); };
		const first = traceInput(f.channel.id);
		const configured = f.transport.configureTraceReplies(first);
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		const next = traceInput(f.channel.id, 'f'.repeat(64));
		const reconfigured = f.transport.configureTraceReplies(next);
		await vi.advanceTimersByTimeAsync(5);
		await reconfigured;
		const aFresh = a.traceRequests().at(-1)!;
		expect(filters(aFresh).find((filter) => !Array.isArray(filter['#e']) && Array.isArray(filter['#E']))?.since).toBe(TIME - 300);
		expect(filters(b.traceRequests().at(-1)!).filter((filter) => filter.limit === 100)).toHaveLength(2);
		expect(f.transport.getDiagnostics().traceReplies?.relays.map((relay) => relay.status)).toContain('unavailable');
	});

	it('keeps notification cursor continuity only for its canonical persona and effective-root scope', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => { if (kind(request) === 1111) send(socket, 'EOSE', request[1]); };
		const first = traceInput(f.channel.id);
		const configured = f.transport.configureTraceReplies(first);
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		const requestsAfterFirst = relay.traceRequests().length;
		const reordered = {
			...traceInput(f.channel.id),
			notification: { personaPubkey: 'c'.repeat(64), effectiveRootIds: [f.channel.id, f.channel.id], initialSince: TIME - 600 }
		};
		await f.transport.configureTraceReplies(reordered);
		expect(relay.traceRequests()).toHaveLength(requestsAfterFirst);
		const added = {
			...traceInput(f.channel.id),
			notification: { personaPubkey: 'c'.repeat(64), effectiveRootIds: [f.channel.id, 'a'.repeat(64)], initialSince: TIME - 700 }
		};
		const addedPending = f.transport.configureTraceReplies(added);
		await vi.advanceTimersByTimeAsync(5);
		await addedPending;
		const addedFilter = filters(relay.traceRequests().at(-1)!).find((filter) => Array.isArray(filter['#p']))!;
		expect(addedFilter.since).toBe(TIME - 700);
		const changedPersona = {
			...added,
			notification: { ...added.notification, personaPubkey: 'b'.repeat(64) }
		};
		const personaPending = f.transport.configureTraceReplies(changedPersona);
		await vi.advanceTimersByTimeAsync(5);
		await personaPending;
		expect(filters(relay.traceRequests().at(-1)!).find((filter) => Array.isArray(filter['#p']))?.['#p']).toEqual(['b'.repeat(64)]);
	});

	it('preserves same-root cursor, makes a new direct scope initial, and refreshes after close and reopen', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => { if (kind(request) === 1111) send(socket, 'EOSE', request[1]); };
		const configured = f.transport.configureTraceReplies(traceInput(f.channel.id));
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		const next = traceInput(f.channel.id, 'f'.repeat(64));
		const changedPending = f.transport.configureTraceReplies(next);
		await vi.advanceTimersByTimeAsync(5);
		await changedPending;
		const changed = relay.traceRequests().map(filters);
		expect(changed.some((bundle) => bundle.find((filter) => Array.isArray(filter['#e']) && filter['#e'][0] === f.channel.id)?.limit === undefined)).toBe(true);
		expect(changed.some((bundle) => bundle.find((filter) => Array.isArray(filter['#e']) && filter['#e'][0] === 'f'.repeat(64))?.limit === 100)).toBe(true);
		await f.transport.configureTraceReplies({ onBatch: vi.fn(), onLiveEvent: vi.fn() });
		const reopened = f.transport.configureTraceReplies(traceInput(f.channel.id));
		await vi.advanceTimersByTimeAsync(5);
		await reopened;
		expect(filters(relay.traceRequests().at(-1)!).filter((filter) => filter.limit === 100)).toHaveLength(2);
	});

	it('cleans up reconfigured trace state and ignores old packets and all callbacks after dispose', async () => {
		const f = fixture(1);
		await f.start();
		await completeTraceRootBootstrap(f.transport);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => { if (kind(request) === 1111) send(socket, 'EOSE', request[1]); };
		const first = traceInput(f.channel.id);
		const configured = f.transport.configureTraceReplies(first);
		await vi.advanceTimersByTimeAsync(5);
		await configured;
		const oldRequest = relay.traceRequests().at(-1)!;
		const second = traceInput(f.channel.id, 'f'.repeat(64));
		const secondPending = f.transport.configureTraceReplies(second);
		await vi.advanceTimersByTimeAsync(5);
		await secondPending;
		expect(relay.messages.some((message) => message[0] === 'CLOSE' && message[1] === oldRequest[1])).toBe(true);
		send(relay.latestSocket(), 'EVENT', oldRequest[1], traceReply(f.channel.id, '4'.repeat(64)));
		send(relay.latestSocket(), 'EOSE', oldRequest[1]);
		await vi.advanceTimersByTimeAsync(1);
		expect(second.onBatch).not.toHaveBeenCalled();
		expect(second.onLiveEvent).not.toHaveBeenCalled();
		f.transport.dispose();
		send(relay.latestSocket(), 'EVENT', relay.traceRequests().at(-1)![1], traceReply(f.channel.id, '5'.repeat(64)));
		await vi.advanceTimersByTimeAsync(TIMEOUT + 10);
		expect(second.onBatch).not.toHaveBeenCalled();
		expect(second.onLiveEvent).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('semantic primary classifier', () => {
	it('rejects unknown real-valued properties exposed by a changed public outgoing API', async () => {
		vi.mocked(createRxNostr).mockImplementationOnce((config) => {
			const client = actualRxNostr.createRxNostr(config);
			const outgoing = client.createOutgoingMessageObservable();
			vi.spyOn(client, 'createOutgoingMessageObservable').mockReturnValue(outgoing.pipe(map((packet) => {
				if (packet.message[0] !== 'REQ' || packet.message[2].kinds?.[0] !== 42) return packet;
				return { ...packet, message: ['REQ', packet.message[1], { ...packet.message[2], futureCondition: true }] } as unknown as typeof packet;
			})));
			return client;
		});
		const f = fixture();
		const assertion = expect(f.transport.start(f.input)).rejects.toThrow('Unexpected outgoing REQ');
		await vi.advanceTimersByTimeAsync(150);
		await assertion;
	});

	it('accepts reordered primary conditions and observed until: undefined without matching concrete since values', async () => {
		const observed: unknown[][] = [];
		vi.mocked(createRxNostr).mockImplementationOnce((config) => {
			const client = actualRxNostr.createRxNostr(config);
			client.createOutgoingMessageObservable().subscribe((packet) => observed.push(packet.message));
			return client;
		});
		vi.mocked(createRxForwardReq).mockImplementation(() => {
			const request = actualRxNostr.createRxForwardReq();
			const emit = request.emit.bind(request);
			request.emit = (filter) => {
				const rewrite = (candidate: import('rx-nostr').LazyFilter) =>
					Object.fromEntries(Object.entries({ ...candidate, ...(candidate.limit === undefined ? { since: TIME - 5 } : {}) }).reverse()) as import('rx-nostr').LazyFilter;
				return emit(Array.isArray(filter) ? filter.map(rewrite) : rewrite(filter));
			};
			return request;
		});
		const f = fixture();
		const result = await f.start();
		expect(result.primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		const primary = observed.filter((message) => message[0] === 'REQ' && [42, 30078].includes(((message[2] as Record<string, number[]>).kinds)[0]));
		expect(primary).toHaveLength(4);
		for (const message of primary) {
			expect(message[2]).toHaveProperty('until', undefined);
			const kinds = (message[2] as Record<string, unknown>).kinds;
			if (Array.isArray(kinds) && kinds[0] === 42) {
				expect(message[2]).toHaveProperty('since', TIME - 5);
				expect(message[3]).toHaveProperty('limit', 50);
				expect(message[3]).toHaveProperty('since', undefined);
			} else {
				expect(message[2]).toHaveProperty('since', TIME - 5);
			}
		}
	});

	it.each([
		['unexpected #w condition', { '#w': ['1:2'] }],
		['numeric until', { until: TIME + 1 }],
		['limit', { limit: 1 }],
		['extra tag condition', { '#x': ['unexpected'] }],
		['search condition', { search: 'unexpected' }]
	])('fails closed for an actual outgoing %s REQ during initialization', async (_name, extra) => {
		const transmitted: unknown[][] = [];
		class RecordingSocket extends WebSocket {
			override send(data: string): void {
				transmitted.push(JSON.parse(data));
				super.send(data);
			}
		}
		vi.mocked(createRxForwardReq).mockImplementation(() => {
			const request = actualRxNostr.createRxForwardReq();
			const emit = request.emit.bind(request);
			request.emit = (filter) => {
				const addExtra = (candidate: import('rx-nostr').LazyFilter) => ({ ...candidate, ...extra });
				return emit(Array.isArray(filter) ? filter.map(addExtra) : addExtra(filter));
			};
			return request;
		});
		const f = fixture(2, RecordingSocket as unknown as IWebSocketConstructor);
		const assertion = expect(f.transport.start(f.input)).rejects.toThrow('Unexpected outgoing REQ');
		await vi.advanceTimersByTimeAsync(150);
		await assertion;
		expect(transmitted.some((message) => message[0] === 'REQ' && Object.keys(extra as object).every((key) => key in (message[2] as object)))).toBe(true);
	});

	it.each([
		['unexpected #w condition', { '#w': ['1:2'] }], ['numeric until', { until: TIME + 1 }],
		['limit', { limit: 1 }], ['unknown primary condition', { '#x': ['unexpected'] }]
	])('does not map a post-start finite %s REQ into primary lifecycle', async (_name, extra) => {
		const f = fixture();
		await f.start();
		for (const relay of f.authorities) relay.onRequest = (socket, request) => send(socket, 'CLOSED', request[1], 'restricted: finite only');
		const subscription = publicClient().use(createRxOneshotReq({ filters: { ...buildWorldMessageFilter({ channelId: f.channel.id, since: TIME - 50 }), ...extra } })).subscribe();
		await vi.advanceTimersByTimeAsync(10);
		subscription.unsubscribe();
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
	});
});

describe('publish', () => {
	it('preserves accepted/rejected/no-response outcomes and publishes only to authoritative relays', async () => {
		const f = fixture(3);
		await f.start();
		f.authorities[0].onPublish = (socket, event) => send(socket, 'OK', event.id, true, 'saved');
		f.authorities[1].onPublish = (socket, event) => send(socket, 'OK', event.id, false, 'blocked: denied');
		const event = f.message('publish');
		const pending = f.transport.publish(event);
		await vi.advanceTimersByTimeAsync(150);
		expect(await pending).toEqual([
			{ relayUrl: f.authorities[0].url, outcome: 'accepted', notice: 'saved' },
			{ relayUrl: f.authorities[1].url, outcome: 'rejected', notice: 'blocked: denied' },
			{ relayUrl: f.authorities[2].url, outcome: 'no-response' }
		]);
		expect(f.seeds.flatMap((relay) => relay.messages.filter((message) => message[0] === 'EVENT'))).toEqual([]);
		for (const relay of f.authorities) expect(relay.messages.filter((message) => message[0] === 'EVENT')).toEqual(JSON.parse(JSON.stringify([['EVENT', event]])));
	});
});

describe('transport ownership', () => {
	it('rejects a second start and methods before start or after disposal', async () => {
		const f = fixture();
		await expect(f.transport.publish(f.message())).rejects.toThrow('must start');
		await f.start();
		await expect(f.transport.start(f.input)).rejects.toThrow('only allowed once');
		f.transport.dispose();
		await expect(f.transport.start(f.input)).rejects.toThrow('only allowed once');
	});

	it('disposes finite requests, primary subscriptions and client without CLOSED callbacks', async () => {
		const f = fixture();
		await f.start();
		const dispose = vi.spyOn(publicClient(), 'dispose');
		const wire = vi.spyOn(WebSocket.prototype, 'send');
		f.transport.dispose();
		f.transport.dispose();
		await vi.advanceTimersByTimeAsync(20);
		expect(dispose).toHaveBeenCalledTimes(1);
		const closedIds = wire.mock.calls.map(([message]) => JSON.parse(message as string)).filter((message) => message[0] === 'CLOSE').map((message) => message[1]);
		for (const relay of f.authorities) {
			for (const request of relay.requests) expect(closedIds).toContain(request[1]);
			expect(relay.latestSocket().readyState).toBe(WebSocket.CLOSED);
		}
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(['metadata', 'primary'])('cancels start and clears its deadline when disposed during %s', async (phase) => {
		const f = fixture();
		for (const relay of phase === 'metadata' ? f.seeds : f.authorities) relay.onRequest = () => {};
		const assertion = expect(f.transport.start(f.input)).rejects.toThrow('disposed');
		await vi.advanceTimersByTimeAsync(30);
		f.transport.dispose();
		await vi.advanceTimersByTimeAsync(30);
		await assertion;
		expect(vi.getTimerCount()).toBe(0);
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
	});

	it('has no WebSocket side effect on module import or transport creation', async () => {
		vi.resetModules();
		const websocket = vi.fn();
		vi.stubGlobal('WebSocket', websocket);
		const { createNostrRelayTransport: create } = await import('./nostrRelayTransport');
		const { PROTOTYPE_WORLD_CONFIG } = await import('./prototypeWorld');
		const transport = create(PROTOTYPE_WORLD_CONFIG);
		expect(websocket).not.toHaveBeenCalled();
		transport.dispose();
	});
});
