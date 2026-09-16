import { describe, expect, it } from 'vitest';
import { getPublicKey } from 'nostr-tools/pure';
import {
	buildRealtimeEventFilter,
	buildRealtimeEventTemplate,
	finalizeRealtimeEvent,
	parseRealtimeAction,
	parseRealtimeEnvelope,
	protocolKeyFor,
	REALTIME_EVENT_KIND,
	type RealtimeEventDefinition
} from './realtimeEvents';

const CHANNEL = 'a'.repeat(64);
const SECRET = new Uint8Array(32).fill(7);
const PUBKEY = getPublicKey(SECRET);
const DEFINITION: RealtimeEventDefinition<{ action: 'ping'; value: number }> = {
	eventType: 'ping',
	protocolVersion: 1,
	protocolKey: protocolKeyFor('ping', 1),
	parseAction(value) {
		return typeof value === 'object' && value !== null && (value as Record<string, unknown>).action === 'ping' && typeof (value as Record<string, unknown>).value === 'number'
			? { action: 'ping', value: (value as Record<string, number>).value }
			: null;
	}
};

describe('realtime event protocol', () => {
	it('builds, signs, and parses the project-owned regular kind 7070 envelope', () => {
		const signed = finalizeRealtimeEvent(buildRealtimeEventTemplate({
			channelId: CHANNEL, relayHint: 'wss://relay.test/', eventType: 'ping', protocolVersion: 1,
			instanceId: '2026-09-16', payload: { action: 'ping', value: 1 }, createdAt: 1_700_000_000
		}), SECRET);
		const parsed = parseRealtimeAction(signed, CHANNEL, [DEFINITION]);
		expect(parsed?.envelope.event.kind).toBe(7070);
		expect(parsed?.envelope.instanceId).toBe('2026-09-16');
		expect(parsed?.action).toEqual({ action: 'ping', value: 1 });
		expect(signed.pubkey).toBe(PUBKEY);
	});

	it('uses an exact instance-indexed filter', () => {
		expect(buildRealtimeEventFilter({ channelId: CHANNEL, eventTypes: [DEFINITION], instanceId: '2026-09-16', since: 10 })).toEqual({
		kinds: [7070], '#e': [CHANNEL], '#d': [DEFINITION.protocolKey], '#i': ['2026-09-16'], since: 10
	});
	});

	it('ignores unknown, disabled, wrong-channel, malformed, and duplicate-tag events', () => {
		const base = finalizeRealtimeEvent(buildRealtimeEventTemplate({
			channelId: CHANNEL, relayHint: 'wss://relay.test/', eventType: 'ping', protocolVersion: 1,
			instanceId: '2026-09-16', payload: { action: 'ping', value: 1 }, createdAt: 1_700_000_000
		}), SECRET);
		expect(parseRealtimeEnvelope(base, CHANNEL, [])).toBeNull();
		const foreign = finalizeRealtimeEvent(buildRealtimeEventTemplate({
			channelId: 'b'.repeat(64), relayHint: 'wss://relay.test/', eventType: 'ping', protocolVersion: 1,
			instanceId: '2026-09-16', payload: { action: 'ping', value: 1 }, createdAt: 1_700_000_000
		}), SECRET);
		expect(parseRealtimeEnvelope(foreign, CHANNEL, [DEFINITION])).toBeNull();
		expect(parseRealtimeEnvelope({ ...base, tags: [['e', 'b'.repeat(64)], ['d', DEFINITION.protocolKey], ['i', '2026-09-16']] }, CHANNEL, [DEFINITION])).toBeNull();
		expect(parseRealtimeEnvelope({ ...base, tags: [['e', CHANNEL], ['e', CHANNEL], ['d', DEFINITION.protocolKey], ['i', '2026-09-16']] }, CHANNEL, [DEFINITION])).toBeNull();
		expect(parseRealtimeEnvelope({ ...base, content: '{not json' }, CHANNEL, [DEFINITION])).toBeNull();
	});

	it('rejects event-specific malformed actions after accepting the common envelope', () => {
		const signed = finalizeRealtimeEvent(buildRealtimeEventTemplate({
			channelId: CHANNEL, relayHint: 'wss://relay.test/', eventType: 'ping', protocolVersion: 1,
			instanceId: '2026-09-16', payload: { action: 'wrong' }, createdAt: 1_700_000_000
		}), SECRET);
		expect(parseRealtimeEnvelope(signed, CHANNEL, [DEFINITION])).not.toBeNull();
		expect(parseRealtimeAction(signed, CHANNEL, [DEFINITION])).toBeNull();
	});
});
