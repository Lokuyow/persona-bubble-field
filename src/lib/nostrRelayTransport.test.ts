import { Server, WebSocket, type Client } from 'mock-socket';
import { finalizeEvent, getPublicKey, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { map, throwError } from 'rxjs';
import {
	Nip11Registry, createRxNostr, createRxForwardReq, createRxOneshotReq,
	type RxNostr, type IWebSocketConstructor
} from 'rx-nostr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNostrRelayTransport } from './nostrRelayTransport';
import {
	buildDeathTraceEventTemplate, buildTraceRootBootstrapFilter, buildWorldMessageTemplate, buildWorldStateEventTemplate, buildWorldMessageFilter, WORLD_STATE_KIND
} from './nostrProtocol';
import { buildRealtimeControlEventTemplate, buildRealtimeControlFilter, buildRealtimeEventFilter, buildRealtimeInstanceFilter, finalizeRealtimeEvent, type RealtimeEventRegistry } from './realtimeEvents';
import { COOPERATION_DEFECTION_EVENT_DEFINITION, buildCooperationDefectionActionTemplate } from './cooperationDefection';
import { TAG_GAME_ACTION_KIND, TAG_GAME_INDEX, TAG_GAME_KIND } from './tagGame';

// Capture only the public client. Tests still use the installed package,
// real RxReqs and mock WebSockets; no internal IDs or fields are inspected.
vi.mock('rx-nostr', async (importOriginal) => {
	const actual = await importOriginal<typeof import('rx-nostr')>();
	return { ...actual, createRxNostr: vi.fn(actual.createRxNostr), createRxForwardReq: vi.fn(actual.createRxForwardReq) };
});

const actualRxNostr = await vi.importActual<typeof import('rx-nostr')>('rx-nostr');
const CREATOR = new Uint8Array(32).fill(11);
const AUTHOR = new Uint8Array(32).fill(30);
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
		maxTagFilters: Infinity,
		requests: [] as WireRequest[],
		messages: [] as unknown[][],
		sockets: [] as Client[],
		onConnection: (_socket: Client) => {},
		onRequest: (socket: Client, request: WireRequest) => send(socket, 'EOSE', request[1]),
		onPublish: (_socket: Client, _event: VerifiedEvent) => {},
		primaryRequests: (): WireRequest[] => relay.requests.filter((request) => [42, WORLD_STATE_KIND].includes(kind(request)!) && request[2].limit === undefined),
		traceRequests: (): WireRequest[] => relay.requests.filter((request) => filters(request).every((filter) => (filter.kinds as number[])[0] === 1111)),
		rootRequests: (): WireRequest[] => relay.requests.filter((request) => kind(request) === 42 && request[2].limit === 1000 && request[3]?.limit === 1000),
		primaryId: (eventKind: 42 | typeof WORLD_STATE_KIND): string => relay.primaryRequests().filter((request) => kind(request) === eventKind).at(-1)![1],
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
				if (filters(request).some((filter) => Object.keys(filter).filter((key) => /^#[A-Za-z]$/.test(key)).length > relay.maxTagFilters)) {
					send(socket, 'CLOSED', request[1], 'ERROR: bad req: too many tags in filter');
					return;
				}
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
	const authorities = Array.from({ length: authorityCount }, () => mockRelay());
	const channel = { id: 'c'.repeat(64), pubkey: getPublicKey(CREATOR) };
	const config = {
		configRevision: 1,
		channelId: channel.id,
		creatorPubkey: channel.pubkey,
		authoritativeRelays: authorities.map((relay) => relay.url),
		preferredRelayHint: authorities[0].url
	};
	const transport = createNostrRelayTransport(config, { operationTimeoutMs, websocketCtor });
	transports.push(transport);
	const input = {
		messageSince: TIME - 50,
		worldStateSince: TIME - 100,
		onBootstrapMessage: vi.fn(),
		onBootstrapWorldState: vi.fn(),
		onBootstrapTrace: vi.fn(),
		onLiveMessage: vi.fn(),
		onLiveTrace: vi.fn(),
		onLiveWorldState: vi.fn(),
		onPrimaryClosed: vi.fn()
	};
	const reference = { channelId: channel.id, relayHint: authorities[0].url };
	const message = (content = 'hello', createdAt = TIME) => finalizeEvent(buildWorldMessageTemplate({ channel: reference, content, createdAt, speechType: 'normal', position: { x: 1, y: 2 } }), AUTHOR);
	const position = (createdAt = TIME) => finalizeEvent(buildWorldStateEventTemplate({ channel: reference, createdAt, slot: 0, position: { x: 1, y: 2 } }), AUTHOR);
	const start = async (elapsed = 30) => {
		const pending = transport.start(input);
		await vi.advanceTimersByTimeAsync(elapsed);
		return pending;
	};
	return { authorities, channel, config, transport, input, message, position, start };
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
	it('opens self publication at three paired EOSEs while the other primaries and publication remain live', async () => {
		const f = fixture(5, socketConstructor, 2_000);
		const published = f.position();
		for (const relay of f.authorities) relay.onRequest = () => {};
		const early = vi.fn();
		const pending = f.transport.start({ ...f.input, onEarlySelfReadReady: early });
		await vi.advanceTimersByTimeAsync(30);
		for (const relay of f.authorities.slice(0, 3)) {
			send(relay.latestSocket(), 'EOSE', relay.primaryId(42));
			send(relay.latestSocket(), 'EOSE', relay.primaryId(WORLD_STATE_KIND));
		}
		await vi.advanceTimersByTimeAsync(5);
		expect(early).toHaveBeenCalledOnce();
		expect(f.transport.getDiagnostics().primaryPairs.filter((pair) => pair.status === 'pending')).toHaveLength(4);
		for (const relay of f.authorities) relay.onPublish = (socket, event) => {
			if (relay === f.authorities[0]) send(socket, 'OK', event.id, true, '');
		};
		const handle = f.transport.publishSelf(published, published.pubkey);
		let allSettled = false;
		void handle.settled.then(() => { allSettled = true; });
		await vi.advanceTimersByTimeAsync(20);
		expect(await handle.firstSuccess).toBe(true);
		expect(allSettled).toBe(false);
		expect(f.authorities.every((relay) => relay.messages.some((message) => message[0] === 'EVENT' && (message[1] as Event).id === published.id))).toBe(true);
		for (const relay of f.authorities.slice(3)) {
			send(relay.latestSocket(), 'EOSE', relay.primaryId(42));
			send(relay.latestSocket(), 'EOSE', relay.primaryId(WORLD_STATE_KIND));
		}
		await vi.advanceTimersByTimeAsync(10);
		expect((await pending).primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		await vi.advanceTimersByTimeAsync(2_000);
		expect((await handle.settled)[0]).toMatchObject({ relayUrl: f.authorities[0].url, outcome: 'accepted' });
	});

	it('uses the bounded deadline only after both logical primaries have an EOSE', async () => {
		const f = fixture(5, socketConstructor, 2_000);
		for (const relay of f.authorities) relay.onRequest = () => {};
		const early = vi.fn();
		const pending = f.transport.start({ ...f.input, onEarlySelfReadReady: early });
		await vi.advanceTimersByTimeAsync(30);
		const [a, b] = f.authorities;
		send(a.latestSocket(), 'EOSE', a.primaryId(42));
		await vi.advanceTimersByTimeAsync(751);
		expect(early).not.toHaveBeenCalled();
		send(b.latestSocket(), 'EOSE', b.primaryId(WORLD_STATE_KIND));
		await vi.advanceTimersByTimeAsync(5);
		expect(early).toHaveBeenCalledOnce();
		for (const relay of f.authorities) {
			for (const request of relay.primaryRequests()) send(relay.latestSocket(), 'EOSE', request[1]);
		}
		await vi.advanceTimersByTimeAsync(5);
		await pending;
	});

	it('starts primary REQs directly on the configured authority without channel metadata requests', async () => {
		const f = fixture(2);
		const result = await f.start();
		expect(result.channel).toEqual({ channelId: f.channel.id, relayHint: f.authorities[0].url });
		for (const relay of f.authorities) {
			expect(relay.primaryRequests()).toHaveLength(2);
			expect(relay.requests.some((request) => [40, 41].includes(kind(request)!))).toBe(false);
		}
	});

	it('sends recent and timeline history filters in one world-messages REQ while keeping two logical primaries', async () => {
		const f = fixture(2);
		const result = await f.start();

		for (const relay of f.authorities) {
			const messageRequests = relay.primaryRequests().filter((request) => kind(request) === 42);
			expect(messageRequests).toHaveLength(1);
			expect(messageRequests[0]).toHaveLength(4);
			expect(messageRequests[0][2]).toMatchObject({ kinds: [42], '#l': ['chat', 'trace'], since: f.input.messageSince });
			expect(messageRequests[0][3]).toMatchObject({ kinds: [42], '#l': ['chat'], limit: 50 });
			expect(messageRequests[0][3].since).toBeUndefined();
		}
		expect(result.primaryPairs).toHaveLength(4);
		expect(result.primaryPairs.map((pair) => pair.subscription)).toEqual([
			'world-messages', 'world-state', 'world-messages', 'world-state'
		]);
	});

	it('keeps an EVENT immediately preceding the final EOSE in the initial position batch', async () => {
		const f = fixture(1);
		const event = f.position();
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === WORLD_STATE_KIND) send(socket, 'EVENT', request[1], event);
			send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.worldStates.map((position) => position.id)).toEqual([event.id]);
		expect(f.input.onLiveWorldState).not.toHaveBeenCalled();
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
		expect(result.worldStates.map((event) => event.id)).toEqual([storedPosition.id]);
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(f.input.onLiveWorldState).not.toHaveBeenCalled();
		const liveMessage = f.message('live', TIME + 1);
		const livePosition = f.position(TIME + 1);
		for (const relay of f.authorities) {
			send(relay.latestSocket(), 'EVENT', relay.primaryId(42), liveMessage);
			send(relay.latestSocket(), 'EVENT', relay.primaryId(WORLD_STATE_KIND), livePosition);
			send(relay.latestSocket(), 'EVENT', relay.primaryId(42), storedMessage);
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: liveMessage.id }), expect.objectContaining({ id: liveMessage.id })
		);
		expect(f.input.onLiveWorldState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: livePosition.id }));
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
		send(b.latestSocket(), 'EOSE', b.primaryId(WORLD_STATE_KIND));
		send(a.latestSocket(), 'EOSE', a.primaryId(42));
		send(a.latestSocket(), 'EOSE', a.primaryId(WORLD_STATE_KIND));
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
		const f = fixture();
		f.authorities[1].server.options!.verifyClient = () => false;
		const result = await f.start(90);
		expect(result.primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'unavailable', 'unavailable']);
		expect(f.authorities[1].requests).toEqual([]);
		expect(f.transport.getDiagnostics().connections[1].state).toBe('waiting-for-retrying');
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

	it('retains verified kind 42 and World State evidence when every primary pair closes', async () => {
		const f = fixture(2);
		const message = f.message('received-before-close');
		const position = f.position();
		for (const relay of f.authorities) {
			relay.onRequest = (socket, request) => {
				const primaryKind = kind(request);
				if (primaryKind === 42) send(socket, 'EVENT', request[1], message);
				if (primaryKind === WORLD_STATE_KIND) send(socket, 'EVENT', request[1], position);
				send(socket, 'CLOSED', request[1], 'primary read closed after event');
			};
		}
		const result = await f.start();
		expect(result.primaryPairs).toHaveLength(4);
		expect(result.primaryPairs.every((pair) => pair.status === 'closed')).toBe(true);
		expect(result.messages.map((event) => event.id)).toEqual([message.id]);
		expect(result.worldStates.map((event) => event.id)).toEqual([position.id]);
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
				expect(request[2].since).toBe(f.input.worldStateSince);
			}
		}
		expect(f.input.onLiveMessage).not.toHaveBeenCalled();
		expect(f.input.onLiveWorldState).not.toHaveBeenCalled();
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

