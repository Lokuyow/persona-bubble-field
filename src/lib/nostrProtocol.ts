import { finalizeEvent, verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import type { SpeechType } from './conversation';
import type { Character } from './character';
import { resolveWorldCharacterFromPubkey } from './worldCharacterAssignment';
import {
	formatCanonicalGridPosition,
	parseCanonicalGridPosition,
	type GridPosition
} from './geometry';

export const PROTOTYPE_NAMESPACE = 'io.github.lokuyow.persona-bubble-field';
export const CHANNEL_MESSAGE_KIND = 42;
export const TRACE_REPLY_KIND = 1111;
export const WORLD_STATE_KIND = 30079;
export const PROFILE_KIND = 0;
export const RECENT_MESSAGE_TIMELINE_LIMIT = 50;
export const WORLD_STATE_SLOT_SUFFIXES = ['0', '1', 'exit'] as const;
export type WorldStateSlot = 0 | 1;
export type WorldStateState = 'active' | 'exit';

export function worldStateIdentifier(channelId: string, slot: WorldStateSlot | 'exit'): string {
	assertChannelId(channelId);
	return `${PROTOTYPE_NAMESPACE}:world-state:1:${channelId}:${slot}`;
}

export function worldStateIdentifiers(channelId: string): readonly string[] {
	return WORLD_STATE_SLOT_SUFFIXES.map((slot) => worldStateIdentifier(channelId, slot === 'exit' ? 'exit' : Number(slot) as WorldStateSlot));
}

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

export type WorldStateEventInput = {
	channel: ChannelReference;
	position: GridPosition;
	slot: WorldStateSlot | 'exit';
	createdAt: number;
	runNumber?: number;
	exitReason?: 'death' | 'clear';
};

export type DeathTraceEventInput = {
	channel: ChannelReference;
	content: string;
	position: GridPosition;
	createdAt: number;
};


export type TraceReplyInput = {
	root: ParsedWorldMessage;
	parent: ParsedWorldMessage | ParsedTraceReply;
	content: string;
	speechType: SpeechType;
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

export type WorldStateEventTemplate = EventTemplate & {
	kind: typeof WORLD_STATE_KIND;
};

export type DeathTraceEventTemplate = EventTemplate & {
	kind: typeof CHANNEL_MESSAGE_KIND;
};


export type TraceReplyTemplate = EventTemplate & {
	kind: typeof TRACE_REPLY_KIND;
};

export type CharacterProfileTemplate = EventTemplate & {
	kind: typeof PROFILE_KIND;
};

export type WorldEventTemplate = WorldMessageTemplate | WorldStateEventTemplate | DeathTraceEventTemplate | TraceReplyTemplate;

export type ParsedWorldMessage = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
	position: GridPosition;
	source?: 'message' | 'death';
};

export type ParsedWorldStateEvent = {
	id: string;
	pubkey: string;
	createdAt: number;
	state: WorldStateState;
	slot: WorldStateSlot | null;
	position: GridPosition;
	runNumber?: number | null;
	exitReason?: 'death' | 'clear' | null;
};

export type ParsedTraceEvent = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: 'normal';
	position: GridPosition;
	source: 'death';
};


