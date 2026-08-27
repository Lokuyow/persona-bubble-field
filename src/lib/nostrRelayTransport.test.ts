import { Server, WebSocket } from 'mock-socket';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNostrRelayTransport } from './nostrRelayTransport';
import type { PrototypeWorldConfig } from './prototypeWorld';

const CREATOR = new Uint8Array(32).fill(11);
const AUTHOR = new Uint8Array(32).fill(12);
const servers: Server[] = [];
const originalFetch = globalThis.fetch;

function relayUrl(name: string): string {
	return `ws://${name}-${crypto.randomUUID()}`;
}

function asWireEvent(event: VerifiedEvent): string {
	return JSON.stringify(event);
}

function sendEose(socket: { send(message: string): void }, subId: string): void {
	socket.send(JSON.stringify(['EOSE', subId]));
}

function hasKind(filter: Record<string, unknown>, kind: number): boolean {
	return Array.isArray(filter.kinds) && filter.kinds.includes(kind);
}

function buildFixture() {
	const bootstrapRelays = [relayUrl('bootstrap-a'), relayUrl('bootstrap-b'), relayUrl('bootstrap-c'), relayUrl('bootstrap-d')];
	const authoritativeRelays = [relayUrl('world-a'), relayUrl('world-b')];
	const channel = finalizeEvent({
		kind: 40,
		created_at: 1_700_000_000,
		tags: [],
		content: JSON.stringify({ relays: authoritativeRelays })
	}, CREATOR);
	const metadata = finalizeEvent({
		kind: 41,
		created_at: 1_700_000_001,
		tags: [['e', channel.id]],
		content: JSON.stringify({ relays: authoritativeRelays })
	}, CREATOR);
	const message = finalizeEvent({
		kind: 42,
		created_at: 1_700_000_010,
		tags: [
			['e', channel.id, '', 'root'],
			['L', 'io.github.lokuyow.persona-bubble-field'],
			['l', 'chat', 'io.github.lokuyow.persona-bubble-field'],
			['w', '1:2']
		],
		content: 'hello'
	}, AUTHOR);
	const config: PrototypeWorldConfig = {
		channelId: channel.id,
		metadataDiscoveryRelays: bootstrapRelays,
		preferredRelayHint: authoritativeRelays[0]
	};
	return { authoritativeRelays, bootstrapRelays, channel, config, message, metadata };
}

afterEach(() => {
	while (servers.length > 0) servers.pop()?.stop();
	globalThis.fetch = originalFetch;
});

beforeEach(() => {
	globalThis.fetch = async () => new Response(JSON.stringify({ limitation: { max_subscriptions: 3 } }), {
		headers: { 'content-type': 'application/nostr+json' }
	});
});

describe('Nostr relay transport', () => {
	it('discovers metadata through temporary bootstrap relays, then buffers primary events and settles per relay', async () => {
		const fixture = buildFixture();
		for (const relay of fixture.bootstrapRelays) {
			const server = new Server(relay);
			servers.push(server);
			server.on('connection', (socket) => socket.on('message', (data) => {
				const request = JSON.parse(data as string) as unknown[];
				if (request[0] !== 'REQ') return;
				const filter = request[2] as Record<string, unknown>;
				if (Array.isArray(filter.ids)) socket.send(JSON.stringify(['EVENT', request[1], JSON.parse(asWireEvent(fixture.channel))]));
				if (hasKind(filter, 41)) socket.send(JSON.stringify(['EVENT', request[1], JSON.parse(asWireEvent(fixture.metadata))]));
				sendEose(socket, request[1] as string);
			}));
		}
		for (const relay of fixture.authoritativeRelays) {
			const server = new Server(relay);
			servers.push(server);
			server.on('connection', (socket) => socket.on('message', (data) => {
				const request = JSON.parse(data as string) as unknown[];
				if (request[0] !== 'REQ') return;
				const filter = request[2] as Record<string, unknown>;
				if (hasKind(filter, 42) && !('#w' in filter)) {
					socket.send(JSON.stringify(['EVENT', request[1], JSON.parse(asWireEvent(fixture.message))]));
				}
				sendEose(socket, request[1] as string);
			}));
		}

		const transport = createNostrRelayTransport(fixture.config, {
			operationTimeoutMs: 100,
			websocketCtor: WebSocket as unknown as import('rx-nostr').IWebSocketConstructor
		});
		try {
			const result = await transport.start({
				messageSince: 123,
				positionSince: 456,
				onLiveMessage: () => undefined,
				onLivePosition: () => undefined,
				onPrimaryClosed: () => undefined
			});

			expect(result.metadata.relays).toEqual(fixture.authoritativeRelays.map((relay) => `${relay}/`));
			expect(result.metadataDiscovery.relays.every((relay) => relay.receivedKind40)).toBe(true);
			expect(result.messages.map((event) => event.id)).toEqual([fixture.message.id]);
			expect(result.primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'eose', 'eose']);
			expect(transport.getDiagnostics().connections.map((connection) => connection.relayUrl)).toEqual(
			fixture.authoritativeRelays.map((relay) => `${relay}/`)
		);
		} finally {
			transport.dispose();
		}
	});

	it('allows a finite trace REQ after start without changing primary lifecycle', async () => {
		const fixture = buildFixture();
		const traceRequests: unknown[][] = [];
		for (const relay of fixture.bootstrapRelays) {
			const server = new Server(relay);
			servers.push(server);
			server.on('connection', (socket) => socket.on('message', (data) => {
				const request = JSON.parse(data as string) as unknown[];
				if (request[0] !== 'REQ') return;
				const filter = request[2] as Record<string, unknown>;
				if (Array.isArray(filter.ids)) socket.send(JSON.stringify(['EVENT', request[1], fixture.channel]));
				if (hasKind(filter, 41)) socket.send(JSON.stringify(['EVENT', request[1], fixture.metadata]));
				sendEose(socket, request[1] as string);
			}));
		}
		for (const relay of fixture.authoritativeRelays) {
			const server = new Server(relay);
			servers.push(server);
			server.on('connection', (socket) => socket.on('message', (data) => {
				const request = JSON.parse(data as string) as unknown[];
				if (request[0] !== 'REQ') return;
				const filter = request[2] as Record<string, unknown>;
				if ('#w' in filter) traceRequests.push(request);
				sendEose(socket, request[1] as string);
			}));
		}

		const transport = createNostrRelayTransport(fixture.config, {
			operationTimeoutMs: 100,
			websocketCtor: WebSocket as unknown as import('rx-nostr').IWebSocketConstructor
		});
		try {
			await transport.start({
				messageSince: 123,
				positionSince: 456,
				onLiveMessage: () => undefined,
				onLivePosition: () => undefined,
				onPrimaryClosed: () => undefined
			});
			const trace = await transport.queryTrace({ positions: [{ x: 1, y: 2 }] });
			expect(trace).toEqual([]);
			expect(traceRequests).toHaveLength(2);
			expect(transport.getDiagnostics().primaryPairs.map((pair) => pair.status)).toEqual(['eose', 'eose', 'eose', 'eose']);
		} finally {
			transport.dispose();
		}
	});
});