describe('supplemental realtime event lifecycle', () => {
	const realtimeInput = (eventTypes: RealtimeEventRegistry = [COOPERATION_DEFECTION_EVENT_DEFINITION], instanceIds: readonly string[] = ['cooperation-defection-instance']) => ({
		eventTypes,
		controlSince: TIME - 100,
		instanceFilters: eventTypes.length === 0 || instanceIds.length === 0 ? [] : [{ protocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey, instanceIds, since: TIME - 100 }],
		onBootstrapEvent: vi.fn(),
		onLiveEvent: vi.fn(),
		onBootstrapControl: vi.fn(),
		onLiveControl: vi.fn()
	});
	const tagGameAction = (nonce = 'a'.repeat(32)) => finalizeEvent({ kind: TAG_GAME_ACTION_KIND, created_at: TIME,
		tags: [['e', 'c'.repeat(64)], ['d', 'host:run:game'], ['r', '1'], ['nonce', nonce]], content: '{"action":"join"}' }, AUTHOR) as import('nostr-tools/pure').VerifiedEvent;

	it('starts realtime when one Relay reaches EOSE and keeps the other Relay live', async () => {
		const f = fixture(2);
		f.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		f.authorities[1].onRequest = (socket, request) => { if (kind(request) !== 7070) send(socket, 'EOSE', request[1]); };
		await f.start();
		const onSupplementalEvent = vi.fn();
		const pending = f.transport.startRealtime({ ...realtimeInput([]), supplementalFilters: [{ kinds: [TAG_GAME_ACTION_KIND], '#e': [f.channel.id] }], onSupplementalEvent });
		await vi.advanceTimersByTimeAsync(30);
		const started = await pending;
		expect(started.status).toBe('active');
		expect(started.relays.find((relay) => relay.relayUrl === f.authorities[1].url)?.status).toBe('pending');
		const remainingRequest = f.authorities[1].requests.findLast((request) => filters(request).some((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_ACTION_KIND)))!;
		const action = tagGameAction();
		send(f.authorities[1].latestSocket(), 'EVENT', remainingRequest[1], action);
		expect(onSupplementalEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: action.id }), 'live');
		send(f.authorities[1].latestSocket(), 'EOSE', remainingRequest[1]);
		expect(f.transport.getDiagnostics().realtime.relays.find((relay) => relay.relayUrl === f.authorities[1].url)?.status).toBe('eose');
	});

	it('does not reuse a disconnected Relay EOSE before the reconnect REQ reaches EOSE', async () => {
		const f = fixture(1);
		const relay = f.authorities[0];
		relay.onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		await f.start();
		const initial = f.transport.startRealtime({ ...realtimeInput([]), supplementalFilters: [{ kinds: [TAG_GAME_ACTION_KIND], '#e': [f.channel.id] }] });
		await vi.advanceTimersByTimeAsync(30);
		await initial;
		const hasTagGameFilter = (request: WireRequest) => filters(request).some((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_ACTION_KIND));
		expect(relay.requests.filter(hasTagGameFilter)).toHaveLength(1);
		relay.onRequest = (socket, request) => { if (!hasTagGameFilter(request)) send(socket, 'EOSE', request[1]); };
		relay.latestSocket().close({ code: 1001, reason: 'realtime reconnect', wasClean: true });
		await vi.advanceTimersByTimeAsync(5_000);
		const currentRealtimeRequest = relay.requests.filter(hasTagGameFilter).at(-1)!;
		expect(relay.requests.filter(hasTagGameFilter)).toHaveLength(2);
		expect(f.transport.getDiagnostics().realtime.relays[0].status).toBe('pending');
		relay.onPublish = () => {};
		const beforeEose = f.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(5);
		let earlyResult: boolean | null = null;
		void beforeEose.firstSuccess.then((result) => { earlyResult = result; });
		send(relay.latestSocket(), 'OK', (relay.messages.findLast((message) => message[0] === 'EVENT' && (message[1] as Event).kind === TAG_GAME_ACTION_KIND)![1] as Event).id, true, '');
		await vi.advanceTimersByTimeAsync(5);
		expect(earlyResult).not.toBe(true);
		send(relay.latestSocket(), 'EOSE', currentRealtimeRequest[1]);
		expect(f.transport.getDiagnostics().realtime.relays[0].status).toBe('eose');
		expect(earlyResult).not.toBe(true);
		beforeEose.dispose();
		expect(await beforeEose.firstSuccess).toBe(false);
		await beforeEose.settled;
		const afterEose = f.transport.publishRealtimeTracked(tagGameAction('b'.repeat(32)));
		await vi.advanceTimersByTimeAsync(5);
		const published = relay.messages.findLast((message) => message[0] === 'EVENT' && (message[1] as Event).kind === TAG_GAME_ACTION_KIND)![1] as Event;
		send(relay.latestSocket(), 'OK', published.id, true, '');
		await vi.advanceTimersByTimeAsync(5);
		expect(await afterEose.firstSuccess).toBe(true);
		afterEose.dispose();
	});

	it('settles a game publish at an absolute deadline after early success while retaining late relay outcomes', async () => {
		const f = fixture(2);
		f.authorities.forEach((relay) => { relay.onRequest = (socket, request) => send(socket, 'EOSE', request[1]); });
		f.authorities[0].onPublish = (socket, event) => send(socket, 'OK', event.id, true, '');
		f.authorities[1].onPublish = () => {};
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const handle = f.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(20);
		expect(await handle.firstSuccess).toBe(true);
		let settled = false;
		void handle.settled.then(() => { settled = true; });
		expect(settled).toBe(false);
		expect(f.authorities.every((relay) => relay.messages.some((message) => message[0] === 'EVENT'))).toBe(true);
		await vi.advanceTimersByTimeAsync(10_000);
		const result = await handle.settled;
		expect(result).toMatchObject({ outcome: 'accepted', terminalReason: 'absolute-timeout' });
		expect(result.results).toEqual(expect.arrayContaining([
			{ relayUrl: f.authorities[0].url, outcome: 'accepted' },
			{ relayUrl: f.authorities[1].url, outcome: 'no-response' }
		]));
		const late = f.authorities[1].messages.find((message) => message[0] === 'EVENT')?.[1] as Event | undefined;
		if (late) send(f.authorities[1].latestSocket(), 'OK', late.id, true, 'late');
		await vi.advanceTimersByTimeAsync(1);
		expect((await handle.settled).results.find((entry) => entry.relayUrl === f.authorities[1].url)?.outcome).toBe('no-response');

		const noSuccess = fixture(1);
		noSuccess.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		noSuccess.authorities[0].onPublish = () => {};
		await noSuccess.start();
		const noSuccessRealtime = noSuccess.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await noSuccessRealtime;
		const expired = noSuccess.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await expired.firstSuccess).toBe(false);
		await expect(expired.settled).resolves.toMatchObject({ outcome: 'unconfirmed', terminalReason: 'absolute-timeout', results: [{ outcome: 'no-response' }] });
	});

	it('completes tracked publish success normally and settles both promises on dispose or send error', async () => {
		const normal = fixture(1);
		normal.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		normal.authorities[0].onPublish = (socket, event) => send(socket, 'OK', event.id, true, '');
		await normal.start();
		const realtime = normal.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const completed = normal.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(20);
		expect(await completed.firstSuccess).toBe(true);
		expect(await completed.settled).toMatchObject({ outcome: 'accepted', terminalReason: 'completed' });

		const disposed = fixture(1);
		disposed.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		disposed.authorities[0].onPublish = () => {};
		await disposed.start();
		const activeRealtime = disposed.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await activeRealtime;
		const cancelled = disposed.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(10);
		cancelled.dispose();
		expect(await cancelled.firstSuccess).toBe(false);
		expect(await cancelled.settled).toMatchObject({ outcome: 'unconfirmed', terminalReason: 'disposed' });

		const failed = fixture(1);
		failed.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		await failed.start();
		const failedRealtime = failed.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await failedRealtime;
		vi.spyOn(publicClient(), 'send').mockReturnValue(throwError(() => new Error('fake send failure')));
		const errored = failed.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(1);
		expect(await errored.firstSuccess).toBe(false);
		expect(await errored.settled).toMatchObject({ outcome: 'unconfirmed', terminalReason: 'send-error' });
	});

	it('keeps observing per-Relay OK after rx-nostr okTimeout until all Relay results settle', async () => {
		const f = fixture(2);
		let releaseSlowAck!: () => void;
		f.authorities.forEach((relay) => { relay.onRequest = (socket, request) => send(socket, 'EOSE', request[1]); });
		f.authorities[0].onPublish = (socket, event) => send(socket, 'OK', event.id, true, '');
		f.authorities[1].onPublish = (socket, event) => { releaseSlowAck = () => send(socket, 'OK', event.id, true, ''); };
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const handle = f.transport.publishRealtimeTracked(tagGameAction());
		await vi.advanceTimersByTimeAsync(200);
		expect(await handle.firstSuccess).toBe(true);
		let settled = false;
		void handle.settled.then(() => { settled = true; });
		expect(settled).toBe(false);
		releaseSlowAck();
		await vi.advanceTimersByTimeAsync(1);
		await expect(handle.settled).resolves.toMatchObject({ outcome: 'accepted', terminalReason: 'completed',
			results: [{ outcome: 'accepted' }, { outcome: 'accepted' }] });
	});

	it('multiplexes 27070 and 37070 through the existing supplemental REQ without entering the 7070 parser', async () => {
		const f = fixture(1);
		const discoveryFilter = { kinds: [TAG_GAME_KIND], '#e': [f.channel.id], '#t': [TAG_GAME_INDEX], since: TIME - 90 };
		const actionFilter = { kinds: [TAG_GAME_ACTION_KIND], '#e': [f.channel.id], since: TIME - 90 };
		const discovery = finalizeEvent({ kind: TAG_GAME_KIND, created_at: TIME, tags: [['d', 'host:run:game'], ['e', f.channel.id], ['t', TAG_GAME_INDEX]], content: '{}' }, AUTHOR);
		const action = finalizeEvent({ kind: TAG_GAME_ACTION_KIND, created_at: TIME, tags: [['d', 'host:run:game'], ['e', f.channel.id]], content: '{"action":"join"}' }, CREATOR);
		f.authorities[0].onRequest = (socket, request) => {
			if (filters(request).some((filter) => (filter.kinds as number[]).includes(TAG_GAME_KIND))) send(socket, 'EVENT', request[1], discovery);
			if (filters(request).some((filter) => (filter.kinds as number[]).includes(TAG_GAME_ACTION_KIND))) send(socket, 'EVENT', request[1], action);
			send(socket, 'EOSE', request[1]);
		};
		await f.start();
		const onSupplementalEvent = vi.fn();
		const pending = f.transport.startRealtime({ ...realtimeInput(), supplementalFilters: [discoveryFilter, actionFilter], onSupplementalEvent });
		await vi.advanceTimersByTimeAsync(30);
		const result = await pending;
		const realtimeRequest = f.authorities[0].requests.find((request) => filters(request).some((filter) => (filter.kinds as number[]).includes(TAG_GAME_KIND)))!;
		expect(filters(realtimeRequest)).toHaveLength(4);
		expect(filters(realtimeRequest)).toContainEqual(discoveryFilter);
		expect(filters(realtimeRequest)).toContainEqual(actionFilter);
		expect(result.events).toEqual([]);
		expect(onSupplementalEvent.mock.calls.map(([event]) => (event as Event).kind).sort()).toEqual([TAG_GAME_ACTION_KIND, TAG_GAME_KIND]);
		expect(onSupplementalEvent.mock.calls.every(([, delivery]) => delivery === 'bootstrap')).toBe(true);
		expect(f.transport.getDiagnostics().primaryPairs).toHaveLength(2);
	});

	it('classifies restored supplemental state during reconnect as bootstrap until the current REQ reaches EOSE', async () => {
		const f = fixture(1);
		const relay = f.authorities[0];
		const hasTagGameFilter = (request: WireRequest) => filters(request).some((filter) => (filter.kinds as number[] | undefined)?.includes(TAG_GAME_KIND));
		const restored = finalizeEvent({ kind: TAG_GAME_KIND, created_at: TIME - 1,
			tags: [['d', 'host:run:game'], ['e', f.channel.id], ['t', 'tag-game']], content: '{}' }, AUTHOR);
		let realtimeRequestCount = 0;
		relay.onRequest = (socket, request) => {
			if (hasTagGameFilter(request)) {
				realtimeRequestCount += 1;
				if (realtimeRequestCount > 1) send(socket, 'EVENT', request[1], restored);
				else send(socket, 'EOSE', request[1]);
				return;
			}
			send(socket, 'EOSE', request[1]);
		};
		await f.start();
		const onSupplementalEvent = vi.fn();
		const initial = f.transport.startRealtime({ ...realtimeInput([]), supplementalFilters: [{ kinds: [TAG_GAME_KIND], '#e': [f.channel.id] }], onSupplementalEvent });
		await vi.advanceTimersByTimeAsync(30);
		await initial;
		relay.latestSocket().close({ code: 1001, reason: 'realtime state restore', wasClean: true });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onSupplementalEvent).toHaveBeenCalledExactlyOnceWith(restored, 'bootstrap');
		const currentRequest = relay.requests.filter(hasTagGameFilter).at(-1)!;
		expect(f.transport.getDiagnostics().realtime.relays[0].status).toBe('pending');
		send(relay.latestSocket(), 'EOSE', currentRequest[1]);
		expect(f.transport.getDiagnostics().realtime.relays[0].status).toBe('eose');
		const live = finalizeEvent({ kind: TAG_GAME_KIND, created_at: TIME + 1,
			tags: [['d', 'host:run:game'], ['e', f.channel.id], ['t', 'tag-game']], content: '{"revision":1}' }, AUTHOR);
		send(relay.latestSocket(), 'EVENT', currentRequest[1], live);
		expect(onSupplementalEvent).toHaveBeenCalledTimes(2);
		expect(onSupplementalEvent).toHaveBeenLastCalledWith(live, 'live');
	});

	it('uses an independent kind-7070 subscription and preserves the two primary subscriptions', async () => {
		const f = fixture(1);
		const event = finalizeEvent(buildCooperationDefectionActionTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: 'cooperation-defection-instance',
			action: { action: 'join', groupId: 'cooperation-defection-instance:group:0' },
			createdAt: TIME
		}), AUTHOR);
		for (const relay of f.authorities) {
			relay.onRequest = (socket, request) => {
				if (kind(request) === 7070) send(socket, 'EVENT', request[1], event);
				send(socket, 'EOSE', request[1]);
			};
		}
		await f.start();
		const onBootstrapEvent = vi.fn();
		const onLiveEvent = vi.fn();
		const pending = f.transport.startRealtime({ ...realtimeInput(), onBootstrapEvent, onLiveEvent });
		await vi.advanceTimersByTimeAsync(30);
		const result = await pending;
		const realtimeRequests = f.authorities[0].requests.filter((request) => kind(request) === 7070);
		expect(realtimeRequests).toHaveLength(1);
		expect(realtimeRequests[0][2]).toEqual(buildRealtimeControlFilter({ channelId: f.channel.id, creatorPubkey: f.channel.pubkey, since: TIME - 100 }));
		expect(realtimeRequests[0][3]).toEqual(buildRealtimeInstanceFilter({
			channelId: f.channel.id,
			configuration: { protocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey, instanceIds: ['cooperation-defection-instance'], since: TIME - 100 }
		}));
		expect(result.status).toBe('active');
		expect(result.events.map((candidate) => candidate.id)).toEqual([event.id]);
		expect(onBootstrapEvent).toHaveBeenCalledWith(event);
		expect(onLiveEvent).not.toHaveBeenCalled();
		expect(f.transport.getDiagnostics().primaryPairs).toHaveLength(2);
		expect(f.transport.getDiagnostics().realtime.status).toBe('active');
		const live = finalizeEvent(buildCooperationDefectionActionTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: 'cooperation-defection-instance',
			action: { action: 'join', groupId: 'cooperation-defection-instance:group:0' },
			createdAt: TIME + 1
		}), AUTHOR);
		send(f.authorities[0].latestSocket(), 'EVENT', realtimeRequests[0][1], live);
		send(f.authorities[0].latestSocket(), 'EVENT', realtimeRequests[0][1], live);
		await vi.advanceTimersByTimeAsync(10);
		expect(onLiveEvent).toHaveBeenCalledExactlyOnceWith(live);
	});

	it('combines creator control and protocol-specific instance filters in one request', async () => {
		const f = fixture(1);
		const createdAt = TIME;
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: `cooperation-defection:1:manual:${createdAt}:0123456789abcdef0123456789abcdef`,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey },
			createdAt
		}), CREATOR);
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 7070) send(socket, 'EVENT', request[1], control);
			send(socket, 'EOSE', request[1]);
		};
		await f.start();
		const onControl = vi.fn();
		const pending = f.transport.startRealtime({ ...realtimeInput([COOPERATION_DEFECTION_EVENT_DEFINITION], []), onBootstrapControl: onControl });
		await vi.advanceTimersByTimeAsync(30);
		await pending;
		const request = f.authorities[0].requests.filter((candidate) => kind(candidate) === 7070)[0];
		expect(filters(request)).toHaveLength(1);
		expect(request[2]).toEqual(buildRealtimeControlFilter({ channelId: f.channel.id, creatorPubkey: f.channel.pubkey, since: TIME - 100 }));
		expect(onControl).toHaveBeenCalledOnce();
	});

	it('replaces only realtime with CLOSE before a new protocol-specific request', async () => {
		const f = fixture(1);
		await f.start();
		const first = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await first;
		const firstRequest = f.authorities[0].requests.filter((request) => kind(request) === 7070)[0];
		f.transport.stopRealtime();
		const second = f.transport.startRealtime(realtimeInput([COOPERATION_DEFECTION_EVENT_DEFINITION], ['next-instance']));
		await vi.advanceTimersByTimeAsync(30);
		await second;
		const realtimeMessages = f.authorities[0].messages.filter((message) => message[0] === 'CLOSE' || (message[0] === 'REQ' && kind(message as WireRequest) === 7070));
		expect(f.authorities[0].messages).toContainEqual(['CLOSE', firstRequest[1]]);
		expect(f.authorities[0].requests.filter((request) => kind(request) === 7070)).toHaveLength(2);
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		expect(realtimeMessages.length).toBeGreaterThan(0);
	});

	it('accepts realtime publication from a readable relay', async () => {
		const f = fixture(1);
		const event = finalizeEvent(buildCooperationDefectionActionTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: 'cooperation-defection-instance',
			action: { action: 'join', groupId: 'cooperation-defection-instance:group:0' },
			createdAt: TIME
		}), AUTHOR);
		let realtimeRequest: WireRequest | undefined;
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 7070) realtimeRequest = request;
			send(socket, 'EOSE', request[1]);
		};
		f.authorities[0].onPublish = (socket, published) => send(socket, 'OK', published.id, true, '');
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const pending = f.transport.publishRealtime(event);
		await vi.advanceTimersByTimeAsync(30);
		const result = await pending;
		expect(result.outcome).toBe('accepted');
		expect(result.results).toEqual([{ relayUrl: f.authorities[0].url, outcome: 'accepted' }]);
		expect(realtimeRequest).toBeDefined();
	});

	it('uses a self echo when OK is absent and does not retry the action', async () => {
		const f = fixture(1);
		const event = finalizeEvent(buildCooperationDefectionActionTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: 'cooperation-defection-instance',
			action: { action: 'join', groupId: 'cooperation-defection-instance:group:0' },
			createdAt: TIME
		}), AUTHOR);
		let realtimeRequest: WireRequest | undefined;
		let publishCount = 0;
		f.authorities[0].onRequest = (socket, request) => {
			if (kind(request) === 7070) realtimeRequest = request;
			send(socket, 'EOSE', request[1]);
		};
		f.authorities[0].onPublish = (socket, published) => {
			publishCount += 1;
			if (realtimeRequest) send(socket, 'EVENT', realtimeRequest[1], published);
		};
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const pending = f.transport.publishRealtime(event);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
		await expect(pending).resolves.toMatchObject({ outcome: 'echoed', results: [{ outcome: 'no-response' }] });
		expect(publishCount).toBe(1);
	});

	it('does not treat an excluded relay acceptance as shared when readable relay rejects', async () => {
		const f = fixture(2);
		Nip11Registry.set(f.authorities[1].url, { limitation: { max_subscriptions: 2 } });
		const event = finalizeEvent(buildCooperationDefectionActionTemplate({
			channelId: f.channel.id,
			relayHint: f.authorities[0].url,
			instanceId: 'cooperation-defection-instance',
			action: { action: 'join', groupId: 'cooperation-defection-instance:group:0' },
			createdAt: TIME
		}), AUTHOR);
		f.authorities[0].onRequest = (socket, request) => send(socket, 'EOSE', request[1]);
		f.authorities[0].onPublish = (socket, published) => send(socket, 'OK', published.id, false, 'blocked');
		f.authorities[1].onPublish = (socket, published) => send(socket, 'OK', published.id, true, '');
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const pending = f.transport.publishRealtime(event);
		await vi.advanceTimersByTimeAsync(TIMEOUT + 1);
		await expect(pending).resolves.toMatchObject({ outcome: 'unconfirmed' });
		expect((await pending).results).toEqual(expect.arrayContaining([
			{ relayUrl: f.authorities[0].url, outcome: 'rejected', notice: 'blocked' },
			{ relayUrl: f.authorities[1].url, outcome: 'accepted' }
		]));
	});

	it('stops only the supplemental realtime subscription', async () => {
		const f = fixture(1);
		await f.start();
		const realtime = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await realtime;
		const realtimeRequest = f.authorities[0].requests.filter((request) => kind(request) === 7070).at(-1);
		expect(realtimeRequest).toBeDefined();
		f.transport.stopRealtime();
		await vi.advanceTimersByTimeAsync(10);
		expect(f.authorities[0].messages).toContainEqual(['CLOSE', realtimeRequest![1]]);
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
	});

	it('does not open an event request when the enabled definition list is empty', async () => {
		const f = fixture(1);
		await f.start();
		const result = await f.transport.startRealtime(realtimeInput([]));
		expect(result.status).toBe('inactive');
		expect(f.authorities[0].requests.filter((request) => kind(request) === 7070)).toEqual([]);
	});

	it('skips realtime on a relay capped below primary-two-plus-one without degrading primary status', async () => {
		const f = fixture(1);
		Nip11Registry.set(f.authorities[0].url, { limitation: { max_subscriptions: 2 } });
		await f.start();
		const result = await f.transport.startRealtime(realtimeInput());
		expect(result.status).toBe('inactive');
		expect(f.authorities[0].requests.filter((request) => kind(request) === 7070)).toEqual([]);
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
		expect(f.transport.getDiagnostics().realtime.relays).toEqual([
			{ relayUrl: f.authorities[0].url, status: 'unavailable', notice: expect.any(String) }
		]);
	});

	it('skips realtime when the known cap is already occupied by primary and Trace capacity', async () => {
		const f = fixture(1);
		Nip11Registry.set(f.authorities[0].url, { limitation: { max_subscriptions: 3 } });
		await f.start();
		const result = await f.transport.startRealtime(realtimeInput());
		expect(result.status).toBe('inactive');
		expect(f.authorities[0].requests.filter((request) => kind(request) === 7070)).toEqual([]);
		expect(f.transport.getDiagnostics().primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
	});

	it('allows a realtime attempt when NIP-11 does not publish max_subscriptions', async () => {
		const f = fixture(1);
		Nip11Registry.set(f.authorities[0].url, {});
		await f.start();
		const pending = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(30);
		await expect(pending).resolves.toMatchObject({ status: 'active' });
		expect(f.authorities[0].requests.filter((request) => kind(request) === 7070)).toHaveLength(1);
	});

	it.each([
		['CLOSED', 'closed'] as const,
		['timeout', 'timeout'] as const
	])('keeps primary world reads usable after realtime %s', async (mode, expectedStatus) => {
		const f = fixture(1);
		if (mode === 'CLOSED') {
			f.authorities[0].onRequest = (socket, request) => {
				if (kind(request) === 7070) send(socket, 'CLOSED', request[1], 'realtime disabled');
				else send(socket, 'EOSE', request[1]);
			};
		} else {
			f.authorities[0].onRequest = (socket, request) => {
				if (kind(request) !== 7070) send(socket, 'EOSE', request[1]);
			};
		}
		const primary = await f.start();
		const pending = f.transport.startRealtime(realtimeInput());
		await vi.advanceTimersByTimeAsync(mode === 'CLOSED' ? 30 : TIMEOUT + 1);
		await expect(pending).resolves.toMatchObject({ status: 'inactive' });
		expect(f.transport.getDiagnostics().realtime.relays[0].status).toBe(expectedStatus);
		expect(primary.primaryPairs.every((pair) => pair.status === 'eose')).toBe(true);
	});
});

