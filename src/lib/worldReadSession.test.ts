import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import { parsePositionEvent, type ParsedPositionEvent, type ParsedWorldMessage } from './nostrProtocol';
import { PRESENCE_TIMEOUT_MS } from './presence';
import { createWorldReadSession, type WorldReadConnectionStatus } from './worldReadSession';

const mocked = vi.hoisted(() => ({ createTransport: vi.fn() }));

vi.mock('./nostrRelayTransport', () => ({
	createNostrRelayTransport: mocked.createTransport
}));

const alice = 'a'.repeat(64);
const selfSecretKey = new Uint8Array(32).fill(7);
const selfPubkey = getPublicKey(selfSecretKey);

function selfAccount() {
	return {
		secretKey: selfSecretKey.slice(),
		pubkey: selfPubkey,
		lastChangedAtMs: 700_000,
		initialProfilePublished: true
	};
}

function message(id = 'message', createdAt = 100): ParsedWorldMessage {
	return { id, pubkey: alice, createdAt, content: 'hello', speechType: 'normal', position: { x: 1, y: 1 } };
}

function position(
	id = 'position',
	createdAt = 100,
	pubkey = alice,
	slot: 0 | 1 = 0,
	cell = { x: 2, y: 1 }
): ParsedPositionEvent {
	return { id, pubkey, createdAt, slot, position: cell };
}

function startResult(messages: readonly ParsedWorldMessage[] = [], positions: readonly ParsedPositionEvent[] = [], statuses: readonly string[] = ['eose']) {
	return {
		metadata: {
			channel: { channelId: 'c'.repeat(64), relayHint: 'wss://relay.test/' }
		},
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

	it('delegates pre-signed publication to the started transport without changing world status on failure', async () => {
		const statuses: WorldReadConnectionStatus[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});
		const event = { id: 'a'.repeat(64) } as VerifiedEvent;
		const results = [{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }] as const;

		await session.start();
		publish.mockResolvedValueOnce(results);
		await expect(session.publish(event)).resolves.toEqual(results);
		expect(publish).toHaveBeenCalledWith(event);

		const beforeFailure = [...statuses];
		publish.mockRejectedValueOnce(new Error('disposed'));
		await expect(session.publish(event)).rejects.toThrow('disposed');
		expect(statuses).toEqual(beforeFailure);
		session.dispose();
		expect(() => session.publish(event)).toThrow('World read session must start before publishing.');
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

	it('flushes buffered occupancy before selecting an entry cell', async () => {
		const occupied = position('occupied', 700, alice, 0, { x: 0, y: 0 });
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onLivePosition(occupied);
				return startResult();
			}),
			dispose,
			publish
		});
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 2, rows: 1 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		const event = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).toEqual({ x: 1, y: 0 });
	});

	it('keeps an active bootstrap self at its recovered position without another entry event', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'not-needed' });
		expect(publish).not.toHaveBeenCalled();
	});

	it('uses the retained cell for the first post-timeout reactivation', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		vi.setSystemTime(700_000 + PRESENCE_TIMEOUT_MS);
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'succeeded', operation: 'reactivation' });
		const event = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).toEqual({ x: 2, y: 1 });
	});

	it('applies a handoff event once when its live echo arrives before no-response completion', async () => {
		let resolvePublish: (results: readonly { relayUrl: string; outcome: 'no-response' }[]) => void;
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		const pending = session.enterSelf();
		await Promise.resolve();
		const echoed = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		input!.onLivePosition(echoed);
		input!.onLivePosition(echoed);
		resolvePublish!([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);

		await expect(pending).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		expect(session.refresh(700_000).participants.filter((participant) => participant.id === selfPubkey)).toEqual([
			expect.objectContaining({ position: echoed.position, status: 'active' })
		]);
		expect(writeStates.at(-1)).toBe('succeeded');
	});

	it('does not double-apply an echo that arrives before accepted completion', async () => {
		let resolvePublish: (results: readonly { relayUrl: string; outcome: 'accepted' }[]) => void;
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const presenceChanged = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: presenceChanged,
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		const pending = session.enterSelf();
		await Promise.resolve();
		const echoed = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		input!.onLivePosition(echoed);
		const beforeCompletion = presenceChanged.mock.calls.length;
		resolvePublish!([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);

		await expect(pending).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		expect(presenceChanged).toHaveBeenCalledTimes(beforeCompletion);
	});

	it('does not double-apply an accepted event when its echo arrives later', async () => {
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const presenceChanged = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: presenceChanged,
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		const echoed = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		const beforeEcho = presenceChanged.mock.calls.length;
		input!.onLivePosition(echoed);

		expect(presenceChanged).toHaveBeenCalledTimes(beforeEcho);
	});

	it('keeps a no-response slot consumed without advancing canonical presence', async () => {
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'blocked' });
		const first = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		const second = parsePositionEvent(publish.mock.calls[1][0], 'c'.repeat(64))!;
		expect([first.slot, second.slot]).toEqual([0, 1]);
		expect(session.refresh(700_000).participants.find((participant) => participant.id === selfPubkey)).toBeUndefined();
	});

	it('reconstructs a reloaded planner from bootstrap position evidence, not an earlier session attempt', async () => {
		result = startResult([], [position('bootstrap-slot-0', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfAccount: selfAccount(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'succeeded', operation: 'movement' });
		const event = parsePositionEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.slot).toBe(1);
	});
});
