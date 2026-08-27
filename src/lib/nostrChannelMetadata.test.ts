import { describe, expect, it } from 'vitest';
import { finalizeEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import {
	CHANNEL_CREATE_KIND,
	CHANNEL_METADATA_KIND,
	resolveChannelMetadata
} from './nostrChannelMetadata';
import {
	PROTOTYPE_CHANNEL_ID,
	PROTOTYPE_METADATA_DISCOVERY_RELAYS,
	PROTOTYPE_PREFERRED_WORLD_RELAY_HINT,
	PROTOTYPE_WORLD_CONFIG
} from './prototypeWorld';

const CREATOR_SECRET_KEY = new Uint8Array(32).fill(1);
const OTHER_SECRET_KEY = new Uint8Array(32).fill(2);

function signedEvent(template: EventTemplate, secretKey = CREATOR_SECRET_KEY): VerifiedEvent {
	return finalizeEvent(template, secretKey);
}

function channelEvent(content = '{"relays":["wss://metadata.example/"]}'): VerifiedEvent {
	return signedEvent({
		kind: CHANNEL_CREATE_KIND,
		created_at: 1_700_000_000,
		tags: [],
		content
	});
}

function metadataEvent(
	channelId: string,
	content: string,
	override: Partial<EventTemplate> = {},
	secretKey = CREATOR_SECRET_KEY
): VerifiedEvent {
	return signedEvent({
		kind: CHANNEL_METADATA_KIND,
		created_at: 1_700_000_001,
		tags: [['e', channelId, 'wss://tag-hint.example', 'unexpected-marker']],
		content,
		...override
	}, secretKey);
}

function receivedCopy(event: Event): Event {
	return {
		id: event.id,
		pubkey: event.pubkey,
		created_at: event.created_at,
		kind: event.kind,
		tags: event.tags.map((tag) => [...tag]),
		content: event.content,
		sig: event.sig
	};
}

describe('prototype world config', () => {
	it('exposes only the prototype channel and metadata discovery settings', () => {
		expect(PROTOTYPE_CHANNEL_ID).toBe('3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b');
		expect(PROTOTYPE_METADATA_DISCOVERY_RELAYS).toEqual([
			'wss://nos.lol/',
			'wss://x.kojira.io/',
			'wss://relay.nostr.wirednet.jp/',
			'wss://yabu.me/'
		]);
		expect(PROTOTYPE_PREFERRED_WORLD_RELAY_HINT).toBe('wss://nos.lol/');
		expect(PROTOTYPE_WORLD_CONFIG).not.toHaveProperty('relays');
		expect(PROTOTYPE_WORLD_CONFIG.metadataDiscoveryRelays).toBe(PROTOTYPE_METADATA_DISCOVERY_RELAYS);
	});
});

describe('NIP-28 channel metadata resolution', () => {
	it('accepts an exact verified kind 40 and uses its creator and metadata', () => {
		const channel = channelEvent('{"name":"Prototype","relays":["wss://nos.lol"]}');
		const resolved = resolveChannelMetadata([channel], channel.id, 'wss://nos.lol');

		expect(resolved).toEqual({
			channelId: channel.id,
			creatorPubkey: channel.pubkey,
			source: { kind: 40, eventId: channel.id, createdAt: channel.created_at },
			relays: ['wss://nos.lol/'],
			channel: { channelId: channel.id, relayHint: 'wss://nos.lol/' }
		});
	});

	it.each([
		['wrong ID', (channel: VerifiedEvent) => channel.id.replace(/^./, 'f')],
		['wrong kind', (channel: VerifiedEvent) => channel.id]
	])('does not accept a %s kind 40 candidate', (label, requestedId) => {
		const channel = channelEvent();
		const event = label === 'wrong kind'
			? signedEvent({ ...channel, kind: 41 })
			: channel;

		expect(resolveChannelMetadata([event], requestedId(event as VerifiedEvent), 'wss://metadata.example/')).toBeNull();
	});

	it('rejects tampered kind 40 content, tags, or signature', () => {
		const channel = channelEvent();
		const contentTampered = receivedCopy(channel);
		contentTampered.content = '{"relays":["wss://tampered.example/"]}';
		const tagsTampered = receivedCopy(channel);
		tagsTampered.tags.push(['client', 'tampered']);
		const signatureTampered = receivedCopy(channel);
		signatureTampered.sig = '0'.repeat(128);

		for (const tampered of [contentTampered, tagsTampered, signatureTampered]) {
			expect(resolveChannelMetadata([tampered], channel.id, 'wss://metadata.example/')).toBeNull();
		}
	});

	it('uses a verified creator-authored target-channel kind 41 as the current source', () => {
		const channel = channelEvent('{"relays":["wss://initial.example/"]}');
		const metadata = metadataEvent(channel.id, '{"name":"Updated","relays":["wss://updated.example"]}');

		const resolved = resolveChannelMetadata([metadata, channel], channel.id, 'wss://updated.example');

		expect(resolved?.source).toEqual({ kind: 41, eventId: metadata.id, createdAt: metadata.created_at });
		expect(resolved?.relays).toEqual(['wss://updated.example/']);
	});

	it('ignores other creators and kind 41 events for unrelated channels', () => {
		const channel = channelEvent('{"relays":["wss://initial.example/"]}');
		const otherCreator = metadataEvent(channel.id, '{"relays":["wss://other.example/"]}', {}, OTHER_SECRET_KEY);
		const unrelatedChannel = channelEvent();
		const unrelated = metadataEvent(unrelatedChannel.id, '{"relays":["wss://unrelated.example/"]}');

		const resolved = resolveChannelMetadata([otherCreator, unrelated, channel], channel.id, 'wss://initial.example/');

		expect(resolved?.source.kind).toBe(40);
		expect(resolved?.relays).toEqual(['wss://initial.example/']);
	});

	it('uses e tag value only for channel identity and deduplicates repeated events', () => {
		const channel = channelEvent();
		const metadata = metadataEvent(channel.id, '{"relays":["wss://updated.example/"]}');

		const resolved = resolveChannelMetadata(
			[metadata, receivedCopy(metadata), channel],
			channel.id,
			'wss://updated.example/'
		);

		expect(resolved?.source.eventId).toBe(metadata.id);
	});

	it('selects the greatest created_at independently of arrival order', () => {
		const channel = channelEvent();
		const older = metadataEvent(channel.id, '{"relays":["wss://older.example/"]}', { created_at: 10 });
		const newer = metadataEvent(channel.id, '{"relays":["wss://newer.example/"]}', { created_at: 20 });

		const resolved = resolveChannelMetadata([newer, channel, older], channel.id, 'wss://newer.example/');

		expect(resolved?.source.eventId).toBe(newer.id);
	});

	it('selects the lexicographically lowest ID at the same created_at', () => {
		const channel = channelEvent();
		const first = metadataEvent(channel.id, '{"relays":["wss://first.example/"]}', { created_at: 20 });
		const second = metadataEvent(channel.id, '{"relays":["wss://second.example/"]}', { created_at: 20 });
		const expected = first.id < second.id ? first : second;

		const resolved = resolveChannelMetadata([second, channel, first], channel.id, 'wss://first.example/');

		expect(first.id).not.toBe(second.id);
		expect(resolved?.source.eventId).toBe(expected.id);
	});

	it('fails closed when the selected kind 41 JSON is malformed or has invalid relays', () => {
		const channel = channelEvent('{"relays":["wss://initial.example/"]}');
		const oldMetadata = metadataEvent(channel.id, '{"relays":["wss://old.example/"]}', { created_at: 10 });
		const malformedCurrent = metadataEvent(channel.id, '{"relays":', { created_at: 20 });
		const invalidCurrent = metadataEvent(channel.id, '{"relays":["wss://valid.example/","https://invalid.example/"]}', { created_at: 30 });

		expect(resolveChannelMetadata([malformedCurrent, oldMetadata, channel], channel.id, 'wss://initial.example/')).toBeNull();
		expect(resolveChannelMetadata([invalidCurrent, oldMetadata, channel], channel.id, 'wss://initial.example/')).toBeNull();
	});

	it('rejects invalid selected kind 40 metadata without a kind 41 fallback', () => {
		const channel = channelEvent('{"relays":[]}');
		expect(resolveChannelMetadata([channel], channel.id, 'wss://metadata.example/')).toBeNull();
	});

	it('canonicalizes and deduplicates relays while preserving first occurrence order', () => {
		const channel = channelEvent(JSON.stringify({
			relays: [
				'wss://first.example',
				'wss://first.example/',
				'ws://second.example',
				'wss://first.example/path',
				'wss://encoded.example/path%23?query=%23'
			]
		}));

		const resolved = resolveChannelMetadata([channel], channel.id, 'wss://missing.example');

		expect(resolved?.relays).toEqual([
			'wss://first.example/',
			'ws://second.example/',
			'wss://first.example/path',
			'wss://encoded.example/path%23?query=%23'
		]);
		expect(resolved?.channel.relayHint).toBe('wss://first.example/');
	});

	it('rejects non-websocket, malformed, empty, non-string, and partially invalid relay arrays', () => {
		const invalidContents = [
			'{"relays":[]}',
			'{"relays":["https://not-websocket.example/"]}',
			'{"relays":["not a url"]}',
			'{"relays":[123]}',
			'{"relays":["wss://fragment.example/#fragment"]}',
			'{"relays":["wss://fragment.example/#"]}',
			'{"relays":["wss://valid.example/", "http://invalid.example/"]}'
		];

		for (const content of invalidContents) {
			const channel = channelEvent(content);
			expect(resolveChannelMetadata([channel], channel.id, 'wss://valid.example/')).toBeNull();
		}
	});

	it('uses the preferred hint only when it is in authoritative metadata', () => {
		const withPreferred = channelEvent('{"relays":["wss://other.example/","wss://nos.lol"]}');
		const withoutPreferred = channelEvent('{"relays":["wss://other.example/","wss://another.example/"]}');

		expect(resolveChannelMetadata([withPreferred], withPreferred.id, 'wss://nos.lol')?.channel.relayHint).toBe('wss://nos.lol/');
		expect(resolveChannelMetadata([withoutPreferred], withoutPreferred.id, 'wss://nos.lol/')?.channel.relayHint).toBe('wss://other.example/');
	});
});
