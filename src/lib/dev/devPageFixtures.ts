import { receiveMessage, type ConversationState, type SpeechType } from '../conversation';
import { createPresenceState, type PresenceField, type PresenceState } from '../presence';
import { DEV_WORLD_SELF_ID } from '../devWorldSandbox';
import { createRecentMessageTimeline, type RecentMessageTimeline } from '../recentMessageTimeline';
import type { ParsedTraceReply, ParsedWorldMessage } from '../nostrProtocol';

type FixturePorts = Readonly<{
	field: PresenceField;
	setPresence: (next: PresenceState) => void;
	getConversation: () => ConversationState;
	setConversation: (next: ConversationState) => void;
	setRecentMessageTimeline: (next: RecentMessageTimeline) => void;
	setEffectiveTraceRoots: (next: readonly ParsedWorldMessage[]) => void;
	setDevTraceReplies: (next: readonly ParsedTraceReply[]) => void;
	enableTraceReplyFixture: () => void;
}>;

/** Apply the existing fixtures synchronously, before DEV presence overrides and runtime setup. */
export function applyDevPageFixtures(searchParams: URLSearchParams, ports: FixturePorts): void {
	const devSpeech = searchParams.get('devSpeech');
	if (devSpeech) {
		if (devSpeech === '1') seedDevSpeechNormalFixture();
		const mergedMemberCount = devSpeech.startsWith('merged2') ? 2 : devSpeech.startsWith('merged3') ? 3 : devSpeech.startsWith('merged4') ? 4 : 0;
		if (mergedMemberCount > 0) {
			const mergedContent = devSpeech.endsWith('-long')
				? 'Merged bubble content grows naturally until its size limit. '.repeat(8).trim()
				: undefined;
			const mergedSpeechType = devSpeech.includes('shout') ? 'shout' : devSpeech.includes('monologue') ? 'monologue' : 'normal';
			seedDevSpeechMergedFixture(mergedMemberCount, mergedContent, mergedSpeechType);
		}
		if (devSpeech === 'types') seedDevSpeechTypeFixture();
		if (devSpeech === 'normal-sizes') seedDevSpeechNormalSizeFixture();
		if (devSpeech === 'comparison') seedDevSpeechComparisonFixture();
		if (devSpeech === 'linebreak') seedDevSpeechLinebreakFixture();
		if (devSpeech === 'linebreak-five') seedDevSpeechLinebreakFiveFixture();
		if (devSpeech === 'long') seedDevSpeechLongFixture();
		if (devSpeech === 'linebreak-overflow') seedDevSpeechLinebreakOverflowFixture();
		if (devSpeech === 'timeline') seedDevRecentMessageTimelineFixture();
	}
	const devTrace = searchParams.get('devTrace');
	if (devTrace === 'lights' || devTrace === 'replies') {
		seedDevTraceMarkerFixture();
	}
	if (devTrace === 'replies') {
		ports.enableTraceReplyFixture();
		seedDevTraceReplyFixture();
	}

	function seedDevRecentMessageTimelineFixture(): void {
		const now = Math.floor(Date.now() / 1000);
		const activePubkeys = ['0', '1', '2', 'a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(64));
		const activePubkey = activePubkeys[0];
		const outsidePubkey = 'f'.repeat(64);
		ports.setPresence(createPresenceState(ports.field, Date.now(), [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			...activePubkeys.map((id, index) => ({
				id,
				position: { x: 8 + (index % 4), y: 2 + Math.floor(index / 4) }
			}))
		]));
		const messages: ParsedWorldMessage[] = Array.from({ length: 24 }, (_, index) => ({
			id: index === 23 ? 'dev-timeline-duplicate' : `dev-timeline-${String(index).padStart(2, '0')}`,
			pubkey: index === 21 ? outsidePubkey : index === 22 ? DEV_WORLD_SELF_ID : activePubkeys[index % activePubkeys.length],
			createdAt: now - Math.floor((23 - index) / 3),
			content: index === 10
				? 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6'
				: index === 11 || index === 12
					? 'same content, different event'
					: `timeline message ${index + 1}`,
			speechType: index % 3 === 0 ? 'shout' : index % 3 === 1 ? 'monologue' : 'normal',
			position: { x: 1, y: 1 }
		}));
		messages.push({ ...messages[22], id: 'dev-timeline-duplicate', content: 'duplicate event ID' });
		ports.setRecentMessageTimeline(createRecentMessageTimeline(messages));
	}

	function seedDevTraceMarkerFixture(): void {
		const nowMs = Date.now();
		const now = Math.floor(nowMs / 1000);
		const livePubkey = 'f'.repeat(64);
		ports.setPresence(createPresenceState(ports.field, nowMs, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: livePubkey, position: { x: 9, y: 4 } }
		]));
		ports.setConversation(receiveMessage(ports.getConversation(), {
			id: 'dev-trace-live-message',
			pubkey: livePubkey,
			content: 'live bubble fixed while a trace bubble is added nearby',
			createdAt: nowMs
		}, { isSpeakerVisible: true, duration: 60_000, now: nowMs }));
		ports.setEffectiveTraceRoots([
			{
				id: '1'.repeat(64), pubkey: 'a'.repeat(64), createdAt: now,
				content: 'out-of-range trace root', speechType: 'normal', position: { x: 2, y: 2 }
			},
			{
				id: '2'.repeat(64), pubkey: 'b'.repeat(64), createdAt: now,
				content: 'trace-only root near the viewer', speechType: 'shout', position: { x: 8, y: 4 }
			},
			{
				id: '3'.repeat(64), pubkey: 'c'.repeat(64), createdAt: now - 2,
				content: 'root beside the current participant', speechType: 'monologue', position: { x: 7, y: 3 }
			},
			{
				id: '4'.repeat(64), pubkey: 'd'.repeat(64), createdAt: now - 1,
				content: 'newest root on an available movement cell', speechType: 'normal', position: { x: 8, y: 3 }
			}
		]);
	}

	function seedDevTraceReplyFixture(): void {
		const now = Math.floor(Date.now() / 1000);
		const sameCellAuthor = '6'.repeat(64);
		const sameCellNewest = devTraceReply({
			id: '7'.repeat(64), pubkey: sameCellAuthor, createdAt: now - 1,
			content: 'newest same-cell direct reply', speechType: 'normal', position: { x: 6, y: 4 }
		});
		ports.setDevTraceReplies([
			devTraceReply({
				id: '6'.repeat(64), pubkey: '5'.repeat(64), createdAt: now - 2,
				content: 'older same-cell direct reply', speechType: 'normal', position: { x: 6, y: 4 }
			}),
			sameCellNewest,
			devTraceReply({
				id: '8'.repeat(64), pubkey: '8'.repeat(64), createdAt: now,
				content: 'shout reply beside an actual participant', speechType: 'shout', position: { x: 9, y: 4 }
			}),
			devTraceReply({
				id: '9'.repeat(64), pubkey: '9'.repeat(64), createdAt: now,
				content: 'monologue reply sharing the root cell', speechType: 'monologue', position: { x: 8, y: 4 }
			}),
			devTraceReply({
				id: 'a'.repeat(64), pubkey: 'a'.repeat(64), createdAt: now,
				content: 'offscreen reply body must stay hidden', speechType: 'normal', position: { x: 15, y: 7 }
			}),
			devTraceReply({
				id: 'b'.repeat(64), pubkey: 'b'.repeat(64), createdAt: now,
				content: 'deeper branch reply', speechType: 'normal', position: { x: 7, y: 4 },
				parentId: sameCellNewest.id, parentKind: 1111, parentPubkey: sameCellNewest.pubkey
			}),
			devTraceReply({
				id: 'd'.repeat(64), pubkey: 'd'.repeat(64), createdAt: now + 2,
				content: 'newest same-author grandchild', speechType: 'shout', position: { x: 8, y: 4 },
				parentId: 'b'.repeat(64), parentKind: 1111, parentPubkey: 'b'.repeat(64)
			}),
			devTraceReply({
				id: 'e'.repeat(64), pubkey: 'd'.repeat(64), createdAt: now + 1,
				content: 'older same-author grandchild', speechType: 'normal', position: { x: 8, y: 4 },
				parentId: 'b'.repeat(64), parentKind: 1111, parentPubkey: 'b'.repeat(64)
			}),
			devTraceReply({
				id: 'f'.repeat(64), pubkey: 'e'.repeat(64), createdAt: now + 3,
				content: 'great-grandchild reply', speechType: 'monologue', position: { x: 9, y: 4 },
				parentId: 'd'.repeat(64), parentKind: 1111, parentPubkey: 'd'.repeat(64)
			})
		]);
	}

	function seedDevSpeechNormalFixture(): void {
		const now = Date.now();
		const participantIds = ['0', 'a', 'b', 'c', 'd', 'e', 'f'].map((prefix) => prefix.repeat(64));
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			...participantIds.map((id, index) => ({ id, position: { x: index * 2 + 1, y: 2 } }))
		]));
		const duration = 60_000;
		const allParticipantIds = [DEV_WORLD_SELF_ID, ...participantIds];
		const mergedContent = 'merged showcase fixture';
		for (const [index, pubkey] of allParticipantIds.slice(0, 2).entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id: `dev-speech-showcase-merged-message-${index}`,
				pubkey,
				content: mergedContent,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		}
		for (const [index, pubkey] of allParticipantIds.entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id: `dev-speech-showcase-normal-message-${index}`,
				pubkey,
				content: `normal fixture ${index + 1}`,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		}
	}

	function seedDevSpeechMergedFixture(
		mergedMemberCount: number,
		mergedContent = 'merged fixture',
		mergedSpeechType: SpeechType = 'normal'
	): void {
		const now = Date.now();
		const normalPubkey = 'a'.repeat(64);
		const mergedPubkeys = ['b', 'c', 'd', 'e']
			.slice(0, mergedMemberCount)
			.map((prefix) => prefix.repeat(64));
		const mergedPositions = mergedMemberCount === 2
			? [6, 10]
			: mergedMemberCount === 3
				? [5, 8, 11]
				: [4, 6, 10, 12];
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 4, y: 2 } },
			...mergedPubkeys.map((id, index) => ({ id, position: { x: mergedPositions[index], y: 2 } }))
		]));
		const duration = 60_000;
		const normalMessage = {
			id: 'dev-speech-normal-message', pubkey: normalPubkey, content: 'normal fixture', createdAt: now
		} as const;
		const mergedMessage = {
			id: 'dev-speech-merged-message-a', pubkey: mergedPubkeys[0], content: mergedContent, speechType: mergedSpeechType, createdAt: now
		} as const;
		ports.setConversation(receiveMessage(ports.getConversation(), normalMessage, { isSpeakerVisible: true, duration, now }));
		ports.setConversation(receiveMessage(ports.getConversation(), mergedMessage, { isSpeakerVisible: true, duration, now }));
		for (const [index, pubkey] of mergedPubkeys.slice(1).entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				...mergedMessage,
				id: `dev-speech-merged-message-${String.fromCharCode(98 + index)}`,
				pubkey
			}, { isSpeakerVisible: true, duration, now }));
		}
	}

	function seedDevSpeechTypeFixture(): void {
		const now = Date.now();
		const normalPubkey = 'a'.repeat(64);
		const singleShoutPubkey = 'f'.repeat(64);
		const singleMonologuePubkey = '9'.repeat(64);
		const shoutPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		const monologuePubkeys = ['d', 'e'].map((prefix) => prefix.repeat(64));
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 4, y: 2 } },
			{ id: singleShoutPubkey, position: { x: 11, y: 2 } },
			{ id: singleMonologuePubkey, position: { x: 11, y: 1 } },
			...shoutPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } })),
			...monologuePubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 1 } }))
		]));
		const duration = 60_000;
		const addMessage = (id: string, pubkey: string, content: string, speechType: SpeechType) => {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id, pubkey, content, speechType, createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		};
		addMessage('dev-speech-types-normal', normalPubkey, 'normal fixture', 'normal');
		addMessage('dev-speech-types-single-shout', singleShoutPubkey, 'single shout fixture', 'shout');
		addMessage('dev-speech-types-single-monologue', singleMonologuePubkey, 'single monologue fixture', 'monologue');
		addMessage('dev-speech-types-shout-a', shoutPubkeys[0], 'shout fixture', 'shout');
		addMessage('dev-speech-types-shout-b', shoutPubkeys[1], 'shout fixture', 'shout');
		addMessage('dev-speech-types-monologue-a', monologuePubkeys[0], 'monologue fixture', 'monologue');
		addMessage('dev-speech-types-monologue-b', monologuePubkeys[1], 'monologue fixture', 'monologue');
	}

	function seedDevSpeechNormalSizeFixture(): void {
		const now = Date.now();
		const messages = [
			{ pubkey: 'a'.repeat(64), position: { x: 5, y: 2 }, content: 'short' },
			{ pubkey: 'b'.repeat(64), position: { x: 7, y: 2 }, content: 'medium bubble message' },
			{
				pubkey: 'c'.repeat(64),
				position: { x: 9, y: 2 },
				content: 'Long normal bubble content grows until it reaches the maximum width and wraps naturally.'
			}
		] as const;
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			...messages.map(({ pubkey, position }) => ({ id: pubkey, position }))
		]));
		const duration = 60_000;
		for (const [index, { pubkey, content }] of messages.entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id: `dev-speech-normal-size-${index}`,
				pubkey,
				content,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		}
	}

	function seedDevSpeechComparisonFixture(): void {
		const now = Date.now();
		const content = 'The same representative message is rendered at two bubble scales to compare wrapping behavior.';
		const normalPubkey = 'a'.repeat(64);
		const mergedPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 5, y: 2 } },
			...mergedPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } }))
		]));
		const duration = 60_000;
		ports.setConversation(receiveMessage(ports.getConversation(), {
			id: 'dev-speech-comparison-normal',
			pubkey: normalPubkey,
			content,
			speechType: 'shout',
			createdAt: now
		}, { isSpeakerVisible: true, duration, now }));
		for (const [index, pubkey] of mergedPubkeys.entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id: `dev-speech-comparison-merged-${index}`,
				pubkey,
				content,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		}
	}

	function seedDevSpeechFixture(normalContent: string, mergedContent: string): void {
		const now = Date.now();
		const normalPubkey = 'a'.repeat(64);
		const mergedPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		ports.setPresence(createPresenceState(ports.field, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 5, y: 2 } },
			...mergedPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } }))
		]));
		const duration = 60_000;
		ports.setConversation(receiveMessage(ports.getConversation(), {
			id: 'dev-speech-line-clamp-normal',
			pubkey: normalPubkey,
			content: normalContent,
			createdAt: now
		}, { isSpeakerVisible: true, duration, now }));
		for (const [index, pubkey] of mergedPubkeys.entries()) {
			ports.setConversation(receiveMessage(ports.getConversation(), {
				id: `dev-speech-line-clamp-merged-${index}`,
				pubkey,
				content: mergedContent,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now }));
		}
	}

	function seedDevSpeechLinebreakFixture(): void {
		seedDevSpeechFixture('normal line 1\nnormal line 2\nnormal line 3', 'merged line 1\nmerged line 2\nmerged line 3');
	}

	function seedDevSpeechLinebreakFiveFixture(): void {
		seedDevSpeechFixture(
			'normal line 1\nnormal line 2\nnormal line 3\nnormal line 4\nnormal line 5',
			'merged line 1\nmerged line 2\nmerged line 3\nmerged line 4\nmerged line 5'
		);
	}

	function seedDevSpeechLongFixture(): void {
		const normalContent = 'Normal bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim();
		const mergedContent = 'Merged bubble message that wraps repeatedly inside the speech bubble width. '.repeat(8).trim();
		seedDevSpeechFixture(normalContent, mergedContent);
	}

	function seedDevSpeechLinebreakOverflowFixture(): void {
		seedDevSpeechFixture(
			'normal line 1\nnormal line 2\nnormal line 3\nnormal line 4\nnormal line 5\nnormal line 6',
			'merged line 1\nmerged line 2\nmerged line 3\nmerged line 4\nmerged line 5\nmerged line 6'
		);
	}

}

function devTraceReply(options: Readonly<{
	id: string;
	pubkey: string;
	createdAt: number;
	content: string;
	speechType: SpeechType;
	position: { x: number; y: number };
	parentId?: string;
	parentKind?: 42 | 1111;
	parentPubkey?: string;
}>): ParsedTraceReply {
	const rootId = '2'.repeat(64);
	const rootPubkey = 'b'.repeat(64);
	return {
		id: options.id,
		pubkey: options.pubkey,
		createdAt: options.createdAt,
		content: options.content,
		speechType: options.speechType,
		rootId,
		rootPubkey,
		parentId: options.parentId ?? rootId,
		parentKind: options.parentKind ?? 42,
		parentPubkey: options.parentPubkey ?? rootPubkey
	};
}

export function createDevTraceLiveReply(nowMs: number): ParsedTraceReply {
	return devTraceReply({
		id: 'c'.repeat(64), pubkey: 'c'.repeat(64), createdAt: Math.floor(nowMs / 1000) + 1,
		content: 'live newest same-cell direct reply', speechType: 'normal', position: { x: 6, y: 4 }
	});
}