describe('fixed World authority boundary', () => {
	it('never requests channel metadata and reads directly from every configured authority', async () => {
		const f = fixture(3);
		const result = await f.start();
		expect(result.channel).toEqual({ channelId: f.channel.id, relayHint: f.authorities[0].url });
		expect(result.primaryPairs).toHaveLength(6);
		for (const relay of f.authorities) {
			expect(relay.primaryRequests().map(kind).sort((left, right) => left! - right!)).toEqual([42, WORLD_STATE_KIND]);
			expect(relay.requests.some((request) => [40, 41].includes(kind(request)!))).toBe(false);
		}
	});

	it('rejects malformed fixed config before opening a Relay connection', () => {
		const f = fixture(1);
		expect(() => createNostrRelayTransport({ ...f.config, preferredRelayHint: 'wss://unconfigured.example/' }, { websocketCtor: socketConstructor })).toThrow('Invalid prototype World config');
		expect(f.authorities[0].sockets).toEqual([]);
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
			const sentLogical = kind(relay.primaryRequests()[0]) === 42 ? 'world-messages' : 'world-state';
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
		const normal = f.message('normal-root');
		const death = finalizeEvent(buildDeathTraceEventTemplate({
			channel: { channelId: f.channel.id, relayHint: f.authorities[0].url },
			content: 'death-root', position: { x: 1, y: 2 }, createdAt: TIME - 1
		}), AUTHOR);
		for (const relay of f.authorities) {
			relay.onRequest = (socket, request) => {
				if (request[2].limit === 1000) {
					send(socket, 'EVENT', request[1], normal);
					send(socket, 'EVENT', request[1], death);
				}
				send(socket, 'EOSE', request[1]);
			};
		}

		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		const result = await pending;
		expect(result.rawEvents.map((event) => event.id)).toEqual([normal.id, death.id]);
		for (const relay of f.authorities) {
			expect(relay.rootRequests().map((request) => request.slice(2))).toEqual([[
				expect.objectContaining(expectedFilter),
				expect.objectContaining({ kinds: [42], '#l': ['trace'], limit: 1000 })
			]]);
		}
		expect(f.authorities.every((relay) => relay.rootRequests().length >= 0)).toBe(true);
		expect(result.relays.map((diagnostic) => diagnostic.status)).toEqual(['eose', 'eose']);
	});

	it('keeps death trace history in a separate bounded filter from kind 42 roots', async () => {
		const f = fixture(1);
		await f.start();
		f.authorities[0].onRequest = (socket, request) => {
			send(socket, 'EOSE', request[1]);
		};

		const pending = f.transport.bootstrapTraceRootCandidates();
		await vi.advanceTimersByTimeAsync(10);
		await pending;
		const rootRequest = f.authorities[0].rootRequests()[0];
		expect(rootRequest.slice(2)).toEqual([
			expect.objectContaining({ kinds: [42], '#l': ['chat'], limit: 1000 }),
			expect.objectContaining({ kinds: [42], '#l': ['trace'], limit: 1000 })
		]);
	});

	it('classifies kind 42 chat and death trace events exclusively at the primary boundary', async () => {
		const f = fixture(1);
		const death = finalizeEvent(buildDeathTraceEventTemplate({
			channel: { channelId: f.channel.id, relayHint: f.authorities[0].url },
			content: 'death trace', position: { x: 2, y: 2 }, createdAt: TIME
		}), AUTHOR);
		const normal = f.message('normal chat');
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit === undefined && (request[2].kinds as number[]).includes(42)) {
				send(socket, 'EVENT', request[1], normal);
				send(socket, 'EVENT', request[1], death);
			}
			send(socket, 'EOSE', request[1]);
		};
		const result = await f.start();
		expect(result.messages.map((event) => event.id)).toEqual([normal.id]);
		expect(result.traces.map((event) => event.id)).toEqual([death.id]);
		expect(f.input.onBootstrapMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: normal.id }));
		expect(f.input.onBootstrapMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: death.id }));
		expect(f.input.onBootstrapTrace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: death.id }));

		const liveDeath = finalizeEvent(buildDeathTraceEventTemplate({
			channel: { channelId: f.channel.id, relayHint: f.authorities[0].url },
			content: 'live death trace', position: { x: 3, y: 2 }, createdAt: TIME + 1
		}), AUTHOR);
		send(f.authorities[0].latestSocket(), 'EVENT', f.authorities[0].primaryId(42), liveDeath);
		await vi.advanceTimersByTimeAsync(10);
		expect(f.input.onLiveTrace).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: liveDeath.id }), liveDeath);
		expect(f.input.onLiveMessage).not.toHaveBeenCalledWith(expect.objectContaining({ id: liveDeath.id }), expect.anything());
	});

	it('dedupes and deterministically orders a bounded union without early termination', async () => {
		const f = fixture(2);
		await f.start();
		const events = Array.from({ length: 1001 }, (_, index) => f.message(`authority-${index}`, TIME - index));
		const sameRelayFirst = events[0];
		const sameRelaySecond = events[0];
		const deathA = finalizeEvent(buildDeathTraceEventTemplate({ channel: { channelId: f.channel.id, relayHint: f.authorities[0].url }, createdAt: TIME - 3, position: { x: 2, y: 2 }, content: 'death-a' }), AUTHOR);
		const deathB = finalizeEvent(buildDeathTraceEventTemplate({ channel: { channelId: f.channel.id, relayHint: f.authorities[0].url }, createdAt: TIME - 4, position: { x: 3, y: 2 }, content: 'death-b' }), AUTHOR);
		let firstRootRequest: WireRequest | null = null;
		f.authorities[0].onRequest = (socket, request) => {
			if (request[2].limit !== 1000) return;
			firstRootRequest = request;
			for (const event of events) send(socket, 'EVENT', request[1], event);
		};
		f.authorities[1].onRequest = (socket, request) => {
			if (request[2].limit !== 1000) return;
			send(socket, 'EVENT', request[1], events[1]);
			send(socket, 'EVENT', request[1], sameRelayFirst);
			send(socket, 'EVENT', request[1], sameRelaySecond);
			send(socket, 'EVENT', request[1], deathA);
			send(socket, 'EVENT', request[1], deathB);
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
		expect(result.rawEvents).toHaveLength(1002);
		expect(result.rawEvents.filter((event) => event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'chat'))).toHaveLength(1000);
		expect(result.rawEvents.filter((event) => event.tags.some((tag) => tag[0] === 'l' && tag[1] === 'trace'))).toHaveLength(2);
		const expectedOrder = [...events.slice(0, 1000), deathA, deathB]
			.sort((first, second) => second.created_at - first.created_at || (first.id < second.id ? -1 : first.id > second.id ? 1 : 0))
			.map((event) => event.id);
		expect(result.rawEvents.map((event) => event.id)).toEqual(expectedOrder);
		expect(result.rawEvents.find((event) => event.id === events[1].id)?.content).toBe(events[1].content);
		expect(result.rawEvents.filter((event) => event.id === sameRelayFirst.id)).toHaveLength(1);
		expect(result.rawEvents.some((event) => event.id === events.at(-1)!.id)).toBe(false);
	}, 15_000);

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
	it('retrieves history beyond the root limit and live replies in a three-tag bundle', async () => {
		const f = fixture(2, socketConstructor, 6_000);
		await f.start(); await completeTraceRootBootstrap(f.transport);
		const currentId = 'e'.repeat(64);
		const older = traceReply(f.channel.id, 'older-direct', TIME - 200, currentId);
		const recent = Array.from({ length: 100 }, (_, index) => traceReply(f.channel.id, `other-${index}`, TIME - index, 'f'.repeat(64)));
		for (const relay of f.authorities) {
			relay.maxTagFilters = 3;
			relay.onRequest = (socket, request) => {
				for (const filter of filters(request)) {
					for (const event of [...recent, older].filter((event) => matchFilter(filter as Filter, event)).slice(0, filter.limit as number | undefined)) {
						send(socket, 'EVENT', request[1], event);
					}
				}
				send(socket, 'EOSE', request[1]);
			};
		}
		const config = { conversation: { rootId: f.channel.id, currentId }, onBatch: vi.fn(), onLiveEvent: vi.fn() };
		const pending = f.transport.configureTraceReplies(config);
		await vi.advanceTimersByTimeAsync(20);
		expect(await pending).toMatchObject({ initialBatch: { events: expect.arrayContaining([expect.objectContaining({ id: older.id })]),
			relays: f.authorities.map((relay) => ({ relayUrl: relay.url, status: 'eose' })) } });
		const live = traceReply(f.channel.id, 'new-live', TIME + 1, currentId);
		for (const relay of f.authorities) {
			const wire = relay.traceRequests().at(-1)!;
			expect(filters(wire)).toHaveLength(2);
			expect(filters(wire).every((filter) => filter.limit === undefined)).toBe(true);
			send(relay.latestSocket(), 'EVENT', wire[1], live);
		}
		await vi.advanceTimersByTimeAsync(10);
		expect(config.onLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: live.id }));
		const caughtUp = traceReply(f.channel.id, 'after-disconnect', TIME + 2, currentId);
		recent.unshift(caughtUp, live);
		const relay = f.authorities[0];
		const requestsBefore = relay.traceRequests().length;
		relay.latestSocket().close({ code: 1001, reason: 'three-tag reconnect', wasClean: false });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(relay.traceRequests().length).toBeGreaterThan(requestsBefore);
		expect(filters(relay.traceRequests().at(-1)!).every((filter) => filter.limit === undefined && typeof filter.since === 'number')).toBe(true);
		expect(config.onBatch).toHaveBeenCalledWith(expect.objectContaining({ events: [expect.objectContaining({ id: caughtUp.id })] }));
		expect(config.onLiveEvent).toHaveBeenCalledTimes(1);
	});

	it('rejects the entire legacy bundle instead of serving its valid root filter', async () => {
		const relay = mockRelay(); relay.maxTagFilters = 3;
		const served = vi.fn(); relay.onRequest = served;
		const socket = new WebSocket(relay.url);
		const packets: unknown[][] = [];
		socket.onmessage = (event) => packets.push(JSON.parse(event.data as string));
		await vi.advanceTimersByTimeAsync(10);
		const root = { kinds: [1111], '#E': ['a'.repeat(64)], '#L': ['namespace'], '#l': ['chat'], limit: 100 };
		socket.send(JSON.stringify(['REQ', 'legacy', root, { ...root, '#e': ['a'.repeat(64)] }]));
		await vi.advanceTimersByTimeAsync(10);
		expect(packets).toEqual([['CLOSED', 'legacy', 'ERROR: bad req: too many tags in filter']]);
		expect(served).not.toHaveBeenCalled(); socket.close();
	});

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
		send(a.latestSocket(), 'EVENT', a.primaryId(WORLD_STATE_KIND), position);
		await vi.advanceTimersByTimeAsync(5);
		expect(config.onLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(reply));
		expect(f.input.onLiveMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: message.id }), expect.objectContaining(message)
		);
		expect(f.input.onLiveWorldState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: position.id }));
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

	it('keeps notification cursor continuity for the persona scope only', async () => {
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
		expect(addedFilter.since).toBe(TIME - 300);
		expect(addedFilter).not.toHaveProperty('#E');
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
		const primary = observed.filter((message) => message[0] === 'REQ' && [42, WORLD_STATE_KIND].includes(((message[2] as Record<string, number[]>).kinds)[0]));
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
		['legacy World State kind', { kinds: [30078] }],
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
		expect(f.authorities.every((relay) => relay.messages.filter((message) => message[0] === 'EVENT').length <= 1)).toBe(true);
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

	it('cancels start and clears its deadline when disposed during primary bootstrap', async () => {
		const f = fixture();
		for (const relay of f.authorities) relay.onRequest = () => {};
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
