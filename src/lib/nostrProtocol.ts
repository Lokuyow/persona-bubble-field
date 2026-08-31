import { finalizeEvent, verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { SpeechType } from './conversation';
import type { Character } from './character';
import {
	formatCanonicalGridPosition,
	parseCanonicalGridPosition,
	type GridPosition
} from './geometry';

export const PROTOTYPE_NAMESPACE = 'io.github.lokuyow.persona-bubble-field';
export const CHANNEL_MESSAGE_KIND = 42;
export const POSITION_KIND = 30078;
export const PROFILE_KIND = 0;
export const RECENT_MESSAGE_TIMELINE_LIMIT = 20;
export const POSITION_SLOT_IDENTIFIERS = [
	`${PROTOTYPE_NAMESPACE}:position:0`,
	`${PROTOTYPE_NAMESPACE}:position:1`
] as const;

export type PositionSlot = 0 | 1;

export type ChannelReference = {
	/** NIP-01 event ID. This is the channel identity. */
	channelId: string;
	/** A recommended websocket relay for the channel event, not its identity. */
	relayHint: string;
};

export type WorldMessageInput = {
	channel: ChannelReference;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
	createdAt: number;
};

export type PositionEventInput = {
	channel: ChannelReference;
	position: GridPosition;
	slot: PositionSlot;
	createdAt: number;
};

export type CharacterProfileInput = {
	character: Character;
	absolutePictureUrl: string;
	createdAt: number;
};

export type WorldMessageTemplate = EventTemplate & {
	kind: typeof CHANNEL_MESSAGE_KIND;
};

export type PositionEventTemplate = EventTemplate & {
	kind: typeof POSITION_KIND;
};

export type CharacterProfileTemplate = EventTemplate & {
	kind: typeof PROFILE_KIND;
};

export type WorldEventTemplate = WorldMessageTemplate | PositionEventTemplate;

export type ParsedWorldMessage = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
};

export type ParsedPositionEvent = {
	id: string;
	pubkey: string;
	createdAt: number;
	slot: PositionSlot;
	position: GridPosition;
};

export type LiveFilterOptions = {
	channelId: string;
	since: number;
};

export type TraceFilterOptions = {
	channelId: string;
	positions: readonly GridPosition[];
	since?: number;
	until?: number;
};

const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/;

function assertChannelId(channelId: string): void {
	if (!NOSTR_EVENT_ID.test(channelId)) {
		throw new TypeError('Channel ID must be a 64-character lowercase hexadecimal Nostr event ID.');
	}
}

function assertRelayHint(relayHint: string): void {
	let url: URL;
	try {
		url = new URL(relayHint);
	} catch {
		throw new TypeError('Relay hint must be a websocket URL.');
	}

	if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
		throw new TypeError('Relay hint must be a websocket URL.');
	}
}

function assertCreatedAt(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError('created_at must be a non-negative safe integer in Unix seconds.');
	}
}

function assertAbsolutePictureUrl(value: string): void {
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
	} catch {
		throw new TypeError('Picture URL must be an absolute HTTP(S) URL.');
	}
}

function assertPositionSlot(slot: PositionSlot): void {
	if (slot !== 0 && slot !== 1) {
		throw new TypeError('Position slot must be 0 or 1.');
	}
}

function assertTimeRange(since: number | undefined, until: number | undefined): void {
	if (since !== undefined) assertCreatedAt(since);
	if (until !== undefined) assertCreatedAt(until);
	if (since !== undefined && until !== undefined && since > until) {
		throw new TypeError('since must not be later than until.');
	}
}

function assertChannelReference(channel: ChannelReference): void {
	assertChannelId(channel.channelId);
	assertRelayHint(channel.relayHint);
}

function speechLabel(speechType: SpeechType): string[] | null {
	if (speechType === 'normal') return null;
	if (speechType === 'shout') return ['l', 'speech:shout', PROTOTYPE_NAMESPACE];
	if (speechType === 'monologue') return ['l', 'speech:monologue', PROTOTYPE_NAMESPACE];
	throw new TypeError('Speech type must be normal, shout, or monologue.');
}

