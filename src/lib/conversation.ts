export type SpeechType = 'normal' | 'shout' | 'monologue';

export type ConversationMessage = {
	id: string;
	pubkey: string;
	content: string;
	speechType?: SpeechType;
	createdAt: number;
	receivedAt?: number;
};

export type ConversationMessageOptions = {
	isSpeakerVisible: boolean;
	duration: number;
	now?: number;
};

export type NormalBubbleState = {
	id: string;
	kind: 'normal';
	messageIds: string[];
	pubkey: string;
	content: string;
	speechType: SpeechType;
	expiresAt: number;
};

export type MergedBubbleState = {
	id: string;
	kind: 'merged';
	messageIds: string[];
	memberPubkeys: string[];
	content: string;
	speechType: SpeechType;
	expiresAt: number;
};

export type ConversationState = {
	normalBubbles: NormalBubbleState[];
	mergedBubbles: MergedBubbleState[];
	processedMessageIds: Set<string>;
	dismissedNormalMessageIds: Set<string>;
};

export function createConversationState(): ConversationState {
	return {
		normalBubbles: [],
		mergedBubbles: [],
		processedMessageIds: new Set(),
		dismissedNormalMessageIds: new Set()
	};
}

export function getPrototypeDisplayDuration(content: string): number {
	return Math.min(12_000, Math.max(5_000, Array.from(content).length * 120 + 5_000));
}

function copyState(state: ConversationState, changes: Partial<ConversationState>): ConversationState {
	return {
		normalBubbles: changes.normalBubbles ?? state.normalBubbles,
		mergedBubbles: changes.mergedBubbles ?? state.mergedBubbles,
		processedMessageIds: changes.processedMessageIds ?? state.processedMessageIds,
		dismissedNormalMessageIds: changes.dismissedNormalMessageIds ?? state.dismissedNormalMessageIds
	};
}

function messageTime(message: ConversationMessage, now: number | undefined): number {
	return now ?? message.receivedAt ?? message.createdAt;
}

function activeNormalBubbles(state: ConversationState, now: number): NormalBubbleState[] {
	return state.normalBubbles.filter((bubble) => bubble.expiresAt > now);
}

function activeMergedBubbles(state: ConversationState, now: number): MergedBubbleState[] {
	return state.mergedBubbles.filter((bubble) => bubble.expiresAt > now);
}

function sameSpeech(message: ConversationMessage, bubble: NormalBubbleState | MergedBubbleState): boolean {
	return (message.speechType ?? 'normal') === bubble.speechType;
}

function sameContent(message: ConversationMessage, bubble: NormalBubbleState | MergedBubbleState): boolean {
	return message.content === bubble.content;
}

function stableMergedId(normalBubbleId: string): string {
	return `merged:${normalBubbleId}`;
}

function retireSpeakerNormalForNewMessage(
	normalBubbles: readonly NormalBubbleState[],
	message: ConversationMessage
): NormalBubbleState[] {
	const existing = normalBubbles.find((bubble) => bubble.pubkey === message.pubkey);
	if (!existing || (sameContent(message, existing) && sameSpeech(message, existing))) return [...normalBubbles];

	return normalBubbles.filter((bubble) => bubble.pubkey !== message.pubkey);
}

export function receiveMessage(
	state: ConversationState,
	message: ConversationMessage,
	options: ConversationMessageOptions
): ConversationState {
	if (state.processedMessageIds.has(message.id)) return state;

	const processedMessageIds = new Set(state.processedMessageIds).add(message.id);
	const now = messageTime(message, options.now);
	const speechType = message.speechType ?? 'normal';
	let normalBubbles = activeNormalBubbles(state, now);
	let mergedBubbles = activeMergedBubbles(state, now);
	normalBubbles = retireSpeakerNormalForNewMessage(normalBubbles, message);

	const matchingMerged = mergedBubbles.find(
		(bubble) => sameContent(message, bubble) && sameSpeech(message, bubble)
	);

	if (matchingMerged) {
		if (!matchingMerged.memberPubkeys.includes(message.pubkey) && options.isSpeakerVisible) {
			mergedBubbles = mergedBubbles.map((bubble) =>
				bubble.id === matchingMerged.id
					? {
							...bubble,
							memberPubkeys: [...bubble.memberPubkeys, message.pubkey],
							messageIds: [...bubble.messageIds, message.id],
							expiresAt: now + options.duration
						}
					: bubble
			);
		}

		return copyState(state, { normalBubbles, mergedBubbles, processedMessageIds });
	}

	if (!options.isSpeakerVisible) {
		return copyState(state, { normalBubbles, mergedBubbles, processedMessageIds });
	}

	const matchingNormal = normalBubbles.find(
		(bubble) => sameContent(message, bubble) && sameSpeech(message, bubble) && bubble.pubkey !== message.pubkey
	);

	if (matchingNormal) {
		normalBubbles = normalBubbles.filter((bubble) => bubble.id !== matchingNormal.id);
		mergedBubbles = [
			...mergedBubbles,
			{
				id: stableMergedId(matchingNormal.id),
				kind: 'merged',
				messageIds: [...matchingNormal.messageIds, message.id],
				memberPubkeys: [matchingNormal.pubkey, message.pubkey],
				content: message.content,
				speechType,
				expiresAt: now + options.duration
			}
		];

		return copyState(state, { normalBubbles, mergedBubbles, processedMessageIds });
	}

	const existingNormalFromSpeaker = normalBubbles.find((bubble) => bubble.pubkey === message.pubkey);
	if (existingNormalFromSpeaker && sameContent(message, existingNormalFromSpeaker) && sameSpeech(message, existingNormalFromSpeaker)) {
		return copyState(state, { normalBubbles, mergedBubbles, processedMessageIds });
	}

	normalBubbles = [
		...normalBubbles,
		{
			id: message.id,
			kind: 'normal',
			messageIds: [message.id],
			pubkey: message.pubkey,
			content: message.content,
			speechType,
			expiresAt: now + options.duration
		}
	];

	return copyState(state, { normalBubbles, mergedBubbles, processedMessageIds });
}

export function applyVisibility(
	state: ConversationState,
	visiblePubkeys: ReadonlySet<string>
): ConversationState {
	const dismissed = state.normalBubbles.filter((bubble) => !visiblePubkeys.has(bubble.pubkey));
	if (dismissed.length === 0) return state;

	const dismissedNormalMessageIds = new Set(state.dismissedNormalMessageIds);
	for (const bubble of dismissed) {
		for (const messageId of bubble.messageIds) dismissedNormalMessageIds.add(messageId);
	}

	return copyState(state, {
		normalBubbles: state.normalBubbles.filter((bubble) => visiblePubkeys.has(bubble.pubkey)),
		dismissedNormalMessageIds
	});
}

export function pruneExpired(state: ConversationState, now: number): ConversationState {
	const normalBubbles = state.normalBubbles.filter((bubble) => bubble.expiresAt > now);
	const mergedBubbles = state.mergedBubbles.filter((bubble) => bubble.expiresAt > now);
	if (normalBubbles.length === state.normalBubbles.length && mergedBubbles.length === state.mergedBubbles.length) {
		return state;
	}

	return copyState(state, { normalBubbles, mergedBubbles });
}
