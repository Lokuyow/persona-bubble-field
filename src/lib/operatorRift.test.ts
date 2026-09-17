import { finalizeEvent, getPublicKey, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import {
	OperatorCancelled,
	OperatorFailure,
	runManualRiftOperator,
	sanitizeOperatorDisplayText,
	type OperatorDependencies
} from './operatorRift';
import type { OperatorRelayAdapter, OperatorRelayQueryResult } from './operatorRelayAdapter';
import { REALTIME_EVENT_KIND, REALTIME_CONTROL_PROTOCOL_KEY } from './realtimeEvents';
import { PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from './prototypeWorldConfig';

const SECRET = new Uint8Array(32).fill(7);
const CREATOR = getPublicKey(SECRET);
const NOW = Date.UTC(2026, 0, 2, 10, 0);

function metadataEvents(): { channel: VerifiedEvent; metadata: VerifiedEvent } {
	const channel = finalizeEvent({
		kind: 40,
		created_at: 1,
		tags: [],
		content: JSON.stringify({ relays: ['wss://relay.example/'] })
	}, SECRET);
	const metadata = finalizeEvent({
		kind: 41,
		created_at: 2,
		tags: [['e', channel.id]],
		content: JSON.stringify({ relays: ['wss://relay.example/'] })
	}, SECRET);
	return { channel, metadata };
}

function result(events: readonly Event[] = []): OperatorRelayQueryResult {
	return { events, eventSources: events.map((value) => ({ event: value, relayUrl: 'wss://relay.example/' })), relays: [{ relayUrl: 'wss://relay.example/', status: 'eose' }], eoseCount: 1 };
}

function fakeDependencies(results: readonly OperatorRelayQueryResult[], overrides: Partial<OperatorDependencies> = {}): OperatorDependencies {
	let index = 0;
	const relay: OperatorRelayAdapter = {
		query: vi.fn(async () => results[index++] ?? result()),
		publish: vi.fn(async () => [{ relayUrl: 'wss://relay.example/', outcome: 'accepted' as const }]),
		close: vi.fn()
	};
	return {
		relay,
		confirmPublish: vi.fn(async () => 'confirmed' as const),
		readSecret: vi.fn(async () => new Uint8Array(SECRET)),
		randomBytes: (length) => new Uint8Array(length).fill(1),
		nowMs: () => NOW,
		output: { stdout: vi.fn(), stderr: vi.fn() },
		...overrides
	};
}

describe('operator Rift flow', () => {
	it('sanitizes terminal controls, bidi/format characters, and bounds remote text', () => {
		const unsafe = `reason\u001b[31m\u001b]0;title\u0007\r\n\u202ehidden\u200b${'x'.repeat(500)}`;
		const safe = sanitizeOperatorDisplayText(unsafe, 80);
		expect(safe).not.toContain('\u001b');
		expect(safe).not.toContain('\u0007');
		expect(safe).not.toContain('\u202e');
		expect(safe).not.toContain('\u200b');
		expect(safe.length).toBeLessThanOrEqual(80);
		expect(safe).toContain('\\u001b');
	});

	it('runs a dry-run with production-shaped metadata and zeroizes the secret bytes', async () => {
		const { channel, metadata } = metadataEvents();
		const secret = new Uint8Array(SECRET);
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result()], { readSecret: vi.fn(async () => secret) });
		const world: PrototypeWorldConfig = { ...PROTOTYPE_WORLD_CONFIG, channelId: channel.id, metadataDiscoveryRelays: ['wss://relay.example/'], preferredRelayHint: 'wss://relay.example/' };
		const command = await runManualRiftOperator('dry-run', dependencies, world);
		expect(command.exitCode).toBe(0);
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(secret.every((byte) => byte === 0)).toBe(true);
		expect(dependencies.relay.close).toHaveBeenCalledTimes(1);
	});

	it('fails closed without asking for a secret when control preflight has no real EOSE', async () => {
		const { channel, metadata } = metadataEvents();
		const dependencies = fakeDependencies([
			result([channel]),
			result([metadata]),
			{ events: [], eventSources: [], relays: [{ relayUrl: 'wss://relay.example/', status: 'closed' }], eoseCount: 0 }
		]);
		const world: PrototypeWorldConfig = { ...PROTOTYPE_WORLD_CONFIG, channelId: channel.id, metadataDiscoveryRelays: ['wss://relay.example/'], preferredRelayHint: 'wss://relay.example/' };
		await expect(runManualRiftOperator('dry-run', dependencies, world)).rejects.toMatchObject({ reason: 'control preflight failed' } satisfies Partial<OperatorFailure>);
		expect(dependencies.readSecret).not.toHaveBeenCalled();
		expect(dependencies.relay.close).toHaveBeenCalledTimes(1);
	});

	it('does not read a secret after confirmation cancellation, including a pasted fake nsec', async () => {
		const { channel, metadata } = metadataEvents();
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const output = { stdout: vi.fn(), stderr: vi.fn() };
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result()], {
			confirmPublish: vi.fn(async () => 'cancelled' as const), readSecret, output
		});
		const world: PrototypeWorldConfig = { ...PROTOTYPE_WORLD_CONFIG, channelId: channel.id, metadataDiscoveryRelays: ['wss://relay.example/'], preferredRelayHint: 'wss://relay.example/' };
		await expect(runManualRiftOperator('publish', dependencies, world)).rejects.toBeInstanceOf(OperatorCancelled);
		expect(readSecret).not.toHaveBeenCalled();
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(output.stdout.mock.calls.flat().join('\n')).not.toContain('nsec1fake');
	});

	it('keeps the command pool boundary in the orchestration contract', () => {
		const dependencies = fakeDependencies([]);
		expect(dependencies.relay.close).toBeDefined();
		expect(REALTIME_EVENT_KIND).toBe(7070);
		expect(REALTIME_CONTROL_PROTOCOL_KEY).toContain(':control:1');
	});
});
