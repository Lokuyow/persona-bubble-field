import {
	createConversationState,
	getPrototypeDisplayDuration,
	pruneExpired,
	receiveMessage,
	type ConversationMessage,
	type ConversationState
} from './conversation';
import type { ParsedWorldMessage } from './nostrProtocol';

function toConversationMessage(message: ParsedWorldMessage): ConversationMessage {
	return {
		id: message.id,
		pubkey: message.pubkey,
		content: message.content,
		speechType: message.speechType,
		createdAt: message.createdAt * 1000
	};
}

/**
 * Replays the bootstrap window at event time, then removes only bubbles whose
 * final state has expired at entry. This preserves merged-bubble membership and
 * expiry resets that depend on earlier messages in the sequence.
 */
export function replayBootstrapConversation(
	messages: readonly ParsedWorldMessage[],
	entryVisiblePubkeys: ReadonlySet<string>,
	entryNowMs: number
): ConversationState {
	let state = createConversationState();
	for (const message of [...messages].sort((first, second) =>
		first.createdAt - second.createdAt || first.id.localeCompare(second.id)
	)) {
		const conversationMessage = toConversationMessage(message);
		state = receiveMessage(state, conversationMessage, {
			isSpeakerVisible: entryVisiblePubkeys.has(message.pubkey),
			duration: getPrototypeDisplayDuration(message.content),
			now: conversationMessage.createdAt
		});
	}

	return pruneExpired(state, entryNowMs);
}
