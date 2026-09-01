import { RECENT_MESSAGE_TIMELINE_LIMIT, type ParsedWorldMessage } from './nostrProtocol';

export type RecentMessageTimeline = readonly ParsedWorldMessage[];

function compareMessages(first: ParsedWorldMessage, second: ParsedWorldMessage): number {
	if (second.createdAt !== first.createdAt) return second.createdAt - first.createdAt;
	return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
}

export function createRecentMessageTimeline(messages: readonly ParsedWorldMessage[] = []): RecentMessageTimeline {
	const byId = new Map<string, ParsedWorldMessage>();
	for (const message of messages) {
		if (!byId.has(message.id)) byId.set(message.id, message);
	}
	return [...byId.values()].sort(compareMessages).slice(0, RECENT_MESSAGE_TIMELINE_LIMIT);
}

export function addRecentMessage(
	timeline: RecentMessageTimeline,
	message: ParsedWorldMessage
): RecentMessageTimeline {
	if (timeline.some((entry) => entry.id === message.id)) return timeline;
	return createRecentMessageTimeline([...timeline, message]);
}
