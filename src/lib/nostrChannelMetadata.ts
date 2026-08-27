import { verifyEvent, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import type { ChannelReference } from './nostrProtocol';

export const CHANNEL_CREATE_KIND = 40;
export const CHANNEL_METADATA_KIND = 41;

export type ChannelMetadataSource = {
	kind: typeof CHANNEL_CREATE_KIND | typeof CHANNEL_METADATA_KIND;
	eventId: string;
	createdAt: number;
};

export type ResolvedChannelMetadata = {
	channelId: string;
	creatorPubkey: string;
	source: ChannelMetadataSource;
	relays: readonly string[];
	channel: ChannelReference;
};

const NOSTR_EVENT_ID = /^[0-9a-f]{64}$/;

function isVerifiedEvent(event: Event): event is VerifiedEvent {
	try {
		return verifyEvent(event);
	} catch {
		return false;
	}
}

function canonicalizeRelay(relay: string): string | null {
	let url: URL;
	try {
		url = new URL(relay);
	} catch {
		return null;
	}

	if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || !url.hostname) {
		return null;
	}

	return url.toString();
}

function parseAuthoritativeRelays(content: string): readonly string[] | null {
	let metadata: unknown;
	try {
		metadata = JSON.parse(content);
	} catch {
		return null;
	}

	if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
		return null;
	}

	const relays = (metadata as { relays?: unknown }).relays;
	if (!Array.isArray(relays) || relays.length === 0 || relays.some((relay) => typeof relay !== 'string')) {
		return null;
	}

	const canonicalRelays: string[] = [];
	const seen = new Set<string>();
	for (const relay of relays) {
		const canonicalRelay = canonicalizeRelay(relay);
		if (canonicalRelay === null) return null;
		if (!seen.has(canonicalRelay)) {
			seen.add(canonicalRelay);
			canonicalRelays.push(canonicalRelay);
		}
	}

	return canonicalRelays.length > 0 ? canonicalRelays : null;
}

function referencesChannel(event: Event, channelId: string): boolean {
	return event.tags.some((tag) => tag[0] === 'e' && tag[1] === channelId);
}

function selectLatestMetadataEvent(events: readonly VerifiedEvent[], creatorPubkey: string, channelId: string): VerifiedEvent | null {
	const uniqueEvents = new Map<string, VerifiedEvent>();
	for (const event of events) {
		if (
			event.kind === CHANNEL_METADATA_KIND &&
			event.pubkey === creatorPubkey &&
			referencesChannel(event, channelId) &&
			!uniqueEvents.has(event.id)
		) {
			uniqueEvents.set(event.id, event);
		}
	}

	return [...uniqueEvents.values()].sort((left, right) => {
		if (left.created_at !== right.created_at) return right.created_at - left.created_at;
		return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
	})[0] ?? null;
}

/**
 * Resolves NIP-28 channel metadata from already-received events.
 *
 * A malformed current metadata event fails closed. It never revives kind 40
 * or an older kind 41 after a newer valid candidate has been selected.
 */
export function resolveChannelMetadata(
	events: readonly Event[],
	channelId: string,
	preferredRelayHint: string
): ResolvedChannelMetadata | null {
	if (!NOSTR_EVENT_ID.test(channelId)) return null;

	const channelEvent = events.find(
		(event) => event.id === channelId && event.kind === CHANNEL_CREATE_KIND && isVerifiedEvent(event)
	);
	if (!channelEvent) return null;

	const verifiedEvents = events.filter(isVerifiedEvent);
	const latestMetadataEvent = selectLatestMetadataEvent(verifiedEvents, channelEvent.pubkey, channelId);
	const sourceEvent = latestMetadataEvent ?? channelEvent;
	const relays = parseAuthoritativeRelays(sourceEvent.content);
	const canonicalPreferredRelayHint = canonicalizeRelay(preferredRelayHint);
	if (!relays || !canonicalPreferredRelayHint) return null;

	const relayHint = relays.includes(canonicalPreferredRelayHint) ? canonicalPreferredRelayHint : relays[0];
	return {
		channelId,
		creatorPubkey: channelEvent.pubkey,
		source: {
			kind: latestMetadataEvent ? CHANNEL_METADATA_KIND : CHANNEL_CREATE_KIND,
			eventId: sourceEvent.id,
			createdAt: sourceEvent.created_at
		},
		relays,
		channel: {
			channelId,
			relayHint
		}
	};
}
