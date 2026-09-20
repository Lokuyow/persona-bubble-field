<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
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
		type FieldCellAction
	} from '$lib/fieldSelection';
	import {
		DEV_WORLD_SELF_ID,
		getDevWorldCharacter,
		getDevWorldFixtureCharacter,
		isDevWorldSandboxEnabled,
		moveDevWorldSelf,
		resetDevWorldPresence,
		resolveDevWorldCharacterId
	} from '$lib/devWorldSandbox';
	import { resolveDevScenario, type DevScenario } from '$lib/dev/devScenarios';
	import {
		createDevRiftPlayground,
		DEV_RIFT_PLAYGROUND_SELF_PUBKEY,
		type DevRiftBotPreset,
		type DevRiftPlaygroundState,
		DevRiftPlayground
	} from '$lib/dev/devRiftPlayground';
	import { CHARACTER_CATALOG, getCharacterById, type Character } from '$lib/character';
import { requireCharacterFromPubkey } from '$lib/characterAssignment';
import { requireWorldCharacterFromPubkey } from '$lib/worldCharacterAssignment';
	import ProfileDialog from '$lib/ProfileDialog.svelte';
	import IdentitySelectionDialog from '$lib/IdentitySelectionDialog.svelte';
	import LifespanHud from '$lib/LifespanHud.svelte';
	import MendingDialog from '$lib/MendingDialog.svelte';
	import AdjustmentDialog from '$lib/AdjustmentDialog.svelte';
	import SelfProfileDialog from '$lib/SelfProfileDialog.svelte';
	import RiftPanel from '$lib/RiftPanel.svelte';
	import RiftRulesDialog from '$lib/RiftRulesDialog.svelte';
	import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL, isBlockedFacilityCell, isWithinFacilityInteractionRange, sameFieldCell } from '$lib/fieldFacilities';
	import { projectMending } from '$lib/mending';
	import { getAbilityUpgrade, type PersonaAbilityKey } from '$lib/personaGameState';
	import {
		CURRENT_CHARACTER_PROFILE_REVISION,
		authorizeActiveRun,
		collectMending,
		loadOrCreateLifecycle,
		selectIdentity,
		transitionExpiredPersona,
		startMending,
		upgradePersonaAbility,
		applyRealtimeOutcome,
		completeRealtimeEventInstance,
		getRealtimeSettlementLedger,
		trackRealtimeEventInstance,
		transitionRealtimeDeath,
		clearPersona,
		exportClearedIdentityNsec,
		type ActiveSignerSnapshot,
		type ClearedIdentityCandidate,
		type PersonaSnapshot,
		type PendingSelection,
		type SelectionCandidate
	} from '$lib/rootIdentity';
	import type { RootBuild } from '$lib/rootProgression';
	import { isPersonaExpired } from '$lib/personaGameState';
	import {
		applyRiftAction,
		buildRiftActionTemplate,
		buildRiftCommitAction,
		buildRiftRevealAction,
		createRiftNonce,
		createRiftSession,
		enabledRealtimeEventDefinitions,
		getRiftRoundSchedule,
		getRiftSchedule,
		getRiftScheduleForDate,
		getRiftScheduleForInstance,
		getRiftParticipantHole,
		isManualRiftControlScheduleEligible,
		compareManualRiftControls,
		isRiftSettlementComplete,
		parseManualRiftInstanceId,
		RIFT_EVENT_DEFINITION,
		RIFT_CONSULTATION_MS,
		RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS,
		parseRiftEvent,
		riftPhaseLabel,
		settleRiftSession,
		type RiftChoice,
		type RiftSessionState
	} from '$lib/rift';
	import { finalizeRealtimeEvent, type RealtimeControlEnvelope } from '$lib/realtimeEvents';
	import type { RealtimeEnvelope } from '$lib/realtimeEvents';
	import {
		prepareCharacterProfilePublication,
		publishCharacterProfile,
		type PreparedCharacterProfilePublication
	} from '$lib/initialProfilePublication';
	import { allocateParticipantColors, projectFrontendPresence, type Participant } from '$lib/frontend/presencePresentation';
	import { advanceMergedAnchorHistory } from '$lib/frontend/mergedAnchorHistory';
	import { debugTimeoutParticipant, type PresenceState } from '$lib/presence';
	import { addRecentMessage, createRecentMessageTimeline, type RecentMessageTimeline } from '$lib/recentMessageTimeline';
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
	import FieldViewport, { type FieldViewportHandle } from '$lib/frontend/FieldViewport.svelte';
	import FieldScene, {
		type FieldActionMenu,
		type FieldParticipantView,
		type TraceMarkerCell,
		type TraceRootGhost
	} from '$lib/frontend/FieldScene.svelte';
	import ComposerKeyboardBinding from '$lib/frontend/ComposerKeyboardBinding.svelte';
	import { createMovementInputController } from '$lib/frontend/movementInputController';
	import SpeechLayer from '$lib/frontend/SpeechLayer.svelte';
	import SoundControl from '$lib/frontend/SoundControl.svelte';
	import { matchesComposerSubmit, type ComposerSubmitEnvelope } from '$lib/hostOwnedComposerContext';
	import {
		acceptedTraceReplyTarget, clearTraceReplyMode, completeTraceReplySubmission,
		createTraceReplyMode, selectTraceReplyTarget, type TraceReplyMode
	} from '$lib/traceReplyMode';
	import { createSpeechPublicationCore, type SpeechPublicationContext, type SpeechPublicationOutcome } from '$lib/speechPublication';
	import type { SpeechSuggestionConversationEntry } from '$lib/speechSuggestions';
	import type { SpeechType } from '$lib/conversation';
	import { createSpeechSoundController, DEFAULT_SOUND_PREFERENCE, newLiveBubbleEffects, type SpeechSoundController } from '$lib/speechSoundEffects';
	import type { SpeechBubbleShape } from '$lib/speechBubblePath';
	import {
		createWorldReadSession,
		type SelfMessageAvailability,
		type SelfPositionWriteState,
		type RealtimeStartConfiguration,
		type WorldReadConnectionStatus
	} from '$lib/worldReadSession';
	import type { TraceReadSnapshot } from '$lib/traceReadState';

	const FIELD = {
		columns: 16,
		rows: 8
	} as const;
	const DEFAULT_VIEWPORT = { width: 1100, height: 680 };
	const FIELD_ARTWORK_SCALE = 1.75;
	const SITE_BACKGROUND_ASSET = '/backgrounds/site-background.webp';
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
	const devScenario: DevScenario | null = initialDevWorldSandboxEnabled ? resolveDevScenario(page.url.searchParams) : null;

	let presenceState = $state.raw<PresenceState>({ field: FIELD, participants: [] });
	let viewportElement = $state<HTMLElement>();
	let viewportSize = $state.raw<Size>(DEFAULT_VIEWPORT);
	let initialFieldGeometryReady = $state(false);
	let bubbleSizes = $state.raw<Record<string, Size>>({});
	let bubbleOverflowById = $state.raw<Record<string, boolean>>({});
	const mountedBubbleRemeasures = new Map<string, () => void>();
	const mountedTraceReplyRemeasures = new Map<string, () => void>();
	let conversationState = $state.raw<ConversationState>(createConversationState());
	let soundPreference = $state(DEFAULT_SOUND_PREFERENCE);
	let speechSoundController = $state.raw<SpeechSoundController | null>(null);
	let devSoundSequence = 0;
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
	let proximityFeedback = $state.raw<Readonly<{ position: { x: number; y: number }; label: string }> | null>(null);
	let proximityFeedbackTimer: number | null = null;
	let connectionStatus: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let selfSigner = $state.raw<ActiveSignerSnapshot | null>(null);
	let personaSnapshot = $state.raw<PersonaSnapshot | null>(null);
	let pendingIdentitySelection = $state<PendingSelection | null>(null);
	let pendingRootPoints = $state(0);
	let personaLifecycleTransition = $state(false);
	let lifespanHudNowMs = $state<number | null>(null);
	let lifespanHudUpdatedAtMs = 0;
	let mendingNowMs = $state(0);
	let mendingDialogOpen = $state(false);
	let mendingMutationInFlight = $state(false);
	let adjustmentDialogOpen = $state(false);
	let selfProfileDialogOpen = $state(false);
	let lastSelfProfileTrigger: HTMLButtonElement | null = null;
	let abilityMutationInFlight = $state(false);
	let clearMutationInFlight = $state(false);
	let pendingRealtimeSettlement = $state(false);
	const LIFESPAN_HUD_REFRESH_INTERVAL_MS = 30_000;
	let selfPositionWriteState = $state.raw<SelfPositionWriteState>({ kind: 'unavailable' });
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let traceReadSnapshot = $state<TraceReadSnapshot>({ readRootIds: [], unreadReplyRootIds: [], hasUnreadReplies: false });
	let composerPreferredHeight = $state<number | null>(null);
	let composerKeyboardInset = $state(0);
	let worldSession: ReturnType<typeof createWorldReadSession> | null = null;
	const runtimeMode: 'relay' | 'dev' = initialDevWorldSandboxEnabled ? 'dev' : 'relay';
	const devWorldSandboxEnabled = initialDevWorldSandboxEnabled;
	const devRiftStaticPhase = devScenario?.fixture.kind === 'rift-static' ? devScenario.fixture.phase : null;
	const devRiftPlaygroundEnabled = devScenario?.fixture.kind === 'rift-playground';
	const devRiftFixtureEnabled = devRiftStaticPhase !== null || devRiftPlaygroundEnabled;
	function devRiftFixtureNowMs(): number {
		const schedule = getRiftSchedule(Date.now());
		if (devRiftStaticPhase === 'warning') return schedule.warningAtMs + 1_000;
		if (devRiftStaticPhase === 'registration') return schedule.registrationAtMs + 1_000;
		if (devRiftStaticPhase === 'game') return schedule.gameAtMs + RIFT_CONSULTATION_MS + 1_000;
		if (devRiftStaticPhase === 'ended') return schedule.endedAtMs + 1_000;
		return Date.now();
	}
	const initialRiftNowMs = devRiftPlaygroundEnabled ? 0 : devRiftFixtureEnabled ? devRiftFixtureNowMs() : Date.now();
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
	let profileDialogOpen = $derived(Boolean(
		page.state.profileCharacterId && getCharacterById(page.state.profileCharacterId)
	));
	let lastProfileTrigger: HTMLButtonElement | null = null;
	let composerEditorIsEmpty: boolean | null = null;
	let chatterComponent: { initialize(width: number): void; isInitialized(): boolean; toggle(): void; resetMeasurements(): void };
	let composerComponent = $state.raw<{ focusEditor(): boolean; blurEditor(): boolean; applyContentIfEmpty(content: string): Promise<boolean> } | null>(null);
	let fieldViewportComponent: FieldViewportHandle | null = null;
	let visualWorldById = $state.raw<Record<string, WorldPoint>>({});
	let visualCamera = $state.raw<WorldPoint | null>(null);
	let visualMotion = $state.raw<VisualMotion | null>(null);
	let visualAnimationFrame: number | null = null;
	let visualProjectionInitialized = false;
	let prefersReducedMotion = false;
	let expiryCheckInFlight = false;
	let deathTransitionInFlight = false;
	let runRuntimeRefresh: (() => Promise<void>) | null = null;
	let startReadOnlyWorld: (() => void) | null = null;
	let startSelectedWorld: ((persona: PersonaSnapshot) => Promise<void>) | null = null;
	const realtimeEventRegistry = enabledRealtimeEventDefinitions();
	const riftEventEnabled = realtimeEventRegistry.some((definition) => definition.eventType === 'rift');
	let realtimeStatus = $state<'inactive' | 'active' | 'degraded'>(devRiftFixtureEnabled ? 'active' : 'inactive');
	let riftRealtimeBootstrapComplete = $state(devRiftFixtureEnabled);
	let riftSchedule = $state(getRiftSchedule(initialRiftNowMs));
	let riftNowMs = $state(initialRiftNowMs);
	let riftSession = $state.raw<RiftSessionState | null>(null);
	let riftSelection = $state<Readonly<{ round: 1 | 2 | 3; choice: RiftChoice; nonce: string; commitId: string | null; commitPublished: boolean; revealAttempted: boolean; revealStatus: 'idle' | 'sending' | 'published' | 'failed' }> | null>(null);
	let riftLastResult = $state<string | null>(null);
	let riftSettlementInFlight = $state(false);
	let riftRulesDialogOpen = $state(false);
	let riftRulesDialogMode = $state<'rules' | 'join-confirmation'>('rules');
	let pendingRiftJoin = $state<{ instanceId: string; holeId: string; position: { x: number; y: number } } | null>(null);
	const appliedRiftOutcomeIds = new Set<string>();
	const realtimeRecoveryInstanceIds = new Set<string>();
	let realtimeControlSince = 0;
	let realtimeControlDateKey = '';
	const realtimeControlIds = new Set<string>();
	let selectedManualRiftInstanceId: string | null = null;
	const pendingRealtimeControls: RealtimeControlEnvelope[] = [];
	const recoveredRiftSessions = new Map<string, RiftSessionState>();
	let devRiftPlayground = $state<DevRiftPlayground | null>(null);
	let devRiftPlaygroundState = $state.raw<DevRiftPlaygroundState | null>(null);
	const movementInputController = createMovementInputController({
		requestMovement: (direction) => {
			closeFieldActionMenu();
			moveSelfFromCell(direction);
		},
		canUseArrowForMovement,
		canUseWASDForMovement,
		isComposerEditorKeyboardEvent,
		getComposerEditorIsEmpty: () => composerEditorIsEmpty,
		isProfileDialogOpen: () => profileDialogOpen,
		isDocumentHidden: () => document.hidden,
		cancelPointerGesture: () => fieldViewportComponent?.cancelPointerGesture()
	});

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
	let fieldArtworkBounds = $derived({
		x: -(fieldWorldSize.width * (FIELD_ARTWORK_SCALE - 1)) / 2,
		y: -(fieldWorldSize.height * (FIELD_ARTWORK_SCALE - 1)) / 2,
		width: fieldWorldSize.width * FIELD_ARTWORK_SCALE,
		height: fieldWorldSize.height * FIELD_ARTWORK_SCALE
	});
	let speechAreaBounds = $derived({
		x: SPEECH_AREA.sidePadding,
		y: SPEECH_AREA.top,
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: SPEECH_AREA.height
	});
	let fieldAreaBounds = $derived(getFieldAreaBounds(viewportSize, speechAreaBounds));
	let selfProjectionId = $derived(devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfSigner?.pubkey ?? 'you');
	let presenceProjection = $derived(projectFrontendPresence({ presence: presenceState, selectedCharacterId, selfProjectionId,
		geometry: { cellSize, fieldAreaBounds, cameraWorldBounds: fieldArtworkBounds }, colors: colorByPubkey }));
	let isWorldSelfActive = $derived(Boolean(selfSigner && presenceState.participants.some((participant) =>
		participant.id === selfSigner?.pubkey && participant.status === 'active'
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
	let mendingProjection = $derived(personaSnapshot ? projectMending(personaSnapshot.gameState, mendingNowMs, personaSnapshot.activeRun.rootBuild) : null);
	let canUseMendingTerminal = $derived(!devWorldSandboxEnabled && Boolean(personaSnapshot && selfIsActive && selfLogicalPosition && isWithinFacilityInteractionRange(selfLogicalPosition)));
	let canUseAdjustmentTerminal = $derived(!devWorldSandboxEnabled && Boolean(personaSnapshot && selfIsActive && selfLogicalPosition && isWithinFacilityInteractionRange(selfLogicalPosition, ADJUSTMENT_TERMINAL)));
	let clearBlockedReason = $derived(!personaSnapshot ? 'Runがありません' : personaSnapshot.gameState.points < 100_000 ? '所持ポイントが100,000pt未満です' : isPersonaExpired(personaSnapshot.gameState, mendingNowMs, personaSnapshot.activeRun.rootBuild) ? '寿命が尽きています' : pendingRealtimeSettlement ? '綻びのsettlementが未完了です' : null);
	let traceRootCells = $derived(groupTraceRoots(effectiveTraceRoots));
	// Keep grouped roots intact for the Trace data flow, but let fixed facilities
	// own their cells at the field presentation/interaction boundary.
	let fieldTraceRootCells = $derived(traceRootCells.filter((cell) => !isBlockedFacilityCell(cell.position)));
	let traceMarkerCells: readonly TraceMarkerCell[] = $derived(fieldTraceRootCells
		.filter((cell) => traceConversationState.kind !== 'open' || !sameCell(cell.position, traceConversationState.root.position))
		.map((cell) => ({
			...cell,
			occupied: participantViews.some((participant) =>
				participant.position.x === cell.position.x && participant.position.y === cell.position.y
			),
			inInvestigationRange: selfIsActive && selfLogicalPosition !== null &&
				isWithinTraceInvestigationRange(selfLogicalPosition, cell.position),
			read: traceReadSnapshot.readRootIds.includes(cell.roots[0].id),
			unreadReply: traceReadSnapshot.unreadReplyRootIds.includes(cell.roots[0].id)
		})));
	let traceConversationProjection = $derived(resolveTraceConversationProjection(traceConversationState));
	let speechSuggestionCharacter = $derived(
		devWorldSandboxEnabled
			? getDevWorldCharacter(selectedCharacterId)
			: selfSigner ? requireCharacterFromPubkey(selfSigner.pubkey)
				: getCharacterById(selectedCharacterId) ?? CHARACTER_CATALOG[0]
	);
	let selfProfileCharacter = $derived(!devWorldSandboxEnabled && personaSnapshot ? getCharacterById(personaSnapshot.identity.characterId) ?? null : null);
	let speechSuggestionConversation = $derived.by((): readonly SpeechSuggestionConversationEntry[] => {
		const traceEvents = traceConversationProjection
			? [
				traceConversationProjection.root,
				...(traceConversationProjection.parent ? [traceConversationProjection.parent.event] : []),
				traceConversationProjection.current.event,
				...traceConversationProjection.directReplies
			]
			: recentMessageTimeline;
		const unique = new Map<string, { id: string; pubkey: string; content: string; createdAt: number }>();
		for (const event of traceEvents) {
			if (!unique.has(event.id)) unique.set(event.id, event);
		}
		return [...unique.values()]
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.slice(-8)
			.map((event) => ({
				speaker: traceCharacter(event.pubkey, devWorldSandboxEnabled, selectedCharacterId).name,
				content: event.content
			}));
	});

	function isCurrentSpeechPublicationContext(context: SpeechPublicationContext): boolean {
		const currentTarget = traceReplyMode.target;
		return traceReplyMode.generation === context.generation &&
			(currentTarget?.rootId ?? null) === (context.target?.rootId ?? null) &&
			(currentTarget?.targetId ?? null) === (context.target?.targetId ?? null);
	}

	const speechPublicationCore = createSpeechPublicationCore({
		getSelectedSpeechType: () => selectedSpeechType,
		getSubmissionInProgress: () => composerSubmissionInProgress,
		setSubmissionInProgress: (value) => { composerSubmissionInProgress = value; },
		isPublicationAllowed: () => devWorldSandboxEnabled || !personaLifecycleTransition,
		waitForReady: (signal) => devWorldSandboxEnabled ? Promise.resolve() : waitForMessageReady(signal),
		isCurrentContext: isCurrentSpeechPublicationContext,
		publish: async (submission, context): Promise<SpeechPublicationOutcome> => {
			if (personaLifecycleTransition) return { kind: 'blocked' };
			const result = context.target
				? await (devWorldSandboxEnabled ? devTraceConversationRuntime : worldSession)?.publishTraceReply({
					rootId: context.target.rootId, targetId: context.target.targetId, ...submission
				})
				: !devWorldSandboxEnabled ? await worldSession?.publishMessage(submission.content, submission.speechType) : undefined;
			if (result?.kind === 'succeeded') return result;
			return { kind: result?.kind === 'out-of-range' ? 'out-of-range' : 'failed' };
		},
		onSucceeded: (context) => {
			selectedSpeechType = 'normal';
			traceReplyMode = completeTraceReplySubmission(traceReplyMode, context.generation);
		},
		onOutOfRange: (context) => {
			if (traceReplyMode.generation === context.generation) traceReplyMode = clearTraceReplyMode(traceReplyMode, true);
		}
	});
	let traceOnlyCellTriggers = $derived(fieldTraceRootCells.map((cell) => cell.position).filter((position) =>
		!participantViews.some((participant) => sameCell(participant.position, position)) &&
		traceMarkerCells.some((cell) => sameCell(cell.position, position))
	));
	let facilityCellTriggers = $derived([MENDING_TERMINAL.position, ADJUSTMENT_TERMINAL.position]);
	let realtimeHoles = $derived(!riftEventEnabled || riftSchedule.phase === 'dormant' || riftSchedule.phase === 'ended' ? [] : (riftSession?.holes ?? createRiftSession({ instanceId: riftSchedule.instanceId, field }).holes));
	let realtimeHoleTriggers = $derived(riftSchedule.phase === 'registration' ? realtimeHoles : []);
	let riftActorPubkey = $derived(devRiftPlaygroundEnabled ? DEV_RIFT_PLAYGROUND_SELF_PUBKEY : selfSigner?.pubkey ?? null);
	let riftSelfHoleId = $derived(riftActorPubkey && riftSession ? getRiftParticipantHole(riftSession, riftSchedule, riftActorPubkey) : null);
	let riftRound = $derived(riftSchedule.phase === 'game'
		? ([1, 2, 3] as const).find((round) => riftNowMs < getRiftRoundSchedule(riftSchedule, round).endedAtMs) ?? 3
		: null);
	let riftRoundSchedule = $derived(riftRound ? getRiftRoundSchedule(riftSchedule, riftRound) : null);
	let riftCanChoose = $derived(Boolean(riftSchedule.phase === 'game' && riftRealtimeBootstrapComplete && riftRoundSchedule && riftNowMs >= riftRoundSchedule.selectionAtMs && riftNowMs < riftRoundSchedule.resultAtMs && riftSelfHoleId && realtimeStatus === 'active' && (devRiftPlaygroundEnabled ? !devRiftPlaygroundState?.selfChoice : Boolean(personaSnapshot)) && !(riftSelection?.round === riftRound && riftSelection.commitPublished)));
	let riftSelectedChoice = $derived(devRiftPlaygroundEnabled
		? devRiftPlaygroundState?.selfChoice ?? null
		: riftSelection?.round === riftRound ? riftSelection.choice : null);
	let riftCommitStatus = $derived(devRiftPlaygroundEnabled
		? devRiftPlaygroundState?.selfChoice ? '秘密選択を送信済み' : 'このラウンドの選択はまだありません'
		: riftSelection && riftSelection.round === riftRound
			? riftSelection.revealStatus === 'published' ? '選択を自動公開済み' : riftSelection.revealStatus === 'sending' ? '選択を自動公開中' : riftSelection.revealStatus === 'failed' ? '選択の自動公開に失敗（未reveal）' : riftSelection.commitPublished ? '秘密選択を送信済み' : '未送信'
			: 'このラウンドの選択はまだありません');
	let devRiftLastResult = $derived.by(() => {
		if (!devRiftPlaygroundState) return null;
		const result = devRiftPlaygroundState.session.results.at(-1);
		if (!result) return devRiftPlaygroundState.message;
		const outcome = result.outcomes.find((candidate) => candidate.pubkey === DEV_RIFT_PLAYGROUND_SELF_PUBKEY);
		return outcome?.kind === 'death' ? `Round ${result.round}: simulated death` : outcome ? `Round ${result.round}: +${outcome.points}pt` : `Round ${result.round}: ${result.kind}`;
	});

	function isActuallyPresented(element: Element | null): element is HTMLElement {
		if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return false;
		const style = getComputedStyle(element);
		return style.visibility !== 'hidden' && style.display !== 'none';
	}

	// Read state follows the visible presentation, not measurement attachments.
	// TracePresentation mounts pending measurement nodes with visibility:hidden.
	$effect(() => {
		const ready = tracePresentationReady;
		const layout = traceTreeLayout;
		const ghost = traceRootGhost;
		const session = worldSession;
		if (!ready || !layout || !ghost || !session || typeof document === 'undefined') return;
		void tick().then(() => {
			if (worldSession !== session || !tracePresentationReady) return;
			const rootGhost = document.querySelector(`[data-trace-ghost-root-id="${ghost.event.id}"]`);
			const rootBubble = document.querySelector(`[data-trace-root-id="${ghost.event.id}"]`);
			if (isActuallyPresented(rootGhost) && isActuallyPresented(rootBubble)) {
				void session.markTraceRootRead(ghost.event.id);
			}
			for (const card of document.querySelectorAll<HTMLElement>('[data-trace-reply-id]')) {
				if (isActuallyPresented(card)) void session.markTraceReplyRead(ghost.event.id, card.dataset.traceReplyId!);
			}
		});
	});

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
		document.documentElement.style.setProperty(
			'--site-background-image',
			`url("${asset(SITE_BACKGROUND_ASSET)}")`
		);
		let mounted = true;
		let soundStorage: Storage | null = null;
		try { soundStorage = window.localStorage; } catch { /* storage may be unavailable */ }
		const soundController = createSpeechSoundController({ storage: soundStorage, document });
		speechSoundController = soundController;
		soundPreference = soundController.preference;
		const unlockSound = () => soundController.unlock();
		window.addEventListener('pointerdown', unlockSound, { passive: true });
		window.addEventListener('keydown', unlockSound, { passive: true });
		let startRequested = false;
		let session: ReturnType<typeof createWorldReadSession> | null = null;
		let currentSessionStartup: { session: ReturnType<typeof createWorldReadSession>; promise: Promise<void> } | null = null;
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
			if (devRiftPlaygroundEnabled) {
				devRiftPlayground = createDevRiftPlayground(FIELD);
				devRiftPlaygroundState = devRiftPlayground.snapshot;
				riftSchedule = devRiftPlaygroundState.schedule;
				riftNowMs = devRiftPlaygroundState.nowMs;
				riftSession = devRiftPlaygroundState.session;
			}
			resetSandbox();
			if (import.meta.env.DEV) {
				if (devScenario) applyDevPageFixtures(devScenario, {
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
			if (import.meta.env.DEV && devScenario?.fixture.kind === 'trace' && devScenario.fixture.inactiveSelf) {
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
			if (devRiftFixtureEnabled && !devRiftPlaygroundEnabled) reconcileRiftSession(initialRiftNowMs);
		}

		function getRealtimeStartConfiguration(nowMs: number): RealtimeStartConfiguration {
			const currentSchedule = getRiftSchedule(nowMs);
			if (realtimeControlDateKey !== currentSchedule.dateKey) {
				realtimeControlDateKey = currentSchedule.dateKey;
				realtimeControlSince = Math.max(0, Math.floor(nowMs / 1000) - RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS);
			}
			const recoveryInstanceIds = [...realtimeRecoveryInstanceIds].filter((instanceId) => getRiftScheduleForInstance(instanceId, nowMs) !== null);
			const includeCurrent = currentSchedule.phase === 'registration' || currentSchedule.phase === 'game';
			const activeManual = selectedManualRiftInstanceId ? getRiftScheduleForInstance(selectedManualRiftInstanceId, nowMs) : null;
			const instanceIds = [...new Set([...recoveryInstanceIds, ...(includeCurrent ? [currentSchedule.instanceId] : []), ...(activeManual && (activeManual.phase === 'registration' || activeManual.phase === 'game') ? [activeManual.instanceId] : [])])];
			const schedules = [...recoveryInstanceIds.map((instanceId) => getRiftScheduleForInstance(instanceId, nowMs)), ...(includeCurrent ? [currentSchedule] : []), activeManual]
				.filter((schedule): schedule is typeof currentSchedule => schedule !== null);
			const since = Math.floor(Math.min(...schedules
				.filter((schedule): schedule is typeof currentSchedule => schedule !== null)
				.map((schedule) => schedule.warningAtMs)) / 1000);
			return {
				controlSince: realtimeControlSince,
				instanceFilters: instanceIds.length === 0 ? [] : [{ protocolKey: RIFT_EVENT_DEFINITION.protocolKey, instanceIds, since }]
			};
		}

		function prepareRealtimeStartConfiguration(configuration: RealtimeStartConfiguration, nowMs: number): RealtimeStartConfiguration {
			realtimeControlSince = Math.max(0, Math.floor(nowMs / 1000) - RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS);
			return { ...configuration, controlSince: realtimeControlSince };
		}

		const startReadSession = async (
			signer: ActiveSignerSnapshot | null,
			characterProfilePublication: PreparedCharacterProfilePublication | null = null,
			authorizationRunNumber: number | null = signer ? personaSnapshot?.activeRun.runNumber ?? null : null,
			realtimeStartImmediately: boolean | undefined = undefined
		): Promise<void> => {
			const previousSession = session;
			session = null;
			if (worldSession === previousSession) worldSession = null;
			previousSession?.dispose();
			riftRealtimeBootstrapComplete = devRiftFixtureEnabled;
			let nextSession!: ReturnType<typeof createWorldReadSession>;
			nextSession = createWorldReadSession({
				field: FIELD,
				selfSigner: signer,
					realtime: {
					registry: realtimeEventRegistry,
					controlSince: Math.max(0, Math.floor(Date.now() / 1000) - 15 * 60),
					instanceFilters: [],
					getStartConfiguration: () => getRealtimeStartConfiguration(Date.now()),
					prepareStartConfiguration: prepareRealtimeStartConfiguration,
					startImmediately: realtimeStartImmediately ?? true,
					onEvent: handleRealtimeEnvelope,
					onControl: handleRealtimeControl,
					onBootstrapComplete: () => {
						if (!mounted || session !== nextSession) return;
						riftRealtimeBootstrapComplete = true;
						selectBootstrapRealtimeControl();
						reconcileRiftSession(Date.now());
					},
					onStatusChanged: (next) => {
						realtimeStatus = next;
						if (next === 'inactive') riftRealtimeBootstrapComplete = false;
					}
				},
				...(signer && authorizationRunNumber !== null ? {
					authorizeSelfWrite: () => authorizeActiveRun({ identity: signer.identity, runNumber: authorizationRunNumber }),
						 onSelfWriteAuthorizationLost: () => {
							if (!personaLifecycleTransition && !deathTransitionInFlight) window.location.reload();
					}
				} : {}),
				onPresenceChanged: acceptPresence,
				onLiveMessage: receiveLiveMessage,
				onTimelineMessage: receiveTimelineMessage,
				onEffectiveTraceRootsChanged: setEffectiveTraceRoots,
				onTraceReadSnapshotChanged: (snapshot) => { traceReadSnapshot = snapshot; },
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
			session = nextSession;
			worldSession = nextSession;
			traceConversationController = nextSession;
			let resolveSessionStartup!: () => void;
			let rejectSessionStartup!: (error: unknown) => void;
			const sessionStartup = new Promise<void>((resolve, reject) => {
				resolveSessionStartup = resolve;
				rejectSessionStartup = reject;
			});
			void sessionStartup.catch(() => {});
			currentSessionStartup = { session: nextSession, promise: sessionStartup };
			try {
				const bootstrap = await nextSession.start();
				if (!mounted || session !== nextSession) {
					nextSession.dispose();
					return;
				}
				restoreBootstrapConversation(bootstrap.messages, bootstrap.presence, Date.now());
				recentMessageTimeline = createRecentMessageTimeline([
					...recentMessageTimeline,
					...bootstrap.timelineMessages
				]);
				nextSession.completeBootstrap();
				resolveSessionStartup();
				if (signer && !personaLifecycleTransition) void nextSession.enterSelf();
				if (characterProfilePublication && signer && !personaLifecycleTransition) {
					void publishCharacterProfile(characterProfilePublication, (event) => {
						if (personaLifecycleTransition || worldSession !== nextSession) {
							return Promise.reject(new Error('Persona is unavailable for publishing.'));
						}
						return nextSession.publish(event);
					}).catch(() => {});
				}
			} catch (error) {
				rejectSessionStartup(error);
				if (session === nextSession) setComposerTerminalError(new Error('Relay startup failed.'));
			}
		};
		startReadOnlyWorld = () => { void startReadSession(null); };
		startSelectedWorld = async (persona: PersonaSnapshot): Promise<void> => {
			personaSnapshot = persona;
			pendingRootPoints = persona.rootPoints;
			selfSigner = persona.signer;
			pendingIdentitySelection = null;
			composerStartupError = null;
			entryRetryable = false;
			selfPositionWriteState = { kind: 'unavailable' };
			selfMessageAvailability = { kind: 'unavailable' };
			connectionStatus = { kind: 'bootstrapping' };
			realtimeRecoveryInstanceIds.clear();
			const ledger = await getRealtimeSettlementLedger(persona);
			pendingRealtimeSettlement = (ledger?.pendingInstanceIds.length ?? 0) > 0;
			for (const instanceId of (ledger?.pendingInstanceIds ?? [])
				.filter((id) => getRiftScheduleForInstance(id, Date.now()) !== null)) {
				realtimeRecoveryInstanceIds.add(instanceId);
			}
			let characterProfilePublication: PreparedCharacterProfilePublication | null = null;
			if (persona.signer.characterProfileRevision !== CURRENT_CHARACTER_PROFILE_REVISION) {
				const character = requireCharacterFromPubkey(persona.signer.pubkey);
				const absolutePictureUrl = new URL(
					asset(`/${character.picture}`),
					window.location.origin
				).toString();
				characterProfilePublication = prepareCharacterProfilePublication({
					signer: persona.signer,
					character,
					absolutePictureUrl,
					createdAt: Math.floor(persona.signer.identityCreatedAtMs / 1000)
				});
			}
			const anonymousSession = session;
			const anonymousStartup = currentSessionStartup;
			if (anonymousSession && anonymousStartup?.session === anonymousSession) {
				try {
					await anonymousStartup.promise;
					if (session !== anonymousSession || anonymousSession.getStatus().kind === 'failed') throw new Error('Anonymous world session is unavailable.');
					await anonymousSession.attachSelf({
						signer: persona.signer,
						authorizeSelfWrite: () => authorizeActiveRun({ identity: persona.signer.identity, runNumber: persona.activeRun.runNumber }),
						onSelfWriteAuthorizationLost: () => {
							if (!personaLifecycleTransition && !deathTransitionInFlight) window.location.reload();
						}
					});
					if (session !== anonymousSession) throw new Error('World session changed during self attachment.');
					personaLifecycleTransition = false;
					mendingNowMs = Date.now();
					updateLifespanHud(mendingNowMs, true);
					await anonymousSession.enterSelf();
					if (characterProfilePublication) {
						void publishCharacterProfile(characterProfilePublication, (event) => {
							if (personaLifecycleTransition || worldSession !== anonymousSession) {
								return Promise.reject(new Error('Persona is unavailable for publishing.'));
							}
							return anonymousSession.publish(event);
						}).catch(() => {});
					}
					return;
				} catch {
					// A failed or superseded anonymous startup cannot be promoted.
				}
			}
			// The anonymous startup error belongs to the superseded attempt, not this fresh signed session.
			composerStartupError = null;
			const startup = startReadSession(persona.signer, characterProfilePublication, persona.activeRun.runNumber, true);
			// startReadSession installs the new session synchronously before its first await.
			// Release the selection guard only after the signed session owns the page state.
			personaLifecycleTransition = false;
			mendingNowMs = Date.now();
			updateLifespanHud(mendingNowMs, true);
			await startup;
		};

		const begin = async () => {
			if (devWorldSandboxEnabled || startRequested || !hasUsableViewport()) return;
			startRequested = true;
			let characterProfilePublication: PreparedCharacterProfilePublication | null = null;
			let realtimeStartImmediately = false;
			try {
				const personaResult = await loadOrCreateLifecycle();
				if (personaResult.kind === 'created' || personaResult.kind === 'selecting') {
					pendingIdentitySelection = personaResult.selection;
					pendingRootPoints = personaResult.rootPoints;
					selfSigner = null;
					personaSnapshot = null;
				} else if (personaResult.kind !== 'restored') {
					setComposerTerminalError(new Error('Persona is unavailable for publishing.'));
				} else {
					personaSnapshot = personaResult.persona;
					pendingRootPoints = personaResult.persona.rootPoints;
					selfSigner = personaResult.persona.signer;
					const ledger = await getRealtimeSettlementLedger(personaResult.persona);
					const pendingInstanceIds = (ledger?.pendingInstanceIds ?? [])
						.filter((instanceId) => getRiftScheduleForInstance(instanceId, Date.now()) !== null);
					realtimeRecoveryInstanceIds.clear();
					pendingRealtimeSettlement = (ledger?.pendingInstanceIds.length ?? 0) > 0;
					for (const instanceId of pendingInstanceIds) realtimeRecoveryInstanceIds.add(instanceId);
					realtimeStartImmediately = true;
					mendingNowMs = Date.now();
					updateLifespanHud(Date.now(), true);
					if (isPersonaExpired(personaResult.persona.gameState, Date.now(), personaResult.persona.activeRun.rootBuild)) {
						const result = await beginDeathTransition(personaResult.persona, session);
						if (result === 'reloaded' || result === 'failed') return;
					}
					if (selfSigner.characterProfileRevision !== CURRENT_CHARACTER_PROFILE_REVISION) {
						const character = requireCharacterFromPubkey(selfSigner.pubkey);
						const absolutePictureUrl = new URL(
							asset(`/${character.picture}`),
							window.location.origin
						).toString();
						characterProfilePublication = prepareCharacterProfilePublication({
							signer: selfSigner,
							character,
							absolutePictureUrl,
							createdAt: personaResult.kind === 'restored' ? Math.floor(Date.now() / 1000) :
								Math.floor(selfSigner.identityCreatedAtMs / 1000)
						});
					}
				}
			} catch {
				setComposerTerminalError(new Error('Persona is unavailable for publishing.'));
			}
			await startReadSession(selfSigner, characterProfilePublication, personaSnapshot?.activeRun.runNumber ?? null, realtimeStartImmediately);
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
		const observer = new ResizeObserver(updateViewport);
		observer.observe(viewportElement!);
		updateViewport();
		const refreshRuntime = async () => {
			if (expiryCheckInFlight || deathTransitionInFlight) return;
			expiryCheckInFlight = true;
			try {
				const expiryResult = await checkPersonaExpiry(session);
				if (expiryResult === 'reloaded') return;
				if (expiryResult === 'failed') {
					await startReadSession(null);
					return;
				}
				const now = Date.now();
				mendingNowMs = now;
				updateLifespanHud(now);
				if (!devRiftPlaygroundEnabled) reconcileRiftSession(devRiftFixtureEnabled ? initialRiftNowMs : now);
				if (!devWorldSandboxEnabled && riftEventEnabled) void worldSession?.startRealtime();
				if (!devWorldSandboxEnabled && riftSchedule.phase === 'ended') maybeStopRealtime();
				const nextPresence = session?.refresh(now);
				if (nextPresence) {
					conversationState = applyVisibility(conversationState, projectFrontendPresence({ presence: nextPresence, selectedCharacterId, selfProjectionId,
						geometry: { cellSize, fieldAreaBounds, cameraWorldBounds: fieldArtworkBounds }, colors: colorByPubkey }).visibleParticipantIds);
				}
				conversationState = pruneExpired(conversationState, now);
			} finally {
			expiryCheckInFlight = false;
			}
		};
		runRuntimeRefresh = refreshRuntime;
		const expiryTimer = window.setInterval(() => { void refreshRuntime(); }, 250);

		return () => {
			mounted = false;
			window.removeEventListener('pointerdown', unlockSound);
			window.removeEventListener('keydown', unlockSound);
			soundController.dispose();
			speechSoundController = null;
			if (proximityFeedbackTimer !== null) window.clearTimeout(proximityFeedbackTimer);
			proximityFeedbackTimer = null;
			cancelPendingComposerSubmission(new DOMException('Submission was cancelled.', 'AbortError'));
			observer.disconnect();
			movementInputController.destroy();
			reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
			cancelVisualAnimation();
			window.clearInterval(expiryTimer);
			if (runRuntimeRefresh === refreshRuntime) runRuntimeRefresh = null;
			if (startReadOnlyWorld) startReadOnlyWorld = null;
			if (startSelectedWorld) startSelectedWorld = null;
			currentSessionStartup = null;
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
		const geometry = { cellSize, fieldAreaBounds, cameraWorldBounds: fieldArtworkBounds };
		const selfId = devWorldSandboxEnabled ? DEV_WORLD_SELF_ID : selfSigner?.pubkey;
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
		if (mendingDialogOpen && !hasLiveMendingProximity()) closeMendingTerminal();
		if (adjustmentDialogOpen && !canUseAdjustmentTerminal) closeAdjustmentTerminal();
		const nextProjection = projectFrontendPresence({ presence: nextPresence,
			selectedCharacterId: selectedId, selfProjectionId: projectionId, geometry, colors: nextColors });
		animatePresenceTransition(previousProjection, nextProjection, projectionId);
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

	function openMendingTerminal(): void {
		if (!canUseMendingTerminal || mendingMutationInFlight) return;
		movementInputController.cancelMovementHold();
			fieldViewportComponent?.cancelPointerGesture();
		mendingNowMs = Date.now();
		mendingDialogOpen = true;
	}

	function closeMendingTerminal(): void {
		mendingDialogOpen = false;
	}

	function openAdjustmentTerminal(): void {
		if (!canUseAdjustmentTerminal || abilityMutationInFlight) return;
		movementInputController.cancelMovementHold();
		fieldViewportComponent?.cancelPointerGesture();
		adjustmentDialogOpen = true;
	}

	function closeAdjustmentTerminal(): void {
		adjustmentDialogOpen = false;
	}

	async function chooseIdentity(candidate: SelectionCandidate, rootBuild: RootBuild): Promise<void> {
		const selection = pendingIdentitySelection;
		if (!selection || personaLifecycleTransition) return;
		personaLifecycleTransition = true;
		try {
			const result = await selectIdentity(selection.generation, candidate, rootBuild);
			if (result.kind === 'selected') {
				if (startSelectedWorld) {
					await startSelectedWorld(result.persona);
					return;
				}
				enterReadOnlyFallback('Persona startup is unavailable.');
				return;
			}
			if (result.kind === 'superseded') {
				window.location.reload();
				return;
			}
			enterReadOnlyFallback('Persona is unavailable for publishing.');
		} catch {
			enterReadOnlyFallback('Persona is unavailable for publishing.');
		}
	}

	async function exportIdentityNsec(candidate: ClearedIdentityCandidate): Promise<void> {
		try {
			const nsec = await exportClearedIdentityNsec({ generation: candidate.generation, accountIndex: candidate.accountIndex, pubkey: candidate.pubkey });
			if (nsec) window.prompt('clear済みIdentityのnsec（安全な場所へ移してください）', nsec);
		} catch {
			setComposerTerminalError(new Error('nsecを取得できませんでした。'));
		}
	}

	async function clearCurrentRun(): Promise<void> {
		const expected = personaSnapshot;
		if (!expected || clearMutationInFlight) return;
		clearMutationInFlight = true;
		try {
			const result = await clearPersona(expected);
			if (result.kind === 'cleared') {
				stopPersonaInteractions('Run cleared.');
				disposePersonaWriter();
				window.location.reload();
			} else if (result.kind === 'superseded') {
				window.location.reload();
			} else if (result.kind === 'corrupt') {
				enterReadOnlyFallback('Persona is unavailable for publishing.');
			}
		} finally {
			clearMutationInFlight = false;
		}
	}

	function samePersonaIdentity(first: PersonaSnapshot, second: PersonaSnapshot): boolean {
		return first.signer.pubkey === second.signer.pubkey &&
			first.signer.identityCreatedAtMs === second.signer.identityCreatedAtMs &&
			first.gameState.personaPubkey === second.gameState.personaPubkey &&
			first.activeRun.runNumber === second.activeRun.runNumber;
	}

	function disposePersonaWriter(currentSession: ReturnType<typeof createWorldReadSession> | null = worldSession): void {
		currentSession?.dispose();
		if (worldSession && worldSession !== currentSession) worldSession.dispose();
		worldSession = null;
		traceConversationController = null;
	}

	function stopPersonaInteractions(message: string): void {
		personaLifecycleTransition = true;
		closeMendingTerminal();
		closeAdjustmentTerminal();
		movementInputController.cancelMovementHold();
		fieldViewportComponent?.cancelPointerGesture();
		cancelPendingComposerSubmission(new Error(message));
	}

	function enterReadOnlyFallback(message: string): void {
		stopPersonaInteractions(message);
		disposePersonaWriter();
		pendingIdentitySelection = null;
		selfSigner = null;
		personaSnapshot = null;
		selfPositionWriteState = { kind: 'unavailable' };
		selfMessageAvailability = { kind: 'unavailable' };
		setComposerTerminalError(new Error(message));
		startReadOnlyWorld?.();
	}

	function reloadForPersonaIdentityChange(latest: PersonaSnapshot): void {
		stopPersonaInteractions('Persona identity changed in another tab.');
		disposePersonaWriter();
		personaSnapshot = latest;
		selfSigner = latest.signer;
		window.location.reload();
	}

	function hasLiveMendingProximity(): boolean {
		return Boolean(!devWorldSandboxEnabled && personaSnapshot && selfIsActive && selfLogicalPosition &&
			isWithinFacilityInteractionRange(selfLogicalPosition));
	}

	async function mutateAbility(key: PersonaAbilityKey): Promise<void> {
		const expected = personaSnapshot;
		if (!expected || abilityMutationInFlight || !canUseAdjustmentTerminal) {
			closeAdjustmentTerminal();
			return;
		}
		abilityMutationInFlight = true;
		try {
			const result = await upgradePersonaAbility(expected, key);
			if (result.kind === 'corrupt') {
				enterReadOnlyFallback('Persona is unavailable for publishing.');
				return;
			}
			if (result.kind === 'superseded') {
				if (result.lifecycle.kind === 'restored') {
					if (!samePersonaIdentity(expected, result.lifecycle.persona)) reloadForPersonaIdentityChange(result.lifecycle.persona);
					else personaSnapshot = result.lifecycle.persona;
				} else {
					stopPersonaInteractions('Persona lifecycle changed in another tab.');
					window.location.reload();
				}
				return;
			}
			if (result.kind === 'expired') {
				closeAdjustmentTerminal();
				void beginDeathTransition(result.persona, worldSession);
				return;
			}
			personaSnapshot = result.persona;
			selfSigner = result.persona.signer;
		} catch {
			closeAdjustmentTerminal();
		} finally {
			abilityMutationInFlight = false;
		}
	}

	async function mutateMending(operation: 'start' | 'collect'): Promise<void> {
		const expected = personaSnapshot;
		if (!expected || mendingMutationInFlight || !hasLiveMendingProximity()) {
			closeMendingTerminal();
			return;
		}
		mendingMutationInFlight = true;
		try {
			const result = operation === 'start' ? await startMending(expected) : await collectMending(expected);
			if (result.kind === 'corrupt') {
				enterReadOnlyFallback('Persona is unavailable for publishing.');
				return;
			}
			if (result.kind === 'superseded') {
				if (result.lifecycle.kind === 'restored') {
					if (!samePersonaIdentity(expected, result.lifecycle.persona)) reloadForPersonaIdentityChange(result.lifecycle.persona);
					else {
						personaSnapshot = result.lifecycle.persona;
						selfSigner = result.lifecycle.persona.signer;
					}
				} else {
					stopPersonaInteractions('Persona lifecycle changed in another tab.');
					window.location.reload();
				}
				return;
			}
			personaSnapshot = result.persona;
			selfSigner = result.persona.signer;
			mendingNowMs = Date.now();
			updateLifespanHud(mendingNowMs, true);
			if (result.kind === 'started') closeMendingTerminal();
			if (result.kind === 'expired') {
				closeMendingTerminal();
				void beginDeathTransition(result.persona, worldSession);
			}
		} catch {
			closeMendingTerminal();
		} finally {
			mendingMutationInFlight = false;
		}
	}

	function showTraceProximityFeedback(position: { x: number; y: number }, label = '近づくと調べられる'): void {
		proximityFeedback = { position: { ...position }, label };
		if (proximityFeedbackTimer !== null) window.clearTimeout(proximityFeedbackTimer);
		proximityFeedbackTimer = window.setTimeout(() => {
			proximityFeedback = null;
			proximityFeedbackTimer = null;
		}, 1_000);
	}

	function ensureRiftSession(instanceId: string): RiftSessionState {
		if (riftSession?.instanceId === instanceId) return riftSession;
		const recovered = recoveredRiftSessions.get(instanceId);
		if (recovered) return recovered;
		const next = createRiftSession({ instanceId, field });
		if (instanceId === riftSchedule.instanceId) riftSession = next;
		else recoveredRiftSessions.set(instanceId, next);
		return next;
	}

	function riftResultLabel(): string | null {
		const pubkey = selfSigner?.pubkey;
		if (!pubkey || !riftSession) return null;
		const results = riftSession.results.filter((result) => result.outcomes.some((outcome) => outcome.pubkey === pubkey));
		const result = results.at(-1);
		const outcome = result?.outcomes.find((candidate) => candidate.pubkey === pubkey);
		if (!result || !outcome) return null;
		return outcome.kind === 'death' ? `Round ${result.round}: 綻びの失敗により死亡` : `Round ${result.round}: +${outcome.points}pt`;
	}

	async function settleOwnRiftOutcomes(sourceSession: RiftSessionState | null = riftSession): Promise<void> {
		if (riftSettlementInFlight || !personaSnapshot || !selfSigner || !sourceSession) return;
		const outcomes = sourceSession.results.flatMap((result) => result.outcomes).filter((outcome) => outcome.pubkey === selfSigner!.pubkey);
		const next = outcomes.find((outcome) => !appliedRiftOutcomeIds.has(outcome.id));
		if (!next) {
			const sourceSchedule = sourceSession.instanceId === riftSchedule.instanceId
				? riftSchedule
				: getRiftScheduleForInstance(sourceSession.instanceId, Date.now());
			if (sourceSchedule && isRiftSettlementComplete(sourceSession, sourceSchedule, selfSigner.pubkey)) {
				const completed = await completeRealtimeEventInstance(personaSnapshot, sourceSession.instanceId);
				if (completed) {
					realtimeRecoveryInstanceIds.delete(sourceSession.instanceId);
					pendingRealtimeSettlement = realtimeRecoveryInstanceIds.size > 0;
					if (sourceSession.instanceId !== riftSchedule.instanceId) recoveredRiftSessions.delete(sourceSession.instanceId);
					maybeStopRealtime();
				}
			}
			return;
		}
		riftSettlementInFlight = true;
		try {
			const outcome = next.kind === 'points'
				? await applyRealtimeOutcome(personaSnapshot, { id: next.id, kind: 'points', points: next.points, instanceId: next.instanceId })
				: await transitionRealtimeDeath(personaSnapshot, { id: next.id, kind: 'death', instanceId: next.instanceId });
			if (outcome.kind === 'applied' || outcome.kind === 'duplicate' || outcome.kind === 'expired') {
				appliedRiftOutcomeIds.add(next.id);
				if ('persona' in outcome) {
					personaSnapshot = outcome.persona;
					selfSigner = outcome.persona.signer;
				}
			} else if (outcome.kind === 'transitioned') {
				appliedRiftOutcomeIds.add(next.id);
				stopPersonaInteractions('綻びの結果を反映しました。');
				window.location.reload();
			} else if (outcome.kind === 'stale') {
				appliedRiftOutcomeIds.add(next.id);
				window.location.reload();
			}
		} catch {
			// A temporary settlement failure leaves the outcome unmarked for the
			// next refresh; it never turns a publication failure into death.
		} finally {
			riftSettlementInFlight = false;
		}
	}

	async function autoRevealRiftChoice(nowMs: number): Promise<void> {
		const selection = riftSelection;
		const roundSchedule = riftRoundSchedule;
		if (!selection || !roundSchedule || selection.round !== riftRound || !selection.commitId || !selection.commitPublished ||
			selection.revealAttempted || selection.revealStatus === 'sending' || selection.revealStatus === 'published' ||
			nowMs < roundSchedule.resultAtMs || nowMs > roundSchedule.revealCutoffAtMs || !selfSigner || !riftSelfHoleId) return;
		riftSelection = { ...selection, revealAttempted: true, revealStatus: 'sending' };
		const id = await publishRiftAction(buildRiftRevealAction({ holeId: riftSelfHoleId, round: selection.round,
			commitId: selection.commitId, choice: selection.choice, nonce: selection.nonce }));
		if (riftSelection?.round !== selection.round || riftSelection.commitId !== selection.commitId) return;
		riftSelection = { ...riftSelection, revealStatus: id ? 'published' : 'failed' };
	}

	function manualControlIsEligible(control: RealtimeControlEnvelope, nowMs: number): boolean {
		const scheduled = getRiftSchedule(nowMs);
		return isManualRiftControlScheduleEligible(control, nowMs) && !selectedManualRiftInstanceId && !['warning', 'registration', 'game'].includes(scheduled.phase);
	}

	function acceptRealtimeControl(control: RealtimeControlEnvelope): void {
		if (realtimeControlIds.has(control.event.id)) return;
		realtimeControlIds.add(control.event.id);
		if (!manualControlIsEligible(control, Date.now())) return;
		selectedManualRiftInstanceId = control.instanceId;
		reconcileRiftSession(Date.now());
		void worldSession?.startRealtime();
	}

	function handleRealtimeControl(control: RealtimeControlEnvelope): void {
		if (!riftRealtimeBootstrapComplete) {
			pendingRealtimeControls.push(control);
			return;
		}
		acceptRealtimeControl(control);
	}

	function selectBootstrapRealtimeControl(): void {
		const candidates = [...pendingRealtimeControls]
			.filter((control) => manualControlIsEligible(control, Date.now()))
			.sort(compareManualRiftControls);
		pendingRealtimeControls.length = 0;
		if (candidates[0]) acceptRealtimeControl(candidates[0]);
	}

	function maybeStopRealtime(): void {
		if (riftSchedule.phase !== 'ended' || realtimeRecoveryInstanceIds.size > 0 || recoveredRiftSessions.size > 0) return;
		void worldSession?.startRealtime();
	}

	function resolveCurrentRiftSchedule(nowMs: number): ReturnType<typeof getRiftSchedule> {
		const scheduled = getRiftSchedule(nowMs);
		if (['warning', 'registration', 'game'].includes(scheduled.phase)) return scheduled;
		const manual = selectedManualRiftInstanceId ? getRiftScheduleForInstance(selectedManualRiftInstanceId, nowMs) : null;
		return manual && ['registration', 'game'].includes(manual.phase) ? manual : scheduled;
	}

	function reconcileRiftSession(nowMs = Date.now()): void {
		riftNowMs = nowMs;
		if (selectedManualRiftInstanceId) {
			const selectedSchedule = getRiftScheduleForInstance(selectedManualRiftInstanceId, nowMs);
			if (selectedSchedule?.phase === 'ended') {
				selectedManualRiftInstanceId = null;
				void worldSession?.startRealtime();
			}
		}
		riftSchedule = resolveCurrentRiftSchedule(nowMs);
		if (!riftEventEnabled) {
			riftSession = null;
			recoveredRiftSessions.clear();
			return;
		}
		if (!riftSession || riftSession.instanceId !== riftSchedule.instanceId) {
			if (riftSchedule.phase !== 'dormant') {
				const recovered = recoveredRiftSessions.get(riftSchedule.instanceId);
				if (recovered) {
					riftSession = recovered;
					recoveredRiftSessions.delete(riftSchedule.instanceId);
				} else {
					riftSession = createRiftSession({ instanceId: riftSchedule.instanceId, field });
				}
			}
		} else if (riftRealtimeBootstrapComplete) {
			riftSession = settleRiftSession(riftSession, riftSchedule, nowMs);
		}
		riftLastResult = riftResultLabel();
		void autoRevealRiftChoice(nowMs);
		void settleOwnRiftOutcomes();
		for (const [instanceId, recovered] of recoveredRiftSessions) {
			const recoveredSchedule = getRiftScheduleForInstance(instanceId, nowMs);
			if (!recoveredSchedule) {
				recoveredRiftSessions.delete(instanceId);
				continue;
			}
			if (riftRealtimeBootstrapComplete) {
				const settled = settleRiftSession(recovered, recoveredSchedule, nowMs);
				recoveredRiftSessions.set(instanceId, settled);
				void settleOwnRiftOutcomes(settled);
			}
		}
	}

	function handleRealtimeEnvelope(envelope: RealtimeEnvelope): void {
		if (envelope.eventType !== 'rift') return;
		const parsed = parseRiftEvent(envelope.event, envelope.channelId, realtimeEventRegistry);
		const eventSchedule = parsed ? getRiftScheduleForInstance(parsed.instanceId, Date.now()) : null;
		if (!parsed || !eventSchedule) return;
		if (parseManualRiftInstanceId(parsed.instanceId) && parsed.instanceId !== selectedManualRiftInstanceId && !realtimeRecoveryInstanceIds.has(parsed.instanceId)) return;
		const state = ensureRiftSession(parsed.instanceId);
		const next = applyRiftAction(state, {
			id: envelope.event.id,
			pubkey: envelope.event.pubkey,
			createdAt: envelope.event.created_at * 1000,
			action: parsed.action
		});
		if (parsed.instanceId === riftSchedule.instanceId) riftSession = next;
		else recoveredRiftSessions.set(parsed.instanceId, next);
		if (personaSnapshot && parsed.action.action === 'join' && envelope.event.pubkey === selfSigner?.pubkey) {
			realtimeRecoveryInstanceIds.add(parsed.instanceId);
			pendingRealtimeSettlement = true;
			void trackRealtimeEventInstance(personaSnapshot, parsed.instanceId);
		}
		if (parsed.instanceId === riftSchedule.instanceId) reconcileRiftSession(Date.now());
		else {
			const settled = riftRealtimeBootstrapComplete ? settleRiftSession(next, eventSchedule, Date.now()) : next;
			recoveredRiftSessions.set(parsed.instanceId, settled);
			if (riftRealtimeBootstrapComplete) void settleOwnRiftOutcomes(settled);
		}
	}

	async function publishRiftAction(action: Parameters<typeof buildRiftActionTemplate>[0]['action']): Promise<string | null> {
		if (!selfSigner || !worldSession || realtimeStatus !== 'active') return null;
		const channel = worldSession.getChannel();
		if (!channel) return null;
		try {
			const event = finalizeRealtimeEvent(buildRiftActionTemplate({ channelId: channel.channelId, relayHint: channel.relayHint,
				instanceId: riftSchedule.instanceId, action, createdAt: Math.floor(Date.now() / 1000) }), selfSigner.secretKey);
			const result = await worldSession.publishRealtime(event);
			if (result.outcome !== 'accepted' && result.outcome !== 'echoed') return null;
			handleRealtimeEnvelope({ event, channelId: channel.channelId, eventType: 'rift', protocolVersion: 1,
				protocolKey: RIFT_EVENT_DEFINITION.protocolKey, instanceId: riftSchedule.instanceId,
				payload: action, definition: RIFT_EVENT_DEFINITION });
			return event.id;
		} catch {
			return null;
		}
	}

	async function joinRiftHole(holeId: string, position: { x: number; y: number }): Promise<void> {
		if (devRiftPlaygroundEnabled) {
			if (!selfIsActive || !selfLogicalPosition) return;
			if (Math.max(Math.abs(selfLogicalPosition.x - position.x), Math.abs(selfLogicalPosition.y - position.y)) > 1) {
				showTraceProximityFeedback(position, '近づくと抜け穴へ参加できる');
				return;
			}
			if (devRiftPlayground) {
				devRiftPlaygroundState = devRiftPlayground.joinSelf(holeId);
				riftSchedule = devRiftPlaygroundState.schedule;
				riftNowMs = devRiftPlaygroundState.nowMs;
				riftSession = devRiftPlaygroundState.session;
			}
			return;
		}
		if (!selfSigner || !selfIsActive || !selfLogicalPosition || riftSchedule.phase !== 'registration') return;
		if (Math.max(Math.abs(selfLogicalPosition.x - position.x), Math.abs(selfLogicalPosition.y - position.y)) > 1) {
			showTraceProximityFeedback(position, '近づくと抜け穴へ参加できる');
			return;
		}
		pendingRiftJoin = { instanceId: riftSchedule.instanceId, holeId, position: { ...position } };
		riftRulesDialogMode = 'join-confirmation';
		riftRulesDialogOpen = true;
	}

	function discardPendingRiftJoin(): void {
		riftRulesDialogOpen = false;
		pendingRiftJoin = null;
	}

	async function confirmRiftJoin(): Promise<void> {
		const pending = pendingRiftJoin;
		if (!pending) return;
		const currentHole = realtimeHoles.find((hole) => hole.id === pending.holeId);
		const isCurrentHole = currentHole?.position.x === pending.position.x && currentHole.position.y === pending.position.y;
		const isInRange = Boolean(selfLogicalPosition && Math.max(
			Math.abs(selfLogicalPosition.x - pending.position.x),
			Math.abs(selfLogicalPosition.y - pending.position.y)
		) <= 1);
		const canStillJoin = Boolean(selfSigner && selfIsActive && selfLogicalPosition &&
			riftSchedule.phase === 'registration' && pending.instanceId === riftSchedule.instanceId &&
			isCurrentHole && isInRange);
		discardPendingRiftJoin();
		if (!canStillJoin) return;
		await publishRiftAction({ action: 'join', holeId: pending.holeId });
	}

	async function chooseRiftChoice(choice: RiftChoice): Promise<void> {
		if (devRiftPlaygroundEnabled) {
			if (devRiftPlayground) {
				devRiftPlaygroundState = devRiftPlayground.chooseSelf(choice);
				riftSchedule = devRiftPlaygroundState.schedule;
				riftNowMs = devRiftPlaygroundState.nowMs;
				riftSession = devRiftPlaygroundState.session;
			}
			return;
		}
		if (!riftCanChoose || !selfSigner || !riftSelfHoleId || !riftRound ||
			(riftSelection?.round === riftRound && riftSelection.commitPublished)) return;
		const nonce = createRiftNonce();
		const action = buildRiftCommitAction({ instanceId: riftSchedule.instanceId, holeId: riftSelfHoleId, round: riftRound, authorPubkey: selfSigner.pubkey, choice, nonce });
		const commitId = await publishRiftAction(action);
		if (!commitId) return;
		riftSelection = { round: riftRound, choice, nonce, commitId, commitPublished: true, revealAttempted: false, revealStatus: 'idle' };
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
		const visibleTraceAtCell = traceMarkerCells.some((cell) => sameCell(cell.position, position));
		const riftHole = riftSchedule.phase === 'registration' ? realtimeHoles.find((hole) => sameCell(hole.position, position)) : undefined;
		const reselectCurrentRoot = traceConversationProjection?.current.kind === 'root' &&
			sameCell(traceConversationProjection.current.event.position, position) && visibleTraceAtCell;
		if (reselectCurrentRoot && !replyMode.target && selfIsActive && selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, position)) {
			trace = { kind: 'trace', rootId: traceConversationProjection!.current.event.id, behavior: 'select-current' };
		} else {
			const rootCell = fieldTraceRootCells.find((cell) => sameCell(cell.position, position));
			const currentIsRootCell = traceConversationProjection?.current.kind === 'root' &&
				sameCell(traceConversationProjection.current.event.position, position);
			const root = currentIsRootCell ? undefined : rootCell?.roots[0];
			if (root && (!selfIsActive || (selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, root.position)))) {
				trace = { kind: 'trace', rootId: root.id, behavior: 'open-root' };
			}
		}
		return buildFieldCellActions({
			participantIds,
			mendingTerminal: canUseMendingTerminal && sameFieldCell(position, MENDING_TERMINAL.position),
			adjustmentTerminal: canUseAdjustmentTerminal && sameFieldCell(position, ADJUSTMENT_TERMINAL.position),
			riftHoleId: riftHole?.id,
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
		const character = requireWorldCharacterFromPubkey(event.pubkey);
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
		if (action.kind === 'mending-terminal') {
			openMendingTerminal();
			return;
		}
		if (action.kind === 'adjustment-terminal') {
			openAdjustmentTerminal();
			return;
		}
		if (action.kind === 'rift-hole') {
			const hole = realtimeHoles.find((candidate) => candidate.id === action.holeId);
			if (hole) void joinRiftHole(hole.id, hole.position);
			return;
		}
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
			if (sameFieldCell(position, MENDING_TERMINAL.position) && selfIsActive) {
				showTraceProximityFeedback(position, '近づくと端末を使える');
				return;
			}
			if (sameFieldCell(position, ADJUSTMENT_TERMINAL.position) && selfIsActive) {
				showTraceProximityFeedback(position, '近づくと端末を使える');
				return;
			}
			const visibleOutOfRangeTrace = selfIsActive && traceMarkerCells.some((cell) => sameCell(cell.position, position) && !cell.inInvestigationRange);
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

	function fieldActionLabel(action: FieldCellAction): string {
		if (action.kind === 'mending-terminal') return '作業端末を使う';
		if (action.kind === 'adjustment-terminal') return '能力強化端末を使う';
		if (action.kind === 'rift-hole') return 'この抜け穴へ参加';
		if (action.kind === 'trace') return '痕跡を調べる';
		const participant = participantViews.find((candidate) => candidate.id === action.participantId);
		return participant ? `${participant.character.name} のプロフィールを開く` : 'プロフィールを開く';
	}

	function isComposerEditorKeyboardEvent(event: Event): boolean {
		const path = event.composedPath();
		return path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer')) &&
			path.some((target) => target instanceof HTMLElement && target.isContentEditable);
	}

	function canUseArrowForMovement(event: KeyboardEvent): boolean {
		if (
			event.isComposing ||
			event.shiftKey ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey ||
			profileDialogOpen
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
			profileDialogOpen
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
			profileDialogOpen
		) return false;

		return !event.composedPath().some((target) => target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		));
	}

	function handleGlobalKeydown(event: KeyboardEvent): void {
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
			!profileDialogOpen &&
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
		movementInputController.handleKeydown(event);
	}

	function handleDocumentFocusIn(event: FocusEvent): void {
		movementInputController.handleFocusIn(event);
	}

	function handleDocumentVisibilityChange(): void {
		movementInputController.handleVisibilityChange();
		if (!document.hidden) {
			updateLifespanHud(Date.now(), true);
			void runRuntimeRefresh?.();
		}
	}

	function handleDocumentPointerDown(event: PointerEvent): void {
		if (fieldActionMenu && !event.composedPath().some((target) =>
			target instanceof HTMLElement && target.classList.contains('field-action-menu')
		)) closeFieldActionMenu();
	}

	function handleComposerEditorEmptyChange(isEmpty: boolean | null): void {
		composerEditorIsEmpty = isEmpty;
		if (isEmpty !== true) movementInputController.cancelMovementHold();
	}

	function moveSandboxSelf(direction: Direction): void {
		if (!devWorldSandboxEnabled) return;
		const result = moveDevWorldSelf(presenceState, direction, Date.now());
		if (result.moved) acceptPresence(result.state);
	}

	function updateLifespanHud(nowMs: number, force = false): void {
		if (devWorldSandboxEnabled || personaLifecycleTransition || !personaSnapshot) {
			lifespanHudNowMs = null;
			return;
		}
		if (force || lifespanHudNowMs === null || nowMs - lifespanHudUpdatedAtMs >= LIFESPAN_HUD_REFRESH_INTERVAL_MS) {
			mendingNowMs = nowMs;
			lifespanHudNowMs = nowMs;
			lifespanHudUpdatedAtMs = nowMs;
		}
	}

	function moveWorldSelf(direction: Direction): void {
		if (devWorldSandboxEnabled || !selfSigner) return;
		void worldSession?.moveSelf(direction);
	}

	function moveSelfFromCell(direction: Direction): void {
		closeFieldActionMenu();
		if (personaLifecycleTransition || mendingDialogOpen) return;
		if (devWorldSandboxEnabled) moveSandboxSelf(direction);
		else moveWorldSelf(direction);
	}

	async function beginDeathTransition(
		expected: PersonaSnapshot,
		currentSession: ReturnType<typeof createWorldReadSession> | null
	): Promise<'reloaded' | 'failed'> {
		if (devWorldSandboxEnabled || personaLifecycleTransition || deathTransitionInFlight) return 'failed';
		deathTransitionInFlight = true;
		stopPersonaInteractions('Persona lifetime ended.');
		disposePersonaWriter(currentSession);
		try {
			const result = await transitionExpiredPersona(expected);
			if (result.kind === 'transitioned' || result.kind === 'superseded') {
				window.location.reload();
				return 'reloaded';
			}
			if (result.kind === 'not-expired') {
				// The writer and interaction paths were already stopped before the
				// lifecycle recheck. Reconcile the current lifecycle through the
				// normal startup path instead of reviving a stale writer in-place.
				window.location.reload();
				return 'reloaded';
			}
			enterReadOnlyFallback('Persona is unavailable for publishing.');
			return 'failed';
		} catch {
			enterReadOnlyFallback('Persona is unavailable for publishing.');
			return 'failed';
		} finally {
			deathTransitionInFlight = false;
		}
	}

	async function checkPersonaExpiry(
		currentSession: ReturnType<typeof createWorldReadSession> | null
	): Promise<'unchanged' | 'reloaded' | 'failed'> {
		if (devWorldSandboxEnabled || personaLifecycleTransition || !personaSnapshot) return 'unchanged';
		if (!isPersonaExpired(personaSnapshot.gameState, Date.now(), personaSnapshot.activeRun.rootBuild)) return 'unchanged';
		return beginDeathTransition(personaSnapshot, currentSession);
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
		if (personaLifecycleTransition) throw new Error('Persona lifetime ended.');
		const desired = () => ({ generation: traceReplyMode.generation, targetId: traceReplyMode.target?.targetId ?? null,
			clearContentVersion: traceReplyMode.clearContentVersion });
		if (!matchesComposerSubmit(envelope, desired())) throw new Error('Composer reply context is not synchronized.');
		return speechPublicationCore.publish(envelope.output.content, {
			generation: envelope.generation,
			target: traceReplyMode.target
		}, options);
	}

	function submitSpeechCandidate(content: string, signal: AbortSignal): Promise<Readonly<{ eventId: string }>> {
		return speechPublicationCore.publish(content, {
			generation: traceReplyMode.generation,
			target: traceReplyMode.target
		}, { signal });
	}

	function setComposerPreferredHeight(height: number): void {
		composerPreferredHeight = height;
	}

	function retryWorldEntry(): void {
		if (devWorldSandboxEnabled || !selfSigner || selfPositionWriteState.kind !== 'retryable') return;
		void worldSession?.enterSelf();
	}

	function selectSandboxCharacter(characterId: string): void {
		if (!devWorldSandboxEnabled) return;
		selectedCharacterId = resolveDevWorldCharacterId(new URLSearchParams(`?devCharacter=${encodeURIComponent(characterId)}`));
		const url = new URL(window.location.href);
		url.searchParams.set('devCharacter', selectedCharacterId);
		replaceState(`${url.pathname}${url.search}${url.hash}`, page.state);
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

	function resetDevScenario(): void {
		if (!devWorldSandboxEnabled) return;
		const url = new URL(window.location.href);
		window.location.assign(url.toString());
	}

	function changeDevRiftPreset(preset: DevRiftBotPreset): void {
		if (!devRiftPlayground) return;
		devRiftPlaygroundState = devRiftPlayground.setPreset(preset);
	}

	function advanceDevRiftPhase(): void {
		if (!devRiftPlayground) return;
		devRiftPlaygroundState = devRiftPlayground.advance();
		riftSchedule = devRiftPlaygroundState.schedule;
		riftNowMs = devRiftPlaygroundState.nowMs;
		riftSession = devRiftPlaygroundState.session;
	}

	function traceMarkerWorldPosition(position: { x: number; y: number }): WorldPoint {
		return {
			x: (position.x + 0.5) * cellSize,
			y: (position.y + 0.5) * cellSize
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
		if (open) movementInputController.cancelMovementHold();
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
			geometry: { cellSize, fieldAreaBounds, cameraWorldBounds: fieldArtworkBounds }, colors: colorByPubkey }).visibleParticipantIds;
		conversationState = replayBootstrapConversation(messages, entryVisible, entryNowMs);
		conversationState = applyVisibility(conversationState, entryVisible);
	}

	function receiveLiveMessage(message: ParsedWorldMessage, nextPresence: PresenceState): void {
		const nowMs = Date.now();
		if (naturalExpiresAt(message) <= nowMs) return;
		const conversationMessage = toConversationMessage(message);
		const visibleParticipantIds = projectFrontendPresence({ presence: nextPresence, selectedCharacterId, selfProjectionId,
			geometry: { cellSize, fieldAreaBounds, cameraWorldBounds: fieldArtworkBounds }, colors: colorByPubkey }).visibleParticipantIds;
		const previousConversationState = conversationState;
		const nextConversationState = receiveMessage(previousConversationState, conversationMessage, {
			isSpeakerVisible: visibleParticipantIds.has(message.pubkey),
			duration: getPrototypeDisplayDuration(message.content),
			now: conversationMessage.createdAt
		});
		conversationState = applyVisibility(nextConversationState, visibleParticipantIds);
		for (const effect of newLiveBubbleEffects(previousConversationState, conversationState)) speechSoundController?.play(effect);
	}

	function injectDevLiveSpeech(speechType: SpeechType): void {
		if (!devWorldSandboxEnabled) return;
		const self = presenceState.participants.find((participant) => participant.id === DEV_WORLD_SELF_ID);
		if (!self) return;
		devSoundSequence += 1;
		const sequence = devSoundSequence;
		const message: ParsedWorldMessage = {
			id: `dev-sound-test-${sequence}`,
			pubkey: DEV_WORLD_SELF_ID,
			createdAt: Math.floor(Date.now() / 1000),
			content: `Sound test: ${speechType} #${sequence}`,
			speechType,
			position: self.position
		};
		receiveTimelineMessage(message);
		receiveLiveMessage(message, presenceState);
	}

	function updateSoundVolume(volume: number): void {
		speechSoundController?.setVolume(volume);
		soundPreference = speechSoundController?.preference ?? { ...soundPreference, volume };
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
		if (isDevWorldSandbox && pubkey === DEV_WORLD_SELF_ID) return getDevWorldCharacter(currentCharacterId);
		try {
			return requireWorldCharacterFromPubkey(pubkey);
		} catch (error) {
			if (isDevWorldSandbox) return getDevWorldFixtureCharacter(pubkey, currentCharacterId);
			throw error;
		}
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

<svelte:window
	onkeydown={handleGlobalKeydown}
	onkeyup={movementInputController.handleKeyup}
	onblur={movementInputController.handleWindowBlur}
/>
<svelte:document
	onfocusin={handleDocumentFocusIn}
	onvisibilitychange={handleDocumentVisibilityChange}
	onpointerdown={handleDocumentPointerDown}
/>
<ComposerKeyboardBinding
	{runtimeMode}
	onKeyboardInsetChange={(inset) => { composerKeyboardInset = inset; }}
/>

<main
	class={['app-shell', { 'composer-available': composerAvailable,
		'composer-keyboard-visible': composerKeyboardInset > 0 }]}
	data-trace-runtime={traceConversationController ? runtimeMode : undefined}
	style={`--composer-keyboard-inset: ${composerKeyboardInset}px;--composer-initial-preferred-height: ${INITIAL_COMPOSER_PREFERRED_HEIGHT}px;${composerPreferredHeight === null ? '' : `--composer-preferred-height: ${composerPreferredHeight}px;`}`}
>
	<FieldViewport
		bind:this={fieldViewportComponent}
		bind:viewportElement
		geometryReady={initialFieldGeometryReady}
		composerAvailable={composerAvailable}
		{fieldAreaBounds}
		{field}
		{camera}
		resolveFieldCellSelection={(position) => resolveFieldCellSelection(position)}
		closeFieldActionMenu={closeFieldActionMenu}
		onPointerMovementTakeover={movementInputController.takeOverPointer}
		onPointerMovementUpdate={movementInputController.updatePointer}
		onPointerMovementStop={movementInputController.stopPointer}
		speechAreaVisualBounds={speechAreaVisualBounds}
	>
		{#snippet children()}
			<SoundControl
				volume={soundPreference.volume}
				onOpen={() => speechSoundController?.unlock()}
				onVolume={updateSoundVolume}
			/>
			<Chatter
				bind:this={chatterComponent}
				messages={recentMessageTimeline}
				tones={colorByPubkey}
				{selectedCharacterId}
				isDevWorldSandbox={devWorldSandboxEnabled}
				onOpenProfile={openProfile}
			/>
			<FieldScene
				geometryReady={initialFieldGeometryReady}
				{fieldAreaBounds}
				{fieldWorldSize}
				fieldArtworkBounds={fieldArtworkBounds}
				{field}
				{cellSize}
				{camera}
				cameraAnimating={visualMotion !== null}
				{traceMarkerCells}
				{proximityFeedback}
					{traceOnlyCellTriggers}
					{facilityCellTriggers}
					realtimeHoles={realtimeHoles}
					realtimeHoleTriggers={realtimeHoleTriggers}
					participatingRiftHoleId={riftSchedule.phase === 'registration' ? riftSelfHoleId : null}
					{participantViews}
				{selfProjectionId}
				{movingParticipantIds}
				{selfIsActive}
				{selfLogicalPosition}
				{traceRootGhost}
				{fieldActionMenu}
				resolveFieldCellSelection={resolveFieldCellSelection}
				executeFieldCellAction={executeFieldCellAction}
				fieldActionLabel={fieldActionLabel}
				closeFieldActionMenu={closeFieldActionMenu}
				onOpenProfile={openProfile}
				traceMarkerWorldPosition={traceMarkerWorldPosition}
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
			{#if lifespanHudNowMs !== null && personaSnapshot && !personaLifecycleTransition}
				{@const lifespanProjection = projectMending(personaSnapshot.gameState, lifespanHudNowMs, personaSnapshot.activeRun.rootBuild)}
				<LifespanHud expiresAtMs={lifespanProjection.effectiveExpiresAtMs} nowMs={lifespanHudNowMs} points={personaSnapshot.gameState.points} mendingProjection={lifespanProjection} />
			{/if}
		{/snippet}
	</FieldViewport>

	{#if riftEventEnabled && (!devWorldSandboxEnabled || devRiftFixtureEnabled)}
		<RiftPanel
			schedule={riftSchedule}
			nowMs={riftNowMs}
			status={realtimeStatus}
			session={riftSession}
			selfHoleId={riftSelfHoleId}
			selectedChoice={riftSelectedChoice}
			commitStatus={riftCommitStatus}
			canChoose={riftCanChoose}
			lastResult={devRiftLastResult ?? riftLastResult}
			onChoice={(choice) => { void chooseRiftChoice(choice); }}
		/>
	{/if}

	<RiftRulesDialog open={riftRulesDialogOpen} mode={riftRulesDialogMode} onOpenChange={(open) => {
		if (!open) discardPendingRiftJoin();
	}} onJoin={() => { void confirmRiftJoin(); }} onViewRules={() => {
		riftRulesDialogMode = 'rules';
		riftRulesDialogOpen = true;
	}} onCancel={discardPendingRiftJoin} />

	<ProfileDialog
		onOpenChange={handleProfileOpenChange}
		onCloseAutoFocus={restoreProfileTriggerFocus}
	/>
	<IdentitySelectionDialog selection={pendingIdentitySelection} rootPoints={pendingRootPoints} onSelect={(candidate, rootBuild) => { void chooseIdentity(candidate, rootBuild); }} onExportNsec={(candidate) => { void exportIdentityNsec(candidate); }} />
	<MendingDialog
		open={mendingDialogOpen}
		projection={mendingProjection}
		hasJob={Boolean(personaSnapshot?.gameState.mendingJob)}
		points={personaSnapshot?.gameState.points ?? 0}
		onOpenChange={(open) => { mendingDialogOpen = open; }}
		onStart={() => { void mutateMending('start'); }}
		onCollect={() => { void mutateMending('collect'); }}
	/>
	<AdjustmentDialog
		open={adjustmentDialogOpen}
		points={personaSnapshot?.gameState.points ?? 0}
		abilities={personaSnapshot?.gameState.abilities ?? { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }}
		busy={abilityMutationInFlight}
		onOpenChange={(open) => { adjustmentDialogOpen = open; }}
		onUpgrade={(key) => { void mutateAbility(key); }}
	/>
	<SelfProfileDialog
		open={selfProfileDialogOpen}
		persona={personaSnapshot}
		mendingProjection={mendingProjection}
		nowMs={mendingNowMs}
		clearBlockedReason={clearBlockedReason}
		clearBusy={clearMutationInFlight}
		onOpenChange={(open) => { selfProfileDialogOpen = open; }}
		onCloseAutoFocus={() => { lastSelfProfileTrigger?.focus(); }}
		onClear={() => { void clearCurrentRun(); }}
	/>

	{#if devWorldSandboxEnabled}
		<DevWorldControls
			scenario={devScenario!}
			{selectedCharacterId}
			traceReplyFixtureEnabled={devTraceReplyFixtureEnabled}
			canAddLiveReply={!devTraceReplies.some((reply) => reply.id === 'c'.repeat(64))}
			riftPlaygroundEnabled={devRiftPlaygroundEnabled}
			botPreset={devRiftPlaygroundState?.preset ?? 'cooperative'}
			canAdvanceRift={Boolean(devRiftPlaygroundState && devRiftPlayground?.canAdvance())}
			onCharacterChange={selectSandboxCharacter}
			onReset={resetDevScenario}
			onAddLiveReply={injectDevTraceLiveReply}
			onInjectLiveSpeech={injectDevLiveSpeech}
			onBotPresetChange={changeDevRiftPreset}
			onAdvanceRift={advanceDevRiftPhase}
		/>
	{:else if selfPositionWriteState.kind === 'retryable' && !isWorldSelfActive}
		<WorldEntryControls onRetry={retryWorldEntry} />
	{/if}

	{#if runtimeMode === 'relay' || devTraceReplyFixtureEnabled}
		<ComposerDock
			bind:this={composerComponent}
			{selectedSpeechType}
			submissionInProgress={composerSubmissionInProgress}
			hasUnreadReplies={traceReadSnapshot.hasUnreadReplies}
			character={selfProfileCharacter ?? speechSuggestionCharacter}
			avatarTone={colorByPubkey[selfProjectionId] ?? 'coral'}
			canOpenSelfProfile={selfProfileCharacter !== null}
			onOpenSelfProfile={(trigger) => { lastSelfProfileTrigger = trigger; selfProfileDialogOpen = true; }}
			suggestionConversation={speechSuggestionConversation}
			onSpeechTypeChange={(next) => { selectedSpeechType = next; }}
			submitContent={submitComposerContent}
			submitCandidate={submitSpeechCandidate}
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

	@media (max-width: 700px) {
		.app-shell {
			--composer-dock-height: calc(var(--composer-preferred-height) + 8px + 46px + 8px + var(--composer-dock-padding-block) + var(--composer-dock-border-width) + env(safe-area-inset-bottom));
			--composer-reserved-height: calc(var(--composer-initial-preferred-height) + 8px + 46px + 8px + var(--composer-dock-padding-block) + var(--composer-dock-border-width) + env(safe-area-inset-bottom));
		}
	}

</style>
