import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicKey, type VerifiedEvent } from 'nostr-tools/pure';
import {
	parseWorldStateEvent,
	parseTraceEvent,
	parseTraceReplyCandidate,
	validateTraceReplyCandidate,
	parseWorldMessage,
	WORLD_STATE_KIND,
	type ParsedWorldStateEvent,
	type ParsedTraceReply,
	type ParsedWorldMessage
} from './nostrProtocol';
import type { TraceReplyConfiguration, TraceReplyConfigurationResult } from './nostrRelayTransport';
import { PRESENCE_TIMEOUT_MS, type PresenceState } from './presence';
import { planPositionPublish, reconstructPositionPublishState } from './positionPublish';
import { protocolKeyFor } from './realtimeEvents';
import { createWorldReadSession, type RealtimeStartConfiguration, type WorldReadConnectionStatus } from './worldReadSession';

const mocked = vi.hoisted(() => ({
	createTransport: vi.fn(),
	reconcileTraceRootCache: vi.fn(),
	reconcileTraceReplyCache: vi.fn(),
	touchTraceReplyTree: vi.fn()
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

describe('Trace reply publication ownership', () => {
	const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
	const accepted = [{ relayUrl: 'wss://relay.test/', outcome: 'accepted' as const }];

	async function fixture(nested = false) {
		vi.useFakeTimers(); vi.setSystemTime(700_000);
		const root = message('a'.repeat(64), 699);
		const child = traceReply('b'.repeat(64), root, 699);
		let cached: readonly ParsedTraceReply[] = nested ? [child] : [];
		let callbacks!: TraceReplyConfiguration;
		let primary!: { onLiveWorldState: (event: ParsedWorldStateEvent) => void };
		const publish = vi.fn(async (_event: VerifiedEvent) => accepted as import('./nostrRelayTransport').PublishRelayResult[]);
		const configureTraceReplies = vi.fn(async (input: TraceReplyConfiguration) => {
			callbacks = input;
			return { status: 'active', initialBatch: { events: [], relays: [] } };
		});
		mocked.reconcileTraceRootCache.mockReset().mockResolvedValue([root]);
		mocked.touchTraceReplyTree.mockReset().mockResolvedValue(true);
		mocked.reconcileTraceReplyCache.mockReset().mockImplementation(async ({ rawEvents }) => {
			for (const rawEvent of rawEvents) {
				const candidate = parseTraceReplyCandidate(rawEvent);
				const parent = candidate?.parentId === root.id ? root : child;
				const parsed = candidate && validateTraceReplyCandidate(candidate, root, parent);
				if (parsed && !cached.some((reply) => reply.id === parsed.id)) cached = [...cached, parsed];
			}
			return cached;
		});
		mocked.createTransport.mockReset().mockReturnValue({
			start: vi.fn(async (input) => { primary = input; return startResult([], [position('self', 700, selfPubkey)]); }),
			bootstrapTraceRootCandidates: traceBootstrap(), configureTraceReplies, publish, dispose: vi.fn()
		});
		const onLiveMessage = vi.fn();
		const session = createWorldReadSession({ field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage, onStatusChanged: vi.fn() });
		await session.start(); session.completeBootstrap(); await session.enterSelf(); await settle();
		expect(session.openTraceConversation({ rootId: root.id, currentId: root.id }).kind).toBe('opened');
		await settle();
		return { session, root, child, publish, configureTraceReplies, primary, onLiveMessage,
			callbacks: () => callbacks,
			submit: (speechType: 'normal' | 'shout' | 'monologue' = 'normal') => session.publishTraceReply({
				rootId: root.id, targetId: nested ? child.id : root.id, content: 'reply draft', speechType
			}) };
	}

	it.each(['normal', 'shout', 'monologue'] as const)('publishes a root %s reply and keeps current speech', async (speechType) => {
		const f = await fixture();
		const result = await f.submit(speechType);
		expect(result.kind).toBe('succeeded');
		expect(f.publish).toHaveBeenCalledTimes(1);
		const rawEvent = f.publish.mock.calls[0][0];
		expect(rawEvent.kind).toBe(1111);
		expect(rawEvent.tags).toEqual(expect.arrayContaining([
			['E', f.root.id, '', f.root.pubkey], ['K', '42'], ['P', f.root.pubkey],
			['e', f.root.id, '', f.root.pubkey], ['k', '42'], ['p', f.root.pubkey]
		]));
		expect(parseTraceReplyCandidate(rawEvent)?.speechType).toBe(speechType);
		expect(f.session.getTraceConversationState()).toMatchObject({ config: { currentId: f.root.id }, replies: [{ id: rawEvent.id }] });
		expect(f.onLiveMessage).not.toHaveBeenCalled();
	});

	it('stops position, message, and Trace writers after its owner is disposed', async () => {
		const f = await fixture();
		f.session.dispose();

		await expect(f.session.moveSelf('right')).resolves.toEqual({ kind: 'unavailable' });
		await expect(f.session.publishMessage('old persona message', 'normal')).resolves.toEqual({ kind: 'unavailable' });
		await expect(f.submit()).resolves.toEqual({ kind: 'unavailable' });

		expect(f.publish).not.toHaveBeenCalled();
	});

	it('constructs nested references from the accepted tree', async () => {
		const f = await fixture(true); await f.submit();
		const rawEvent = f.publish.mock.calls[0][0];
		expect(rawEvent.tags).toEqual(expect.arrayContaining([['E', f.root.id, '', f.root.pubkey],
			['e', f.child.id, '', f.child.pubkey], ['k', '1111'], ['p', f.child.pubkey]]));
	});

	it('rejects a foreign target before any planner or publication work', async () => {
		const f = await fixture();
		await expect(f.session.publishTraceReply({ rootId: f.root.id, targetId: 'f'.repeat(64), content: 'draft', speechType: 'normal' }))
			.resolves.toEqual({ kind: 'blocked' });
		expect(f.publish).not.toHaveBeenCalled();
	});

	it('blocks reply before consuming another slot while Trace inspection is pending, and allows retry', async () => {
		const f = await fixture(); vi.setSystemTime(701_000);
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementationOnce(() => pending.promise);
		expect(f.session.selectTraceConversationSpeech(f.root.id).kind).toBe('opened');
		await expect(f.submit()).resolves.toEqual({ kind: 'pending' });
		expect(f.publish).toHaveBeenCalledTimes(1);
		pending.resolve(accepted); await settle();
		await expect(f.submit()).resolves.toMatchObject({ kind: 'succeeded' });
		expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([WORLD_STATE_KIND, 1111]);
	});

	it('allows local Trace navigation while its inspection position is pending without publishing again', async () => {
		const f = await fixture(true); vi.setSystemTime(701_000);
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementation((event) => event.kind === WORLD_STATE_KIND ? pending.promise : Promise.resolve(accepted));

		expect(f.session.selectTraceConversationSpeech(f.child.id)).toEqual({ kind: 'opened' });
		await settle();
		expect(f.session.getTraceConversationState()).toMatchObject({ config: { currentId: f.child.id } });
		expect(f.publish).toHaveBeenCalledTimes(1);
		expect(f.publish.mock.calls[0][0].kind).toBe(WORLD_STATE_KIND);

		expect(f.session.selectTraceConversationSpeech(f.root.id)).toEqual({ kind: 'opened' });
		expect(f.session.getTraceConversationState()).toMatchObject({ config: { rootId: f.root.id, currentId: f.root.id } });
		expect(f.publish).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])('holds the owner through kind 1111 (preceding position: %s), even after position echo', async (positionRequired) => {
		const f = await fixture();
		if (positionRequired) vi.setSystemTime(701_000);
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementation((event) => event.kind === 1111 ? pending.promise : Promise.resolve(accepted));
		const result = f.submit(); await settle();
		const calls = f.publish.mock.calls.map(([event]) => event);
		if (positionRequired) f.primary.onLiveWorldState(parseWorldStateEvent(calls[0], 'c'.repeat(64))!);
		await expect(f.session.moveSelf('right')).resolves.toEqual({ kind: 'pending' });
		await expect(f.session.enterSelf()).resolves.toEqual({ kind: 'pending' });
		await expect(f.session.publishMessage('normal', 'normal')).resolves.toEqual({ kind: 'pending' });
		expect(f.session.selectTraceConversationSpeech(f.root.id).kind).toBe('pending');
		await expect(f.submit()).resolves.toEqual({ kind: 'pending' });
		expect(f.publish).toHaveBeenCalledTimes(positionRequired ? 2 : 1);
		pending.resolve(accepted); await result;
		vi.setSystemTime(702_000);
		await expect(f.session.moveSelf('right')).resolves.toMatchObject({ kind: 'succeeded' });
	});

	it('also excludes an already pending normal message', async () => {
		const f = await fixture();
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementationOnce(() => pending.promise);
		const message = f.session.publishMessage('normal', 'normal');
		await expect(f.submit()).resolves.toEqual({ kind: 'pending' });
		expect(f.publish).toHaveBeenCalledTimes(1);
		pending.resolve(accepted); await message;
	});

	it.each(['accepted', 'duplicate', 'rejected', 'exception', 'no-response'] as const)('withholds own echo until %s, while another valid reply continues', async (outcome) => {
		const f = await fixture();
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementationOnce(() => pending.promise);
		const result = f.submit();
		await settle();
		const rawEvent = f.publish.mock.calls[0][0];
		f.callbacks().onLiveEvent(rawEvent);
		f.callbacks().onBatch({ events: [rawEvent], relays: [] });
		await settle();
		expect(mocked.reconcileTraceReplyCache.mock.calls.flatMap(([input]) => input.rawEvents)).not.toContain(rawEvent);
		const { buildTraceReplyTemplate, finalizeWorldEvent } = await import('./nostrProtocol');
		const other = finalizeWorldEvent(buildTraceReplyTemplate({ root: f.root, parent: f.root, content: 'other',
			speechType: 'normal', createdAt: 700 }), new Uint8Array(32).fill(67));
		f.callbacks().onLiveEvent(other);
		f.callbacks().onBatch({ events: [], relays: [{ relayUrl: 'wss://relay.test/', status: 'closed' }] });
		await settle();
		expect(f.session.getTraceConversationState()).toMatchObject({ replies: [{ id: other.id }] });
		if (outcome === 'exception') pending.reject(new Error('offline'));
		else if (outcome === 'no-response') pending.resolve([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		else pending.resolve(outcome === 'accepted' ? accepted : [{ relayUrl: 'wss://relay.test/', outcome: 'rejected',
			notice: outcome === 'duplicate' ? 'duplicate: already stored' : 'blocked: no' }]);
		const success = outcome === 'accepted' || outcome === 'duplicate';
		await expect(result).resolves.toMatchObject({ kind: success ? 'succeeded' : 'reply-failed' });
		expect(mocked.reconcileTraceReplyCache.mock.calls.flatMap(([input]) => input.rawEvents).filter((event) => event.id === rawEvent.id))
			.toHaveLength(success ? 1 : 0);
		expect(f.configureTraceReplies).toHaveBeenCalledTimes(1);
		f.session.closeTraceConversation(); await settle();
		f.session.openTraceConversation({ rootId: f.root.id, currentId: f.root.id }); await settle();
		f.callbacks().onLiveEvent(rawEvent); await settle();
		expect(f.session.getTraceConversationState()).toMatchObject({ replies: expect.arrayContaining([expect.objectContaining({ id: rawEvent.id })]) });
	});

	it('keeps the owner during reconciliation and treats cache failure as supplemental', async () => {
		const f = await fixture();
		const cache = deferred<readonly ParsedTraceReply[]>();
		mocked.reconcileTraceReplyCache.mockImplementationOnce(() => cache.promise);
		const result = f.submit(); await settle();
		await expect(f.session.moveSelf('right')).resolves.toEqual({ kind: 'pending' });
		cache.reject(new Error('transaction aborted'));
		await expect(result).resolves.toMatchObject({ kind: 'succeeded' });
		vi.setSystemTime(701_000);
		await expect(f.session.moveSelf('right')).resolves.toMatchObject({ kind: 'succeeded' });
	});

	it('reconciles accepted publication after close without reopening its conversation', async () => {
		const f = await fixture();
		const pending = deferred<import('./nostrRelayTransport').PublishRelayResult[]>();
		f.publish.mockImplementationOnce(() => pending.promise);
		const result = f.submit();
		await settle();
		f.session.closeTraceConversation(); await settle();
		const configurations = f.configureTraceReplies.mock.calls.length;
		pending.resolve(accepted);
		await expect(result).resolves.toMatchObject({ kind: 'succeeded' });
		expect(f.session.getTraceConversationState()).toEqual({ kind: 'closed' });
		expect(f.configureTraceReplies).toHaveBeenCalledTimes(configurations);
		expect(mocked.reconcileTraceReplyCache.mock.calls.at(-1)![0]).not.toHaveProperty('currentOpenRootId');
	});

	it('does not roll back position or its consumed slots when reply is rejected', async () => {
		const f = await fixture(); vi.setSystemTime(701_000);
		f.publish.mockImplementation(async (event) => event.kind === 1111
			? [{ relayUrl: 'wss://relay.test/', outcome: 'rejected', notice: 'blocked: no' }] : accepted);
		await expect(f.submit()).resolves.toEqual({ kind: 'reply-failed' });
		await f.session.moveSelf('right');
		expect(parseWorldStateEvent(f.publish.mock.calls.at(-1)![0], 'c'.repeat(64))?.slot).toBe(1);
		await expect(f.session.moveSelf('left')).resolves.toEqual({ kind: 'blocked' });
	});

	it('does not construct a reply after a retryable position failure and preserves slot consumption', async () => {
		const f = await fixture(); vi.setSystemTime(701_000);
		f.publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		await expect(f.submit()).resolves.toEqual({ kind: 'position-failed' });
		await expect(f.submit()).resolves.toEqual({ kind: 'position-failed' });
		await expect(f.submit()).resolves.toEqual({ kind: 'blocked' });
		expect(f.publish.mock.calls.map(([event]) => event.kind)).toEqual([WORLD_STATE_KIND, WORLD_STATE_KIND]);
	});
});

vi.mock('./nostrRelayTransport', () => ({
	createNostrRelayTransport: mocked.createTransport
}));

vi.mock('./traceRootCache', () => ({
	reconcileTraceRootCache: mocked.reconcileTraceRootCache
}));

vi.mock('./traceReplyCache', () => ({
	reconcileTraceReplyCache: mocked.reconcileTraceReplyCache,
	touchTraceReplyTree: mocked.touchTraceReplyTree
}));

vi.mock('./positionPublish', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./positionPublish')>();
	return { ...actual, reconstructPositionPublishState: vi.fn(actual.reconstructPositionPublishState) };
});

const alice = 'a'.repeat(64);
const selfSecretKey = new Uint8Array(32).fill(30);
const selfPubkey = getPublicKey(selfSecretKey);

function selfSigner() {
	return {
		secretKey: selfSecretKey.slice(),
		pubkey: selfPubkey,
		identityCreatedAtMs: 700_000,
		characterProfileRevision: 2,
		identity: { generation: 1, accountIndex: 1, pubkey: selfPubkey }
	};
}

function message(id = 'message', createdAt = 100): ParsedWorldMessage {
	return { id, pubkey: alice, createdAt, content: 'hello', speechType: 'normal', position: { x: 1, y: 1 } };
}

function deathRoot(id = 'death-root', position = { x: 1, y: 1 }): ParsedWorldMessage & { source: 'death' } {
	return { ...message(id, 700), position, source: 'death' };
}

function position(
	id = 'position',
	createdAt = 100,
	pubkey = alice,
	slot: 0 | 1 = 0,
	cell = { x: 2, y: 1 }
): ParsedWorldStateEvent {
	return { id, pubkey, createdAt, state: 'active', slot, position: cell };
}

function raw(event: ParsedWorldMessage) {
	return { id: event.id } as never;
}

function traceReply(
	id: string,
	root: ParsedWorldMessage,
	createdAt = 701,
	options: {
		parent?: ParsedWorldMessage | ParsedTraceReply;
		position?: { x: number; y: number };
		pubkey?: string;
	} = {}
): ParsedTraceReply {
	const parent = options.parent ?? root;
	return {
		id,
		pubkey: options.pubkey ?? alice,
		createdAt,
		content: id,
		speechType: 'normal',
		rootId: root.id,
		rootPubkey: root.pubkey,
		parentId: parent.id,
		parentKind: 'rootId' in parent ? 1111 : 42,
		parentPubkey: parent.pubkey
	};
}

function traceBootstrap() {
	return vi.fn().mockResolvedValue({ rawEvents: [], relays: [] });
}

function startResult(messages: readonly ParsedWorldMessage[] = [], worldStates: readonly ParsedWorldStateEvent[] = [], statuses: readonly string[] = ['eose']) {
	return {
		channel: { channelId: 'c'.repeat(64), relayHint: 'wss://relay.test/' },
		messages,
		timelineMessages: messages,
		worldStates,
		primaryPairs: statuses.map((status) => ({ relayUrl: 'ws://relay.test/', subscription: 'world-messages', status })),
		nip11: []
	} as never;
}

describe('world read session', () => {
	let input: {
	onBootstrapMessage: (event: ParsedWorldMessage) => void;
	onBootstrapWorldState: (event: ParsedWorldStateEvent) => void;
		onLiveMessage: (event: ParsedWorldMessage, rawEvent: never) => void;
		onLiveWorldState: (event: ParsedWorldStateEvent) => void;
		onLiveTrace: (event: { id: string; source: 'death' }, rawEvent: never) => void;
		onPrimaryClosed: (diagnostic: never) => void;
		messageSince: number;
		worldStateSince: number;
	} | undefined;
	let dispose: ReturnType<typeof vi.fn>;
	let publish: ReturnType<typeof vi.fn>;
	let result: ReturnType<typeof startResult>;

	beforeEach(() => {
		vi.mocked(reconstructPositionPublishState).mockClear();
		vi.useFakeTimers();
		vi.setSystemTime(700_000);
		input = undefined;
		dispose = vi.fn();
		publish = vi.fn();
		result = startResult();
		mocked.createTransport.mockReset();
		mocked.reconcileTraceRootCache.mockReset().mockResolvedValue([]);
		mocked.reconcileTraceReplyCache.mockReset().mockResolvedValue([]);
		mocked.touchTraceReplyTree.mockReset().mockResolvedValue(true);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
	});

	it('can defer realtime startup until its event window without delaying primary bootstrap', async () => {
		const startRealtime = vi.fn().mockResolvedValue({ status: 'inactive', events: [], relays: [] });
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return startResult(); }),
			startRealtime,
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		const onRealtimeStatus = vi.fn();
		const onRealtimeBootstrapComplete = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
				realtime: {
					registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
					controlSince: 0, instanceFilters: [{ protocolKey: protocolKeyFor('fixture', 1), instanceIds: ['fixture-instance'], since: 0 }], startImmediately: false,
				onEvent: vi.fn(), onStatusChanged: onRealtimeStatus,
				onBootstrapComplete: onRealtimeBootstrapComplete,
			}
		});
		const bootstrap = await session.start();
		expect(bootstrap.status).toEqual({ kind: 'available' });
		expect(bootstrap.realtimeStatus).toBe('inactive');
		expect(startRealtime).not.toHaveBeenCalled();
		await session.startRealtime();
		expect(startRealtime).toHaveBeenCalledOnce();
		expect(onRealtimeStatus).toHaveBeenCalledWith('degraded');
		expect(onRealtimeBootstrapComplete).toHaveBeenCalledOnce();
	});

	it('ignores a stale realtime bootstrap after the supplemental subscription is stopped', async () => {
		const pendingRealtime = deferred<{ status: 'active'; events: []; relays: [] }>();
		const startRealtime = vi.fn().mockReturnValue(pendingRealtime.promise);
		const onRealtimeBootstrapComplete = vi.fn();
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return startResult(); }),
			startRealtime,
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish,
			stopRealtime: vi.fn()
		});
		const statuses: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn(),
				realtime: {
					registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
					controlSince: 0, instanceFilters: [{ protocolKey: protocolKeyFor('fixture', 1), instanceIds: ['fixture-instance'], since: 0 }], startImmediately: false,
				onEvent: vi.fn(), onStatusChanged: (status) => statuses.push(status), onBootstrapComplete: onRealtimeBootstrapComplete
			}
		});
		await session.start();
		const started = session.startRealtime();
		session.stopRealtime();
		pendingRealtime.resolve({ status: 'active', events: [], relays: [] });
		await started;
		expect(onRealtimeBootstrapComplete).not.toHaveBeenCalled();
		expect(statuses.at(-1)).toBe('inactive');
	});

	it('re-evaluates realtime instance and refreshes the control cursor only for a new generation', async () => {
		const startRealtime = vi.fn().mockResolvedValue({ status: 'active', events: [], relays: [] });
		const stopRealtime = vi.fn();
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return startResult(); }),
			startRealtime,
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish,
			stopRealtime
		});
		let configuration = { controlSince: 0, instanceFilters: [{ protocolKey: protocolKeyFor('fixture', 1), instanceIds: ['rift-day-1'], since: 100 }] };
		const prepareStartConfiguration = vi.fn((next: RealtimeStartConfiguration, nowMs: number): RealtimeStartConfiguration => ({
			...next,
			controlSince: Math.max(0, Math.floor(nowMs / 1000) - 900)
		}));
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn(),
					realtime: {
					registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
					controlSince: 0, instanceFilters: [], getStartConfiguration: () => configuration, prepareStartConfiguration, startImmediately: false,
					onEvent: vi.fn()
				}
		});
		await session.start();
		await session.startRealtime();
		const firstConfiguration = { ...configuration, controlSince: 0 };
		await session.startRealtime();
		expect(startRealtime).toHaveBeenCalledTimes(1);
		configuration = { controlSince: 0, instanceFilters: [{ protocolKey: protocolKeyFor('fixture', 1), instanceIds: ['rift-day-2'], since: 200 }] };
		vi.setSystemTime(3_600_000);
		await session.startRealtime();
		expect(startRealtime).toHaveBeenCalledTimes(2);
		expect(startRealtime.mock.calls.map(([next]) => ({
			controlSince: next.controlSince,
			instanceFilters: next.instanceFilters
		}))).toEqual([firstConfiguration, { ...configuration, controlSince: 2_700 }]);
		expect(prepareStartConfiguration).toHaveBeenCalledTimes(2);
		session.stopRealtime();
		await session.startRealtime();
		expect(startRealtime).toHaveBeenCalledTimes(3);
		expect(startRealtime.mock.calls[2][0].controlSince).toBe(2_700);
		expect(prepareStartConfiguration).toHaveBeenCalledTimes(3);
		expect(stopRealtime).toHaveBeenCalledTimes(2);
	});

	it('stops every self-write boundary when persisted Run authorization is lost', async () => {
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const authorize = vi.fn()
			.mockResolvedValueOnce('authorized' as const)
			.mockResolvedValueOnce('authorized' as const)
			.mockResolvedValueOnce('superseded' as const);
		const lost = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			authorizeSelfWrite: authorize, onSelfWriteAuthorizationLost: lost,
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start();
		session.completeBootstrap();
		await expect(session.moveSelf('right')).resolves.toMatchObject({ kind: 'succeeded' });
		await expect(session.publishMessage('stale', 'normal')).resolves.toMatchObject({ kind: 'succeeded' });
		await expect(session.publish({} as VerifiedEvent)).rejects.toThrow('Self-write authorization was lost.');
		expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([WORLD_STATE_KIND, 42]);
		expect(authorize).toHaveBeenCalledTimes(3);
		expect(lost).toHaveBeenCalledTimes(1);
	});

	it('prepares and publishes a terminal exit from canonical self position without consuming the active planner', async () => {
		result = startResult([], [position('self-slot-0', 701, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		const prepared = session.prepareTerminalExit(selfPubkey);
		expect(prepared.kind).toBe('prepared');
		if (prepared.kind !== 'prepared') throw new Error('Expected a prepared exit.');
		expect(prepared.parsed).toMatchObject({ state: 'exit', slot: null, position: { x: 2, y: 1 }, createdAt: 701 });
		expect(prepared.event.tags.find((tag) => tag[0] === 'd')?.[1]).toBe(`io.github.lokuyow.persona-bubble-field:world-state:1:${'c'.repeat(64)}:exit`);
		expect(parseWorldStateEvent(prepared.event, 'c'.repeat(64))).toMatchObject({ state: 'exit', position: { x: 2, y: 1 } });
		expect(await session.publishTerminalExit()).toEqual({ kind: 'unavailable' });
		session.commitTerminalExit({ createdAt: 701, position: prepared.parsed.position });
		expect(await session.publishTerminalExit()).toMatchObject({ kind: 'published' });
		expect(publish).toHaveBeenCalledOnce();
		expect(parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))).toMatchObject({ state: 'exit', position: { x: 2, y: 1 } });
		expect(await session.publishTerminalExit()).toEqual({ kind: 'unavailable' });
		expect(await session.moveSelf('right')).toEqual({ kind: 'unavailable' });
		expect(await session.publishMessage('normal message after death', 'normal')).toEqual({ kind: 'unavailable' });
	});

	it('routes live death traces to the trace reducer without entering world presence', async () => {
		const onLiveMessage = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage, onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		const rawEvent = { id: 'death-trace' } as never;
		input?.onLiveTrace({ id: 'death-trace', source: 'death' }, rawEvent);
		await Promise.resolve();
		expect(onLiveMessage).not.toHaveBeenCalled();
		expect(mocked.reconcileTraceRootCache).toHaveBeenCalledWith(expect.objectContaining({ rawEvents: [rawEvent] }));
	});

	it('publishes one dedicated death Last Words trace after terminal exit without using the presence writer', async () => {
		const selfMessage = { ...message('self-message', 110), pubkey: selfPubkey, position: { x: 2, y: 1 } };
		result = startResult([selfMessage], [position('self-slot-0', 100, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		vi.setSystemTime(105_000);
		const prepared = session.prepareTerminalExit(selfPubkey);
		expect(prepared.kind).toBe('prepared');
		if (prepared.kind !== 'prepared') throw new Error('Expected a prepared exit.');
		session.commitTerminalExit({ createdAt: 110, position: prepared.parsed.position });
		expect(await session.publishTerminalExit()).toMatchObject({ kind: 'published' });
		expect(session.enableDeathLastWords()).toBe(true);
		const publishedExit = publish.mock.calls[0][0] as VerifiedEvent;
		expect(publishedExit.created_at).toBe(110);
		const first = await session.publishDeathLastWords('  last words  ');
		expect(first).toMatchObject({ kind: 'published' });
		expect(publish).toHaveBeenCalledTimes(2);
		const publishedTrace = publish.mock.calls[1][0] as VerifiedEvent;
		expect(publishedTrace.kind).toBe(42);
		expect(publishedTrace.created_at).toBeGreaterThanOrEqual(publishedExit.created_at);
		expect(parseTraceEvent(publishedTrace, 'c'.repeat(64))).toMatchObject({ content: 'last words', position: { x: 2, y: 1 }, source: 'death' });
		expect(publishedTrace.tags.find((tag) => tag[0] === 'w')?.[1]).toBe(publishedExit.content);
		expect(await session.publishDeathLastWords('duplicate')).toEqual({ kind: 'unavailable' });
	});

	it('requires range and trace-inspection activity before opening a death root', async () => {
		const outside = deathRoot('death-outside', { x: 3, y: 2 });
		mocked.reconcileTraceRootCache.mockResolvedValue([outside]);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalled());
		expect(session.openTraceConversation({ rootId: outside.id, currentId: outside.id })).toEqual({ kind: 'blocked' });
		expect(publish).not.toHaveBeenCalled();

		const inside = deathRoot('death-inside');
		mocked.reconcileTraceRootCache.mockResolvedValue([inside]);
		session.closeTraceConversation();
		input?.onLiveTrace({ id: inside.id, source: 'death' }, raw(inside));
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalledWith(expect.objectContaining({ rawEvents: [expect.objectContaining({ id: inside.id })] })));
		vi.setSystemTime(701_000);
		expect(session.openTraceConversation({ rootId: inside.id, currentId: inside.id })).toEqual({ kind: 'opened' });
		await Promise.resolve();
		expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([WORLD_STATE_KIND]);
	});

	it('rejects kind 1111 publication to a death root at the session domain boundary', async () => {
		const root = deathRoot();
		mocked.reconcileTraceRootCache.mockResolvedValue([root]);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap(); await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalled());
		await session.enterSelf();
		vi.setSystemTime(701_000);
		expect(session.openTraceConversation({ rootId: root.id, currentId: root.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
		const publicationCountBeforeReply = publish.mock.calls.length;
		await expect(session.publishTraceReply({ rootId: root.id, targetId: root.id, content: 'no reply', speechType: 'normal' }))
			.resolves.toEqual({ kind: 'blocked' });
		expect(publish).toHaveBeenCalledTimes(publicationCountBeforeReply);
		expect(publish.mock.calls.map(([event]) => event.kind)).not.toContain(1111);
	});

	it('uses latest positive message activity when preparing an exit after clock regression', async () => {
		const selfMessage = { ...message('self-message', 110), pubkey: selfPubkey, position: { x: 2, y: 1 } };
		result = startResult([selfMessage], [position('self-position', 100, selfPubkey, 0, { x: 2, y: 1 })]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		vi.mocked(reconstructPositionPublishState).mockClear();
		vi.setSystemTime(105_000);

		const prepared = session.prepareTerminalExit(selfPubkey);
		expect(prepared.kind).toBe('prepared');
		if (prepared.kind !== 'prepared') throw new Error('Expected a prepared exit.');
		expect(prepared.parsed).toMatchObject({ state: 'exit', slot: null, position: { x: 2, y: 1 }, createdAt: 110 });
		expect(reconstructPositionPublishState).not.toHaveBeenCalled();
	});

	it('makes same-second re-entry strictly newer than the known self exit', async () => {
		result = startResult([], [
			position('self-before-exit', 99, selfPubkey, 0, { x: 1, y: 1 }),
			{ ...position('self-exit', 100, selfPubkey, 0, { x: 1, y: 1 }), state: 'exit', slot: null }
		]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		vi.setSystemTime(100_000);

		await expect(session.enterSelf()).resolves.toMatchObject({ kind: 'succeeded', operation: 'entry' });
		const entry = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(entry).toMatchObject({ state: 'active', createdAt: 101 });
	});

	it('does not prepare an exit without canonical self position and quiesces normal writes', async () => {
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		expect(session.prepareTerminalExit(selfPubkey)).toEqual({ kind: 'unavailable', reason: 'missing-position' });
		expect(await session.moveSelf('right')).toEqual({ kind: 'unavailable' });
		expect(await session.publishMessage('blocked', 'normal')).toEqual({ kind: 'unavailable' });
		expect(() => session.publish({} as VerifiedEvent)).toThrow('World read session must start before publishing.');
		expect(publish).not.toHaveBeenCalled();
	});

	it('blocks a write whose authorization resolves after terminal quiesce', async () => {
		const authorization = deferred<'authorized'>();
		const authorize = vi.fn(() => authorization.promise);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(), authorizeSelfWrite: authorize,
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start(); session.completeBootstrap();
		const movement = session.moveSelf('right');
		await Promise.resolve();
		expect(session.prepareTerminalExit(selfPubkey)).toEqual({ kind: 'unavailable', reason: 'missing-position' });
		authorization.resolve('authorized');
		expect(await movement).toEqual({ kind: 'unavailable' });
		expect(publish).not.toHaveBeenCalled();
	});

	it('bounds planner inputs while processing 100 successive self position seconds', async () => {
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start();
		session.completeBootstrap();
		vi.mocked(reconstructPositionPublishState).mockClear();
		for (let second = 700; second < 800; second += 1) {
			vi.setSystemTime(second * 1000);
			input!.onLiveWorldState(position(`self-${second}`, second, selfPubkey));
		}
		const calls = vi.mocked(reconstructPositionPublishState).mock.calls;
		expect(calls).toHaveLength(100);
		expect(Math.max(...calls.map(([events]) => events.length))).toBeLessThanOrEqual(2);
		expect(calls.reduce((sum, [events]) => sum + events.length, 0)).toBeLessThanOrEqual(200);
		const state = vi.mocked(reconstructPositionPublishState).mock.results.at(-1)!.value;
		expect(planPositionPublish(state, 799)).toMatchObject({ kind: 'available', slot: 1 });
		expect(planPositionPublish(state, 798)).toEqual({ kind: 'unavailable', reason: 'clock-regressed' });
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		await expect(session.moveSelf('right')).resolves.toMatchObject({ kind: 'succeeded' });
		expect(parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))?.slot).toBe(1);
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

		expect(input).toMatchObject({ messageSince: 40, worldStateSince: 40 });
		expect(bootstrap.presence.participants).toEqual([
			{ id: alice, position: { x: 2, y: 1 }, lastActivityAt: 700_000, status: 'active' }
		]);
		expect(presences.at(-1)).toBe(1);
		expect(publish).not.toHaveBeenCalled();
	});

	it('promotes a completed anonymous session without restarting its transport', async () => {
		const promotedSecret = selfSecretKey.slice();
		const promotedPubkey = selfPubkey;
		result = startResult([], [position('promoted-slot-0', 700, promotedPubkey, 0)]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const startRealtime = vi.fn().mockResolvedValue({ status: 'active', events: [], relays: [] });
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return result; }),
			startRealtime,
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn(),
			realtime: {
				registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
				controlSince: 0, instanceFilters: [], startImmediately: false, onEvent: vi.fn()
			}
		});
		await session.start();
		session.completeBootstrap();
		await session.attachSelf({
			signer: selfSigner(),
			authorizeSelfWrite: vi.fn().mockResolvedValue('authorized')
		});
		await expect(session.moveSelf('right')).resolves.toMatchObject({ kind: 'succeeded' });
		expect(parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))?.slot).toBe(1);
		expect(startRealtime).toHaveBeenCalledOnce();
		expect(mocked.createTransport.mock.results).toHaveLength(1);
		expect(dispose).not.toHaveBeenCalled();
	});

	it('does not wait for delayed Trace promotion before attaching self', async () => {
		const traceRoots = deferred<{ rawEvents: readonly never[]; relays: readonly never[] }>();
		const startRealtime = vi.fn().mockResolvedValue({ status: 'active', events: [], relays: [] });
		const configureTraceReplies = vi.fn().mockResolvedValue({ status: 'active', initialBatch: { events: [], relays: [] } });
		result = startResult([], [position('promoted-slot-0', 700, selfPubkey, 0)]);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return result; }),
			startRealtime,
			bootstrapTraceRootCandidates: vi.fn(() => traceRoots.promise),
			configureTraceReplies,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn(),
			realtime: {
				registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
				controlSince: 0, instanceFilters: [], startImmediately: false, onEvent: vi.fn()
			}
		});
		await session.start();
		session.completeBootstrap();
		await expect(session.attachSelf({ signer: selfSigner(), authorizeSelfWrite: vi.fn().mockResolvedValue('authorized') })).resolves.toBeUndefined();
		expect(startRealtime).not.toHaveBeenCalled();
		await expect(session.enterSelf()).resolves.toMatchObject({ kind: 'not-needed' });

		traceRoots.resolve({ rawEvents: [], relays: [] });
		await vi.waitFor(() => expect(startRealtime).toHaveBeenCalledOnce());
	});

	it('retains anonymous position evidence for a full same-second pair before promotion', async () => {
		const promotedSecret = selfSecretKey.slice();
		const promotedPubkey = selfPubkey;
		result = startResult([], [
			position('promoted-slot-0', 700, promotedPubkey, 0),
			position('promoted-slot-1', 700, promotedPubkey, 1)
		]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start();
		session.completeBootstrap();
		await session.attachSelf({ signer: selfSigner() });
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'blocked' });
		expect(publish).not.toHaveBeenCalled();
	});

	it('emits final bootstrap presence before start resolves and orders canonical live callbacks', async () => {
		result = startResult([message('bootstrap-message', 700)]);
		const calls: string[] = [];
		const presences: PresenceState[] = [];
		const livePresences: PresenceState[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: (presence) => {
				calls.push('presence');
				presences.push(structuredClone(presence));
			},
			onLiveMessage: (_message, presence) => {
				calls.push('message');
				livePresences.push(structuredClone(presence));
			},
			onStatusChanged: vi.fn()
		});
		const bootstrap = await session.start().then((snapshot) => {
			calls.push('start-resolved');
			return snapshot;
		});
		expect(calls.slice(-2)).toEqual(['presence', 'start-resolved']);
		expect(presences.at(-1)).toEqual(bootstrap.presence);
		session.completeBootstrap();
		calls.length = 0;
		vi.setSystemTime(701_000);
		const live = { ...message('canonical-live', 701), position: { x: 3, y: 1 } };
		input!.onLiveMessage(live, raw(live));
		expect(calls).toEqual(['presence', 'message']);
		expect(livePresences.at(-1)).toEqual(presences.at(-1));
		expect(livePresences.at(-1)?.participants).toEqual([
			{ id: alice, position: { x: 3, y: 1 }, lastActivityAt: 701_000, status: 'active' }
		]);
		session.dispose();
	});

	it('keeps history in the timeline while excluding it from presence and recent bootstrap messages', async () => {
		const old = { ...message('old-history', 39), pubkey: 'b'.repeat(64), speechType: 'monologue' as const };
		const recent = message('recent-message', 40);
		result = startResult([old, recent]);
		const timeline = vi.fn();
		const presence = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: presence,
			onLiveMessage: vi.fn(),
			onTimelineMessage: timeline,
			onStatusChanged: vi.fn()
		});

		const bootstrap = await session.start();

		expect(bootstrap.messages).toEqual([recent]);
		expect(bootstrap.timelineMessages).toEqual([old, recent]);
		expect(bootstrap.presence.participants.map((participant) => participant.id)).toEqual([alice]);
		expect(timeline).not.toHaveBeenCalled();

		const oldReconnect = { ...old, id: 'old-history-reconnect' };
		input!.onLiveMessage(oldReconnect, raw(oldReconnect));
		input!.onLiveMessage(oldReconnect, raw(oldReconnect));
		session.completeBootstrap();

		expect(timeline).toHaveBeenCalledExactlyOnceWith(oldReconnect);
		 expect(session.refresh(700_000).participants.map((participant) => participant.id)).toEqual([alice]);
	});

	it('does not await trace restore or an unresolved trace bootstrap during primary start', async () => {
		let resolveRestore!: (roots: readonly ParsedWorldMessage[]) => void;
		mocked.reconcileTraceRootCache.mockImplementationOnce(() => new Promise((resolve) => { resolveRestore = resolve; }));
		const bootstrapTraceRootCandidates = vi.fn(() => new Promise<never>(() => {}));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return startResult();
			}),
			bootstrapTraceRootCandidates,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await expect(session.start()).resolves.toEqual(expect.objectContaining({ status: { kind: 'available' } }));
		expect(bootstrapTraceRootCandidates).toHaveBeenCalledOnce();
		resolveRestore([]);
	});

	it('reconciles cache restore and a partial trace bootstrap as supplemental snapshots', async () => {
		const cached = message('cached-root', 700);
		const network = message('network-root', 701);
		const onEffectiveTraceRootsChanged = vi.fn();
		mocked.reconcileTraceRootCache.mockImplementation(async ({ rawEvents }) =>
			rawEvents.length === 0 ? [cached] : [network]
		);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return startResult();
			}),
			bootstrapTraceRootCandidates: vi.fn().mockResolvedValue({ rawEvents: [raw(network)], relays: [{ status: 'timeout' }] }),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(),
			onEffectiveTraceRootsChanged, onStatusChanged: vi.fn()
		});

		await session.start();
		await vi.waitFor(() => expect(onEffectiveTraceRootsChanged).toHaveBeenCalledWith([network]));
		expect(onEffectiveTraceRootsChanged).toHaveBeenCalledWith([cached]);
		expect(session.getStatus()).toEqual({ kind: 'available' });
	});

	it('does not reconcile a timeline-only live history message', async () => {
		const bootstrapTraceRootCandidates = vi.fn(() => new Promise<never>(() => {}));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return startResult();
			}),
			bootstrapTraceRootCandidates,
			dispose,
			publish
		});
		const timeline = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(),
			onTimelineMessage: timeline, onStatusChanged: vi.fn()
		});

		await session.start();
		await Promise.resolve();
		mocked.reconcileTraceRootCache.mockClear();
		session.completeBootstrap();
		const history = message('live-history', 39);
		input!.onLiveMessage(history, raw(history));

		expect(timeline).toHaveBeenCalledWith(history);
		expect(mocked.reconcileTraceRootCache).not.toHaveBeenCalled();
	});

	it('keeps trace cache and bootstrap failures out of world connection status', async () => {
		const statuses: WorldReadConnectionStatus[] = [];
		mocked.reconcileTraceRootCache.mockRejectedValue(new Error('storage unavailable'));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return startResult();
			}),
			bootstrapTraceRootCandidates: vi.fn().mockRejectedValue(new Error('trace timeout')),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});

		await session.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(statuses).toEqual([{ kind: 'bootstrapping' }, { kind: 'available' }]);
	});

	it('does not notify late trace cache snapshots after disposal', async () => {
		let resolveRestore!: (roots: readonly ParsedWorldMessage[]) => void;
		const onEffectiveTraceRootsChanged = vi.fn();
		mocked.reconcileTraceRootCache.mockImplementationOnce(() => new Promise((resolve) => { resolveRestore = resolve; }));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return startResult();
			}),
			bootstrapTraceRootCandidates: vi.fn(() => new Promise<never>(() => {})),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(),
			onEffectiveTraceRootsChanged, onStatusChanged: vi.fn()
		});

		await session.start();
		session.dispose();
		resolveRestore([message('late-root', 700)]);
		await Promise.resolve();
		expect(onEffectiveTraceRootsChanged).not.toHaveBeenCalled();
	});

	it('reconciles an accepted local publish without a live echo', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		const bootstrapTraceRootCandidates = vi.fn(() => new Promise<never>(() => {}));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates,
			dispose,
			publish
		});
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(), onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await session.start();
		await Promise.resolve();
		mocked.reconcileTraceRootCache.mockClear();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'not-needed' });
		await expect(session.publishMessage('local trace candidate', 'normal')).resolves.toEqual(expect.objectContaining({ kind: 'succeeded' }));

		const signed = publish.mock.calls[0][0];
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalledWith(expect.objectContaining({ rawEvents: [signed] })));
	});

	it('does not reconcile a self publish twice when its live echo arrives first', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		let resolvePublish!: (value: readonly { relayUrl: string; outcome: 'accepted' }[]) => void;
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: vi.fn(() => new Promise<never>(() => {})),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(), onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await session.start();
		await Promise.resolve();
		mocked.reconcileTraceRootCache.mockClear();
		session.completeBootstrap();
		await session.enterSelf();
		const pending = session.publishMessage('echo first', 'normal');
		await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
		const signed = publish.mock.calls[0][0] as VerifiedEvent;
		const echoed = parseWorldMessage(signed, 'c'.repeat(64))!;
		input!.onLiveMessage(echoed, signed as never);
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalledTimes(1));
		resolvePublish([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);

		await expect(pending).resolves.toEqual({ kind: 'succeeded', eventId: echoed.id });
		expect(mocked.reconcileTraceRootCache).toHaveBeenCalledTimes(1);
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
				nextInput.onLiveMessage(liveMessage, raw(liveMessage));
				nextInput.onLiveWorldState(livePosition);
				return startResult();
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
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
		result = startResult([message('valid-before-terminal', 700)], [], Array(10).fill('closed'));
		const statuses: WorldReadConnectionStatus[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: (status) => statuses.push(status)
		});

		const bootstrap = await session.start();

		expect(bootstrap.status).toEqual({ kind: 'degraded', issueCount: 10 });
		expect(statuses.at(-1)).toEqual({ kind: 'degraded', issueCount: 10 });
		expect(bootstrap.presence.participants.map((participant) => participant.id)).toEqual([alice]);
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
		const afterDispose = message('after-dispose', 701);
		input!.onLiveMessage(afterDispose, raw(afterDispose));
		expect(live).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('flushes buffered occupancy before selecting an entry cell', async () => {
		const occupied = position('occupied', 700, alice, 0, { x: 0, y: 0 });
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onLiveWorldState(occupied);
				return startResult();
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 2, rows: 1 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		const event = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).toEqual({ x: 1, y: 0 });
	});

	it('keeps an active bootstrap self at its recovered position without another entry event', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'not-needed' });
		expect(publish).not.toHaveBeenCalled();
	});

	it('replaces an active bootstrap self on the terminal cell with a non-blocked entry publication', async () => {
		result = startResult([], [position('self-at-terminal', 700, selfPubkey, 0, { x: 12, y: 3 })]);
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 16, rows: 8 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		const event = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).not.toEqual({ x: 12, y: 3 });
	});

	it('uses the retained cell for the first post-timeout reactivation', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		vi.setSystemTime(700_000 + PRESENCE_TIMEOUT_MS);
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'succeeded', operation: 'reactivation' });
		const event = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).toEqual({ x: 2, y: 1 });
	});

	it('applies a handoff event once when its live echo arrives before no-response completion', async () => {
		let resolvePublish: (results: readonly { relayUrl: string; outcome: 'no-response' }[]) => void;
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		const pending = session.enterSelf();
		await Promise.resolve();
		const echoed = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		input!.onLiveWorldState(echoed);
		input!.onLiveWorldState(echoed);
		resolvePublish!([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);

		await expect(pending).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		expect(session.refresh(700_000).participants.filter((participant) => participant.id === selfPubkey)).toEqual([
			expect.objectContaining({ position: echoed.position, status: 'active' })
		]);
		expect(writeStates.at(-1)).toBe('succeeded');
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		vi.setSystemTime(700_250);
		await expect(session.moveSelf(echoed.position.x < 3 ? 'right' : 'left')).resolves.toMatchObject({ kind: 'succeeded' });
		expect(parseWorldStateEvent(publish.mock.calls[1][0], 'c'.repeat(64))?.slot).toBe(1);
	});

	it('settles a retryable no-response operation when its matching live echo arrives later', async () => {
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		const presenceChanged = vi.fn();
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: presenceChanged,
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		const echoed = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		const beforeEcho = presenceChanged.mock.calls.length;
		input!.onLiveWorldState(echoed);
		input!.onLiveWorldState(echoed);

		expect(presenceChanged).toHaveBeenCalledTimes(beforeEcho + 1);
		expect(session.refresh(700_000).participants).toEqual([
			expect.objectContaining({ id: selfPubkey, position: echoed.position, status: 'active' })
		]);
		expect(writeStates.at(-1)).toBe('succeeded');
	});

	it('settles a retryable publish exception when its matching live echo arrives later', async () => {
		publish.mockRejectedValueOnce(new Error('publish failed'));
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		input!.onLiveWorldState(parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!);

		expect(writeStates.at(-1)).toBe('succeeded');
	});

	it('does not let an old retryable echo overwrite a newer pending operation state', async () => {
		let resolvePublish!: (results: readonly { relayUrl: string; outcome: 'accepted' }[]) => void;
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		publish
			.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }])
			.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'retryable', operation: 'movement' });
		const oldEcho = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		vi.setSystemTime(701_000);
		const newerPending = session.moveSelf('down');
		await Promise.resolve();
		input!.onLiveWorldState(oldEcho);

		expect(writeStates.at(-1)).toBe('pending');
		resolvePublish([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		await expect(newerPending).resolves.toEqual({ kind: 'succeeded', operation: 'movement' });
	});

	it('does not let an old retryable echo overwrite a newer succeeded operation state', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		publish
			.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }])
			.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const writeStates: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfPositionWriteStateChanged: (state) => writeStates.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'retryable', operation: 'movement' });
		const oldEcho = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		vi.setSystemTime(701_000);
		await expect(session.moveSelf('down')).resolves.toEqual({ kind: 'succeeded', operation: 'movement' });
		const newer = parseWorldStateEvent(publish.mock.calls[1][0], 'c'.repeat(64))!;
		const beforeOldEcho = writeStates.length;
		input!.onLiveWorldState(oldEcho);

		expect(writeStates).toHaveLength(beforeOldEcho);
		expect(session.refresh(701_000).participants).toEqual([
			expect.objectContaining({ id: selfPubkey, position: newer.position, status: 'active' })
		]);
	});

	it('does not double-apply an echo that arrives before accepted completion', async () => {
		let resolvePublish: (results: readonly { relayUrl: string; outcome: 'accepted' }[]) => void;
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const presenceChanged = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: presenceChanged,
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		const pending = session.enterSelf();
		await Promise.resolve();
		const echoed = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		input!.onLiveWorldState(echoed);
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
			selfSigner: selfSigner(),
			onPresenceChanged: presenceChanged,
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		const echoed = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		const beforeEcho = presenceChanged.mock.calls.length;
		input!.onLiveWorldState(echoed);

		expect(presenceChanged).toHaveBeenCalledTimes(beforeEcho);
	});

	it('keeps a no-response slot consumed without advancing canonical presence', async () => {
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'retryable', operation: 'entry' });
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'blocked' });
		const first = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		const second = parseWorldStateEvent(publish.mock.calls[1][0], 'c'.repeat(64))!;
		expect([first.slot, second.slot]).toEqual([0, 1]);
		expect(session.refresh(700_000).participants.find((participant) => participant.id === selfPubkey)).toBeUndefined();
	});

	it('preserves newer exhausted planner state while an old retryable echo settles', async () => {
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});
		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toMatchObject({ kind: 'retryable' });
		const old = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))!;
		vi.setSystemTime(701_000);
		input!.onLiveWorldState(position('new-slot-1', 701, selfPubkey, 1));
		input!.onLiveWorldState(old);
		expect(session.getSelfPositionWriteState()).toMatchObject({ kind: 'succeeded' });
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'blocked' });
		expect(publish).toHaveBeenCalledTimes(1);
		const state = vi.mocked(reconstructPositionPublishState).mock.results.at(-1)!.value;
		expect(state).toEqual({ lastPublishSecond: 701, consumedSlots: 2 });
		expect(planPositionPublish(state, 700)).toEqual({ kind: 'unavailable', reason: 'clock-regressed' });
	});

	it.each(['slot-0', 'slot-1', 'two-slot-0', 'buffered-slot-1'] as const)(
		'retains %s evidence across progressive, final and buffered bootstrap handoff', async (scenario) => {
			const latest = position('latest', 700, selfPubkey, scenario === 'slot-1' ? 1 : 0);
			const older = position('older', 699, selfPubkey, 1);
			mocked.createTransport.mockReturnValue({
				start: vi.fn(async (nextInput) => {
					input = nextInput;
					input!.onBootstrapWorldState(older);
					input!.onBootstrapWorldState(latest);
					input!.onBootstrapWorldState({ ...latest });
					if (scenario === 'two-slot-0') input!.onBootstrapWorldState(position('distinct', 700, selfPubkey, 0));
					if (scenario === 'buffered-slot-1') input!.onLiveWorldState(position('buffered', 700, selfPubkey, 1));
					return startResult([], [older, { ...older }]);
				}),
				bootstrapTraceRootCandidates: traceBootstrap(), dispose, publish
			});
			publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
			const session = createWorldReadSession({
				field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
				onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
			});
			await session.start();
			await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'blocked' });
			session.completeBootstrap();
			const outcome = await session.moveSelf('right');
			if (scenario === 'slot-0') {
				expect(outcome).toMatchObject({ kind: 'succeeded' });
				expect(parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64))?.slot).toBe(1);
			} else {
				expect(outcome).toEqual({ kind: 'blocked' });
				expect(publish).not.toHaveBeenCalled();
			}
		}
	);

	it('reconstructs a reloaded planner from bootstrap position evidence, not an earlier session attempt', async () => {
		result = startResult([], [position('bootstrap-slot-0', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'succeeded', operation: 'movement' });
		const event = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.slot).toBe(1);
	});

	it('blocks a message when bootstrap evidence exists but this session has not confirmed entry', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.publishMessage('before entry', 'normal')).resolves.toEqual({ kind: 'blocked' });
		expect(publish).not.toHaveBeenCalled();
		expect(session.getSelfMessageAvailability()).toEqual({ kind: 'unavailable' });
	});

	it('publishes a canonical normal message at the active self position without a position event', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const live = vi.fn();
		const timeline = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: live,
			onTimelineMessage: timeline,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.publishMessage('hello #ignored', 'normal')).resolves.toEqual({
			kind: 'succeeded',
			eventId: expect.any(String)
		});
		const event = publish.mock.calls[0][0];
		const parsed = parseWorldMessage(event, 'c'.repeat(64));

		expect(event.kind).toBe(42);
		expect(event.tags).toEqual([
			['e', 'c'.repeat(64), 'wss://relay.test/', 'root'],
			['L', 'io.github.lokuyow.persona-bubble-field'],
			['l', 'chat', 'io.github.lokuyow.persona-bubble-field'],
			['w', '2:1']
		]);
		expect(parsed).toMatchObject({ content: 'hello #ignored', speechType: 'normal', position: { x: 2, y: 1 } });
		expect(live).toHaveBeenCalledTimes(1);
		expect(timeline).toHaveBeenCalledWith(expect.objectContaining({
			id: parsed?.id,
			content: 'hello #ignored',
			speechType: 'normal'
		}));
	});

	it.each([
		['shout', ['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']],
		['monologue', ['l', 'speech:monologue', 'io.github.lokuyow.persona-bubble-field']]
	] as const)('publishes a canonical %s speech type through kind 42', async (speechType, speechLabel) => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const timeline = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onTimelineMessage: timeline,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.publishMessage('typed message', speechType)).resolves.toEqual({
			kind: 'succeeded',
			eventId: expect.any(String)
		});

		const event = publish.mock.calls[0][0];
		expect(event.kind).toBe(42);
		expect(event.tags).toContainEqual(speechLabel);
		expect(parseWorldMessage(event, 'c'.repeat(64))).toMatchObject({
			content: 'typed message',
			speechType
		});
		expect(timeline).toHaveBeenCalledWith(expect.objectContaining({
			content: 'typed message',
			speechType
		}));
	});

	it('accepts the canonical duplicate prefix for a normal message', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'rejected', notice: 'duplicate: already have event' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();

		await expect(session.publishMessage('duplicate', 'normal')).resolves.toEqual({ kind: 'succeeded', eventId: expect.any(String) });
	});

	it('reactivates an entered self through a message and records the reallocated w position', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		vi.setSystemTime(700_000 + PRESENCE_TIMEOUT_MS);
		input!.onLiveWorldState(position('occupied', 700 + PRESENCE_TIMEOUT_MS / 1000, alice, 0, { x: 2, y: 1 }));
		await expect(session.publishMessage('back', 'normal')).resolves.toEqual({ kind: 'succeeded', eventId: expect.any(String) });
		const parsed = parseWorldMessage(publish.mock.calls[0][0], 'c'.repeat(64));

		expect(parsed?.position).not.toEqual({ x: 2, y: 1 });
		expect(session.refresh(700_000 + PRESENCE_TIMEOUT_MS).participants).toContainEqual(
			expect.objectContaining({ id: selfPubkey, position: parsed?.position, status: 'active' })
		);
	});

	it('treats a matching live echo before a non-authoritative publish completion as message success once', async () => {
		let resolvePublish!: (results: readonly { relayUrl: string; outcome: 'no-response' }[]) => void;
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const live = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: live,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		const pending = session.publishMessage('echo first', 'normal');
		await Promise.resolve();
		const echoed = parseWorldMessage(publish.mock.calls[0][0], 'c'.repeat(64))!;
		input!.onLiveMessage(echoed, raw(echoed));
		input!.onLiveMessage(echoed, raw(echoed));
		resolvePublish([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);

		await expect(pending).resolves.toEqual({ kind: 'succeeded', eventId: echoed.id });
		expect(live).toHaveBeenCalledTimes(1);
	});

	it('does not let a different live event confirm a pending self message', async () => {
		let resolvePublish!: (results: readonly { relayUrl: string; outcome: 'no-response' }[]) => void;
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockImplementationOnce(() => new Promise((resolve) => { resolvePublish = resolve; }));
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		const pending = session.publishMessage('waiting', 'normal');
		await Promise.resolve();
		const otherLive = { ...message('other-live', 700), pubkey: alice };
		input!.onLiveMessage(otherLive, raw(otherLive));
		resolvePublish([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]);

		await expect(pending).resolves.toEqual({ kind: 'retryable' });
	});

	it.each([
		['rejection', [{ relayUrl: 'wss://relay.test/', outcome: 'rejected', notice: 'blocked: denied' }]],
		['no response', [{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }]]
	] as const)('does not canonically apply a message after %s without a matching echo', async (_name, results) => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 2, y: 1 })]);
		publish.mockResolvedValueOnce(results);
		const live = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: live,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await session.enterSelf();
		await expect(session.publishMessage('not confirmed', 'normal')).resolves.toEqual({ kind: 'retryable' });

		expect(live).not.toHaveBeenCalled();
	});

	it('does not re-deliver a bootstrap message when its live duplicate is drained', async () => {
		const bootstrap = message('bootstrap-message', 700);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onLiveMessage(bootstrap, raw(bootstrap));
				return startResult([bootstrap]);
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		const live = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: vi.fn(),
			onLiveMessage: live,
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		input!.onLiveMessage(bootstrap, raw(bootstrap));

		expect(live).not.toHaveBeenCalled();
	});

	it('keeps message publishing available when movement is retryable', async () => {
		result = startResult([], [position('self-bootstrap', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		publish
			.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'no-response' }])
			.mockResolvedValueOnce([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const availability: string[] = [];
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfMessageAvailabilityChanged: (state) => availability.push(state.kind)
		});

		await session.start();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'not-needed' });
		await expect(session.moveSelf('right')).resolves.toEqual({ kind: 'retryable', operation: 'movement' });
		await expect(session.publishMessage('still available', 'normal')).resolves.toEqual(expect.objectContaining({ kind: 'succeeded' }));
		expect(availability).toEqual(['ready']);
	});

	it('projects verified bootstrap evidence before canonical completion without replaying it as conversation', async () => {
		const bootstrapMessage = message('progressive-message', 700);
		const bootstrapPosition = position('progressive-position', 700);
		const progressiveParticipantCounts: number[] = [];
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onBootstrapMessage(bootstrapMessage);
				nextInput.onBootstrapWorldState(bootstrapPosition);
				nextInput.onLiveMessage(bootstrapMessage, raw(bootstrapMessage));
				return startResult([bootstrapMessage], [bootstrapPosition]);
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		const live = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			onPresenceChanged: (presence) => progressiveParticipantCounts.push(presence.participants.length),
			onLiveMessage: live,
			onStatusChanged: vi.fn()
		});

		const bootstrap = await session.start();

		expect(progressiveParticipantCounts).toContain(1);
		expect(bootstrap.presence.participants).toEqual([
			expect.objectContaining({ id: alice, position: { x: 2, y: 1 } })
		]);
		expect(live).not.toHaveBeenCalled();
		session.completeBootstrap();
		expect(live).not.toHaveBeenCalled();
	});

	it('does not select a self entry cell from partial bootstrap presence', async () => {
		const occupied = position('bootstrap-occupied', 700, alice, 0, { x: 0, y: 0 });
		result = startResult([], [occupied]);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onBootstrapWorldState(occupied);
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		publish.mockResolvedValue([{ relayUrl: 'wss://relay.test/', outcome: 'accepted' }]);
		const session = createWorldReadSession({
			field: { columns: 2, rows: 1 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn()
		});

		await session.start();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'blocked' });
		expect(publish).not.toHaveBeenCalled();
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'succeeded', operation: 'entry' });
		const event = parseWorldStateEvent(publish.mock.calls[0][0], 'c'.repeat(64));
		expect(event?.position).toEqual({ x: 1, y: 0 });
	});

	it('keeps returning self evidence visible before canonical entry without enabling messages', async () => {
		const recovered = position('returning-self', 700, selfPubkey, 0, { x: 2, y: 1 });
		result = startResult([], [recovered]);
		const availability: string[] = [];
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				nextInput.onBootstrapWorldState(recovered);
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onStatusChanged: vi.fn(),
			onSelfMessageAvailabilityChanged: (state) => availability.push(state.kind)
		});

		await session.start();
		expect(session.refresh(700_000).participants).toEqual([
			expect.objectContaining({ id: selfPubkey, position: { x: 2, y: 1 } })
		]);
		expect(availability).toEqual([]);
		await expect(session.publishMessage('too early', 'normal')).resolves.toEqual({ kind: 'blocked' });
		session.completeBootstrap();
		await expect(session.enterSelf()).resolves.toEqual({ kind: 'not-needed' });
		expect(availability).toEqual(['ready']);
	});

	it('scopes every cached reply handoff to the open root across restore, initial, batch, and live paths', async () => {
		const root = { ...message('trace-root', 700), pubkey: 'b'.repeat(64), position: { x: 1, y: 1 } };
		const otherRoot = { ...message('other-trace-root', 699), pubkey: 'c'.repeat(64), position: { x: 2, y: 1 } };
		const cachedReply = traceReply('cached-reply', root);
		const refreshedReply = traceReply('refreshed-reply', root, 702);
		const otherReply = traceReply('other-cached-reply', otherRoot);
		let resolveTraceBootstrap!: (value: { rawEvents: readonly never[]; relays: readonly never[] }) => void;
		let resolveConfiguration!: (value: never) => void;
		const configureTraceReplies = vi.fn((_configuration: TraceReplyConfiguration) =>
			new Promise((resolve) => { resolveConfiguration = resolve; })
		);
		mocked.reconcileTraceRootCache.mockResolvedValue([root, otherRoot]);
		mocked.reconcileTraceReplyCache.mockImplementation(async ({ rawEvents }) =>
			rawEvents.length === 0
				? [cachedReply, otherReply]
				: [cachedReply, refreshedReply, otherReply]
		);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: vi.fn(() => new Promise((resolve) => { resolveTraceBootstrap = resolve; })),
			configureTraceReplies,
			dispose,
			publish
		});
		const states: unknown[] = [];
		const rootsChanged = vi.fn();
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 },
			selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(),
			onLiveMessage: vi.fn(),
			onEffectiveTraceRootsChanged: rootsChanged,
			onTraceConversationChanged: (state) => states.push(state),
			onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await vi.waitFor(() => expect(rootsChanged).toHaveBeenCalledWith([root, otherRoot]));
		expect(session.openTraceConversation({ rootId: root.id, currentId: root.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', replies: [cachedReply], replyRefresh: 'loading'
		})));
		expect(configureTraceReplies).not.toHaveBeenCalled();
		expect(mocked.touchTraceReplyTree).toHaveBeenCalledWith({ channelId: 'c'.repeat(64), rootId: root.id });

		resolveTraceBootstrap({ rawEvents: [raw(root)], relays: [] });
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledWith(expect.objectContaining({
			conversation: { rootId: root.id, currentId: root.id }
		})));
		resolveConfiguration({
			status: 'active',
			generation: 1,
			initialBatch: { events: [{ id: 'raw-reply' }], relays: [] }
		} as never);
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', replies: [cachedReply, refreshedReply], replyRefresh: 'settled'
		})));
		const configuration = configureTraceReplies.mock.calls[0][0];
		configuration.onBatch({ events: [{ id: 'batch-reply' } as never], relays: [] });
		await vi.waitFor(() => expect(mocked.reconcileTraceReplyCache).toHaveBeenCalledTimes(3));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', replies: [cachedReply, refreshedReply]
		}));
		configuration.onLiveEvent({ id: 'live-reply' } as never);
		await vi.waitFor(() => expect(mocked.reconcileTraceReplyCache).toHaveBeenCalledTimes(4));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', replies: [cachedReply, refreshedReply]
		}));
		expect(states).toContainEqual(expect.objectContaining({ kind: 'open', replies: [cachedReply], replyRefresh: 'loading' }));
		expect(states.filter((state): state is { kind: 'open'; replies: readonly ParsedTraceReply[] } =>
			typeof state === 'object' && state !== null && 'kind' in state && state.kind === 'open'
		).every((state) => state.replies.every((reply) => reply.rootId === root.id))).toBe(true);
	});

	it('protects the current root when an old generation starts cache reconciliation after a switch', async () => {
		const rootA = { ...message('trace-root-a', 700), pubkey: 'b'.repeat(64), position: { x: 1, y: 1 } };
		const rootB = { ...message('trace-root-b', 701), pubkey: 'c'.repeat(64), position: { x: 1, y: 1 } };
		const replyA = traceReply('reply-a', rootA);
		const replyB = traceReply('reply-b', rootB);
		const blockingBatchId = 'blocking-a-batch';
		const blockingBatch = { id: blockingBatchId } as never;
		const oldLiveEvent = { id: 'old-a-live' } as never;
		let releaseBlockingBatch!: () => void;
		const blockingBatchDone = new Promise<void>((resolve) => { releaseBlockingBatch = resolve; });
		mocked.reconcileTraceRootCache.mockResolvedValue([rootB, rootA]);
		mocked.reconcileTraceReplyCache.mockImplementation(async ({ rawEvents }) => {
			if (rawEvents[0]?.id === blockingBatchId) await blockingBatchDone;
			return [replyA, replyB];
		});
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		let rootAConfiguration!: TraceReplyConfiguration;
		const configureTraceReplies = vi.fn((configuration: TraceReplyConfiguration) => {
			if (configuration.conversation?.rootId === rootA.id) {
				rootAConfiguration = configuration;
				return Promise.resolve({
					status: 'active' as const,
					generation: 1,
					initialBatch: { events: [], relays: [] }
				});
			}
			return new Promise<never>(() => {});
		});
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			configureTraceReplies,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalled());
		expect(session.openTraceConversation({ rootId: rootA.id, currentId: rootA.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			root: rootA,
			replies: [replyA],
			replyRefresh: 'settled'
		})));

		rootAConfiguration.onBatch({ events: [blockingBatch], relays: [] });
		await vi.waitFor(() => expect(mocked.reconcileTraceReplyCache).toHaveBeenCalledWith(expect.objectContaining({
			rawEvents: [blockingBatch]
		})));
		rootAConfiguration.onLiveEvent(oldLiveEvent);
		expect(session.openTraceConversation({ rootId: rootB.id, currentId: rootB.id })).toEqual({ kind: 'opened' });

		releaseBlockingBatch();
		await vi.waitFor(() => expect(mocked.reconcileTraceReplyCache).toHaveBeenCalledWith(expect.objectContaining({
			rawEvents: [oldLiveEvent],
			currentOpenRootId: rootB.id
		})));
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			root: rootB,
			replies: [replyB]
		})));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({ root: rootB, replies: [replyB] }));
	});

	it('switches only to adjacent accepted speech while preserving the snapshot and rejecting stale callbacks', async () => {
		const root = { ...message('trace-root', 700), pubkey: 'b'.repeat(64), position: { x: 1, y: 1 } };
		const child = traceReply('child', root, 701, { position: { x: 0, y: 1 } });
		const sibling = traceReply('sibling', root, 700, { position: { x: 1, y: 2 } });
		const grandchild = traceReply('grandchild', root, 702, {
			parent: child,
			position: { x: 0, y: 2 }
		});
		const replies = [grandchild, child, sibling];
		const configurations: TraceReplyConfiguration[] = [];
		mocked.reconcileTraceRootCache.mockResolvedValue([root]);
		mocked.reconcileTraceReplyCache.mockResolvedValue(replies);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		const configureTraceReplies = vi.fn((configuration: TraceReplyConfiguration) => {
			configurations.push(configuration);
			return Promise.resolve({
				status: 'active' as const,
				generation: configurations.length,
				initialBatch: { events: [], relays: [] }
			});
		});
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			configureTraceReplies,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalled());
		expect(session.openTraceConversation({ rootId: root.id, currentId: child.id })).toEqual({ kind: 'blocked' });
		expect(session.openTraceConversation({ rootId: root.id, currentId: root.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', config: { rootId: root.id, currentId: root.id }, replies, replyRefresh: 'settled'
		})));

		expect(session.selectTraceConversationSpeech(grandchild.id)).toEqual({ kind: 'blocked' });
		expect(session.selectTraceConversationSpeech('unknown')).toEqual({ kind: 'blocked' });
		expect(session.selectTraceConversationSpeech(child.id)).toEqual({ kind: 'opened' });
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', config: { rootId: root.id, currentId: child.id }, replies, replyRefresh: 'loading'
		}));
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			kind: 'open', config: { rootId: root.id, currentId: child.id }, replies, replyRefresh: 'settled'
		})));
		expect(configurations.at(-1)?.conversation).toEqual({ rootId: root.id, currentId: child.id });
		expect(session.openTraceConversation({ rootId: root.id, currentId: root.id })).toEqual({ kind: 'blocked' });
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			config: { rootId: root.id, currentId: child.id }, replies
		}));
		expect(session.selectTraceConversationSpeech(sibling.id)).toEqual({ kind: 'blocked' });

		configurations[0].onBatch({ events: [{ id: 'late-root-batch' } as never], relays: [] });
		configurations[0].onLiveEvent({ id: 'late-root-live' } as never);
		await vi.waitFor(() => expect(mocked.reconcileTraceReplyCache).toHaveBeenCalledWith(expect.objectContaining({
			rawEvents: [{ id: 'late-root-live' }]
		})));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			config: { rootId: root.id, currentId: child.id }, replies
		}));

		expect(session.selectTraceConversationSpeech(grandchild.id)).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(configurations.at(-1)?.conversation).toEqual({
			rootId: root.id,
			currentId: grandchild.id
		}));
		expect(session.selectTraceConversationSpeech(child.id)).toEqual({ kind: 'opened' });
		expect(session.selectTraceConversationSpeech(root.id)).toEqual({ kind: 'opened' });
		input!.onLiveWorldState(position('self-moved-away', 703, selfPubkey, 1, { x: 3, y: 2 }));
		const beforeBlockedSelection = session.getTraceConversationState();
		expect(session.selectTraceConversationSpeech(child.id)).toEqual({ kind: 'blocked' });
		expect(session.getTraceConversationState()).toEqual(beforeBlockedSelection);
	});

	it('reconciles an open root to a death root without starting its reply conversation', async () => {
		const newest = { ...deathRoot('newest-death-root'), createdAt: 701, pubkey: 'b'.repeat(64), position: { x: 1, y: 1 } };
		const older = { ...message('older-root', 700), pubkey: 'c'.repeat(64), position: { x: 1, y: 1 } };
		mocked.reconcileTraceRootCache.mockResolvedValue([older]);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		const configureTraceReplies = vi.fn().mockResolvedValue({
			status: 'active', generation: 1, initialBatch: { events: [], relays: [] }
		});
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => {
				input = nextInput;
				return result;
			}),
			bootstrapTraceRootCandidates: traceBootstrap(),
			configureTraceReplies,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn()
		});

		await session.start();
		session.completeBootstrap();
		await vi.waitFor(() => expect(mocked.reconcileTraceRootCache).toHaveBeenCalled());
		expect(session.openTraceConversation({ rootId: older.id, currentId: older.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledTimes(1));
		mocked.reconcileTraceRootCache.mockResolvedValue([newest]);
		input!.onLiveTrace({ id: newest.id, source: 'death' }, raw(newest));
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({ root: newest })));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({ root: newest, config: { rootId: newest.id, currentId: newest.id } }));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({ replyRefresh: 'settled', replies: [] }));
		expect(publish).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledTimes(2));
		expect(configureTraceReplies.mock.calls[1][0]).not.toHaveProperty('conversation');
		expect(configureTraceReplies.mock.calls[1][0]).not.toHaveProperty('rootId');
		expect(configureTraceReplies.mock.calls[1][0]).not.toHaveProperty('currentId');
		session.closeTraceConversation();
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledTimes(3));
		expect(configureTraceReplies.mock.calls[2][0]).not.toHaveProperty('conversation');
	});

	it('restores realtime when a stale normal conversation loses the race to death activation', async () => {
		const normal = { ...message('normal-race-root', 700), position: { x: 1, y: 1 } };
		const death = deathRoot('death-race-root');
		mocked.reconcileTraceRootCache.mockResolvedValue([normal]);
		result = startResult([], [position('self-position', 700, selfPubkey, 0, { x: 1, y: 1 })]);
		const oldConversation = deferred<TraceReplyConfigurationResult>();
		const deathConfiguration = deferred<TraceReplyConfigurationResult>();
		const configureTraceReplies = vi.fn((configuration: TraceReplyConfiguration) =>
			configuration.conversation ? oldConversation.promise : deathConfiguration.promise
		);
		const startRealtime = vi.fn().mockResolvedValue({ status: 'active', events: [], relays: [] });
		const stopRealtime = vi.fn();
		mocked.createTransport.mockReturnValue({
			start: vi.fn(async (nextInput) => { input = nextInput; return result; }),
			bootstrapTraceRootCandidates: traceBootstrap(),
			configureTraceReplies,
			startRealtime,
			stopRealtime,
			dispose,
			publish
		});
		const session = createWorldReadSession({
			field: { columns: 4, rows: 3 }, selfSigner: selfSigner(),
			onPresenceChanged: vi.fn(), onLiveMessage: vi.fn(), onStatusChanged: vi.fn(),
			realtime: {
				registry: [{ eventType: 'fixture', protocolVersion: 1, protocolKey: protocolKeyFor('fixture', 1), parseAction: () => ({}) }],
				controlSince: 0,
				instanceFilters: [{ protocolKey: protocolKeyFor('fixture', 1), instanceIds: ['fixture-instance'], since: 0 }],
				startImmediately: false,
				onEvent: vi.fn()
			}
		});

		await session.start();
		session.completeBootstrap();
		await session.startRealtime();
		expect(startRealtime).toHaveBeenCalledOnce();
		expect(session.openTraceConversation({ rootId: normal.id, currentId: normal.id })).toEqual({ kind: 'opened' });
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledTimes(1));
		expect(stopRealtime).toHaveBeenCalledOnce();

		mocked.reconcileTraceRootCache.mockResolvedValue([death]);
		input!.onLiveTrace({ id: death.id, source: 'death' }, raw(death));
		await vi.waitFor(() => expect(session.getTraceConversationState()).toEqual(expect.objectContaining({
			root: death, replyRefresh: 'settled', replies: []
		})));
		await vi.waitFor(() => expect(configureTraceReplies).toHaveBeenCalledTimes(2));
		expect(configureTraceReplies.mock.calls[1][0]).not.toHaveProperty('conversation');
		expect(configureTraceReplies.mock.calls.map(([configuration]) => configuration.conversation?.rootId))
			.toEqual([normal.id, undefined]);

		oldConversation.resolve({ status: 'superseded', generation: 1 });
		await Promise.resolve();
		expect(startRealtime).toHaveBeenCalledOnce();
		deathConfiguration.resolve({ status: 'active', generation: 2, initialBatch: { events: [], relays: [] } });
		await vi.waitFor(() => expect(startRealtime).toHaveBeenCalledTimes(2));
		expect(session.getTraceConversationState()).toEqual(expect.objectContaining({ root: death, replyRefresh: 'settled', replies: [] }));
	});
});