function rootTags(channel: ChannelReference): string[][] {
	return [
		['e', channel.channelId, channel.relayHint, 'root'],
		['L', PROTOTYPE_NAMESPACE],
		['l', 'chat', PROTOTYPE_NAMESPACE]
	];
}

export function buildWorldMessageTemplate(input: WorldMessageInput): WorldMessageTemplate {
	assertChannelReference(input.channel);
	assertCreatedAt(input.createdAt);
	const tags = [
		...rootTags(input.channel),
		['w', formatCanonicalGridPosition(input.position)]
	];
	const label = speechLabel(input.speechType);
	if (label) tags.push(label);

	return {
		kind: CHANNEL_MESSAGE_KIND,
		created_at: input.createdAt,
		tags,
		content: input.content
	};
}

export function buildPositionEventTemplate(input: PositionEventInput): PositionEventTemplate {
	assertChannelReference(input.channel);
	assertCreatedAt(input.createdAt);
	assertPositionSlot(input.slot);

	return {
		kind: POSITION_KIND,
		created_at: input.createdAt,
		tags: [
			['d', POSITION_SLOT_IDENTIFIERS[input.slot]],
			['e', input.channel.channelId, input.channel.relayHint]
		],
		content: formatCanonicalGridPosition(input.position)
	};
}

export function buildCharacterProfileTemplate(input: CharacterProfileInput): CharacterProfileTemplate {
	assertCreatedAt(input.createdAt);
	assertAbsolutePictureUrl(input.absolutePictureUrl);

	return {
		kind: PROFILE_KIND,
		created_at: input.createdAt,
		tags: [],
		content: JSON.stringify({
			name: input.character.name,
			about: input.character.about,
			picture: input.absolutePictureUrl
		})
	};
}

/** Delegates ID generation and Schnorr signing to nostr-tools. */
export function finalizeWorldEvent(template: WorldEventTemplate, secretKey: Uint8Array): VerifiedEvent {
	return finalizeEvent(template, secretKey);
}

/** Delegates ID generation and Schnorr signing to nostr-tools. */
export function finalizeCharacterProfileEvent(
	template: CharacterProfileTemplate,
	secretKey: Uint8Array
): VerifiedEvent {
	return finalizeEvent(template, secretKey);
}

function getProjectRootIds(event: Event): string[] {
	return event.tags
		.filter((tag) => tag[0] === 'e' && tag[3] === 'root')
		.map((tag) => tag[1]);
}

function hasProjectChatLabel(event: Event): boolean {
	return event.tags.some((tag) =>
		tag[0] === 'l' && tag[1] === 'chat' && tag[2] === PROTOTYPE_NAMESPACE
	);
}

function parseSpeechType(event: Event): SpeechType | null {
	const labels = event.tags.filter((tag) => tag[0] === 'l' && tag[2] === PROTOTYPE_NAMESPACE);
	const speechLabels = labels.filter((tag) => tag[1]?.startsWith('speech:'));
	if (speechLabels.some((tag) => tag[1] !== 'speech:shout' && tag[1] !== 'speech:monologue')) return null;

	const values = new Set(speechLabels.map((tag) => tag[1]));
	if (values.size === 0) return 'normal';
	if (values.size !== 1) return null;
	return values.has('speech:shout') ? 'shout' : 'monologue';
}

function parseUnambiguousWorldPosition(event: Event): GridPosition | null {
	const values = event.tags.filter((tag) => tag[0] === 'w').map((tag) => tag[1]);
	if (values.length !== 1) return null;

	return parseCanonicalGridPosition(values[0]);
}

function matchesChannelRoot(event: Event, channelId: string): boolean {
	const rootIds = getProjectRootIds(event);
	return rootIds.length > 0 && rootIds.every((id) => id === channelId);
}

