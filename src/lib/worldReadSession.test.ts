import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParsedPositionEvent, ParsedWorldMessage } from './nostrProtocol';
import { PRESENCE_TIMEOUT_MS } from './presence';
import { createWorldReadSession, type WorldReadConnectionStatus } from './worldReadSession';

const mocked = vi.hoisted(() => ({ createTransport: vi.fn() }));

vi.mock('./nostrRelayTransport', () => ({
	createNostrRelayTransport: mocked.createTransport
}));

const alice = 'a'.repeat(64);

function message(id = 'message', createdAt = 100): ParsedWorldMessage {
	return { id, pubkey: alice, createdAt, content: 'hello', speechType: 'normal', position: { x: 1, y: 1 } };
}

function position(id = 'position', createdAt = 100): ParsedPositionEvent {
	return { id, pubkey: alice, createdAt, slot: 0, position: { x: 2, y: 1 } };
}

function startResult(messages: readonly ParsedWorldMessage[] = [], positions: readonly ParsedPositionEvent[] = [], statuses: readonly string[] = ['eose']) {
	return {
		messages,
		positions,
		metadataDiscovery: { relays: [{ relayUrl: 'ws://relay.test/', status: 'eose' }] },
		primaryPairs: statuses.map((status) => ({ relayUrl: 'ws://relay.test/', subscription: 'world-messages', status })),
		nip11: []
	} as never;
}

describe('world read session', () => {
	let input: {
		onLiveMessage: (event: ParsedWorldMessage) => void;
		onLivePosition: (event: ParsedPositionEvent) => void;
		onPrimaryClosed: (diagnostic: never) => void;
		messageSince: number;
		positionSince: number;
	} | undefined;
	let dispose: ReturnType<typeof vi.fn>;
	let publish: ReturnType<typeof vi.fn>;
	let result: ReturnType<typeof startResult>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(700_000);
		input = undefined;
		dispose = vi.fn();
		publish = vi.fn();
		result = startResult();
		mocked.createTransport.mockReset();
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			dispose,
			publish
		});
	});

	it('reconstructs the bootstrap snapshot and uses the 11 minute window', async () => {
		result = startResult([message('message', 700)], [position('position', 700)]);
		const presences: number[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: (presence) => presences.push(presence.participants.length),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		const bootstrap = await session.start();

		expect(input).toMatchObject({ messageSince: 40, positionSince: 40 });
		expect(bootstrap.presence.participants).toEqual([
			{ id: alice, position: { x: 2, y: 1 }, lastActivityAt: 700_000, status: 'active' }
		]);
		expect(presences.at(-1)).toBe(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it('buffers live callbacks until bootstrap completion, then drains them once in arrival order', async () => {
		const liveMessage = message('live-message', 701);
		const livePosition = position('live-position', 702);
		const received: string[] = [];
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onLiveMessage(liveMessage);
				nextInput.onLivePosition(livePosition);
				return startResult();
			}),
			dispose
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: (event) => received.push(event.id),
			onStatusChanged: vi.fn()
		});

		await session.start();
		expect(received).toEqual([]);
		session.completeBootstrap();
		expect(received).toEqual(['live-message']);
		expect(session.refresh(702_000).participants[0]).toMatchObject({ position: { x: 2, y: 1 } });
		session.completeBootstrap();
		expect(received).toEqual(['live-message']);
	});

	it('keeps usable snapshots on partial Relay failure and reports degradation', async () => {
		result = startResult([], [], ['eose', 'timeout']);
		const statuses: WorldReadConnectionStatus[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});

		const bootstrap = await session.start();

		expect(bootstrap.status).toEqual({ kind: 'degraded', issueCount: 1 });
		expect(statuses.at(-1)).toEqual({ kind: 'degraded', issueCount: 1 });
	});

	it('reports a post-bootstrap primary close as degraded without discarding presence', async () => {
		const statuses: WorldReadConnectionStatus[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});

		await session.start();
		input!.onPrimaryClosed({ relayUrl: 'ws://relay.test/', subscription: 'world-messages', status: 'closed' } as never);

		expect(session.getStatus()).toEqual({ kind: 'degraded', issueCount: 1 });
		expect(statuses.at(-1)).toEqual({ kind: 'degraded', issueCount: 1 });
	});

	it('reports fatal startup failure without treating it as an empty world', async () => {
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async () => { throw new Error('metadata resolution failed'); }),
			dispose
		});
		const statuses: WorldReadConnectionStatus[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});

		await expect(session.start()).rejects.toThrow('metadata resolution failed');
		expect(statuses.at(-1)).toEqual({ kind: 'failed', message: 'metadata resolution failed' });
	});

	it('reprojects canonical presence at the existing ten minute timeout and ignores callbacks after disposal', async () => {
		result = startResult([message('bootstrap', 100)]);
		const live = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: live,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		expect(session.refresh(100_000 + PRESENCE_TIMEOUT_MS).participants[0].status).toBe('inactive');
		session.dispose();
		input!.onLiveMessage(message('after-dispose', 701));
		expect(live).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
