import type { Character } from './character';
import { deriveCharacterFromPubkey } from './characterAssignment';
import {
	fieldLocalToViewport,
	gridToWorld,
	type Bounds,
	type Direction,
	type GridPosition,
	type WorldPoint,
	worldToScreen
} from './geometry';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationState } from './traceConversation';

export type TraceReplyRepresentativeState = Readonly<{
	rootId: string | null;
	representativeByCurrent: Readonly<Record<string, Readonly<Record<string, string>>>>;
}>;

export type TraceSpeech =
	| Readonly<{ kind: 'root'; event: ParsedWorldMessage }>
	| Readonly<{ kind: 'reply'; event: ParsedTraceReply }>;

export type TraceConversationProjection = Readonly<{
	root: ParsedWorldMessage;
	current: TraceSpeech;
	parent: TraceSpeech | null;
	directReplies: readonly ParsedTraceReply[];
}>;

export type NumberedTraceReply = Readonly<{
	reply: ParsedTraceReply;
	authorOrdinal: number | null;
}>;

export type TraceReplyCell = Readonly<{
	position: GridPosition;
	replies: readonly ParsedTraceReply[];
	representative: ParsedTraceReply;
	count: number;
}>;

export type TraceReplyPresentation = Readonly<{
	state: TraceReplyRepresentativeState;
	cells: readonly TraceReplyCell[];
}>;

export type TraceReplyCellProjection = Readonly<{
	position: GridPosition;
	screen: WorldPoint;
	visibility: 'onscreen' | 'offscreen';
	edge?: Readonly<{ point: WorldPoint; direction: Direction }>;
}>;

export type TraceGhostPlacement = Readonly<{
	offset: WorldPoint;
	scale: number;
	subdued: boolean;
}>;

export const EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE: TraceReplyRepresentativeState = {
	rootId: null,
	representativeByCurrent: {}
};

function cellKey(position: GridPosition): string {
	return `${position.x},${position.y}`;
}

