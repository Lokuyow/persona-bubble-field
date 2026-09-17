import { finalizeEvent, verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import { resolveCharacterFromPubkey } from './characterAssignment';
import { PROTOTYPE_NAMESPACE } from './nostrProtocol';

/** Project-owned regular event kind for the realtime-event prototype. */
export const REALTIME_EVENT_KIND = 7070;
export const REALTIME_INSTANCE_TAG = 'i';
export const REALTIME_PROTOCOL_NAMESPACE = `${PROTOTYPE_NAMESPACE}:realtime`;
export const REALTIME_CONTROL_PROTOCOL_KEY = `${REALTIME_PROTOCOL_NAMESPACE}:control:1`;

export type RealtimeFieldTargetInput = Readonly<{
	instanceId: string;
	field: Readonly<{ columns: number; rows: number; cellSize: number }>;
	participantDemand?: number;
}>;

export type RealtimeEventDefinition<Action = unknown> = Readonly<{
	eventType: string;
	protocolVersion: number;
	protocolKey: string;
	parseAction: (value: unknown) => Action | null;
	schedule?: (nowMs: number) => unknown;
	fieldTargets?: (input: RealtimeFieldTargetInput) => readonly unknown[];
}>;

export type RealtimeEventRegistry = readonly RealtimeEventDefinition[];

export type RealtimeEnvelope = Readonly<{
	event: VerifiedEvent;
	channelId: string;
	eventType: string;
	protocolVersion: number;
	protocolKey: string;
	instanceId: string;
	payload: Record<string, unknown>;
	definition: RealtimeEventDefinition;
}>;

export type RealtimeControlPayload = Readonly<{
	command: 'start';
	targetProtocolKey: string;
}>;

export type RealtimeControlEnvelope = Readonly<{
	event: VerifiedEvent;
	channelId: string;
	protocolKey: typeof REALTIME_CONTROL_PROTOCOL_KEY;
	instanceId: string;
	payload: RealtimeControlPayload;
}>;

export type RealtimeEventTemplate = EventTemplate & { kind: typeof REALTIME_EVENT_KIND };

export type RealtimeEventInput = Readonly<{
	channelId: string;
	relayHint: string;
	eventType: string;
	protocolVersion: number;
	instanceId: string;
	payload: Record<string, unknown>;
	createdAt: number;
}>;

export type RealtimeControlEventInput = Readonly<{
	channelId: string;
	relayHint: string;
	instanceId: string;
	payload: RealtimeControlPayload;
	createdAt: number;
}>;

const HEX_64 = /^[0-9a-f]{64}$/;
const INSTANCE_ID = /^[\x20-\x7e]{1,160}$/;

function assertChannelId(value: string): void {
	if (!HEX_64.test(value)) throw new TypeError('Realtime target channel must be a lowercase 64-character event ID.');
}

function assertRelayHint(value: string): void {
	let url: URL;
	try { url = new URL(value); } catch { throw new TypeError('Realtime relay hint must be a websocket URL.'); }
	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new TypeError('Realtime relay hint must be a websocket URL.');
}

function assertInstanceId(value: string): void {
	if (!INSTANCE_ID.test(value)) throw new TypeError('Realtime instance ID must be a short printable string.');
}

function assertCreatedAt(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Realtime created_at must be a non-negative Unix timestamp.');
}

function assertProtocolVersion(value: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 999) throw new TypeError('Realtime protocol version must be a positive safe integer.');
}

function assertPayload(value: unknown): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Realtime action payload must be a JSON object.');
}

function exactlyOneTag(event: Event, name: string): string[] | null {
	const tags = event.tags.filter((tag) => tag[0] === name);
	return tags.length === 1 ? tags[0] : null;
}

function findDefinition(registry: RealtimeEventRegistry, protocolKey: string): RealtimeEventDefinition | null {
	return registry.find((definition) => definition.protocolKey === protocolKey) ?? null;
}

function hasAssignedCharacter(pubkey: string): boolean {
	try {
		return resolveCharacterFromPubkey(pubkey) !== undefined;
	} catch {
		return false;
	}
}

function parseProtocolKey(value: string): Readonly<{ eventType: string; protocolVersion: number }> | null {
	const prefix = `${REALTIME_PROTOCOL_NAMESPACE}:`;
	if (!value.startsWith(prefix)) return null;
	const parts = value.slice(prefix.length).split(':');
	if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) return null;
	const protocolVersion = Number(parts[1]);
	return Number.isSafeInteger(protocolVersion) && protocolVersion > 0
		? { eventType: parts[0], protocolVersion }
		: null;
}

export function protocolKeyFor(eventType: string, protocolVersion: number): string {
	if (!/^[a-z][a-z0-9-]{0,48}$/.test(eventType)) throw new TypeError('Realtime event type must be a lowercase identifier.');
	assertProtocolVersion(protocolVersion);
	return `${REALTIME_PROTOCOL_NAMESPACE}:${eventType}:${protocolVersion}`;
}

