<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { asset, base } from '$app/paths';
	import { Avatar } from 'bits-ui';
	import {
		applyVisibility,
		createConversationState,
		getPrototypeDisplayDuration,
		pruneExpired,
		receiveMessage,
		type ConversationState
	} from '$lib/conversation';
	import { replayBootstrapConversation } from '$lib/bootstrapConversation';
	import {
		clampToBounds,
		fieldLocalToViewport,
		getActualFieldTop,
		getFieldAreaBounds,
		getFieldWorldSize,
		getResponsiveCellSize,
		gridToWorld,
		MOBILE_FIELD_BREAKPOINT,
		mergedBubblePreferredAnchor,
		normalBubblePreferredAnchor,
		placeBubbles,
		placeBubblesWithFixed,
		type Direction,
		type Size,
		type WorldPoint,
		worldToScreen
	} from '$lib/geometry';
	import {
		buildFieldCellActions,
		resolveFieldCellActions,
		viewportPointToLogicalCell,
		type FieldCellAction
	} from '$lib/fieldSelection';
	import {
		clampJoystickThumb,
		isJoystickDrag,
		joystickDirection,
		type JoystickPoint
	} from '$lib/pointerJoystick';
	import {
		DEV_WORLD_SELF_ID,
		getDevWorldCharacter,
		isDevWorldSandboxEnabled,
		moveDevWorldSelf,
		resetDevWorldPresence,
		resolveDevWorldCharacterId
	} from '$lib/devWorldSandbox';
	import { CHARACTER_CATALOG, type Character } from '$lib/character';
	import { deriveCharacterFromPubkey } from '$lib/characterAssignment';
	import ProfileDialog from '$lib/ProfileDialog.svelte';
	import {
		CURRENT_CHARACTER_PROFILE_REVISION,
		loadOrCreateAccount,
		type AccountSnapshot
	} from '$lib/nostrAccount';
	import {
		prepareCharacterProfilePublication,
		publishCharacterProfile,
		type PreparedCharacterProfilePublication
	} from '$lib/initialProfilePublication';
	import { projectPresence } from '$lib/presenceProjection';
	import { createPresenceState, type PresenceState } from '$lib/presence';
	import { addRecentMessage, createRecentMessageTimeline, type RecentMessageTimeline } from '$lib/recentMessageTimeline';
	import { getVirtualKeyboardBottomInset, getVisualViewportKeyboardInset, type ViewportRect } from '$lib/keyboardInset';
	import type { ParsedTraceReply, ParsedWorldMessage } from '$lib/nostrProtocol';
	import {
		groupTraceRoots,
		stepTraceRootSelection,
		traceSelectionDetails
	} from '$lib/traceInvestigation';
	import type {
		TraceConversationController,
		TraceConversationState
	} from '$lib/traceConversation';
	import type { DevTraceConversationRuntime } from '$lib/devTraceConversationRuntime';
	import {
		deriveTraceReplyCharacter,
		EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE,
		numberTraceReplyAuthors,
		projectTraceReplyCell,
		reconcileTraceReplyPresentation,
		resolveTraceConversationProjection,
		resolveTraceGhostPlacement,
		type TraceReplyCell,
		type TraceReplyRepresentativeState,
		type TraceSpeech
	} from '$lib/traceReplyPresentation';
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
	import { resolveSpeechSubmission } from '$lib/speechSubmission';
	import type { SpeechType } from '$lib/conversation';
	import { createSpeechBubbleShape, type SpeechBubbleShape } from '$lib/speechBubblePath';
	import {
		createWorldReadSession,
		type SelfMessageAvailability,
		type SelfPositionWriteState,
		type WorldReadConnectionStatus
	} from '$lib/worldReadSession';

	const FIELD = {
		columns: 16,
		rows: 8
	} as const;
	const FIELD_BACKGROUND_ASSET = '/field/prototype-urban-park.png';
	const DEFAULT_VIEWPORT = { width: 1100, height: 680 };
	const SPEECH_AREA = {
		top: 84,
		height: 176,
		sidePadding: 16
	} as const;
	const DEFAULT_BUBBLE_SIZES = {
		normal: { width: 184, height: 54 },
		merged: { width: 218, height: 58 }
	} satisfies Record<'normal' | 'merged', Size>;
	const MOVEMENT_ANIMATION_DURATION_MS = 400;
	const INITIAL_COMPOSER_PREFERRED_HEIGHT = 50;
	const SPECIAL_TAIL_BODY_EXTENSION = 26;
	const SPEECH_TYPE_ORDER: readonly SpeechType[] = ['normal', 'shout', 'monologue'];
	const SPEECH_TYPE_LABELS: Readonly<Record<SpeechType, string>> = {
		normal: '通常',
		shout: '叫び',
		monologue: 'モノローグ'
	};
	const initialDevWorldSandboxEnabled = import.meta.env.DEV &&
		isDevWorldSandboxEnabled(import.meta.env.DEV, page.url.searchParams);

	type AvatarColor = 'coral' | 'lavender' | 'mint' | 'yellow' | 'sky' | 'peach' | 'rose' | 'blue';
	type Participant = {
		id: string;
		character: Character;
		color: AvatarColor;
	};
	const AVATAR_COLORS: readonly AvatarColor[] = ['coral', 'lavender', 'mint', 'yellow', 'sky', 'peach', 'rose', 'blue'];

	let presenceState: PresenceState = { field: FIELD, participants: [] };
	let viewportElement: HTMLElement;
	let viewportSize: Size = DEFAULT_VIEWPORT;
	let bubbleSizes: Record<string, Size> = {};
	let bubbleOverflowById: Record<string, boolean> = {};
	const mountedBubbleNodes = new Map<string, HTMLElement>();
	let conversationState: ConversationState = createConversationState();
	let lastPlacedAnchorById: Record<string, WorldPoint> = {};
	let lastVisibilityKey: string | null = null;
	let colorByPubkey: Record<string, AvatarColor> = {};
	let recentMessageTimeline: RecentMessageTimeline = [];
	let effectiveTraceRoots: readonly ParsedWorldMessage[] = [];
	let traceConversationState: TraceConversationState = { kind: 'closed' };
	let traceReplyRepresentativeState: TraceReplyRepresentativeState = EMPTY_TRACE_REPLY_REPRESENTATIVE_STATE;
	let traceReplyCells: readonly TraceReplyCell[] = [];
	let traceConversationController: TraceConversationController | null = null;
	let devTraceConversationRuntime: DevTraceConversationRuntime | null = null;
	let devTraceReplies: readonly ParsedTraceReply[] = [];
	let devTraceReplyFixtureEnabled = false;
	let fieldActionMenu: Readonly<{
		position: { x: number; y: number };
		actions: readonly FieldCellAction[];
	}> | null = null;
	let timelineOverflowById: Record<string, boolean> = {};
	let timelineEntryHeights: Record<string, number> = {};
	let timelineAvailableHeight = 0;
	let timelineInitialized = false;
	let timelineOpen = false;
	let connectionStatus: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let selfAccount: AccountSnapshot | null = null;
	let selfPositionWriteState: SelfPositionWriteState = { kind: 'unavailable' };
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let composerPreferredHeight: number | null = null;
	let composerKeyboardInset = 0;
	let worldSession: ReturnType<typeof createWorldReadSession> | null = null;
	let runtimeMode: 'relay' | 'dev' = initialDevWorldSandboxEnabled ? 'dev' : 'relay';
	let devWorldSandboxEnabled = initialDevWorldSandboxEnabled;
	let pendingComposerSubmission: Readonly<{
		resolve: () => void;
		reject: (error: Error) => void;
		cleanup: () => void;
	}> | null = null;
	let composerStartupError: Error | null = null;
	let composerSubmissionInProgress = false;
	let entryRetryable = false;
	let selectedCharacterId = '001';
	let selectedSpeechType: SpeechType = 'normal';
	let lastProfileTrigger: HTMLButtonElement | null = null;
	let composerEditorIsEmpty: boolean | null = null;
	let composerComponent: { focusEditor(): boolean; blurEditor(): boolean } | null = null;
	let visualWorldById: Record<string, WorldPoint> = {};
	let visualCamera: WorldPoint | null = null;
	let visualMotion: VisualMotion | null = null;
	let visualAnimationFrame: number | null = null;
	let visualProjectionInitialized = false;
	let prefersReducedMotion = false;
	let stopMovementHold = () => {};
	let cancelPointerJoystick = () => {};
	let movementHoldTakeover = (_pointerId: number, _direction: Direction) => {};
	let movementHoldUpdatePointer = (_pointerId: number, _direction: Direction) => {};
	let movementHoldStopPointer = (_pointerId: number) => {};
	let pointerJoystick: Readonly<{
		center: JoystickPoint;
		thumb: JoystickPoint;
		direction: Direction;
	}> | null = null;

	type VisualParticipantTransition = Readonly<{ from: WorldPoint; to: WorldPoint }>;
	type VisualMotion = Readonly<{
		startedAt: number;
		fromCamera: WorldPoint;
		toCamera: WorldPoint;
		participants: ReadonlyMap<string, VisualParticipantTransition>;
	}>;

	$: cellSize = getResponsiveCellSize(viewportSize.width);
	$: field = { ...FIELD, cellSize };
	$: fieldWorldSize = getFieldWorldSize(field);
	$: speechAreaBounds = {
		x: SPEECH_AREA.sidePadding,
		y: SPEECH_AREA.top,
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: SPEECH_AREA.height
	};
	$: fieldAreaBounds = getFieldAreaBounds(viewportSize, speechAreaBounds);
	$: selfProjectionId = devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfAccount?.pubkey ?? 'you';
	$: presenceProjection = getPresenceProjection(presenceState, selectedCharacterId, selfProjectionId);
	$: isWorldSelfActive = Boolean(selfAccount && presenceState.participants.some((participant) =>
		participant.id === selfAccount?.pubkey && participant.status === 'active'
	));
	$: camera = visualCamera ?? presenceProjection.camera;
	$: actualFieldTop = getActualFieldTop(fieldAreaBounds, camera);
	$: speechAreaVisualBounds = {
		x: 0,
		y: 0,
		width: viewportSize.width,
		height: actualFieldTop
	};
	$: bubbleSafeBounds = {
		x: SPEECH_AREA.sidePadding,
		y: SPEECH_AREA.top,
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: Math.max(0, actualFieldTop - SPEECH_AREA.top)
	};
	$: bubbleVisualRegion = {
		x: 0,
		y: bubbleSafeBounds.y,
		width: viewportSize.width,
		height: Math.max(bubbleSafeBounds.height, ...Object.values(bubbleSizes).map((size) => size.height))
	};

	$: participantViews = presenceProjection.participants.map((participant) => {
		const world = visualWorldById[participant.id] ?? participant.world;
		return {
			...participant,
			world,
			screen: fieldLocalToViewport(worldToScreen(world, camera), fieldAreaBounds)
		};
	});

	$: participantById = new Map(participantViews.map((participant) => [participant.id, participant]));
	$: traceRootCells = groupTraceRoots(effectiveTraceRoots);
	$: traceLightCells = traceRootCells.map((cell) => ({
		...cell,
		occupied: participantViews.some((participant) =>
			participant.position.x === cell.position.x && participant.position.y === cell.position.y
		)
	}));
	$: traceConversationProjection = resolveTraceConversationProjection(traceConversationState);
	$: selectedTraceDetails = traceConversationState.kind === 'open' &&
		traceConversationState.config.currentId === traceConversationState.root.id
		? traceSelectionDetails({
			position: traceConversationState.root.position,
			rootId: traceConversationState.root.id
		}, traceRootCells)
		: null;
	$: traceVisibleBounds = {
		x: fieldAreaBounds.x,
		y: actualFieldTop,
		width: fieldAreaBounds.width,
		height: Math.max(0, fieldAreaBounds.y + fieldAreaBounds.height - actualFieldTop)
	};
	$: projectedTraceReplyCells = traceReplyCells.map((cell) => ({
		cell,
		projection: projectTraceReplyCell({
			position: cell.position,
			cellSize,
			camera,
			fieldArea: fieldAreaBounds,
			visibleBounds: traceVisibleBounds
		})
	}));
	$: offscreenTraceReplyCells = projectedTraceReplyCells.filter(({ projection }) =>
		projection.visibility === 'offscreen'
	);
	$: projectedTraceParent = traceConversationProjection?.parent ? {
		speech: traceConversationProjection.parent,
		projection: projectTraceReplyCell({
			position: traceConversationProjection.parent.event.position,
			cellSize,
			camera,
			fieldArea: fieldAreaBounds,
			visibleBounds: traceVisibleBounds
		})
	} : null;
	$: traceNavigationPositions = [
		...traceRootCells.map((cell) => cell.position),
		...(traceConversationProjection?.parent ? [traceConversationProjection.parent.event.position] : []),
		...(traceConversationProjection?.directReplies.map((reply) => reply.position) ?? [])
	].filter((position, index, positions) => positions.findIndex((candidate) => sameCell(candidate, position)) === index);
	$: traceOnlyCellTriggers = traceNavigationPositions.filter((position) =>
		!participantViews.some((participant) => sameCell(participant.position, position)) &&
		actionsForCell(position).length > 0
	);

	$: visibleParticipantIds = new Set(
		participantViews.filter((participant) => isInsideFieldArea(participant.screen)).map((participant) => participant.id)
	);
	$: visibleParticipantKey = [...visibleParticipantIds].sort().join('|');
	$: syncVisibility(visibleParticipantKey, visibleParticipantIds);

	$: visibleNormalBubbles = conversationState.normalBubbles
		.map((bubble) => {
			const speaker = participantById.get(bubble.pubkey);
			if (!speaker || !isInsideFieldArea(speaker.screen)) return null;
			const size = bubbleSizes[bubble.id] ?? DEFAULT_BUBBLE_SIZES.normal;
			const shape = specialBubbleShape(bubble.speechType, bubble.id, size);
			const preferred = normalBubblePreferredAnchor(
				speaker.screen.x,
				speaker.world.y / cellSize - 0.5,
				field.rows,
				size,
				bubbleSafeBounds
			);
			return {
				...bubble,
				text: bubble.content,
				tone: participantTone(speaker),
				anchor: clampToBounds(preferred, size, bubbleSafeBounds),
				size,
				shape,
				speaker
			};
		})
		.filter((bubble): bubble is NonNullable<typeof bubble> => bubble !== null);

	$: visibleMergedBubbles = conversationState.mergedBubbles
		.map((bubble) => {
			const members = bubble.memberPubkeys
				.map((id) => participantById.get(id))
				.filter((participant): participant is (typeof participantViews)[number] => Boolean(participant));
			const visibleMembers = members
				.filter((member) => isInsideFieldArea(member.screen))
				.sort((left, right) => left.screen.x - right.screen.x || left.id.localeCompare(right.id));
			const size = bubbleSizes[bubble.id] ?? DEFAULT_BUBBLE_SIZES.merged;
			const shape = specialBubbleShape(bubble.speechType, bubble.id, size);
			if (visibleMembers.length === 0) {
				const lastAnchor = lastPlacedAnchorById[bubble.id];
				if (!lastAnchor) return null;
				return {
					...bubble,
					text: bubble.content,
					tone: mergedBubbleTone(members),
					anchor: lastAnchor,
					size,
					shape,
					members: []
				};
			}

			const preferred = mergedBubblePreferredAnchor(
				visibleMembers.map((member) => ({ x: member.screen.x, y: member.world.y / cellSize - 0.5 })),
				field.rows,
				size,
				bubbleSafeBounds
			);
			return {
				...bubble,
				text: bubble.content,
				tone: mergedBubbleTone(members),
				anchor: clampToBounds(preferred, size, bubbleSafeBounds),
				size,
				shape,
				members: visibleMembers
			};
		})
		.filter((bubble): bubble is NonNullable<typeof bubble> => bubble !== null);

	$: placeableBubbles = [
		...visibleNormalBubbles,
		...visibleMergedBubbles.filter((bubble) => bubble.members.length > 0)
	];
	$: bubblePlacement = placeBubbles(
		placeableBubbles.map((bubble) => ({
			id: bubble.id,
			preferred: bubble.anchor,
			size: bubble.size,
			visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
		})),
		bubbleSafeBounds,
		cellSize,
		undefined,
		bubbleVisualRegion
	);
	$: placedAnchorById = new Map(bubblePlacement.map((placement) => [placement.id, placement.anchor]));
	$: rememberPlacedMergedAnchors(visibleMergedBubbles, placedAnchorById, conversationState.mergedBubbles);
	$: positionedNormalBubbles = visibleNormalBubbles.map((bubble) => ({
		...bubble,
		anchor: placedAnchorById.get(bubble.id) ?? bubble.anchor
	}));
	$: positionedMergedBubbles = visibleMergedBubbles.map((bubble) => ({
		...bubble,
		anchor: bubble.members.length === 0 ? bubble.anchor : placedAnchorById.get(bubble.id) ?? bubble.anchor
	}));
	$: positionedVisibleBubbles = [...positionedNormalBubbles, ...positionedMergedBubbles];
	$: traceCurrentView = traceConversationProjection ? buildTraceSpeechView(
		traceConversationProjection.current,
		'current',
		fieldLocalToViewport(
			worldToScreen(gridToWorld(traceConversationProjection.current.event.position, cellSize), camera),
			fieldAreaBounds
		),
		Boolean(
			traceConversationProjection.parent?.kind === 'root' &&
			sameCell(traceConversationProjection.parent.event.position, traceConversationProjection.current.event.position)
		),
		traceConversationProjection.parent?.kind === 'root' &&
			sameCell(traceConversationProjection.parent.event.position, traceConversationProjection.current.event.position)
	) : null;
	$: traceParentView = projectedTraceParent?.projection.visibility === 'onscreen' && traceCurrentView
		? buildTraceSpeechView(
			projectedTraceParent.speech,
			'parent',
			projectedTraceParent.projection.screen,
			sameCell(projectedTraceParent.speech.event.position, traceCurrentView.event.position),
			traceCurrentView.speech.kind === 'root' &&
				sameCell(traceCurrentView.event.position, projectedTraceParent.speech.event.position)
		)
		: null;
	$: traceReplyViews = projectedTraceReplyCells
		.filter(({ projection }) => projection.visibility === 'onscreen')
		.map(({ cell, projection }) => {
			const reply = cell.representative;
			const collidesWithCurrent = Boolean(traceCurrentView && sameCell(traceCurrentView.event.position, reply.position));
			const collidesWithParent = Boolean(traceParentView && sameCell(traceParentView.event.position, reply.position));
			const rootCollision = Boolean(
				(traceCurrentView?.speech.kind === 'root' && collidesWithCurrent) ||
				(traceParentView?.speech.kind === 'root' && collidesWithParent)
			);
			const view = buildTraceSpeechView(
				{ kind: 'reply', event: reply },
				'child',
				projection.screen,
				collidesWithCurrent || collidesWithParent,
				rootCollision
			);
			return {
				...view,
				cell,
				reply
			};
		});
	$: traceReplyGhosts = traceReplyViews
		.filter((view): view is typeof view & { ghost: NonNullable<typeof view.ghost> } => view.ghost !== null)
		.map((view) => ({ ...view, world: view.ghost.world, screen: view.ghost.screen }));
	$: traceBubble = traceCurrentView ? (() => {
		const event = traceCurrentView.event;
		const id = traceCurrentView.speech.kind === 'root'
			? `trace-root-${event.id}`
			: `trace-current-reply-${event.id}`;
		const size = bubbleSizes[id] ?? DEFAULT_BUBBLE_SIZES.normal;
		const shape = specialBubbleShape(event.speechType, id, size);
		const preferred = normalBubblePreferredAnchor(
			traceCurrentView.screen.x,
			event.position.y,
			field.rows,
			size,
			bubbleSafeBounds
		);
		const [placement] = placeBubblesWithFixed(
			[{
				id,
				preferred: clampToBounds(preferred, size, bubbleSafeBounds),
				size,
				visualBounds: event.speechType === 'shout' ? undefined : shape?.bounds
			}],
			positionedVisibleBubbles.map((bubble) => ({
				id: bubble.id,
				preferred: bubble.anchor,
				anchor: bubble.anchor,
				size: bubble.size,
				visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
			})),
			bubbleSafeBounds,
			cellSize,
			undefined,
			bubbleVisualRegion
		);
		return {
			...traceCurrentView,
			id,
			size,
			shape,
			anchor: placement?.anchor ?? preferred
		};
	})() : null;
	$: traceParentBubble = traceParentView ? (() => {
		const event = traceParentView.event;
		const id = `trace-parent-${traceParentView.speech.kind}-${event.id}`;
		const size = bubbleSizes[id] ?? DEFAULT_BUBBLE_SIZES.normal;
		const shape = specialBubbleShape(event.speechType, id, size);
		const preferred = normalBubblePreferredAnchor(
			traceParentView.screen.x,
			event.position.y,
			field.rows,
			size,
			bubbleSafeBounds
		);
		const [placement] = placeBubblesWithFixed(
			[{
				id,
				preferred: clampToBounds(preferred, size, bubbleSafeBounds),
				size,
				visualBounds: event.speechType === 'shout' ? undefined : shape?.bounds
			}],
			[
				...positionedVisibleBubbles.map((bubble) => ({
					id: bubble.id, preferred: bubble.anchor, anchor: bubble.anchor, size: bubble.size,
					visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
				})),
				...(traceBubble ? [{
					id: traceBubble.id, preferred: traceBubble.anchor, anchor: traceBubble.anchor,
					size: traceBubble.size,
					visualBounds: traceBubble.event.speechType === 'shout' ? undefined : traceBubble.shape?.bounds
				}] : [])
			],
			bubbleSafeBounds,
			cellSize,
			undefined,
			bubbleVisualRegion
		);
		return { ...traceParentView, id, size, shape, anchor: placement?.anchor ?? preferred };
	})() : null;
	$: traceReplyBubbleCandidates = traceReplyViews.map((ghost) => {
		const id = `trace-reply-${ghost.reply.id}`;
		const size = bubbleSizes[id] ?? DEFAULT_BUBBLE_SIZES.normal;
		const shape = specialBubbleShape(ghost.reply.speechType, id, size);
		const preferred = normalBubblePreferredAnchor(
			ghost.screen.x,
			ghost.reply.position.y,
			field.rows,
			size,
			bubbleSafeBounds
		);
		return {
			...ghost,
			id,
			size,
			shape,
			preferred: clampToBounds(preferred, size, bubbleSafeBounds)
		};
	});
	$: traceReplyBubblePlacements = placeBubblesWithFixed(
		traceReplyBubbleCandidates.map((bubble) => ({
			id: bubble.id,
			preferred: bubble.preferred,
			size: bubble.size,
			visualBounds: bubble.reply.speechType === 'shout' ? undefined : bubble.shape?.bounds
		})),
		[
			...positionedVisibleBubbles.map((bubble) => ({
				id: bubble.id,
				preferred: bubble.anchor,
				anchor: bubble.anchor,
				size: bubble.size,
				visualBounds: bubble.speechType === 'shout' ? undefined : bubble.shape?.bounds
			})),
			...(traceBubble ? [{
				id: traceBubble.id,
				preferred: traceBubble.anchor,
				anchor: traceBubble.anchor,
				size: traceBubble.size,
				visualBounds: traceBubble.event.speechType === 'shout' ? undefined : traceBubble.shape?.bounds
			}] : []),
			...(traceParentBubble ? [{
				id: traceParentBubble.id,
				preferred: traceParentBubble.anchor,
				anchor: traceParentBubble.anchor,
				size: traceParentBubble.size,
				visualBounds: traceParentBubble.event.speechType === 'shout' ? undefined : traceParentBubble.shape?.bounds
			}] : [])
		],
		bubbleSafeBounds,
		cellSize,
		undefined,
		bubbleVisualRegion
	);
	$: traceReplyAnchorById = new Map(traceReplyBubblePlacements.map((placement) => [placement.id, placement.anchor]));
	$: traceReplyBubbles = traceReplyBubbleCandidates.map((bubble) => ({
		...bubble,
		anchor: traceReplyAnchorById.get(bubble.id) ?? bubble.preferred
	}));
	$: movingParticipantIds = visualMotion ? new Set(visualMotion.participants.keys()) : new Set<string>();

	function lerp(first: number, second: number, progress: number): number {
		return first + (second - first) * progress;
	}

	function lerpPoint(first: WorldPoint, second: WorldPoint, progress: number): WorldPoint {
		return { x: lerp(first.x, second.x, progress), y: lerp(first.y, second.y, progress) };
	}

	function easeOut(progress: number): number {
		return 1 - Math.pow(1 - progress, 3);
	}

	function cancelVisualAnimation(): void {
		if (visualAnimationFrame !== null) {
			cancelAnimationFrame(visualAnimationFrame);
			visualAnimationFrame = null;
		}
		visualMotion = null;
	}

	function sampleVisualAnimation(now = performance.now()): void {
		if (!visualMotion) return;
		const progress = Math.min(1, Math.max(0, (now - visualMotion.startedAt) / MOVEMENT_ANIMATION_DURATION_MS));
		const eased = easeOut(progress);
		const nextWorldById: Record<string, WorldPoint> = {};
		for (const [id, transition] of visualMotion.participants) {
			nextWorldById[id] = lerpPoint(transition.from, transition.to, eased);
		}
		visualWorldById = nextWorldById;
		visualCamera = lerpPoint(visualMotion.fromCamera, visualMotion.toCamera, eased);

		if (progress >= 1) {
			visualMotion = null;
			if (visualAnimationFrame !== null) {
				cancelAnimationFrame(visualAnimationFrame);
				visualAnimationFrame = null;
			}
			visualWorldById = Object.fromEntries(presenceProjection.participants.map((participant) => [participant.id, participant.world]));
			visualCamera = presenceProjection.camera;
		}
	}

	function scheduleVisualAnimation(): void {
		if (!visualMotion || visualAnimationFrame !== null) return;
		visualAnimationFrame = requestAnimationFrame(() => {
			visualAnimationFrame = null;
			sampleVisualAnimation();
			scheduleVisualAnimation();
		});
	}

	function syncVisualToCanonical(): void {
		cancelVisualAnimation();
		visualWorldById = Object.fromEntries(presenceProjection.participants.map((participant) => [participant.id, participant.world]));
		visualCamera = presenceProjection.camera;
		visualProjectionInitialized = true;
	}

	function animatePresenceTransition(previous: ReturnType<typeof getPresenceProjection>, next: ReturnType<typeof getPresenceProjection>): void {
		const logicalParticipantsChanged = previous.participants.length !== next.participants.length || previous.participants.some((participant, index) => {
			const nextParticipant = next.participants[index];
			return !nextParticipant ||
				participant.id !== nextParticipant.id ||
				participant.position.x !== nextParticipant.position.x ||
				participant.position.y !== nextParticipant.position.y;
		});
		if (!logicalParticipantsChanged) return;

		if (!visualProjectionInitialized) {
			visualWorldById = Object.fromEntries(next.participants.map((participant) => [participant.id, participant.world]));
			visualCamera = next.camera;
			visualProjectionInitialized = true;
			return;
		}

		const now = performance.now();
		const hadActiveVisualMotion = visualMotion !== null;
		sampleVisualAnimation(now);
		const currentVisualWorldById = visualWorldById;
		const currentVisualCamera = visualCamera ?? previous.camera;
		const previousById = new Map(previous.participants.map((participant) => [participant.id, participant]));
		const transitions = new Map<string, VisualParticipantTransition>();
		for (const participant of next.participants) {
			const previousParticipant = previousById.get(participant.id);
			const currentWorld = currentVisualWorldById[participant.id] ?? previousParticipant?.world ?? participant.world;
			transitions.set(participant.id, currentWorld.x !== participant.world.x || currentWorld.y !== participant.world.y
				? { from: currentWorld, to: participant.world }
				: { from: participant.world, to: participant.world });
		}

		const movedIds = new Map([...transitions].filter(([, transition]) =>
			transition.from.x !== transition.to.x || transition.from.y !== transition.to.y
		));
		const previousSelf = previousById.get(selfProjectionId);
		const nextSelf = next.participants.find((participant) => participant.id === selfProjectionId);
		const selfMoved = Boolean(previousSelf && nextSelf && (
			previousSelf.position.x !== nextSelf.position.x || previousSelf.position.y !== nextSelf.position.y
		));
		const cameraCanAnimate = hadActiveVisualMotion || selfMoved;
		const cameraMoved = cameraCanAnimate && (currentVisualCamera.x !== next.camera.x || currentVisualCamera.y !== next.camera.y);
		if (prefersReducedMotion || (movedIds.size === 0 && !cameraMoved)) {
			cancelVisualAnimation();
			visualWorldById = Object.fromEntries(next.participants.map((participant) => [participant.id, participant.world]));
			visualCamera = next.camera;
			return;
		}

		visualWorldById = Object.fromEntries([...transitions].map(([id, transition]) => [id, transition.from]));
		visualCamera = currentVisualCamera;
		visualMotion = {
			startedAt: now,
			fromCamera: currentVisualCamera,
			toCamera: next.camera,
			participants: movedIds
		};
		sampleVisualAnimation(now);
		scheduleVisualAnimation();
	}

	onMount(() => {
		let mounted = true;
		let startRequested = false;
		let session: ReturnType<typeof createWorldReadSession> | null = null;
		timelineInitialized = true;
		timelineOpen = window.innerWidth > MOBILE_FIELD_BREAKPOINT;
		const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		prefersReducedMotion = reducedMotionQuery.matches;
		const handleReducedMotionChange = () => {
			prefersReducedMotion = reducedMotionQuery.matches;
			if (prefersReducedMotion) syncVisualToCanonical();
		};
		reducedMotionQuery.addEventListener('change', handleReducedMotionChange);

		if (devWorldSandboxEnabled) {
			const devSearchParams = new URLSearchParams(window.location.search);
			selectedCharacterId = resolveDevWorldCharacterId(devSearchParams);
			resetSandbox();
			const devSpeech = devSearchParams.get('devSpeech');
			if (import.meta.env.DEV && devSpeech) {
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
			const devTrace = devSearchParams.get('devTrace');
			if (import.meta.env.DEV && (devTrace === 'lights' || devTrace === 'replies')) {
				seedDevTraceLightFixture();
			}
			if (import.meta.env.DEV && devTrace === 'replies') {
				devTraceReplyFixtureEnabled = true;
				seedDevTraceReplyFixture();
			}
			if (import.meta.env.DEV) {
				void import('$lib/devTraceConversationRuntime').then(({ createDevTraceConversationRuntime }) => {
					if (!mounted || !devWorldSandboxEnabled) return;
					const runtime = createDevTraceConversationRuntime({
						selfId: DEV_WORLD_SELF_ID,
						getPresence: () => presenceState,
						setPresence,
						getEffectiveRoots: () => effectiveTraceRoots,
						getReplies: () => devTraceReplies,
						onStateChanged: setTraceConversation
					});
					devTraceConversationRuntime = runtime;
					traceConversationController = runtime;
				});
			}
		}

		const begin = async () => {
			if (devWorldSandboxEnabled || startRequested || !hasUsableViewport()) return;
			startRequested = true;
			let characterProfilePublication: PreparedCharacterProfilePublication | null = null;
			try {
				const accountResult = await loadOrCreateAccount();
				if (accountResult.kind === 'created' || accountResult.kind === 'restored') {
					selfAccount = accountResult.account;
				}
				if (selfAccount && selfAccount.characterProfileRevision !== CURRENT_CHARACTER_PROFILE_REVISION) {
					const character = deriveCharacterFromPubkey(selfAccount.pubkey, CHARACTER_CATALOG);
					const absolutePictureUrl = new URL(
						asset(`/${character.picture}`),
						window.location.origin
					).toString();
					characterProfilePublication = prepareCharacterProfilePublication({
						account: selfAccount,
						character,
						absolutePictureUrl,
						createdAt: accountResult.kind === 'restored' ? Math.floor(Date.now() / 1000) :
							Math.floor(selfAccount.lastChangedAtMs / 1000)
					});
				}
				if (!selfAccount) {
					setComposerTerminalError(new Error('Account is unavailable for publishing.'));
				}
			} catch {
				// Account failure is fail-closed for profile publication, not world reading.
				setComposerTerminalError(new Error('Account is unavailable for publishing.'));
			}
			session = createWorldReadSession({
				field: FIELD,
				selfAccount,
				onPresenceChanged: setPresence,
				onLiveMessage: receiveLiveMessage,
				onTimelineMessage: receiveTimelineMessage,
				onEffectiveTraceRootsChanged: setEffectiveTraceRoots,
				onTraceConversationChanged: setTraceConversation,
				onStatusChanged: (status) => {
					connectionStatus = status;
					if (status.kind === 'failed') setComposerTerminalError(new Error(status.message));
				},
				onSelfPositionWriteStateChanged: (state) => {
					selfPositionWriteState = state;
					if ('operation' in state && state.operation === 'entry') {
						if (state.kind === 'retryable') {
							entryRetryable = true;
							cancelPendingComposerSubmission(new Error('World entry was not confirmed by Relay.'));
						} else if (state.kind === 'pending' || state.kind === 'succeeded') entryRetryable = false;
					}
				},
				onSelfMessageAvailabilityChanged: (state) => {
					selfMessageAvailability = state;
					if (state.kind === 'ready') resolvePendingComposerSubmission();
				}
			});
			worldSession = session;
			traceConversationController = session;

			try {
				const bootstrap = await session.start();
				if (!mounted) return;
				setPresence(bootstrap.presence);
				restoreBootstrapConversation(bootstrap.messages, bootstrap.presence, Date.now());
				recentMessageTimeline = createRecentMessageTimeline([
					...recentMessageTimeline,
					...bootstrap.timelineMessages
				]);
				session.completeBootstrap();
				void session.enterSelf();
				if (characterProfilePublication) {
					void publishCharacterProfile(characterProfilePublication, (event) => session!.publish(event)).catch(() => {});
				}
			} catch {
				// The session reports a concise fatal status to the UI.
				setComposerTerminalError(new Error('Relay startup failed.'));
			}
		};

		const updateViewport = () => {
			if (!viewportElement) return;
			const rect = viewportElement.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;
			if (viewportSize.width !== rect.width || viewportSize.height !== rect.height) {
				// Measured body sizes are tied to their previous containing block.
				// Discard them before special visual bounds are recomputed for a resize.
				bubbleSizes = {};
			}
			viewportSize = { width: rect.width, height: rect.height };
			void tick().then(() => {
				if (!mounted) return;
				remeasureMountedBubbles();
				syncVisualToCanonical();
			});
			if (!devWorldSandboxEnabled) void begin();
		};
		type MovementHoldOwner = 'keyboard' | 'pointer';
		let movementHoldOwner: MovementHoldOwner | null = null;
		let movementHoldDirection: Direction | null = null;
		let movementHoldSource: 'page' | 'composer-editor' | null = null;
		let movementHoldKeyboardKey: string | null = null;
		let movementHoldKeyboardCode: string | null = null;
		let movementHoldPointerId: number | null = null;
		let holdTimer: number | null = null;
		const clearMovementHold = () => {
			movementHoldOwner = null;
			movementHoldDirection = null;
			movementHoldSource = null;
			movementHoldKeyboardKey = null;
			movementHoldKeyboardCode = null;
			movementHoldPointerId = null;
			if (holdTimer !== null) {
				window.clearInterval(holdTimer);
				holdTimer = null;
			}
		};
		stopMovementHold = clearMovementHold;
		const requestMovement = (direction: Direction) => {
			closeFieldActionMenu();
			moveSelfFromCell(direction);
		};
		const startMovementTimer = () => {
			holdTimer = window.setInterval(() => {
				if (!movementHoldOwner || !movementHoldDirection ||
					(movementHoldOwner === 'keyboard' && movementHoldSource === 'composer-editor' && composerEditorIsEmpty !== true) ||
					document.querySelector('.profile-dialog-content')) {
					clearMovementHold();
					return;
				}
				requestMovement(movementHoldDirection);
			}, 500);
		};
		const startKeyboardHold = (direction: Direction, event: KeyboardEvent, source: 'page' | 'composer-editor') => {
			clearMovementHold();
			movementHoldOwner = 'keyboard';
			movementHoldDirection = direction;
			movementHoldSource = source;
			movementHoldKeyboardKey = event.key;
			movementHoldKeyboardCode = event.code;
			requestMovement(direction);
			startMovementTimer();
		};
		const takeOverPointerHold = (pointerId: number, direction: Direction) => {
			clearMovementHold();
			movementHoldOwner = 'pointer';
			movementHoldDirection = direction;
			movementHoldPointerId = pointerId;
			requestMovement(direction);
			startMovementTimer();
		};
		const updatePointerHold = (pointerId: number, direction: Direction) => {
			if (movementHoldOwner === 'pointer' && movementHoldPointerId === pointerId) movementHoldDirection = direction;
		};
		const stopPointerHold = (pointerId: number) => {
			if (movementHoldOwner === 'pointer' && movementHoldPointerId === pointerId) clearMovementHold();
		};
		const handleKeydown = (event: KeyboardEvent) => {
			if (event.code === 'Escape' && fieldActionMenu) {
				closeFieldActionMenu();
				event.preventDefault();
				return;
			}
			if (
				timelineInitialized &&
				event.key.toLowerCase() === 'c' &&
				!event.repeat &&
				!event.isComposing &&
				!event.shiftKey &&
				!event.ctrlKey &&
				!event.altKey &&
				!event.metaKey &&
				!document.querySelector('.profile-dialog-content') &&
				!event.composedPath().some((target) => target instanceof HTMLElement && (
					target.matches('input, textarea, select') || target.isContentEditable
				))
			) {
				timelineOpen = !timelineOpen;
				event.preventDefault();
				return;
			}
			if (event.code === 'Escape' && isComposerEditorKeyboardEvent(event) && !event.isComposing) {
				if (composerComponent?.blurEditor()) event.preventDefault();
				return;
			}
			if (event.code === 'KeyN' && canUseComposerFocusShortcut(event)) {
				if (composerComponent?.focusEditor()) event.preventDefault();
				return;
			}

			const arrowDirection = directionFromKey(event.key);
			const wasdDirection = directionFromCode(event.code);
			const direction = arrowDirection ?? wasdDirection;
			if (!direction) return;
			if (movementHoldOwner === 'pointer') return;
			const canMove = arrowDirection
				? canUseArrowForMovement(event)
				: canUseWASDForMovement(event);
			if (!canMove) {
				clearMovementHold();
				return;
			}
			// Browser repeat events only suppress the browser default. Movement is
			// driven by the explicit hold timer below, never by repeat frequency.
			event.preventDefault();
			if (event.repeat) return;
			const source = arrowDirection && isComposerEditorKeyboardEvent(event) ? 'composer-editor' : 'page';
			startKeyboardHold(direction, event, source);
		};
		const handleKeyup = (event: KeyboardEvent) => {
			const direction = directionFromKey(event.key) ?? directionFromCode(event.code);
			if (movementHoldOwner === 'keyboard' && direction === movementHoldDirection &&
				(event.key === movementHoldKeyboardKey || event.code === movementHoldKeyboardCode)) clearMovementHold();
		};
		const handleMovementFocusIn = (event: FocusEvent) => {
			if (movementHoldOwner === 'keyboard' && movementHoldDirection && !isComposerEditorKeyboardEvent(event)) clearMovementHold();
		};
		const handleWindowBlur = () => {
			clearMovementHold();
			cancelPointerJoystick();
		};
		const handleVisibilityChange = () => {
			if (document.hidden) {
				clearMovementHold();
				cancelPointerJoystick();
			}
		};
		const handleDocumentPointerDown = (event: PointerEvent) => {
			if (fieldActionMenu && !event.composedPath().some((target) =>
				target instanceof HTMLElement && target.classList.contains('field-action-menu')
			)) closeFieldActionMenu();
		};

		const observer = new ResizeObserver(updateViewport);
		const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
		const visualViewport = window.visualViewport;
		let composerFocused = false;
		let changedVirtualKeyboardOverlaysContent = false;
		let previousVirtualKeyboardOverlaysContent: boolean | null = null;
		const updateComposerKeyboardInset = () => {
			if (virtualKeyboard) {
				composerKeyboardInset = getVirtualKeyboardBottomInset(layoutViewportRect(), virtualKeyboard.boundingRect);
				return;
			}
			if (!visualViewport) {
				composerKeyboardInset = 0;
				return;
			}
			composerKeyboardInset = getVisualViewportKeyboardInset({
				layoutViewportHeight: window.innerHeight,
				visualViewportHeight: visualViewport.height,
				visualViewportOffsetTop: visualViewport.offsetTop,
				visualViewportScale: visualViewport.scale,
				composerFocused
			});
		};
		const handleComposerFocusIn = (event: FocusEvent) => {
			if (!isComposerEditorFocusEvent(event)) return;
			composerFocused = true;
			updateComposerKeyboardInset();
		};
		const handleComposerFocusOut = () => {
			queueMicrotask(() => {
				composerFocused = document.activeElement instanceof HTMLElement && document.activeElement.matches('ehagaki-composer');
				updateComposerKeyboardInset();
			});
		};
		if (runtimeMode === 'relay' && virtualKeyboard) {
			const previousOverlaysContent = virtualKeyboard.overlaysContent;
			previousVirtualKeyboardOverlaysContent = previousOverlaysContent;
			if (!previousOverlaysContent) {
				virtualKeyboard.overlaysContent = true;
				changedVirtualKeyboardOverlaysContent = true;
			}
			virtualKeyboard.addEventListener('geometrychange', updateComposerKeyboardInset);
		}
		observer.observe(viewportElement);
		updateViewport();
		updateComposerKeyboardInset();
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('keyup', handleKeyup);
		document.addEventListener('focusin', handleMovementFocusIn);
		document.addEventListener('focusin', handleComposerFocusIn);
		document.addEventListener('focusout', handleComposerFocusOut);
		visualViewport?.addEventListener('resize', updateComposerKeyboardInset);
		visualViewport?.addEventListener('scroll', updateComposerKeyboardInset);
		window.addEventListener('resize', updateComposerKeyboardInset);
		window.addEventListener('blur', handleWindowBlur);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		document.addEventListener('pointerdown', handleDocumentPointerDown);
		movementHoldTakeover = takeOverPointerHold;
		movementHoldUpdatePointer = updatePointerHold;
		movementHoldStopPointer = stopPointerHold;
		const expiryTimer = window.setInterval(() => {
			const now = Date.now();
			const nextPresence = session?.refresh(now);
			if (nextPresence) {
				conversationState = applyVisibility(conversationState, getPresenceProjection(nextPresence).visibleParticipantIds);
			}
			conversationState = pruneExpired(conversationState, now);
		}, 250);

		return () => {
			mounted = false;
			cancelPendingComposerSubmission(new DOMException('Submission was cancelled.', 'AbortError'));
			observer.disconnect();
			virtualKeyboard?.removeEventListener('geometrychange', updateComposerKeyboardInset);
			if (changedVirtualKeyboardOverlaysContent && virtualKeyboard && previousVirtualKeyboardOverlaysContent !== null) {
				virtualKeyboard.overlaysContent = previousVirtualKeyboardOverlaysContent;
			}
			composerKeyboardInset = 0;
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('keyup', handleKeyup);
			document.removeEventListener('focusin', handleMovementFocusIn);
			document.removeEventListener('focusin', handleComposerFocusIn);
			document.removeEventListener('focusout', handleComposerFocusOut);
			visualViewport?.removeEventListener('resize', updateComposerKeyboardInset);
			visualViewport?.removeEventListener('scroll', updateComposerKeyboardInset);
			window.removeEventListener('resize', updateComposerKeyboardInset);
			window.removeEventListener('blur', handleWindowBlur);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			document.removeEventListener('pointerdown', handleDocumentPointerDown);
			clearMovementHold();
			cancelPointerJoystick();
			movementHoldTakeover = (_pointerId, _direction) => {};
			movementHoldUpdatePointer = (_pointerId, _direction) => {};
			movementHoldStopPointer = (_pointerId) => {};
			stopMovementHold = () => {};
			reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
			cancelVisualAnimation();
			window.clearInterval(expiryTimer);
			session?.dispose();
			devTraceConversationRuntime?.dispose();
			devTraceConversationRuntime = null;
			traceConversationController = null;
			if (worldSession === session) worldSession = null;
		};
	});

	type BubbleMeasurement = Readonly<{ size: Size; overflow: boolean }>;

	function measureBubble(node: HTMLElement): BubbleMeasurement {
		const content = node.querySelector<HTMLElement>('.bubble-content');
		const rect = node.getBoundingClientRect();
		return {
			size: { width: rect.width, height: rect.height },
			overflow: content ? content.scrollHeight > content.clientHeight : false
		};
	}

	function applyBubbleMeasurement(id: string, measurement: BubbleMeasurement): void {
		const currentSize = bubbleSizes[id];
		if (!currentSize || currentSize.width !== measurement.size.width || currentSize.height !== measurement.size.height) {
			bubbleSizes = {
				...bubbleSizes,
				[id]: measurement.size
			};
		}
		if (bubbleOverflowById[id] !== measurement.overflow) {
			bubbleOverflowById = {
				...bubbleOverflowById,
				[id]: measurement.overflow
			};
		}
	}

	function remeasureMountedBubbles(): void {
		const nextSizes = { ...bubbleSizes };
		const nextOverflow = { ...bubbleOverflowById };
		let sizesChanged = false;
		let overflowChanged = false;
		for (const [id, node] of mountedBubbleNodes) {
			const measurement = measureBubble(node);
			const currentSize = nextSizes[id];
			if (!currentSize || currentSize.width !== measurement.size.width || currentSize.height !== measurement.size.height) {
				nextSizes[id] = measurement.size;
				sizesChanged = true;
			}
			if (nextOverflow[id] !== measurement.overflow) {
				nextOverflow[id] = measurement.overflow;
				overflowChanged = true;
			}
		}
		if (sizesChanged) bubbleSizes = nextSizes;
		if (overflowChanged) bubbleOverflowById = nextOverflow;
	}

	function observeBubble(node: HTMLElement, id: string) {
		mountedBubbleNodes.set(id, node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		const update = () => {
			applyBubbleMeasurement(id, measureBubble(node));
		};

		const observer = new ResizeObserver(update);
		observer.observe(node);
		if (content) observer.observe(content);
		update();

		return {
			destroy() {
				observer.disconnect();
				if (mountedBubbleNodes.get(id) === node) mountedBubbleNodes.delete(id);
				const next = { ...bubbleOverflowById };
				delete next[id];
				bubbleOverflowById = next;
			}
		};
	}

	function observeTimelineContent(node: HTMLElement, id: string) {
		const update = () => {
			timelineOverflowById = {
				...timelineOverflowById,
				[id]: node.scrollHeight > node.clientHeight + 1
			};
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return {
			destroy() {
				observer.disconnect();
				const next = { ...timelineOverflowById };
				delete next[id];
				timelineOverflowById = next;
			}
		};
	}

	function observeTimelineEntry(node: HTMLElement, id: string) {
		const update = () => {
			const height = node.getBoundingClientRect().height;
			if (height <= 0) return;
			timelineEntryHeights = {
				...timelineEntryHeights,
				[id]: height
			};
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return {
			destroy() {
			observer.disconnect();
			const next = { ...timelineEntryHeights };
			delete next[id];
			timelineEntryHeights = next;
		}
		};
	}

	function observeTimelineVisibleArea(node: HTMLElement) {
		const update = () => {
			timelineAvailableHeight = Math.max(0, node.clientHeight - 14);
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return {
			destroy() {
				observer.disconnect();
				timelineAvailableHeight = 0;
			}
		};
	}

	function isInsideFieldArea(point: WorldPoint) {
		return (
			point.x >= fieldAreaBounds.x &&
			point.x <= fieldAreaBounds.x + fieldAreaBounds.width &&
			point.y >= actualFieldTop &&
			point.y <= fieldAreaBounds.y + fieldAreaBounds.height
		);
	}

	function syncVisibility(key: string, visiblePubkeys: ReadonlySet<string>) {
		if (key === '' && lastVisibilityKey === null) return;
		if (key === lastVisibilityKey) return;
		lastVisibilityKey = key;
		conversationState = applyVisibility(conversationState, visiblePubkeys);
	}

	function participantTone(participant: Pick<Participant, 'color'>): string {
		return participant.color;
	}

	function sameCell(first: { x: number; y: number }, second: { x: number; y: number }): boolean {
		return first.x === second.x && first.y === second.y;
	}

	function traceTone(pubkey: string): AvatarColor {
		const prefix = Number.parseInt(pubkey.slice(0, 2), 16);
		return AVATAR_COLORS[(Number.isFinite(prefix) ? prefix : 0) % AVATAR_COLORS.length];
	}

	function mergedBubbleTone(members: readonly Participant[]): string {
		return participantTone(members[0] ?? { color: 'lavender' });
	}

	function participantModels(state: PresenceState, selectedId = selectedCharacterId): readonly Participant[] {
		return state.participants
			.filter((participant) => participant.status === 'active')
			.map((participant) => {
				if (participant.id === DEV_WORLD_SELF_ID) {
					return {
						id: participant.id,
						character: getDevWorldCharacter(selectedId),
						color: colorByPubkey[participant.id] ?? AVATAR_COLORS[0]
					};
				}
				const character = deriveCharacterFromPubkey(participant.id, CHARACTER_CATALOG);
				return {
					id: participant.id,
					character,
					color: colorByPubkey[participant.id] ?? AVATAR_COLORS[0]
				};
			});
	}

	function getPresenceProjection(
		state: PresenceState,
		selectedId = selectedCharacterId,
		selfId = selfProjectionId
	) {
		return projectPresence(state, participantModels(state, selectedId), {
			cellSize,
			fieldAreaBounds,
			fieldWorldSize
		}, selfId);
	}

	function hasUsableViewport(): boolean {
		return viewportSize.width > 0 && viewportSize.height > 0;
	}

	function setPresence(nextPresence: PresenceState): void {
		const previousProjection = getPresenceProjection(presenceState);
		const activeIds = nextPresence.participants
			.filter((participant) => participant.status === 'active')
			.map((participant) => participant.id)
			.sort();
		const nextColors: Record<string, AvatarColor> = {};
		const used = new Set<AvatarColor>();
		for (const id of activeIds) {
			const retained = colorByPubkey[id];
			if (retained) {
				nextColors[id] = retained;
				used.add(retained);
			}
		}
		for (const id of activeIds) {
			if (nextColors[id]) continue;
			const color = AVATAR_COLORS.find((candidate) => !used.has(candidate)) ?? AVATAR_COLORS[activeIds.indexOf(id) % AVATAR_COLORS.length];
			nextColors[id] = color;
			used.add(color);
		}
		colorByPubkey = nextColors;
		presenceState = nextPresence;
		const nextProjection = getPresenceProjection(nextPresence);
		animatePresenceTransition(previousProjection, nextProjection);
	}

	function directionFromKey(key: string): Direction | null {
		if (key === 'ArrowUp') return 'up';
		if (key === 'ArrowDown') return 'down';
		if (key === 'ArrowLeft') return 'left';
		if (key === 'ArrowRight') return 'right';
		return null;
	}

	function directionFromCode(code: string): Direction | null {
		if (code === 'KeyW') return 'up';
		if (code === 'KeyA') return 'left';
		if (code === 'KeyS') return 'down';
		if (code === 'KeyD') return 'right';
		return null;
	}

	function setEffectiveTraceRoots(roots: readonly ParsedWorldMessage[]): void {
		effectiveTraceRoots = roots;
		devTraceConversationRuntime?.reconcileEffectiveRoots(roots);
	}

	function setTraceConversation(next: TraceConversationState): void {
		const presentation = reconcileTraceReplyPresentation(traceReplyRepresentativeState, next);
		traceReplyRepresentativeState = presentation.state;
		traceReplyCells = presentation.cells;
		traceConversationState = next;
	}

	function setDevTraceReplies(replies: readonly ParsedTraceReply[]): void {
		devTraceReplies = replies;
		devTraceConversationRuntime?.reconcileReplies(replies);
	}

	function closeFieldActionMenu(): void {
		fieldActionMenu = null;
	}

	function closeTraceConversation(): void {
		closeFieldActionMenu();
		traceConversationController?.closeTraceConversation();
		if (!traceConversationController) setTraceConversation({ kind: 'closed' });
	}

	function replyNavigationItemsForCell(position: { x: number; y: number }) {
		if (!traceConversationProjection) return [];
		const replies = [
			...(traceConversationProjection.parent?.kind === 'reply'
				? [traceConversationProjection.parent.event]
				: []),
			...traceConversationProjection.directReplies
		].filter((reply) =>
			reply.id !== traceConversationProjection?.current.event.id && sameCell(reply.position, position)
		);
		return numberTraceReplyAuthors(replies);
	}

	function actionsForCell(position: { x: number; y: number }): readonly FieldCellAction[] {
		const participantIds = participantViews
			.filter((participant) => sameCell(participant.position, position))
			.map((participant) => participant.id);
		let trace: Extract<FieldCellAction, { kind: 'trace' }> | null = null;
		if (
			traceConversationProjection?.parent?.kind === 'root' &&
			sameCell(traceConversationProjection.parent.event.position, position)
		) {
			trace = {
				kind: 'trace',
				rootId: traceConversationProjection.parent.event.id,
				behavior: 'select-current'
			};
		} else {
			const rootCell = traceRootCells.find((cell) => sameCell(cell.position, position));
			const currentIsRootCell = traceConversationProjection?.current.kind === 'root' &&
				sameCell(traceConversationProjection.current.event.position, position);
			const root = currentIsRootCell
				? undefined
				: rootCell?.roots.find((candidate) => candidate.id !== traceConversationProjection?.root.id);
			if (root) trace = { kind: 'trace', rootId: root.id, behavior: 'open-root' };
		}
		return buildFieldCellActions({
			participantIds,
			trace,
			replyIds: replyNavigationItemsForCell(position).map((item) => item.reply.id)
		});
	}

	function investigateTraceRoot(rootId: string): void {
		traceConversationController?.openTraceConversation({ rootId, currentId: rootId });
	}

	function executeFieldCellAction(
		action: FieldCellAction,
		position: { x: number; y: number },
		trigger?: HTMLButtonElement
	): void {
		closeFieldActionMenu();
		if (action.kind === 'trace') {
			if (action.behavior === 'select-current') {
				traceConversationController?.selectTraceConversationSpeech(action.rootId);
			} else {
				investigateTraceRoot(action.rootId);
			}
			return;
		}
		if (action.kind === 'reply') {
			traceConversationController?.selectTraceConversationSpeech(action.replyId);
			return;
		}
		const participant = participantViews.find((candidate) => candidate.id === action.participantId);
		if (participant && trigger) openProfile(participant.character.characterId, trigger);
	}

	function resolveFieldCellSelection(position: { x: number; y: number }, trigger?: HTMLButtonElement): void {
		const resolution = resolveFieldCellActions(actionsForCell(position));
		if (resolution.kind === 'none') {
			closeTraceConversation();
			return;
		}
		if (resolution.kind === 'direct') {
			executeFieldCellAction(resolution.action, position, trigger);
			return;
		}
		fieldActionMenu = { position: { ...position }, actions: resolution.actions };
	}

	function fieldSelectionPointer(node: HTMLElement) {
		let activeGesture: Readonly<{
			pointerId: number;
			start: JoystickPoint;
			anchor: { x: number; y: number };
			dragging: boolean;
		}> | null = null;

		const isInteractiveTarget = (event: PointerEvent): boolean => event.composedPath().some((target) =>
			target instanceof HTMLElement && target.matches(
				'button, input, textarea, select, [contenteditable="true"], .field-action-menu'
			)
		);
		const releasePointerCapture = (pointerId: number) => {
			if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
		};
		const cancelGesture = () => {
			const gesture = activeGesture;
			activeGesture = null;
			if (gesture) {
				movementHoldStopPointer(gesture.pointerId);
				try { releasePointerCapture(gesture.pointerId); } catch { /* pointer capture may already be lost */ }
			}
			pointerJoystick = null;
		};
		const finishGesture = (event: PointerEvent, selectTap: boolean) => {
			const gesture = activeGesture;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			activeGesture = null;
			try { releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be lost */ }
			if (gesture.dragging) movementHoldStopPointer(event.pointerId);
			pointerJoystick = null;
			if (selectTap && !gesture.dragging) resolveFieldCellSelection(gesture.anchor);
		};
		const handlePointerDown = (event: PointerEvent) => {
			if (!event.isPrimary || event.button !== 0 || activeGesture || isInteractiveTarget(event)) return;
			const start = { x: event.clientX, y: event.clientY };
			const anchor = viewportPointToLogicalCell({ point: start, fieldArea: fieldAreaBounds, camera, field });
			if (!anchor) return;
			activeGesture = { pointerId: event.pointerId, start, anchor, dragging: false };
			try { node.setPointerCapture(event.pointerId); } catch { /* synthetic events may not have a capturable pointer */ }
		};
		const handlePointerMove = (event: PointerEvent) => {
			const gesture = activeGesture;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			const current = { x: event.clientX, y: event.clientY };
			if (!gesture.dragging) {
				if (!isJoystickDrag(gesture.start, current)) return;
				const direction = joystickDirection(gesture.start, current);
				if (!direction) return;
				activeGesture = { ...gesture, dragging: true };
				pointerJoystick = {
					center: gesture.start,
					thumb: clampJoystickThumb(gesture.start, current),
					direction
				};
				closeFieldActionMenu();
				movementHoldTakeover(event.pointerId, direction);
				return;
			}
			const direction = joystickDirection(gesture.start, current);
			if (!direction) return;
			pointerJoystick = {
				center: gesture.start,
				thumb: clampJoystickThumb(gesture.start, current),
				direction
			};
			movementHoldUpdatePointer(event.pointerId, direction);
		};
		node.addEventListener('pointerdown', handlePointerDown);
		node.addEventListener('pointermove', handlePointerMove);
		node.addEventListener('pointerup', (event) => finishGesture(event, true));
		node.addEventListener('pointercancel', (event) => finishGesture(event, false));
		node.addEventListener('lostpointercapture', (event) => finishGesture(event as PointerEvent, false));
		cancelPointerJoystick = cancelGesture;
		return {
			destroy() {
				cancelGesture();
				cancelPointerJoystick = () => {};
			}
		};
	}

	function selectAdjacentTraceRoot(delta: -1 | 1): void {
		if (!selectedTraceDetails) return;
		const current = {
			position: selectedTraceDetails.cell.position,
			rootId: selectedTraceDetails.root.id
		};
		const next = stepTraceRootSelection(current, traceRootCells, delta);
		if (next.rootId === current.rootId) return;
		traceConversationController?.openTraceConversation({ rootId: next.rootId, currentId: next.rootId });
	}

	function fieldActionLabel(action: FieldCellAction): string {
		if (action.kind === 'trace') return '痕跡を調べる';
		if (action.kind === 'reply') {
			const item = fieldActionMenu
				? replyNavigationItemsForCell(fieldActionMenu.position).find((candidate) => candidate.reply.id === action.replyId)
				: undefined;
			if (!item) return '返信を調べる';
			const character = deriveTraceReplyCharacter(item.reply, CHARACTER_CATALOG);
			return `${character.name}${item.authorOrdinal === null ? '' : ` #${item.authorOrdinal}`}`;
		}
		const participant = participantViews.find((candidate) => candidate.id === action.participantId);
		return participant ? `${participant.character.name} のプロフィールを開く` : 'プロフィールを開く';
	}

	function isComposerEditorKeyboardEvent(event: Event): boolean {
		const path = event.composedPath();
		return path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer')) &&
			path.some((target) => target instanceof HTMLElement && target.isContentEditable);
	}

	type VirtualKeyboardLike = {
		boundingRect: DOMRectReadOnly;
		overlaysContent: boolean;
		addEventListener: (type: 'geometrychange', listener: EventListener) => void;
		removeEventListener: (type: 'geometrychange', listener: EventListener) => void;
	};

	function isComposerEditorFocusEvent(event: Event): boolean {
		const path = event.composedPath();
		return path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer')) &&
			path.some((target) => target instanceof HTMLElement && (
				target.isContentEditable || target.matches('input, textarea')
			));
	}

	function layoutViewportRect(): ViewportRect {
		return {
			left: 0,
			top: 0,
			right: window.innerWidth,
			bottom: window.innerHeight,
			width: window.innerWidth,
			height: window.innerHeight
		};
	}

	function canUseArrowForMovement(event: KeyboardEvent): boolean {
		if (
			event.isComposing ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			document.querySelector('.profile-dialog-content')
		) return false;

		const path = event.composedPath();
		const isComposerEvent = path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer'));
		if (isComposerEvent) return isComposerEditorKeyboardEvent(event) && composerEditorIsEmpty === true;
		return !path.some((target) => target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		));
	}

	function canUseWASDForMovement(event: KeyboardEvent): boolean {
		if (
			event.isComposing ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			document.querySelector('.profile-dialog-content')
		) return false;

		return !event.composedPath().some((target) => target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		));
	}

	function canUseComposerFocusShortcut(event: KeyboardEvent): boolean {
		if (
			event.isComposing ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			isComposerEditorKeyboardEvent(event) ||
			document.querySelector('.profile-dialog-content')
		) return false;

		return !event.composedPath().some((target) => target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		));
	}

	function handleComposerEditorEmptyChange(isEmpty: boolean | null): void {
		composerEditorIsEmpty = isEmpty;
		if (isEmpty !== true) stopMovementHold();
	}

	function moveSandboxSelf(direction: Direction): void {
		if (!devWorldSandboxEnabled) return;
		const result = moveDevWorldSelf(presenceState, direction, Date.now());
		if (result.moved) setPresence(result.state);
	}

	function moveWorldSelf(direction: Direction): void {
		if (devWorldSandboxEnabled) return;
		void worldSession?.moveSelf(direction);
	}

	function moveSelfFromCell(direction: Direction): void {
		closeFieldActionMenu();
		if (devWorldSandboxEnabled) moveSandboxSelf(direction);
		else moveWorldSelf(direction);
	}

	function resolvePendingComposerSubmission(): void {
		const pending = pendingComposerSubmission;
		if (!pending) return;
		pendingComposerSubmission = null;
		pending.cleanup();
		pending.resolve();
	}

	function setComposerTerminalError(error: Error): void {
		composerStartupError = error;
		cancelPendingComposerSubmission(error);
	}

	function cancelPendingComposerSubmission(error: Error): void {
		const pending = pendingComposerSubmission;
		if (!pending) return;
		pendingComposerSubmission = null;
		pending.cleanup();
		pending.reject(error);
	}

	function waitForMessageReady(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(new DOMException('Submission was cancelled.', 'AbortError'));
		if (composerStartupError) return Promise.reject(composerStartupError);
		if (entryRetryable) return Promise.reject(new Error('World entry was not confirmed by Relay.'));
		if (selfMessageAvailability.kind === 'ready' && worldSession) return Promise.resolve();
		if (pendingComposerSubmission) return Promise.reject(new Error('A message is already waiting for Relay readiness.'));
		return new Promise((resolve, reject) => {
			const abort = () => cancelPendingComposerSubmission(new DOMException('Submission was cancelled.', 'AbortError'));
			const cleanup = () => signal.removeEventListener('abort', abort);
			pendingComposerSubmission = { resolve, reject, cleanup };
			signal.addEventListener('abort', abort, { once: true });
			if (signal.aborted) abort();
		});
	}

	async function submitComposerContent(
		content: string,
		options: Readonly<{ signal: AbortSignal; shortcutId?: string }>
	): Promise<Readonly<{ eventId: string }>> {
		const submission = resolveSpeechSubmission({
			content,
			shortcutId: options.shortcutId,
			selectedSpeechType
		});
		composerSubmissionInProgress = true;
		try {
			await waitForMessageReady(options.signal);
			if (options.signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
			const result = await worldSession?.publishMessage(submission.content, submission.speechType);
			if (result?.kind === 'succeeded') {
				selectedSpeechType = 'normal';
				return { eventId: result.eventId };
			}
			throw new Error('Message was not confirmed by Relay.');
		} finally {
			composerSubmissionInProgress = false;
		}
	}

	function nextSpeechType(speechType: SpeechType): SpeechType {
		const index = SPEECH_TYPE_ORDER.indexOf(speechType);
		return SPEECH_TYPE_ORDER[(index + 1) % SPEECH_TYPE_ORDER.length];
	}

	function cycleSpeechType(): void {
		if (composerSubmissionInProgress) return;
		selectedSpeechType = nextSpeechType(selectedSpeechType);
	}

	function setComposerPreferredHeight(height: number): void {
		composerPreferredHeight = height;
	}

	function retryWorldEntry(): void {
		if (devWorldSandboxEnabled || selfPositionWriteState.kind !== 'retryable') return;
		void worldSession?.enterSelf();
	}

	function selectSandboxCharacter(characterId: string): void {
		if (!devWorldSandboxEnabled) return;
		selectedCharacterId = resolveDevWorldCharacterId(new URLSearchParams(`?devCharacter=${encodeURIComponent(characterId)}`));
	}

	function resetSandbox(): void {
		if (!devWorldSandboxEnabled) return;
		conversationState = createConversationState();
		recentMessageTimeline = [];
		setDevTraceReplies([]);
		setEffectiveTraceRoots([]);
		closeTraceConversation();
		timelineOverflowById = {};
		timelineEntryHeights = {};
		timelineAvailableHeight = 0;
		lastPlacedAnchorById = {};
		lastVisibilityKey = null;
		colorByPubkey = {};
		setPresence(resetDevWorldPresence(FIELD, Date.now()));
	}

	function seedDevRecentMessageTimelineFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const now = Math.floor(Date.now() / 1000);
		const activePubkey = 'a'.repeat(64);
		const outsidePubkey = 'f'.repeat(64);
		setPresence(createPresenceState(FIELD, Date.now(), [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: activePubkey, position: { x: 11, y: 3 } }
		]));
		const messages: ParsedWorldMessage[] = Array.from({ length: 24 }, (_, index) => ({
			id: index === 23 ? 'dev-timeline-duplicate' : `dev-timeline-${String(index).padStart(2, '0')}`,
			pubkey: index === 21 ? outsidePubkey : activePubkey,
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
		recentMessageTimeline = createRecentMessageTimeline(messages);
	}

	function traceLightWorldPosition(position: { x: number; y: number }, occupied: boolean): WorldPoint {
		const edgeOffset = occupied ? cellSize * 0.28 : 0;
		return {
			x: (position.x + 0.5) * cellSize + edgeOffset,
			y: (position.y + 0.5) * cellSize - edgeOffset
		};
	}

	function seedDevTraceLightFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const nowMs = Date.now();
		const now = Math.floor(nowMs / 1000);
		const livePubkey = 'f'.repeat(64);
		setPresence(createPresenceState(FIELD, nowMs, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: livePubkey, position: { x: 9, y: 4 } }
		]));
		conversationState = receiveMessage(conversationState, {
			id: 'dev-trace-live-message',
			pubkey: livePubkey,
			content: 'live bubble fixed while a trace bubble is added nearby',
			createdAt: nowMs
		}, { isSpeakerVisible: true, duration: 60_000, now: nowMs });
		setEffectiveTraceRoots([
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
			},
			{
				id: '5'.repeat(64), pubkey: 'e'.repeat(64), createdAt: now - 2,
				content: 'older root on the same movement cell', speechType: 'monologue', position: { x: 8, y: 3 }
			}
		]);
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
			position: options.position,
			rootId,
			rootPubkey,
			parentId: options.parentId ?? rootId,
			parentKind: options.parentKind ?? 42,
			parentPubkey: options.parentPubkey ?? rootPubkey
		};
	}

	function seedDevTraceReplyFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const now = Math.floor(Date.now() / 1000);
		const sameCellAuthor = '6'.repeat(64);
		const sameCellNewest = devTraceReply({
			id: '7'.repeat(64), pubkey: sameCellAuthor, createdAt: now - 1,
			content: 'newest same-cell direct reply', speechType: 'normal', position: { x: 6, y: 4 }
		});
		setDevTraceReplies([
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

	function injectDevTraceLiveReply(): void {
		if (!devTraceReplyFixtureEnabled || devTraceReplies.some((reply) => reply.id === 'c'.repeat(64))) return;
		setDevTraceReplies([...devTraceReplies, devTraceReply({
			id: 'c'.repeat(64), pubkey: 'c'.repeat(64), createdAt: Math.floor(Date.now() / 1000) + 1,
			content: 'live newest same-cell direct reply', speechType: 'normal', position: { x: 6, y: 4 }
		})]);
	}

	function seedDevSpeechNormalFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const now = Date.now();
		const participantIds = ['0', 'a', 'b', 'c', 'd', 'e', 'f'].map((prefix) => prefix.repeat(64));
		setPresence(createPresenceState(FIELD, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			...participantIds.map((id, index) => ({ id, position: { x: index * 2 + 1, y: 2 } }))
		]));
		const duration = 60_000;
		const allParticipantIds = [DEV_WORLD_SELF_ID, ...participantIds];
		const mergedContent = 'merged showcase fixture';
		for (const [index, pubkey] of allParticipantIds.slice(0, 2).entries()) {
			conversationState = receiveMessage(conversationState, {
				id: `dev-speech-showcase-merged-message-${index}`,
				pubkey,
				content: mergedContent,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now });
		}
		for (const [index, pubkey] of allParticipantIds.entries()) {
			conversationState = receiveMessage(conversationState, {
				id: `dev-speech-showcase-normal-message-${index}`,
				pubkey,
				content: `normal fixture ${index + 1}`,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now });
		}
	}

	function seedDevSpeechMergedFixture(
		mergedMemberCount: number,
		mergedContent = 'merged fixture',
		mergedSpeechType: SpeechType = 'normal'
	): void {
		if (!devWorldSandboxEnabled) return;
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
		setPresence(createPresenceState(FIELD, now, [
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
		conversationState = receiveMessage(conversationState, normalMessage, { isSpeakerVisible: true, duration, now });
		conversationState = receiveMessage(conversationState, mergedMessage, { isSpeakerVisible: true, duration, now });
		for (const [index, pubkey] of mergedPubkeys.slice(1).entries()) {
			conversationState = receiveMessage(conversationState, {
				...mergedMessage,
				id: `dev-speech-merged-message-${String.fromCharCode(98 + index)}`,
				pubkey
			}, { isSpeakerVisible: true, duration, now });
		}
	}

	function seedDevSpeechTypeFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const now = Date.now();
		const normalPubkey = 'a'.repeat(64);
		const singleShoutPubkey = 'f'.repeat(64);
		const singleMonologuePubkey = '9'.repeat(64);
		const shoutPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		const monologuePubkeys = ['d', 'e'].map((prefix) => prefix.repeat(64));
		setPresence(createPresenceState(FIELD, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 4, y: 2 } },
			{ id: singleShoutPubkey, position: { x: 11, y: 2 } },
			{ id: singleMonologuePubkey, position: { x: 11, y: 1 } },
			...shoutPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } })),
			...monologuePubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 1 } }))
		]));
		const duration = 60_000;
		const addMessage = (id: string, pubkey: string, content: string, speechType: SpeechType) => {
			conversationState = receiveMessage(conversationState, {
				id, pubkey, content, speechType, createdAt: now
			}, { isSpeakerVisible: true, duration, now });
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
		if (!devWorldSandboxEnabled) return;
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
		setPresence(createPresenceState(FIELD, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			...messages.map(({ pubkey, position }) => ({ id: pubkey, position }))
		]));
		const duration = 60_000;
		for (const [index, { pubkey, content }] of messages.entries()) {
			conversationState = receiveMessage(conversationState, {
				id: `dev-speech-normal-size-${index}`,
				pubkey,
				content,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now });
		}
	}

	function seedDevSpeechComparisonFixture(): void {
		if (!devWorldSandboxEnabled) return;
		const now = Date.now();
		const content = 'The same representative message is rendered at two bubble scales to compare wrapping behavior.';
		const normalPubkey = 'a'.repeat(64);
		const mergedPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		setPresence(createPresenceState(FIELD, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 5, y: 2 } },
			...mergedPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } }))
		]));
		const duration = 60_000;
		conversationState = receiveMessage(conversationState, {
			id: 'dev-speech-comparison-normal',
			pubkey: normalPubkey,
			content,
			speechType: 'shout',
			createdAt: now
		}, { isSpeakerVisible: true, duration, now });
		for (const [index, pubkey] of mergedPubkeys.entries()) {
			conversationState = receiveMessage(conversationState, {
				id: `dev-speech-comparison-merged-${index}`,
				pubkey,
				content,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now });
		}
	}

	function seedDevSpeechFixture(normalContent: string, mergedContent: string): void {
		if (!devWorldSandboxEnabled) return;
		const now = Date.now();
		const normalPubkey = 'a'.repeat(64);
		const mergedPubkeys = ['b', 'c'].map((prefix) => prefix.repeat(64));
		setPresence(createPresenceState(FIELD, now, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: normalPubkey, position: { x: 5, y: 2 } },
			...mergedPubkeys.map((id, index) => ({ id, position: { x: index === 0 ? 6 : 8, y: 2 } }))
		]));
		const duration = 60_000;
		conversationState = receiveMessage(conversationState, {
			id: 'dev-speech-line-clamp-normal',
			pubkey: normalPubkey,
			content: normalContent,
			createdAt: now
		}, { isSpeakerVisible: true, duration, now });
		for (const [index, pubkey] of mergedPubkeys.entries()) {
			conversationState = receiveMessage(conversationState, {
				id: `dev-speech-line-clamp-merged-${index}`,
				pubkey,
				content: mergedContent,
				createdAt: now
			}, { isSpeakerVisible: true, duration, now });
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

	function openProfile(characterId: string, trigger: HTMLButtonElement): void {
		lastProfileTrigger = trigger;
		pushState('', { ...page.state, profileCharacterId: characterId });
	}

	function timelineCharacter(pubkey: string): Character {
		return pubkey === DEV_WORLD_SELF_ID
			? getDevWorldCharacter(selectedCharacterId)
			: deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG);
	}

	function timelineTone(pubkey: string): AvatarColor | null {
		return colorByPubkey[pubkey] ?? null;
	}

	$: timelineVisibleMessageCount = (() => {
		let usedHeight = 0;
		let count = 0;
		for (const message of recentMessageTimeline) {
			const height = timelineEntryHeights[message.id];
			if (height === undefined || usedHeight + height > timelineAvailableHeight + 1) break;
			usedHeight += height;
			count += 1;
		}
		return count;
	})();
	$: timelineVisibleMessages = recentMessageTimeline.slice(0, timelineVisibleMessageCount);

	function receiveTimelineMessage(message: ParsedWorldMessage): void {
		recentMessageTimeline = addRecentMessage(recentMessageTimeline, message);
	}

	function showRecentMessageTimeline(): void {
		timelineOpen = true;
	}

	function hideRecentMessageTimeline(): void {
		timelineOpen = false;
	}

	function handleProfileOpenChange(open: boolean): void {
		if (open) stopMovementHold();
		if (!open) history.back();
	}

	function restoreProfileTriggerFocus(event: Event): void {
		if (!lastProfileTrigger?.isConnected) return;
		event.preventDefault();
		lastProfileTrigger.focus();
	}

	function toConversationMessage(message: ParsedWorldMessage) {
		return {
			id: message.id,
			pubkey: message.pubkey,
			content: message.content,
			speechType: message.speechType,
			createdAt: message.createdAt * 1000
		};
	}

	function naturalExpiresAt(message: ParsedWorldMessage): number {
		return message.createdAt * 1000 + getPrototypeDisplayDuration(message.content);
	}

	function restoreBootstrapConversation(
		messages: readonly ParsedWorldMessage[],
		bootstrapPresence: PresenceState,
		entryNowMs: number
	): void {
		const entryVisible = getPresenceProjection(bootstrapPresence).visibleParticipantIds;
		conversationState = replayBootstrapConversation(messages, entryVisible, entryNowMs);
		conversationState = applyVisibility(conversationState, entryVisible);
	}

	function receiveLiveMessage(message: ParsedWorldMessage, nextPresence: PresenceState): void {
		setPresence(nextPresence);
		const nowMs = Date.now();
		if (naturalExpiresAt(message) <= nowMs) return;
		const conversationMessage = toConversationMessage(message);
		const visibleParticipantIds = getPresenceProjection(nextPresence).visibleParticipantIds;
		conversationState = receiveMessage(conversationState, conversationMessage, {
			isSpeakerVisible: visibleParticipantIds.has(message.pubkey),
			duration: getPrototypeDisplayDuration(message.content),
			now: conversationMessage.createdAt
		});
		conversationState = applyVisibility(conversationState, visibleParticipantIds);
	}

	function rememberPlacedMergedAnchors(
		bubbles: readonly { id: string; members: readonly Participant[] }[],
		placed: ReadonlyMap<string, WorldPoint>,
		activeMergedBubbles: readonly { id: string }[]
	) {
		const activeIds = new Set(activeMergedBubbles.map((bubble) => bubble.id));
		const next = { ...lastPlacedAnchorById };
		let changed = false;

		for (const id of Object.keys(next)) {
			if (!activeIds.has(id)) {
				delete next[id];
				changed = true;
			}
		}

		for (const bubble of bubbles) {
			if (bubble.members.length === 0) continue;
			const anchor = placed.get(bubble.id);
			if (!anchor) continue;
			const previous = next[bubble.id];
			if (!previous || previous.x !== anchor.x || previous.y !== anchor.y) {
				next[bubble.id] = anchor;
				changed = true;
			}
		}

		if (changed) lastPlacedAnchorById = next;
	}

	function specialBubbleShape(speechType: SpeechType, bubbleId: string, size: Size): SpeechBubbleShape | null {
		const constraints = speechType === 'shout' ? undefined : {
			maxBleedX: Math.max(0, (viewportSize.width - size.width) / 2),
			maxBleedY: Math.max(0, (bubbleSafeBounds.height - size.height) / 2)
		};
		return createSpeechBubbleShape(speechType, size.width, size.height, `${bubbleId}${speechType}`, constraints);
	}

	function bubbleSurfaceStyle(shape: SpeechBubbleShape): string {
		return `inset: auto; left: ${shape.bounds.x - 1}px; top: ${shape.bounds.y - 1}px; width: ${shape.bounds.width}px; height: ${shape.bounds.height}px;`;
	}

	function tailStart(anchor: WorldPoint, size: Size): WorldPoint {
		return { x: anchor.x + size.width / 2, y: anchor.y + size.height };
	}

	function bubbleCenter(anchor: WorldPoint, size: Size): WorldPoint {
		return { x: anchor.x + size.width / 2, y: anchor.y + size.height / 2 };
	}

	function traceRelationPath(start: WorldPoint, end: WorldPoint): string {
		return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
	}

	function mergedTailStart(anchor: WorldPoint, size: Size, index: number, count: number): WorldPoint {
		return {
			x: anchor.x + size.width * mergedTailFraction(index, count),
			y: anchor.y + size.height
		};
	}

	function mergedTailFraction(index: number, count: number): number {
		if (count <= 1) return 0.5;
		const edgeInset = count === 2 ? 0.28 : count === 3 ? 0.22 : 0.18;
		return edgeInset + (1 - edgeInset * 2) * (index / (count - 1));
	}

	function mergedTailConnectionStyle(index: number, count: number): string {
		return `left: ${mergedTailFraction(index, count) * 100}%;`;
	}

	function mergedBubbleStyle(memberCount: number): string {
		const level = Math.min(Math.max(memberCount, 2), 4) - 2;
		const minWidth = 100 + level * 20;
		const maxWidth = 330 + level * 15;
		const paddingY = 14 + level;
		const paddingX = 20 + level * 2;
		const fontSize = 22 + level;
		return [
			`--merged-bubble-min-width: ${minWidth}px`,
			`--merged-bubble-max-width: ${maxWidth}px`,
			`--merged-bubble-padding-y: ${paddingY}px`,
			`--merged-bubble-padding-x: ${paddingX}px`,
			`--merged-bubble-font-size: ${fontSize}px`
		].join('; ');
	}

	function tailTarget(participant: (typeof participantViews)[number]): WorldPoint {
		return {
			x: participant.screen.x,
			y: fieldAreaBounds.y + participant.world.y - cellSize / 2 - camera.y - 4
		};
	}

	function buildTraceSpeechView(
		speech: TraceSpeech,
		role: 'current' | 'parent' | 'child',
		baseScreen: WorldPoint,
		hasTraceCollision: boolean,
		hasRootGhost: boolean
	) {
		const event = speech.event;
		const selfParticipant = speech.kind === 'reply'
			? participantViews.find((participant) =>
				participant.id === selfProjectionId &&
				participant.id === event.pubkey &&
				participant.status === 'active' &&
				sameCell(participant.position, event.position)
			)
			: undefined;
		const hasParticipant = hasTraceCollision || participantViews.some((participant) =>
			sameCell(participant.position, event.position)
		);
		const placement = resolveTraceGhostPlacement({
			kind: role === 'parent' ? 'root' : speech.kind,
			cellSize,
			hasParticipant,
			hasRootGhost
		});
		const center = gridToWorld(event.position, cellSize);
		const world = { x: center.x + placement.offset.x, y: center.y + placement.offset.y };
		const ghostScreen = {
			x: baseScreen.x + placement.offset.x,
			y: baseScreen.y + placement.offset.y
		};
		return {
			speech,
			role,
			event,
			character: deriveCharacterFromPubkey(event.pubkey, CHARACTER_CATALOG),
			tone: traceTone(event.pubkey),
			compact: placement.scale < 1,
			world,
			screen: selfParticipant ? baseScreen : ghostScreen,
			tailTarget: selfParticipant
				? tailTarget(selfParticipant)
				: { x: ghostScreen.x, y: ghostScreen.y - cellSize * (placement.scale < 1 ? 0.29 : 0.5) - 4 },
			ghost: selfParticipant ? null : { world, screen: ghostScreen }
		};
	}

	function tailGeometry(start: WorldPoint, target: WorldPoint, width = 11, overlap = 2, bodyExtension = 0) {
		const dx = target.x - start.x;
		const dy = target.y - start.y;
		const length = Math.hypot(dx, dy) || 1;
		const ux = dx / length;
		const uy = dy / length;
		const px = -uy * (width / 2);
		const py = ux * (width / 2);
		const baseCenter = { x: start.x - ux * overlap, y: start.y - uy * overlap };
		const left = { x: baseCenter.x + px, y: baseCenter.y + py };
		const right = { x: baseCenter.x - px, y: baseCenter.y - py };
		const extendIntoBody = (point: WorldPoint): WorldPoint => ({
			x: point.x + (point.x - target.x) / length * bodyExtension,
			y: point.y + (point.y - target.y) / length * bodyExtension
		});
		const rootLeft = extendIntoBody(left);
		const rootRight = extendIntoBody(right);
		const seamProgress = Math.min(1, Math.max(0, (start.y - baseCenter.y) / (target.y - baseCenter.y || 1)));
		const seamCenterX = baseCenter.x + (target.x - baseCenter.x) * seamProgress;

		return {
			points: `${rootLeft.x},${rootLeft.y} ${rootRight.x},${rootRight.y} ${target.x},${target.y}`,
			outlinePath: `M ${rootLeft.x} ${rootLeft.y} L ${target.x} ${target.y} L ${rootRight.x} ${rootRight.y}`,
			rootLeft,
			rootRight,
			target,
			seamOffsetX: seamCenterX - start.x
		};
	}

	function specialTailExtension(speechType: SpeechType): number {
		return speechType === 'normal' ? 0 : SPECIAL_TAIL_BODY_EXTENSION;
	}

	function tailOutlineOpeningPoints(tail: ReturnType<typeof tailGeometry>, anchor: WorldPoint): string {
		return [tail.rootLeft, tail.rootRight, tail.target]
			.map((point) => ({ x: point.x - anchor.x, y: point.y - anchor.y }))
			.map((point) => `${point.x},${point.y}`)
			.join(' ');
	}

	function speechOutlineMaskId(bubbleId: string): string {
		return `speech-tail-opening-${bubbleId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
	}
</script>

<svelte:head>
	<title>{devWorldSandboxEnabled ? 'Persona Bubble Field — DEV World Sandbox' : 'Persona Bubble Field — Relay world'}</title>
	<link rel="icon" href={`${base}/favicon.svg`} />
	<meta
		name="description"
		content={devWorldSandboxEnabled
			? 'A local-only development sandbox with no Relay connection or publishing.'
			: 'Join and move in the current prototype world through Nostr relays.'}
	/>
</svelte:head>

<main
	class="app-shell"
	class:composer-available={runtimeMode === 'relay'}
	class:composer-keyboard-visible={composerKeyboardInset > 0}
	data-trace-runtime={traceConversationController ? runtimeMode : undefined}
	style={`--composer-keyboard-inset: ${composerKeyboardInset}px;--composer-initial-preferred-height: ${INITIAL_COMPOSER_PREFERRED_HEIGHT}px;${composerPreferredHeight === null ? '' : `--composer-preferred-height: ${composerPreferredHeight}px;`}`}
>
	<section class="field-viewport" bind:this={viewportElement} aria-label="Conversation field">
		<div
			class="speech-area"
			style={`top: ${speechAreaVisualBounds.y}px; height: ${speechAreaVisualBounds.height}px; left: ${speechAreaVisualBounds.x}px; width: ${speechAreaVisualBounds.width}px;`}
			aria-hidden="true"
		>
		</div>
		{#if timelineInitialized && timelineOpen}
			<aside class="recent-message-timeline" aria-label="Chatter">
				<header class="timeline-header">
					<button
						class="timeline-hide-control"
						type="button"
						aria-label="Hide Chatter"
						aria-keyshortcuts="C"
						on:click={hideRecentMessageTimeline}
					>×</button>
					<h2>Chatter</h2>
				</header>
				<div class="timeline-visible-entries" use:observeTimelineVisibleArea>
					{#each timelineVisibleMessages as message (message.id)}
						{@const character = timelineCharacter(message.pubkey)}
						{@const tone = timelineTone(message.pubkey)}
						<article
							class="timeline-entry"
							data-timeline-event-id={message.id}
							data-timeline-pubkey={message.pubkey}
							data-timeline-created-at={message.createdAt}
							data-timeline-tone={tone ?? 'default'}
						>
							<div class="timeline-content-shell">
								<div class="timeline-text" use:observeTimelineContent={message.id}>
									<button
										class={`timeline-name${tone ? ` tone-${tone}` : ''}`}
										type="button"
										aria-label={`${character.name} のプロフィールを開く`}
										on:click={(event) => openProfile(character.characterId, event.currentTarget as HTMLButtonElement)}
									>{character.name}</button>
									<span class="timeline-content">{message.content}</span>
								</div>
								{#if timelineOverflowById[message.id]}
									<span class="timeline-ellipsis" aria-hidden="true">…</span>
								{/if}
							</div>
						</article>
					{/each}
				</div>
				<div class="timeline-measurements" aria-hidden="true">
					{#each recentMessageTimeline as message (message.id)}
						{@const character = timelineCharacter(message.pubkey)}
						{@const tone = timelineTone(message.pubkey)}
						<article class="timeline-entry" use:observeTimelineEntry={message.id}>
							<div class="timeline-content-shell">
								<div class="timeline-text">
									<span class={`timeline-name${tone ? ` tone-${tone}` : ''}`}>{character.name}</span>
									<span class="timeline-content">{message.content}</span>
								</div>
							</div>
						</article>
					{/each}
				</div>
			</aside>
		{:else if timelineInitialized}
			<button
				class="timeline-show-control"
				type="button"
				aria-label="Show Chatter"
				aria-keyshortcuts="C"
				on:click={showRecentMessageTimeline}
			>Chatter</button>
		{/if}
		<div
			class="field-area"
			style={`top: ${fieldAreaBounds.y}px; left: ${fieldAreaBounds.x}px; width: ${fieldAreaBounds.width}px; height: ${fieldAreaBounds.height}px;`}
			aria-label="Field area"
			use:fieldSelectionPointer
		>
			<div
				class="field-scene"
				data-camera-animation={visualMotion ? 'active' : undefined}
				style={`--cell-size: ${cellSize}px; --avatar-size: calc(var(--cell-size) - 4px); width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
			>
				<div
					class="field-grid"
					style={`--field-background-image: url("${asset(FIELD_BACKGROUND_ASSET)}");`}
					aria-hidden="true"
				></div>
				<div class="trace-light-layer" aria-hidden="true">
					{#each traceLightCells as cell (`${cell.position.x},${cell.position.y}`)}
						{@const world = traceLightWorldPosition(cell.position, cell.occupied)}
						<span
							class="trace-light"
							data-trace-light-position={`${cell.position.x},${cell.position.y}`}
							data-trace-light-occupied={cell.occupied ? 'true' : undefined}
							style={`left: ${world.x}px; top: ${world.y}px;`}
						></span>
					{/each}
				</div>
				<div class="field-cell-selection-layer" aria-label="Trace investigation cells">
					{#each traceOnlyCellTriggers as position (`${position.x},${position.y}`)}
						<button
							class="field-cell-selection-trigger"
							type="button"
							data-cell-position={`${position.x},${position.y}`}
							aria-label="痕跡を調べる"
							style={`left: ${position.x * cellSize}px; top: ${position.y * cellSize}px;`}
							on:click={(event) => {
								event.stopPropagation();
								resolveFieldCellSelection(position, event.currentTarget as HTMLButtonElement);
							}}
						></button>
					{/each}
				</div>
				{#each participantViews as participant (participant.id)}
					<div
						class="participant"
						data-participant-id={participant.id}
						data-self={participant.id === selfProjectionId ? 'true' : undefined}
						data-position={`${participant.position.x},${participant.position.y}`}
						data-movement-animation={movingParticipantIds.has(participant.id) ? 'active' : undefined}
						style={`left: ${participant.world.x}px; top: ${participant.world.y}px;`}
					>
						<button
							class="participant-profile-trigger"
							type="button"
							aria-label={`${participant.character.name} のプロフィールを開く`}
							on:click={(event) => {
								event.stopPropagation();
								resolveFieldCellSelection(participant.position, event.currentTarget);
							}}
						>
							<Avatar.Root class={`avatar avatar-${participant.color}`}>
								<Avatar.Image src={asset(`/${participant.character.picture}`)} alt="" />
								<Avatar.Fallback>{participant.character.name.slice(0, 1)}</Avatar.Fallback>
							</Avatar.Root>
							<span
								class={`participant-name${participant.id === selfProjectionId ? ' participant-name-self' : ''}`}
								aria-hidden="true"
							>{participant.character.name}</span
							>
						</button>
					</div>
				{/each}
				{#if traceCurrentView?.ghost}
					<div
						class:trace-ghost-compact={traceCurrentView.compact}
						class="trace-ghost"
						data-trace-ghost-root-id={traceCurrentView.speech.kind === 'root' ? traceCurrentView.event.id : undefined}
						data-trace-current-reply-ghost-id={traceCurrentView.speech.kind === 'reply' ? traceCurrentView.event.id : undefined}
						style={`left: ${traceCurrentView.world.x}px; top: ${traceCurrentView.world.y}px;`}
					>
						<button
							class="trace-ghost-profile-trigger"
							type="button"
							aria-label={`${traceCurrentView.character.name} のプロフィールを開く`}
							on:click={(event) => {
								event.stopPropagation();
								openProfile(traceCurrentView.character.characterId, event.currentTarget);
							}}
						>
							<Avatar.Root class={`avatar avatar-${traceCurrentView.tone}`}>
								<Avatar.Image src={asset(`/${traceCurrentView.character.picture}`)} alt="" />
								<Avatar.Fallback>{traceCurrentView.character.name.slice(0, 1)}</Avatar.Fallback>
							</Avatar.Root>
							<span class="trace-ghost-name" aria-hidden="true">{traceCurrentView.character.name}</span>
						</button>
					</div>
				{/if}
				{#if traceParentView?.ghost}
					<div
						class:trace-ghost-compact={traceParentView.compact}
						class="trace-ghost trace-parent-ghost"
						data-trace-parent-ghost-id={traceParentView.event.id}
						style={`left: ${traceParentView.world.x}px; top: ${traceParentView.world.y}px;`}
					>
						<button
							class="trace-ghost-profile-trigger"
							type="button"
							aria-label={`${traceParentView.character.name} のプロフィールを開く`}
							on:click={(event) => {
								event.stopPropagation();
								openProfile(traceParentView.character.characterId, event.currentTarget);
							}}
						>
							<Avatar.Root class={`avatar avatar-${traceParentView.tone}`}>
								<Avatar.Image src={asset(`/${traceParentView.character.picture}`)} alt="" />
								<Avatar.Fallback>{traceParentView.character.name.slice(0, 1)}</Avatar.Fallback>
							</Avatar.Root>
							<span class="trace-ghost-name" aria-hidden="true">{traceParentView.character.name}</span>
						</button>
					</div>
				{/if}
				{#each traceReplyGhosts as ghost (ghost.reply.id)}
					<div
						class:trace-ghost-compact={ghost.compact}
						class="trace-ghost trace-reply-ghost"
						data-trace-reply-ghost-id={ghost.reply.id}
						data-trace-reply-position={`${ghost.reply.position.x},${ghost.reply.position.y}`}
						style={`left: ${ghost.world.x}px; top: ${ghost.world.y}px;`}
					>
						<button
							class="trace-ghost-profile-trigger"
							type="button"
							aria-label={`${ghost.character.name} のプロフィールを開く`}
							on:click={(event) => {
								event.stopPropagation();
								openProfile(ghost.character.characterId, event.currentTarget);
							}}
						>
							<Avatar.Root class={`avatar avatar-${ghost.tone}`}>
								<Avatar.Image src={asset(`/${ghost.character.picture}`)} alt="" />
								<Avatar.Fallback>{ghost.character.name.slice(0, 1)}</Avatar.Fallback>
							</Avatar.Root>
							<span class="trace-ghost-name" aria-hidden="true">{ghost.character.name}</span>
						</button>
					</div>
				{/each}
				{#if fieldActionMenu}
					<div
						class="field-action-menu"
						role="menu"
						tabindex="-1"
						aria-label="Cell actions"
						style={`left: ${(fieldActionMenu.position.x + 0.5) * cellSize}px; top: ${(fieldActionMenu.position.y + 0.5) * cellSize}px;`}
					>
					{#each fieldActionMenu.actions as action, index (`${action.kind}-${action.kind === 'participant' ? action.participantId : action.kind === 'trace' ? action.rootId : action.replyId}-${index}`)}
							<button
								type="button"
								role="menuitem"
								data-cell-action={action.kind}
								on:click={(event) => {
									event.stopPropagation();
									executeFieldCellAction(action, fieldActionMenu!.position, event.currentTarget);
								}}
							>{fieldActionLabel(action)}</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
		{#if pointerJoystick}
			<div
				class="pointer-joystick"
				data-pointer-joystick={pointerJoystick.direction}
				aria-hidden="true"
				style={`left: ${pointerJoystick.center.x}px; top: ${pointerJoystick.center.y}px;`}
			>
				<div class="pointer-joystick-base"></div>
				<div
					class="pointer-joystick-thumb"
					style={`--joystick-thumb-x: ${pointerJoystick.thumb.x}px; --joystick-thumb-y: ${pointerJoystick.thumb.y}px;`}
				></div>
			</div>
		{/if}

		<svg class="tail-layer" viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`} aria-hidden="true">
			{#if traceBubble && (offscreenTraceReplyCells.length > 0 || projectedTraceParent?.projection.visibility === 'offscreen')}
				<defs>
					<marker id="trace-offscreen-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
						<path class="trace-offscreen-arrowhead" d="M 0 0 L 8 4 L 0 8 z" />
					</marker>
				</defs>
			{/if}
			{#if traceBubble}
				{@const currentCenter = bubbleCenter(traceBubble.anchor, traceBubble.size)}
				{#if traceParentBubble}
					<path
						class="trace-relation-connector trace-parent-connector"
						data-trace-parent-relation-id={traceParentBubble.event.id}
						d={traceRelationPath(bubbleCenter(traceParentBubble.anchor, traceParentBubble.size), currentCenter)}
					/>
				{:else if projectedTraceParent?.projection.visibility === 'offscreen' && projectedTraceParent.projection.edge}
					<path
						class="trace-relation-connector trace-offscreen-connector trace-parent-offscreen-connector"
						data-trace-parent-offscreen-id={projectedTraceParent.speech.event.id}
						data-trace-parent-direction={projectedTraceParent.projection.edge.direction}
						d={traceRelationPath(currentCenter, projectedTraceParent.projection.edge.point)}
						marker-end="url(#trace-offscreen-arrow)"
					/>
				{/if}
				{#each traceReplyBubbles as bubble (bubble.id)}
					<path
						class="trace-relation-connector"
						data-trace-relation-reply-id={bubble.reply.id}
						d={traceRelationPath(currentCenter, bubbleCenter(bubble.anchor, bubble.size))}
					/>
				{/each}
				{#each offscreenTraceReplyCells as item (`${item.cell.position.x},${item.cell.position.y}`)}
					{#if item.projection.edge}
						<path
							class="trace-relation-connector trace-offscreen-connector"
							data-trace-reply-offscreen-position={`${item.cell.position.x},${item.cell.position.y}`}
							data-trace-reply-direction={item.projection.edge.direction}
							d={traceRelationPath(currentCenter, item.projection.edge.point)}
							marker-end="url(#trace-offscreen-arrow)"
						/>
					{/if}
				{/each}
			{/if}
			{#each positionedNormalBubbles as bubble (bubble.id)}
				{@const start = tailStart(bubble.anchor, bubble.size)}
				{@const target = tailTarget(bubble.speaker)}
				{@const tail = tailGeometry(start, target, 11, 2, specialTailExtension(bubble.speechType))}
				<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={bubble.speaker.id} points={tail.points} />
				<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={bubble.speaker.id} d={tail.outlinePath} />
			{/each}
			{#each positionedMergedBubbles as bubble (bubble.id)}
				{#each bubble.members as member, index (member.id)}
					{@const start = mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length)}
					{@const target = tailTarget(member)}
					{@const tail = tailGeometry(start, target, 9, 2, specialTailExtension(bubble.speechType))}
					<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={member.id} points={tail.points} />
					<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={member.id} d={tail.outlinePath} />
				{/each}
			{/each}
			{#if traceBubble}
				{@const start = tailStart(traceBubble.anchor, traceBubble.size)}
				{@const tail = tailGeometry(start, traceBubble.tailTarget, 11, 2, specialTailExtension(traceBubble.event.speechType))}
				<polygon class={`tail trace-tail tone-${traceBubble.tone}`} data-trace-tail-root-id={traceBubble.speech.kind === 'root' ? traceBubble.event.id : undefined} data-trace-tail-current-reply-id={traceBubble.speech.kind === 'reply' ? traceBubble.event.id : undefined} data-trace-tail-target={`${traceBubble.tailTarget.x},${traceBubble.tailTarget.y}`} points={tail.points} />
				<path class={`tail-outline trace-tail-outline tone-${traceBubble.tone}`} data-trace-tail-root-id={traceBubble.speech.kind === 'root' ? traceBubble.event.id : undefined} data-trace-tail-current-reply-id={traceBubble.speech.kind === 'reply' ? traceBubble.event.id : undefined} data-trace-tail-target={`${traceBubble.tailTarget.x},${traceBubble.tailTarget.y}`} d={tail.outlinePath} />
			{/if}
			{#if traceParentBubble}
				{@const start = tailStart(traceParentBubble.anchor, traceParentBubble.size)}
				{@const tail = tailGeometry(start, traceParentBubble.tailTarget, 11, 2, specialTailExtension(traceParentBubble.event.speechType))}
				<polygon class={`tail trace-tail trace-parent-tail tone-${traceParentBubble.tone}`} data-trace-tail-parent-id={traceParentBubble.event.id} points={tail.points} />
				<path class={`tail-outline trace-tail-outline trace-parent-tail-outline tone-${traceParentBubble.tone}`} data-trace-tail-parent-id={traceParentBubble.event.id} d={tail.outlinePath} />
			{/if}
			{#each traceReplyBubbles as bubble (bubble.id)}
				{@const start = tailStart(bubble.anchor, bubble.size)}
				{@const tail = tailGeometry(start, bubble.tailTarget, 11, 2, specialTailExtension(bubble.reply.speechType))}
				<polygon class={`tail trace-tail tone-${bubble.tone}`} data-trace-tail-reply-id={bubble.reply.id} data-trace-tail-target={`${bubble.tailTarget.x},${bubble.tailTarget.y}`} points={tail.points} />
				<path class={`tail-outline trace-tail-outline tone-${bubble.tone}`} data-trace-tail-reply-id={bubble.reply.id} data-trace-tail-target={`${bubble.tailTarget.x},${bubble.tailTarget.y}`} d={tail.outlinePath} />
			{/each}
		</svg>

		<div class="bubble-layer" aria-live="polite">
			{#each positionedVisibleBubbles as bubble (bubble.id)}
				<div
					use:observeBubble={bubble.id}
					class={`bubble bubble-${bubble.kind} bubble-${bubble.tone} tone-${bubble.tone}${bubble.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
					data-bubble-id={bubble.id}
					data-bubble-participant-id={bubble.kind === 'normal' ? bubble.speaker.id : undefined}
					data-merged-members={bubble.kind === 'merged' ? bubble.memberPubkeys.length : undefined}
					data-speech-type={bubble.speechType}
					style={`${bubble.kind === 'merged' ? mergedBubbleStyle(bubble.memberPubkeys.length) : ''}; --tail-seam-offset-x: ${bubble.kind === 'normal' ? tailGeometry(tailStart(bubble.anchor, bubble.size), tailTarget(bubble.speaker)).seamOffsetX : 0}px; transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
				>
					{#if bubble.speechType !== 'normal'}
						{@const shape = bubble.shape}
						{@const outlineMaskId = speechOutlineMaskId(bubble.id)}
						<svg
							class="bubble-surface"
							data-speech-surface={bubble.speechType}
							data-visual-bounds={`${shape?.bounds.x ?? 0},${shape?.bounds.y ?? 0},${shape?.bounds.width ?? bubble.size.width},${shape?.bounds.height ?? bubble.size.height}`}
							viewBox={`${shape?.bounds.x ?? 0} ${shape?.bounds.y ?? 0} ${shape?.bounds.width ?? bubble.size.width} ${shape?.bounds.height ?? bubble.size.height}`}
							style={shape ? bubbleSurfaceStyle(shape) : ''}
							aria-hidden="true"
						>
							<defs>
								<mask id={outlineMaskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? bubble.size.width} height={shape?.bounds.height ?? bubble.size.height}>
									<rect x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? bubble.size.width} height={shape?.bounds.height ?? bubble.size.height} fill="white" />
									{#if bubble.kind === 'normal'}
										{@const start = tailStart(bubble.anchor, bubble.size)}
										{@const tail = tailGeometry(start, tailTarget(bubble.speaker), 11, 2, SPECIAL_TAIL_BODY_EXTENSION)}
										<polygon data-tail-opening={bubble.speaker.id} points={tailOutlineOpeningPoints(tail, bubble.anchor)} fill="black" />
									{:else}
										{#each bubble.members as member, index (member.id)}
											{@const start = mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length)}
											{@const tail = tailGeometry(start, tailTarget(member), 9, 2, SPECIAL_TAIL_BODY_EXTENSION)}
											<polygon data-tail-opening={member.id} points={tailOutlineOpeningPoints(tail, bubble.anchor)} fill="black" />
										{/each}
									{/if}
								</mask>
							</defs>
							<path class="bubble-surface-fill" d={shape?.path ?? ''} />
							<path class="bubble-surface-outline" d={shape?.path ?? ''} mask={`url(#${outlineMaskId})`} />
						</svg>
					{/if}
					<span class="bubble-content">{bubble.text}</span>
					{#if bubbleOverflowById[bubble.id]}
						<span class="bubble-ellipsis" aria-hidden="true">…</span>
					{/if}
					{#if bubble.kind === 'merged' && bubble.speechType === 'normal'}
						{#each bubble.members as member, index (member.id)}
							<span
								class="bubble-tail-connection"
								data-tail-participant-id={member.id}
								style={`${mergedTailConnectionStyle(index, bubble.members.length)} --tail-seam-offset-x: ${tailGeometry(mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length), tailTarget(member), 9, 2).seamOffsetX}px;`}
								aria-hidden="true"
							></span>
						{/each}
					{/if}
				</div>
			{/each}
			{#each traceReplyBubbles as bubble (bubble.id)}
				{@const replyTarget = bubble.tailTarget}
				{@const replyTail = tailGeometry(tailStart(bubble.anchor, bubble.size), replyTarget, 11, 2, specialTailExtension(bubble.reply.speechType))}
				<div
					use:observeBubble={bubble.id}
					class={`bubble bubble-normal trace-reply-bubble tone-${bubble.tone}${bubble.reply.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
					data-bubble-id={bubble.id}
					data-trace-reply-id={bubble.reply.id}
					data-trace-reply-position={`${bubble.reply.position.x},${bubble.reply.position.y}`}
					data-trace-reply-count={bubble.cell.count}
					data-speech-type={bubble.reply.speechType}
					style={`--tail-seam-offset-x: ${replyTail.seamOffsetX}px; transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
				>
					{#if bubble.reply.speechType !== 'normal'}
						{@const shape = bubble.shape}
						{@const outlineMaskId = speechOutlineMaskId(bubble.id)}
						<svg
							class="bubble-surface"
							data-speech-surface={bubble.reply.speechType}
							data-visual-bounds={`${shape?.bounds.x ?? 0},${shape?.bounds.y ?? 0},${shape?.bounds.width ?? bubble.size.width},${shape?.bounds.height ?? bubble.size.height}`}
							viewBox={`${shape?.bounds.x ?? 0} ${shape?.bounds.y ?? 0} ${shape?.bounds.width ?? bubble.size.width} ${shape?.bounds.height ?? bubble.size.height}`}
							style={shape ? bubbleSurfaceStyle(shape) : ''}
							aria-hidden="true"
						>
							<defs>
								<mask id={outlineMaskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? bubble.size.width} height={shape?.bounds.height ?? bubble.size.height}>
									<rect x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? bubble.size.width} height={shape?.bounds.height ?? bubble.size.height} fill="white" />
									<polygon data-tail-opening={bubble.reply.id} points={tailOutlineOpeningPoints(replyTail, bubble.anchor)} fill="black" />
								</mask>
							</defs>
							<path class="bubble-surface-fill trace-bubble-surface-fill" d={shape?.path ?? ''} />
							<path class="bubble-surface-outline trace-bubble-surface-outline" d={shape?.path ?? ''} mask={`url(#${outlineMaskId})`} />
						</svg>
					{/if}
					<span class="bubble-content">{bubble.reply.content}</span>
					{#if bubbleOverflowById[bubble.id]}
						<span class="bubble-ellipsis" aria-hidden="true">…</span>
					{/if}
					{#if bubble.cell.count > 1}
						<span class="trace-reply-count" aria-label={`${bubble.cell.count} replies in this cell`}>{bubble.cell.count}</span>
					{/if}
				</div>
			{/each}
			{#if traceParentBubble}
				{@const parentTail = tailGeometry(tailStart(traceParentBubble.anchor, traceParentBubble.size), traceParentBubble.tailTarget, 11, 2, specialTailExtension(traceParentBubble.event.speechType))}
				<div
					use:observeBubble={traceParentBubble.id}
					class={`bubble bubble-normal trace-root-bubble trace-parent-bubble tone-${traceParentBubble.tone}${traceParentBubble.event.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
					data-bubble-id={traceParentBubble.id}
					data-trace-parent-id={traceParentBubble.event.id}
					data-trace-parent-kind={traceParentBubble.speech.kind}
					data-speech-type={traceParentBubble.event.speechType}
					style={`--tail-seam-offset-x: ${parentTail.seamOffsetX}px; transform: translate3d(${traceParentBubble.anchor.x}px, ${traceParentBubble.anchor.y}px, 0);`}
				>
					{#if traceParentBubble.event.speechType !== 'normal'}
						{@const shape = traceParentBubble.shape}
						{@const outlineMaskId = speechOutlineMaskId(traceParentBubble.id)}
						<svg class="bubble-surface" data-speech-surface={traceParentBubble.event.speechType} viewBox={`${shape?.bounds.x ?? 0} ${shape?.bounds.y ?? 0} ${shape?.bounds.width ?? traceParentBubble.size.width} ${shape?.bounds.height ?? traceParentBubble.size.height}`} style={shape ? bubbleSurfaceStyle(shape) : ''} aria-hidden="true">
							<defs>
								<mask id={outlineMaskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? traceParentBubble.size.width} height={shape?.bounds.height ?? traceParentBubble.size.height}>
									<rect x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? traceParentBubble.size.width} height={shape?.bounds.height ?? traceParentBubble.size.height} fill="white" />
									<polygon data-tail-opening={traceParentBubble.event.id} points={tailOutlineOpeningPoints(parentTail, traceParentBubble.anchor)} fill="black" />
								</mask>
							</defs>
							<path class="bubble-surface-fill trace-bubble-surface-fill" d={shape?.path ?? ''} />
							<path class="bubble-surface-outline trace-bubble-surface-outline" d={shape?.path ?? ''} mask={`url(#${outlineMaskId})`} />
						</svg>
					{/if}
					<span class="bubble-content">{traceParentBubble.event.content}</span>
					{#if bubbleOverflowById[traceParentBubble.id]}<span class="bubble-ellipsis" aria-hidden="true">…</span>{/if}
				</div>
			{/if}
			{#if traceBubble}
				{@const currentTail = tailGeometry(tailStart(traceBubble.anchor, traceBubble.size), traceBubble.tailTarget, 11, 2, specialTailExtension(traceBubble.event.speechType))}
				<div
					use:observeBubble={traceBubble.id}
					class={`bubble bubble-normal trace-root-bubble trace-current-bubble tone-${traceBubble.tone}${traceBubble.event.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
					data-bubble-id={traceBubble.id}
					data-trace-root-id={traceBubble.speech.kind === 'root' ? traceBubble.event.id : undefined}
					data-trace-current-reply-id={traceBubble.speech.kind === 'reply' ? traceBubble.event.id : undefined}
					data-trace-current-id={traceBubble.event.id}
					data-trace-current-kind={traceBubble.speech.kind}
					data-speech-type={traceBubble.event.speechType}
					style={`--tail-seam-offset-x: ${currentTail.seamOffsetX}px; transform: translate3d(${traceBubble.anchor.x}px, ${traceBubble.anchor.y}px, 0);`}
				>
					{#if traceBubble.event.speechType !== 'normal'}
						{@const shape = traceBubble.shape}
						{@const outlineMaskId = speechOutlineMaskId(traceBubble.id)}
						<svg
							class="bubble-surface"
							data-speech-surface={traceBubble.event.speechType}
							viewBox={`${shape?.bounds.x ?? 0} ${shape?.bounds.y ?? 0} ${shape?.bounds.width ?? traceBubble.size.width} ${shape?.bounds.height ?? traceBubble.size.height}`}
							style={shape ? bubbleSurfaceStyle(shape) : ''}
							aria-hidden="true"
						>
							<defs>
								<mask id={outlineMaskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? traceBubble.size.width} height={shape?.bounds.height ?? traceBubble.size.height}>
									<rect x={shape?.bounds.x ?? 0} y={shape?.bounds.y ?? 0} width={shape?.bounds.width ?? traceBubble.size.width} height={shape?.bounds.height ?? traceBubble.size.height} fill="white" />
									<polygon data-tail-opening={traceBubble.event.id} points={tailOutlineOpeningPoints(currentTail, traceBubble.anchor)} fill="black" />
								</mask>
							</defs>
							<path class="bubble-surface-fill trace-bubble-surface-fill" d={shape?.path ?? ''} />
							<path class="bubble-surface-outline trace-bubble-surface-outline" d={shape?.path ?? ''} mask={`url(#${outlineMaskId})`} />
						</svg>
					{/if}
					<span class="bubble-content">{traceBubble.event.content}</span>
					{#if bubbleOverflowById[traceBubble.id]}
						<span class="bubble-ellipsis" aria-hidden="true">…</span>
					{/if}
					{#if selectedTraceDetails && selectedTraceDetails.total > 1}
						<div class="trace-root-selector" aria-label="Trace roots in this cell">
							<button type="button" aria-label="Previous trace root" disabled={selectedTraceDetails.index === 0} on:click={() => selectAdjacentTraceRoot(-1)}>‹</button>
							<span>{selectedTraceDetails.index + 1}/{selectedTraceDetails.total}</span>
							<button type="button" aria-label="Next trace root" disabled={selectedTraceDetails.index === selectedTraceDetails.total - 1} on:click={() => selectAdjacentTraceRoot(1)}>›</button>
						</div>
					{/if}
					{#if traceConversationState.kind === 'open' && traceConversationState.replyRefresh !== 'settled'}
						<span class="trace-reply-status" data-reply-refresh={traceConversationState.replyRefresh}>
							{traceConversationState.replyRefresh === 'loading' ? 'Loading…' : 'Replies unavailable'}
						</span>
					{/if}
				</div>
			{/if}
		</div>

		<div class="viewport-vignette" aria-hidden="true"></div>
	</section>

	<ProfileDialog
		onOpenChange={handleProfileOpenChange}
		onCloseAutoFocus={restoreProfileTriggerFocus}
	/>

	{#if devWorldSandboxEnabled}
		<div class="sandbox-controls" aria-label="DEV sandbox controls">
			<label class="sandbox-character-picker">
				<span>Character</span>
				<select aria-label="Select sandbox character" value={selectedCharacterId} on:change={(event) => selectSandboxCharacter((event.currentTarget as HTMLSelectElement).value)}>
					{#each CHARACTER_CATALOG as character (character.characterId)}
						<option value={character.characterId}>{character.characterId} — {character.name}</option>
					{/each}
				</select>
			</label>
			{#if devTraceReplyFixtureEnabled}
				<button
					class="sandbox-live-reply"
					type="button"
					disabled={devTraceReplies.some((reply) => reply.id === 'c'.repeat(64))}
					on:click={injectDevTraceLiveReply}
				>Add live trace reply</button>
			{/if}
			<button class="sandbox-reset" type="button" on:click={resetSandbox}>Reset sandbox</button>
		</div>
	{:else if selfPositionWriteState.kind === 'retryable' && !isWorldSelfActive}
		<div class="world-controls" aria-label="World entry controls">
			<button class="world-entry-retry" type="button" on:click={retryWorldEntry}>Enter field again</button>
		</div>
	{/if}

	{#if runtimeMode === 'relay'}
		<div class="composer-dock" aria-label="Message composer">
			<div class="composer-dock-content">
				<button
					class="speech-type-toggle"
					type="button"
					data-speech-type={selectedSpeechType}
					aria-label={`発言タイプ: ${SPEECH_TYPE_LABELS[selectedSpeechType]}（クリックで${SPEECH_TYPE_LABELS[nextSpeechType(selectedSpeechType)]}へ）`}
					title={`発言タイプ: ${SPEECH_TYPE_LABELS[selectedSpeechType]}。クリックで${SPEECH_TYPE_LABELS[nextSpeechType(selectedSpeechType)]}へ`}
					disabled={composerSubmissionInProgress}
					on:click={cycleSpeechType}
				>
					<span aria-hidden="true">{SPEECH_TYPE_LABELS[selectedSpeechType]}</span>
				</button>
				<div class="composer-editor-slot">
					<HostOwnedComposerLite
						bind:this={composerComponent}
						submitContent={submitComposerContent}
						onEditorEmptyChange={handleComposerEditorEmptyChange}
						onPreferredHeightChange={setComposerPreferredHeight}
					/>
				</div>
			</div>
		</div>
	{/if}

</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(:root) {
		--app-background: #161921;
	}

	:global(html) {
		background: var(--app-background);
	}

	:global(body) {
		margin: 0;
		min-width: 320px;
		background: var(--app-background);
		color: #2e3435;
		font-family: 'Trebuchet MS', 'Avenir Next', system-ui, sans-serif;
	}

	:global(button) {
		font: inherit;
		cursor: pointer;
	}

	.app-shell {
		--composer-dock-padding-block: 8px;
		--composer-dock-border-width: 1px;
		--composer-preferred-height: var(--composer-initial-preferred-height);
		--composer-dock-height: calc(
			var(--composer-preferred-height)
			+ var(--composer-dock-padding-block)
			+ var(--composer-dock-padding-block)
			+ var(--composer-dock-border-width)
			+ env(safe-area-inset-bottom)
		);
		position: relative;
		display: flex;
		height: 100svh;
		min-height: 100svh;
		flex-direction: column;
		overflow: hidden;
		background: transparent;
	}

	.status-panel,
	.footer-note,
	.camera-chip,
	.sandbox-controls,
	.world-controls {
		position: absolute;
		z-index: 10;
	}


	.brand-lockup {
		display: flex;
		align-items: center;
		gap: 11px;
	}

	.brand-mark {
		display: grid;
		width: 35px;
		height: 35px;
		place-items: center;
		border: 1.5px solid #394044;
		border-radius: 50%;
		color: #e88a6b;
		font-size: 22px;
		line-height: 1;
	}

	.brand-name,
	.brand-subtitle,
	.panel-kicker,
	.status-message,
	.footer-note,
	.field-label {
		margin: 0;
	}

	.brand-name {
		font-size: 15px;
		font-weight: 800;
		letter-spacing: 0.02em;
	}

	.brand-subtitle {
		margin-top: 2px;
		color: #7d8582;
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.prototype-badge {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border: 1px solid rgba(53, 64, 65, 0.15);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.42);
		color: #7d8582;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.prototype-badge span {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #d98568;
		box-shadow: 0 0 0 4px rgba(217, 133, 104, 0.14);
	}

	.field-viewport {
		position: relative;
		min-height: 100svh;
		flex: 1;
		overflow: hidden;
		isolation: isolate;
		background: transparent;
	}

	.composer-available .field-viewport {
		min-height: 0;
	}

	.composer-available {
		padding-bottom: var(--composer-dock-height);
	}

	.composer-dock {
		position: fixed;
		bottom: var(--composer-keyboard-inset);
		left: 0;
		right: 0;
		z-index: 12;
		height: var(--composer-dock-visible-height, var(--composer-dock-height));
		padding: var(--composer-dock-padding-block) 16px
			calc(var(--composer-dock-padding-block) + env(safe-area-inset-bottom));
		border-top: var(--composer-dock-border-width) solid rgba(57, 67, 64, 0.14);
		background: rgba(245, 241, 233, 0.98);
	}

	.composer-keyboard-visible .composer-dock {
		--composer-dock-visible-height: calc(var(--composer-dock-height) - env(safe-area-inset-bottom));
		padding-bottom: var(--composer-dock-padding-block);
	}

	.composer-dock-content {
		display: flex;
		width: min(720px, 100%);
		height: 100%;
		align-items: stretch;
		gap: 8px;
		margin: 0 auto;
		min-width: 0;
	}

	.speech-type-toggle {
		flex: 0 0 54px;
		min-width: 0;
		min-height: 0;
		padding: 0 4px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1);
		color: #3f4a47;
		font-size: 10px;
		font-weight: 800;
		line-height: 1.15;
		white-space: normal;
	}

	.speech-type-toggle:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.98);
	}

	.speech-type-toggle:disabled {
		cursor: wait;
		opacity: 0.58;
	}

	.speech-type-toggle:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: 2px;
	}

	.composer-editor-slot {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.composer-dock-content :global(.host-owned-composer) {
		width: 100%;
		height: 100%;
		min-width: 0;
	}

	.field-viewport::before {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: transparent;
		content: '';
	}

	.recent-message-timeline {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 12px;
		z-index: 9;
		display: flex;
		width: min(320px, calc(100% - 32px));
		flex-direction: column;
		border-radius: 18px;
		background: transparent;
		box-shadow: none;
		color: #374345;
		pointer-events: auto;
	}

	.timeline-header {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		padding: 16px 12px 10px 0;
		border-bottom: 1px solid rgba(57, 67, 64, 0.12);
		flex: 0 0 auto;
		gap: 12px;
	}

	.timeline-header h2 {
		margin: 0;
		color: #fff;
		font-size: 16px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
	}

	.timeline-hide-control,
	.timeline-show-control {
		border: 1px solid rgba(57, 67, 64, 0.16);
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.78);
		box-shadow: 0 4px 10px rgba(58, 70, 61, 0.1);
		color: #596662;
		font-weight: 700;
	}

	.timeline-hide-control {
		display: grid;
		width: 44px;
		height: 44px;
		padding: 0;
		place-items: center;
		font-size: 30px;
		line-height: 1;
	}

	.timeline-visible-entries {
		flex: 1 1 auto;
		min-height: 0;
		padding: 0;
		overflow: visible;
	}

	.timeline-measurements {
		position: absolute;
		top: 0;
		right: 8px;
		left: 8px;
		visibility: hidden;
		pointer-events: none;
	}

	/* .timeline-entry {
		padding: 10px 8px 11px;
	} */

	.timeline-entry:last-child { border-bottom: 0; }

	.timeline-name {
		display: inline;
		max-width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		appearance: none;
		color: #fff;
		font-family: inherit;
		font-weight: 700;
		line-height: 1.45;
		margin-right: 0.35em;
		letter-spacing: 0.02em;
		text-align: left;
		cursor: pointer;
		vertical-align: top;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
	}

	.timeline-name.tone-coral { color: hsl(12, 96%, 42%); }
	.timeline-name.tone-lavender { color: hsl(250, 72%, 42%); }
	.timeline-name.tone-mint { color: hsl(145, 68%, 31%); }
	.timeline-name.tone-yellow { color: hsl(48, 82%, 34%); }
	.timeline-name.tone-sky { color: hsl(188, 72%, 32%); }
	.timeline-name.tone-peach { color: hsl(28, 82%, 38%); }
	.timeline-name.tone-rose { color: hsl(340, 72%, 40%); }
	.timeline-name.tone-blue { color: hsl(210, 72%, 37%); }

	.timeline-name:hover,
	.timeline-name:focus-visible {
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.18);
	}

	.timeline-content-shell {
		position: relative;
		min-width: 0;
	}

	.timeline-text {
		max-height: calc(1.45em * 5);
		overflow: hidden;
		color: #fff;
		font-size: 18px;
		letter-spacing: 0.01em;
		line-height: 1.45;
		padding: 6px 0;
		overflow-wrap: anywhere;
		white-space: pre-line;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);

	 @media (width <= 700px) {
			font-size: 14px;
		}
	}

	.timeline-content {
		display: inline;
		color: inherit;
		font: inherit;
	}

	.timeline-ellipsis {
		position: absolute;
		right: 0;
		bottom: 0;
		padding-left: 0.35em;
		background: transparent;
		color: #fff;
		font-size: 13px;
		font-weight: 700;
		line-height: 1.45;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
	}

	.timeline-show-control {
		position: absolute;
		top: 16px;
		left: 12px;
		z-index: 9;
		min-height: 44px;
		padding: 0 13px;
		font-size: 16px;
		letter-spacing: 0.03em;
		pointer-events: auto;
	}

	.timeline-hide-control:focus-visible,
	.timeline-name:focus-visible,
	.timeline-show-control:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: 2px;
	}

	.field-scene {
		position: absolute;
		top: 0;
		left: 0;
		will-change: transform;
	}

	.field-area {
		position: absolute;
		z-index: 2;
		overflow: hidden;
		background: transparent;
		touch-action: pinch-zoom;
	}

	.speech-area {
		position: absolute;
		z-index: 1;
		border-top: 1px dashed rgba(111, 121, 100, 0.2);
		border-bottom: 1px dashed rgba(111, 121, 100, 0.2);
		background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), transparent 42%, rgba(255, 255, 255, 0.06));
		pointer-events: none;
	}

	.speech-area span {
		position: absolute;
		top: 68px;
		right: 10px;
		color: rgba(89, 104, 88, 0.38);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.field-grid {
		position: absolute;
		inset: 0;
		background-color: rgba(222, 228, 213, 0.48);
		background-image:
			linear-gradient(to right, rgba(101, 122, 105, 0.16) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(101, 122, 105, 0.16) 1px, transparent 1px),
			linear-gradient(rgba(255, 250, 224, 0.2), rgba(255, 250, 224, 0.2)),
			var(--field-background-image, none);
		background-size: var(--cell-size) var(--cell-size), var(--cell-size) var(--cell-size),
			100% 100%, 100% 100%;
		background-repeat: repeat, repeat, no-repeat, no-repeat;
		box-shadow:
			0 24px 65px rgba(67, 75, 62, 0.12),
			inset 0 0 0 1px rgba(95, 111, 96, 0.3);
	}

	.field-grid::after {
		position: absolute;
		inset: 0;
		border: 2px solid rgba(68, 91, 73, 0.48);
		box-shadow: inset 0 0 0 10px rgba(112, 137, 108, 0.2);
		content: '';
		pointer-events: none;
	}

	.trace-light-layer {
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
	}

	.trace-light {
		position: absolute;
		width: max(6px, calc(var(--cell-size) * 0.14));
		height: max(6px, calc(var(--cell-size) * 0.14));
		border: 1px solid rgba(255, 250, 205, 0.84);
		border-radius: 50%;
		background: rgba(255, 238, 154, 0.75);
		box-shadow: 0 0 8px 3px rgba(255, 225, 120, 0.42);
		pointer-events: none;
		transform: translate(-50%, -50%);
	}

	.field-cell-selection-layer {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
	}

	.field-cell-selection-trigger {
		position: absolute;
		width: var(--cell-size);
		height: var(--cell-size);
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		pointer-events: auto;
		touch-action: manipulation;
	}

	.field-cell-selection-trigger:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: -5px;
	}

	.pointer-joystick {
		position: absolute;
		z-index: 7;
		width: 96px;
		height: 96px;
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.pointer-joystick-base,
	.pointer-joystick-thumb {
		position: absolute;
		border-radius: 50%;
		pointer-events: none;
	}

	.pointer-joystick-base {
		top: 0;
		left: 0;
		width: 96px;
		height: 96px;
		border: 1px solid rgba(50, 82, 70, 0.32);
		background: rgba(221, 235, 221, 0.32);
		box-shadow: 0 5px 18px rgba(50, 68, 56, 0.14), inset 0 0 0 1px rgba(255, 255, 255, 0.3);
	}

	.pointer-joystick-thumb {
		left: calc(50% + var(--joystick-thumb-x));
		top: calc(50% + var(--joystick-thumb-y));
		width: 32px;
		height: 32px;
		transform: translate(-50%, -50%);
		border: 1px solid rgba(43, 77, 63, 0.48);
		background: rgba(108, 153, 132, 0.58);
		box-shadow: 0 3px 10px rgba(50, 68, 56, 0.18);
	}

	.field-label {
		position: absolute;
		color: rgba(66, 86, 71, 0.52);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
	}

	.field-label-top {
		top: 24px;
		left: 24px;
	}

	.field-label-bottom {
		right: 24px;
		bottom: 24px;
	}

	.participant {
		position: absolute;
		z-index: 3;
		width: var(--cell-size);
		height: var(--cell-size);
		transform: translate(-50%, -50%);
		will-change: left, top;
	}

	.participant-profile-trigger {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
	}

	.participant-profile-trigger:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: 3px;
	}

	:global(.avatar) {
		position: absolute;
		top: 50%;
		left: 50%;
		display: grid;
		width: var(--avatar-size);
		height: var(--avatar-size);
		box-sizing: border-box;
		place-items: center;
		border: 2px solid rgba(255, 255, 255, 0.88);
		border-radius: 42% 58% 48% 52%;
		box-shadow: 0 5px 10px rgba(58, 70, 61, 0.16);
		color: #374345;
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.04em;
		transform: translate(-50%, -50%);
	}

	:global(.avatar-coral) { background: #f0a488; }
	:global(.avatar-lavender) { background: #b6afe1; }
	:global(.avatar-mint) { background: #99c6ac; }
	:global(.avatar-yellow) { background: #e8c774; }
	:global(.avatar-sky) { background: #9bc6d5; }
	:global(.avatar-peach) { background: #eab994; }
	:global(.avatar-rose) { background: #dca1b2; }
	:global(.avatar-blue) { background: #90b4d0; }

	:global(.avatar img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: center;
	}

	.participant-name {
		position: absolute;
		bottom: 1px;
		left: 50%;
		display: block;
		width: max-content;
		max-width: calc(var(--avatar-size) + 4px);
		box-sizing: border-box;
		transform: translateX(-50%);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		padding: 1px 6px 1px;
		border-radius: 999px;
		background: rgba(247, 247, 239, 0.74);
		color: #596662;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.03em;

		@media (max-width: 700px) {
			font-size: 8px;
		}
	}

	.participant-name-self {
		border: 2px solid #d14949;
		font-weight: 800;
	}

	.trace-ghost {
		position: absolute;
		z-index: 4;
		width: var(--cell-size);
		height: var(--cell-size);
		transform: translate(-50%, -50%);
		opacity: 0.58;
		filter: saturate(0.72);
		pointer-events: none;
	}

	.trace-ghost-compact {
		width: calc(var(--cell-size) * 0.58);
		height: calc(var(--cell-size) * 0.58);
	}

	.trace-ghost-compact :global(.avatar) {
		width: 100%;
		height: 100%;
	}

	.trace-reply-ghost {
		z-index: 4;
	}

	.trace-ghost-profile-trigger {
		position: absolute;
		top: 50%;
		left: 50%;
		display: block;
		width: calc(100% - 8px);
		height: calc(100% - 8px);
		padding: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		pointer-events: auto;
		transform: translate(-50%, -50%);
	}

	.trace-ghost-profile-trigger :global(.avatar) {
		width: 100%;
		height: 100%;
	}

	.trace-ghost-compact .trace-ghost-profile-trigger {
		width: 100%;
		height: 100%;
	}

	.trace-ghost-profile-trigger:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: 2px;
	}

	.trace-ghost-name {
		position: absolute;
		bottom: -2px;
		left: 50%;
		max-width: calc(var(--cell-size) + 8px);
		padding: 1px 5px;
		transform: translateX(-50%);
		overflow: hidden;
		border: 1px dashed rgba(79, 91, 88, 0.48);
		border-radius: 999px;
		background: rgba(247, 247, 239, 0.76);
		color: #596662;
		font-size: 9px;
		font-weight: 700;
		pointer-events: none;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.field-action-menu {
		position: absolute;
		z-index: 8;
		display: grid;
		min-width: 170px;
		padding: 5px;
		border: 1px solid rgba(66, 82, 76, 0.28);
		border-radius: 10px;
		background: rgba(250, 250, 244, 0.97);
		box-shadow: 0 10px 28px rgba(44, 54, 50, 0.24);
		transform: translate(-50%, calc(-100% - 8px));
		pointer-events: auto;
	}

	.field-action-menu button {
		min-height: 38px;
		padding: 7px 10px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: #364541;
		font: inherit;
		font-size: 12px;
		font-weight: 700;
		text-align: left;
		cursor: pointer;
	}

	.field-action-menu button:hover,
	.field-action-menu button:focus-visible {
		background: rgba(122, 164, 148, 0.18);
		outline: none;
	}

	.tail-layer,
	.bubble-layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.tail-layer {
		z-index: 4;
		overflow: visible;
	}

	.tail-outline {
		fill: none;
		stroke: var(--tone-outline);
		stroke-width: 1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.tail {
		fill: var(--tone-background);
	}

	.trace-relation-connector {
		fill: none;
		stroke: rgba(77, 101, 93, 0.64);
		stroke-width: 1.5;
		stroke-dasharray: 3 5;
		stroke-linecap: round;
		pointer-events: none;
	}

	.trace-offscreen-connector {
		stroke-width: 1.75;
	}

	.trace-offscreen-arrowhead {
		fill: rgba(77, 101, 93, 0.78);
	}

	.bubble-layer {
		z-index: 6;
	}

	.bubble {
		position: absolute;
		display: flex;
		background: var(--tone-background);
		align-items: center;
		justify-content: center;
		border: 1px solid var(--tone-outline);
		border-radius: 18px;
		color: #364142;
		font-size: 16px;
		font-weight: 800;
		letter-spacing: 0.02em;
		line-height: 1.35;
		text-align: center;
		will-change: transform;
	}

	.bubble[data-speech-type='shout'] {
		z-index: 3;
	}

	.speech-bubble-special {
		background: transparent;
		border-color: transparent;
		border-radius: 0;
	}

	.speech-bubble-special.bubble-normal::after {
		content: none;
	}

	.bubble-surface {
		position: absolute;
		inset: -1px;
		z-index: 0;
		display: block;
		width: calc(100% + 2px);
		height: calc(100% + 2px);
		overflow: visible;
		pointer-events: none;
	}

	.bubble-surface-fill {
		fill: var(--tone-background);
	}

	.bubble-surface-outline {
		fill: none;
		stroke: var(--tone-outline);
		stroke-width: 1;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.bubble-content {
		position: relative;
		z-index: 1;
		min-width: 0;
		max-width: 100%;
		overflow: hidden;
		white-space: pre-line;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 5;
		line-clamp: 5;
		text-align: left;
	}

	.bubble-ellipsis {
		position: absolute;
		right: 8px;
		bottom: 5px;
		z-index: 2;
		padding-left: 0.5em;
		background: var(--tone-background);
		line-height: 1;
		pointer-events: none;
	}

	.trace-root-bubble,
	.trace-reply-bubble {
		width: fit-content;
		min-width: 72px;
		max-width: min(240px, calc(100% - 32px));
		padding: 12px 15px;
		border-style: dashed;
		background: color-mix(in srgb, var(--tone-background) 91%, transparent);
		pointer-events: none;
	}

	.trace-root-bubble .bubble-content,
	.trace-reply-bubble .bubble-content {
		color: #26312f;
		opacity: 1;
	}

	.trace-reply-count {
		position: absolute;
		top: -8px;
		right: -8px;
		display: grid;
		min-width: 22px;
		height: 22px;
		box-sizing: border-box;
		place-items: center;
		padding: 0 6px;
		border: 1px dashed rgba(69, 85, 80, 0.58);
		border-radius: 999px;
		background: rgba(250, 250, 244, 0.94);
		color: #4e5d58;
		font-size: 10px;
		font-weight: 900;
		line-height: 1;
		pointer-events: none;
	}

	.trace-bubble-surface-fill {
		fill: color-mix(in srgb, var(--tone-background) 91%, transparent);
	}

	.trace-bubble-surface-outline,
	.trace-tail-outline {
		stroke-dasharray: 4 3;
	}

	.trace-tail {
		opacity: 0.9;
	}

	.trace-root-selector {
		position: absolute;
		top: calc(100% + 5px);
		left: 50%;
		z-index: 4;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 5px;
		border: 1px solid rgba(65, 77, 73, 0.22);
		border-radius: 999px;
		background: rgba(250, 250, 244, 0.94);
		box-shadow: 0 4px 12px rgba(44, 54, 50, 0.14);
		color: #53625d;
		font-size: 10px;
		transform: translateX(-50%);
		pointer-events: auto;
	}

	.trace-root-selector button {
		display: grid;
		width: 26px;
		height: 26px;
		place-items: center;
		padding: 0;
		border: 0;
		border-radius: 50%;
		background: transparent;
		color: inherit;
		font-size: 20px;
		line-height: 1;
		cursor: pointer;
	}

	.trace-root-selector button:disabled {
		opacity: 0.32;
		cursor: default;
	}

	.trace-root-selector button:focus-visible {
		outline: 2px solid #6dabb9;
	}

	.trace-reply-status {
		position: absolute;
		top: calc(100% + 42px);
		left: 50%;
		width: max-content;
		max-width: 180px;
		padding: 2px 7px;
		border-radius: 999px;
		background: rgba(250, 250, 244, 0.88);
		color: #68736f;
		font-size: 9px;
		font-weight: 700;
		transform: translateX(-50%);
	}

	.bubble-normal::after {
		content: '';
		position: absolute;
		left: calc(50% + var(--tail-seam-offset-x, 0px));
		bottom: -1px;
		width: 11px;
		height: 3px;
		transform: translateX(-50%);
		background: var(--tone-background);
		pointer-events: none;
		z-index: 1;
	}

	.bubble-normal {
		width: fit-content;
		min-width: 72px;
		max-width: min(240px, calc(100% - 32px));
		padding: 12px 15px;
	}

	.bubble-merged {
		width: fit-content;
		max-width: min(var(--merged-bubble-max-width, 330px), calc(100% - 32px));
		min-width: var(--merged-bubble-min-width, 100px);
		padding: var(--merged-bubble-padding-y, 12px) var(--merged-bubble-padding-x, 16px);
		font-size: var(--merged-bubble-font-size, 13px);
	}

	.bubble-tail-connection {
		position: absolute;
		bottom: -1px;
		width: 9px;
		height: 3px;
		transform: translateX(calc(-50% + var(--tail-seam-offset-x, 0px)));
		background: var(--tone-background);
		pointer-events: none;
		z-index: 1;
	}

	.tone-coral {
		--tone-background: hsl(12, 53%, 96%);
		--tone-outline: hsl(12, 96%, 52%);
	}

	.tone-lavender {
		--tone-background: hsl(250, 53%, 96%);
		--tone-outline: hsl(250, 96%, 52%);
	}

	.tone-mint {
		--tone-background: hsl(145, 43%, 96%);
		--tone-outline: hsl(145, 90%, 42%);
	}

	.tone-yellow {
		--tone-background: hsl(48, 53%, 96%);
		--tone-outline: hsl(48, 96%, 48%);
	}

	.tone-sky {
		--tone-background: hsl(188, 43%, 96%);
		--tone-outline: hsl(188, 99%, 46%);
	}

	.tone-peach {
		--tone-background: hsl(28, 53%, 96%);
		--tone-outline: hsl(28, 96%, 52%);
	}

	.tone-rose {
		--tone-background: hsl(340, 53%, 96%);
		--tone-outline: hsl(340, 96%, 52%);
	}

	.tone-blue {
		--tone-background: hsl(210, 53%, 96%);
		--tone-outline: hsl(210, 96%, 52%);
	}

	.viewport-vignette {
		position: absolute;
		inset: 0;
		z-index: 7;
		pointer-events: none;
		box-shadow: inset 0 0 80px rgba(89, 101, 82, 0.12);
	}

	.camera-chip {
		right: 28px;
		bottom: 28px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 11px;
		border: 1px solid rgba(57, 67, 64, 0.12);
		border-radius: 999px;
		background: rgba(246, 246, 237, 0.7);
		backdrop-filter: blur(8px);
		color: #77807b;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.camera-dot {
		width: 7px;
		height: 7px;
		border: 1px solid #d28165;
		border-radius: 50%;
		background: #f0a488;
	}

	.status-panel {
		bottom: 30px;
		left: 32px;
		display: flex;
		align-items: flex-end;
		gap: 22px;
	}

	.composer-available .status-panel {
		bottom: calc(var(--composer-dock-height) + 30px);
	}

	.panel-kicker {
		color: #76827b;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.status-message {
		margin-top: 6px;
		color: #3f4a47;
		font-size: 14px;
		font-weight: 800;
	}

	.write-status {
		margin: 5px 0 0;
		color: #7d6258;
		font-size: 10px;
		font-weight: 700;
	}

	.sandbox-controls {
		bottom: 76px;
		left: 50%;
		z-index: 11;
		display: flex;
		align-items: center;
		gap: 10px;
		transform: translateX(-50%);
	}

	.world-controls {
		bottom: 76px;
		left: 50%;
		z-index: 11;
		transform: translateX(-50%);
	}

	.composer-available .world-controls {
		bottom: calc(var(--composer-dock-height) + 76px);
	}

	.sandbox-character-picker {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #596662;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
	}

	.sandbox-character-picker select {
		max-width: 205px;
		min-height: 38px;
		padding: 0 9px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.86);
		color: #3f4a47;
		font: inherit;
	}

	.sandbox-reset,
	.sandbox-live-reply,
	.world-entry-retry {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-reset,
	.sandbox-live-reply {
		min-height: 38px;
		padding: 0 11px;
		border-radius: 999px;
		font-size: 10px;
		letter-spacing: 0.04em;
	}

	.sandbox-live-reply:disabled {
		opacity: 0.48;
	}

	.world-entry-retry {
		min-height: 38px;
		padding: 0 14px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
	}

	.sandbox-reset:focus-visible,
	.sandbox-live-reply:focus-visible,
	.world-entry-retry:focus-visible,
	.sandbox-character-picker select:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: 2px;
	}

	.footer-note {
		bottom: 8px;
		left: 50%;
		transform: translateX(-50%);
		color: rgba(91, 102, 96, 0.55);
		font-size: 9px;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.composer-available .footer-note {
		bottom: calc(var(--composer-dock-height) + 8px);
	}

	@media (max-width: 700px) {

		.brand-mark {
			width: 31px;
			height: 31px;
			font-size: 19px;
		}

		.brand-name { font-size: 13px; }
		.brand-subtitle { font-size: 8px; }

		.prototype-badge {
			padding: 7px 9px;
			font-size: 8px;
		}

		.status-panel {
			bottom: 22px;
			left: 16px;
			gap: 14px;
		}

		.status-message { font-size: 12px; }

		.camera-chip {
			right: 16px;
			bottom: 24px;
			font-size: 8px;
		}

		.sandbox-controls {
			bottom: 76px;
			flex-direction: column;
			gap: 7px;
		}

		.world-controls {
			bottom: 76px;
		}

		.sandbox-character-picker {
			width: min(100vw - 32px, 280px);
			justify-content: space-between;
		}

		.sandbox-character-picker select {
			max-width: 210px;
			flex: 1;
		}

		.footer-note {
			display: none;
		}

		.field-label-bottom { display: none; }
	}

	@media (max-width: 420px) {
		.prototype-badge { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.status-panel { max-width: 176px; }
		.status-message { line-height: 1.25; }
	}

</style>
