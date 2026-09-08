<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
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
	import { allocateParticipantColors, projectFrontendPresence, type Participant } from '$lib/frontend/presencePresentation';
	import { advanceMergedAnchorHistory } from '$lib/frontend/mergedAnchorHistory';
	import { debugTimeoutParticipant, type PresenceState } from '$lib/presence';
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
	import { type BubbleMeasurement, type LiveBubblePresentation } from '$lib/SpeechBubble.svelte';
	import {
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
	import ComposerDock from '$lib/frontend/ComposerDock.svelte';
	import Chatter from '$lib/frontend/Chatter.svelte';
	import WorldEntryControls from '$lib/frontend/WorldEntryControls.svelte';
	import DevWorldControls from '$lib/dev/DevWorldControls.svelte';
	import { applyDevPageFixtures, createDevTraceLiveReply } from '$lib/dev/devPageFixtures';
	import FieldViewport from '$lib/frontend/FieldViewport.svelte';
	import FieldScene, {
		type FieldActionMenu,
		type FieldParticipantView,
		type PointerJoystick,
		type TraceLightCell,
		type TraceRootGhost
	} from '$lib/frontend/FieldScene.svelte';
	import SpeechLayer from '$lib/frontend/SpeechLayer.svelte';
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
	const initialDevWorldSandboxEnabled = import.meta.env.DEV &&
		isDevWorldSandboxEnabled(import.meta.env.DEV, page.url.searchParams);

	let presenceState = $state.raw<PresenceState>({ field: FIELD, participants: [] });
	let viewportElement = $state<HTMLElement>();
	let viewportSize = $state.raw<Size>(DEFAULT_VIEWPORT);
	let initialFieldGeometryReady = $state(false);
	let bubbleSizes = $state.raw<Record<string, Size>>({});
	let bubbleOverflowById = $state.raw<Record<string, boolean>>({});
	const mountedBubbleRemeasures = new Map<string, () => void>();
	const mountedTraceReplyRemeasures = new Map<string, () => void>();
	let conversationState = $state.raw<ConversationState>(createConversationState());
	let lastPlacedAnchorById = $state.raw<Readonly<Record<string, WorldPoint>>>({});
	let lastVisibilityKey: string | null = null;
	let colorByPubkey = $state.raw<Record<string, BubbleTone>>({});
	let recentMessageTimeline = $state.raw<RecentMessageTimeline>([]);
	let effectiveTraceRoots = $state.raw<readonly ParsedWorldMessage[]>([]);
	let traceConversationState = $state.raw<TraceConversationState>({ kind: 'closed' });
	let traceReplyMode = $state.raw(createTraceReplyMode());
	let composerDesiredContext = $derived({
		generation: traceReplyMode.generation,
		targetId: traceReplyMode.target?.targetId ?? null,
		clearContentVersion: traceReplyMode.clearContentVersion
	});
	// The measured body remains the source for speech shape and text overflow.
	// Reply wrappers have a separate footprint because their Profile control lives beside it.
	let traceReplyCardFootprints = $state.raw<Record<string, Size>>({});
	let traceConversationController = $state.raw<TraceConversationController | null>(null);
	let devTraceConversationRuntime: DevTraceConversationRuntime | null = null;
	let devTraceReplies = $state.raw<readonly ParsedTraceReply[]>([]);
	let devTraceReplyFixtureEnabled = $state(false);
	let fieldActionMenu = $state.raw<FieldActionMenu | null>(null);
	let proximityFeedback = $state.raw<Readonly<{ position: { x: number; y: number } }> | null>(null);
	let proximityFeedbackTimer: number | null = null;
	let connectionStatus: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let selfAccount = $state.raw<AccountSnapshot | null>(null);
	let selfPositionWriteState = $state.raw<SelfPositionWriteState>({ kind: 'unavailable' });
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let composerPreferredHeight = $state<number | null>(null);
	let composerKeyboardInset = $state(0);
	let worldSession: ReturnType<typeof createWorldReadSession> | null = null;
	const runtimeMode: 'relay' | 'dev' = initialDevWorldSandboxEnabled ? 'dev' : 'relay';
	const devWorldSandboxEnabled = initialDevWorldSandboxEnabled;
	let composerAvailable = $derived(runtimeMode === 'relay' || devTraceReplyFixtureEnabled);
	let pendingComposerSubmission: Readonly<{
		resolve: () => void;
		reject: (error: Error) => void;
		cleanup: () => void;
	}> | null = null;
	let composerStartupError: Error | null = null;
	let composerSubmissionInProgress = $state(false);
	let entryRetryable = false;
	let selectedCharacterId = $state('001');
	let selectedSpeechType = $state<SpeechType>('normal');
	let lastProfileTrigger: HTMLButtonElement | null = null;
	let composerEditorIsEmpty: boolean | null = null;
	let chatterComponent: { initialize(width: number): void; isInitialized(): boolean; toggle(): void; resetMeasurements(): void };
	let composerComponent = $state.raw<{ focusEditor(): boolean; blurEditor(): boolean } | null>(null);
	let visualWorldById = $state.raw<Record<string, WorldPoint>>({});
	let visualCamera = $state.raw<WorldPoint | null>(null);
	let visualMotion = $state.raw<VisualMotion | null>(null);
	let visualAnimationFrame: number | null = null;
	let visualProjectionInitialized = false;
	let prefersReducedMotion = false;
	let stopMovementHold = () => {};
	let cancelPointerJoystick = () => {};
	let movementHoldTakeover = (_pointerId: number, _direction: Direction) => {};
	let movementHoldUpdatePointer = (_pointerId: number, _direction: Direction) => {};
	let movementHoldStopPointer = (_pointerId: number) => {};
	let pointerJoystick = $state.raw<PointerJoystick | null>(null);

	type VisualParticipantTransition = Readonly<{ from: WorldPoint; to: WorldPoint }>;
	type VisualMotion = Readonly<{
		startedAt: number;
		fromCamera: WorldPoint;
		toCamera: WorldPoint;
		participants: ReadonlyMap<string, VisualParticipantTransition>;
	}>;

	let cellSize = $derived(getResponsiveCellSize(viewportSize.width));
	let field = $derived({ ...FIELD, cellSize });
	let fieldWorldSize = $derived(getFieldWorldSize(field));
	let speechAreaBounds = $derived({
		x: SPEECH_AREA.sidePadding,
		y: SPEECH_AREA.top,
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: SPEECH_AREA.height
	});
	let fieldAreaBounds = $derived(getFieldAreaBounds(viewportSize, speechAreaBounds));
	let selfProjectionId = $derived(devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfAccount?.pubkey ?? 'you');
	let presenceProjection = $derived(projectFrontendPresence({ presence: presenceState, selectedCharacterId, selfProjectionId,
		geometry: { cellSize, fieldAreaBounds, fieldWorldSize }, colors: colorByPubkey }));
	let isWorldSelfActive = $derived(Boolean(selfAccount && presenceState.participants.some((participant) =>
		participant.id === selfAccount?.pubkey && participant.status === 'active'
	)));
	let camera = $derived(visualCamera ?? presenceProjection.camera);
	let actualFieldTop = $derived(getActualFieldTop(fieldAreaBounds, camera));
	let speechAreaVisualBounds = $derived({
		x: 0,
		y: 0,
		width: viewportSize.width,
		height: actualFieldTop
	});
	let bubbleSafeBounds = $derived({
		x: SPEECH_AREA.sidePadding,
		y: SPEECH_AREA.top,
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: Math.max(0, actualFieldTop - SPEECH_AREA.top)
	});
	let bubbleVisualRegion = $derived({
		x: 0,
		y: bubbleSafeBounds.y,
		width: viewportSize.width,
		height: Math.max(bubbleSafeBounds.height, ...Object.values(bubbleSizes).map((size) => size.height))
	});

	let participantViews: FieldParticipantView[] = $derived(presenceProjection.participants.map((participant) => {
		const world = visualWorldById[participant.id] ?? participant.world;
		return {
			...participant,
			world,
			screen: fieldLocalToViewport(worldToScreen(world, camera), fieldAreaBounds)
		};
	}));

	let participantById = $derived(new Map(participantViews.map((participant) => [participant.id, participant])));
	let selfPresence = $derived(presenceState.participants.find((participant) => participant.id === selfProjectionId) ?? null);
	let selfLogicalPosition = $derived(selfPresence?.position ?? null);
	let selfIsActive = $derived(selfPresence?.status === 'active');
	let traceRootCells = $derived(groupTraceRoots(effectiveTraceRoots));
	let traceLightCells: readonly TraceLightCell[] = $derived(traceRootCells
		.filter((cell) => traceConversationState.kind !== 'open' || !sameCell(cell.position, traceConversationState.root.position))
		.map((cell) => ({
			...cell,
			occupied: participantViews.some((participant) =>
				participant.position.x === cell.position.x && participant.position.y === cell.position.y
			),
			inInvestigationRange: selfIsActive && selfLogicalPosition !== null &&
				isWithinTraceInvestigationRange(selfLogicalPosition, cell.position)
		})));
	let traceConversationProjection = $derived(resolveTraceConversationProjection(traceConversationState));
	let traceOnlyCellTriggers = $derived(traceRootCells.map((cell) => cell.position).filter((position) =>
		!participantViews.some((participant) => sameCell(participant.position, position)) &&
		traceLightCells.some((cell) => sameCell(cell.position, position))
	));

	let visibleParticipantIds = $derived(new Set(
		participantViews.filter((participant) => isInsideFieldArea(participant.screen)).map((participant) => participant.id)
	));
	let visibleParticipantKey = $derived([...visibleParticipantIds].sort().join('|'));
	$effect(() => {
		const key = visibleParticipantKey;
		const ids = visibleParticipantIds;
		// Only visual visibility changes trigger permanent dismissal, not conversation updates.
		untrack(() => syncVisibility(key, ids));
	});

	let visibleNormalBubbles = $derived(conversationState.normalBubbles
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
		.filter((bubble): bubble is NonNullable<typeof bubble> => bubble !== null));

	let visibleMergedBubbles = $derived(conversationState.mergedBubbles
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
		.filter((bubble): bubble is NonNullable<typeof bubble> => bubble !== null));

	let placeableBubbles = $derived([
		...visibleNormalBubbles,
		...visibleMergedBubbles.filter((bubble) => bubble.members.length > 0)
	]);
	let bubblePlacement = $derived(placeBubbles(
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
	));
	let placedAnchorById = $derived(new Map(bubblePlacement.map((placement) => [placement.id, placement.anchor])));
	$effect(() => {
		const activeIds = new Set(conversationState.mergedBubbles.map((bubble) => bubble.id));
		const anchors = new Map<string, WorldPoint>();
		for (const bubble of visibleMergedBubbles) {
			const anchor = placedAnchorById.get(bubble.id);
			if (bubble.members.length > 0 && anchor) anchors.set(bubble.id, anchor);
		}
		untrack(() => {
			const next = advanceMergedAnchorHistory(lastPlacedAnchorById, activeIds, anchors);
			if (next !== lastPlacedAnchorById) lastPlacedAnchorById = next;
		});
	});
	let positionedNormalBubbles = $derived(visibleNormalBubbles.map((bubble) => ({
		...bubble,
		anchor: placedAnchorById.get(bubble.id) ?? bubble.anchor
	})));
	let positionedMergedBubbles = $derived(visibleMergedBubbles.map((bubble) => ({
		...bubble,
		anchor: bubble.members.length === 0 ? bubble.anchor : placedAnchorById.get(bubble.id) ?? bubble.anchor
	})));
	let positionedVisibleBubbles = $derived([...positionedNormalBubbles, ...positionedMergedBubbles]);
	let liveBubblePresentations = $derived(positionedVisibleBubbles.map((bubble): LiveBubblePresentation => {
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
	}));
	let normalTailModels = $derived(positionedNormalBubbles.map((bubble) => ({
		id: bubble.speaker.id, tone: bubble.tone as BubbleTone, speechType: bubble.speechType,
		anchor: bubble.anchor, size: bubble.size, shape: bubble.shape, target: tailTarget(bubble.speaker)
	})));
	let mergedTailModels = $derived(positionedMergedBubbles.map((bubble) => ({
		id: bubble.id, tone: bubble.tone as BubbleTone, speechType: bubble.speechType,
		anchor: bubble.anchor, size: bubble.size, shape: bubble.shape,
		members: bubble.members.map((member) => ({ id: member.id, target: tailTarget(member) }))
	})));
	let traceTreeLayout = $state.raw<ReturnType<typeof layoutTraceBubblePresentation>>(null);
	$effect.pre(() => {
		const isDev = devWorldSandboxEnabled;
		const selectedId = selectedCharacterId;
		const input = {
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
			characterFor: (pubkey: string) => traceCharacter(pubkey, isDev, selectedId),
			toneFor: traceTone
		};
		// Preserve continuity before rendering, without tracking the previous layout itself.
		untrack(() => {
			traceTreeLayout = input.projection
				? layoutTraceBubblePresentation({ ...input, previousLayout: traceTreeLayout })
				: null;
		});
	});
	let traceBubble = $derived(traceTreeLayout?.root ?? null);
	let tracePresentationReady = $derived(isTracePresentationMeasured(initialFieldGeometryReady, traceTreeLayout, bubbleSizes, traceReplyCardFootprints));
	let traceRootGhost: TraceRootGhost | null = $derived(traceBubble ? (() => {
		const occupied = participantViews.some((participant) => sameCell(participant.position, traceBubble.event.position));
		const offset = occupied ? { x: -cellSize * 0.29, y: cellSize * 0.27 } : { x: 0, y: 0 };
		const center = gridToWorld(traceBubble.event.position, cellSize);
		return { ...traceBubble, world: { x: center.x + offset.x, y: center.y + offset.y }, compact: occupied };
	})() : null);
	let traceRootTailTarget = $derived(traceRootGhost ? (() => {
		const screen = fieldLocalToViewport(worldToScreen(traceRootGhost.world, camera), fieldAreaBounds);
		return { x: screen.x, y: screen.y - cellSize * (traceRootGhost.compact ? 0.29 : 0.5) - 4 };
	})() : null);
	let movingParticipantIds = $derived(visualMotion ? new Set(visualMotion.participants.keys()) : new Set<string>());

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

	function sampleVisualAnimation(now = performance.now(), canonical = presenceProjection): void {
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
			visualWorldById = Object.fromEntries(canonical.participants.map((participant) => [participant.id, participant.world]));
			visualCamera = canonical.camera;
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

	function animatePresenceTransition(previous: ReturnType<typeof projectFrontendPresence>, next: ReturnType<typeof projectFrontendPresence>, selfId: string): void {
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
		// Finish the old motion against its own canonical snapshot before retargeting.
		sampleVisualAnimation(now, previous);
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
		const previousSelf = previousById.get(selfId);
		const nextSelf = next.participants.find((participant) => participant.id === selfId);
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
		sampleVisualAnimation(now, next);
		scheduleVisualAnimation();
	}

	onMount(() => {
		let mounted = true;
		let startRequested = false;
		let session: ReturnType<typeof createWorldReadSession> | null = null;
		chatterComponent.initialize(window.innerWidth);
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
			if (import.meta.env.DEV) {
				applyDevPageFixtures(devSearchParams, {
					field: FIELD,
					setPresence: acceptPresence,
					getConversation: () => conversationState,
					setConversation: (next) => { conversationState = next; },
					setRecentMessageTimeline: (next) => { recentMessageTimeline = next; },
					setEffectiveTraceRoots,
					setDevTraceReplies,
					enableTraceReplyFixture: () => { devTraceReplyFixtureEnabled = true; }
				});
			}
			if (import.meta.env.DEV && devSearchParams.get('devPresence') === 'inactive') {
				acceptPresence(debugTimeoutParticipant(presenceState, DEV_WORLD_SELF_ID));
			}
			if (import.meta.env.DEV) {
				void import('$lib/devTraceConversationRuntime').then(({ createDevTraceConversationRuntime }) => {
					if (!mounted || !devWorldSandboxEnabled) return;
					const runtime = createDevTraceConversationRuntime({
						selfId: DEV_WORLD_SELF_ID,
						getPresence: () => presenceState,
						setPresence: acceptPresence,
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
				onPresenceChanged: acceptPresence,
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
				chatterComponent.isInitialized() &&
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
				chatterComponent.toggle();
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
		observer.observe(viewportElement!);
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
				conversationState = applyVisibility(conversationState, projectFrontendPresence({ presence: nextPresence, selectedCharacterId, selfProjectionId,
			geometry: { cellSize, fieldAreaBounds, fieldWorldSize }, colors: colorByPubkey }).visibleParticipantIds);
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

	function hasUsableViewport(): boolean {
		return viewportSize.width > 0 && viewportSize.height > 0;
	}

	function acceptPresence(nextPresence: PresenceState): void {
		const previousPresence = presenceState;
		const previousColors = colorByPubkey;
		const selectedId = selectedCharacterId;
		const projectionId = selfProjectionId;
		const geometry = { cellSize, fieldAreaBounds, fieldWorldSize };
		const selfId = devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfAccount?.pubkey;
		const previousSelf = previousPresence.participants.find((participant) => participant.id === selfId);
		const nextSelf = nextPresence.participants.find((participant) => participant.id === selfId);
		const traceRangeExited = traceConversationState.kind === 'open' && nextSelf &&
			(!previousSelf || !sameCell(previousSelf.position, nextSelf.position)) &&
			!isWithinTraceInvestigationRange(nextSelf.position, traceConversationState.root.position);
		if (traceRangeExited) closeTraceConversation(Boolean(traceReplyMode.target));
		const previousProjection = projectFrontendPresence({ presence: previousPresence,
			selectedCharacterId: selectedId, selfProjectionId: projectionId, geometry, colors: previousColors });
		const nextColors = allocateParticipantColors(previousColors, nextPresence.participants
			.filter((participant) => participant.status === 'active').map((participant) => participant.id));
		colorByPubkey = nextColors;
		presenceState = nextPresence;
		const nextProjection = projectFrontendPresence({ presence: nextPresence,
			selectedCharacterId: selectedId, selfProjectionId: projectionId, geometry, colors: nextColors });
		animatePresenceTransition(previousProjection, nextProjection, projectionId);
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

	function closeTraceConversation(discardReplyDraft = false): void {
		closeFieldActionMenu();
		traceReplyMode = clearTraceReplyMode(traceReplyMode, discardReplyDraft);
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
		if (result.moved) acceptPresence(result.state);
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
		chatterComponent.resetMeasurements();
		lastPlacedAnchorById = {};
		lastVisibilityKey = null;
		colorByPubkey = {};
		acceptPresence(resetDevWorldPresence(FIELD, Date.now()));
	}

	function traceLightWorldPosition(position: { x: number; y: number }, occupied: boolean): WorldPoint {
		const edgeOffset = occupied ? cellSize * 0.28 : 0;
		return {
			x: (position.x + 0.5) * cellSize + edgeOffset,
			y: (position.y + 0.5) * cellSize - edgeOffset
		};
	}

	function injectDevTraceLiveReply(): void {
		if (!devTraceReplyFixtureEnabled || devTraceReplies.some((reply) => reply.id === 'c'.repeat(64))) return;
		setDevTraceReplies([...devTraceReplies, createDevTraceLiveReply(Date.now())]);
	}

	function openProfile(characterId: string, trigger: HTMLButtonElement): void {
		lastProfileTrigger = trigger;
		pushState('', { ...page.state, profileCharacterId: characterId });
	}


	function receiveTimelineMessage(message: ParsedWorldMessage): void {
		recentMessageTimeline = addRecentMessage(recentMessageTimeline, message);
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
		const entryVisible = projectFrontendPresence({ presence: bootstrapPresence, selectedCharacterId, selfProjectionId,
			geometry: { cellSize, fieldAreaBounds, fieldWorldSize }, colors: colorByPubkey }).visibleParticipantIds;
		conversationState = replayBootstrapConversation(messages, entryVisible, entryNowMs);
		conversationState = applyVisibility(conversationState, entryVisible);
	}

	function receiveLiveMessage(message: ParsedWorldMessage, nextPresence: PresenceState): void {
		const nowMs = Date.now();
		if (naturalExpiresAt(message) <= nowMs) return;
		const conversationMessage = toConversationMessage(message);
		const visibleParticipantIds = projectFrontendPresence({ presence: nextPresence, selectedCharacterId, selfProjectionId,
			geometry: { cellSize, fieldAreaBounds, fieldWorldSize }, colors: colorByPubkey }).visibleParticipantIds;
		conversationState = receiveMessage(conversationState, conversationMessage, {
			isSpeakerVisible: visibleParticipantIds.has(message.pubkey),
			duration: getPrototypeDisplayDuration(message.content),
			now: conversationMessage.createdAt
		});
		conversationState = applyVisibility(conversationState, visibleParticipantIds);
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
	class={['app-shell', { 'composer-available': composerAvailable,
		'composer-keyboard-visible': composerKeyboardInset > 0 }]}
	data-trace-runtime={traceConversationController ? runtimeMode : undefined}
	style={`--composer-keyboard-inset: ${composerKeyboardInset}px;--composer-initial-preferred-height: ${INITIAL_COMPOSER_PREFERRED_HEIGHT}px;${composerPreferredHeight === null ? '' : `--composer-preferred-height: ${composerPreferredHeight}px;`}`}
>
	<FieldViewport
		bind:viewportElement
		geometryReady={initialFieldGeometryReady}
		composerAvailable={composerAvailable}
		speechAreaVisualBounds={speechAreaVisualBounds}
	>
		{#snippet children()}
			<Chatter
				bind:this={chatterComponent}
				messages={recentMessageTimeline}
				tones={colorByPubkey}
				{selectedCharacterId}
				onOpenProfile={openProfile}
			/>
			<FieldScene
				geometryReady={initialFieldGeometryReady}
				{fieldAreaBounds}
				{fieldWorldSize}
				{cellSize}
				{camera}
				cameraAnimating={visualMotion !== null}
				{fieldSelectionPointer}
				{traceLightCells}
				{proximityFeedback}
				{traceOnlyCellTriggers}
				{participantViews}
				{selfProjectionId}
				{movingParticipantIds}
				{selfIsActive}
				{selfLogicalPosition}
				{traceRootGhost}
				{fieldActionMenu}
				{pointerJoystick}
				resolveFieldCellSelection={resolveFieldCellSelection}
				executeFieldCellAction={executeFieldCellAction}
				fieldActionLabel={fieldActionLabel}
				onOpenProfile={openProfile}
				traceLightWorldPosition={traceLightWorldPosition}
			/>
			<SpeechLayer
				{viewportSize}
				traceReady={tracePresentationReady}
				traceLayout={traceTreeLayout}
				{traceRootTailTarget}
				normalTails={normalTailModels}
				mergedTails={mergedTailModels}
				{liveBubblePresentations}
				{bubbleOverflowById}
				currentSpeechId={traceConversationProjection?.current.event.id ?? null}
				replyRefresh={traceConversationState.kind === 'open' ? traceConversationState.replyRefresh : null}
				onSelectSpeech={selectTraceSpeech}
				onOpenProfile={openProfile}
				onBubbleMeasurement={applyBubbleMeasurement}
				onBubbleMeasurementRemoved={removeBubbleMeasurement}
				registerBubbleRemeasure={registerBubbleRemeasure}
				onReplyFootprint={applyTraceReplyFootprint}
				onReplyFootprintRemoved={removeTraceReplyFootprint}
				registerReplyRemeasure={registerTraceReplyRemeasure}
			/>
		{/snippet}
	</FieldViewport>

	<ProfileDialog
		onOpenChange={handleProfileOpenChange}
		onCloseAutoFocus={restoreProfileTriggerFocus}
	/>

	{#if devWorldSandboxEnabled}
		<DevWorldControls
			{selectedCharacterId}
			traceReplyFixtureEnabled={devTraceReplyFixtureEnabled}
			canAddLiveReply={!devTraceReplies.some((reply) => reply.id === 'c'.repeat(64))}
			onCharacterChange={selectSandboxCharacter}
			onReset={resetSandbox}
			onAddLiveReply={injectDevTraceLiveReply}
		/>
	{:else if selfPositionWriteState.kind === 'retryable' && !isWorldSelfActive}
		<WorldEntryControls onRetry={retryWorldEntry} />
	{/if}

	{#if runtimeMode === 'relay' || devTraceReplyFixtureEnabled}
		<ComposerDock
			bind:this={composerComponent}
			{selectedSpeechType}
			submissionInProgress={composerSubmissionInProgress}
			onSpeechTypeChange={(next) => { selectedSpeechType = next; }}
			submitContent={submitComposerContent}
			desiredContext={composerDesiredContext}
			loadPreview={loadComposerPreview}
			onPreviewClear={clearComposerReply}
			onEditorEmptyChange={handleComposerEditorEmptyChange}
			onPreferredHeightChange={setComposerPreferredHeight}
		/>
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

	.composer-available {
		padding-bottom: var(--composer-reserved-height);
	}

</style>
