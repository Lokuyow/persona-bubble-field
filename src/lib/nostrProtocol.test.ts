import { describe, expect, it } from 'vitest';
import { verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import {
	CHANNEL_MESSAGE_KIND,
	PROFILE_KIND,
	POSITION_KIND,
	POSITION_SLOT_IDENTIFIERS,
	PROTOTYPE_NAMESPACE,
	RECENT_MESSAGE_TIMELINE_LIMIT,
	TRACE_REPLY_KIND,
	buildPositionEventTemplate,
	buildCharacterProfileTemplate,
	buildPositionFilter,
	buildTraceDirectReplyFilter,
	buildTraceNotificationFilter,
	buildTraceReplyFilter,
	buildTraceReplyTemplate,
	buildTraceRootBootstrapFilter,
	buildWorldMessageFilter,
	buildWorldMessageFilters,
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	finalizeCharacterProfileEvent,
	parsePositionEvent,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate,
	type ChannelReference,
	type PositionEventTemplate,
	type TraceReplyTemplate,
	type WorldEventTemplate,
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
	return finalizeWorldEvent(template as WorldEventTemplate, TEST_SECRET_KEY);
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

function parsedRoot(content = 'hello world') {
	const root = parseWorldMessage(signedMessage('normal', { content }), CHANNEL_ID);
	if (!root) throw new Error('Test root did not parse.');
	return root;
}

function signedTraceReply(
	root = parsedRoot(),
	parent = root,
	override: Partial<Omit<Parameters<typeof buildTraceReplyTemplate>[0], 'root' | 'parent'>> = {}
): VerifiedEvent {
	return finalizeWorldEvent(buildTraceReplyTemplate({
		root,
		parent,
		content: 'reply',
		speechType: 'normal',
		position: { x: 8, y: 3 },
		createdAt: 1_700_000_001,
		relayHint: channel.relayHint,
		...override
	}), TEST_SECRET_KEY);
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
		expect(event.kind).toBe(template.kind);
		expect(event.created_at).toBe(template.created_at);
		expect(event.tags).toEqual(template.tags);
		expect(event.content).toBe(template.content);
	});

	it('preserves Character 002 about text including newlines in kind 0 metadata', () => {
		const character = CHARACTER_CATALOG[1];
		const template = buildCharacterProfileTemplate({
			character,
			absolutePictureUrl: 'https://static.example.test/characters/002.webp',
			createdAt: 1_700_000_000
		});

		expect(JSON.parse(template.content).about).toBe(character.about);
	});

	it.each(['characters/001.webp', '/characters/001.webp', 'not a URL', 'ftp://example.test/characters/001.webp'])('rejects non-absolute HTTP(S) picture URLs: %s', (absolutePictureUrl) => {
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

	it('rejects NIP-28 replies and every additional kind 42 e relation', () => {
		const nip28Reply = buildWorldMessageTemplate({
			channel,
			content: 'reply',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		nip28Reply.tags.push(['e', 'c'.repeat(64), 'wss://relay.example.com', 'reply'], ['p', 'd'.repeat(64)]);

		const duplicateRoot = buildWorldMessageTemplate({
			channel,
			content: 'duplicate root',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		duplicateRoot.tags.push(['e', CHANNEL_ID, '', 'root']);

		const extraUnmarkedRelation = buildWorldMessageTemplate({
			channel,
			content: 'extra relation',
			speechType: 'normal',
			position: { x: 7, y: 3 },
			createdAt: 1_700_000_000
		});
		extraUnmarkedRelation.tags.push(['e', CHANNEL_ID]);

		for (const template of [nip28Reply, duplicateRoot, extraUnmarkedRelation]) {
			expect(parseWorldMessage(resign(template), CHANNEL_ID)).toBeNull();
		}
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

	it('builds and validates canonical direct and deeper trace replies', () => {
		const root = parsedRoot();
		const directTemplate = buildTraceReplyTemplate({
			root,
			parent: root,
			content: 'direct',
			speechType: 'shout',
			position: { x: 8, y: 3 },
			createdAt: 1_700_000_001,
			relayHint: channel.relayHint
		});
		expect(directTemplate).toEqual({
			kind: TRACE_REPLY_KIND,
			created_at: 1_700_000_001,
			tags: [
				['E', root.id, channel.relayHint, root.pubkey], ['K', '42'], ['P', root.pubkey],
				['e', root.id, channel.relayHint, root.pubkey], ['k', '42'], ['p', root.pubkey],
				['L', PROTOTYPE_NAMESPACE], ['l', 'chat', PROTOTYPE_NAMESPACE], ['w', '8:3'],
				['l', 'speech:shout', PROTOTYPE_NAMESPACE]
			],
			content: 'direct'
		});
		const directCandidate = parseTraceReplyCandidate(finalizeWorldEvent(directTemplate, TEST_SECRET_KEY));
		expect(directCandidate).not.toBeNull();
		const direct = validateTraceReplyCandidate(directCandidate!, root, root);
		expect(direct).toMatchObject({ rootId: root.id, parentId: root.id, parentKind: 42, speechType: 'shout' });

		const deeperTemplate = buildTraceReplyTemplate({
			root,
			parent: direct!,
			content: 'deeper',
			speechType: 'monologue',
			position: { x: 9, y: 3 },
			createdAt: 1_700_000_002
		});
		expect(deeperTemplate.tags.slice(0, 6)).toEqual([
			['E', root.id, '', root.pubkey], ['K', '42'], ['P', root.pubkey],
			['e', direct!.id, '', direct!.pubkey], ['k', '1111'], ['p', direct!.pubkey]
		]);
		const deeperCandidate = parseTraceReplyCandidate(finalizeWorldEvent(deeperTemplate, TEST_SECRET_KEY));
		expect(validateTraceReplyCandidate(deeperCandidate!, root, direct!)).toMatchObject({
			rootId: root.id, parentId: direct!.id, parentKind: 1111, speechType: 'monologue'
		});
	});

	it.each(['normal', 'shout', 'monologue'] as const)('parses valid %s trace speech', (speechType) => {
		const root = parsedRoot();
		const candidate = parseTraceReplyCandidate(signedTraceReply(root, root, { speechType }));
		expect(candidate?.speechType).toBe(speechType);
		expect(validateTraceReplyCandidate(candidate!, root, root)).not.toBeNull();
	});

	it('rejects malformed trace candidate scopes, relations, timestamps, and signatures', () => {
		const root = parsedRoot();
		const template = buildTraceReplyTemplate({
			root,
			parent: root,
			content: 'reply',
			speechType: 'normal',
			position: { x: 8, y: 3 },
			createdAt: 1_700_000_001
		});
		const malformed = [
			['missing E', (event: TraceReplyTemplate) => event.tags.splice(0, 1)],
			['duplicate E', (event: TraceReplyTemplate) => event.tags.push(['E', root.id])],
			['invalid E id', (event: TraceReplyTemplate) => { event.tags[0][1] = 'A'.repeat(64); }],
			['invalid K', (event: TraceReplyTemplate) => { event.tags[1][1] = '1111'; }],
			['duplicate K', (event: TraceReplyTemplate) => event.tags.push(['K', '42'])],
			['invalid P pubkey', (event: TraceReplyTemplate) => { event.tags[2][1] = 'A'.repeat(64); }],
			['duplicate P', (event: TraceReplyTemplate) => event.tags.push(['P', root.pubkey])],
			['missing e', (event: TraceReplyTemplate) => event.tags.splice(3, 1)],
			['duplicate e', (event: TraceReplyTemplate) => event.tags.push(['e', root.id])],
			['invalid e id', (event: TraceReplyTemplate) => { event.tags[3][1] = 'A'.repeat(64); }],
			['invalid k', (event: TraceReplyTemplate) => { event.tags[4][1] = '1'; }],
			['duplicate k', (event: TraceReplyTemplate) => event.tags.push(['k', '42'])],
			['root scope A', (event: TraceReplyTemplate) => event.tags.push(['A', '30023:x'])],
			['root scope I', (event: TraceReplyTemplate) => event.tags.push(['I', 'https://example.test'])],
			['parent scope a', (event: TraceReplyTemplate) => event.tags.push(['a', '30023:x'])],
			['parent scope i', (event: TraceReplyTemplate) => event.tags.push(['i', 'https://example.test'])],
			['invalid w', (event: TraceReplyTemplate) => { event.tags[8][1] = '08:3'; }],
			['duplicate w', (event: TraceReplyTemplate) => event.tags.push(['w', '8:3'])],
			['missing namespace label', (event: TraceReplyTemplate) => event.tags.splice(6, 1)],
			['missing chat label', (event: TraceReplyTemplate) => event.tags.splice(7, 1)],
			['invalid root author hint', (event: TraceReplyTemplate) => { event.tags[0][3] = 'A'.repeat(64); }]
		] as const;
		for (const [, mutate] of malformed) {
			const copy = { ...template, tags: template.tags.map((tag) => [...tag]) } as TraceReplyTemplate;
			mutate(copy);
			expect(parseTraceReplyCandidate(resign(copy))).toBeNull();
		}

		const invalidTimestamp = { ...template, created_at: -1 } as TraceReplyTemplate;
		expect(parseTraceReplyCandidate(resign(invalidTimestamp))).toBeNull();
		const tampered = receivedCopy(resign(template));
		tampered.sig = '0'.repeat(128);
		expect(parseTraceReplyCandidate(tampered)).toBeNull();
	});

	it('validates trace root and parent claims semantically while allowing p mentions', () => {
		const root = parsedRoot();
		const directEvent = signedTraceReply(root);
		const directCandidate = parseTraceReplyCandidate(directEvent)!;
		const direct = validateTraceReplyCandidate(directCandidate, root, root)!;
		const validWithMention = receivedCopy(directEvent);
		validWithMention.tags.push(['p', 'f'.repeat(64)]);
		expect(validateTraceReplyCandidate(parseTraceReplyCandidate(resign(validWithMention))!, root, root)).not.toBeNull();

		const otherRoot = parsedRoot('other root');
		const otherDirect = validateTraceReplyCandidate(parseTraceReplyCandidate(signedTraceReply(otherRoot))!, otherRoot, otherRoot)!;
		const cases = [
			['wrong root id', (event: TraceReplyTemplate) => { event.tags[0][1] = 'c'.repeat(64); }, root, root],
			['wrong root author', (event: TraceReplyTemplate) => { event.tags[2][1] = 'c'.repeat(64); }, root, root],
			['wrong root author hint', (event: TraceReplyTemplate) => { event.tags[0][3] = 'c'.repeat(64); }, root, root],
			['wrong parent id', (event: TraceReplyTemplate) => { event.tags[3][1] = 'c'.repeat(64); }, root, root],
			['wrong parent kind', (event: TraceReplyTemplate) => { event.tags[4][1] = '1111'; }, root, root],
			['wrong parent author hint', (event: TraceReplyTemplate) => { event.tags[3][3] = 'c'.repeat(64); }, root, root],
			['missing parent author p', (event: TraceReplyTemplate) => { event.tags[5][1] = 'c'.repeat(64); }, root, root],
			['parent from another root tree', (event: TraceReplyTemplate) => {
				event.tags[3][1] = otherDirect.id;
				event.tags[3][3] = otherDirect.pubkey;
				event.tags[4][1] = '1111';
				event.tags[5][1] = otherDirect.pubkey;
			}, root, otherDirect]
		] as const;
		for (const [, mutate, candidateRoot, parent] of cases) {
			const copy = { ...buildTraceReplyTemplate({
				root: candidateRoot,
				parent: candidateRoot,
				content: 'reply', speechType: 'normal', position: { x: 8, y: 3 }, createdAt: 1_700_000_001
			}), tags: buildTraceReplyTemplate({
				root: candidateRoot,
				parent: candidateRoot,
				content: 'reply', speechType: 'normal', position: { x: 8, y: 3 }, createdAt: 1_700_000_001
			}).tags.map((tag) => [...tag]) } as TraceReplyTemplate;
			mutate(copy);
			const candidate = parseTraceReplyCandidate(resign(copy));
			expect(candidate && validateTraceReplyCandidate(candidate, candidateRoot, parent)).toBeNull();
		}
		expect(direct.parentPubkey).toBe(root.pubkey);
	});

	it('builds exact message, position, and trace filters', () => {
		expect(buildWorldMessageFilter({ channelId: CHANNEL_ID, since: 1_700_000_000 })).toEqual({
			kinds: [42],
			'#e': [CHANNEL_ID],
			'#L': [PROTOTYPE_NAMESPACE],
			'#l': ['chat'],
			since: 1_700_000_000
		});
		expect(buildWorldMessageFilters({ channelId: CHANNEL_ID, since: 1_700_000_000 })).toEqual([
			{
				kinds: [42],
				'#e': [CHANNEL_ID],
				'#L': [PROTOTYPE_NAMESPACE],
				'#l': ['chat'],
				since: 1_700_000_000
			},
			{
				kinds: [42],
				'#e': [CHANNEL_ID],
				'#L': [PROTOTYPE_NAMESPACE],
				'#l': ['chat'],
				limit: RECENT_MESSAGE_TIMELINE_LIMIT
			}
		]);
		expect(buildPositionFilter({ channelId: CHANNEL_ID, since: 1_700_000_100 })).toEqual({
			kinds: [30078],
			'#d': [...POSITION_SLOT_IDENTIFIERS],
			'#e': [CHANNEL_ID],
			since: 1_700_000_100
		});
		expect(buildTraceRootBootstrapFilter({ channelId: CHANNEL_ID })).toEqual({
			kinds: [42],
			'#e': [CHANNEL_ID],
			'#L': [PROTOTYPE_NAMESPACE],
			'#l': ['chat'],
			limit: 1000
		});
		expect(buildTraceReplyFilter({ rootId: CHANNEL_ID })).toEqual({
			kinds: [1111], '#E': [CHANNEL_ID], '#L': [PROTOTYPE_NAMESPACE], '#l': ['chat'], limit: 100
		});
		const directFilter = buildTraceDirectReplyFilter({ currentId: OTHER_CHANNEL_ID });
		expect(directFilter).toEqual({
			kinds: [1111], '#e': [OTHER_CHANNEL_ID], '#L': [PROTOTYPE_NAMESPACE], '#l': ['chat'], limit: 100
		});
		expect(directFilter).not.toHaveProperty('#E');
		expect(Object.keys(directFilter).filter((key) => key.startsWith('#'))).toHaveLength(3);
		expect(buildTraceNotificationFilter({ personaPubkey: 'c'.repeat(64) })).toEqual({
			kinds: [1111], '#p': ['c'.repeat(64)], '#L': [PROTOTYPE_NAMESPACE], '#l': ['chat']
		});
		expect(buildTraceNotificationFilter({ personaPubkey: 'c'.repeat(64), effectiveRootIds: [CHANNEL_ID, OTHER_CHANNEL_ID] })).toEqual({
			kinds: [1111], '#p': ['c'.repeat(64)], '#L': [PROTOTYPE_NAMESPACE], '#l': ['chat'], '#E': [CHANNEL_ID, OTHER_CHANNEL_ID]
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
		expect(() => buildTraceReplyFilter({ rootId: 'A'.repeat(64) })).toThrow(TypeError);
		for (const currentId of ['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), '']) {
			expect(() => buildTraceDirectReplyFilter({ currentId })).toThrow(TypeError);
		}
		expect(() => buildTraceNotificationFilter({ personaPubkey: 'A'.repeat(64) })).toThrow(TypeError);
		expect(() => buildPositionEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'https://not-a-relay.example.com' },
			position: { x: 0, y: 0 },
			slot: 0,
			createdAt: 1
		})).toThrow(TypeError);
	});
});
