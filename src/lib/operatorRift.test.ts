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

function testWorld(channelId: string): PrototypeWorldConfig {
	return { ...PROTOTYPE_WORLD_CONFIG, channelId, metadataDiscoveryRelays: ['wss://relay.example/'], preferredRelayHint: 'wss://relay.example/' };
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
		const world = testWorld(channel.id);
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
		const world = testWorld(channel.id);
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
		const world = testWorld(channel.id);
		await expect(runManualRiftOperator('publish', dependencies, world)).rejects.toBeInstanceOf(OperatorCancelled);
		expect(readSecret).not.toHaveBeenCalled();
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(output.stdout.mock.calls.flat().join('\n')).not.toContain('nsec1fake');
	});

	it('preflights scheduled conflict before reading a secret in dry-run and publish modes', async () => {
		const { channel, metadata } = metadataEvents();
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		for (const mode of ['dry-run', 'publish'] as const) {
			const confirmPublish = vi.fn(async () => 'confirmed' as const);
			const readSecret = vi.fn(async () => new Uint8Array(SECRET));
			const dependencies = fakeDependencies([result([channel]), result([metadata]), result()], { nowMs: () => conflictTime, confirmPublish, readSecret });
			await expect(runManualRiftOperator(mode, dependencies, testWorld(channel.id))).rejects.toMatchObject({ reason: 'scheduled Rift conflict' });
			expect(readSecret).not.toHaveBeenCalled();
			if (mode === 'publish') expect(confirmPublish).not.toHaveBeenCalled();
		}
	});

	it('rechecks scheduled conflict after confirmation before requesting the secret', async () => {
		const { channel, metadata } = metadataEvents();
		const safeTime = Date.UTC(2026, 0, 2, 10, 0);
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		let calls = 0;
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result(), result()], {
			confirmPublish: vi.fn(async () => 'confirmed' as const), readSecret, nowMs: () => calls++ === 0 ? safeTime : conflictTime
		});
		await expect(runManualRiftOperator('publish', dependencies, testWorld(channel.id))).rejects.toMatchObject({ reason: 'scheduled Rift conflict' });
		expect(readSecret).not.toHaveBeenCalled();
	});

	it('settles a second preflight before honoring cancellation and leaves no publish path', async () => {
		const { channel, metadata } = metadataEvents();
		const controller = new AbortController();
		let queryCount = 0;
		let settleSecond: (() => void) | undefined;
		const secondQuery = new Promise<OperatorRelayQueryResult>((resolve) => { settleSecond = () => resolve(result()); });
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const base = fakeDependencies([], { readSecret, cancelSignal: controller.signal });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			query: vi.fn(async () => {
				queryCount += 1;
				if (queryCount === 1) return result([channel]);
				if (queryCount === 2) return result([metadata]);
				if (queryCount === 4) return secondQuery;
				return result();
			})
		};
		const dependencies = {
			...base,
			relay,
			confirmPublish: vi.fn(async () => {
				controller.abort();
				return 'confirmed' as const;
			})
		};
		const pending = runManualRiftOperator('publish', dependencies, testWorld(channel.id));
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		settleSecond!();
		await expect(pending).rejects.toBeInstanceOf(OperatorCancelled);
		expect(readSecret).not.toHaveBeenCalled();
		expect(relay.publish).not.toHaveBeenCalled();
		expect(queryCount).toBe(4);
	});

	it('performs a final exact conflict check after fresh time advances and before signing or publishing', async () => {
		const { channel, metadata } = metadataEvents();
		const safeTime = Date.UTC(2026, 0, 2, 10, 0);
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		let calls = 0;
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result()], {
			readSecret, nowMs: () => calls++ === 0 ? safeTime : conflictTime
		});
		await expect(runManualRiftOperator('dry-run', dependencies, testWorld(channel.id))).rejects.toMatchObject({ reason: 'scheduled Rift conflict' });
		expect(readSecret).toHaveBeenCalledTimes(1);
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
	});

	it('runs the confirmed publish orchestration with the creator secret and authoritative Relay', async () => {
		const { channel, metadata } = metadataEvents();
		const secret = new Uint8Array(SECRET);
		const readSecret = vi.fn(async () => secret);
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result(), result()], { readSecret });
		const command = await runManualRiftOperator('publish', dependencies, testWorld(channel.id));
		expect(command.exitCode).toBe(0);
		expect(dependencies.confirmPublish).toHaveBeenCalledTimes(1);
		expect(dependencies.relay.publish).toHaveBeenCalledTimes(1);
		expect(secret.every((byte) => byte === 0)).toBe(true);
	});

	it('treats accepted plus failed Relays as partial success and sanitizes rejection reasons', async () => {
		const { channel, metadata } = metadataEvents();
		const output = { stdout: vi.fn(), stderr: vi.fn() };
		const base = fakeDependencies([result([channel]), result([metadata]), result(), result()], { output });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			publish: vi.fn(async () => [
				{ relayUrl: 'wss://relay.example/', outcome: 'accepted' as const },
				{ relayUrl: 'wss://relay-2.example/', outcome: 'rejected' as const, notice: '\u001b]0;rejected\u0007\r\n' }
			])
		};
		const command = await runManualRiftOperator('publish', { ...base, relay }, testWorld(channel.id));
		expect(command.exitCode).toBe(0);
		const displayed = output.stdout.mock.calls.flat().join('\n');
		expect(displayed).not.toContain('\u001b');
		expect(displayed).toContain('\\u001b');
	});

	it('returns a fixed overall failure for all rejected/timeout Relays and still zeroizes and closes', async () => {
		const { channel, metadata } = metadataEvents();
		const secret = new Uint8Array(SECRET);
		const base = fakeDependencies([result([channel]), result([metadata]), result(), result()], { readSecret: vi.fn(async () => secret) });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			publish: vi.fn(async () => [
				{ relayUrl: 'wss://relay.example/', outcome: 'rejected' as const, notice: 'policy' },
				{ relayUrl: 'wss://relay-2.example/', outcome: 'timeout' as const }
			])
		};
		await expect(runManualRiftOperator('publish', { ...base, relay }, testWorld(channel.id))).rejects.toMatchObject({ reason: 'all authoritative Relays failed to accept the event' });
		expect(secret.every((byte) => byte === 0)).toBe(true);
		expect(base.relay.close).toHaveBeenCalledTimes(1);
	});

	it.each([
		['wrong creator', new Uint8Array(32).fill(8), 'operator secret is not the channel creator'],
		['malformed', new Uint8Array(1), 'invalid operator secret']
	] as const)('rejects %s secret without publishing', async (_label, secret, reason) => {
		const { channel, metadata } = metadataEvents();
		const dependencies = fakeDependencies([result([channel]), result([metadata]), result()], { readSecret: vi.fn(async () => secret) });
		await expect(runManualRiftOperator('dry-run', dependencies, testWorld(channel.id))).rejects.toMatchObject({ reason });
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(secret.every((byte) => byte === 0)).toBe(true);
	});

	it('keeps the command pool boundary in the orchestration contract', () => {
		const dependencies = fakeDependencies([]);
		expect(dependencies.relay.close).toBeDefined();
		expect(REALTIME_EVENT_KIND).toBe(7070);
		expect(REALTIME_CONTROL_PROTOCOL_KEY).toContain(':control:1');
	});
});
