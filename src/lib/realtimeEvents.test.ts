import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import {
	buildRealtimeControlEventTemplate,
	buildRealtimeControlFilter,
	buildRealtimeEventFilter,
	buildRealtimeInstanceFilter,
	buildRealtimeEventTemplate,
	finalizeRealtimeEvent,
	parseRealtimeControlEnvelope,
	parseRealtimeAction,
	parseRealtimeEnvelope,
	normalizeRealtimeInstanceFilterConfigurations,
	protocolKeyFor,
	REALTIME_EVENT_KIND,
	REALTIME_CONTROL_PROTOCOL_KEY,
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

	it('builds and validates a creator-signed control without adding an instance index to its filter', () => {
		const createdAt = 1_700_000_000;
		const instanceId = `rift:1:manual:${createdAt}:0123456789abcdef0123456789abcdef`;
		const signed = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: CHANNEL, relayHint: 'wss://relay.test/', instanceId,
			payload: { command: 'start', targetProtocolKey: DEFINITION.protocolKey }, createdAt
		}), SECRET);
		expect(parseRealtimeControlEnvelope(signed, CHANNEL, PUBKEY)?.payload).toEqual({ command: 'start', targetProtocolKey: DEFINITION.protocolKey });
		expect(buildRealtimeControlFilter({ channelId: CHANNEL, creatorPubkey: PUBKEY, since: createdAt - 900 })).toEqual({
			kinds: [REALTIME_EVENT_KIND], authors: [PUBKEY], '#e': [CHANNEL], '#d': [REALTIME_CONTROL_PROTOCOL_KEY], since: createdAt - 900
		});
		expect(buildRealtimeInstanceFilter({ channelId: CHANNEL, configuration: { protocolKey: DEFINITION.protocolKey, instanceIds: [instanceId], since: createdAt } })).toEqual({
			kinds: [REALTIME_EVENT_KIND], '#e': [CHANNEL], '#d': [DEFINITION.protocolKey], '#i': [instanceId], since: createdAt
		});
	});

	it('keeps instance IDs and history cursors independent for each playable protocol key', () => {
		const second = { ...DEFINITION, eventType: 'other', protocolKey: protocolKeyFor('other', 1) };
		const filters = [
			buildRealtimeInstanceFilter({ channelId: CHANNEL, configuration: { protocolKey: DEFINITION.protocolKey, instanceIds: ['rift-a', 'rift-b'], since: 10 } }),
			buildRealtimeInstanceFilter({ channelId: CHANNEL, configuration: { protocolKey: second.protocolKey, instanceIds: ['other-a'], since: 20 } })
		];
		expect(filters).toEqual([
			{ kinds: [REALTIME_EVENT_KIND], '#e': [CHANNEL], '#d': [DEFINITION.protocolKey], '#i': ['rift-a', 'rift-b'], since: 10 },
			{ kinds: [REALTIME_EVENT_KIND], '#e': [CHANNEL], '#d': [second.protocolKey], '#i': ['other-a'], since: 20 }
		]);
	});

	it('normalizes duplicate configuration entries without crossing protocol ownership', () => {
		expect(normalizeRealtimeInstanceFilterConfigurations([
			{ protocolKey: DEFINITION.protocolKey, instanceIds: ['b', 'a'], since: 20 },
			{ protocolKey: DEFINITION.protocolKey, instanceIds: ['a', 'c'], since: 10 }
		])).toEqual([{ protocolKey: DEFINITION.protocolKey, instanceIds: ['a', 'b', 'c'], since: 10 }]);
	});

	it('rejects controls from a foreign creator and controls with ambiguous payload keys', () => {
		const signed = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: CHANNEL, relayHint: 'wss://relay.test/', instanceId: 'rift:1:manual:1700000000:0123456789abcdef0123456789abcdef',
			payload: { command: 'start', targetProtocolKey: DEFINITION.protocolKey }, createdAt: 1_700_000_000
		}), SECRET);
		expect(parseRealtimeControlEnvelope(signed, CHANNEL, getPublicKey(new Uint8Array(32).fill(8)))).toBeNull();
		const malformed = finalizeEvent({
			kind: REALTIME_EVENT_KIND, created_at: 1_700_000_000,
			tags: [['e', CHANNEL, 'wss://relay.test/'], ['d', REALTIME_CONTROL_PROTOCOL_KEY], ['i', 'rift:1:manual:1700000000:0123456789abcdef0123456789abcdef']],
			content: JSON.stringify({ command: 'start', targetProtocolKey: DEFINITION.protocolKey, extra: true })
		}, SECRET);
		expect(parseRealtimeControlEnvelope(malformed, CHANNEL, PUBKEY)).toBeNull();
	});
});