/** A structurally valid kind 1111 whose root and parent still need lookup. */
export type ParsedTraceReplyCandidate = {
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
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

function assertWorldStateSlot(slot: WorldStateSlot | 'exit'): void {
	if (slot !== 0 && slot !== 1) {
		if (slot !== 'exit') throw new TypeError('World State slot must be 0, 1, or exit.');
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
		['l', 'chat', PROTOTYPE_NAMESPACE]
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

export function buildWorldStateEventTemplate(input: WorldStateEventInput): WorldStateEventTemplate {
	assertChannelReference(input.channel);
	assertCreatedAt(input.createdAt);
	assertWorldStateSlot(input.slot);
	if (input.runNumber !== undefined && (!Number.isSafeInteger(input.runNumber) || input.runNumber < 1)) throw new TypeError('Invalid World State Run number.');
	if (input.exitReason !== undefined && (input.slot !== 'exit' || input.runNumber === undefined)) throw new TypeError('Exit reason requires a Run-scoped terminal exit.');
	const tags = [
		['d', worldStateIdentifier(input.channel.channelId, input.slot)],
		['e', input.channel.channelId, input.channel.relayHint],
		...(input.runNumber === undefined ? [] : [['r', String(input.runNumber)]]),
		...(input.exitReason === undefined ? [] : [['reason', input.exitReason]])
	];

	return {
		kind: WORLD_STATE_KIND,
		created_at: input.createdAt,
		tags,
		content: formatCanonicalGridPosition(input.position)
	};
}

export function buildDeathTraceEventTemplate(input: DeathTraceEventInput): DeathTraceEventTemplate {
	assertChannelReference(input.channel);
	assertCreatedAt(input.createdAt);
	return {
		kind: CHANNEL_MESSAGE_KIND,
		created_at: input.createdAt,
		tags: [
			['e', input.channel.channelId, input.channel.relayHint, 'root'],
			['w', formatCanonicalGridPosition(input.position)],
			['L', PROTOTYPE_NAMESPACE],
			['l', 'trace', PROTOTYPE_NAMESPACE],
			['l', 'trace:death', PROTOTYPE_NAMESPACE]
		],
		content: input.content
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

function hasExactlyProjectLabel(event: Event, value: string): boolean {
	return event.tags.filter((tag) => tag[0] === 'l' && tag[1] === value && tag[2] === PROTOTYPE_NAMESPACE).length === 1;
}

function hasProjectLabel(event: Event, value: string): boolean {
	return event.tags.some((tag) => tag[0] === 'l' && tag[1] === value && tag[2] === PROTOTYPE_NAMESPACE);
}

function hasProjectTraceLabel(event: Event): boolean {
	return event.tags.some((tag) =>
		tag[0] === 'l' && (tag[1] === 'trace' || tag[1]?.startsWith('trace:')) && tag[2] === PROTOTYPE_NAMESPACE
	);
}

function hasProjectSpeechLabel(event: Event): boolean {
	return event.tags.some((tag) => tag[0] === 'l' && tag[2] === PROTOTYPE_NAMESPACE && tag[1]?.startsWith('speech:'));
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

function hasAssignedCharacter(event: Event): boolean {
	try {
		return resolveWorldCharacterFromPubkey(event.pubkey) !== undefined;
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
	if (!isVerifiedEvent(event) || event.kind !== CHANNEL_MESSAGE_KIND || !hasAssignedCharacter(event)) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!hasExactlyChannelRootRelation(event, channelId)) return null;
	if (!event.tags.some((tag) => tag[0] === 'L' && tag[1] === PROTOTYPE_NAMESPACE)) return null;
	if (!hasExactlyProjectLabel(event, 'chat') || hasProjectTraceLabel(event)) return null;

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
	if (!isVerifiedEvent(event) || event.kind !== TRACE_REPLY_KIND || !hasAssignedCharacter(event)) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!event.tags.some((tag) => tag[0] === 'L' && tag[1] === PROTOTYPE_NAMESPACE)) return null;
	if (!hasExactlyProjectLabel(event, 'chat') || hasProjectTraceLabel(event)) return null;
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
	if (!speechType) return null;

	return {
		id: event.id,
		pubkey: event.pubkey,
		createdAt: event.created_at,
		content: event.content,
		speechType,
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
		rootId: root.id,
		rootPubkey: root.pubkey,
		parentId: parent.id,
		parentKind,
		parentPubkey: parent.pubkey
	};
}

function parseWorldStateSlot(event: Event, channelId: string): WorldStateSlot | 'exit' | null {
	const identifiers = event.tags.filter((tag) => tag[0] === 'd').map((tag) => tag[1]);
	if (identifiers.length !== 1) return null;
	if (identifiers[0] === worldStateIdentifier(channelId, 0)) return 0;
	if (identifiers[0] === worldStateIdentifier(channelId, 1)) return 1;
	if (identifiers[0] === worldStateIdentifier(channelId, 'exit')) return 'exit';
	return null;
}

function referencesChannel(event: Event, channelId: string): boolean {
	const referencedEventIds = event.tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1]);
	return referencedEventIds.length === 1 && referencedEventIds[0] === channelId;
}

/**
 * Validates a received experimental kind 30079 position event. Its channel reference is
 * matched by event ID only; relay hints remain non-authoritative recommendations.
 */
export function parseWorldStateEvent(event: Event, channelId: string): ParsedWorldStateEvent | null {
	assertChannelId(channelId);
	if (!isVerifiedEvent(event) || event.kind !== WORLD_STATE_KIND || !hasAssignedCharacter(event)) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!referencesChannel(event, channelId)) return null;

	const slot = parseWorldStateSlot(event, channelId);
	const position = parseCanonicalGridPosition(event.content);
	if (slot === null || !position) return null;
	const runTags = event.tags.filter((tag) => tag[0] === 'r');
	const reasonTags = event.tags.filter((tag) => tag[0] === 'reason');
	if (runTags.length > 1 || reasonTags.length > 1) return null;
	const runNumber = runTags.length ? Number(runTags[0][1]) : null;
	if (runNumber !== null && (!Number.isSafeInteger(runNumber) || runNumber < 1)) return null;
	const exitReason = reasonTags.length && (reasonTags[0][1] === 'death' || reasonTags[0][1] === 'clear') ? reasonTags[0][1] : null;
	if (reasonTags.length && (!exitReason || slot !== 'exit' || runNumber === null)) return null;

	return {
		id: event.id,
		pubkey: event.pubkey,
		createdAt: event.created_at,
		state: slot === 'exit' ? 'exit' : 'active',
		slot: slot === 'exit' ? null : slot,
		position,
		runNumber,
		exitReason
	};
}

export function parseTraceEvent(event: Event, channelId: string): ParsedTraceEvent | null {
	assertChannelId(channelId);
	if (!isVerifiedEvent(event) || event.kind !== CHANNEL_MESSAGE_KIND || !hasAssignedCharacter(event)) return null;
	if (!Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	if (!hasExactlyChannelRootRelation(event, channelId)) return null;
	if (!event.tags.some((tag) => tag[0] === 'L' && tag[1] === PROTOTYPE_NAMESPACE)) return null;
	if (event.tags.some((tag) => tag[0] === 'd')) return null;
	if (hasProjectLabel(event, 'chat') || !hasExactlyProjectLabel(event, 'trace')) return null;
	const sourceTags = event.tags.filter((tag) => tag[0] === 'l' && tag[2] === PROTOTYPE_NAMESPACE && tag[1]?.startsWith('trace:'));
	if (sourceTags.length !== 1 || sourceTags[0][1] !== 'trace:death' || hasProjectSpeechLabel(event)) return null;
	const position = parseUnambiguousWorldPosition(event);
	if (!position) return null;
	return { id: event.id, pubkey: event.pubkey, createdAt: event.created_at, content: event.content, speechType: 'normal', position, source: 'death' };
}

export function buildWorldMessageFilter(options: LiveFilterOptions): Filter {
	assertChannelId(options.channelId);
	assertCreatedAt(options.since);
	return {
		kinds: [CHANNEL_MESSAGE_KIND],
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat', 'trace'],
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

export function buildWorldStateFilter(options: LiveFilterOptions): Filter {
	assertChannelId(options.channelId);
	assertCreatedAt(options.since);
	return {
		kinds: [WORLD_STATE_KIND],
		'#d': [...worldStateIdentifiers(options.channelId)],
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

export function buildTraceRootBootstrapFilters(options: TraceRootBootstrapFilterOptions): [Filter, Filter] {
	assertChannelId(options.channelId);
	const base = {
		'#e': [options.channelId],
		'#L': [PROTOTYPE_NAMESPACE],
		limit: TRACE_ROOT_BOOTSTRAP_LIMIT
	};
	return [
		{ kinds: [CHANNEL_MESSAGE_KIND], ...base, '#l': ['chat'] },
		{ kinds: [CHANNEL_MESSAGE_KIND], ...base, '#l': ['trace'] }
	];
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
	// Relay compatibility requires the production notification query to remain
	// the three-tag query. Effective-root and parent consistency is established
	// after parsing through the existing Trace reply validator/cache.
	return {
		kinds: [TRACE_REPLY_KIND],
		'#p': [options.personaPubkey],
		'#L': [PROTOTYPE_NAMESPACE],
		'#l': ['chat']
	};
}
