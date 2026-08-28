import { describe, expect, it } from 'vitest';
import { verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import {
	CHANNEL_MESSAGE_KIND,
	PROFILE_KIND,
	POSITION_KIND,
	POSITION_SLOT_IDENTIFIERS,
	PROTOTYPE_NAMESPACE,
	buildPositionEventTemplate,
	buildCharacterProfileTemplate,
	buildPositionFilter,
	buildTraceMessageFilter,
	buildWorldMessageFilter,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	finalizeCharacterProfileEvent,
	parsePositionEvent,
	parseWorldMessage,
	type ChannelReference,
	type PositionEventTemplate,
	type WorldMessageTemplate
} from './nostrProtocol';
import { CHARACTER_CATALOG } from './character';

const CHANNEL_ID = 'a'.repeat(64);
const OTHER_CHANNEL_ID = 'b'.repeat(64);
const channel: ChannelReference = {
	channelId: CHANNEL_ID,
	relayHint: 'wss://relay.example.com'
};
const otherRelayChannel: ChannelReference = {
	channelId: CHANNEL_ID,
	relayHint: 'wss://another-relay.example.com'
};
const TEST_SECRET_KEY = new Uint8Array(32).fill(1);

function signedMessage(
	speechType: 'normal' | 'shout' | 'monologue' = 'normal',
	override: Partial<Parameters<typeof buildWorldMessageTemplate>[0]> = {}
): VerifiedEvent {
	return finalizeWorldEvent(buildWorldMessageTemplate({
		channel,
		content: 'hello world',
		speechType,
		position: { x: 7, y: 3 },
		createdAt: 1_700_000_000,
		...override
	}), TEST_SECRET_KEY);
}

function signedPosition(slot: 0 | 1, override: Partial<Parameters<typeof buildPositionEventTemplate>[0]> = {}): VerifiedEvent {
	return finalizeWorldEvent(buildPositionEventTemplate({
		channel,
		position: { x: 8, y: 3 },
		slot,
		createdAt: 1_700_000_000,
		...override
	}), TEST_SECRET_KEY);
}

function signedPositionWithCreatedAt(createdAt: number): VerifiedEvent {
	return finalizeWorldEvent({
		kind: POSITION_KIND,
		created_at: createdAt,
		tags: [
			['d', POSITION_SLOT_IDENTIFIERS[0]],
			['e', channel.channelId, channel.relayHint]
		],
		content: '8:3'
	} as PositionEventTemplate, TEST_SECRET_KEY);
}

function signedMessageWithCreatedAt(createdAt: number): VerifiedEvent {
	return finalizeWorldEvent({
		kind: CHANNEL_MESSAGE_KIND,
		created_at: createdAt,
		tags: [
			['e', channel.channelId, channel.relayHint, 'root'],
			['L', PROTOTYPE_NAMESPACE],
			['l', 'chat', PROTOTYPE_NAMESPACE],
			['w', '7:3']
		],
		content: 'hello world'
	} as WorldMessageTemplate, TEST_SECRET_KEY);
}

function resign(template: EventTemplate): VerifiedEvent {
	return finalizeWorldEvent(template as WorldMessageTemplate | PositionEventTemplate, TEST_SECRET_KEY);
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

describe('Nostr protocol foundation', () => {
	it('builds and signs the initial character kind 0 profile', () => {
		const character = CHARACTER_CATALOG[0];
		const template = buildCharacterProfileTemplate({
			character,
			absolutePictureUrl: 'https://static.example.test/characters/001.webp',
			createdAt: 1_700_000_000
		});

		expect(template).toEqual({
			kind: PROFILE_KIND,
			created_at: 1_700_000_000,
			tags: [],
			content: JSON.stringify({
				name: character.name,
				about: character.about,
				picture: 'https://static.example.test/characters/001.webp'
			})
		});

		const event = finalizeCharacterProfileEvent(template, TEST_SECRET_KEY);
		expect(verifyEvent(event)).toBe(true);
		expect(event.kind).toBe(0);
		expect(event.tags).toEqual([]);
	});

	it.each(['characters/001.webp', '/characters/001.webp', 'not a URL'])('rejects non-absolute picture URLs: %s', (absolutePictureUrl) => {
		expect(() => buildCharacterProfileTemplate({
			character: CHARACTER_CATALOG[0],
			absolutePictureUrl,
			createdAt: 1_700_000_000
		})).toThrow(TypeError);
	});

	it('rejects invalid profile template timestamps', () => {
		expect(() => buildCharacterProfileTemplate({
			character: CHARACTER_CATALOG[0],
			absolutePictureUrl: 'https://static.example.test/characters/001.webp',
			createdAt: -1
		})).toThrow(TypeError);
	});

	it('builds the canonical normal kind 42 shape', () => {
		const event = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});

		expect(event).toEqual({
			kind: CHANNEL_MESSAGE_KIND,
			created_at: 1_700_000_000,
			tags: [
				['e', CHANNEL_ID, 'wss://relay.example.com', 'root'],
				['L', PROTOTYPE_NAMESPACE],
				['l', 'chat', PROTOTYPE_NAMESPACE],
				['w', '7:3']
			],
			content: 'hello world'
		});
	});

	it.each([
		['shout', 'speech:shout'],
		['monologue', 'speech:monologue']
	] as const)('adds only the canonical %s speech label', (speechType, label) => {
		const event = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType,
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});

		expect(event.tags).toEqual([
			['e', CHANNEL_ID, 'wss://relay.example.com', 'root'],
			['L', PROTOTYPE_NAMESPACE],
			['l', 'chat', PROTOTYPE_NAMESPACE],
			['w', '7:3'],
			['l', label, PROTOTYPE_NAMESPACE]
		]);
	});

	it('builds canonical position slots without labels or w tags', () => {
		const first = buildPositionEventTemplate({
			channel,
			position: { x: 7, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		const second = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 1,
			createdAt: 1_700_000_000
		});

		expect(first).toEqual({
			kind: POSITION_KIND,
			created_at: 1_700_000_000,
			tags: [
				['d', POSITION_SLOT_IDENTIFIERS[0]],
				['e', CHANNEL_ID, 'wss://relay.example.com']
			],
			content: '7:3'
		});
		expect(second.tags[0]).toEqual(['d', POSITION_SLOT_IDENTIFIERS[1]]);
		expect(second.content).toBe('8:3');
	});

	it('finalizes and parses signed project events', () => {
		const message = signedMessage('shout');
		const position = signedPosition(1);

		expect(verifyEvent(message)).toBe(true);
		expect(verifyEvent(position)).toBe(true);
		expect(parseWorldMessage(message, CHANNEL_ID)).toMatchObject({
			id: message.id,
			content: 'hello world',
			speechType: 'shout',
			position: { x: 7, y: 3 }
		});
		expect(parsePositionEvent(position, CHANNEL_ID)).toMatchObject({
			id: position.id,
			slot: 1,
			position: { x: 8, y: 3 }
		});
	});

	it.each([-1, 1_700_000_000.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects correctly signed position events with invalid created_at %s',
		(createdAt) => {
			const event = signedPositionWithCreatedAt(createdAt);

			expect(verifyEvent(event)).toBe(true);
			expect(parsePositionEvent(event, CHANNEL_ID)).toBeNull();
		}
	);

	it.each([-1, 1_700_000_000.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects correctly signed message events with invalid created_at %s',
		(createdAt) => {
			const event = signedMessageWithCreatedAt(createdAt);

			expect(verifyEvent(event)).toBe(true);
			expect(parseWorldMessage(event, CHANNEL_ID)).toBeNull();
		}
	);

	it('rejects wire copies whose content, tags, or signature have been tampered with', () => {
		const event = signedMessage();
		const contentTampered = receivedCopy(event);
		contentTampered.content = 'changed after signing';
		const tagsTampered = receivedCopy(event);
		tagsTampered.tags[3][1] = '8:3';
		const signatureTampered = receivedCopy(event);
		signatureTampered.sig = '0'.repeat(128);

		for (const tampered of [contentTampered, tagsTampered, signatureTampered]) {
			expect(verifyEvent(tampered)).toBe(false);
			expect(parseWorldMessage(tampered, CHANNEL_ID)).toBeNull();
		}
	});

	it('uses the channel event ID, not the relay hint, as inbound message identity', () => {
		const receivedFromAnotherRelay = signedMessage('normal', { channel: otherRelayChannel });
		const receivedWithoutRelayHint = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		receivedWithoutRelayHint.tags[0][2] = '';

		expect(parseWorldMessage(receivedFromAnotherRelay, CHANNEL_ID)).not.toBeNull();
		expect(parseWorldMessage(resign(receivedWithoutRelayHint), CHANNEL_ID)).not.toBeNull();
		expect(parseWorldMessage(receivedFromAnotherRelay, OTHER_CHANNEL_ID)).toBeNull();
	});

	it('uses the channel event ID, not the relay hint, as inbound position identity', () => {
		const receivedFromAnotherRelay = signedPosition(0, { channel: otherRelayChannel });
		const receivedWithoutRelayHint = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		receivedWithoutRelayHint.tags[1][2] = '';

		expect(parsePositionEvent(receivedFromAnotherRelay, CHANNEL_ID)).not.toBeNull();
		expect(parsePositionEvent(resign(receivedWithoutRelayHint), CHANNEL_ID)).not.toBeNull();
		expect(parsePositionEvent(receivedFromAnotherRelay, OTHER_CHANNEL_ID)).toBeNull();
	});

	it('accepts unrelated inbound tags, including a client tag', () => {
		const template = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		template.tags.push(
			['client', 'external-client'],
			['t', 'unrelated'],
			['L', 'org.example.other'],
			['l', 'other', 'org.example.other']
		);

		expect(parseWorldMessage(resign(template), CHANNEL_ID)).not.toBeNull();
	});

	it('rejects ambiguous or malformed message semantics', () => {
		const conflictingRoot = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		conflictingRoot.tags.push(['e', OTHER_CHANNEL_ID, 'wss://relay.example.com', 'root']);

		const conflictingSpeech = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'shout',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		conflictingSpeech.tags.push(['l', 'speech:monologue', PROTOTYPE_NAMESPACE]);

		const malformedPosition = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		malformedPosition.tags[3][1] = '07:3';

		const duplicatePosition = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		duplicatePosition.tags.push(['w', '7:3']);

		const missingChatLabel = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		missingChatLabel.tags.splice(2, 1);

		const missingNamespaceLabel = buildWorldMessageTemplate({
			channel,
			content: 'hello world',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		missingNamespaceLabel.tags.splice(1, 1);

		for (const template of [
			conflictingRoot,
			conflictingSpeech,
			malformedPosition,
			duplicatePosition,
			missingChatLabel,
			missingNamespaceLabel
		]) {
			expect(parseWorldMessage(resign(template), CHANNEL_ID)).toBeNull();
		}
	});

	it('rejects ambiguous position semantics while allowing unrelated extra tags', () => {
		const targetOnly = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		const accepted = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		accepted.tags.push(['client', 'external-client'], ['L', 'org.example.other'], ['w', '0:0']);

		const conflictingSlot = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		conflictingSlot.tags.push(['d', POSITION_SLOT_IDENTIFIERS[1]]);

		const conflictingChannel = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		conflictingChannel.tags.push(['e', OTHER_CHANNEL_ID, 'wss://other-relay.example.com']);

		const malformedContent = buildPositionEventTemplate({
			channel,
			position: { x: 8, y: 3 },
			slot: 0,
			createdAt: 1_700_000_000
		});
		malformedContent.content = '08:3';

		expect(parsePositionEvent(resign(targetOnly), CHANNEL_ID)).not.toBeNull();
		expect(parsePositionEvent(resign(accepted), CHANNEL_ID)).not.toBeNull();
		expect(parsePositionEvent(resign(conflictingSlot), CHANNEL_ID)).toBeNull();
		expect(parsePositionEvent(resign(conflictingChannel), CHANNEL_ID)).toBeNull();
		expect(parsePositionEvent(resign(malformedContent), CHANNEL_ID)).toBeNull();
	});

	it('builds exact message, position, and trace filters without fixed policy values', () => {
		expect(buildWorldMessageFilter({ channelId: CHANNEL_ID, since: 1_700_000_000 })).toEqual({
			kinds: [42],
			'#e': [CHANNEL_ID],
			'#L': [PROTOTYPE_NAMESPACE],
			'#l': ['chat'],
			since: 1_700_000_000
		});
		expect(buildPositionFilter({ channelId: CHANNEL_ID, since: 1_700_000_100 })).toEqual({
			kinds: [30078],
			'#d': [...POSITION_SLOT_IDENTIFIERS],
			'#e': [CHANNEL_ID],
			since: 1_700_000_100
		});
		expect(buildTraceMessageFilter({
			channelId: CHANNEL_ID,
			positions: [{ x: 7, y: 3 }, { x: 8, y: 3 }],
			since: 1_600_000_000,
			until: 1_700_000_000
		})).toEqual({
			kinds: [42],
			'#e': [CHANNEL_ID],
			'#L': [PROTOTYPE_NAMESPACE],
			'#l': ['chat'],
			'#w': ['7:3', '8:3'],
			since: 1_600_000_000,
			until: 1_700_000_000
		});
	});

	it('guards channel IDs and invalid builder/filter inputs at public boundaries', () => {
		expect(() => buildWorldMessageFilter({ channelId: 'A'.repeat(64), since: 1 })).toThrow(TypeError);
		expect(() => buildWorldMessageTemplate({
			channel: { channelId: 'A'.repeat(64), relayHint: 'wss://relay.example.com' },
			content: 'hello world',
			speechType: 'normal',
			position: { x: 0, y: 0 },
			createdAt: 1
		})).toThrow(TypeError);
		expect(() => buildTraceMessageFilter({ channelId: CHANNEL_ID, positions: [] })).toThrow(TypeError);
		expect(() => buildPositionEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'https://not-a-relay.example.com' },
			position: { x: 0, y: 0 },
			slot: 0,
			createdAt: 1
		})).toThrow(TypeError);
	});
});