function compareReplies(first: ParsedTraceReply, second: ParsedTraceReply): number {
	return second.createdAt - first.createdAt ||
		(first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
}

function acceptedReplies(state: Extract<TraceConversationState, { kind: 'open' }>): readonly ParsedTraceReply[] {
	const unique = new Map<string, ParsedTraceReply>();
	for (const reply of state.replies) {
		if (reply.rootId === state.root.id && !unique.has(reply.id)) {
			unique.set(reply.id, reply);
		}
	}
	return [...unique.values()].sort(compareReplies);
}

export function resolveTraceConversationProjection(
	conversation: TraceConversationState
): TraceConversationProjection | null {
	if (conversation.kind === 'closed' || conversation.config.rootId !== conversation.root.id) return null;
	const replies = acceptedReplies(conversation);
	const replyById = new Map(replies.map((reply) => [reply.id, reply]));
	const current: TraceSpeech | null = conversation.config.currentId === conversation.root.id
		? { kind: 'root', event: conversation.root }
		: (() => {
			const reply = replyById.get(conversation.config.currentId);
			return reply ? { kind: 'reply' as const, event: reply } : null;
		})();
	if (!current) return null;

	let parent: TraceSpeech | null = null;
	if (current.kind === 'reply') {
		if (current.event.parentKind === 42) {
			if (current.event.parentId !== conversation.root.id) return null;
			parent = { kind: 'root', event: conversation.root };
		} else {
			const reply = replyById.get(current.event.parentId);
			if (!reply) return null;
			parent = { kind: 'reply', event: reply };
		}
	}

	const parentKind = current.kind === 'root' ? 42 : 1111;
	const directReplies = replies.filter((reply) =>
		reply.parentKind === parentKind && reply.parentId === current.event.id
	);
	return { root: conversation.root, current, parent, directReplies };
}

export function adjacentTraceSpeech(
	projection: TraceConversationProjection,
	targetId: string
): TraceSpeech | null {
	if (projection.parent && projection.parent.event.id === targetId) return projection.parent;
	const child = projection.directReplies.find((reply) => reply.id === targetId);
	return child ? { kind: 'reply', event: child } : null;
}

export function numberTraceReplyAuthors(
	replies: readonly ParsedTraceReply[]
): readonly NumberedTraceReply[] {
	const unique = new Map<string, ParsedTraceReply>();
	for (const reply of replies) if (!unique.has(reply.id)) unique.set(reply.id, reply);
	const ordered = [...unique.values()].sort(compareReplies);
	const totals = new Map<string, number>();
	for (const reply of ordered) totals.set(reply.pubkey, (totals.get(reply.pubkey) ?? 0) + 1);
	const seen = new Map<string, number>();
	return ordered.map((reply) => {
		const ordinal = (seen.get(reply.pubkey) ?? 0) + 1;
		seen.set(reply.pubkey, ordinal);
		return { reply, authorOrdinal: (totals.get(reply.pubkey) ?? 0) > 1 ? ordinal : null };
	});
}

/**
 * Reconciles the viewer-local representative selection against an accepted
 * reply snapshot. Relay/cache order is deliberately irrelevant here.
 */
export function reconcileTraceReplyPresentation(
	previous: TraceReplyRepresentativeState,
	conversation: TraceConversationState
): TraceReplyPresentation {
	if (conversation.kind === 'closed') {
		return { state: EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE, cells: [] };
	}
	const projection = resolveTraceConversationProjection(conversation);
	if (!projection) return { state: EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE, cells: [] };
	const preserveRoot = previous.rootId === conversation.root.id;
	const currentId = projection.current.event.id;
	const previousByCurrent = preserveRoot ? previous.representativeByCurrent : {};
	const previousByCell = previousByCurrent[currentId] ?? {};
	const grouped = new Map<string, ParsedTraceReply[]>();
	for (const reply of projection.directReplies) {
		const key = cellKey(reply.position);
		const replies = grouped.get(key) ?? [];
		replies.push(reply);
		grouped.set(key, replies);
	}

	const representativeByCell: Record<string, string> = {};
	const cells = [...grouped.entries()].map(([key, replies]) => {
		const retainedId = previousByCell[key];
		const representative = replies.find((reply) => reply.id === retainedId) ?? replies[0];
		representativeByCell[key] = representative.id;
		return {
			position: { ...representative.position },
			replies,
			representative,
			count: replies.length
		};
	}).sort((first, second) =>
		first.position.y - second.position.y || first.position.x - second.position.x
	);

	return {
		state: {
			rootId: conversation.root.id,
			representativeByCurrent: { ...previousByCurrent, [currentId]: representativeByCell }
		},
		cells
	};
}

function isInside(point: WorldPoint, bounds: Bounds): boolean {
	return point.x >= bounds.x && point.x <= bounds.x + bounds.width &&
		point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function directionForVector(dx: number, dy: number): Direction {
	if (dx === 0 && dy === 0) return 'up';
	const sector = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
	const directions: readonly Direction[] = [
		'right', 'down-right', 'down', 'down-left',
		'left', 'up-left', 'up', 'up-right'
	];
	return directions[(sector + 8) % 8];
}

export function projectPointToViewportEdge(
	target: WorldPoint,
	bounds: Bounds,
	margin = 12
): Readonly<{ point: WorldPoint; direction: Direction }> {
	const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
	const dx = target.x - center.x;
	const dy = target.y - center.y;
	const halfWidth = Math.max(0, bounds.width / 2 - margin);
	const halfHeight = Math.max(0, bounds.height / 2 - margin);
	const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
	const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
	const scale = Math.min(scaleX, scaleY);
	return {
		point: {
			x: center.x + dx * (Number.isFinite(scale) ? scale : 0),
			y: center.y + dy * (Number.isFinite(scale) ? scale : 0)
		},
		direction: directionForVector(dx, dy)
	};
}

export function projectTraceReplyCell(input: Readonly<{
	position: GridPosition;
	cellSize: number;
	camera: WorldPoint;
	fieldArea: Pick<Bounds, 'x' | 'y'>;
	visibleBounds: Bounds;
}>): TraceReplyCellProjection {
	const screen = fieldLocalToViewport(
		worldToScreen(gridToWorld(input.position, input.cellSize), input.camera),
		input.fieldArea
	);
	if (isInside(screen, input.visibleBounds)) {
		return { position: { ...input.position }, screen, visibility: 'onscreen' };
	}
	return {
		position: { ...input.position },
		screen,
		visibility: 'offscreen',
		edge: projectPointToViewportEdge(screen, input.visibleBounds)
	};
}

export function resolveTraceGhostPlacement(input: Readonly<{
	kind: 'root' | 'reply';
	cellSize: number;
	hasParticipant: boolean;
	hasRootGhost: boolean;
}>): TraceGhostPlacement {
	const collides = input.hasParticipant || (input.kind === 'reply' && input.hasRootGhost);
	if (!collides) return { offset: { x: 0, y: 0 }, scale: 1, subdued: false };
	return {
		offset: {
			x: input.cellSize * (input.kind === 'root' ? -0.29 : 0.29),
			y: input.cellSize * 0.27
		},
		scale: 0.58,
		subdued: true
	};
}

export function deriveTraceReplyCharacter(
	reply: Pick<ParsedTraceReply, 'pubkey'>,
	catalog: readonly Character[]
): Character {
	return deriveCharacterFromPubkey(reply.pubkey, catalog);
}
