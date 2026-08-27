import { Server, WebSocket } from 'mock-socket';
import { createRxNostr, noopSigner } from 'rx-nostr';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';

const TEST_SECRET_KEY = new Uint8Array(32).fill(7);
const servers: Server[] = [];

function event(): VerifiedEvent {
	return finalizeEvent({
		kind: 1,
		created_at: 1_700_000_000,
		tags: [],
		content: 'patched publish cleanup'
	}, TEST_SECRET_KEY);
}

function waitFor(predicate: () => boolean, timeout = 500): Promise<void> {
	const startedAt = Date.now();
	return new Promise((resolve, reject) => {
		const check = () => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - startedAt >= timeout) {
				reject(new Error('Timed out waiting for the expected public rx-nostr behavior.'));
				return;
			}
			setTimeout(check, 1);
		};
		check();
	});
}

async function waitForCompletion(observable: { subscribe(observer: { complete: () => void; error: (error: unknown) => void }): void }): Promise<void> {
	await new Promise<void>((resolve, reject) => observable.subscribe({ complete: resolve, error: reject }));
}

async function expectPublishCleanup(ok: boolean | null): Promise<void> {
	const relayUrl = `ws://rx-nostr-patch-${crypto.randomUUID()}`;
	const server = new Server(relayUrl);
	servers.push(server);
	server.on('connection', (socket) => {
		socket.on('message', (data) => {
			const message = JSON.parse(data as string) as unknown[];
			if (message[0] !== 'EVENT' || ok === null) return;
			const published = message[1] as { id: string };
			socket.send(JSON.stringify(['OK', published.id, ok, ok ? 'accepted' : 'rejected']));
		});
	});

	const rxNostr = createRxNostr({
		connectionStrategy: 'lazy',
		disconnectTimeout: 1,
		okTimeout: 10,
		signer: noopSigner(),
		verifier: async () => true,
		websocketCtor: WebSocket as unknown as import('rx-nostr').IWebSocketConstructor
	});

	try {
		rxNostr.setDefaultRelays([relayUrl]);
		await waitForCompletion(rxNostr.send(event()));
		await waitFor(() => rxNostr.getRelayStatus(relayUrl)?.connection === 'dormant');
	} finally {
		rxNostr.dispose();
	}
}

afterEach(() => {
	while (servers.length > 0) servers.pop()?.stop();
});

describe('rx-nostr 3.7.5 temporary publish cleanup patch', () => {
	it('releases the lazy relay after a terminal OK true', async () => {
		await expectPublishCleanup(true);
	});

	it('releases the lazy relay after a terminal OK false', async () => {
		await expectPublishCleanup(false);
	});

	it('releases the lazy relay after an OK timeout', async () => {
		await expectPublishCleanup(null);
	});
});
