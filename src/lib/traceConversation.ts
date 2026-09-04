import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';

export type TraceConversationConfig = Readonly<{
	rootId: string;
	currentId: string;
}>;

export type TraceReplyRefreshState = 'loading' | 'settled' | 'unavailable';

export type TraceConversationState =
	| Readonly<{ kind: 'closed' }>
	| Readonly<{
		kind: 'open';
		root: ParsedWorldMessage;
		config: TraceConversationConfig;
		replies: readonly ParsedTraceReply[];
		replyRefresh: TraceReplyRefreshState;
	}>;

export type TraceConversationOpenResult = Readonly<{
	kind: 'opened' | 'blocked' | 'pending' | 'unavailable';
}>;

export type TraceConversationController = Readonly<{
	openTraceConversation(config: TraceConversationConfig): TraceConversationOpenResult;
	selectTraceConversationSpeech(targetId: string): TraceConversationOpenResult;
	closeTraceConversation(): void;
	getTraceConversationState(): TraceConversationState;
}>;
