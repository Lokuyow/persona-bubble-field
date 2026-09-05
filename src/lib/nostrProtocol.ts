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
export const TRACE_REPLY_KIND = 1111;
export const POSITION_KIND = 30078;
export const PROFILE_KIND = 0;
export const RECENT_MESSAGE_TIMELINE_LIMIT = 50;
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

export type TraceReplyInput = {
	root: ParsedWorldMessage;
	parent: ParsedWorldMessage | ParsedTraceReply;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
	createdAt: number;
	/** An authoritative world relay recommendation, never an event identity. */
	relayHint?: string;
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

export type TraceReplyTemplate = EventTemplate & {
	kind: typeof TRACE_REPLY_KIND;
};

export type CharacterProfileTemplate = EventTemplate & {
	kind: typeof PROFILE_KIND;
};

export type WorldEventTemplate = WorldMessageTemplate | PositionEventTemplate | TraceReplyTemplate;

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

/** A structurally valid kind 1111 whose root and parent still need lookup. */
export type ParsedTraceReplyCandidate = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
	rootId: string;
	rootPubkey: string;
	rootAuthorHint?: string;
	parentId: string;
	parentKind: typeof CHANNEL_MESSAGE_KIND | typeof TRACE_REPLY_KIND;
	parentAuthorHints: readonly string[];
	parentAuthorHint?: string;
};

/** A kind 1111 whose root and immediate parent were both semantically verified. */
export type ParsedTraceReply = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
	rootId: string;
	rootPubkey: string;
	parentId: string;
	parentKind: typeof CHANNEL_MESSAGE_KIND | typeof TRACE_REPLY_KIND;
	parentPubkey: string;
};

export type LiveFilterOptions = {
	channelId: string;
	since: number;
};

export type TraceRootBootstrapFilterOptions = Pick<LiveFilterOptions, 'channelId'>;

export type TraceReplyFilterOptions = {
	rootId: string;
};

export type TraceDirectReplyFilterOptions = {
	currentId: string;
};

export type TraceNotificationFilterOptions = {
	personaPubkey: string;
	effectiveRootIds?: readonly string[];
};

const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/;
const TRACE_ROOT_BOOTSTRAP_LIMIT = 1000;
const TRACE_REPLY_INITIAL_LIMIT = 100;

function assertChannelId(channelId: string): void {
	assertNostrEventId(channelId, 'Channel ID');
}

