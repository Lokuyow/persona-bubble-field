import { Server, WebSocket, type Client } from 'mock-socket';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { map } from 'rxjs';
import {
	Nip11Registry, createRxNostr, createRxForwardReq, createRxOneshotReq,
	type RxNostr, type IWebSocketConstructor
} from 'rx-nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNostrRelayTransport } from './nostrRelayTransport';
import {
	buildWorldMessageTemplate, buildPositionEventTemplate, buildWorldMessageFilter
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
type WireRequest = ['REQ', string, Record<string, unknown>];

function kind(request: WireRequest): number | undefined {
	return (request[2].kinds as number[])[0];
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
		primaryRequests: (): WireRequest[] => relay.requests.filter((request) => [42, 30078].includes(kind(request)!) && !request[2]['#w']),
		traceRequests: (): WireRequest[] => relay.requests.filter((request) => request[2]['#w']),
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

function fixture(authorityCount = 2, websocketCtor = socketConstructor) {
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
	const transport = createNostrRelayTransport(config, { operationTimeoutMs: TIMEOUT, websocketCtor });
	transports.push(transport);
	const input = { messageSince: TIME - 50, positionSince: TIME - 100, onLiveMessage: vi.fn(), onLivePosition: vi.fn(), onPrimaryClosed: vi.fn() };
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
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: liveMessage.id }));
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
			expect(request[2].since).toBe(kind(request) === 42 ? f.input.messageSince : f.input.positionSince);
		}
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(f.input.onLivePosition).not.toHaveBeenCalled();
		const live = f.message('after reconnect', TIME + 2);
		send(relay.latestSocket(), 'EVENT', relay.primaryId(42), live);
		await vi.advanceTimersByTimeAsync(5);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: live.id }));
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

