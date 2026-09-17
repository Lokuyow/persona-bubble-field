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
			})
		})),
		close: vi.fn(),
		publish: vi.fn(() => [Promise.resolve('ok')])
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
			ensureRelay: vi.fn(async () => ({ subscribe: vi.fn((_filters: Filter[], next) => { params = next; return { close }; }) })),
			close: vi.fn(),
			publish: vi.fn(() => [Promise.resolve('ok')])
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
});
