<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { pushState } from '$app/navigation';
	import { page } from '$app/state';
	import { asset, base } from '$app/paths';
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
		type Bounds,
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
	import FieldParticipant from '$lib/FieldParticipant.svelte';
	import CharacterAvatar from '$lib/CharacterAvatar.svelte';
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
	import { projectPresence, type PresenceProjectionOptions } from '$lib/presenceProjection';
	import { createPresenceState, debugTimeoutParticipant, type PresenceState } from '$lib/presence';
	import { addRecentMessage, createRecentMessageTimeline, type RecentMessageTimeline } from '$lib/recentMessageTimeline';
	import { getVirtualKeyboardBottomInset, getVisualViewportKeyboardInset, type ViewportRect } from '$lib/keyboardInset';
	import type { ParsedTraceReply, ParsedWorldMessage } from '$lib/nostrProtocol';
	import {
		groupTraceRoots,
		isWithinTraceInvestigationRange
	} from '$lib/traceInvestigation';
	import type {
		TraceConversationController,
		TraceConversationState
	} from '$lib/traceConversation';
	import type { DevTraceConversationRuntime } from '$lib/devTraceConversationRuntime';
	import {
		resolveTraceConversationProjection,
		type TraceSpeech
	} from '$lib/traceReplyPresentation';
	import BubbleTailLayer from '$lib/BubbleTailLayer.svelte';
	import SpeechBubble, { type BubbleMeasurement, type LiveBubblePresentation } from '$lib/SpeechBubble.svelte';
	import TracePresentation from '$lib/TracePresentation.svelte';
	import {
		BUBBLE_TONES,
		bubbleToneStyle,
		createPresentationBubbleShape,
		mergedTailStart,
		specialTailExtension,
		tailGeometry,
		tailOutlineOpeningPoints,
		tailStart,
		traceTone,
		type BubbleTone
	} from '$lib/bubblePresentation';
	import {
		isTracePresentationMeasured,
		layoutTraceBubblePresentation
	} from '$lib/traceBubblePresentation';
	const resolveTraceBubbleLayout = (() => {
		let previousLayout: ReturnType<typeof layoutTraceBubblePresentation> = null;
		return (input: Parameters<typeof layoutTraceBubblePresentation>[0]) => {
			if (!input.projection) {
				previousLayout = null;
				return null;
			}
			const next = layoutTraceBubblePresentation({ ...input, previousLayout });
			previousLayout = next;
			return next;
		};
	})();
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
	import { matchesComposerSubmit, type ComposerSubmitEnvelope } from '$lib/hostOwnedComposerContext';
	import {
		acceptedTraceReplyTarget, clearTraceReplyMode, completeTraceReplySubmission,
		createTraceReplyMode, selectTraceReplyTarget, type TraceReplyMode
	} from '$lib/traceReplyMode';
	import { resolveSpeechSubmission } from '$lib/speechSubmission';
	import type { SpeechType } from '$lib/conversation';
	import type { SpeechBubbleShape } from '$lib/speechBubblePath';
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
	const SPEECH_TYPE_ORDER: readonly SpeechType[] = ['normal', 'shout', 'monologue'];
	const SPEECH_TYPE_LABELS: Readonly<Record<SpeechType, string>> = {
		normal: '通常',
		shout: '叫び',
		monologue: 'モノローグ'
	};
	const initialDevWorldSandboxEnabled = import.meta.env.DEV &&
		isDevWorldSandboxEnabled(import.meta.env.DEV, page.url.searchParams);

	type AvatarColor = BubbleTone;
	type Participant = {
		id: string;
		character: Character;
		color: AvatarColor;
	};
	const AVATAR_COLORS: readonly AvatarColor[] = BUBBLE_TONES;

	let presenceState: PresenceState = { field: FIELD, participants: [] };
	let viewportElement: HTMLElement;
	let viewportSize: Size = DEFAULT_VIEWPORT;
	let initialFieldGeometryReady = false;
	let bubbleSizes: Record<string, Size> = {};
	let bubbleOverflowById: Record<string, boolean> = {};
	const mountedBubbleRemeasures = new Map<string, () => void>();
	const mountedTraceReplyRemeasures = new Map<string, () => void>();
	let conversationState: ConversationState = createConversationState();
	let lastPlacedAnchorById: Record<string, WorldPoint> = {};
	let lastVisibilityKey: string | null = null;
	let colorByPubkey: Record<string, AvatarColor> = {};
	let recentMessageTimeline: RecentMessageTimeline = [];
	let effectiveTraceRoots: readonly ParsedWorldMessage[] = [];
	let traceConversationState: TraceConversationState = { kind: 'closed' };
	let traceReplyMode = createTraceReplyMode();
	$: composerDesiredContext = {
		generation: traceReplyMode.generation,
		targetId: traceReplyMode.target?.targetId ?? null,
		clearContentVersion: traceReplyMode.clearContentVersion
	};
	// The measured body remains the source for speech shape and text overflow.
	// Reply wrappers have a separate footprint because their Profile control lives beside it.
	let traceReplyCardFootprints: Record<string, Size> = {};
	let traceConversationController: TraceConversationController | null = null;
	let devTraceConversationRuntime: DevTraceConversationRuntime | null = null;
	let devTraceReplies: readonly ParsedTraceReply[] = [];
	let devTraceReplyFixtureEnabled = false;
	let fieldActionMenu: Readonly<{
		position: { x: number; y: number };
		actions: readonly FieldCellAction[];
	}> | null = null;
	let proximityFeedback: Readonly<{ position: { x: number; y: number } }> | null = null;
	let proximityFeedbackTimer: number | null = null;
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
	$: presenceProjection = getPresenceProjection(presenceState, selectedCharacterId, selfProjectionId, {
		cellSize, fieldAreaBounds, fieldWorldSize
	});
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
	$: selfPresence = presenceState.participants.find((participant) => participant.id === selfProjectionId) ?? null;
	$: selfLogicalPosition = selfPresence?.position ?? null;
	$: selfIsActive = selfPresence?.status === 'active';
	$: traceRootCells = groupTraceRoots(effectiveTraceRoots);
	$: traceLightCells = traceRootCells
		.filter((cell) => traceConversationState.kind !== 'open' || !sameCell(cell.position, traceConversationState.root.position))
		.map((cell) => ({
			...cell,
			occupied: participantViews.some((participant) =>
				participant.position.x === cell.position.x && participant.position.y === cell.position.y
			),
			inInvestigationRange: selfIsActive && selfLogicalPosition !== null &&
				isWithinTraceInvestigationRange(selfLogicalPosition, cell.position)
		}));
	$: traceConversationProjection = resolveTraceConversationProjection(traceConversationState);
	$: traceOnlyCellTriggers = traceRootCells.map((cell) => cell.position).filter((position) =>
		!participantViews.some((participant) => sameCell(participant.position, position)) &&
		traceLightCells.some((cell) => sameCell(cell.position, position))
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
			const shape = createPresentationBubbleShape(bubble.speechType, bubble.id, size, viewportSize.width, bubbleSafeBounds);
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
			const shape = createPresentationBubbleShape(bubble.speechType, bubble.id, size, viewportSize.width, bubbleSafeBounds);
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
	$: liveBubblePresentations = positionedVisibleBubbles.map((bubble): LiveBubblePresentation => {
		if (bubble.kind === 'normal') {
			const tail = tailGeometry(tailStart(bubble.anchor, bubble.size), tailTarget(bubble.speaker), 11, 2, specialTailExtension(bubble.speechType));
			return {
				id: bubble.id,
				kind: 'normal',
				tone: bubble.tone as BubbleTone,
				speechType: bubble.speechType,
				text: bubble.text,
				anchor: bubble.anchor,
				size: bubble.size,
				shape: bubble.shape,
				participantId: bubble.speaker.id,
				tailSeamOffset: tail.seamOffsetX,
			outlineOpenings: bubble.speechType === 'normal' ? [] : [{ id: bubble.speaker.id, points: tailOutlineOpeningPoints(tail, bubble.anchor) }]
			};
		}
		const connections = bubble.members.map((member, index) => {
			const tail = tailGeometry(mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length), tailTarget(member), 9, 2, specialTailExtension(bubble.speechType));
			return { participantId: member.id, seamOffset: tail.seamOffsetX, opening: tailOutlineOpeningPoints(tail, bubble.anchor) };
		});
		return {
			id: bubble.id,
			kind: 'merged',
			tone: bubble.tone as BubbleTone,
			speechType: bubble.speechType,
			text: bubble.text,
			anchor: bubble.anchor,
			size: bubble.size,
			shape: bubble.shape,
			memberCount: bubble.memberPubkeys.length,
			tailSeamOffset: 0,
			mergedTailConnections: connections.map(({ participantId, seamOffset }) => ({ participantId, seamOffset })),
			outlineOpenings: bubble.speechType === 'normal' ? [] : connections.map(({ participantId, opening }) => ({ id: participantId, points: opening }))
		};
	});
	$: normalTailModels = positionedNormalBubbles.map((bubble) => ({
		id: bubble.speaker.id, tone: bubble.tone as BubbleTone, speechType: bubble.speechType,
		anchor: bubble.anchor, size: bubble.size, shape: bubble.shape, target: tailTarget(bubble.speaker)
	}));
	$: mergedTailModels = positionedMergedBubbles.map((bubble) => ({
		id: bubble.id, tone: bubble.tone as BubbleTone, speechType: bubble.speechType,
		anchor: bubble.anchor, size: bubble.size, shape: bubble.shape,
		members: bubble.members.map((member) => ({ id: member.id, target: tailTarget(member) }))
	}));
	$: traceTreeLayout = resolveTraceBubbleLayout({
		projection: traceConversationProjection,
		fixedBubbles: positionedVisibleBubbles,
		bubbleSizes,
		traceReplyCardFootprints,
		bubbleSafeBounds,
		bubbleVisualRegion,
		cellSize,
		camera,
		fieldAreaBounds,
		fieldRows: field.rows,
		viewportWidth: viewportSize.width,
		defaultBubbleSize: DEFAULT_BUBBLE_SIZES.normal,
		characterFor: (pubkey) => traceCharacter(pubkey, devWorldSandboxEnabled, selectedCharacterId),
		toneFor: traceTone
	});
	$: traceBubble = traceTreeLayout?.root ?? null;
	$: tracePresentationReady = isTracePresentationMeasured(initialFieldGeometryReady, traceTreeLayout, bubbleSizes, traceReplyCardFootprints);
	$: traceRootGhost = traceBubble ? (() => {
		const occupied = participantViews.some((participant) => sameCell(participant.position, traceBubble.event.position));
		const offset = occupied ? { x: -cellSize * 0.29, y: cellSize * 0.27 } : { x: 0, y: 0 };
		const center = gridToWorld(traceBubble.event.position, cellSize);
		return { ...traceBubble, world: { x: center.x + offset.x, y: center.y + offset.y }, compact: occupied };
	})() : null;
	$: traceRootTailTarget = traceRootGhost ? (() => {
		const screen = fieldLocalToViewport(worldToScreen(traceRootGhost.world, camera), fieldAreaBounds);
		return { x: screen.x, y: screen.y - cellSize * (traceRootGhost.compact ? 0.29 : 0.5) - 4 };
	})() : null;
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
			if (import.meta.env.DEV && devSearchParams.get('devPresence') === 'inactive') {
				setPresence(debugTimeoutParticipant(presenceState, DEV_WORLD_SELF_ID));
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
						setReplies: setDevTraceReplies,
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
				traceReplyCardFootprints = {};
			}
			viewportSize = { width: rect.width, height: rect.height };
			void tick().then(() => {
				if (!mounted) return;
				remeasureMountedBubbles();
				remeasureMountedTraceReplyCards();
				syncVisualToCanonical();
				// Reveal only with the visual projection of the measured geometry.
				initialFieldGeometryReady = true;
			});
			if (!devWorldSandboxEnabled) void begin();
		};
		type MovementHoldOwner = 'keyboard' | 'pointer';
		let movementHoldOwner: MovementHoldOwner | null = null;
		let movementHoldDirection: Direction | null = null;
		let movementHoldSource: 'page' | 'composer-editor' | null = null;
		const pressedKeyboardMovementKeys = new Set<string>();
		let movementHoldPointerId: number | null = null;
		let holdTimer: number | null = null;
		let keyboardChordTimer: number | null = null;
		const KEYBOARD_CHORD_DELAY_MS = 50;
		const cancelKeyboardChordTimer = () => {
			if (keyboardChordTimer === null) return;
			window.clearTimeout(keyboardChordTimer);
			keyboardChordTimer = null;
		};
		const clearMovementHold = () => {
			movementHoldOwner = null;
			movementHoldDirection = null;
			movementHoldSource = null;
			pressedKeyboardMovementKeys.clear();
			movementHoldPointerId = null;
			cancelKeyboardChordTimer();
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
				if (!movementHoldOwner ||
					(movementHoldOwner === 'keyboard' && movementHoldSource === 'composer-editor' && composerEditorIsEmpty !== true) ||
					document.querySelector('.profile-dialog-content')) {
					clearMovementHold();
					return;
				}
				if (movementHoldDirection) requestMovement(movementHoldDirection);
			}, 500);
		};
		const rephaseMovementTimer = () => {
			if (holdTimer === null) return;
			window.clearInterval(holdTimer);
			startMovementTimer();
		};
		const resolveKeyboardChord = () => {
			cancelKeyboardChordTimer();
			const direction = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
			movementHoldDirection = direction;
			if (direction) requestMovement(direction);
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
			const keyToken = event.code || event.key;
			pressedKeyboardMovementKeys.add(keyToken);
			const nextDirection = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
			if (movementHoldOwner !== 'keyboard') {
				clearMovementHold();
				pressedKeyboardMovementKeys.add(keyToken);
				movementHoldOwner = 'keyboard';
				movementHoldSource = source;
				movementHoldDirection = nextDirection;
				keyboardChordTimer = window.setTimeout(resolveKeyboardChord, KEYBOARD_CHORD_DELAY_MS);
				return;
			}
			if (keyboardChordTimer !== null) {
				if (nextDirection === 'up-right' || nextDirection === 'down-right' ||
					nextDirection === 'down-left' || nextDirection === 'up-left') {
					window.clearTimeout(keyboardChordTimer);
					keyboardChordTimer = null;
					movementHoldDirection = nextDirection;
					requestMovement(nextDirection);
					startMovementTimer();
				} else {
					movementHoldDirection = nextDirection;
				}
				return;
			}
			const previousDirection = movementHoldDirection;
			movementHoldDirection = nextDirection;
			if (nextDirection !== previousDirection) {
				if (!nextDirection) return;
				requestMovement(nextDirection);
				rephaseMovementTimer();
			}
		};
		const handleKeyup = (event: KeyboardEvent) => {
			const keyToken = event.code || event.key;
			if (keyboardChordTimer !== null) resolveKeyboardChord();
			if (!pressedKeyboardMovementKeys.delete(keyToken) || movementHoldOwner !== 'keyboard') return;
			const nextDirection = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
			if (!nextDirection) {
				if (pressedKeyboardMovementKeys.size === 0) clearMovementHold();
				else movementHoldDirection = null;
				return;
			}
			movementHoldDirection = nextDirection;
		};
		const handleMovementFocusIn = (event: FocusEvent) => {
			if (movementHoldOwner === 'keyboard' && !isComposerEditorKeyboardEvent(event)) clearMovementHold();
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
			if (proximityFeedbackTimer !== null) window.clearTimeout(proximityFeedbackTimer);
			proximityFeedbackTimer = null;
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
		for (const measure of mountedBubbleRemeasures.values()) measure();
	}

	function registerBubbleRemeasure(id: string, measure: () => void): () => void {
		mountedBubbleRemeasures.set(id, measure);
		return () => {
			if (mountedBubbleRemeasures.get(id) === measure) mountedBubbleRemeasures.delete(id);
		};
	}

	function removeBubbleMeasurement(id: string): void {
		queueMicrotask(() => {
			if (mountedBubbleRemeasures.has(id) || mountedTraceReplyRemeasures.has(id)) return;
			const next = { ...bubbleOverflowById };
			delete next[id];
			bubbleOverflowById = next;
		});
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
		selfId = selfProjectionId,
		geometry: PresenceProjectionOptions = { cellSize, fieldAreaBounds, fieldWorldSize }
	) {
		return projectPresence(state, participantModels(state, selectedId), geometry, selfId);
	}

	function hasUsableViewport(): boolean {
		return viewportSize.width > 0 && viewportSize.height > 0;
	}

	function setPresence(nextPresence: PresenceState): void {
		const selfId = devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfAccount?.pubkey;
		const previousSelf = presenceState.participants.find((participant) => participant.id === selfId);
		const nextSelf = nextPresence.participants.find((participant) => participant.id === selfId);
		if (traceReplyMode.target && nextSelf &&
			(!previousSelf || !sameCell(previousSelf.position, nextSelf.position)) &&
			!isWithinTraceInvestigationRange(nextSelf.position, traceConversationState.kind === 'open'
				? traceConversationState.root.position : nextSelf.position)) {
			traceReplyMode = clearTraceReplyMode(traceReplyMode, true);
		}
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

	function directionFromKeyboardMovementKeys(keys: Iterable<string>): Direction | null {
		const activeDirections = new Set<Direction>();
		for (const key of keys) {
			const direction = directionFromCode(key) ?? directionFromKey(key);
			if (direction) activeDirections.add(direction);
		}
		const x = activeDirections.has('left') === activeDirections.has('right')
			? 0 : activeDirections.has('right') ? 1 : -1;
		const y = activeDirections.has('up') === activeDirections.has('down')
			? 0 : activeDirections.has('down') ? 1 : -1;
		if (x === 0 && y === 0) return null;
		if (x === 0) return y < 0 ? 'up' : 'down';
		if (y === 0) return x < 0 ? 'left' : 'right';
		if (x > 0 && y < 0) return 'up-right';
		if (x > 0 && y > 0) return 'down-right';
		if (x < 0 && y > 0) return 'down-left';
		return 'up-left';
	}

	function setEffectiveTraceRoots(roots: readonly ParsedWorldMessage[]): void {
		effectiveTraceRoots = roots;
		devTraceConversationRuntime?.reconcileEffectiveRoots(roots);
	}

	function setTraceConversation(next: TraceConversationState): void {
		if (traceReplyMode.target && !acceptedTraceReplyTarget(next, traceReplyMode.target)) {
			traceReplyMode = clearTraceReplyMode(traceReplyMode);
		}
		traceConversationState = next;
	}

	function setDevTraceReplies(replies: readonly ParsedTraceReply[]): void {
		devTraceReplies = replies;
		devTraceConversationRuntime?.reconcileReplies(replies);
	}

	function closeFieldActionMenu(): void {
		fieldActionMenu = null;
	}

	function showTraceProximityFeedback(position: { x: number; y: number }): void {
		proximityFeedback = { position: { ...position } };
		if (proximityFeedbackTimer !== null) window.clearTimeout(proximityFeedbackTimer);
		proximityFeedbackTimer = window.setTimeout(() => {
			proximityFeedback = null;
			proximityFeedbackTimer = null;
		}, 1_000);
	}

	function closeTraceConversation(): void {
		closeFieldActionMenu();
		traceReplyMode = clearTraceReplyMode(traceReplyMode);
		traceConversationController?.closeTraceConversation();
		if (!traceConversationController) setTraceConversation({ kind: 'closed' });
	}

	function actionsForCell(position: { x: number; y: number }, replyMode: TraceReplyMode = traceReplyMode): readonly FieldCellAction[] {
		const participantIds = participantViews
			.filter((participant) => sameCell(participant.position, position))
			.map((participant) => participant.id);
		let trace: Extract<FieldCellAction, { kind: 'trace' }> | null = null;
		const visibleTraceAtCell = traceLightCells.some((cell) => sameCell(cell.position, position));
		const reselectCurrentRoot = traceConversationProjection?.current.kind === 'root' &&
			sameCell(traceConversationProjection.current.event.position, position) && visibleTraceAtCell;
		if (reselectCurrentRoot && !replyMode.target && selfIsActive && selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, position)) {
			trace = { kind: 'trace', rootId: traceConversationProjection!.current.event.id, behavior: 'select-current' };
		} else {
			const rootCell = traceRootCells.find((cell) => sameCell(cell.position, position));
			const currentIsRootCell = traceConversationProjection?.current.kind === 'root' &&
				sameCell(traceConversationProjection.current.event.position, position);
			const root = currentIsRootCell ? undefined : rootCell?.roots[0];
			if (root && (!selfIsActive || (selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, root.position)))) {
				trace = { kind: 'trace', rootId: root.id, behavior: 'open-root' };
			}
		}
		return buildFieldCellActions({
			participantIds,
			trace
		});
	}

	function investigateTraceRoot(rootId: string): void {
		const result = traceConversationController?.openTraceConversation({ rootId, currentId: rootId });
		if (result?.kind === 'opened') activateReplyTarget(rootId, rootId);
	}

	function activateReplyTarget(rootId: string, targetId: string): void {
		const accepted = traceConversationController?.getTraceConversationState();
		const target = accepted && acceptedTraceReplyTarget(accepted, { rootId, targetId });
		if (target) traceReplyMode = selectTraceReplyTarget(traceReplyMode, target);
	}

	function selectTraceSpeech(targetId: string): void {
		const result = traceConversationController?.selectTraceConversationSpeech(targetId);
		const accepted = traceConversationController?.getTraceConversationState();
		if (result?.kind === 'opened' && accepted?.kind === 'open') activateReplyTarget(accepted.root.id, targetId);
	}

	function clearComposerReply(generation: number): void {
		if (generation === traceReplyMode.generation) traceReplyMode = clearTraceReplyMode(traceReplyMode);
	}

	async function loadComposerPreview(targetId: string) {
		const target = traceReplyMode.target;
		if (target?.targetId !== targetId || !worldSession) return null;
		const event = await worldSession.getTracePreviewEvent(target.rootId, targetId);
		if (!event) return null;
		const character = deriveCharacterFromPubkey(event.pubkey, CHARACTER_CATALOG);
		return {
			event,
			profile: {
				displayName: character.name,
				picture: new URL(asset(`/${character.picture}`), window.location.origin).toString()
			}
		};
	}

	function executeFieldCellAction(
		action: FieldCellAction,
		position: { x: number; y: number },
		trigger?: HTMLButtonElement
	): void {
		closeFieldActionMenu();
		if (action.kind === 'trace') {
			if (action.behavior === 'select-current') {
				selectTraceSpeech(action.rootId);
			} else {
				investigateTraceRoot(action.rootId);
			}
			return;
		}
		const participant = participantViews.find((candidate) => candidate.id === action.participantId);
		if (participant && trigger) openProfile(participant.character.characterId, trigger);
	}

	function resolveFieldCellSelection(position: { x: number; y: number }, trigger?: HTMLButtonElement): void {
		const resolution = resolveFieldCellActions(actionsForCell(position));
		if (resolution.kind === 'none') {
			const visibleOutOfRangeTrace = selfIsActive && traceLightCells.some((cell) => sameCell(cell.position, position) && !cell.inInvestigationRange);
			if (visibleOutOfRangeTrace) {
				showTraceProximityFeedback(position);
				return;
			}
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
			captureOwner: HTMLElement;
		}> | null = null;

		const fieldGestureOrigin = (event: PointerEvent): HTMLElement | null => {
			for (const target of event.composedPath()) {
				if (!(target instanceof HTMLElement)) continue;
				if (target.matches('[data-field-gesture-origin="selectable"]')) return target;
				if (target.matches('button, input, textarea, select, [contenteditable="true"], .field-action-menu')) return null;
			}
			return null;
		};
		const releasePointerCapture = (pointerId: number) => {
			if (node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId);
		};
		const cancelGesture = () => {
			const gesture = activeGesture;
			activeGesture = null;
			if (gesture) {
				movementHoldStopPointer(gesture.pointerId);
				try {
					if (gesture.captureOwner.hasPointerCapture(gesture.pointerId)) gesture.captureOwner.releasePointerCapture(gesture.pointerId);
					releasePointerCapture(gesture.pointerId);
				} catch { /* pointer capture may already be lost */ }
			}
			pointerJoystick = null;
		};
		const finishGesture = (event: PointerEvent, selectTap: boolean) => {
			const gesture = activeGesture;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			activeGesture = null;
			try {
				if (gesture.captureOwner.hasPointerCapture(event.pointerId)) gesture.captureOwner.releasePointerCapture(event.pointerId);
				releasePointerCapture(event.pointerId);
			} catch { /* pointer capture may already be lost */ }
			if (gesture.dragging) movementHoldStopPointer(event.pointerId);
			pointerJoystick = null;
			if (selectTap && !gesture.dragging && gesture.captureOwner === node) resolveFieldCellSelection(gesture.anchor);
		};
		const handlePointerDown = (event: PointerEvent) => {
			if (!event.isPrimary || event.button !== 0 || activeGesture) return;
			const origin = fieldGestureOrigin(event);
			if (event.composedPath().some((target) => target instanceof HTMLElement && target.matches('button, input, textarea, select, [contenteditable="true"], .field-action-menu')) && !origin) return;
			const start = { x: event.clientX, y: event.clientY };
			const anchor = viewportPointToLogicalCell({ point: start, fieldArea: fieldAreaBounds, camera, field });
			if (!anchor) return;
			activeGesture = { pointerId: event.pointerId, start, anchor, dragging: false, captureOwner: origin ?? node };
			try { (origin ?? node).setPointerCapture(event.pointerId); } catch { /* synthetic events may not have a capturable pointer */ }
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
				try {
					if (gesture.captureOwner !== node && gesture.captureOwner.hasPointerCapture(event.pointerId)) gesture.captureOwner.releasePointerCapture(event.pointerId);
					node.setPointerCapture(event.pointerId);
				} catch { /* pointer capture may already be lost */ }
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
		node.addEventListener('lostpointercapture', (event) => {
			const gesture = activeGesture;
			if (!gesture || event.target !== node) return;
			finishGesture(event as PointerEvent, false);
		});
		cancelPointerJoystick = cancelGesture;
		return {
			destroy() {
				cancelGesture();
				cancelPointerJoystick = () => {};
			}
		};
	}

	function fieldActionLabel(action: FieldCellAction): string {
		if (action.kind === 'trace') return '痕跡を調べる';
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
		envelope: ComposerSubmitEnvelope,
		options: Readonly<{ signal: AbortSignal; shortcutId?: string }>
	): Promise<Readonly<{ eventId: string }>> {
		const desired = () => ({ generation: traceReplyMode.generation, targetId: traceReplyMode.target?.targetId ?? null,
			clearContentVersion: traceReplyMode.clearContentVersion });
		if (!matchesComposerSubmit(envelope, desired())) throw new Error('Composer reply context is not synchronized.');
		const target = traceReplyMode.target;
		const submission = resolveSpeechSubmission({
			content: envelope.output.content,
			shortcutId: options.shortcutId,
			selectedSpeechType
		});
		composerSubmissionInProgress = true;
		try {
			if (!devWorldSandboxEnabled) await waitForMessageReady(options.signal);
			if (options.signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
			if (!matchesComposerSubmit(envelope, desired())) throw new Error('Composer reply target changed before publication.');
			const result = target
				? await (devWorldSandboxEnabled ? devTraceConversationRuntime : worldSession)?.publishTraceReply({
					rootId: target.rootId, targetId: target.targetId, ...submission
				})
				: !devWorldSandboxEnabled ? await worldSession?.publishMessage(submission.content, submission.speechType) : undefined;
			if (result?.kind === 'succeeded') {
				selectedSpeechType = 'normal';
				traceReplyMode = completeTraceReplySubmission(traceReplyMode, envelope.generation);
				return { eventId: result.eventId };
			}
			if (result?.kind === 'out-of-range' && traceReplyMode.generation === envelope.generation) {
				traceReplyMode = clearTraceReplyMode(traceReplyMode, true);
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
		const activePubkeys = ['0', '1', '2', 'a', 'b', 'c', 'd', 'e'].map((prefix) => prefix.repeat(64));
		const activePubkey = activePubkeys[0];
		const outsidePubkey = 'f'.repeat(64);
		setPresence(createPresenceState(FIELD, Date.now(), [
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

	function tailTarget(participant: (typeof participantViews)[number]): WorldPoint {
		return {
			x: participant.screen.x,
			y: fieldAreaBounds.y + participant.world.y - cellSize / 2 - camera.y - 4
		};
	}

	function remeasureMountedTraceReplyCards(): void {
		for (const measure of mountedTraceReplyRemeasures.values()) measure();
	}

	function registerTraceReplyRemeasure(id: string, measure: () => void): () => void {
		mountedTraceReplyRemeasures.set(id, measure);
		return () => {
			if (mountedTraceReplyRemeasures.get(id) === measure) mountedTraceReplyRemeasures.delete(id);
		};
	}

	function applyTraceReplyFootprint(id: string, footprint: Size): void {
		const current = traceReplyCardFootprints[id];
		if (!current || current.width !== footprint.width || current.height !== footprint.height) {
			traceReplyCardFootprints = { ...traceReplyCardFootprints, [id]: footprint };
		}

	}

	function removeTraceReplyFootprint(id: string): void {
		queueMicrotask(() => {
			if (mountedTraceReplyRemeasures.has(id)) return;
			const next = { ...traceReplyCardFootprints };
			delete next[id];
			traceReplyCardFootprints = next;
		});
	}

	function traceCharacter(pubkey: string, isDevWorldSandbox: boolean, currentCharacterId: string): Character {
		return isDevWorldSandbox && pubkey === DEV_WORLD_SELF_ID
			? getDevWorldCharacter(currentCharacterId) : deriveCharacterFromPubkey(pubkey, CHARACTER_CATALOG);
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
	class:composer-available={runtimeMode === 'relay' || devTraceReplyFixtureEnabled}
	class:composer-keyboard-visible={composerKeyboardInset > 0}
	data-trace-runtime={traceConversationController ? runtimeMode : undefined}
	style={`--composer-keyboard-inset: ${composerKeyboardInset}px;--composer-initial-preferred-height: ${INITIAL_COMPOSER_PREFERRED_HEIGHT}px;${composerPreferredHeight === null ? '' : `--composer-preferred-height: ${composerPreferredHeight}px;`}`}
>
	<section
		class="field-viewport"
		class:initial-field-geometry-ready={initialFieldGeometryReady}
		bind:this={viewportElement}
		aria-label="Conversation field"
	>
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
						{#if cell.inInvestigationRange}
							<span
								class="trace-investigation-indicator"
								data-trace-indicator-position={`${cell.position.x},${cell.position.y}`}
								aria-hidden="true"
								style={`left: ${world.x + cellSize * 0.18}px; top: ${world.y - cellSize * 0.18}px;`}
							>⌕</span>
						{/if}
					{/each}
				</div>
				{#if proximityFeedback}
					<div
						class="trace-proximity-feedback"
						role="status"
						aria-live="polite"
						style={`left: ${(proximityFeedback.position.x + 0.5) * cellSize}px; top: ${(proximityFeedback.position.y + 0.18) * cellSize}px;`}
					>近づくと調べられる</div>
				{/if}
				<div class="field-cell-selection-layer" aria-label="Trace investigation cells">
					{#each traceOnlyCellTriggers as position (`${position.x},${position.y}`)}
						<button
							class="field-cell-selection-trigger"
							data-field-gesture-origin="selectable"
							type="button"
							on:dragstart|preventDefault
							data-cell-position={`${position.x},${position.y}`}
				aria-label={!selfIsActive || (selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, position))
					? '痕跡を調べる'
					: '痕跡を調べる（近づくと調べられる）'}
							style={`left: ${position.x * cellSize}px; top: ${position.y * cellSize}px;`}
							on:click={(event) => {
								event.stopPropagation();
								resolveFieldCellSelection(position, event.currentTarget as HTMLButtonElement);
							}}
						></button>
					{/each}
				</div>
				{#each participantViews as participant (participant.id)}
					<FieldParticipant
						id={participant.id}
						character={participant.character}
						color={participant.color}
						self={participant.id === selfProjectionId}
						position={participant.position}
						world={participant.world}
						movementAnimation={movingParticipantIds.has(participant.id)}
						onProfile={resolveFieldCellSelection}
					/>
				{/each}
				{#if traceRootGhost}
					<div
						class:trace-ghost-compact={traceRootGhost.compact}
						class="trace-ghost"
						data-trace-ghost-root-id={traceRootGhost.event.id}
						style={`left: ${traceRootGhost.world.x}px; top: ${traceRootGhost.world.y}px;`}
					>
						<button
							class="trace-ghost-profile-trigger"
							data-field-gesture-origin="selectable"
							type="button"
							on:dragstart|preventDefault
							aria-label={`${traceRootGhost.character.name} のプロフィールを開く`}
							on:click={(event) => {
								event.stopPropagation();
								openProfile(traceRootGhost.character.characterId, event.currentTarget);
							}}
						>
							<CharacterAvatar class={`avatar avatar-${traceRootGhost.tone}`} character={traceRootGhost.character} />
							<span class="trace-ghost-name" aria-hidden="true">{traceRootGhost.character.name}</span>
						</button>
					</div>
				{/if}
				{#if fieldActionMenu}
					<div
						class="field-action-menu"
						role="menu"
						tabindex="-1"
						aria-label="Cell actions"
						style={`left: ${(fieldActionMenu.position.x + 0.5) * cellSize}px; top: ${(fieldActionMenu.position.y + 0.5) * cellSize}px;`}
					>
					{#each fieldActionMenu.actions as action, index (`${action.kind}-${action.kind === 'participant' ? action.participantId : action.rootId}-${index}`)}
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

		<BubbleTailLayer
			{viewportSize}
			traceReady={tracePresentationReady}
			traceLayout={traceTreeLayout}
			{traceRootTailTarget}
			normalTails={normalTailModels}
			mergedTails={mergedTailModels}
		/>

		<div class="bubble-layer" aria-live="polite">
			{#each liveBubblePresentations as bubble (bubble.id)}
				<SpeechBubble
					{bubble}
					overflow={bubbleOverflowById[bubble.id] ?? false}
					onMeasurement={applyBubbleMeasurement}
					onMeasurementRemoved={removeBubbleMeasurement}
					registerRemeasure={registerBubbleRemeasure}
				/>
			{/each}
			<TracePresentation
				layout={traceTreeLayout}
				ready={tracePresentationReady}
				currentSpeechId={traceConversationProjection?.current.event.id ?? null}
				replyRefresh={traceConversationState.kind === 'open' ? traceConversationState.replyRefresh : null}
				{traceRootTailTarget}
				{bubbleOverflowById}
				onSelectSpeech={selectTraceSpeech}
				onOpenProfile={openProfile}
				onBubbleMeasurement={applyBubbleMeasurement}
				onBubbleMeasurementRemoved={removeBubbleMeasurement}
				registerBubbleRemeasure={registerBubbleRemeasure}
				onReplyFootprint={applyTraceReplyFootprint}
				onReplyFootprintRemoved={removeTraceReplyFootprint}
				registerReplyRemeasure={registerTraceReplyRemeasure}
			/>
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

	{#if runtimeMode === 'relay' || devTraceReplyFixtureEnabled}
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
						desiredContext={composerDesiredContext}
						loadPreview={loadComposerPreview}
						onPreviewClear={clearComposerReply}
						onEditorEmptyChange={handleComposerEditorEmptyChange}
						onPreferredHeightChange={setComposerPreferredHeight}
					/>
				</div>
			</div>
		</div>
	{/if}

</main>

<style>
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
		--composer-reserved-height: calc(
			var(--composer-initial-preferred-height)
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

	.field-viewport {
		position: relative;
		min-height: 100svh;
		flex: 1;
		overflow: hidden;
		isolation: isolate;
		background: transparent;
	}

	.field-viewport:not(.initial-field-geometry-ready) .field-scene {
		visibility: hidden;
	}

	.composer-available .field-viewport {
		min-height: 0;
	}

	.composer-available {
		padding-bottom: var(--composer-reserved-height);
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
		outline: 3px solid var(--color-focus-ring);
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

	.timeline-name.tone-coral { color: color-mix(in srgb, hsl(12, 96%, 42%) 70%, white 30%); }
	.timeline-name.tone-lavender { color: color-mix(in srgb, hsl(250, 72%, 42%) 70%, white 30%); }
	.timeline-name.tone-mint { color: color-mix(in srgb, hsl(145, 68%, 31%) 70%, white 30%); }
	.timeline-name.tone-yellow { color: color-mix(in srgb, hsl(48, 82%, 34%) 70%, white 30%); }
	.timeline-name.tone-sky { color: color-mix(in srgb, hsl(188, 72%, 32%) 70%, white 30%); }
	.timeline-name.tone-peach { color: color-mix(in srgb, hsl(28, 82%, 38%) 70%, white 30%); }
	.timeline-name.tone-rose { color: color-mix(in srgb, hsl(340, 72%, 40%) 70%, white 30%); }
	.timeline-name.tone-blue { color: color-mix(in srgb, hsl(210, 72%, 37%) 70%, white 30%); }

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
		outline: 3px solid var(--color-focus-ring);
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
		pointer-events: none;
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

	.trace-investigation-indicator {
		position: absolute;
		width: max(12px, calc(var(--cell-size) * 0.24));
		height: max(12px, calc(var(--cell-size) * 0.24));
		color: rgba(255, 250, 205, 0.92);
		font-size: max(12px, calc(var(--cell-size) * 0.24));
		font-weight: 900;
		line-height: 1;
		text-align: center;
		text-shadow: 0 0 4px rgba(84, 67, 26, 0.55);
		transform: translate(-50%, -50%);
		pointer-events: none;
	}

	.trace-proximity-feedback {
		position: absolute;
		z-index: 5;
		width: max-content;
		max-width: 150px;
		padding: 3px 8px;
		border: 1px solid rgba(255, 250, 205, 0.72);
		border-radius: 999px;
		background: rgba(52, 64, 54, 0.82);
		color: #fffbdc;
		font-size: 11px;
		font-weight: 800;
		line-height: 1.2;
		transform: translate(-50%, -100%);
		pointer-events: none;
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
		outline: 3px solid var(--color-focus-ring);
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
		outline: 3px solid var(--color-focus-ring);
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

	.composer-available .world-controls,
	.composer-available .sandbox-controls {
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
		outline: 3px solid var(--color-focus-ring);
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