describe('trace query', () => {
	it('shares overlapping identical trace semantics without cross-correlating their EOSE', async () => {
		const f = fixture(1);
		await f.start();
		const event = f.message();
		f.authorities[0].onRequest = (socket, request) => {
			// A repeated query without coalescing would overwrite the first mapping
			// before its response and then time out despite this successful result.
			if (f.authorities[0].traceRequests().length !== 1) return;
			send(socket, 'EVENT', request[1], event);
			send(socket, 'EOSE', request[1]);
		};
		const first = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }, { x: 2, y: 3 }] });
		const second = f.transport.queryTrace({ positions: [{ x: 2, y: 3 }, { x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(150);
		for (const result of await Promise.all([first, second])) {
			expect(result.messages.map((message) => message.id)).toEqual([event.id]);
			expect(result.relays[0].status).toBe('eose');
		}
		expect(f.authorities[0].traceRequests()).toHaveLength(1);
	});

	it('treats repeated trace positions as the same filter condition', async () => {
		const f = fixture(1);
		await f.start();
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }, { x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(150);
		expect((await pending).relays[0].status).toBe('eose');
	});

	it('validates and dedupes query-local messages, correlates only trace subIds, and releases only finite REQs', async () => {
		const f = fixture();
		await f.start();
		const valid = f.message('trace');
		const primaryOnly = f.message('primary-only');
		const invalid = finalizeEvent({ ...valid, tags: [...valid.tags, ['w', '1:2']], content: 'ambiguous position' }, AUTHOR);
		for (const relay of f.authorities) relay.onRequest = (socket, request) => {
			send(socket, 'EVENT', relay.primaryId(42), primaryOnly);
			send(socket, 'EVENT', request[1], valid);
			send(socket, 'EVENT', request[1], valid);
			send(socket, 'EVENT', request[1], invalid);
			send(socket, 'EVENT', request[1], { ...valid, sig: '0'.repeat(128) });
			send(socket, 'EOSE', request[1]);
		};
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }], since: TIME - 1, until: TIME + 1 });
		await vi.advanceTimersByTimeAsync(15);
		const result = await pending;
		expect(result.messages.map((event) => event.id)).toEqual([valid.id]);
		expect(result.relays.map((relay) => relay.status)).toEqual(['eose', 'eose']);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: primaryOnly.id }));
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
		for (const relay of f.authorities) {
			expect(relay.traceRequests()).toHaveLength(1);
			const closedIds = relay.messages.filter((message) => message[0] === 'CLOSE').map((message) => message[1]);
			expect(closedIds).toEqual([relay.traceRequests()[0][1]]);
			expect(relay.primaryRequests()).toHaveLength(2);
			expect(relay.sockets).toHaveLength(1);
		}
		expect(f.seeds.flatMap((relay) => relay.traceRequests())).toEqual([]);
	});

	it('keeps successful relay messages when another relay times out, ignoring unrelated EOSE', async () => {
		const f = fixture();
		await f.start();
		const event = f.message();
		f.authorities[0].onRequest = (socket, request) => {
			send(socket, 'EVENT', request[1], event);
			send(socket, 'EOSE', request[1]);
		};
		f.authorities[1].onRequest = (socket) => send(socket, 'EOSE', f.authorities[1].primaryId(42));
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(150);
		const result = await pending;
		expect(result.messages.map((message) => message.id)).toEqual([event.id]);
		expect(result.relays.map((relay) => relay.status)).toEqual(['eose', 'timeout']);
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
	});

	it('reports CLOSED and its notice without notifying the primary CLOSED callback', async () => {
		const f = fixture();
		await f.start();
		f.authorities[1].onRequest = (socket, request) => send(socket, 'CLOSED', request[1], 'restricted: trace disabled');
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(10);
		expect((await pending).relays).toEqual([
			{ relayUrl: f.authorities[0].url, status: 'eose' },
			{ relayUrl: f.authorities[1].url, status: 'closed', notice: 'restricted: trace disabled' }
		]);
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
	});

	it('reports an already rejected relay as unavailable', async () => {
		const f = fixture();
		await f.start();
		f.authorities[1].latestSocket().close({ code: 4000, reason: 'test unavailable', wasClean: true });
		await vi.advanceTimersByTimeAsync(5);
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(15);
		expect((await pending).relays.map((relay) => relay.status)).toEqual(['eose', 'unavailable']);
	});

	it('times out queued trace REQs without closing either primary subscription', async () => {
		const f = fixture();
		for (const relay of f.authorities) Nip11Registry.set(relay.url, { limitation: { max_subscriptions: 2 } });
		await f.start();
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(150);
		expect((await pending).relays.map((relay) => relay.status)).toEqual(['timeout', 'timeout']);
		expect(f.authorities.flatMap((relay) => relay.traceRequests())).toEqual([]);
		const live = f.message('after queued trace');
		send(f.authorities[0].latestSocket(), 'EVENT', f.authorities[0].primaryId(42), live);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: live.id }));
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
	});

	it('uses a total operation deadline even if events keep arriving without EOSE', async () => {
		const f = fixture(1);
		await f.start();
		f.authorities[0].onRequest = () => {};
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(10);
		const relay = f.authorities[0];
		const event = f.message();
		const interval = setInterval(() => send(relay.latestSocket(), 'EVENT', relay.traceRequests()[0][1], event), 10);
		await vi.advanceTimersByTimeAsync(95);
		clearInterval(interval);
		const result = await pending;
		expect(result.messages.map((message) => message.id)).toEqual([event.id]);
		expect(result.relays[0].status).toBe('timeout');
	});

	it('returns messages and per-relay real EOSE diagnostics without changing primary lifecycle', async () => {
		const f = fixture();
		await f.start();
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		await vi.advanceTimersByTimeAsync(10);
		expect(await pending).toEqual({ messages: [], relays: f.authorities.map((relay) => ({ relayUrl: relay.url, status: 'eose' })) });
		expect(f.transport.getDiagnostics().primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'eose', 'eose']);
		expect(f.input.onPrimaryClosed).not.toHaveBeenCalled();
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
			request.emit = (filter) => emit(Object.fromEntries(Object.entries({ ...filter, since: TIME - 5 }).reverse()) as import('rx-nostr').LazyFilter);
			return request;
		});
		const f = fixture();
		const result = await f.start();
		expect(result.primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		const primary = observed.filter((message) => message[0] === 'REQ' && [42, 30078].includes(((message[2] as Record<string, number[]>).kinds)[0]));
		expect(primary).toHaveLength(4);
		for (const message of primary) {
			expect(message[2]).toHaveProperty('until', undefined);
			expect(message[2]).toHaveProperty('since', TIME - 5);
		}
	});

	it.each([
		['trace #w', { '#w': ['1:2'] }],
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
			request.emit = (filter) => emit({ ...filter, ...extra });
			return request;
		});
		const f = fixture(2, RecordingSocket as unknown as IWebSocketConstructor);
		const assertion = expect(f.transport.start(f.input)).rejects.toThrow('Unexpected outgoing REQ');
		await vi.advanceTimersByTimeAsync(150);
		await assertion;
		expect(transmitted.some((message) => message[0] === 'REQ' && Object.keys(extra as object).every((key) => key in (message[2] as object)))).toBe(true);
	});

	it.each([
		['trace #w', { '#w': ['1:2'] }], ['numeric until', { until: TIME + 1 }],
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
		await expect(f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] })).rejects.toThrow('must start');
		await f.start();
		await expect(f.transport.start(f.input)).rejects.toThrow('only allowed once');
		f.transport.dispose();
		await expect(f.transport.start(f.input)).rejects.toThrow('only allowed once');
		await expect(f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] })).rejects.toThrow('must start');
	});

	it('disposes finite requests, primary subscriptions and client without CLOSED callbacks', async () => {
		const f = fixture();
		await f.start();
		for (const relay of f.authorities) relay.onRequest = () => {};
		const dispose = vi.spyOn(publicClient(), 'dispose');
		const pending = f.transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
		const assertion = expect(pending).rejects.toThrow('disposed');
		await vi.advanceTimersByTimeAsync(10);
		const wire = vi.spyOn(WebSocket.prototype, 'send');
		f.transport.dispose();
		f.transport.dispose();
		await vi.advanceTimersByTimeAsync(20);
		await assertion;
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