export function buildRealtimeControlEventTemplate(input: RealtimeControlEventInput): RealtimeEventTemplate {
	assertChannelId(input.channelId);
	assertRelayHint(input.relayHint);
	assertCreatedAt(input.createdAt);
	assertInstanceId(input.instanceId);
	if (!isRealtimeControlPayload(input.payload)) throw new TypeError('Realtime control payload is invalid.');
	return {
		kind: REALTIME_EVENT_KIND,
		created_at: input.createdAt,
		tags: [['e', input.channelId, input.relayHint], ['d', REALTIME_CONTROL_PROTOCOL_KEY], [REALTIME_INSTANCE_TAG, input.instanceId]],
		content: JSON.stringify(input.payload)
	};
}

export function buildRealtimeEventTemplate(input: RealtimeEventInput): RealtimeEventTemplate {
	assertChannelId(input.channelId);
	assertRelayHint(input.relayHint);
	assertCreatedAt(input.createdAt);
	assertProtocolVersion(input.protocolVersion);
	assertInstanceId(input.instanceId);
	assertPayload(input.payload);
	const protocolKey = protocolKeyFor(input.eventType, input.protocolVersion);
	return {
		kind: REALTIME_EVENT_KIND,
		created_at: input.createdAt,
		tags: [
			['e', input.channelId, input.relayHint],
			['d', protocolKey],
			[REALTIME_INSTANCE_TAG, input.instanceId]
		],
		content: JSON.stringify(input.payload)
	};
}

export function finalizeRealtimeEvent(template: RealtimeEventTemplate, secretKey: Uint8Array): VerifiedEvent {
	return finalizeEvent(template, secretKey);
}

/**
 * Parses only enabled definitions supplied by the caller. This makes an event
 * type disappear from runtime when it is removed from the compile-time registry.
 */
export function parseRealtimeEnvelope(
	event: Event,
	channelId: string,
	registry: RealtimeEventRegistry
): RealtimeEnvelope | null {
	assertChannelId(channelId);
	if (event.kind !== REALTIME_EVENT_KIND) return null;
	try { if (!verifyEvent(event)) return null; } catch { return null; }
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	const channel = exactlyOneTag(event, 'e');
	const descriptor = exactlyOneTag(event, 'd');
	const instance = exactlyOneTag(event, REALTIME_INSTANCE_TAG);
	if (!channel || !descriptor || !instance || channel[1] !== channelId || !HEX_64.test(channel[1])) return null;
	if (channel.length < 2 || channel.length > 3 || descriptor.length !== 2 || instance.length !== 2 || !INSTANCE_ID.test(instance[1])) return null;
	if (channel.length === 3) {
		try { assertRelayHint(channel[2]); } catch { return null; }
	}
	const parsedKey = parseProtocolKey(descriptor[1]);
	if (!parsedKey) return null;
	if (descriptor[1] === REALTIME_CONTROL_PROTOCOL_KEY || !hasAssignedCharacter(event.pubkey)) return null;
	const definition = findDefinition(registry, descriptor[1]);
	if (!definition || definition.eventType !== parsedKey.eventType || definition.protocolVersion !== parsedKey.protocolVersion) return null;
	let payload: unknown;
	try { payload = JSON.parse(event.content); } catch { return null; }
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
	return {
		event,
		channelId,
		eventType: parsedKey.eventType,
		protocolVersion: parsedKey.protocolVersion,
		protocolKey: descriptor[1],
		instanceId: instance[1],
		payload: payload as Record<string, unknown>,
		definition
	};
}

function parseRealtimeControlPayload(value: unknown): RealtimeControlPayload | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const payload = value as Record<string, unknown>;
	if (Object.keys(payload).some((key) => key !== 'command' && key !== 'targetProtocolKey')) return null;
	return payload.command === 'start' && typeof payload.targetProtocolKey === 'string' && payload.targetProtocolKey.length > 0
		? { command: 'start', targetProtocolKey: payload.targetProtocolKey }
		: null;
}

export function isRealtimeControlPayload(value: unknown): value is RealtimeControlPayload {
	return parseRealtimeControlPayload(value) !== null;
}

export function parseRealtimeControlEnvelope(event: Event, channelId: string, creatorPubkey: string): RealtimeControlEnvelope | null {
	assertChannelId(channelId);
	if (event.kind !== REALTIME_EVENT_KIND || event.pubkey !== creatorPubkey) return null;
	try { if (!verifyEvent(event)) return null; } catch { return null; }
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	const channel = exactlyOneTag(event, 'e');
	const descriptor = exactlyOneTag(event, 'd');
	const instance = exactlyOneTag(event, REALTIME_INSTANCE_TAG);
	if (!channel || !descriptor || !instance || channel[1] !== channelId || descriptor[1] !== REALTIME_CONTROL_PROTOCOL_KEY) return null;
	if (channel.length < 2 || channel.length > 3 || descriptor.length !== 2 || instance.length !== 2 || !INSTANCE_ID.test(instance[1])) return null;
	if (channel.length === 3) {
		try { assertRelayHint(channel[2]); } catch { return null; }
	}
	let payload: unknown;
	try { payload = JSON.parse(event.content); } catch { return null; }
	const parsedPayload = parseRealtimeControlPayload(payload);
	return parsedPayload ? { event, channelId, protocolKey: REALTIME_CONTROL_PROTOCOL_KEY, instanceId: instance[1], payload: parsedPayload } : null;
}

