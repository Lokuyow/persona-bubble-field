import { describe, expect, it, vi } from 'vitest';
import type { Event } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import {
	createOperatorRelayAdapter,
	type OperatorRelayPool
} from './operatorRelayAdapter';

type Scenario = 'eose' | 'closed' | 'connection-failure' | 'timeout' | 'manual';

function event(id: string): Event {
	return { id, pubkey: 'a'.repeat(64), created_at: 1, kind: 7070, tags: [], content: '{}', sig: 'b'.repeat(128) };
}

function fakePool(scenarios: Readonly<Record<string, Scenario>>) {
	const subscriptions = new Map<string, { close: ReturnType<typeof vi.fn> }>();
	const callbacks = new Map<string, { onevent: (value: Event) => void; oneose: () => void; onclose: (reason: string) => void }>();
	const pool = {
		ensureRelay: vi.fn(async (url: string) => ({
			subscribe: vi.fn((_filters: Filter[], params: { onevent: (value: Event) => void; oneose: () => void; onclose: (reason: string) => void }) => {
				const subscription = { close: vi.fn() };
				subscriptions.set(url, subscription);
				callbacks.set(url, params);
				queueMicrotask(() => {
					const scenario = scenarios[url];
					if (scenario === 'eose') params.oneose();
					else if (scenario === 'closed') params.onclose('blocked by policy');
					else if (scenario === 'connection-failure') params.onclose('relay connection failed');
				});
				return subscription;
			}),
			publish: vi.fn(async () => 'accepted')
		})),
		close: vi.fn(),
	} satisfies OperatorRelayPool;
	return { pool, subscriptions, callbacks };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('operator per-Relay finite read adapter', () => {
	it('counts only real EOSE when every Relay closes', async () => {
		const { pool } = fakePool({ a: 'closed', b: 'closed' });
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 20 });
		const result = await adapter.query({ kinds: [1] }, ['a', 'b']);
		expect(result.eoseCount).toBe(0);
		expect(result.relays.map((relay) => relay.status)).toEqual(['closed', 'closed']);
	});

	it('keeps EOSE success distinct from closed, failed, and timed out Relays', async () => {
		const { pool } = fakePool({ eose: 'eose', closed: 'closed', failed: 'connection-failure', timed: 'timeout' });
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 5 });
		const result = await adapter.query({ kinds: [1] }, ['eose', 'closed', 'failed', 'timed']);
		expect(result.eoseCount).toBe(1);
		expect(Object.fromEntries(result.relays.map((relay) => [relay.relayUrl, relay.status]))).toEqual({
			eose: 'eose', closed: 'closed', failed: 'connection-failure', timed: 'timeout'
		});
	});

	it('retains events received before EOSE and closes the query subscription', async () => {
		const { pool, subscriptions, callbacks } = fakePool({ relay: 'manual' });
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 20 });
		const pending = adapter.query({ kinds: [1] }, ['relay']);
		await settle();
		const params = callbacks.get('relay')!;
		params.onevent(event('event-1'));
		params.oneose();
		const result = await pending;
		expect(result.events.map((value) => value.id)).toEqual(['event-1']);
		expect(result.relays[0].status).toBe('eose');
		expect(subscriptions.get('relay')?.close).toHaveBeenCalled();
	});

	it('does not let a delayed callback rewrite a terminal timeout result', async () => {
		const close = vi.fn();
		let params: { onevent: (value: Event) => void; oneose: () => void; onclose: (reason: string) => void } | undefined;
		const pool = {
			ensureRelay: vi.fn(async () => ({ subscribe: vi.fn((_filters: Filter[], next) => { params = next; return { close }; }), publish: vi.fn(async () => 'accepted') })),
			close: vi.fn()
		} satisfies OperatorRelayPool;
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 2 });
		const pending = adapter.query({ kinds: [1] }, ['relay']);
		const result = await pending;
		params?.oneose();
		params?.onclose('late close');
		expect(result.relays[0].status).toBe('timeout');
		expect(result.eoseCount).toBe(0);
	});

	it('reuses the command-scoped pool across finite queries and closes it idempotently at command end', async () => {
		const { pool } = fakePool({ relay: 'eose' });
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 20 });
		await adapter.query({ kinds: [1] }, ['relay']);
		await adapter.query({ kinds: [2] }, ['relay']);
		expect(pool.close).not.toHaveBeenCalled();
		adapter.close();
		adapter.close();
		expect(pool.close).toHaveBeenCalledTimes(1);
		expect(pool.close).toHaveBeenCalledWith(['relay']);
		expect(pool).not.toHaveProperty('destroy');
	});

	it('distinguishes connection failure, rejection, timeout, acceptance, and partial success per Relay', async () => {
		const connection = (publish: () => Promise<string>) => ({
			subscribe: vi.fn(() => ({ close: vi.fn() })),
			publish: vi.fn(publish)
		});
		const accepted = connection(async () => 'accepted');
		const rejected = connection(async () => { throw new Error('\u001b[31mconnection policy rejection\u001b]0;x\u0007'); });
		const timedOut = connection(async () => { throw new Error('publish timed out'); });
		const failed = connection(async () => { throw new Error('socket closed'); });
		const pool = {
			ensureRelay: vi.fn(async (url: string) => {
				if (url === 'connect-failed') throw new Error('cannot connect');
				return ({ 'accepted': accepted, 'rejected': rejected, 'timed-out': timedOut, 'failed': failed } as Record<string, typeof accepted>)[url];
			}),
			close: vi.fn()
		} satisfies OperatorRelayPool;
		const adapter = createOperatorRelayAdapter({ poolFactory: () => pool, operationTimeoutMs: 20 });
		const result = await adapter.publish(event('publish-event') as never, ['accepted', 'rejected', 'timed-out', 'failed', 'connect-failed']);
		expect(Object.fromEntries(result.map((value) => [value.relayUrl, value.outcome]))).toEqual({
			accepted: 'accepted', rejected: 'rejected', 'timed-out': 'timeout', failed: 'connection-failure', 'connect-failed': 'connection-failure'
		});
		expect(result.find((value) => value.relayUrl === 'rejected')?.notice).toContain('connection policy rejection');
	});
});