function assertNostrEventId(value: string, label: string): void {
	if (!NOSTR_EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a 64-character lowercase hexadecimal Nostr event ID.`);
	}
}

function assertPubkey(value: string, label: string): void {
	if (!NOSTR_EVENT_ID.test(value)) {
		throw new TypeError(`${label} must be a 64-character lowercase hexadecimal Nostr pubkey.`);
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

function isParsedTraceReply(value: ParsedWorldMessage | ParsedTraceReply): value is ParsedTraceReply {
	return 'rootId' in value;
}

function assertMessageReference(message: ParsedWorldMessage, label: string): void {
	assertNostrEventId(message.id, `${label} ID`);
	assertPubkey(message.pubkey, `${label} pubkey`);
}

function assertTraceReplyReference(reply: ParsedTraceReply, label: string): void {
	assertNostrEventId(reply.id, `${label} ID`);
	assertPubkey(reply.pubkey, `${label} pubkey`);
	assertNostrEventId(reply.rootId, `${label} root ID`);
	assertPubkey(reply.rootPubkey, `${label} root pubkey`);
}

function regularEventPointer(tagName: 'E' | 'e', id: string, pubkey: string, relayHint?: string): string[] {
	return [tagName, id, relayHint ?? '', pubkey];
}

export function buildTraceReplyTemplate(input: TraceReplyInput): TraceReplyTemplate {
	assertMessageReference(input.root, 'Root');
	assertCreatedAt(input.createdAt);
	if (input.relayHint !== undefined) assertRelayHint(input.relayHint);

	const parentKind = isParsedTraceReply(input.parent) ? TRACE_REPLY_KIND : CHANNEL_MESSAGE_KIND;
	if (isParsedTraceReply(input.parent)) {
		assertTraceReplyReference(input.parent, 'Parent');
		if (input.parent.rootId !== input.root.id || input.parent.rootPubkey !== input.root.pubkey) {
			throw new TypeError('Reply parent must belong to the supplied root tree.');
		}
	} else {
		assertMessageReference(input.parent, 'Parent');
		if (input.parent.id !== input.root.id || input.parent.pubkey !== input.root.pubkey) {
			throw new TypeError('A kind 42 reply parent must be the supplied root.');
		}
	}

	const tags = [
		regularEventPointer('E', input.root.id, input.root.pubkey, input.relayHint),
		['K', String(CHANNEL_MESSAGE_KIND)],
		['P', input.root.pubkey],
		regularEventPointer('e', input.parent.id, input.parent.pubkey, input.relayHint),
		['k', String(parentKind)],
		['p', input.parent.pubkey],
		['L', PROTOTYPE_NAMESPACE],
		['l', 'chat', PROTOTYPE_NAMESPACE],
		['w', formatCanonicalGridPosition(input.position)]
	];
	const label = speechLabel(input.speechType);
	if (label) tags.push(label);

	return {
		kind: TRACE_REPLY_KIND,
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

function hasExactlyChannelRootRelation(event: Event, channelId: string): boolean {
	const relations = event.tags.filter((tag) => tag[0] === 'e');
	return relations.length === 1 && relations[0][1] === channelId && relations[0][3] === 'root';
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
	if (!hasExactlyChannelRootRelation(event, channelId)) return null;
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

function exactlyOneTag(event: Event, name: string): string[] | null {
	const tags = event.tags.filter((tag) => tag[0] === name);
	return tags.length === 1 ? tags[0] : null;
}

function validPointerAuthorHint(tag: readonly string[]): string | null | undefined {
	const hint = tag[3];
	if (hint === undefined) return undefined;
	return NOSTR_EVENT_ID.test(hint) ? hint : null;
}

/**
 * Validates only an event's own kind 1111 structure. The resulting candidate
 * must still be compared with accepted root and parent events before use.
 */
export function parseTraceReplyCandidate(event: Event): ParsedTraceReplyCandidate | null {
	if (!isVerifiedEvent(event) || event.kind !== TRACE_REPLY_KIND) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!event.tags.some((tag) => tag[0] === 'L' && tag[1] === PROTOTYPE_NAMESPACE)) return null;
	if (!hasProjectChatLabel(event)) return null;
	if (event.tags.some((tag) => ['A', 'I', 'a', 'i'].includes(tag[0]))) return null;

	const rootEvent = exactlyOneTag(event, 'E');
	const rootKind = exactlyOneTag(event, 'K');
	const rootAuthor = exactlyOneTag(event, 'P');
	const parentEvent = exactlyOneTag(event, 'e');
	const parentKind = exactlyOneTag(event, 'k');
	if (!rootEvent || !rootKind || !rootAuthor || !parentEvent || !parentKind) return null;
	if (!NOSTR_EVENT_ID.test(rootEvent[1]) || rootKind[1] !== String(CHANNEL_MESSAGE_KIND) || !NOSTR_EVENT_ID.test(rootAuthor[1])) return null;
	if (!NOSTR_EVENT_ID.test(parentEvent[1])) return null;
	if (parentKind[1] !== String(CHANNEL_MESSAGE_KIND) && parentKind[1] !== String(TRACE_REPLY_KIND)) return null;

	const rootAuthorHint = validPointerAuthorHint(rootEvent);
	const parentAuthorHint = validPointerAuthorHint(parentEvent);
	if (rootAuthorHint === null || parentAuthorHint === null) return null;

	const speechType = parseSpeechType(event);
	const position = parseUnambiguousWorldPosition(event);
	if (!speechType || !position) return null;

	return {
		id: event.id,
		pubkey: event.pubkey,
		createdAt: event.created_at,
		content: event.content,
		speechType,
		position,
		rootId: rootEvent[1],
		rootPubkey: rootAuthor[1],
		...(rootAuthorHint === undefined ? {} : { rootAuthorHint }),
		parentId: parentEvent[1],
		parentKind: parentKind[1] === String(CHANNEL_MESSAGE_KIND) ? CHANNEL_MESSAGE_KIND : TRACE_REPLY_KIND,
		parentAuthorHints: event.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]),
		...(parentAuthorHint === undefined ? {} : { parentAuthorHint })
	};
}

/**
 * Resolves a structural candidate against already accepted events without
 * owning transport, cache, pending-parent, or tree orchestration state.
 */
export function validateTraceReplyCandidate(
	candidate: ParsedTraceReplyCandidate,
	root: ParsedWorldMessage,
	parent: ParsedWorldMessage | ParsedTraceReply
): ParsedTraceReply | null {
	if (candidate.rootId !== root.id || candidate.rootPubkey !== root.pubkey) return null;
	if (candidate.rootAuthorHint !== undefined && candidate.rootAuthorHint !== root.pubkey) return null;

	const parentKind = isParsedTraceReply(parent) ? TRACE_REPLY_KIND : CHANNEL_MESSAGE_KIND;
	if (isParsedTraceReply(parent) && (parent.rootId !== root.id || parent.rootPubkey !== root.pubkey)) return null;
	if (!isParsedTraceReply(parent) && (parent.id !== root.id || parent.pubkey !== root.pubkey)) return null;
	if (candidate.parentId !== parent.id || candidate.parentKind !== parentKind) return null;
	if (!candidate.parentAuthorHints.includes(parent.pubkey)) return null;
	if (candidate.parentAuthorHint !== undefined && candidate.parentAuthorHint !== parent.pubkey) return null;

	return {
		id: candidate.id,
		pubkey: candidate.pubkey,
		createdAt: candidate.createdAt,
		content: candidate.content,
		speechType: candidate.speechType,
		position: candidate.position,
		rootId: root.id,
		rootPubkey: root.pubkey,
		parentId: parent.id,
		parentKind,
		parentPubkey: parent.pubkey
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

export function buildTraceRootBootstrapFilter(options: TraceRootBootstrapFilterOptions): Filter {
	assertChannelId(options.channelId);
	return {
		kinds: [CHANNEL_MESSAGE_KIND],
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		limit: TRACE_ROOT_BOOTSTRAP_LIMIT
	};
}

export function buildTraceReplyFilter(options: TraceReplyFilterOptions): Filter {
	assertNostrEventId(options.rootId, 'Root ID');
	return {
		kinds: [TRACE_REPLY_KIND],
		'#E': [options.rootId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		limit: TRACE_REPLY_INITIAL_LIMIT
	};
}

export function buildTraceDirectReplyFilter(options: TraceDirectReplyFilterOptions): Filter {
	assertNostrEventId(options.currentId, 'Current event ID');
	return {
		kinds: [TRACE_REPLY_KIND],
		'#e': [options.currentId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		limit: TRACE_REPLY_INITIAL_LIMIT
	};
}

export function buildTraceNotificationFilter(options: TraceNotificationFilterOptions): Filter {
	assertPubkey(options.personaPubkey, 'Persona pubkey');
	if (options.effectiveRootIds !== undefined) {
		for (const rootId of options.effectiveRootIds) assertNostrEventId(rootId, 'Effective root ID');
	}
	return {
		kinds: [TRACE_REPLY_KIND],
		'#p': [options.personaPubkey],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat'],
		...(options.effectiveRootIds && options.effectiveRootIds.length > 0
			? { '#E': [...options.effectiveRootIds] }
			: {})
	};
}