export function parseRealtimeAction<Action>(
	event: Event,
	channelId: string,
	registry: readonly RealtimeEventDefinition<Action>[]
): Readonly<{ envelope: RealtimeEnvelope; action: Action }> | null {
	const envelope = parseRealtimeEnvelope(event, channelId, registry);
	if (!envelope) return null;
	const action = envelope.definition.parseAction(envelope.payload) as Action | null;
	return action === null ? null : { envelope, action };
}

export function buildRealtimeEventFilter(input: Readonly<{
	channelId: string;
	eventTypes: RealtimeEventRegistry;
	instanceId?: string;
	instanceIds?: readonly string[];
	since?: number;
}>): Filter {
	assertChannelId(input.channelId);
	if (input.eventTypes.length === 0) throw new TypeError('At least one realtime event definition is required.');
	if (input.instanceId !== undefined) assertInstanceId(input.instanceId);
	if (input.instanceIds !== undefined) {
		if (input.instanceIds.length === 0 || input.instanceIds.some((instanceId) => !INSTANCE_ID.test(instanceId))) throw new TypeError('Realtime instance IDs are invalid.');
	}
	if (input.instanceId !== undefined && input.instanceIds !== undefined) throw new TypeError('Use instanceId or instanceIds, not both.');
	if (input.since !== undefined) assertCreatedAt(input.since);
	const filter: Record<string, unknown> = {
		kinds: [REALTIME_EVENT_KIND],
		'#e': [input.channelId],
		'#d': input.eventTypes.map((definition) => definition.protocolKey)
	};
	if (input.instanceId !== undefined) filter[`#${REALTIME_INSTANCE_TAG}`] = [input.instanceId];
	if (input.instanceIds !== undefined) filter[`#${REALTIME_INSTANCE_TAG}`] = [...new Set(input.instanceIds)];
	if (input.since !== undefined) filter.since = input.since;
	return filter as Filter;
}

export type RealtimeInstanceFilterConfiguration = Readonly<{
	protocolKey: string;
	instanceIds: readonly string[];
	since: number;
}>;

export function normalizeRealtimeInstanceFilterConfigurations(
	configurations: readonly RealtimeInstanceFilterConfiguration[]
): readonly RealtimeInstanceFilterConfiguration[] {
	const merged = new Map<string, { instanceIds: Set<string>; since: number }>();
	for (const configuration of configurations) {
		const current = merged.get(configuration.protocolKey) ?? { instanceIds: new Set<string>(), since: configuration.since };
		for (const instanceId of configuration.instanceIds) current.instanceIds.add(instanceId);
		current.since = Math.min(current.since, configuration.since);
		merged.set(configuration.protocolKey, current);
	}
	return [...merged.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([protocolKey, value]) => ({
		protocolKey,
		instanceIds: [...value.instanceIds].sort(),
		since: value.since
	}));
}

export function buildRealtimeControlFilter(input: Readonly<{ channelId: string; creatorPubkey: string; since: number }>): Filter {
	assertChannelId(input.channelId);
	if (!HEX_64.test(input.creatorPubkey)) throw new TypeError('Realtime creator must be a lowercase 64-character public key.');
	assertCreatedAt(input.since);
	return { kinds: [REALTIME_EVENT_KIND], authors: [input.creatorPubkey], '#e': [input.channelId], '#d': [REALTIME_CONTROL_PROTOCOL_KEY], since: input.since } as Filter;
}

export function buildRealtimeInstanceFilter(input: Readonly<{ channelId: string; configuration: RealtimeInstanceFilterConfiguration }>): Filter {
	assertChannelId(input.channelId);
	if (!input.configuration.protocolKey || input.configuration.protocolKey === REALTIME_CONTROL_PROTOCOL_KEY) throw new TypeError('Realtime instance protocol key is invalid.');
	if (input.configuration.instanceIds.length === 0 || input.configuration.instanceIds.some((instanceId) => !INSTANCE_ID.test(instanceId))) throw new TypeError('Realtime instance IDs are invalid.');
	assertCreatedAt(input.configuration.since);
	return { kinds: [REALTIME_EVENT_KIND], '#e': [input.channelId], '#d': [input.configuration.protocolKey], [`#${REALTIME_INSTANCE_TAG}`]: [...new Set(input.configuration.instanceIds)], since: input.configuration.since } as Filter;
}

export function isRealtimeEventKind(kind: number): kind is typeof REALTIME_EVENT_KIND {
	return kind === REALTIME_EVENT_KIND;
}
