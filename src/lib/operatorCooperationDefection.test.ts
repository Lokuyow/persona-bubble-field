import { getPublicKey, type Event } from 'nostr-tools/pure';
import { describe, expect, it, vi } from 'vitest';
import {
	OperatorCancelled,
	OperatorFailure,
	runManualCooperationDefectionOperator,
	sanitizeOperatorDisplayText,
	type OperatorDependencies
} from './operatorCooperationDefection';
import type { OperatorRelayAdapter, OperatorRelayPublishResult, OperatorRelayQueryResult } from './operatorRelayAdapter';
import { REALTIME_EVENT_KIND, REALTIME_CONTROL_PROTOCOL_KEY } from './realtimeEvents';
import { PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from './prototypeWorldConfig';

const SECRET = new Uint8Array(32).fill(7);
const CREATOR = getPublicKey(SECRET);
const NOW = Date.UTC(2026, 0, 2, 10, 0);

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
	return { ...PROTOTYPE_WORLD_CONFIG, channelId, creatorPubkey: CREATOR, authoritativeRelays: ['wss://relay.example/'], preferredRelayHint: 'wss://relay.example/' };
}

describe('operator CooperationDefection flow', () => {
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
		const world = testWorld('c'.repeat(64));
		const secret = new Uint8Array(SECRET);
		const dependencies = fakeDependencies([result()], { readSecret: vi.fn(async () => secret) });
		const command = await runManualCooperationDefectionOperator('dry-run', dependencies, world);
		expect(command.exitCode).toBe(0);
		expect(command.world).toEqual(world);
		expect(dependencies.relay.query).toHaveBeenCalledTimes(1);
		expect(dependencies.relay.query).toHaveBeenCalledWith(
			expect.objectContaining({ kinds: [REALTIME_EVENT_KIND], authors: [CREATOR] }),
			world.authoritativeRelays
		);
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(secret.every((byte) => byte === 0)).toBe(true);
		expect(dependencies.relay.close).toHaveBeenCalledTimes(1);
	});

	it('rejects invalid fixed World config without querying Relay', async () => {
		const dependencies = fakeDependencies([]);
		await expect(runManualCooperationDefectionOperator('dry-run', dependencies, {
			...testWorld('c'.repeat(64)),
			preferredRelayHint: 'wss://not-authoritative.example/'
		})).rejects.toMatchObject({ reason: 'invalid configuration' } satisfies Partial<OperatorFailure>);
		expect(dependencies.relay.query).not.toHaveBeenCalled();
	});

	it('fails closed without asking for a secret when control preflight has no real EOSE', async () => {
		const world = testWorld('c'.repeat(64));
		const dependencies = fakeDependencies([
			{ events: [], eventSources: [], relays: [{ relayUrl: 'wss://relay.example/', status: 'closed' }], eoseCount: 0 }
		]);
		await expect(runManualCooperationDefectionOperator('dry-run', dependencies, world)).rejects.toMatchObject({ reason: 'control preflight failed' } satisfies Partial<OperatorFailure>);
		expect(dependencies.readSecret).not.toHaveBeenCalled();
		expect(dependencies.relay.close).toHaveBeenCalledTimes(1);
	});

	it('does not read a secret after confirmation cancellation, including a pasted fake nsec', async () => {
		const world = testWorld('c'.repeat(64));
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const output = { stdout: vi.fn(), stderr: vi.fn() };
		const dependencies = fakeDependencies([result()], {
			confirmPublish: vi.fn(async () => 'cancelled' as const), readSecret, output
		});
		await expect(runManualCooperationDefectionOperator('publish', dependencies, world)).rejects.toBeInstanceOf(OperatorCancelled);
		expect(readSecret).not.toHaveBeenCalled();
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
		expect(output.stdout.mock.calls.flat().join('\n')).not.toContain('nsec1fake');
	});

	it('preflights scheduled conflict before reading a secret in dry-run and publish modes', async () => {
		const world = testWorld('c'.repeat(64));
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		for (const mode of ['dry-run', 'publish'] as const) {
			const confirmPublish = vi.fn(async () => 'confirmed' as const);
			const readSecret = vi.fn(async () => new Uint8Array(SECRET));
			const dependencies = fakeDependencies([result()], { nowMs: () => conflictTime, confirmPublish, readSecret });
			await expect(runManualCooperationDefectionOperator(mode, dependencies, world)).rejects.toMatchObject({ reason: 'scheduled CooperationDefection conflict' });
			expect(readSecret).not.toHaveBeenCalled();
			if (mode === 'publish') expect(confirmPublish).not.toHaveBeenCalled();
		}
	});

	it('rechecks scheduled conflict after confirmation before requesting the secret', async () => {
		const world = testWorld('c'.repeat(64));
		const safeTime = Date.UTC(2026, 0, 2, 10, 0);
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		let calls = 0;
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const dependencies = fakeDependencies([result(), result()], {
			confirmPublish: vi.fn(async () => 'confirmed' as const), readSecret, nowMs: () => calls++ === 0 ? safeTime : conflictTime
		});
		await expect(runManualCooperationDefectionOperator('publish', dependencies, world)).rejects.toMatchObject({ reason: 'scheduled CooperationDefection conflict' });
		expect(readSecret).not.toHaveBeenCalled();
	});

	it('settles a second preflight before honoring cancellation and leaves no publish path', async () => {
		const world = testWorld('c'.repeat(64));
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
				if (queryCount === 2) return secondQuery;
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
		const pending = runManualCooperationDefectionOperator('publish', dependencies, world);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		settleSecond!();
		await expect(pending).rejects.toBeInstanceOf(OperatorCancelled);
		expect(readSecret).not.toHaveBeenCalled();
		expect(relay.publish).not.toHaveBeenCalled();
		expect(queryCount).toBe(2);
	});

	it('honors cancellation before relay.publish is invoked', async () => {
		const world = testWorld('c'.repeat(64));
		const controller = new AbortController();
		const secret = new Uint8Array(SECRET);
		const base = fakeDependencies([result()], {
			cancelSignal: controller.signal,
			readSecret: vi.fn(async () => {
				controller.abort();
				return secret;
			})
		});
		await expect(runManualCooperationDefectionOperator('publish', base, world)).rejects.toBeInstanceOf(OperatorCancelled);
		expect(base.relay.publish).not.toHaveBeenCalled();
		expect(secret.every((byte) => byte === 0)).toBe(true);
	});

	it('waits for relay results when cancellation arrives after publish starts', async () => {
		const world = testWorld('c'.repeat(64));
		const controller = new AbortController();
		let resolvePublish: ((value: readonly OperatorRelayPublishResult[]) => void) | undefined;
		const base = fakeDependencies([result(), result()], { cancelSignal: controller.signal });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			publish: vi.fn((): Promise<readonly OperatorRelayPublishResult[]> => {
				controller.abort();
				return new Promise((resolve) => { resolvePublish = resolve; });
			})
		};
		const pending = runManualCooperationDefectionOperator('publish', { ...base, relay }, world);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		resolvePublish!([{ relayUrl: 'wss://relay.example/', outcome: 'accepted' }]);
		await expect(pending).resolves.toMatchObject({ exitCode: 0 });
	});

	it('performs a final exact conflict check after fresh time advances and before signing or publishing', async () => {
		const world = testWorld('c'.repeat(64));
		const safeTime = Date.UTC(2026, 0, 2, 10, 0);
		const conflictTime = Date.UTC(2026, 0, 2, 11, 50);
		let calls = 0;
		const readSecret = vi.fn(async () => new Uint8Array(SECRET));
		const dependencies = fakeDependencies([result()], {
			readSecret, nowMs: () => calls++ === 0 ? safeTime : conflictTime
		});
		await expect(runManualCooperationDefectionOperator('dry-run', dependencies, world)).rejects.toMatchObject({ reason: 'scheduled CooperationDefection conflict' });
		expect(readSecret).toHaveBeenCalledTimes(1);
		expect(dependencies.relay.publish).not.toHaveBeenCalled();
	});

	it('runs the confirmed publish orchestration with the creator secret and authoritative Relay', async () => {
		const world = testWorld('c'.repeat(64));
		const secret = new Uint8Array(SECRET);
		const readSecret = vi.fn(async () => secret);
		const dependencies = fakeDependencies([result(), result()], { readSecret });
		const command = await runManualCooperationDefectionOperator('publish', dependencies, world);
		expect(command.exitCode).toBe(0);
		expect(dependencies.confirmPublish).toHaveBeenCalledTimes(1);
		expect(dependencies.relay.publish).toHaveBeenCalledTimes(1);
		expect(secret.every((byte) => byte === 0)).toBe(true);
	});

	it('treats accepted plus failed Relays as partial success and sanitizes rejection reasons', async () => {
		const world = testWorld('c'.repeat(64));
		const output = { stdout: vi.fn(), stderr: vi.fn() };
		const base = fakeDependencies([result(), result()], { output });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			publish: vi.fn(async () => [
				{ relayUrl: 'wss://relay.example/', outcome: 'accepted' as const },
				{ relayUrl: 'wss://relay-2.example/', outcome: 'rejected' as const, notice: '\u001b]0;rejected\u0007\r\n' }
			])
		};
		const command = await runManualCooperationDefectionOperator('publish', { ...base, relay }, world);
		expect(command.exitCode).toBe(0);
		const displayed = output.stdout.mock.calls.flat().join('\n');
		expect(displayed).not.toContain('\u001b');
		expect(displayed).toContain('\\u001b');
	});

	it('returns a fixed overall failure for all rejected/timeout Relays and still zeroizes and closes', async () => {
		const world = testWorld('c'.repeat(64));
		const secret = new Uint8Array(SECRET);
		const base = fakeDependencies([result(), result()], { readSecret: vi.fn(async () => secret) });
		const relay: OperatorRelayAdapter = {
			...base.relay,
			publish: vi.fn(async () => [
				{ relayUrl: 'wss://relay.example/', outcome: 'rejected' as const, notice: 'policy' },
				{ relayUrl: 'wss://relay-2.example/', outcome: 'timeout' as const }
			])
		};
		await expect(runManualCooperationDefectionOperator('publish', { ...base, relay }, world)).rejects.toMatchObject({ reason: 'all authoritative Relays failed to accept the event' });
		expect(secret.every((byte) => byte === 0)).toBe(true);
		expect(base.relay.close).toHaveBeenCalledTimes(1);
	});

	it.each([
		['wrong creator', new Uint8Array(32).fill(8), 'operator secret is not the channel creator'],
		['malformed', new Uint8Array(1), 'invalid operator secret']
	] as const)('rejects %s secret without publishing', async (_label, secret, reason) => {
		const world = testWorld('c'.repeat(64));
		const dependencies = fakeDependencies([result()], { readSecret: vi.fn(async () => secret) });
		await expect(runManualCooperationDefectionOperator('dry-run', dependencies, world)).rejects.toMatchObject({ reason });
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