function isVerifiedEvent(event: Event): event is VerifiedEvent {
	try {
		return verifyEvent(event);
	} catch {
		return false;
	}
}

/**
 * Validates a received kind 42 for this project's semantics. Relay hints are
 * intentionally ignored: the target kind 40 event ID is the channel identity.
 */
export function parseWorldMessage(event: Event, channelId: string): ParsedWorldMessage | null {
	assertChannelId(channelId);
	if (!isVerifiedEvent(event) || event.kind !== CHANNEL_MESSAGE_KIND) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!matchesChannelRoot(event, channelId)) return null;
	if (!event.tags.some((tag) => tag[0] === 'L' && tag[1] === PROTOTYPE_NAMESPACE)) return null;
	if (!hasProjectChatLabel(event)) return null;

	const speechType = parseSpeechType(event);
	const position = parseUnambiguousWorldPosition(event);
	if (!speechType || !position) return null;

	return {
		id: event.id,
		pubkey: event.pubkey,
		createdAt: event.created_at,
		content: event.content,
		speechType,
		position
	};
}

function parsePositionSlot(event: Event): PositionSlot | null {
	const identifiers = event.tags.filter((tag) => tag[0] === 'd').map((tag) => tag[1]);
	if (identifiers.length !== 1) return null;
	if (identifiers[0] === POSITION_SLOT_IDENTIFIERS[0]) return 0;
	if (identifiers[0] === POSITION_SLOT_IDENTIFIERS[1]) return 1;
	return null;
}

function referencesChannel(event: Event, channelId: string): boolean {
	const referencedEventIds = event.tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1]);
	return referencedEventIds.length > 0 && referencedEventIds.every((eventId) => eventId === channelId);
}

/**
 * Validates a received kind 30078 position event. Its channel reference is
 * matched by event ID only; relay hints remain non-authoritative recommendations.
 */
export function parsePositionEvent(event: Event, channelId: string): ParsedPositionEvent | null {
	assertChannelId(channelId);
	if (!isVerifiedEvent(event) || event.kind !== POSITION_KIND) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!referencesChannel(event, channelId)) return null;

	const slot = parsePositionSlot(event);
	const position = parseCanonicalGridPosition(event.content);
	if (slot === null || !position) return null;

	return {
		id: event.id,
		pubkey: event.pubkey,
		createdAt: event.created_at,
		slot,
		position
	};
}

export function buildWorldMessageFilter(options: LiveFilterOptions): Filter {
	assertChannelId(options.channelId);
	assertCreatedAt(options.since);
	return {
		kinds: [CHANNEL_MESSAGE_KIND],
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		since: options.since
	};
}

export function buildWorldMessageHistoryFilter(options: Pick<LiveFilterOptions, 'channelId'>): Filter {
	assertChannelId(options.channelId);
	return {
		kinds: [CHANNEL_MESSAGE_KIND],
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		limit: RECENT_MESSAGE_TIMELINE_LIMIT
	};
}

export function buildWorldMessageFilters(options: LiveFilterOptions): [Filter, Filter] {
	return [buildWorldMessageFilter(options), buildWorldMessageHistoryFilter(options)];
}

export function buildPositionFilter(options: LiveFilterOptions): Filter {
	assertChannelId(options.channelId);
	assertCreatedAt(options.since);
	return {
		kinds: [POSITION_KIND],
		'#d': [...POSITION_SLOT_IDENTIFIERS],
		'#e': [options.channelId],
		since: options.since
	};
}

export function buildTraceMessageFilter(options: TraceFilterOptions): Filter {
	assertChannelId(options.channelId);
	assertTimeRange(options.since, options.until);
	if (options.positions.length === 0) {
		throw new TypeError('Trace filters require at least one position.');
	}

	return {
		kinds: [CHANNEL_MESSAGE_KIND],
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		'#w': options.positions.map(formatCanonicalGridPosition),
		...(options.since === undefined ? {} : { since: options.since }),
		...(options.until === undefined ? {} : { until: options.until })
	};
}
