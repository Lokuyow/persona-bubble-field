<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
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
		moveOneCell,
		getResponsiveCellSize,
		MOBILE_FIELD_BREAKPOINT,
		gridToWorld,
		mergedBubblePreferredAnchor,
		normalBubblePreferredAnchor,
		placeBubbles,
		placeBubblesWithFixed,
		type Bounds,
		type Direction,
		type GridPosition,
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
		createDevCooperationDefectionPlayground,
		DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY,
		type DevCooperationDefectionBotPreset,
		type DevCooperationDefectionPlaygroundState,
		DevCooperationDefectionPlayground
	} from '$lib/dev/devCooperationDefectionPlayground';
	import { CHARACTER_CATALOG, getCharacterById, type Character } from '$lib/character';
	import ActionButton from '$lib/ActionButton.svelte';
import { requireCharacterFromPubkey } from '$lib/characterAssignment';
import { requireWorldCharacterFromPubkey } from '$lib/worldCharacterAssignment';
	import ProfileDialog from '$lib/ProfileDialog.svelte';
	import IdentitySelectionDialog from '$lib/IdentitySelectionDialog.svelte';
	import UnifiedStatusHud from '$lib/UnifiedStatusHud.svelte';
	import TagGameHud from '$lib/TagGameHud.svelte';
	import MendingDialog from '$lib/MendingDialog.svelte';
	import AdjustmentDialog from '$lib/AdjustmentDialog.svelte';
	import SelfProfileDialog from '$lib/SelfProfileDialog.svelte';
	import CooperationDefectionPanel from '$lib/CooperationDefectionPanel.svelte';
	import CooperationDefectionRulesDialog from '$lib/CooperationDefectionRulesDialog.svelte';
	import TagGamePanel from '$lib/TagGamePanel.svelte';
	import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL, TAG_GAME_TERMINAL, isBlockedFacilityCell, isWithinFacilityInteractionRange, sameFieldCell } from '$lib/fieldFacilities';
	import { projectMending } from '$lib/mending';
	import { comparePresenceEvidence, presenceEvidenceFromWorldState } from '$lib/presenceEvidence';
	import { getAbilityUpgrade, type PersonaAbilityKey } from '$lib/personaGameState';
	import {
		CURRENT_CHARACTER_PROFILE_REVISION,
		LIFECYCLE_UPGRADE_BLOCKED_MESSAGE,
		authorizeActiveRun,
		collectMending,
		loadOrCreateLifecycle,
		selectIdentity,
		transitionExpiredPersona,
		startMending,
		upgradePersonaAbility,
		applyRealtimeOutcome,
		applyRealtimeLifespanLoss,
		completeRealtimeEventInstance,
		getRealtimeSettlementLedger,
		trackRealtimeEventInstance,
		reserveTagGameParticipation,
		confirmTagGameParticipation,
		beginTagGameReservationRecovery,
		releaseTagGameParticipation,
		activateTagGameRun,
		applyTagGameCumulative,
		clearPersona,
		exportClearedIdentityNsec,
		type ActiveSignerSnapshot,
		type TerminalExitJournalRequest,
		type ClearedIdentityCandidate,
		type PersonaSnapshot,
		type PendingSelection,
		type SelectionCandidate
	} from '$lib/rootIdentity';
	import { rootMaximumLifespanMs, type RootBuild } from '$lib/rootProgression';
	import { isPersonaExpired } from '$lib/personaGameState';
	import { deathDevMode, DEATH_DEV_INITIAL_LIFESPAN_MS } from '$lib/deathDevMode';
	import { clearDevMode, CLEAR_DEV_INITIAL_POINTS } from '$lib/clearDevMode';
	import { consumeRunTransitionNotice, storeRunTransitionNotice, type RunTransitionNotice } from '$lib/runTransitionNotice';
	import {
		applyCooperationDefectionAction,
		buildCooperationDefectionActionTemplate,
		buildCooperationDefectionCommitAction,
		buildCooperationDefectionRevealAction,
		createCooperationDefectionNonce,
		createCooperationDefectionSession,
		enabledRealtimeEventDefinitions,
		getCooperationDefectionRoundSchedule,
		getCooperationDefectionSchedule,
		getCooperationDefectionScheduleForDate,
		getCooperationDefectionScheduleForInstance,
		getCooperationDefectionParticipantGroup,
		isManualCooperationDefectionControlScheduleEligible,
		compareManualCooperationDefectionControls,
		isCooperationDefectionSettlementComplete,
		cooperationDefectionPublicationKey,
		parseManualCooperationDefectionInstanceId,
		isRetiredRiftSettlementInstanceId,
		COOPERATION_DEFECTION_EVENT_DEFINITION,
		COOPERATION_DEFECTION_MIN_PARTICIPANTS,
		COOPERATION_DEFECTION_CONSULTATION_MS,
		COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS,
		parseCooperationDefectionEvent,
		cooperationDefectionPhaseLabel,
		settleCooperationDefectionSession,
		type CooperationDefectionChoice,
		type CooperationDefectionOutcome,
		type CooperationDefectionSessionState
	} from '$lib/cooperationDefection';
	import { finalizeRealtimeEvent, type RealtimeControlEnvelope } from '$lib/realtimeEvents';
	import type { RealtimeEnvelope } from '$lib/realtimeEvents';
	import { finalizeEvent } from 'nostr-tools/pure';
	import {
		TAG_GAME_BENEFIT_POINTS_PER_SECOND,
		TAG_GAME_FINAL_WAIT_MS,
		TAG_GAME_GAME_MS,
		TAG_GAME_LOBBY_MAX_AGE_SECONDS,
		TAG_GAME_LOBBY_RENEW_MS,
		TAG_GAME_NO_ACTIVITY_MS,
		TAG_GAME_PRECHECK_TIMEOUT_MS,
		TAG_GAME_RESPONSE_TIMEOUT_MS,
		TAG_GAME_RESERVATION_RECOVERY_MS,
		TAG_GAME_TOUCH_EVIDENCE_WAIT_MS,
		TAG_GAME_TOUCH_FEEDBACK_MS,
		TAG_GAME_TOUCH_RETRY_MS,
		TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND,
		TAG_GAME_KIND,
		TAG_GAME_ACTION_KIND,
		buildTagGameActionFilter,
		buildTagGameFilter,
		buildTagGameRecoveryFilter,
		buildTagGameTemplate,
		buildTagGameActionTemplate,
		createTagGameId,
		createTagGameSchedule,
		tagGameScheduledEffectAt,
		canRetryTagGamePositionProofRefresh,
		latestTagGameHolderActivityAt,
		TAG_GAME_POSITION_PROOF_REFRESH_MAX_ATTEMPTS,
		TAG_GAME_POSITION_PROOF_REFRESH_RETRY_MS,
		finalizeTagGameState,
		isFreshTagGameLobby,
		isFreshTagGameTouchAction,
		isTagGameTransferCooldownActive,
		isValidTagGameHolderResponse,
		isTagGameTouchProofSuperseded,
		isTagGameTouchPositionProof,
		leaveTagGameParticipant,
		parseTagGameActionEvent,
		parseTagGameEvent,
		tagGameEffectSafetyCutoffMs,
		type TagGameTouchPositionProof,
		type TagGameState
	} from '$lib/tagGame';
	import { isTagGameScheduledEffectActive, projectTagGameHud } from '$lib/tagGameHud';
	import { isOwnTagGameStartTransition } from '$lib/tagGamePresentation';
	import {
		prepareCharacterProfilePublication,
		publishCharacterProfile,
		type PreparedCharacterProfilePublication
	} from '$lib/initialProfilePublication';
	import { allocateParticipantColors, projectFrontendPresence, type Participant } from '$lib/frontend/presencePresentation';
	import { advanceMergedAnchorHistory } from '$lib/frontend/mergedAnchorHistory';
	import { debugTimeoutParticipant, PRESENCE_TIMEOUT_MS, type PresenceState } from '$lib/presence';
	import { addRecentMessage, createRecentMessageTimeline, type RecentMessageTimeline } from '$lib/recentMessageTimeline';
	import type { ParsedTraceReply, ParsedWorldMessage, ParsedWorldStateEvent } from '$lib/nostrProtocol';
	import type { ReducedPresenceParticipant } from '$lib/presenceEvidence';
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
	import ActionDock from '$lib/frontend/ActionDock.svelte';
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
	import { createSoundController, DEFAULT_SOUND_PREFERENCE, newLiveBubbleEffects, type SoundController } from '$lib/speechSoundEffects';
	import type { SpeechBubbleShape } from '$lib/speechBubblePath';
	import {
		createWorldReadSession,
		type SelfMessageAvailability,
		type SelfPositionWriteState,
		type TerminalExitPreparation,
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
	let cooperationDefectionPanelBounds = $state<Bounds | null>(null);
	let cooperationDefectionPanelObstacle = $derived(cooperationDefectionPanelBounds ? [{
		id: 'cooperation-defection-panel',
		preferred: { x: cooperationDefectionPanelBounds.x, y: cooperationDefectionPanelBounds.y },
		anchor: { x: cooperationDefectionPanelBounds.x, y: cooperationDefectionPanelBounds.y },
		size: { width: cooperationDefectionPanelBounds.width, height: cooperationDefectionPanelBounds.height }
	}] : []);
	let initialFieldGeometryReady = $state(false);
	let bubbleSizes = $state.raw<Record<string, Size>>({});
	let bubbleOverflowById = $state.raw<Record<string, boolean>>({});
	const mountedBubbleRemeasures = new Map<string, () => void>();
	const mountedTraceReplyRemeasures = new Map<string, () => void>();
	let conversationState = $state.raw<ConversationState>(createConversationState());
	let soundPreference = $state(DEFAULT_SOUND_PREFERENCE);
	let soundController = $state.raw<SoundController | null>(null);
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
	let runTransitionNotice = $state<RunTransitionNotice | null>(null);
	let pendingRootPoints = $state(0);
	let personaLifecycleTransition = $state(false);
	let lifespanHudNowMs = $state<number | null>(null);
	let lifespanHudUpdatedAtMs = 0;
	let topStatusHudBottom = $state(0);
	let statusHudVisible = $derived(lifespanHudNowMs !== null && personaSnapshot !== null && !personaLifecycleTransition);
	const observeTopStatusHud: Attachment<HTMLElement> = (node) => untrack(() => {
		const update = () => untrack(() => { topStatusHudBottom = node.getBoundingClientRect().bottom; });
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();
		return () => untrack(() => { observer.disconnect(); topStatusHudBottom = 0; });
	});
	let mendingNowMs = $state(0);
	let mendingDialogOpen = $state(false);
	let mendingMutationInFlight = $state(false);
	let collectFeedback = $state<Readonly<{ id: number; points: number; lifespanMs: number }> | null>(null);
	let collectFeedbackTimer: number | null = null;
	let mendingStartupFeedback = $state<Readonly<{ id: number; phase: 'starting' | 'started' }> | null>(null);
	let mendingStartupFeedbackTimer: number | null = null;
	let adjustmentDialogOpen = $state(false);
	let selfProfileDialogOpen = $state(false);
	let lastSelfProfileTrigger: HTMLButtonElement | null = null;
	let abilityMutationInFlight = $state(false);
	let upgradeFeedback = $state<Readonly<{ id: number; key: PersonaAbilityKey; level: number }> | null>(null);
	let upgradeFeedbackTimer: number | null = null;
	let feedbackSequence = 0;
	let clearMutationInFlight = $state(false);
	let pendingRealtimeSettlement = $state(false);
	let tagGamePanelOpen = $state(false);
	let tagGameBusy = $state(false);
	let tagGameWatchedGameId = $state<string | null>(null);
	let tagGameStates = $state.raw<readonly TagGameState[]>([]);
	let tagGameHudNowMs = $state(Date.now());
	let tagGameHudLastSecond = Math.floor(Date.now() / 1000);
	const tagGameEvents = new Map<string, { eventId: string; createdAt: number; state: TagGameState }>();
	let latestTagGameWorldStates = $state.raw(new Map<string, ParsedWorldStateEvent>());
	const appliedTagGameWorldStateIds = new Set<string>();
	const tagGameConflictSince = new Map<string, number>();
	const tagGameHostProbeAtMs = new Map<string, number>();
	let tagGameDiscoverySince = 0;
	const tagGameLastLobbyRenewalMs = new Map<string, number>();
	const tagGameLastPublishSeconds = new Map<string, number>();
	const tagGameHolderProbes = new Map<string, { challengeId: string; ownerPubkey: string; runNumber: number; startedAtMs: number; requestAcknowledgedAtMs: number | null; responseAtMs: number | null; lastAttemptAtMs: number; requestPending: boolean }>();
	const tagGameHolderLocalActivityAt = new Map<string, { ownerPubkey: string; runNumber: number; atMs: number }>();
	const tagGameSelfChallengeResponses = new Map<string, { challengeId: string; stage: 'precheck' | 'formal'; ownerPubkey: string; runNumber: number; createdAtMs: number; status: 'pending' | 'sent' }>();
	const tagGameEffectPauses = new Map<string, { challengeId: string; ownerPubkey: string; runNumber: number; pausedAtMs: number; statePublishPending: boolean; formalRequestPending: boolean; formalLastAttemptAtMs: number }>();
	const tagGameFormalChallengeAcks = new Map<string, number>();
	const tagGameHolderResponsePending = new Set<string>();
	let advancingTagGames = false;
	const tagGamePublishQueues = new Map<string, Promise<unknown>>();
	const tagGameTouchAttempts = new Map<string, number>();
	type TagGameProofRefreshAttempt = { gameId: string; pubkey: string; runNumber: number; mode: 'host-request' | 'local-refresh'; attempts: number; lastAttemptAtMs: number; inFlight: boolean; completed: boolean; baselineEvidenceId: string | null; requireNewEvidence: boolean; lastRequestEventId: string | null; restartAfterBatch: boolean; timer: number | null };
	const tagGameProofRefreshAttempts = new Map<string, TagGameProofRefreshAttempt>();
	const tagGamePositionEvidenceWaiters = new Set<() => void>();
	const tagGameTouchSeenEventIds = new Map<string, number>();
	const tagGameTouchStatusTimers = new Map<string, number>();
	const tagGameTouchStatusVersions = new Map<string, number>();
	const tagGameTouchStatusTargets = new Map<string, string>();
	let tagGameTouchStatusVersionSequence = 0;
	const tagGameTouchRequestVersions = new Map<string, number>();
	let tagGameTouchRequestVersionSequence = 0;
	const tagGamePositionEvidenceIdsByPubkey = new Map<string, string[]>();
	const tagGameWorldStateIdsByPubkey = new Map<string, string[]>();
	let tagGameTouchStatuses = $state.raw(new Map<string, Readonly<{ targetPubkey: string; label: string }>>());
	let tagGameTouchAttempt = $state.raw<Readonly<{ participantId: string; direction: Direction; id: number }> | null>(null);
	let tagGameTouchAttemptSequence = 0;
	let tagGameHolderTransfer = $state.raw<Readonly<{ participantId: string; id: number }> | null>(null);
	let tagGameHolderTransferSequence = 0;
	let tagGamePositionEvidence = $state.raw(new Map<string, ReducedPresenceParticipant>());
	const LIFESPAN_HUD_REFRESH_INTERVAL_MS = 30_000;
	let selfPositionWriteState = $state.raw<SelfPositionWriteState>({ kind: 'unavailable' });
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let traceReadSnapshot = $state<TraceReadSnapshot>({ readRootIds: [], unreadReplyRootIds: [], hasUnreadReplies: false });
	let composerPreferredHeight = $state<number | null>(null);
	let composerKeyboardInset = $state(0);
	let worldReader: ReturnType<typeof createWorldReadSession> | null = null;
	// Only an attached self (or a directly signed session) owns persona writes.
	let worldSession = $state.raw<ReturnType<typeof createWorldReadSession> | null>(null);
	const runtimeMode: 'relay' | 'dev' = initialDevWorldSandboxEnabled ? 'dev' : 'relay';
	const devWorldSandboxEnabled = initialDevWorldSandboxEnabled;
	const devCooperationDefectionStaticPhase = devScenario?.fixture.kind === 'cooperation-defection-static' ? devScenario.fixture.phase : null;
	const devCooperationDefectionPlaygroundEnabled = devScenario?.fixture.kind === 'cooperation-defection-playground';
	const devCooperationDefectionFixtureEnabled = devCooperationDefectionStaticPhase !== null || devCooperationDefectionPlaygroundEnabled;
	function devCooperationDefectionFixtureNowMs(): number {
		const schedule = getCooperationDefectionSchedule(Date.now());
		if (devCooperationDefectionStaticPhase === 'warning') return schedule.warningAtMs + 1_000;
		if (devCooperationDefectionStaticPhase === 'registration') return schedule.registrationAtMs + 1_000;
		if (devCooperationDefectionStaticPhase === 'game') return schedule.gameAtMs + COOPERATION_DEFECTION_CONSULTATION_MS + 1_000;
		if (devCooperationDefectionStaticPhase === 'ended') return schedule.endedAtMs + 1_000;
		return Date.now();
	}
	const initialCooperationDefectionNowMs = devCooperationDefectionPlaygroundEnabled ? 0 : devCooperationDefectionFixtureEnabled ? devCooperationDefectionFixtureNowMs() : Date.now();
	let actionDockAvailable = $derived(runtimeMode === 'relay' || devTraceReplyFixtureEnabled);
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
	let chatterComponent: { initialize(width: number): void; isInitialized(): boolean; resetMeasurements(): void };
	let chatterOpen = $state(false);
	const CHATTER_VISIBILITY_STORAGE_KEY = 'persona-bubble-field:chatter-open';

	function readChatterVisibility(): boolean | null {
		try {
			const value = window.localStorage.getItem(CHATTER_VISIBILITY_STORAGE_KEY);
			return value === 'true' ? true : value === 'false' ? false : null;
		} catch {
			return null;
		}
	}

	function setChatterOpen(open: boolean): void {
		chatterOpen = open;
		try {
			window.localStorage.setItem(CHATTER_VISIBILITY_STORAGE_KEY, String(open));
		} catch {
			// Storage may be unavailable; keep the in-memory control usable.
		}
	}

	function toggleChatter(): void {
		setChatterOpen(!chatterOpen);
	}

	function initializeChatterVisibility(width: number): void {
		chatterOpen = readChatterVisibility() ?? width > MOBILE_FIELD_BREAKPOINT;
	}
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
	type DeathPresentationPhase = 'intro' | 'last-words';
	type DeathPresentationState = Readonly<{
		session: ReturnType<typeof createWorldReadSession> | null;
		phase: DeathPresentationPhase;
		canonicalPosition: GridPosition | null;
		terminalExitPublication: Promise<void> | null;
	}>;
	const DEATH_INTRO_DURATION_MS = 2_400;
	let deathPresentation = $state.raw<DeathPresentationState | null>(null);
	let deathPresentationTimer: number | null = null;
	let deathPresentationElement = $state<HTMLElement | null>(null);
	let deathPresentationContent = $state('');
	let deathPresentationSubmitting = $state(false);
	$effect(() => {
		const presentation = deathPresentation;
		if (!presentation || typeof document === 'undefined') return;
		void tick().then(() => {
			if (deathPresentation === presentation) deathPresentationElement?.focus();
		});
	});
	let runRuntimeRefresh: (() => Promise<void>) | null = null;
	let startReadOnlyWorld: (() => void) | null = null;
	let startSelectedWorld: ((persona: PersonaSnapshot) => Promise<void>) | null = null;
	const realtimeEventRegistry = enabledRealtimeEventDefinitions();
	const cooperationDefectionEventEnabled = realtimeEventRegistry.some((definition) => definition.eventType === 'cooperation-defection');
	let realtimeStatus = $state<'inactive' | 'active' | 'degraded'>(devCooperationDefectionFixtureEnabled ? 'active' : 'inactive');
	let cooperationDefectionRealtimeBootstrapComplete = $state(devCooperationDefectionFixtureEnabled);
	let cooperationDefectionSchedule = $state(getCooperationDefectionSchedule(initialCooperationDefectionNowMs));
	let cooperationDefectionNowMs = $state(initialCooperationDefectionNowMs);
	let cooperationDefectionStartSoundPreviousSchedule: { instanceId: string; phase: string } | null = null;
	let cooperationDefectionStartSoundEligibleInstanceId: string | null = null;
	let cooperationDefectionStartSoundPendingInstanceId: string | null = null;
	let cooperationDefectionStartSoundPlayedInstanceId: string | null = null;
	const cooperationDefectionJstDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
		timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
	});
	let cooperationDefectionRegistrationDeadline = $derived.by(() => {
		if (cooperationDefectionSchedule.phase !== 'registration') return null;
		const remainingSeconds = Math.max(0, Math.ceil((cooperationDefectionSchedule.gameAtMs - cooperationDefectionNowMs) / 1_000));
		return {
			deadline: `${cooperationDefectionJstDateTimeFormatter.format(new Date(cooperationDefectionSchedule.gameAtMs))} JST`,
			remaining: `${Math.floor(remainingSeconds / 60).toString().padStart(2, '0')}:${(remainingSeconds % 60).toString().padStart(2, '0')}`
		};
	});
	let cooperationDefectionSession = $state.raw<CooperationDefectionSessionState | null>(null);
	let cooperationDefectionSelection = $state<Readonly<{ round: 1 | 2 | 3; choice: CooperationDefectionChoice; nonce: string; commitId: string | null; commitPublished: boolean; revealAttempted: boolean; revealStatus: 'idle' | 'sending' | 'published' | 'failed' }> | null>(null);
	let cooperationDefectionSettlementInFlight = $state(false);
	let cooperationDefectionRulesDialogOpen = $state(false);
	let cooperationDefectionRulesDialogMode = $state<'rules' | 'join-confirmation'>('rules');
	let pendingCooperationDefectionJoin = $state<{ instanceId: string; groupId: string; position: { x: number; y: number } } | null>(null);
	const appliedCooperationDefectionOutcomeIds = new Set<string>();
	const realtimeRecoveryInstanceIds = new Set<string>();
	let realtimeControlSince = 0;
	let realtimeControlDateKey = '';
	const realtimeControlIds = new Set<string>();
	let selectedManualCooperationDefectionInstanceId: string | null = null;
	const pendingRealtimeControls: RealtimeControlEnvelope[] = [];
	const recoveredCooperationDefectionSessions = new Map<string, CooperationDefectionSessionState>();
	let devCooperationDefectionPlayground = $state<DevCooperationDefectionPlayground | null>(null);
	let devCooperationDefectionPlaygroundState = $state.raw<DevCooperationDefectionPlaygroundState | null>(null);
	const movementInputController = createMovementInputController({
		requestDirectionalAction: attemptTagGameTouch,
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
		y: Math.max(SPEECH_AREA.top, topStatusHudBottom + 8),
		width: Math.max(0, viewportSize.width - SPEECH_AREA.sidePadding * 2),
		height: Math.max(0, actualFieldTop - Math.max(SPEECH_AREA.top, topStatusHudBottom + 8))
	});
	let bubbleVisualRegion = $derived({
		x: 0,
		y: bubbleSafeBounds.y,
		width: viewportSize.width,
		height: Math.max(bubbleSafeBounds.height, ...Object.values(bubbleSizes).map((size) => size.height))
	});

	let participantViews: FieldParticipantView[] = $derived(presenceProjection.participants
		.filter((participant) => !(deathPresentation && participant.id === selfProjectionId))
		.map((participant) => {
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
	let canUseMendingTerminal = $derived(!devWorldSandboxEnabled && !personaLifecycleTransition && Boolean(worldSession && personaSnapshot && selfIsActive && selfLogicalPosition && isWithinFacilityInteractionRange(selfLogicalPosition)));
	let tagGameSelfActiveGameId = $derived(personaSnapshot ? tagGameStates.find((game) => (game.phase === 'running' || game.phase === 'settling') && game.participant.some((member) => member.pubkey === personaSnapshot?.signer.pubkey && member.runNumber === personaSnapshot.activeRun.runNumber && (member.status === 'active' || member.status === 'temporarily-ineligible')))?.gameId ?? null : null);
	let tagGameReservationGameId = $derived(personaSnapshot?.tagGame?.lock?.gameId ?? (personaSnapshot?.tagGame?.reservation?.expiresAtMs !== undefined && personaSnapshot.tagGame.reservation.expiresAtMs <= mendingNowMs ? null : personaSnapshot?.tagGame?.reservation?.gameId) ?? null);
	let tagGameReservationStatus = $derived(personaSnapshot?.tagGame?.lock ? 'active' as const : tagGameStates.some((game) => game.gameId === tagGameReservationGameId && game.participant.some((member) => member.pubkey === personaSnapshot?.signer.pubkey && member.runNumber === personaSnapshot.activeRun.runNumber)) ? 'registered' as const : personaSnapshot?.tagGame?.reservation?.expiresAtMs !== undefined ? 'pending' as const : 'registered' as const);
	let tagGameWatchedGame = $derived(tagGameWatchedGameId ? tagGameStates.find((game) => game.gameId === tagGameWatchedGameId && (game.phase === 'running' || game.phase === 'settling')) ?? null : null);
	let tagGameDisplayedGameId = $derived(tagGameSelfActiveGameId ?? tagGameWatchedGame?.gameId ?? null);
	let tagGameLocalLock = $derived(Boolean(personaSnapshot && tagGameSelfActiveGameId));
	let tagGameDisplayedGame = $derived(tagGameStates.find((candidate) => candidate.gameId === tagGameDisplayedGameId && (candidate.phase === 'running' || candidate.phase === 'settling')) ?? null);
	// Keep the received final cumulative value visible while its lifecycle receipt is being applied.
	let tagGameHudGameId = $derived.by(() => {
		if (tagGameSelfActiveGameId) return tagGameSelfActiveGameId;
		const self = personaSnapshot;
		const lock = self?.tagGame?.lock;
		if (!lock || !self) return null;
		return tagGameStates.some((game) => game.gameId === lock.gameId &&
			(game.phase === 'ended' || game.phase === 'interrupted') &&
			game.participant.some((member) => member.pubkey === self.signer.pubkey && member.runNumber === self.activeRun.runNumber)) ? lock.gameId : null;
	});
	let tagGameHudWorkProjection = $derived.by(() => tagGameHudGameId && personaSnapshot
		? projectMending(personaSnapshot.gameState, tagGameHudNowMs, personaSnapshot.activeRun.rootBuild)
		: null);
	let tagGameHudProjection = $derived.by(() => {
		if (!tagGameHudGameId || !personaSnapshot || !tagGameHudWorkProjection) return null;
		const game = tagGameStates.find((candidate) => candidate.gameId === tagGameHudGameId) ?? null;
		const lock = personaSnapshot.tagGame?.lock;
		const holder = game?.participant.find((member) => member.pubkey === game.ownerPubkey);
		const localPause = game?.hostPubkey === personaSnapshot.signer.pubkey ? tagGameEffectPauses.get(game.gameId) : null;
		const effectPausedAtMs = localPause && localPause.ownerPubkey === game?.ownerPubkey && localPause.runNumber === holder?.runNumber
			? localPause.pausedAtMs
			: undefined;
		return projectTagGameHud({
			game,
			selfPubkey: personaSnapshot.signer.pubkey,
			selfRunNumber: personaSnapshot.activeRun.runNumber,
			localLockGameId: lock?.gameId ?? null,
			localAppliedPoints: lock?.points ?? 0,
			localAppliedLossMs: lock?.lifespanLossMs ?? 0,
			effectPausedAtMs,
			savedPoints: personaSnapshot.gameState.points,
			effectiveExpiresAtMs: tagGameHudWorkProjection.effectiveExpiresAtMs,
			nowMs: tagGameHudNowMs,
			holderActivityAtMs: game && game.ownerPubkey === personaSnapshot.signer.pubkey ? tagGameHolderActivityAt(game, tagGameHudNowMs) : undefined
		});
	});
	let tagGameDisplayedEffect = $derived.by(() => {
		const game = tagGameDisplayedGame;
		if (!game) return null;
		const holder = game.participant.find((member) => member.pubkey === game.ownerPubkey);
		const self = personaSnapshot;
		const localPause = self && game.hostPubkey === self.signer.pubkey ? tagGameEffectPauses.get(game.gameId) : null;
		const locallyPaused = Boolean(localPause && localPause.ownerPubkey === game.ownerPubkey && localPause.runNumber === holder?.runNumber && tagGameHudNowMs >= localPause.pausedAtMs);
		return { effect: tagGameScheduledEffectAt(game, tagGameHudNowMs), locallyPaused,
			active: isTagGameScheduledEffectActive(game, tagGameHudNowMs) && !game.holderChallengeId && !locallyPaused && holder?.status === 'active' };
	});
	let tagGameRoleByPubkey = $derived.by(() => {
		const roles = new Map<string, 'participant' | 'holder'>();
		const game = tagGameStates.find((candidate) => candidate.gameId === tagGameDisplayedGameId);
		if (!game) return roles;
		for (const member of game.participant) {
			const latest = latestTagGameWorldStates.get(member.pubkey);
			if ((member.status === 'active' || member.status === 'temporarily-ineligible') && latest?.state === 'active' && latest.runNumber === member.runNumber) {
				roles.set(member.pubkey, member.pubkey === game.ownerPubkey ? 'holder' : 'participant');
			}
		}
		return roles;
	});
	let tagGameTouchTargetIds = $derived.by(() => {
		const targets = new Set<string>();
		const game = tagGameDisplayedGame;
		const self = personaSnapshot;
		if (!game || game.phase !== 'running' || !tagGameDisplayedEffect?.active || !self) return targets;
		const own = game.participant.find((member) => member.pubkey === self.signer.pubkey && member.runNumber === self.activeRun.runNumber && member.status === 'active');
		const ownPresence = tagGamePositionEvidence.get(self.signer.pubkey);
		if (!own || !ownPresence || ownPresence.lastPositiveActivityCreatedAt === null ||
			(ownPresence.latestExitCreatedAt !== null && ownPresence.lastPositiveActivityCreatedAt <= ownPresence.latestExitCreatedAt) ||
			tagGameHudNowMs - ownPresence.lastPositiveActivityCreatedAt * 1_000 >= PRESENCE_TIMEOUT_MS) return targets;
		const ownAnchor = latestTagGameWorldStates.get(self.signer.pubkey);
		if (ownAnchor && (ownAnchor.state !== 'active' || ownAnchor.runNumber !== own.runNumber)) return targets;
		const currentEffect = tagGameDisplayedEffect?.effect;
		const shouldChaseHolder = currentEffect === 'benefit' ? self.signer.pubkey !== game.ownerPubkey : currentEffect === 'calamity' && self.signer.pubkey === game.ownerPubkey;
		if (!shouldChaseHolder) return targets;
		for (const member of game.participant) {
			if (member.pubkey === self.signer.pubkey || member.status !== 'active') continue;
			const targetAnchor = latestTagGameWorldStates.get(member.pubkey);
			const targetPresence = tagGamePositionEvidence.get(member.pubkey);
			const targetWorldPresence = presenceState.participants.find((participant) => participant.id === member.pubkey);
			if ((targetAnchor && (targetAnchor.state !== 'active' || targetAnchor.runNumber !== member.runNumber)) || !targetPresence || !targetWorldPresence || targetWorldPresence.status !== 'active' ||
				targetPresence.lastPositiveActivityCreatedAt === null || (targetPresence.latestExitCreatedAt !== null && targetPresence.lastPositiveActivityCreatedAt <= targetPresence.latestExitCreatedAt)) continue;
			if (tagGameHudNowMs - targetPresence.lastPositiveActivityCreatedAt * 1_000 >= PRESENCE_TIMEOUT_MS) continue;
			const isHolder = member.pubkey === game.ownerPubkey;
			if ((currentEffect === 'benefit' && !isHolder) || (currentEffect === 'calamity' && isHolder)) continue;
			if (Math.max(Math.abs(ownPresence.position.x - targetPresence.position.x), Math.abs(ownPresence.position.y - targetPresence.position.y)) === 1) targets.add(member.pubkey);
		}
		return targets;
	});
	let canUseAdjustmentTerminal = $derived(!devWorldSandboxEnabled && !personaLifecycleTransition && !tagGameLocalLock && Boolean(worldSession && personaSnapshot && selfIsActive && selfLogicalPosition && isWithinFacilityInteractionRange(selfLogicalPosition, ADJUSTMENT_TERMINAL)));
	let canUseTagGameTerminal = $derived(!devWorldSandboxEnabled && !personaLifecycleTransition && Boolean(worldSession && selfIsActive && selfLogicalPosition && isWithinFacilityInteractionRange(selfLogicalPosition, TAG_GAME_TERMINAL)));
	// Keep terminal states in tagGameEvents for recovery and delayed-action rejection,
	// but a pre-start host cancellation is not a playable game or a result card.
	let visibleTagGameStates = $derived(tagGameStates.filter((game) => game.endReason !== 'host-cancelled' && (isFreshTagGameLobby(game, Math.floor(Date.now() / 1000)) || game.phase !== 'lobby')));
	let clearBlockedReason = $derived(!personaSnapshot ? 'Runがありません' : tagGameLocalLock ? '鬼ごっこ終了後の精算中です' : personaSnapshot.gameState.points < 100_000 ? '所持ポイントが100,000pt未満です' : isPersonaExpired(personaSnapshot.gameState, mendingNowMs, personaSnapshot.activeRun.rootBuild) ? '寿命が尽きています' : pendingRealtimeSettlement ? '協力と抜け駆けの精算が未完了です' : null);
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
			unreadReply: traceReadSnapshot.unreadReplyRootIds.includes(cell.roots[0].id),
			kind: cell.roots[0].source === 'death' ? 'death' : 'normal'
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
	let facilityCellTriggers = $derived([MENDING_TERMINAL.position, ADJUSTMENT_TERMINAL.position, TAG_GAME_TERMINAL.position]);
	let realtimeGroups = $derived(!cooperationDefectionEventEnabled || cooperationDefectionSchedule.phase === 'dormant' || cooperationDefectionSchedule.phase === 'ended' ? [] : (cooperationDefectionSession?.groups ?? createCooperationDefectionSession({ instanceId: cooperationDefectionSchedule.instanceId, field }).groups));
	let realtimeGroupTriggers = $derived(cooperationDefectionSchedule.phase === 'registration' ? realtimeGroups : []);
	let cooperationDefectionActorPubkey = $derived(devCooperationDefectionPlaygroundEnabled ? DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY : selfSigner?.pubkey ?? null);
	let cooperationDefectionSelfGroupId = $derived(cooperationDefectionActorPubkey && cooperationDefectionSession ? getCooperationDefectionParticipantGroup(cooperationDefectionSession, cooperationDefectionSchedule, cooperationDefectionActorPubkey) : null);
	let cooperationDefectionSelfGroupCancelled = $derived(Boolean(cooperationDefectionSelfGroupId && cooperationDefectionSession?.cancelledGroupIds.includes(cooperationDefectionSelfGroupId)));
	let cooperationDefectionRound = $derived(cooperationDefectionSchedule.phase === 'game'
		? ([1, 2, 3] as const).find((round) => cooperationDefectionNowMs < getCooperationDefectionRoundSchedule(cooperationDefectionSchedule, round).endedAtMs) ?? 3
		: null);
	let cooperationDefectionRoundSchedule = $derived(cooperationDefectionRound ? getCooperationDefectionRoundSchedule(cooperationDefectionSchedule, cooperationDefectionRound) : null);
	let cooperationDefectionCanChoose = $derived(Boolean(cooperationDefectionSchedule.phase === 'game' && cooperationDefectionRealtimeBootstrapComplete && !cooperationDefectionSelfGroupCancelled && cooperationDefectionRoundSchedule && cooperationDefectionNowMs >= cooperationDefectionRoundSchedule.selectionAtMs && cooperationDefectionNowMs < cooperationDefectionRoundSchedule.resultAtMs && cooperationDefectionSelfGroupId && realtimeStatus === 'active' && (devCooperationDefectionPlaygroundEnabled ? !devCooperationDefectionPlaygroundState?.selfChoice : Boolean(personaSnapshot)) && !(cooperationDefectionSelection?.round === cooperationDefectionRound && cooperationDefectionSelection.commitPublished)));
	let cooperationDefectionSelectedChoice = $derived(devCooperationDefectionPlaygroundEnabled
		? devCooperationDefectionPlaygroundState?.selfChoice ?? null
		: cooperationDefectionSelection?.round === cooperationDefectionRound ? cooperationDefectionSelection.choice : null);
	let cooperationDefectionCommitStatus = $derived(devCooperationDefectionPlaygroundEnabled
		? devCooperationDefectionPlaygroundState?.selfChoice ? '秘密選択を送信済み' : null
		: cooperationDefectionSelection && cooperationDefectionSelection.round === cooperationDefectionRound
			? cooperationDefectionSelection.revealStatus === 'published' ? '選択を自動公開済み' : cooperationDefectionSelection.revealStatus === 'sending' ? '選択を自動公開中' : cooperationDefectionSelection.revealStatus === 'failed' ? '自動公開エラー（結果未確認）' : cooperationDefectionSelection.commitPublished ? '秘密選択を送信済み' : '未送信'
			: null);
	function cooperationDefectionParticipantName(pubkey: string): string {
		try { return requireCharacterFromPubkey(pubkey).name; }
		catch { return pubkey.slice(0, 8); }
	}

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
		const session = worldReader;
		if (!ready || !layout || !ghost || !session || typeof document === 'undefined') return;
		void tick().then(() => {
			if (worldReader !== session || !tracePresentationReady) return;
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
		bubbleVisualRegion,
		cooperationDefectionPanelObstacle
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
			fixedObstacles: cooperationDefectionPanelObstacle,
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
		const appSoundController = createSoundController({ storage: soundStorage, document });
		soundController = appSoundController;
		soundPreference = appSoundController.preference;
		const unlockSound = () => appSoundController.unlock();
		window.addEventListener('pointerdown', unlockSound, { passive: true });
		window.addEventListener('keydown', unlockSound, { passive: true });
		let startRequested = false;
		let currentSessionStartup: { session: ReturnType<typeof createWorldReadSession>; promise: Promise<void> } | null = null;
		let localLifecycleReady = false;
		let pendingBootstrapMessages: ParsedWorldMessage[] | null = null;
		const restoreMeasuredBootstrapConversation = () => {
			if (!pendingBootstrapMessages || !localLifecycleReady || !initialFieldGeometryReady) return;
			const messages = pendingBootstrapMessages;
			pendingBootstrapMessages = null;
			// The reader may have projected presence before the restored self id existed.
			syncVisualToCanonical();
			restoreBootstrapConversation(messages, presenceState, Date.now());
		};
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
			if (devCooperationDefectionPlaygroundEnabled) {
				devCooperationDefectionPlayground = createDevCooperationDefectionPlayground(FIELD);
				devCooperationDefectionPlaygroundState = devCooperationDefectionPlayground.snapshot;
				cooperationDefectionSchedule = devCooperationDefectionPlaygroundState.schedule;
				cooperationDefectionNowMs = devCooperationDefectionPlaygroundState.nowMs;
				cooperationDefectionSession = devCooperationDefectionPlaygroundState.session;
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
			if (devCooperationDefectionFixtureEnabled && !devCooperationDefectionPlaygroundEnabled) reconcileCooperationDefectionSession(initialCooperationDefectionNowMs);
		}

		function getRealtimeStartConfiguration(nowMs: number): RealtimeStartConfiguration {
			const currentSchedule = getCooperationDefectionSchedule(nowMs);
			if (realtimeControlDateKey !== currentSchedule.dateKey) {
				realtimeControlDateKey = currentSchedule.dateKey;
				realtimeControlSince = Math.max(0, Math.floor(nowMs / 1000) - COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS);
			}
			const recoveryInstanceIds = [...realtimeRecoveryInstanceIds].filter((instanceId) => getCooperationDefectionScheduleForInstance(instanceId, nowMs) !== null);
			const includeCurrent = currentSchedule.phase === 'registration' || currentSchedule.phase === 'game';
			const activeManual = selectedManualCooperationDefectionInstanceId ? getCooperationDefectionScheduleForInstance(selectedManualCooperationDefectionInstanceId, nowMs) : null;
			const instanceIds = [...new Set([...recoveryInstanceIds, ...(includeCurrent ? [currentSchedule.instanceId] : []), ...(activeManual && (activeManual.phase === 'registration' || activeManual.phase === 'game') ? [activeManual.instanceId] : [])])];
			const schedules = [...recoveryInstanceIds.map((instanceId) => getCooperationDefectionScheduleForInstance(instanceId, nowMs)), ...(includeCurrent ? [currentSchedule] : []), activeManual]
				.filter((schedule): schedule is typeof currentSchedule => schedule !== null);
			const since = Math.floor(Math.min(...schedules
				.filter((schedule): schedule is typeof currentSchedule => schedule !== null)
				.map((schedule) => schedule.warningAtMs)) / 1000);
			const channelId = worldReader?.getChannel()?.channelId;
		if (tagGameDiscoverySince === 0) tagGameDiscoverySince = Math.max(0, Math.floor(nowMs / 1000) - TAG_GAME_LOBBY_MAX_AGE_SECONDS);
			return {
				controlSince: realtimeControlSince,
				instanceFilters: instanceIds.length === 0 ? [] : [{ protocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey, instanceIds, since }],
				supplementalFilters: channelId ? [
					buildTagGameFilter(channelId, tagGameDiscoverySince),
					buildTagGameActionFilter(channelId, tagGameDiscoverySince),
					...(personaSnapshot?.tagGame?.reservation?.expiresAtMs === undefined && personaSnapshot?.tagGame?.reservation
						? [buildTagGameRecoveryFilter(channelId, personaSnapshot.tagGame.reservation.gameId)] : [])
				] : []
			};
		}

		function prepareRealtimeStartConfiguration(configuration: RealtimeStartConfiguration, nowMs: number): RealtimeStartConfiguration {
			realtimeControlSince = Math.max(0, Math.floor(nowMs / 1000) - COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS);
			return { ...configuration, controlSince: realtimeControlSince };
		}

		const startReadSession = async (
			signer: ActiveSignerSnapshot | null,
			characterProfilePublication: PreparedCharacterProfilePublication | null = null,
			authorizationRunNumber: number | null = signer ? personaSnapshot?.activeRun.runNumber ?? null : null,
			realtimeStartImmediately: boolean | undefined = undefined
		): Promise<void> => {
		tagGameDiscoverySince = 0;
			const previousSession = worldReader;
			worldReader = null;
			pendingBootstrapMessages = null;
			if (worldSession === previousSession) worldSession = null;
			previousSession?.dispose();
			selfPositionWriteState = { kind: 'unavailable' };
			selfMessageAvailability = { kind: 'unavailable' };
			entryRetryable = false;
			cooperationDefectionRealtimeBootstrapComplete = devCooperationDefectionFixtureEnabled;
			let nextSession!: ReturnType<typeof createWorldReadSession>;
			nextSession = createWorldReadSession({
				field: FIELD,
				selfSigner: signer,
				...(signer && authorizationRunNumber !== null ? { selfRunNumber: authorizationRunNumber } : {}),
					realtime: {
					registry: realtimeEventRegistry,
					controlSince: Math.max(0, Math.floor(Date.now() / 1000) - 15 * 60),
					instanceFilters: [],
					supplementalFilters: [],
					onSupplementalEvent: handleTagGameSupplementalEvent,
					getStartConfiguration: () => getRealtimeStartConfiguration(Date.now()),
					prepareStartConfiguration: prepareRealtimeStartConfiguration,
					startImmediately: realtimeStartImmediately ?? true,
					onEvent: handleRealtimeEnvelope,
					onControl: handleRealtimeControl,
					onBootstrapComplete: () => {
						if (!mounted || worldReader !== nextSession) return;
						cooperationDefectionRealtimeBootstrapComplete = true;
						selectBootstrapRealtimeControl();
						reconcileCooperationDefectionSession(Date.now());
					},
					onStatusChanged: (next) => {
						if (!mounted || worldReader !== nextSession) return;
						realtimeStatus = next;
						if (next === 'inactive') cooperationDefectionRealtimeBootstrapComplete = false;
					}
				},
				...(signer && authorizationRunNumber !== null ? {
					authorizeSelfWrite: () => authorizeActiveRun({ identity: signer.identity, runNumber: authorizationRunNumber }),
					onSelfWriteAuthorizationLost: () => {
						if (!personaLifecycleTransition && !deathTransitionInFlight) window.location.reload();
					}
				} : {}),
				onPresenceChanged: acceptPresence,
				onPositionEvidenceChanged: acceptTagGamePositionEvidence,
				onWorldStateEvent: handleTagGameWorldState,
				onLiveMessage: receiveLiveMessage,
				onTimelineMessage: receiveSessionTimelineMessage,
				onEffectiveTraceRootsChanged: setEffectiveTraceRoots,
				onTraceReadSnapshotChanged: (snapshot) => { traceReadSnapshot = snapshot; },
				onTraceConversationChanged: setTraceConversation,
				onStatusChanged: (status) => {
					if (!mounted || worldReader !== nextSession) return;
					connectionStatus = status;
					if (status.kind === 'failed') setComposerTerminalError(new Error(status.message));
				},
				onSelfPositionWriteStateChanged: (state) => {
					if (!mounted || worldReader !== nextSession) return;
					selfPositionWriteState = state;
					if ('operation' in state && state.operation === 'entry') {
						if (state.kind === 'retryable') {
							entryRetryable = true;
							cancelPendingComposerSubmission(new Error('World entry was not confirmed by Relay.'));
						} else if (state.kind === 'pending' || state.kind === 'succeeded') entryRetryable = false;
					}
				},
				onSelfMessageAvailabilityChanged: (state) => {
					if (!mounted || worldReader !== nextSession) return;
					selfMessageAvailability = state;
					if (state.kind === 'ready' && worldSession === nextSession) resolvePendingComposerSubmission();
				}
			});
			worldReader = nextSession;
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
				if (!mounted || worldReader !== nextSession) {
					nextSession.dispose();
					return;
				}
				recentMessageTimeline = createRecentMessageTimeline([
					...recentMessageTimeline,
					...bootstrap.timelineMessages
				]);
				pendingBootstrapMessages = [...bootstrap.messages];
				restoreMeasuredBootstrapConversation();
				nextSession.completeBootstrap();
				if (signer) {
					worldSession = nextSession;
					personaLifecycleTransition = false;
					if (selfMessageAvailability.kind === 'ready') resolvePendingComposerSubmission();
				}
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
				if (worldReader === nextSession) setComposerTerminalError(new Error('Relay startup failed.'));
			}
		};
		const receiveSessionTimelineMessage = (message: ParsedWorldMessage) => {
			receiveTimelineMessage(message);
			if (pendingBootstrapMessages && !pendingBootstrapMessages.some((pending) => pending.id === message.id)) {
				pendingBootstrapMessages.push(message);
			}
		};
		startReadOnlyWorld = () => { void startReadSession(null, null, null, false); };
		const promoteOrStartSignedWorld = async (
			persona: PersonaSnapshot,
			characterProfilePublication: PreparedCharacterProfilePublication | null,
			restored = false
		): Promise<void> => {
			const anonymousSession = worldReader;
			const anonymousStartup = currentSessionStartup;
			if (anonymousSession && anonymousStartup?.session === anonymousSession && !worldSession &&
				(!persona.tagGame?.reservation || persona.tagGame.reservation.expiresAtMs !== undefined)) {
				try {
					await Promise.race([anonymousStartup.promise, anonymousSession.whenSelfReadReady()]);
					if (restored && isPersonaExpired(persona.gameState, Date.now(), persona.activeRun.rootBuild)) {
						personaLifecycleTransition = false;
						await beginDeathTransition(persona, null, false);
						return;
					}
					if (worldReader !== anonymousSession || anonymousSession.getStatus().kind === 'failed') throw new Error('Anonymous world session is unavailable.');
					await anonymousSession.attachSelf({
						signer: persona.signer,
						runNumber: persona.activeRun.runNumber,
						authorizeSelfWrite: () => authorizeActiveRun({ identity: persona.signer.identity, runNumber: persona.activeRun.runNumber }),
						onSelfWriteAuthorizationLost: () => {
							if (!personaLifecycleTransition && !deathTransitionInFlight) window.location.reload();
						}
					});
					if (worldReader !== anonymousSession) throw new Error('World session changed during self attachment.');
					worldSession = anonymousSession;
					personaLifecycleTransition = false;
					if (selfMessageAvailability.kind === 'ready') resolvePendingComposerSubmission();
					mendingNowMs = Date.now();
					updateLifespanHud(mendingNowMs, true);
					await anonymousSession.enterSelf();
					if (characterProfilePublication) {
						void anonymousStartup.promise.then(() => publishCharacterProfile(characterProfilePublication, (event) => {
							if (personaLifecycleTransition || worldSession !== anonymousSession) {
								return Promise.reject(new Error('Persona is unavailable for publishing.'));
							}
							return anonymousSession.publish(event);
						})).catch(() => {});
					}
					return;
				} catch {
					// A failed or superseded anonymous startup cannot be promoted.
				}
			}
			// The anonymous startup error belongs to the superseded attempt, not this fresh signed session.
			if (restored && isPersonaExpired(persona.gameState, Date.now(), persona.activeRun.rootBuild)) {
				personaLifecycleTransition = false;
				await beginDeathTransition(persona, null, false);
				return;
			}
			composerStartupError = null;
			const startup = startReadSession(persona.signer, characterProfilePublication, persona.activeRun.runNumber, true);
			// The signed session replaces the reader synchronously before its first await.
			mendingNowMs = Date.now();
			updateLifespanHud(mendingNowMs, true);
			await startup;
		};
		async function loadPendingCooperationDefectionInstances(persona: PersonaSnapshot): Promise<readonly string[]> {
			let ledger = await getRealtimeSettlementLedger(persona);
			for (const instanceId of ledger?.pendingInstanceIds ?? []) {
				if (isRetiredRiftSettlementInstanceId(instanceId)) await completeRealtimeEventInstance(persona, instanceId);
			}
			ledger = await getRealtimeSettlementLedger(persona);
			return ledger?.pendingInstanceIds ?? [];
		}

		startSelectedWorld = async (persona: PersonaSnapshot): Promise<void> => {
			personaSnapshot = persona;
			pendingRootPoints = persona.rootPoints;
			selfSigner = persona.signer;
			if (initialFieldGeometryReady) syncVisualToCanonical();
			pendingIdentitySelection = null;
			composerStartupError = null;
			entryRetryable = false;
			selfPositionWriteState = { kind: 'unavailable' };
			selfMessageAvailability = { kind: 'unavailable' };
			connectionStatus = { kind: 'bootstrapping' };
			realtimeRecoveryInstanceIds.clear();
			const pendingInstanceIds = await loadPendingCooperationDefectionInstances(persona);
			pendingRealtimeSettlement = pendingInstanceIds.length > 0;
			for (const instanceId of pendingInstanceIds
				.filter((id) => getCooperationDefectionScheduleForInstance(id, Date.now()) !== null)) {
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
			await promoteOrStartSignedWorld(persona, characterProfilePublication);
		};

		const begin = async () => {
			if (devWorldSandboxEnabled || startRequested) return;
			startRequested = true;
			const transitionNotice = consumeRunTransitionNotice();
			let characterProfilePublication: PreparedCharacterProfilePublication | null = null;
			try {
				const personaResult = await loadOrCreateLifecycle();
				if (personaResult.kind === 'created' || personaResult.kind === 'selecting') {
					pendingIdentitySelection = personaResult.selection;
					pendingRootPoints = personaResult.rootPoints;
					runTransitionNotice = transitionNotice;
					selfSigner = null;
					personaSnapshot = null;
				} else if (personaResult.kind !== 'restored') {
					runTransitionNotice = null;
					setComposerTerminalError(new Error('Persona is unavailable for publishing.'));
				} else {
					runTransitionNotice = null;
					personaSnapshot = personaResult.persona;
					const reservation = personaSnapshot.tagGame?.reservation;
					if (reservation && reservation.expiresAtMs === undefined && !personaSnapshot.tagGame?.lock) {
						if (await beginTagGameReservationRecovery(personaSnapshot, reservation.gameId, Date.now() + TAG_GAME_RESERVATION_RECOVERY_MS)) {
							await refreshTagGamePersona(personaSnapshot);
						}
					}
					pendingRootPoints = personaResult.persona.rootPoints;
					selfSigner = personaResult.persona.signer;
					if (initialFieldGeometryReady) syncVisualToCanonical();
					const pendingInstanceIds = (await loadPendingCooperationDefectionInstances(personaResult.persona))
						.filter((instanceId) => getCooperationDefectionScheduleForInstance(instanceId, Date.now()) !== null);
					realtimeRecoveryInstanceIds.clear();
					pendingRealtimeSettlement = pendingInstanceIds.length > 0;
					for (const instanceId of pendingInstanceIds) realtimeRecoveryInstanceIds.add(instanceId);
					mendingNowMs = Date.now();
					updateLifespanHud(Date.now(), true);
					if (isPersonaExpired(personaResult.persona.gameState, Date.now(), personaResult.persona.activeRun.rootBuild)) {
						personaLifecycleTransition = false;
						const result = await beginDeathTransition(personaResult.persona, null, false);
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
			} catch (error) {
				setComposerTerminalError(new Error(error instanceof Error && error.message === LIFECYCLE_UPGRADE_BLOCKED_MESSAGE
					? LIFECYCLE_UPGRADE_BLOCKED_MESSAGE : 'Persona is unavailable for publishing.'));
				localLifecycleReady = true;
				restoreMeasuredBootstrapConversation();
				return;
			}
			localLifecycleReady = true;
			restoreMeasuredBootstrapConversation();
			if (personaSnapshot && selfSigner) await promoteOrStartSignedWorld(personaSnapshot, characterProfilePublication, true);
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
				restoreMeasuredBootstrapConversation();
			});
		};
		const observer = new ResizeObserver(updateViewport);
		observer.observe(viewportElement!);
		updateViewport();
		if (!devWorldSandboxEnabled) {
			void startReadSession(null, null, null, false);
			void begin();
		}
		const refreshRuntime = async () => {
			if (expiryCheckInFlight || deathTransitionInFlight) return;
			expiryCheckInFlight = true;
			try {
				const expiryResult = await checkPersonaExpiry(worldSession);
				if (expiryResult === 'reloaded' || expiryResult === 'presenting') return;
				if (expiryResult === 'failed') {
					await startReadSession(null, null, null, false);
					return;
				}
				const now = Date.now();
				mendingNowMs = now;
				const second = Math.floor(now / 1000);
				if (tagGameDisplayedGameId && second !== tagGameHudLastSecond) {
					tagGameHudLastSecond = second;
					tagGameHudNowMs = now;
				}
				updateLifespanHud(now);
				if (!devCooperationDefectionPlaygroundEnabled) reconcileCooperationDefectionSession(devCooperationDefectionFixtureEnabled ? initialCooperationDefectionNowMs : now);
				if (!devWorldSandboxEnabled && cooperationDefectionEventEnabled) void worldSession?.startRealtime();
				if (!devWorldSandboxEnabled && worldSession) void advanceTagGames(now);
				if (!devWorldSandboxEnabled && cooperationDefectionSchedule.phase === 'ended') maybeStopRealtime();
				const nextPresence = worldReader?.refresh(now);
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
			clearDeathPresentationTimer();
			window.removeEventListener('pointerdown', unlockSound);
			window.removeEventListener('keydown', unlockSound);
			appSoundController.dispose();
			soundController = null;
			if (collectFeedbackTimer !== null) window.clearTimeout(collectFeedbackTimer);
			if (mendingStartupFeedbackTimer !== null) window.clearTimeout(mendingStartupFeedbackTimer);
			if (upgradeFeedbackTimer !== null) window.clearTimeout(upgradeFeedbackTimer);
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
			worldReader?.dispose();
			devTraceConversationRuntime?.dispose();
			devTraceConversationRuntime = null;
			traceConversationController = null;
			worldReader = null;
			worldSession = null;
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

	function rememberTagGameEvidenceId(byPubkey: Map<string, string[]>, pubkey: string, eventId: string): void {
		const ids = byPubkey.get(pubkey) ?? [];
		if (ids.includes(eventId)) return;
		byPubkey.set(pubkey, [...ids, eventId].slice(-4));
	}

	function acceptTagGamePositionEvidence(evidence: readonly ReducedPresenceParticipant[]): void {
		tagGamePositionEvidence = new Map(evidence.map((participant) => [participant.pubkey, participant]));
		for (const participant of evidence) {
			rememberTagGameEvidenceId(tagGamePositionEvidenceIdsByPubkey, participant.pubkey, participant.positionEvidence.eventId);
			for (const attempt of tagGameProofRefreshAttempts.values()) {
				if (attempt.pubkey === participant.pubkey) completeTagGameProofRefreshIfResolved(attempt);
			}
		}
		for (const notify of tagGamePositionEvidenceWaiters) notify();
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
		if (!personaSnapshot?.gameState.mendingJob) {
			mendingStartupFeedback = { id: ++feedbackSequence, phase: 'starting' };
			void mutateMending('start');
		}
	}

	function closeMendingTerminal(): void {
		mendingDialogOpen = false;
		mendingStartupFeedback = null;
		if (mendingStartupFeedbackTimer !== null) {
			window.clearTimeout(mendingStartupFeedbackTimer);
			mendingStartupFeedbackTimer = null;
		}
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
			const selectionOptions = deathDevMode || clearDevMode ? {
				...(deathDevMode ? { initialLifespanMs: DEATH_DEV_INITIAL_LIFESPAN_MS } : {}),
				...(clearDevMode ? { initialPoints: CLEAR_DEV_INITIAL_POINTS } : {})
			} : undefined;
			const result = await selectIdentity(selection.generation, candidate, rootBuild, selectionOptions);
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
		if (!expected || !worldSession || personaLifecycleTransition || clearMutationInFlight) return;
		clearMutationInFlight = true;
		const currentSession = worldSession;
		stopPersonaInteractions('Run cleared.');
		try {
			const preparedExit = currentSession?.prepareTerminalExit(expected.signer.pubkey, 'clear');
			const exitRequest = preparedExit?.kind === 'prepared' && currentSession?.getChannel()
				? { channelId: currentSession.getChannel()!.channelId, position: preparedExit.parsed.position,
					lastPositiveCreatedAt: preparedExit.parsed.createdAt }
				: undefined;
			const result = await clearPersona(expected, exitRequest);
			if (result.kind === 'cleared') {
				storeRunTransitionNotice('cleared');
				try {
					if (result.exit && preparedExit?.kind === 'prepared') {
						currentSession?.commitTerminalExit(result.exit);
						await currentSession?.publishTerminalExit();
					}
				} catch {
					// The local clear is already durable; World State exit is best effort.
				}
				disposePersonaWriter(currentSession);
				window.location.reload();
			} else if (result.kind === 'superseded' || result.kind === 'blocked') {
				disposePersonaWriter(currentSession);
				window.location.reload();
			} else if (result.kind === 'corrupt') {
				enterReadOnlyFallback('Persona is unavailable for publishing.');
			}
		} catch (error) {
			enterReadOnlyFallback('Persona is unavailable for publishing.');
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

	function clearDeathPresentationTimer(): void {
		if (deathPresentationTimer !== null) window.clearTimeout(deathPresentationTimer);
		deathPresentationTimer = null;
	}

	function startDeathPresentation(
		currentSession: ReturnType<typeof createWorldReadSession> | null,
		canonicalPosition: GridPosition | null,
		terminalExitPublication: Promise<void> | null
	): void {
		clearDeathPresentationTimer();
		const phase: DeathPresentationPhase = prefersReducedMotion ? 'last-words' : 'intro';
		deathPresentation = { session: currentSession, phase, canonicalPosition, terminalExitPublication };
		soundController?.play('death');
		if (phase === 'intro') {
			deathPresentationTimer = window.setTimeout(() => {
				if (deathPresentation?.phase === 'intro') deathPresentation = { ...deathPresentation, phase: 'last-words' };
				deathPresentationTimer = null;
			}, DEATH_INTRO_DURATION_MS);
		}
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
		return Boolean(!devWorldSandboxEnabled && !personaLifecycleTransition && worldSession && personaSnapshot && selfIsActive && selfLogicalPosition &&
			isWithinFacilityInteractionRange(selfLogicalPosition));
	}

	async function mutateAbility(key: PersonaAbilityKey): Promise<void> {
		const expected = personaSnapshot;
		if (!expected || !worldSession || personaLifecycleTransition || abilityMutationInFlight || !canUseAdjustmentTerminal) {
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
			if (result.kind === 'upgraded') {
				void worldSession?.refreshSelfActivity();
				if (upgradeFeedbackTimer !== null) window.clearTimeout(upgradeFeedbackTimer);
				upgradeFeedback = { id: ++feedbackSequence, key, level: result.persona.activeRun.gameState.abilities[key] };
				upgradeFeedbackTimer = window.setTimeout(() => { upgradeFeedback = null; upgradeFeedbackTimer = null; }, 500);
				soundController?.play('level-up');
			}
		} catch {
			closeAdjustmentTerminal();
		} finally {
			abilityMutationInFlight = false;
		}
	}

	async function mutateMending(operation: 'start' | 'collect'): Promise<void> {
		const expected = personaSnapshot;
		if (!expected || !worldSession || personaLifecycleTransition || mendingMutationInFlight || !hasLiveMendingProximity()) {
			closeMendingTerminal();
			return;
		}
		mendingMutationInFlight = true;
		try {
			const result = operation === 'start' ? await startMending(expected) : await collectMending(expected);
			if (result.kind === 'corrupt') {
				mendingStartupFeedback = null;
				enterReadOnlyFallback('Persona is unavailable for publishing.');
				return;
			}
			if (result.kind === 'superseded') {
				mendingStartupFeedback = null;
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
			if (result.kind === 'blocked') mendingStartupFeedback = null;
			personaSnapshot = result.persona;
			selfSigner = result.persona.signer;
			if (result.kind === 'started' || result.kind === 'collected') void worldSession?.refreshSelfActivity();
			if (result.kind === 'collected') {
				if (collectFeedbackTimer !== null) window.clearTimeout(collectFeedbackTimer);
				collectFeedback = {
					id: ++feedbackSequence,
					points: Math.max(0, result.persona.activeRun.gameState.points - expected.gameState.points),
					lifespanMs: Math.max(0, result.persona.activeRun.gameState.lifespanExpiresAtMs - expected.gameState.lifespanExpiresAtMs)
				};
				collectFeedbackTimer = window.setTimeout(() => { collectFeedback = null; collectFeedbackTimer = null; }, 500);
				soundController?.play('collect');
			}
			mendingNowMs = Date.now();
			updateLifespanHud(mendingNowMs, true);
			if (result.kind === 'started') {
				if (mendingStartupFeedbackTimer !== null) window.clearTimeout(mendingStartupFeedbackTimer);
				if (mendingDialogOpen) {
					mendingStartupFeedback = { id: ++feedbackSequence, phase: 'started' };
					mendingStartupFeedbackTimer = window.setTimeout(() => { mendingStartupFeedback = null; mendingStartupFeedbackTimer = null; }, 3000);
				}
				soundController?.play('startup');
			}
			if (result.kind === 'expired') {
				mendingStartupFeedback = null;
				closeMendingTerminal();
				void beginDeathTransition(result.persona, worldSession);
			}
		} catch {
			mendingStartupFeedback = null;
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

	function ensureCooperationDefectionSession(instanceId: string): CooperationDefectionSessionState {
		if (cooperationDefectionSession?.instanceId === instanceId) return cooperationDefectionSession;
		const recovered = recoveredCooperationDefectionSessions.get(instanceId);
		if (recovered) return recovered;
		const next = createCooperationDefectionSession({ instanceId, field });
		if (instanceId === cooperationDefectionSchedule.instanceId) cooperationDefectionSession = next;
		else recoveredCooperationDefectionSessions.set(instanceId, next);
		return next;
	}

	function publishCooperationDefectionResultMessages(sourceSession: CooperationDefectionSessionState, sourceSchedule: ReturnType<typeof getCooperationDefectionScheduleForInstance>): Promise<void> {
		const pubkey = selfSigner?.pubkey;
		const currentSession = worldSession;
		if (!pubkey || !currentSession || !sourceSchedule || devWorldSandboxEnabled) return Promise.resolve();
		const nowMs = Date.now();
		const dispatches: Promise<void>[] = [];
		for (const result of sourceSession.results) {
			if (result.kind === 'insufficient' || !result.validParticipantPubkeys.includes(pubkey)) continue;
			const roundSchedule = getCooperationDefectionRoundSchedule(sourceSchedule, result.round);
			if (nowMs < roundSchedule.revealCutoffAtMs || nowMs >= roundSchedule.endedAtMs) continue;
			const choice = result.cooperatePubkeys.includes(pubkey) ? '協力' : result.defectPubkeys.includes(pubkey) ? '抜け駆け' : null;
			if (!choice) continue;
			const dedupeId = cooperationDefectionPublicationKey(sourceSession.instanceId, result.groupId, result.round, pubkey);
			let markDispatched!: () => void;
			dispatches.push(new Promise<void>((resolve) => { markDispatched = resolve; }));
			void currentSession.publishMessage(choice, 'normal', dedupeId, markDispatched).catch(() => {});
		}
		return Promise.all(dispatches).then(() => undefined);
	}

	async function settleCooperationDefectionLifespanLoss(expected: PersonaSnapshot, outcome: CooperationDefectionOutcome): Promise<'survived' | 'presenting' | 'reloaded' | 'failed'> {
		if (deathTransitionInFlight) return 'reloaded';
		deathTransitionInFlight = true;
		const currentSession = worldSession;
		const preparedExitRef: { current: TerminalExitPreparation | null } = { current: null };
		try {
			const result = await applyRealtimeLifespanLoss(expected, {
				id: outcome.id,
				kind: 'lifespan-loss',
				lifespanLossMs: outcome.lifespanLossMs,
				instanceId: outcome.instanceId
			}, () => {
				preparedExitRef.current = currentSession?.prepareTerminalExit(expected.signer.pubkey, 'death') ?? null;
				const channel = currentSession?.getChannel();
				return preparedExitRef.current?.kind === 'prepared' && channel
					? { channelId: channel.channelId, position: preparedExitRef.current.parsed.position, lastPositiveCreatedAt: preparedExitRef.current.parsed.createdAt }
					: undefined;
			});
			const preparedExit = preparedExitRef.current;
			if (result.kind === 'survived' || result.kind === 'duplicate') {
				personaSnapshot = result.persona;
				selfSigner = result.persona.signer;
				appliedCooperationDefectionOutcomeIds.add(outcome.id);
				return 'survived';
			}
			if (result.kind === 'transitioned') {
				stopPersonaInteractions('Persona lifetime ended.');
				if (result.exit && preparedExit?.kind === 'prepared') {
					try { currentSession?.commitTerminalExit(result.exit); } catch { /* Durable death is already committed. */ }
				}
				storeRunTransitionNotice('dead');
				const canonicalPosition = preparedExit?.kind === 'prepared' ? { ...preparedExit.parsed.position } : null;
				if (result.exit && preparedExit?.kind === 'prepared') currentSession?.enableDeathLastWords();
				deathPresentationContent = '';
				startDeathPresentation(currentSession, canonicalPosition, null);
				const terminalExitPublication = result.exit && preparedExit?.kind === 'prepared' && currentSession
					? currentSession.publishTerminalExit().then(() => undefined).catch(() => undefined)
					: null;
				if (deathPresentation) deathPresentation = { ...deathPresentation, terminalExitPublication };
				appliedCooperationDefectionOutcomeIds.add(outcome.id);
				return 'presenting';
			}
			if (result.kind === 'stale') {
				disposePersonaWriter(currentSession);
				window.location.reload();
				return 'reloaded';
			}
			disposePersonaWriter(currentSession);
			enterReadOnlyFallback('Persona is unavailable for publishing.');
			return 'failed';
		} finally {
			deathTransitionInFlight = false;
		}
	}

	async function settleOwnCooperationDefectionOutcomes(
		sourceSession: CooperationDefectionSessionState | null = cooperationDefectionSession,
		resultMessageDispatch: Promise<void> = Promise.resolve()
	): Promise<void> {
		if (cooperationDefectionSettlementInFlight || !personaSnapshot || !selfSigner || !sourceSession) return;
		const currentPersona = personaSnapshot;
		const currentSigner = selfSigner;
		const outcomes = sourceSession.results.flatMap((result) => result.outcomes).filter((outcome) => outcome.pubkey === currentSigner.pubkey);
		const next = outcomes.find((outcome) => !appliedCooperationDefectionOutcomeIds.has(outcome.id));
		if (!next) {
			const sourceSchedule = sourceSession.instanceId === cooperationDefectionSchedule.instanceId
				? cooperationDefectionSchedule
				: getCooperationDefectionScheduleForInstance(sourceSession.instanceId, Date.now());
			if (sourceSchedule && isCooperationDefectionSettlementComplete(sourceSession, sourceSchedule, selfSigner.pubkey)) {
				const completed = await completeRealtimeEventInstance(currentPersona, sourceSession.instanceId);
				if (completed) {
					realtimeRecoveryInstanceIds.delete(sourceSession.instanceId);
					pendingRealtimeSettlement = realtimeRecoveryInstanceIds.size > 0;
					if (sourceSession.instanceId !== cooperationDefectionSchedule.instanceId) recoveredCooperationDefectionSessions.delete(sourceSession.instanceId);
					maybeStopRealtime();
				}
			}
			return;
		}
		cooperationDefectionSettlementInFlight = true;
		try {
			if (next.kind === 'lifespan-loss') {
				await resultMessageDispatch;
				await settleCooperationDefectionLifespanLoss(currentPersona, next);
				return;
			}
			const outcome = await applyRealtimeOutcome(currentPersona, { id: next.id, kind: 'points', points: next.points, instanceId: next.instanceId });
			if (outcome.kind === 'applied' || outcome.kind === 'duplicate' || outcome.kind === 'expired') {
				appliedCooperationDefectionOutcomeIds.add(next.id);
				if ('persona' in outcome) {
					personaSnapshot = outcome.persona;
					selfSigner = outcome.persona.signer;
				}
			} else if (outcome.kind === 'stale') {
				appliedCooperationDefectionOutcomeIds.add(next.id);
				window.location.reload();
			}
		} catch {
			// A temporary settlement failure leaves the outcome unmarked for the
			// next refresh; it never turns a publication failure into death.
		} finally {
			cooperationDefectionSettlementInFlight = false;
		}
	}

	async function autoRevealCooperationDefectionChoice(nowMs: number): Promise<void> {
		const selection = cooperationDefectionSelection;
		const roundSchedule = cooperationDefectionRoundSchedule;
		if (!selection || !roundSchedule || selection.round !== cooperationDefectionRound || !selection.commitId || !selection.commitPublished ||
			selection.revealAttempted || selection.revealStatus === 'sending' || selection.revealStatus === 'published' ||
			nowMs < roundSchedule.resultAtMs || nowMs > roundSchedule.revealCutoffAtMs || !selfSigner || !cooperationDefectionSelfGroupId) return;
		cooperationDefectionSelection = { ...selection, revealAttempted: true, revealStatus: 'sending' };
		const id = await publishCooperationDefectionAction(buildCooperationDefectionRevealAction({ groupId: cooperationDefectionSelfGroupId, round: selection.round,
			commitId: selection.commitId, choice: selection.choice, nonce: selection.nonce }));
		if (cooperationDefectionSelection?.round !== selection.round || cooperationDefectionSelection.commitId !== selection.commitId) return;
		cooperationDefectionSelection = { ...cooperationDefectionSelection, revealStatus: id ? 'published' : 'failed' };
	}

	function manualControlIsEligible(control: RealtimeControlEnvelope, nowMs: number): boolean {
		const scheduled = getCooperationDefectionSchedule(nowMs);
		return isManualCooperationDefectionControlScheduleEligible(control, nowMs) && !selectedManualCooperationDefectionInstanceId && !['warning', 'registration', 'game'].includes(scheduled.phase);
	}

	function acceptRealtimeControl(control: RealtimeControlEnvelope): void {
		if (realtimeControlIds.has(control.event.id)) return;
		realtimeControlIds.add(control.event.id);
		if (!manualControlIsEligible(control, Date.now())) return;
		selectedManualCooperationDefectionInstanceId = control.instanceId;
		reconcileCooperationDefectionSession(Date.now());
		void worldSession?.startRealtime();
	}

	function handleRealtimeControl(control: RealtimeControlEnvelope): void {
		if (!cooperationDefectionRealtimeBootstrapComplete) {
			pendingRealtimeControls.push(control);
			return;
		}
		acceptRealtimeControl(control);
	}

	function selectBootstrapRealtimeControl(): void {
		const candidates = [...pendingRealtimeControls]
			.filter((control) => manualControlIsEligible(control, Date.now()))
			.sort(compareManualCooperationDefectionControls);
		pendingRealtimeControls.length = 0;
		if (candidates[0]) acceptRealtimeControl(candidates[0]);
	}

	function maybeStopRealtime(): void {
		if (cooperationDefectionSchedule.phase !== 'ended' || realtimeRecoveryInstanceIds.size > 0 || recoveredCooperationDefectionSessions.size > 0) return;
		void worldSession?.startRealtime();
	}

	function resolveCurrentCooperationDefectionSchedule(nowMs: number): ReturnType<typeof getCooperationDefectionSchedule> {
		const scheduled = getCooperationDefectionSchedule(nowMs);
		if (['warning', 'registration', 'game'].includes(scheduled.phase)) return scheduled;
		const manual = selectedManualCooperationDefectionInstanceId ? getCooperationDefectionScheduleForInstance(selectedManualCooperationDefectionInstanceId, nowMs) : null;
		return manual && ['registration', 'game'].includes(manual.phase) ? manual : scheduled;
	}

	function reconcileCooperationDefectionSession(nowMs = Date.now()): void {
		cooperationDefectionNowMs = nowMs;
		if (selectedManualCooperationDefectionInstanceId) {
			const selectedSchedule = getCooperationDefectionScheduleForInstance(selectedManualCooperationDefectionInstanceId, nowMs);
			if (selectedSchedule?.phase === 'ended') {
				selectedManualCooperationDefectionInstanceId = null;
				void worldSession?.startRealtime();
			}
		}
		cooperationDefectionSchedule = resolveCurrentCooperationDefectionSchedule(nowMs);
		const schedule = cooperationDefectionSchedule;
		const previousSchedule = cooperationDefectionStartSoundPreviousSchedule;
		if (previousSchedule && previousSchedule.instanceId !== schedule.instanceId) {
			cooperationDefectionStartSoundEligibleInstanceId = null;
			cooperationDefectionStartSoundPendingInstanceId = null;
			cooperationDefectionStartSoundPlayedInstanceId = null;
		}
		const actorPubkey = cooperationDefectionActorPubkey;
		const selfGroupId = actorPubkey && cooperationDefectionSession
			? getCooperationDefectionParticipantGroup(cooperationDefectionSession, schedule, actorPubkey)
			: null;
		if (schedule.phase === 'registration' && selfGroupId) cooperationDefectionStartSoundEligibleInstanceId = schedule.instanceId;
		const enteredGameFromRegistration = previousSchedule?.instanceId === schedule.instanceId && previousSchedule.phase === 'registration' && schedule.phase === 'game';
		if (enteredGameFromRegistration && cooperationDefectionStartSoundEligibleInstanceId === schedule.instanceId) {
			cooperationDefectionStartSoundPendingInstanceId = schedule.instanceId;
		}
		cooperationDefectionStartSoundPreviousSchedule = { instanceId: schedule.instanceId, phase: schedule.phase };
		if (!cooperationDefectionEventEnabled) {
			cooperationDefectionSession = null;
			recoveredCooperationDefectionSessions.clear();
			return;
		}
		if (!cooperationDefectionSession || cooperationDefectionSession.instanceId !== cooperationDefectionSchedule.instanceId) {
			if (cooperationDefectionSchedule.phase !== 'dormant') {
				const recovered = recoveredCooperationDefectionSessions.get(cooperationDefectionSchedule.instanceId);
				if (recovered) {
					cooperationDefectionSession = recovered;
					recoveredCooperationDefectionSessions.delete(cooperationDefectionSchedule.instanceId);
				} else {
					const session = createCooperationDefectionSession({ instanceId: cooperationDefectionSchedule.instanceId, field });
					if (devCooperationDefectionStaticPhase === 'game') {
						const groupId = session.groups[0]?.id;
						cooperationDefectionSession = groupId ? { ...session, participantSnapshot: { [groupId]: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)] } } : session;
					} else {
						cooperationDefectionSession = session;
					}
				}
			}
		} else if (cooperationDefectionRealtimeBootstrapComplete) {
			cooperationDefectionSession = settleCooperationDefectionSession(cooperationDefectionSession, cooperationDefectionSchedule, nowMs);
		}
		const firstRound = schedule.phase === 'game' ? getCooperationDefectionRoundSchedule(schedule, 1) : null;
		const awaitingFirstConsultationSnapshot = firstRound && nowMs < firstRound.selectionAtMs;
		if (schedule.phase !== 'registration' && !awaitingFirstConsultationSnapshot) {
			cooperationDefectionStartSoundPendingInstanceId = null;
			cooperationDefectionStartSoundEligibleInstanceId = null;
		} else if (cooperationDefectionStartSoundPendingInstanceId === schedule.instanceId &&
			cooperationDefectionStartSoundEligibleInstanceId === schedule.instanceId && cooperationDefectionStartSoundPlayedInstanceId !== schedule.instanceId &&
			!devWorldSandboxEnabled && actorPubkey && selfGroupId && cooperationDefectionRealtimeBootstrapComplete) {
			const snapshot = cooperationDefectionSession?.participantSnapshot;
			if (snapshot) {
				const participants = snapshot[selfGroupId];
				const groupWasStarted = participants && participants.length >= COOPERATION_DEFECTION_MIN_PARTICIPANTS &&
					participants.includes(actorPubkey) && !cooperationDefectionSession?.cancelledGroupIds.includes(selfGroupId);
				cooperationDefectionStartSoundPendingInstanceId = null;
				cooperationDefectionStartSoundEligibleInstanceId = null;
				if (groupWasStarted) {
					cooperationDefectionStartSoundPlayedInstanceId = schedule.instanceId;
					try { soundController?.play('cooperation-start'); }
					catch { /* Optional audio must not interrupt event or settlement handling. */ }
				}
			}
		}
		void autoRevealCooperationDefectionChoice(nowMs);
		const currentResultMessageDispatch = cooperationDefectionSession
			? publishCooperationDefectionResultMessages(cooperationDefectionSession, cooperationDefectionSchedule)
			: Promise.resolve();
		void settleOwnCooperationDefectionOutcomes(cooperationDefectionSession, currentResultMessageDispatch);
		for (const [instanceId, recovered] of recoveredCooperationDefectionSessions) {
			const recoveredSchedule = getCooperationDefectionScheduleForInstance(instanceId, nowMs);
			if (!recoveredSchedule) {
				recoveredCooperationDefectionSessions.delete(instanceId);
				continue;
			}
			if (cooperationDefectionRealtimeBootstrapComplete) {
				const settled = settleCooperationDefectionSession(recovered, recoveredSchedule, nowMs);
				recoveredCooperationDefectionSessions.set(instanceId, settled);
				const resultMessageDispatch = publishCooperationDefectionResultMessages(settled, recoveredSchedule);
				void settleOwnCooperationDefectionOutcomes(settled, resultMessageDispatch);
			}
		}
	}

	function refreshTagGameStateList(): void {
		tagGameStates = [...tagGameEvents.values()].map((entry) => entry.state).sort((a, b) => b.updatedAt - a.updatedAt || a.gameId.localeCompare(b.gameId));
	}

	function rememberTagGameEnvelope(eventId: string, createdAt: number, state: TagGameState): void {
		const previous = tagGameEvents.get(state.gameId);
		if (previous && createdAt < previous.createdAt) return;
		if (previous && createdAt === previous.createdAt && eventId === previous.eventId) return;
		if (previous && createdAt === previous.createdAt && eventId !== previous.eventId) {
			if (!tagGameConflictSince.has(state.gameId)) {
				tagGameConflictSince.set(state.gameId, Date.now());
				worldReader?.stopRealtime();
				void worldReader?.startRealtime();
			}
			return;
		}
		if (previous && createdAt > previous.createdAt) tagGameConflictSince.delete(state.gameId);
		if (previous?.state.ownerPubkey && state.ownerPubkey && previous.state.ownerPubkey !== state.ownerPubkey) {
			tagGameHolderProbes.delete(state.gameId);
			tagGameHolderLocalActivityAt.delete(state.gameId);
			tagGameSelfChallengeResponses.delete(state.gameId);
			tagGameEffectPauses.delete(state.gameId);
			for (const key of tagGameFormalChallengeAcks.keys()) if (key.startsWith(`${state.gameId}:`)) tagGameFormalChallengeAcks.delete(key);
		}
		const recoveredPause = tagGameEffectPauses.get(state.gameId);
		if (recoveredPause && recoveredPause.ownerPubkey === state.ownerPubkey && !state.holderChallengeId && state.settledAtMs >= recoveredPause.pausedAtMs) {
			tagGameEffectPauses.delete(state.gameId);
			tagGameHolderProbes.delete(state.gameId);
			tagGameFormalChallengeAcks.delete(`${state.gameId}:${recoveredPause.challengeId}`);
		}
		tagGameHostProbeAtMs.delete(state.gameId);
		if ((state.phase === 'ended' || state.phase === 'interrupted') && personaSnapshot?.tagGame?.reservation?.gameId === state.gameId) void releaseAndRefreshTagGameParticipation(personaSnapshot, state.gameId);
		if (previous && personaSnapshot && previous.state.participant.some((member) => member.pubkey === personaSnapshot?.signer.pubkey) && !state.participant.some((member) => member.pubkey === personaSnapshot?.signer.pubkey) && state.phase === 'lobby') {
			void releaseAndRefreshTagGameParticipation(personaSnapshot, state.gameId);
		}
		tagGameEvents.set(state.gameId, { eventId, createdAt, state });
		pruneTagGameProofRefreshes(state.gameId);
		const activeHolder = state.phase === 'running' ? state.participant.find((member) => member.pubkey === state.ownerPubkey && member.status === 'active') : null;
		const localHolderActivity = tagGameHolderLocalActivityAt.get(state.gameId);
		if (!activeHolder || localHolderActivity && (localHolderActivity.ownerPubkey !== state.ownerPubkey || localHolderActivity.runNumber !== activeHolder.runNumber)) {
			tagGameHolderLocalActivityAt.delete(state.gameId);
			tagGameSelfChallengeResponses.delete(state.gameId);
		}
		const pendingSelfResponse = tagGameSelfChallengeResponses.get(state.gameId);
		if (pendingSelfResponse && (!activeHolder || pendingSelfResponse.ownerPubkey !== state.ownerPubkey || pendingSelfResponse.runNumber !== activeHolder.runNumber ||
			(pendingSelfResponse.stage === 'precheck' ? Boolean(state.holderChallengeId) : state.holderChallengeId !== pendingSelfResponse.challengeId))) {
			tagGameSelfChallengeResponses.delete(state.gameId);
		}
		if (personaSnapshot && localHolderActivity?.ownerPubkey === personaSnapshot.signer.pubkey && localHolderActivity.runNumber !== personaSnapshot.activeRun.runNumber) {
			tagGameHolderLocalActivityAt.delete(state.gameId);
			tagGameSelfChallengeResponses.delete(state.gameId);
		}
		if (previous && previous.state.ownerPubkey && state.ownerPubkey && previous.state.ownerPubkey !== state.ownerPubkey && state.phase === 'running') {
			tagGameHolderTransfer = { participantId: state.ownerPubkey, id: ++tagGameHolderTransferSequence };
			window.setTimeout(() => {
				if (tagGameHolderTransfer?.id === tagGameHolderTransferSequence) tagGameHolderTransfer = null;
			}, 800);
			const touchStatus = tagGameTouchStatuses.get(state.gameId);
			if (touchStatus) setTagGameTouchStatus(state.gameId, touchStatus.targetPubkey, '所持者が更新されました', 'clear');
		}
		const ownStartTransition = isOwnTagGameStartTransition(previous?.state ?? null, state, personaSnapshot?.signer.pubkey ?? null, personaSnapshot?.activeRun.runNumber ?? null);
		if (ownStartTransition && tagGamePanelOpen) {
			tagGamePanelOpen = false;
		}
		const ownActiveRun = personaSnapshot && state.participant.some((member) => member.pubkey === personaSnapshot?.signer.pubkey && member.runNumber === personaSnapshot.activeRun.runNumber && member.status === 'active');
		if (ownStartTransition || tagGameWatchedGameId === state.gameId || state.phase === 'running' && ownActiveRun) {
			tagGameHudNowMs = Date.now();
			tagGameHudLastSecond = Math.floor(tagGameHudNowMs / 1000);
		}
		if (tagGameWatchedGameId === state.gameId && state.phase !== 'running' && state.phase !== 'settling') tagGameWatchedGameId = null;
		const nowSeconds = Math.floor(Date.now() / 1000);
		if (state.phase === 'running') refreshOwnTagGamePositionProof(state);
		const localMember = personaSnapshot && state.participant.find((member) => member.pubkey === personaSnapshot?.signer.pubkey && member.runNumber === personaSnapshot.activeRun.runNumber);
		const freshStateEvent = nowSeconds - createdAt <= TAG_GAME_LOBBY_MAX_AGE_SECONDS && nowSeconds >= createdAt - 5;
		const ongoingReservationState = freshStateEvent && (state.phase === 'lobby' ? isFreshTagGameLobby(state, nowSeconds) :
			state.phase === 'proposed' ? Boolean(state.proposalDeadline && state.proposalDeadline >= nowSeconds && nowSeconds - state.updatedAt <= TAG_GAME_LOBBY_MAX_AGE_SECONDS) :
			state.phase === 'countdown' ? Boolean(state.startAt && state.startAt >= nowSeconds - 5 && state.startAt <= nowSeconds + 30) :
			(state.phase === 'running' || state.phase === 'settling') && Boolean(state.endsAt && nowSeconds <= state.endsAt + TAG_GAME_FINAL_WAIT_MS / 1000));
		if (personaSnapshot && localMember && ongoingReservationState && ['registered', 'active', 'temporarily-ineligible'].includes(localMember.status)) {
			void confirmAndRefreshTagGameParticipation(personaSnapshot, state.gameId);
		}
		refreshTagGameStateList();
		if (state.phase === 'running' || state.phase === 'settling' || state.phase === 'ended' || state.phase === 'interrupted') void syncTagGameLifecycle(state);
	}

	async function syncTagGameLifecycle(game: TagGameState): Promise<void> {
		const self = personaSnapshot;
		const member = self && game.participant.find((player) => player.pubkey === self.signer.pubkey && player.runNumber === self.activeRun.runNumber);
		if (!self || !member) return;
		if (!game.startedAt || !game.endsAt) {
			if (game.phase === 'ended' || game.phase === 'interrupted') await releaseAndRefreshTagGameParticipation(self, game.gameId);
			return;
		}
		const gameId = game.gameId;
		if ((game.phase === 'running' || game.phase === 'settling') && member.status !== 'left') {
			await activateTagGameRun(self, gameId, game.startedAt * 1000, game.endsAt * 1000, game.endsAt * 1000 + TAG_GAME_FINAL_WAIT_MS);
			const own = game.participant.find((candidate) => candidate.pubkey === self.signer.pubkey)!;
			let preparedExit: ReturnType<NonNullable<typeof worldSession>['prepareTerminalExit']> | undefined;
			const result = await applyTagGameCumulative(self, gameId, own.points, own.lifespanLossMs, false, () => {
				preparedExit = worldSession?.prepareTerminalExit(self.signer.pubkey, 'death');
				return terminalExitRequest(preparedExit, worldSession);
			});
			if (result.kind === 'applied') personaSnapshot = result.persona;
			else if (result.kind === 'transitioned') completeTagGameDeathTransition(worldSession, result.exit, preparedExit);
		} else {
			await activateTagGameRun(self, gameId, game.startedAt * 1000, game.endsAt * 1000, game.endsAt * 1000 + TAG_GAME_FINAL_WAIT_MS);
			const own = game.participant.find((candidate) => candidate.pubkey === self.signer.pubkey)!;
			let preparedExit: ReturnType<NonNullable<typeof worldSession>['prepareTerminalExit']> | undefined;
			const result = await applyTagGameCumulative(self, gameId, own.points, own.lifespanLossMs, true, () => {
				preparedExit = worldSession?.prepareTerminalExit(self.signer.pubkey, 'death');
				return terminalExitRequest(preparedExit, worldSession);
			});
			if (result.kind === 'applied') personaSnapshot = result.persona;
			else if (result.kind === 'transitioned') completeTagGameDeathTransition(worldSession, result.exit, preparedExit);
			else await releaseAndRefreshTagGameParticipation(self, gameId);
		}
	}

	async function releaseAndRefreshTagGameParticipation(expected: PersonaSnapshot, gameId: string): Promise<void> {
		if (!await releaseTagGameParticipation(expected, gameId)) return;
		await refreshTagGamePersona(expected);
	}

	async function refreshTagGamePersona(expected: PersonaSnapshot): Promise<void> {
		const result = await loadOrCreateLifecycle();
		if (result.kind === 'restored' && result.persona.signer.pubkey === expected.signer.pubkey && result.persona.activeRun.runNumber === expected.activeRun.runNumber) personaSnapshot = result.persona;
	}

	async function confirmAndRefreshTagGameParticipation(expected: PersonaSnapshot, gameId: string): Promise<void> {
		if (await confirmTagGameParticipation(expected, gameId)) await refreshTagGamePersona(expected);
	}

	function terminalExitRequest(prepared: ReturnType<NonNullable<typeof worldSession>['prepareTerminalExit']> | undefined, session: ReturnType<typeof createWorldReadSession> | null): TerminalExitJournalRequest | undefined {
		return prepared?.kind === 'prepared' && session?.getChannel() ? { channelId: session.getChannel()!.channelId, position: prepared.parsed.position, lastPositiveCreatedAt: prepared.parsed.createdAt } : undefined;
	}

	function completeTagGameDeathTransition(currentSession: ReturnType<typeof createWorldReadSession> | null, exit: import('$lib/rootIdentity').CommittedTerminalExit | undefined,
		prepared: ReturnType<NonNullable<typeof worldSession>['prepareTerminalExit']> | undefined): void {
		if (personaLifecycleTransition || deathTransitionInFlight) return;
		deathTransitionInFlight = true;
		stopPersonaInteractions('Persona lifetime ended.');
		if (exit && prepared?.kind === 'prepared') {
			try { currentSession?.commitTerminalExit(exit); } catch { /* Durable death is already committed. */ }
		}
		storeRunTransitionNotice('dead');
		const canonicalPosition = exit && prepared?.kind === 'prepared' ? { ...exit.position } : null;
		if (exit && prepared?.kind === 'prepared') currentSession?.enableDeathLastWords();
		deathPresentationContent = '';
		startDeathPresentation(currentSession, canonicalPosition, null);
		const publication = exit && prepared?.kind === 'prepared' && currentSession
			? currentSession.publishTerminalExit().then(() => undefined).catch(() => undefined) : null;
		if (deathPresentation) deathPresentation = { ...deathPresentation, terminalExitPublication: publication };
	}

	function tagGameNonce(): string {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
	}

	async function publishTagGameAction(gameId: string, action: string, payload: Readonly<Record<string, unknown>> = {}): Promise<boolean> {
		const self = personaSnapshot;
		const channel = worldSession?.getChannel();
		if (!self || !channel || !worldSession || !selfIsActive) return false;
		const createdAt = Math.floor(Date.now() / 1000);
		const event = finalizeEvent(buildTagGameActionTemplate({ channelId: channel.channelId, gameId, action, runNumber: self.activeRun.runNumber, nonce: tagGameNonce(), createdAt, payload }), self.signer.secretKey);
		try {
			const handle = await worldSession.publishRealtimeTracked(event);
			const confirmed = await handle.firstSuccess;
			void handle.settled;
			if (confirmed && action === 'leave' && tagGameEvents.get(gameId)?.state.hostPubkey === self.signer.pubkey) handleTagGameSupplementalEvent(event);
			return confirmed;
		} catch { return false; }
	}

	async function publishTagGameState(next: TagGameState): Promise<boolean> {
		return enqueueTagGameState(next.gameId, () => next);
	}

	async function updateTagGameState(gameId: string, update: (current: TagGameState) => TagGameState | null): Promise<boolean> {
		return enqueueTagGameState(gameId, (current) => current ? update(current) : null);
	}

	async function enqueueTagGameState(gameId: string, create: (current: TagGameState | null) => TagGameState | null): Promise<boolean> {
		const operation = async () => {
			const now = Date.now();
			const previousPublishedSecond = tagGameLastPublishSeconds.get(gameId) ?? 0;
			if (Math.floor(now / 1000) <= previousPublishedSecond) await new Promise((resolve) => window.setTimeout(resolve, previousPublishedSecond * 1000 + 1_001 - now));
			const self = personaSnapshot;
			const session = worldSession;
			const channel = session?.getChannel();
			if (!self || !channel || !session) return false;
			const current = tagGameEvents.get(gameId)?.state ?? null;
			const next = create(current);
			if (!next || next.gameId !== gameId || next.hostPubkey !== self.signer.pubkey) return false;
			const createdAt = Math.floor(Date.now() / 1000);
			const state = { ...next, updatedAt: createdAt };
			const event = finalizeTagGameState(state, channel.channelId, createdAt, self.signer.secretKey);
			const handle = await session.publishRealtimeTracked(event);
			if (!await handle.firstSuccess) {
				await handle.settled;
				return false;
			}
			tagGameLastPublishSeconds.set(gameId, createdAt);
			if (state.phase === 'lobby' && state.hostPubkey === self.signer.pubkey) tagGameLastLobbyRenewalMs.set(state.gameId, Date.now());
			rememberTagGameEnvelope(event.id, createdAt, state);
			void handle.settled;
			return true;
		};
		const queue = tagGamePublishQueues.get(gameId) ?? Promise.resolve();
		const pending = queue.then(operation, operation);
		tagGamePublishQueues.set(gameId, pending.catch(() => false));
		return pending;
	}

	async function createTagGame(): Promise<void> {
		const self = personaSnapshot;
		if (!self || !worldSession || !selfIsActive || tagGameBusy || self.tagGame?.lock || self.tagGame?.reservation && (self.tagGame.reservation.expiresAtMs === undefined || self.tagGame.reservation.expiresAtMs > Date.now()) || visibleTagGameStates.some((game) => !['ended', 'interrupted'].includes(game.phase) && (game.hostPubkey === self.signer.pubkey || game.participant.some((member) => member.pubkey === self.signer.pubkey && ['registered', 'active', 'temporarily-ineligible'].includes(member.status))))) return;
		tagGameBusy = true;
		try {
			const randomId = tagGameNonce() + tagGameNonce();
			const createdAt = Math.floor(Date.now() / 1000);
			const gameId = createTagGameId(self.signer.pubkey, createdAt, randomId);
			if (!await reserveTagGameParticipation(self, gameId)) return;
			await refreshTagGamePersona(self);
			const state: TagGameState = {
				gameId, hostPubkey: self.signer.pubkey, phase: 'lobby', revision: 0, updatedAt: createdAt,
				participant: [{ pubkey: self.signer.pubkey, runNumber: self.activeRun.runNumber, registeredAt: createdAt, status: 'registered', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 }], settledAtMs: createdAt * 1000
			};
			await publishTagGameState(state);
		} finally { tagGameBusy = false; }
	}

	async function joinTagGame(gameId: string): Promise<void> {
		const self = personaSnapshot;
		if (!self || tagGameBusy) return;
		tagGameBusy = true;
		try {
			if (!await reserveTagGameParticipation(self, gameId, true)) return;
			await refreshTagGamePersona(self);
			if (!await publishTagGameAction(gameId, 'join')) await releaseAndRefreshTagGameParticipation(self, gameId);
		} finally { tagGameBusy = false; }
	}

	async function leaveTagGame(gameId: string): Promise<void> {
		const self = personaSnapshot;
		if (!self || tagGameBusy) return;
		tagGameBusy = true;
		const game = tagGameEvents.get(gameId)?.state;
		const duringGame = game?.phase === 'running' || game?.phase === 'settling';
		try {
			await publishTagGameAction(gameId, 'leave');
			if (!duringGame) await releaseAndRefreshTagGameParticipation(self, gameId);
		}
		finally { tagGameBusy = false; }
	}

	async function cancelTagGame(gameId: string): Promise<void> {
		const self = personaSnapshot;
		const game = tagGameEvents.get(gameId)?.state;
		if (!self || !game || game.hostPubkey !== self.signer.pubkey || (game.phase !== 'lobby' && game.phase !== 'proposed') || tagGameBusy) return;
		tagGameBusy = true;
		try {
			await updateTagGameState(gameId, (current) => current && current.hostPubkey === self.signer.pubkey && (current.phase === 'lobby' || current.phase === 'proposed')
				? { ...current, phase: 'interrupted', endReason: 'host-cancelled', proposalId: undefined, proposalDeadline: undefined, startAt: undefined, finalizedAt: Math.floor(Date.now() / 1000), revision: current.revision + 1 }
				: null);
		} finally { tagGameBusy = false; }
	}

	async function proposeTagGameStart(gameId: string): Promise<void> {
		const proposalId = tagGameNonce();
		await updateTagGameState(gameId, (current) => current.phase === 'lobby' && current.participant.length >= 2
			? { ...current, phase: 'proposed', proposalId, proposalDeadline: Math.floor(Date.now() / 1000) + 30,
				participant: current.participant.map((member) => ({ ...member, consentProposalId: member.pubkey === current.hostPubkey ? proposalId : undefined, consented: member.pubkey === current.hostPubkey })), revision: current.revision + 1 }
			: null);
	}

	async function excludeTagGameParticipant(gameId: string, pubkey: string): Promise<void> {
		await updateTagGameState(gameId, (current) => current.phase === 'proposed' && current.participant.some((member) => member.pubkey === pubkey && !member.consented)
			? { ...current, phase: 'lobby', proposalId: undefined, proposalDeadline: undefined, startAt: undefined, revision: current.revision + 1,
				participant: current.participant.filter((member) => member.pubkey !== pubkey).map((member) => ({ ...member, consentProposalId: undefined, consented: false })) }
			: null);
	}

	async function consentTagGameStart(gameId: string, proposalId: string): Promise<void> {
		await publishTagGameAction(gameId, 'consent', { proposalId });
	}

	type TagGameTouchProofState = 'ready' | 'stale' | 'missing';

	function tagGameTouchProofState(pubkey: string, memberRunNumber: number, proof: unknown): TagGameTouchProofState {
		if (!isTagGameTouchPositionProof(proof)) return 'missing';
		const anchor = latestTagGameWorldStates.get(pubkey);
		const position = tagGamePositionEvidence.get(pubkey);
		const anchorHistory = tagGameWorldStateIdsByPubkey.get(pubkey) ?? [];
		const positionHistory = tagGamePositionEvidenceIdsByPubkey.get(pubkey) ?? [];
		if (!anchor || !position) return 'missing';
		if (isTagGameTouchProofSuperseded({
			proof,
			currentWorldStateEventId: anchor.id,
			currentWorldState: anchor.state,
			currentRunNumber: anchor.runNumber ?? null,
			memberRunNumber,
			currentPositionEvidenceEventId: position.positionEvidence.eventId,
			knownWorldStateEventIds: anchorHistory,
			knownPositionEvidenceEventIds: positionHistory
		})) return 'stale';
		if (anchor.id !== proof.worldStateEventId) return 'missing';
		if (position.positionEvidence.eventId !== proof.positionEvidenceEventId && positionHistory.includes(proof.positionEvidenceEventId)) return 'stale';
		if (position.positionEvidence.eventId !== proof.positionEvidenceEventId) return 'missing';
		const positiveAt = position.lastPositiveActivityCreatedAt;
		const nowSeconds = Math.floor(Date.now() / 1_000);
		const worldParticipant = presenceState.participants.find((participant) => participant.id === pubkey);
		if (positiveAt === null || position.positionEvidence.source === 'world-state-exit' || !worldParticipant || worldParticipant.status !== 'active' ||
			(position.latestExitCreatedAt !== null && positiveAt <= position.latestExitCreatedAt) ||
			nowSeconds - positiveAt >= PRESENCE_TIMEOUT_MS / 1_000) return 'stale';
		return 'ready';
	}

	function waitForTagGameTouchEvidence(game: TagGameState, actorPubkey: string, targetPubkey: string, actorProof: unknown, targetProof: unknown): Promise<TagGameTouchProofState> {
		const actor = game.participant.find((member) => member.pubkey === actorPubkey && member.status === 'active');
		const target = game.participant.find((member) => member.pubkey === targetPubkey && member.status === 'active');
		if (!actor || !target) return Promise.resolve('stale');
		const status = () => {
			const actorStatus = tagGameTouchProofState(actorPubkey, actor.runNumber, actorProof);
			const targetStatus = tagGameTouchProofState(targetPubkey, target.runNumber, targetProof);
			return actorStatus === 'stale' || targetStatus === 'stale' ? 'stale' : actorStatus === 'ready' && targetStatus === 'ready' ? 'ready' : 'missing';
		};
		const initial = status();
		if (initial !== 'missing') return Promise.resolve(initial);
		return new Promise((resolve) => {
			let finished = false;
			let timeout = 0;
			const finish = (result: TagGameTouchProofState) => {
				if (finished) return;
				finished = true;
				window.clearTimeout(timeout);
				tagGamePositionEvidenceWaiters.delete(check);
				resolve(result);
			};
			const check = () => {
				const current = status();
				if (current !== 'missing') finish(current);
			};
			tagGamePositionEvidenceWaiters.add(check);
			timeout = window.setTimeout(() => finish(status() === 'stale' ? 'stale' : 'missing'), TAG_GAME_TOUCH_EVIDENCE_WAIT_MS);
		});
	}

	function tagGameProofRefreshKey(gameId: string, pubkey: string, runNumber: number): string {
		return `${gameId}:${pubkey}:${runNumber}`;
	}

	function currentTagGameTouchProof(pubkey: string, runNumber: number): TagGameTouchPositionProof | undefined {
		const anchor = latestTagGameWorldStates.get(pubkey);
		const position = tagGamePositionEvidence.get(pubkey);
		if (!anchor || anchor.state !== 'active' || anchor.runNumber !== runNumber || !position || position.positionEvidence.source === 'world-state-exit') return undefined;
		return { worldStateEventId: anchor.id, positionEvidenceEventId: position.positionEvidence.eventId };
	}

	function stopTagGameProofRefresh(attempt: TagGameProofRefreshAttempt, remove = false): void {
		if (attempt.timer !== null) window.clearTimeout(attempt.timer);
		attempt.timer = null;
		attempt.completed = true;
		if (remove) tagGameProofRefreshAttempts.delete(tagGameProofRefreshKey(attempt.gameId, attempt.pubkey, attempt.runNumber));
	}

	function pruneTagGameProofRefreshes(gameId: string): void {
		const game = tagGameEvents.get(gameId)?.state;
		for (const attempt of tagGameProofRefreshAttempts.values()) {
			if (attempt.gameId !== gameId) continue;
			const member = game?.participant.find((candidate) => candidate.pubkey === attempt.pubkey);
			if (!game || game.phase !== 'running' || !member || member.runNumber !== attempt.runNumber || member.status !== 'active' ||
				(attempt.pubkey === personaSnapshot?.signer.pubkey && personaSnapshot.activeRun.runNumber !== attempt.runNumber)) {
				stopTagGameProofRefresh(attempt, true);
			}
		}
	}

	function completeTagGameProofRefreshIfResolved(attempt: TagGameProofRefreshAttempt): boolean {
		const proof = currentTagGameTouchProof(attempt.pubkey, attempt.runNumber);
		const proofState = tagGameTouchProofState(attempt.pubkey, attempt.runNumber, proof);
		const resolved = proofState !== 'missing' && (!attempt.requireNewEvidence || proof?.positionEvidenceEventId !== attempt.baselineEvidenceId);
		if (resolved) stopTagGameProofRefresh(attempt);
		return resolved;
	}

	function scheduleTagGameProofRefresh(attempt: TagGameProofRefreshAttempt, delayMs: number): void {
		if (attempt.completed || attempt.timer !== null || attempt.attempts >= TAG_GAME_POSITION_PROOF_REFRESH_MAX_ATTEMPTS) return;
		attempt.timer = window.setTimeout(() => {
			attempt.timer = null;
			void attemptTagGameProofRefresh(attempt);
		}, delayMs);
	}

	async function attemptTagGameProofRefresh(attempt: TagGameProofRefreshAttempt): Promise<void> {
		if (attempt.completed || attempt.inFlight) return;
		const game = tagGameEvents.get(attempt.gameId)?.state;
		const self = personaSnapshot;
		const member = game?.participant.find((candidate) => candidate.pubkey === attempt.pubkey && candidate.runNumber === attempt.runNumber && candidate.status === 'active');
		if (!game || game.phase !== 'running' || !member ||
			(attempt.mode === 'host-request' && game.hostPubkey !== self?.signer.pubkey) ||
			(attempt.mode === 'local-refresh' && (attempt.pubkey !== self?.signer.pubkey || self.activeRun.runNumber !== attempt.runNumber))) {
			stopTagGameProofRefresh(attempt, true);
			return;
		}
		if (attempt.mode === 'host-request' && tagGameTouchProofState(attempt.pubkey, attempt.runNumber, undefined) !== 'missing') {
			stopTagGameProofRefresh(attempt);
			return;
		}
		const nowMs = Date.now();
		if (!canRetryTagGamePositionProofRefresh({ attempts: attempt.attempts, lastAttemptAtMs: attempt.lastAttemptAtMs, nowMs, inFlight: attempt.inFlight })) return;
		attempt.inFlight = true;
		attempt.attempts += 1;
		attempt.lastAttemptAtMs = nowMs;
		try {
			if (attempt.mode === 'local-refresh' || attempt.pubkey === self?.signer.pubkey) {
				await worldSession?.refreshSelfActivity({ forcePositionEvidence: true });
			} else {
				await publishTagGameAction(attempt.gameId, 'position-refresh-request', { targetPubkey: attempt.pubkey, targetRunNumber: attempt.runNumber });
			}
		} catch {
			// Failed requests consume one bounded attempt and may retry after the interval.
		} finally {
			attempt.inFlight = false;
		}
		if (completeTagGameProofRefreshIfResolved(attempt)) return;
		if (attempt.attempts < TAG_GAME_POSITION_PROOF_REFRESH_MAX_ATTEMPTS) scheduleTagGameProofRefresh(attempt, TAG_GAME_POSITION_PROOF_REFRESH_RETRY_MS);
		else if (attempt.restartAfterBatch) {
			attempt.restartAfterBatch = false;
			attempt.attempts = 0;
			attempt.lastAttemptAtMs = 0;
			scheduleTagGameProofRefresh(attempt, TAG_GAME_POSITION_PROOF_REFRESH_RETRY_MS);
		}
	}

	function requestTagGamePositionProofRefresh(gameId: string, pubkey: string, runNumber: number, mode: 'host-request' | 'local-refresh', requestEventId?: string): void {
		const self = personaSnapshot;
		const game = tagGameEvents.get(gameId)?.state;
		if (!self || !game || game.phase !== 'running' || (mode === 'host-request' && game.hostPubkey !== self.signer.pubkey) ||
			!game.participant.some((member) => member.pubkey === pubkey && member.runNumber === runNumber && member.status === 'active')) return;
		if (mode === 'local-refresh' && (pubkey !== self.signer.pubkey || self.activeRun.runNumber !== runNumber)) return;
		const key = tagGameProofRefreshKey(gameId, pubkey, runNumber);
		let attempt = tagGameProofRefreshAttempts.get(key);
		const currentEvidenceId = tagGamePositionEvidence.get(pubkey)?.positionEvidence.eventId ?? null;
		if (!attempt || attempt.completed && attempt.baselineEvidenceId !== currentEvidenceId) {
			attempt = { gameId, pubkey, runNumber, mode, attempts: 0, lastAttemptAtMs: 0, inFlight: false, completed: false,
				baselineEvidenceId: currentEvidenceId, requireNewEvidence: false, lastRequestEventId: null, restartAfterBatch: false, timer: null };
			tagGameProofRefreshAttempts.set(key, attempt);
		}
		if (requestEventId && attempt.lastRequestEventId !== requestEventId) {
			attempt.lastRequestEventId = requestEventId;
			// A distinct, fresh touch/request may start a new bounded retry batch
			// after an earlier batch was exhausted. Duplicate deliveries retain
			// the same event ID and therefore remain coalesced.
			if (!attempt.inFlight && attempt.timer === null && (attempt.completed || attempt.attempts >= TAG_GAME_POSITION_PROOF_REFRESH_MAX_ATTEMPTS)) {
				attempt.attempts = 0;
				attempt.lastAttemptAtMs = 0;
				attempt.completed = false;
				attempt.baselineEvidenceId = currentEvidenceId;
			} else if (attempt.inFlight || attempt.timer !== null) attempt.restartAfterBatch = true;
			attempt.requireNewEvidence = true;
		}
		if (attempt.completed || attempt.inFlight || attempt.timer !== null) return;
		if (Date.now() - attempt.lastAttemptAtMs < TAG_GAME_POSITION_PROOF_REFRESH_RETRY_MS) {
			scheduleTagGameProofRefresh(attempt, TAG_GAME_POSITION_PROOF_REFRESH_RETRY_MS - (Date.now() - attempt.lastAttemptAtMs));
			return;
		}
		void attemptTagGameProofRefresh(attempt);
	}

	function refreshOwnTagGamePositionProof(game: TagGameState): void {
		const self = personaSnapshot;
		const member = self && game.participant.find((candidate) => candidate.pubkey === self.signer.pubkey && candidate.runNumber === self.activeRun.runNumber && candidate.status === 'active');
		if (!self || !member || game.phase !== 'running') return;
		requestTagGamePositionProofRefresh(game.gameId, self.signer.pubkey, member.runNumber, 'local-refresh');
	}

	function setTagGameTouchStatus(gameId: string, targetPubkey: string, label: string, expiry: 'unconfirmed' | 'clear', expectedVersion?: number): void {
		const currentVersion = tagGameTouchStatusVersions.get(gameId) ?? 0;
		if (expectedVersion !== undefined && currentVersion !== expectedVersion) return;
		const version = expectedVersion ?? ++tagGameTouchStatusVersionSequence;
		tagGameTouchStatusVersions.set(gameId, version);
		tagGameTouchStatusTargets.set(gameId, targetPubkey);
		const previousTimer = tagGameTouchStatusTimers.get(gameId);
		if (previousTimer !== undefined) window.clearTimeout(previousTimer);
		tagGameTouchStatuses = new Map(tagGameTouchStatuses).set(gameId, { targetPubkey, label });
		tagGameTouchStatusTimers.set(gameId, window.setTimeout(() => {
			const current = tagGameTouchStatuses.get(gameId);
			if (tagGameTouchStatusVersions.get(gameId) !== version || current?.targetPubkey !== targetPubkey || current.label !== label) return;
			if (expiry === 'unconfirmed') {
				setTagGameTouchStatus(gameId, targetPubkey, '転移未確認', 'clear', version);
				return;
			}
			tagGameTouchStatuses = new Map(tagGameTouchStatuses);
			tagGameTouchStatuses.delete(gameId);
			tagGameTouchStatusTimers.delete(gameId);
			tagGameTouchStatusVersions.delete(gameId);
			tagGameTouchStatusTargets.delete(gameId);
		}, label === '判定待ち・開催者未確認' ? 2_000 : 1_800));
	}

	function notifyTagGameTouchEvidenceWaiters(): void {
		for (const notify of tagGamePositionEvidenceWaiters) notify();
	}

	function isFreshHolderResponse(createdAtSeconds: number, receivedAtMs: number): boolean {
		if (!Number.isSafeInteger(createdAtSeconds) || !Number.isSafeInteger(receivedAtMs)) return false;
		const ageSeconds = Math.floor(receivedAtMs / 1_000) - createdAtSeconds;
		return ageSeconds >= -2 && ageSeconds <= (TAG_GAME_NO_ACTIVITY_MS + TAG_GAME_PRECHECK_TIMEOUT_MS + TAG_GAME_RESPONSE_TIMEOUT_MS) / 1_000;
	}

	function respondToTagGameHolderChallenge(state: TagGameState, action: NonNullable<ReturnType<typeof parseTagGameActionEvent>>, self: PersonaSnapshot): void {
		const challengeId = action.payload.challengeId;
		const stage = action.payload.stage;
		if (stage !== 'precheck' && stage !== 'formal') return;
		const holder = state.participant.find((member) => member.pubkey === self.signer.pubkey && member.runNumber === self.activeRun.runNumber && member.status === 'active');
		const host = state.participant.find((member) => member.pubkey === state.hostPubkey && member.runNumber === action.runNumber &&
			(member.status === 'active' || member.status === 'temporarily-ineligible'));
		const matchingStage = stage === 'precheck' ? !state.holderChallengeId : stage === 'formal' && state.holderChallengeId === challengeId;
		if (state.phase !== 'running' || !matchingStage || state.ownerPubkey !== self.signer.pubkey || !holder || !host ||
			action.event.pubkey !== state.hostPubkey || typeof challengeId !== 'string' || !/^[0-9a-f]{32}$/.test(challengeId) ||
			!isFreshHolderResponse(action.event.created_at, Date.now())) return;
		const existing = tagGameSelfChallengeResponses.get(state.gameId);
		if (existing?.challengeId === challengeId && existing.stage === stage && existing.ownerPubkey === holder.pubkey && existing.runNumber === holder.runNumber) return;
		const request: { challengeId: string; stage: 'precheck' | 'formal'; ownerPubkey: string; runNumber: number; createdAtMs: number; status: 'pending' } = {
			challengeId, stage, ownerPubkey: holder.pubkey, runNumber: holder.runNumber,
			createdAtMs: action.event.created_at * 1_000, status: 'pending' as const };
		tagGameSelfChallengeResponses.set(state.gameId, request);
		void publishTagGameAction(state.gameId, 'response', { challengeId }).then((sent) => {
			if (tagGameSelfChallengeResponses.get(state.gameId) !== request) return;
			const current = tagGameEvents.get(state.gameId)?.state;
			const currentHolder = current?.participant.find((member) => member.pubkey === request.ownerPubkey && member.runNumber === request.runNumber && member.status === 'active');
			const currentHost = current?.participant.find((member) => member.pubkey === current.hostPubkey && member.runNumber === action.runNumber &&
				(member.status === 'active' || member.status === 'temporarily-ineligible'));
			const currentStageMatches = request.stage === 'precheck' ? !current?.holderChallengeId : current?.holderChallengeId === request.challengeId;
			const stillCurrent = sent && current?.phase === 'running' && currentStageMatches && currentHost && current.hostPubkey === action.event.pubkey &&
				current.ownerPubkey === request.ownerPubkey && currentHolder && isFreshHolderResponse(action.event.created_at, Date.now());
			if (!stillCurrent) {
				tagGameSelfChallengeResponses.delete(state.gameId);
				return;
			}
			tagGameSelfChallengeResponses.set(state.gameId, { ...request, status: 'sent' });
			if (request.stage === 'precheck') {
				const responseAtMs = Date.now();
				tagGameHolderLocalActivityAt.set(state.gameId, { ownerPubkey: request.ownerPubkey, runNumber: request.runNumber, atMs: responseAtMs });
				tagGameHudNowMs = responseAtMs;
				tagGameHudLastSecond = Math.floor(responseAtMs / 1_000);
			}
		}).catch(() => {
			if (tagGameSelfChallengeResponses.get(state.gameId) === request) tagGameSelfChallengeResponses.delete(state.gameId);
		});
	}

	function acceptTagGameHolderResponse(state: TagGameState, action: NonNullable<ReturnType<typeof parseTagGameActionEvent>>): void {
		const challengeId = action.payload.challengeId;
		if (typeof challengeId !== 'string' || !isFreshHolderResponse(action.event.created_at, Date.now())) return;
		const receivedAtMs = Date.now();
		const member = state.participant.find((candidate) => candidate.pubkey === action.event.pubkey && candidate.runNumber === action.runNumber && candidate.status === 'active');
		const signedStopMatches = isValidTagGameHolderResponse({ state, pubkey: action.event.pubkey, runNumber: action.runNumber,
			challengeId, createdAtSeconds: action.event.created_at, receivedAtMs });
		const probe = tagGameHolderProbes.get(state.gameId);
		const precheckMatches = Boolean(member && probe && probe.challengeId === challengeId && probe.ownerPubkey === action.event.pubkey &&
			probe.runNumber === action.runNumber && action.event.created_at * 1_000 >= probe.startedAtMs - 2_000);
		if (!signedStopMatches && !precheckMatches) return;
		const formalAckAt = tagGameFormalChallengeAcks.get(`${state.gameId}:${challengeId}`) ?? state.holderChallengeStartedAtMs;
		if (formalAckAt !== undefined && receivedAtMs > formalAckAt + TAG_GAME_RESPONSE_TIMEOUT_MS) return;
		tagGameHolderLocalActivityAt.set(state.gameId, { ownerPubkey: action.event.pubkey, runNumber: action.runNumber, atMs: receivedAtMs });
		if (probe && probe.challengeId === challengeId) probe.responseAtMs = receivedAtMs;
		if (!signedStopMatches) {
			// Precheck is host-local activity evidence; it must not depend on a 37070 publish.
			tagGameHolderProbes.delete(state.gameId);
			return;
		}
		tagGameHolderResponsePending.add(state.gameId);
		void updateTagGameState(state.gameId, (current) => {
			if (current.phase !== 'running' || current.ownerPubkey !== action.event.pubkey ||
				(current.holderChallengeId !== challengeId && !precheckMatches)) return null;
			const currentMember = current.participant.find((candidate) => candidate.pubkey === action.event.pubkey && candidate.runNumber === action.runNumber && candidate.status === 'active');
			if (!currentMember) return null;
			const accrued = accrueTagGameState(current, receivedAtMs);
			return { ...accrued, settledAtMs: Math.max(accrued.settledAtMs, receivedAtMs), lastHolderResponseAtMs: receivedAtMs,
				holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 };
		}).then((published) => {
			if (published && tagGameHolderProbes.get(state.gameId)?.challengeId === challengeId) tagGameHolderProbes.delete(state.gameId);
			if (published && tagGameEffectPauses.get(state.gameId)?.challengeId === challengeId) tagGameEffectPauses.delete(state.gameId);
			if (published) tagGameFormalChallengeAcks.delete(`${state.gameId}:${challengeId}`);
		}).catch(() => {}).finally(() => { tagGameHolderResponsePending.delete(state.gameId); });
	}

	function publishTagGameHolderPrecheck(game: TagGameState, probe: NonNullable<ReturnType<typeof tagGameHolderProbes.get>>): void {
		if (probe.requestPending || Date.now() - probe.lastAttemptAtMs < TAG_GAME_PRECHECK_TIMEOUT_MS) return;
		probe.requestPending = true;
		probe.lastAttemptAtMs = Date.now();
		void publishTagGameAction(game.gameId, 'response-challenge', { challengeId: probe.challengeId, stage: 'precheck' }).then((sent) => {
			const current = tagGameHolderProbes.get(game.gameId);
			if (current !== probe) return;
			probe.requestPending = false;
			if (sent) probe.requestAcknowledgedAtMs = Date.now();
		});
	}

	function publishTagGameEffectStop(game: TagGameState, pause: NonNullable<ReturnType<typeof tagGameEffectPauses.get>>): void {
		if (pause.statePublishPending) return;
		pause.statePublishPending = true;
		void (async () => {
			try {
				const alreadyStopped = tagGameEvents.get(game.gameId)?.state.holderChallengeId === pause.challengeId;
				const stopped = alreadyStopped || await updateTagGameState(game.gameId, (current) => {
					if (current.phase !== 'running' || current.ownerPubkey !== pause.ownerPubkey) return null;
					if (current.holderChallengeId === pause.challengeId) return null;
					if (current.holderChallengeId) return null;
					const accrued = accrueTagGameState(current, pause.pausedAtMs);
					return { ...accrued, settledAtMs: pause.pausedAtMs, holderChallengeId: pause.challengeId,
						holderChallengeStartedAtMs: undefined, revision: current.revision + 1 };
				});
				if (!stopped) return;
				const latest = tagGameEvents.get(game.gameId)?.state;
				if (!latest || latest.holderChallengeId !== pause.challengeId || pause.formalRequestPending ||
					Date.now() - pause.formalLastAttemptAtMs < TAG_GAME_PRECHECK_TIMEOUT_MS) return;
				pause.formalRequestPending = true;
				pause.formalLastAttemptAtMs = Date.now();
				const requestSent = await publishTagGameAction(game.gameId, 'response-challenge', { challengeId: pause.challengeId, stage: 'formal' });
				pause.formalRequestPending = false;
				if (!requestSent || tagGameEffectPauses.get(game.gameId) !== pause) return;
				const acknowledgedAtMs = Date.now();
				tagGameFormalChallengeAcks.set(`${game.gameId}:${pause.challengeId}`, acknowledgedAtMs);
				await updateTagGameState(game.gameId, (current) => current.phase === 'running' && current.ownerPubkey === pause.ownerPubkey && current.holderChallengeId === pause.challengeId
					? { ...current, holderChallengeStartedAtMs: acknowledgedAtMs, revision: current.revision + 1 } : null);
			} catch {
				// The pause remains local and the next advancement retries publication.
			} finally {
				pause.statePublishPending = false;
			}
		})();
	}

	async function processTagGameTouch(
		observed: TagGameState,
		action: NonNullable<ReturnType<typeof parseTagGameActionEvent>>,
		receivedAtMs: number,
		receivedAtMonotonicMs: number
	): Promise<void> {
		if (!action || !personaSnapshot || personaSnapshot.signer.pubkey !== observed.hostPubkey || observed.phase !== 'running' || tagGameConflictSince.has(observed.gameId)) return;
		const targetPubkey = action.payload.targetPubkey;
		if (typeof targetPubkey !== 'string') return;
		const actor = observed.participant.find((member) => member.pubkey === action.event.pubkey && member.runNumber === action.runNumber && member.status === 'active');
		const target = observed.participant.find((member) => member.pubkey === targetPubkey && member.status === 'active');
		if (!actor || !target || actor.pubkey === target.pubkey) return;
		const observedEffect = tagGameScheduledEffectAt(observed, receivedAtMs);
		const validRole = observedEffect === 'benefit'
			? actor.pubkey !== observed.ownerPubkey && target.pubkey === observed.ownerPubkey
			: observedEffect === 'calamity' && actor.pubkey === observed.ownerPubkey && target.pubkey !== observed.ownerPubkey;
		if (!validRole || !tagGameOrganizerEffectActive(observed, receivedAtMs)) return;
		const actorProof = action.payload.actorProof;
		const targetProof = action.payload.targetProof;
		if (!isTagGameTouchPositionProof(actorProof) || !isTagGameTouchPositionProof(targetProof)) {
			requestTagGamePositionProofRefresh(observed.gameId, actor.pubkey, actor.runNumber, 'host-request', action.event.id);
			requestTagGamePositionProofRefresh(observed.gameId, target.pubkey, target.runNumber, 'host-request', action.event.id);
			return;
		}
		const evidenceStatus = await waitForTagGameTouchEvidence(observed, actor.pubkey, target.pubkey, actorProof, targetProof);
		if (evidenceStatus === 'missing') {
			if (tagGameTouchProofState(actor.pubkey, actor.runNumber, actorProof) === 'missing') requestTagGamePositionProofRefresh(observed.gameId, actor.pubkey, actor.runNumber, 'host-request', action.event.id);
			if (tagGameTouchProofState(target.pubkey, target.runNumber, targetProof) === 'missing') requestTagGamePositionProofRefresh(observed.gameId, target.pubkey, target.runNumber, 'host-request', action.event.id);
			return;
		}
		if (evidenceStatus !== 'ready') return;
		await updateTagGameState(observed.gameId, (current) => {
			const nowMs = Date.now();
			const elapsedSinceReceiptMs = performance.now() - receivedAtMonotonicMs;
			if (!isFreshTagGameTouchAction({ createdAtSeconds: action.event.created_at, nowMs, elapsedSinceFirstReceiptMs: elapsedSinceReceiptMs }) ||
				current.phase !== 'running' || current.holderChallengeId || nowMs >= (current.endsAt ?? 0) * 1_000 ||
				isTagGameTransferCooldownActive({ transferAtMs: current.transferAt, startedAtMs: current.startedAt! * 1_000, nowMs }) ||
				!tagGameOrganizerEffectActive(current, nowMs) || tagGameConflictSince.has(current.gameId)) return null;
			const currentEffect = tagGameScheduledEffectAt(current, nowMs);
			if (!currentEffect) return null;
			const currentActor = current.participant.find((member) => member.pubkey === action.event.pubkey && member.runNumber === action.runNumber && member.status === 'active');
			const currentTarget = current.participant.find((member) => member.pubkey === targetPubkey && member.status === 'active');
			if (!currentActor || !currentTarget ||
				tagGameTouchProofState(currentActor.pubkey, currentActor.runNumber, actorProof) !== 'ready' ||
				tagGameTouchProofState(currentTarget.pubkey, currentTarget.runNumber, targetProof) !== 'ready') return null;
			const actorPosition = tagGamePositionEvidence.get(currentActor.pubkey)?.position;
			const targetPosition = tagGamePositionEvidence.get(currentTarget.pubkey)?.position;
			if (!actorPosition || !targetPosition || Math.max(Math.abs(actorPosition.x - targetPosition.x), Math.abs(actorPosition.y - targetPosition.y)) !== 1) return null;
			const shouldTransfer = currentEffect === 'benefit'
				? currentActor.pubkey !== current.ownerPubkey && currentTarget.pubkey === current.ownerPubkey
				: currentEffect === 'calamity' && currentActor.pubkey === current.ownerPubkey && currentTarget.pubkey !== current.ownerPubkey;
			if (!shouldTransfer) return null;
			const accrued = accrueTagGameState(current, nowMs);
			return { ...accrued, ownerPubkey: accrued.effect === 'benefit' ? currentActor.pubkey : currentTarget.pubkey, transferAt: nowMs, lastHolderResponseAtMs: nowMs, revision: current.revision + 1 };
		});
	}

	function handleTagGameSupplementalEvent(event: import('nostr-tools/pure').Event): void {
		const channelId = worldReader?.getChannel()?.channelId;
		if (!channelId) return;
		if (event.kind === TAG_GAME_KIND) {
			const parsed = parseTagGameEvent(event, channelId);
			if (parsed) rememberTagGameEnvelope(parsed.event.id, parsed.event.created_at, parsed.state);
			return;
		}
		if (event.kind !== TAG_GAME_ACTION_KIND) return;
		const parsed = parseTagGameActionEvent(event, channelId);
		if (!parsed) return;
		const gameId = parsed.event.tags.find((tag) => tag[0] === 'd')?.[1];
		const state = gameId ? tagGameEvents.get(gameId)?.state : null;
		const self = personaSnapshot;
		if (!state) return;
		if (parsed.action === 'touch') {
			const receivedAtMs = Date.now();
			const receivedAtMonotonicMs = performance.now();
			if (tagGameTouchSeenEventIds.has(parsed.event.id)) return;
			for (const [eventId, seenAt] of tagGameTouchSeenEventIds) if (receivedAtMs - seenAt > 60_000) tagGameTouchSeenEventIds.delete(eventId);
			tagGameTouchSeenEventIds.set(parsed.event.id, receivedAtMs);
			if (!isFreshTagGameTouchAction({ createdAtSeconds: parsed.event.created_at, nowMs: receivedAtMs, elapsedSinceFirstReceiptMs: 0 })) return;
			void processTagGameTouch(state, parsed, receivedAtMs, receivedAtMonotonicMs);
			return;
		}
		if (parsed.action === 'response-challenge' && parsed.payload.challengeId && parsed.event.pubkey === state.hostPubkey && state.ownerPubkey === self?.signer.pubkey) {
			if (self) respondToTagGameHolderChallenge(state, parsed, self);
			return;
		}
		if (parsed.action === 'position-refresh-request') {
			const targetPubkey = parsed.payload.targetPubkey;
			const targetRunNumber = parsed.payload.targetRunNumber;
			const ownMember = self && state.participant.find((member) => member.pubkey === self.signer.pubkey && member.runNumber === self.activeRun.runNumber && member.status === 'active');
			if (self && state.phase === 'running' && parsed.event.pubkey === state.hostPubkey && targetPubkey === self.signer.pubkey && targetRunNumber === ownMember?.runNumber && ownMember) {
				requestTagGamePositionProofRefresh(state.gameId, self.signer.pubkey, ownMember.runNumber, 'local-refresh', parsed.event.id);
			}
			return;
		}
		if (!self || state.hostPubkey !== self.signer.pubkey) return;
		const currentMember = state.participant.find((member) => member.pubkey === parsed.event.pubkey && member.runNumber === parsed.runNumber);
		if (parsed.action === 'join') {
			const member = { pubkey: parsed.event.pubkey, runNumber: parsed.runNumber, registeredAt: parsed.event.created_at, status: 'registered' as const, points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 };
			void updateTagGameState(state.gameId, (current) => current.phase === 'lobby' && !current.participant.some((member) => member.pubkey === parsed.event.pubkey) && current.participant.length < 8
				? { ...current, revision: current.revision + 1, participant: [...current.participant, member] } : null);
		} else if (parsed.action === 'leave') {
			void updateTagGameState(state.gameId, (current) => {
				const member = current.participant.find((candidate) => candidate.pubkey === parsed.event.pubkey && candidate.runNumber === parsed.runNumber);
				if (!member) return null;
				if ((current.phase === 'lobby' || current.phase === 'proposed') && current.hostPubkey === parsed.event.pubkey) return null;
				if (current.phase === 'lobby' || current.phase === 'proposed') return {
					...current, phase: 'lobby', proposalId: undefined, proposalDeadline: undefined, startAt: undefined, revision: current.revision + 1,
					participant: current.participant.filter((candidate) => candidate.pubkey !== parsed.event.pubkey).map((candidate) => ({ ...candidate, consentProposalId: undefined, consented: false }))
				};
				if ((current.phase !== 'running' && current.phase !== 'settling') || (member.status !== 'active' && member.status !== 'temporarily-ineligible') || !current.endsAt) return null;
				const confirmedAtMs = Date.now();
				if (confirmedAtMs >= current.endsAt * 1000) return null;
				const accrued = accrueTagGameState(current, confirmedAtMs);
				return leaveTagGameParticipant(accrued, parsed.event.pubkey, parsed.runNumber, confirmedAtMs);
			});
		} else if (parsed.action === 'consent' && state.proposalId === parsed.payload.proposalId) {
			void updateTagGameState(state.gameId, (current) => {
				if (current.phase !== 'proposed' || parsed.event.pubkey === current.hostPubkey || !current.proposalDeadline || Date.now() >= current.proposalDeadline * 1000 || current.proposalId !== parsed.payload.proposalId ||
					!current.participant.some((member) => member.pubkey === parsed.event.pubkey && member.runNumber === parsed.runNumber)) return null;
				const participants = current.participant.map((member) => member.pubkey === parsed.event.pubkey && member.runNumber === parsed.runNumber ? { ...member, consentProposalId: current.proposalId, consented: true } : member);
				const allConsented = participants.every((member) => member.consentProposalId === current.proposalId && member.consented);
				return { ...current, revision: current.revision + 1, participant: participants, ...(allConsented ? { phase: 'countdown' as const, startAt: Math.floor(Date.now() / 1000) + 5 } : {}) };
			});
		} else if (parsed.action === 'response' && parsed.event.pubkey === state.ownerPubkey && currentMember) {
			acceptTagGameHolderResponse(state, parsed);
		}
	}

	function attemptTagGameTouch(direction: Direction): void {
		const self = personaSnapshot;
		if (!self || !selfLogicalPosition || !selfIsActive) return;
		const targetPosition = moveOneCell(selfLogicalPosition, direction, FIELD);
		if (!targetPosition) return;
		const game = tagGameDisplayedGame;
		if (!game || game.phase !== 'running' || !tagGameTouchTargetIds.size ||
			!game.participant.some((member) => member.pubkey === self.signer.pubkey && member.runNumber === self.activeRun.runNumber && member.status === 'active')) return;
		const ownEvidence = tagGamePositionEvidence.get(self.signer.pubkey);
		if (!ownEvidence || !sameFieldCell(ownEvidence.position, selfLogicalPosition)) return;
		const target = game.participant.find((member) => member.pubkey !== self.signer.pubkey && tagGameTouchTargetIds.has(member.pubkey) &&
			member.status === 'active' && tagGamePositionEvidence.get(member.pubkey) && sameFieldCell(tagGamePositionEvidence.get(member.pubkey)!.position, targetPosition));
		if (!target) return;
		const now = Date.now();
		const key = `${game.gameId}:${target.pubkey}`;
		const previousAttempt = tagGameTouchAttempts.get(key);
		const attemptId = ++tagGameTouchAttemptSequence;
		tagGameTouchAttempt = { participantId: self.signer.pubkey, direction, id: attemptId };
		window.setTimeout(() => { if (tagGameTouchAttempt?.id === attemptId) tagGameTouchAttempt = null; }, TAG_GAME_TOUCH_FEEDBACK_MS);
		if (previousAttempt !== undefined && now - previousAttempt < TAG_GAME_TOUCH_RETRY_MS) return;
		tagGameTouchAttempts.set(key, now);
		let statusVersion = tagGameTouchStatusVersions.get(game.gameId);
		const currentStatus = tagGameTouchStatuses.get(game.gameId);
		const confirmedStatusVisible = currentStatus?.label === '所持者が更新されました';
		if (!confirmedStatusVisible && (!statusVersion || tagGameTouchStatusTargets.get(game.gameId) !== target.pubkey)) {
			statusVersion = ++tagGameTouchStatusVersionSequence;
			tagGameTouchStatusVersions.set(game.gameId, statusVersion);
			tagGameTouchStatusTargets.set(game.gameId, target.pubkey);
			const previousStatusTimer = tagGameTouchStatusTimers.get(game.gameId);
			if (previousStatusTimer !== undefined) window.clearTimeout(previousStatusTimer);
			tagGameTouchStatusTimers.delete(game.gameId);
			tagGameTouchStatuses = new Map(tagGameTouchStatuses);
			tagGameTouchStatuses.delete(game.gameId);
		} else if (!confirmedStatusVisible && currentStatus?.targetPubkey === target.pubkey && currentStatus.label === '判定待ち・開催者未確認') {
			// A valid held-key retry renews the one pending display without clearing or restating it.
			setTagGameTouchStatus(game.gameId, target.pubkey, currentStatus.label, 'unconfirmed', statusVersion);
		}
		const requestKey = `${game.gameId}:${target.pubkey}`;
		const requestVersion = ++tagGameTouchRequestVersionSequence;
		tagGameTouchRequestVersions.set(requestKey, requestVersion);
		const actorAnchor = latestTagGameWorldStates.get(self.signer.pubkey);
		const targetAnchor = latestTagGameWorldStates.get(target.pubkey);
		const proof = (pubkey: string, runNumber: number): Readonly<{ worldStateEventId: string; positionEvidenceEventId: string }> | undefined => {
			const anchor = latestTagGameWorldStates.get(pubkey);
			const position = tagGamePositionEvidence.get(pubkey);
			if (!anchor || anchor.state !== 'active' || anchor.runNumber !== runNumber || !position || position.positionEvidence.source === 'world-state-exit') return undefined;
			return { worldStateEventId: anchor.id, positionEvidenceEventId: position.positionEvidence.eventId };
		};
		const actorProof = proof(self.signer.pubkey, self.activeRun.runNumber);
		const targetProof = proof(target.pubkey, target.runNumber);
		if (!actorProof) {
			refreshOwnTagGamePositionProof(game);
		}
		const transferAt = game.transferAt ?? 0;
		void publishTagGameAction(game.gameId, 'touch', { targetPubkey: target.pubkey, ...(actorProof ? { actorProof } : {}), ...(targetProof ? { targetProof } : {}) }).then((sent) => {
			if (tagGameTouchStatusVersions.get(game.gameId) !== statusVersion || tagGameTouchStatusTargets.get(game.gameId) !== target.pubkey) return;
			const current = tagGameEvents.get(game.gameId)?.state;
			const visibleStatus = tagGameTouchStatuses.get(game.gameId);
			if (visibleStatus?.label === '所持者が更新されました') return;
			if (!sent) {
				if (tagGameTouchRequestVersions.get(requestKey) !== requestVersion || visibleStatus?.label === '判定待ち・開催者未確認' || visibleStatus?.label === '転移未確認') return;
				setTagGameTouchStatus(game.gameId, target.pubkey, '送信未確認', 'clear', statusVersion);
			} else if (current?.transferAt && current.transferAt > transferAt) {
				setTagGameTouchStatus(game.gameId, target.pubkey, '所持者が更新されました', 'clear', statusVersion);
			} else if (tagGameTouchRequestVersions.get(requestKey) === requestVersion) {
				setTagGameTouchStatus(game.gameId, target.pubkey, '判定待ち・開催者未確認', 'unconfirmed', statusVersion);
			}
		});
	}

	function handleTagGameWorldState(event: ParsedWorldStateEvent): void {
		rememberTagGameEvidenceId(tagGameWorldStateIdsByPubkey, event.pubkey, event.id);
		if (appliedTagGameWorldStateIds.has(event.id)) return;
		appliedTagGameWorldStateIds.add(event.id);
		const previous = latestTagGameWorldStates.get(event.pubkey);
		if (previous && comparePresenceEvidence(presenceEvidenceFromWorldState(event), presenceEvidenceFromWorldState(previous)) <= 0) return;
		latestTagGameWorldStates = new Map(latestTagGameWorldStates).set(event.pubkey, event);
		for (const attempt of tagGameProofRefreshAttempts.values()) {
			if (attempt.pubkey === event.pubkey) completeTagGameProofRefreshIfResolved(attempt);
		}
		if (event.state === 'exit' && event.exitReason && event.runNumber !== null) {
			for (const game of tagGameStates) {
			if (game.hostPubkey !== event.pubkey || !['lobby', 'proposed', 'countdown', 'running', 'settling'].includes(game.phase)) continue;
				const host = game.participant.find((member) => member.pubkey === event.pubkey && member.runNumber === event.runNumber);
				if (!host) continue;
				const interrupted: TagGameState = { ...game, phase: 'interrupted', endReason: 'host-exit', revision: game.revision + 1 };
				tagGameEvents.set(game.gameId, { eventId: `exit:${event.id}`, createdAt: event.createdAt, state: interrupted });
				void syncTagGameLifecycle(interrupted);
			}
			refreshTagGameStateList();
		}
		if (event.state === 'active' && event.runNumber !== null) {
			for (const game of tagGameStates) {
				if (game.hostPubkey !== personaSnapshot?.signer.pubkey || game.phase !== 'running') continue;
				const member = game.participant.find((candidate) => candidate.pubkey === event.pubkey && candidate.runNumber === event.runNumber && candidate.status === 'temporarily-ineligible');
				if (member) void updateTagGameState(game.gameId, (current) => ({ ...current, participant: current.participant.map((candidate) => candidate.pubkey === event.pubkey && candidate.runNumber === event.runNumber && candidate.status === 'temporarily-ineligible' ? { ...candidate, status: 'active' } : candidate), revision: current.revision + 1 }));
			}
		}
		if (event.state !== 'exit' || !event.exitReason || event.runNumber === null) return;
		for (const game of tagGameStates) {
			if (game.hostPubkey !== personaSnapshot?.signer.pubkey || (game.phase !== 'running' && game.phase !== 'settling')) continue;
			const participant = game.participant.find((member) => member.pubkey === event.pubkey && member.runNumber === event.runNumber && member.status === 'active');
			if (!participant) continue;
			const status = event.exitReason === 'death' ? 'dead' as const : 'left' as const;
			void updateTagGameState(game.gameId, (current) => {
				const member = current.participant.find((candidate) => candidate.pubkey === event.pubkey && candidate.runNumber === event.runNumber && candidate.status === 'active');
				if (!member || !['running', 'settling'].includes(current.phase)) return null;
				const accrued = accrueTagGameState(current, Date.now());
				const participants = accrued.participant.map((candidate) => candidate.pubkey === event.pubkey && candidate.runNumber === event.runNumber ? { ...candidate, status } : candidate);
				const remaining = participants.filter((candidate) => candidate.status === 'active');
				if (remaining.length <= 1) return { ...accrued, phase: 'interrupted', endReason: 'too-few-participants', participant: participants, revision: current.revision + 1 };
				let ownerPubkey = current.ownerPubkey;
				if (ownerPubkey === event.pubkey) {
					const hash = [...(current.seed ?? '')].reduce((value, char) => (Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0), 2166136261);
					ownerPubkey = remaining[hash % remaining.length].pubkey;
				}
				const transferred = ownerPubkey !== current.ownerPubkey;
				const transferAt = Date.now();
				return { ...accrued, participant: participants, ownerPubkey, transferAt,
					...(transferred ? { lastHolderResponseAtMs: transferAt } : {}), revision: current.revision + 1 };
			});
		}
	}

	function tagGameHolderMember(game: TagGameState) {
		return game.participant.find((member) => member.pubkey === game.ownerPubkey && member.status === 'active');
	}

	function tagGameHolderActivityAt(game: TagGameState, nowMs = Date.now()): number {
		const holder = tagGameHolderMember(game);
		const normalActivityAtMs = presenceState.participants.find((participant) => participant.id === game.ownerPubkey)?.lastActivityAt ?? 0;
		const probe = tagGameHolderProbes.get(game.gameId);
		const probeResponseAtMs = probe && probe.ownerPubkey === game.ownerPubkey && probe.runNumber === holder?.runNumber ? probe.responseAtMs ?? 0 : 0;
		const localResponse = tagGameHolderLocalActivityAt.get(game.gameId);
		const localResponseAtMs = localResponse && localResponse.ownerPubkey === game.ownerPubkey && localResponse.runNumber === holder?.runNumber ? localResponse.atMs : 0;
		return latestTagGameHolderActivityAt({ nowMs, startedAtMs: (game.startedAt ?? 0) * 1_000,
			transferAtMs: game.transferAt ?? null, persistedResponseAtMs: game.lastHolderResponseAtMs ?? null,
			worldActivityAtMs: normalActivityAtMs, precheckResponseAtMs: probeResponseAtMs || null,
			localResponseAtMs: localResponseAtMs || null });
	}

	function tagGameEffectCutoff(game: TagGameState): number {
		if (!game.endsAt) return Number.POSITIVE_INFINITY;
		return tagGameEffectSafetyCutoffMs(tagGameHolderActivityAt(game), game.endsAt * 1_000);
	}

	function tagGameOrganizerEffectActive(game: TagGameState, nowMs: number): boolean {
		const holder = tagGameHolderMember(game);
		const pause = tagGameEffectPauses.get(game.gameId);
		return isTagGameScheduledEffectActive(game, nowMs) && !game.holderChallengeId &&
			!(pause && pause.ownerPubkey === game.ownerPubkey && pause.runNumber === holder?.runNumber) && nowMs < tagGameEffectCutoff(game);
	}

	function accrueTagGameState(game: TagGameState, untilMs: number): TagGameState {
		if (!game.startedAt || !game.seed) return game;
		const holder = tagGameHolderMember(game);
		const pause = tagGameEffectPauses.get(game.gameId);
		const localPauseAt = pause && pause.ownerPubkey === game.ownerPubkey && pause.runNumber === holder?.runNumber ? pause.pausedAtMs : Number.POSITIVE_INFINITY;
		const signedPauseAt = game.holderChallengeId ? game.settledAtMs : Number.POSITIVE_INFINITY;
		const cap = Math.min(untilMs, game.endsAt ? game.endsAt * 1000 : untilMs, tagGameEffectCutoff(game), localPauseAt, signedPauseAt);
		const end = Math.max(game.settledAtMs, cap);
		const players = game.participant.map((member) => ({ ...member }));
		const intervals = createTagGameSchedule(game.seed);
		let cursor = Math.max(game.settledAtMs, game.startedAt * 1000);
		while (cursor < end) {
			const elapsed = cursor - game.startedAt * 1000;
			let boundary = 0;
			let index = 0;
			for (; index < intervals.length; index++) { boundary += intervals[index].durationMs; if (elapsed < boundary) break; }
			if (index >= intervals.length) break;
			const segmentEnd = Math.min(end, game.startedAt * 1000 + boundary);
			const duration = segmentEnd - cursor;
			const ownerIndex = players.findIndex((member) => member.pubkey === game.ownerPubkey && member.status === 'active');
			if (ownerIndex >= 0) {
				const owner = players[ownerIndex];
				if (intervals[index].effect === 'benefit') {
					const benefitMs = owner.benefitMs + duration;
					players[ownerIndex] = { ...owner, benefitMs, points: Math.floor(benefitMs * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1000) };
				} else {
					const calamityMs = owner.calamityMs + duration;
					players[ownerIndex] = { ...owner, calamityMs, lifespanLossMs: Math.floor(calamityMs * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1000) };
				}
			}
			cursor = segmentEnd;
		}
	let boundary = 0;
	let effect = intervals.at(-1)!.effect;
	for (const interval of intervals) { boundary += interval.durationMs; if (end - game.startedAt * 1000 < boundary) { effect = interval.effect; break; } }
	return { ...game, participant: players, settledAtMs: end, effect };
	}

	async function advanceTagGames(nowMs: number): Promise<void> {
		if (advancingTagGames) return;
		advancingTagGames = true;
		try {
		const nowSeconds = Math.floor(nowMs / 1000);
		const selfPubkey = personaSnapshot?.signer.pubkey;
		const reservation = personaSnapshot?.tagGame?.reservation;
		if (reservation?.recoveryDeadlineMs !== undefined && nowMs >= reservation.recoveryDeadlineMs) {
			const recovered = tagGameEvents.get(reservation.gameId)?.state;
			const member = recovered?.participant.find((player) => player.pubkey === selfPubkey && player.runNumber === personaSnapshot?.activeRun.runNumber);
			const stillValid = Boolean(recovered && member && !['ended', 'interrupted'].includes(recovered.phase) &&
				(recovered.phase === 'lobby' ? isFreshTagGameLobby(recovered, nowSeconds) :
					recovered.phase === 'proposed' ? Boolean(recovered.proposalDeadline && recovered.proposalDeadline >= nowSeconds) :
					recovered.phase === 'countdown' ? Boolean(recovered.startAt && recovered.startAt >= nowSeconds - 5) :
					(recovered.phase === 'running' || recovered.phase === 'settling') && Boolean(recovered.endsAt && nowSeconds <= recovered.endsAt + TAG_GAME_FINAL_WAIT_MS / 1000)));
			if (stillValid) {
				if (personaSnapshot && await confirmTagGameParticipation(personaSnapshot, reservation.gameId)) await refreshTagGamePersona(personaSnapshot);
			} else if (personaSnapshot) await releaseAndRefreshTagGameParticipation(personaSnapshot, reservation.gameId);
		}
		for (const entry of [...tagGameEvents.values()]) {
			let game = entry.state;
			const hostFinalWaitDeadline = game.endsAt ? game.endsAt * 1000 + TAG_GAME_FINAL_WAIT_MS : Number.POSITIVE_INFINITY;
			const silenceProbeAt = game.endsAt && ['running', 'settling'].includes(game.phase)
				? Math.min(entry.createdAt * 1000 + 30_000, hostFinalWaitDeadline - 5_000)
				: entry.createdAt * 1000 + 30_000;
			if (game.hostPubkey !== selfPubkey && ['lobby', 'proposed', 'countdown', 'running', 'settling'].includes(game.phase) && realtimeStatus === 'active' &&
				nowMs >= silenceProbeAt) {
				const probingAt = tagGameHostProbeAtMs.get(game.gameId);
				if (probingAt === undefined) {
					tagGameHostProbeAtMs.set(game.gameId, nowMs);
					worldReader?.stopRealtime();
					void worldReader?.startRealtime();
				} else if (nowMs >= Math.max(probingAt + 5_000, game.endsAt && ['running', 'settling'].includes(game.phase) && nowMs >= game.endsAt * 1000 ? hostFinalWaitDeadline : 0) && realtimeStatus === 'active') {
					tagGameHostProbeAtMs.delete(game.gameId);
					const interrupted = { ...game, phase: 'interrupted' as const, endReason: 'host-unavailable' as const, revision: game.revision + 1 };
					tagGameEvents.set(game.gameId, { ...entry, state: interrupted });
					await syncTagGameLifecycle(interrupted);
					refreshTagGameStateList();
					continue;
				}
			}
			const conflictSince = tagGameConflictSince.get(game.gameId);
			if (conflictSince !== undefined) {
				if (nowMs - conflictSince >= 30_000) {
					const interrupted: TagGameState = { ...game, phase: 'interrupted', endReason: 'conflict', revision: game.revision + 1 };
					tagGameConflictSince.delete(game.gameId);
					tagGameEvents.set(game.gameId, { ...entry, state: interrupted });
					void syncTagGameLifecycle(interrupted);
					refreshTagGameStateList();
					continue;
				} else continue;
			}
			if (game.hostPubkey === selfPubkey && game.phase === 'lobby' && nowMs - (tagGameLastLobbyRenewalMs.get(game.gameId) ?? 0) >= TAG_GAME_LOBBY_RENEW_MS) {
				tagGameLastLobbyRenewalMs.set(game.gameId, nowMs);
				void updateTagGameState(game.gameId, (current) => current.phase === 'lobby' ? { ...current, revision: current.revision + 1 } : null);
			}
			if (game.hostPubkey === selfPubkey && game.phase === 'proposed' && game.proposalDeadline && nowSeconds >= game.proposalDeadline) {
				void updateTagGameState(game.gameId, (current) => {
					if (current.phase !== 'proposed' || !current.proposalDeadline || nowSeconds < current.proposalDeadline) return null;
					const remaining = current.participant.filter((member) => member.consentProposalId === current.proposalId && member.consented);
					const hostIncluded = remaining.some((member) => member.pubkey === current.hostPubkey);
					return { ...current, phase: 'lobby', proposalId: undefined, proposalDeadline: undefined,
						participant: hostIncluded ? remaining : current.participant.filter((member) => member.pubkey === current.hostPubkey), revision: current.revision + 1 };
				});
			}
			if (game.hostPubkey === selfPubkey && game.phase === 'countdown' && game.startAt && nowSeconds >= game.startAt) {
				const seed = tagGameNonce() + tagGameNonce();
				const schedule = createTagGameSchedule(seed);
					const roster = game.participant.filter((member) => {
						const latest = latestTagGameWorldStates.get(member.pubkey);
						return member.consentProposalId === game.proposalId && member.consented && (!latest || latest.state === 'active' && (latest.runNumber === null || latest.runNumber === member.runNumber));
					});
				if (roster.length < 2) {
					void updateTagGameState(game.gameId, (current) => current.phase === 'countdown' ? { ...current, phase: 'lobby', startAt: undefined, participant: current.participant.filter((member) => member.pubkey === current.hostPubkey), revision: current.revision + 1 } : null);
				} else {
					const hash = [...seed].reduce((value, char) => (Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0), 2166136261);
					void updateTagGameState(game.gameId, (current) => {
						if (current.phase !== 'countdown' || !current.startAt || nowSeconds < current.startAt) return null;
						const activeRoster = current.participant.filter((member) => member.consentProposalId === current.proposalId && member.consented &&
							(!latestTagGameWorldStates.has(member.pubkey) || (latestTagGameWorldStates.get(member.pubkey)!.state === 'active' && (latestTagGameWorldStates.get(member.pubkey)!.runNumber === null || latestTagGameWorldStates.get(member.pubkey)!.runNumber === member.runNumber))));
						if (activeRoster.length < 2) return { ...current, phase: 'lobby', startAt: undefined, participant: current.participant.filter((member) => member.pubkey === current.hostPubkey), revision: current.revision + 1 };
						const startedAt = current.startAt;
						return { ...current, phase: 'running', revision: current.revision + 1, startedAt, endsAt: startedAt + TAG_GAME_GAME_MS / 1000,
							seed, ownerPubkey: activeRoster[hash % activeRoster.length].pubkey, effect: schedule[0].effect, transferAt: startedAt * 1000, lastHolderResponseAtMs: startedAt * 1000,
							participant: activeRoster.map((member) => ({ ...member, status: 'active', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 })), settledAtMs: startedAt * 1000 };
					});
				}
			}
			if (game.hostPubkey === selfPubkey && (game.phase === 'running' || game.phase === 'settling') && game.seed && game.startedAt && game.endsAt) {
				if (nowMs >= game.endsAt * 1000) {
					void updateTagGameState(game.gameId, (current) => {
						if ((current.phase !== 'running' && current.phase !== 'settling') || !current.endsAt || nowMs < current.endsAt * 1000) return null;
						const accrued = accrueTagGameState(current, current.endsAt * 1000);
						return { ...accrued, phase: 'ended', finalizedAt: current.endsAt, endReason: 'normal', holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 };
					});
					continue;
				}
				const holder = tagGameHolderMember(game);
				if (!holder) continue;
				let probe = tagGameHolderProbes.get(game.gameId);
				if (probe && (probe.ownerPubkey !== game.ownerPubkey || probe.runNumber !== holder.runNumber)) {
					tagGameHolderProbes.delete(game.gameId);
					probe = undefined;
				}
				let pause = tagGameEffectPauses.get(game.gameId);
				if (game.holderChallengeId && (!pause || pause.challengeId !== game.holderChallengeId)) {
					pause = { challengeId: game.holderChallengeId, ownerPubkey: game.ownerPubkey!, runNumber: holder.runNumber,
						pausedAtMs: game.settledAtMs, statePublishPending: false, formalRequestPending: false, formalLastAttemptAtMs: 0 };
					tagGameEffectPauses.set(game.gameId, pause);
				}
				if (pause && (pause.ownerPubkey !== game.ownerPubkey || pause.runNumber !== holder.runNumber)) {
					tagGameEffectPauses.delete(game.gameId);
					pause = undefined;
				}
				const holderActivityAt = tagGameHolderActivityAt(game, nowMs);
				if (pause) {
					if (holderActivityAt > pause.pausedAtMs) {
						const resumeAtMs = holderActivityAt;
						void updateTagGameState(game.gameId, (current) => {
							if (current.phase !== 'running' || current.ownerPubkey !== pause!.ownerPubkey ||
								current.participant.find((member) => member.pubkey === current.ownerPubkey)?.runNumber !== pause!.runNumber) return null;
							const accrued = accrueTagGameState(current, resumeAtMs);
						return { ...accrued, settledAtMs: Math.max(accrued.settledAtMs, resumeAtMs),
							lastHolderResponseAtMs: Math.max(current.lastHolderResponseAtMs ?? 0, probe?.responseAtMs ?? 0, resumeAtMs),
							holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 };
						}).then((published) => {
							if (published && tagGameEffectPauses.get(game.gameId) === pause) tagGameEffectPauses.delete(game.gameId);
							if (published && tagGameHolderProbes.get(game.gameId) === probe) tagGameHolderProbes.delete(game.gameId);
						});
						continue;
					}
					const challengeStartedAtMs = tagGameFormalChallengeAcks.get(`${game.gameId}:${pause.challengeId}`) ?? game.holderChallengeStartedAtMs ?? null;
					if (challengeStartedAtMs === null) publishTagGameEffectStop(game, pause);
					if (!tagGameHolderResponsePending.has(game.gameId) && challengeStartedAtMs !== null && nowMs - challengeStartedAtMs >= TAG_GAME_RESPONSE_TIMEOUT_MS) {
					const eligible = game.participant.filter((member) => member.status === 'active' && member.pubkey !== game.ownerPubkey);
					if (eligible.length <= 1) {
						void updateTagGameState(game.gameId, (current) => current.holderChallengeId === pause!.challengeId ? { ...accrueTagGameState(current, pause!.pausedAtMs), phase: 'interrupted', endReason: 'too-few-participants', holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 } : null);
						continue;
					}
					void updateTagGameState(game.gameId, (current) => {
						const candidates = current.participant.filter((member) => member.status === 'active' && member.pubkey !== current.ownerPubkey);
						if (current.holderChallengeId !== pause!.challengeId || candidates.length <= 1) return current.holderChallengeId === pause!.challengeId ? { ...accrueTagGameState(current, pause!.pausedAtMs), phase: 'interrupted', endReason: 'too-few-participants', holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 } : null;
						const selected = candidates[createTagGameSchedule(current.seed ?? '')[0].durationMs % candidates.length];
						return { ...accrueTagGameState(current, pause!.pausedAtMs), ownerPubkey: selected.pubkey, participant: current.participant.map((member) => member.pubkey === current.ownerPubkey ? { ...member, status: 'temporarily-ineligible' } : member), transferAt: nowMs, lastHolderResponseAtMs: nowMs, settledAtMs: nowMs, holderChallengeId: undefined, holderChallengeStartedAtMs: undefined, revision: current.revision + 1 };
					});
						continue;
					}
				} else {
					if (probe && holderActivityAt > probe.startedAtMs) {
						tagGameHolderProbes.delete(game.gameId);
						probe = undefined;
					}
					if (!probe && nowMs - holderActivityAt >= TAG_GAME_NO_ACTIVITY_MS) {
						probe = { challengeId: tagGameNonce(), ownerPubkey: game.ownerPubkey!, runNumber: holder.runNumber,
							startedAtMs: nowMs, requestAcknowledgedAtMs: null, responseAtMs: null, lastAttemptAtMs: 0, requestPending: false };
						tagGameHolderProbes.set(game.gameId, probe);
					}
					if (probe) publishTagGameHolderPrecheck(game, probe);
					const cutoffAtMs = tagGameEffectCutoff(game);
					if (nowMs >= cutoffAtMs) {
						const stopProbe = probe ?? { challengeId: tagGameNonce(), ownerPubkey: game.ownerPubkey!, runNumber: holder.runNumber,
							startedAtMs: cutoffAtMs - TAG_GAME_PRECHECK_TIMEOUT_MS, requestAcknowledgedAtMs: null, responseAtMs: null, lastAttemptAtMs: 0, requestPending: false };
						if (!probe) tagGameHolderProbes.set(game.gameId, stopProbe);
						pause = { challengeId: stopProbe.challengeId, ownerPubkey: game.ownerPubkey!, runNumber: holder.runNumber,
							pausedAtMs: cutoffAtMs, statePublishPending: false, formalRequestPending: false, formalLastAttemptAtMs: 0 };
						tagGameEffectPauses.set(game.gameId, pause);
						publishTagGameEffectStop(game, pause);
						continue;
					}
				}
				if (game.holderChallengeId && pause) continue;
				const endMs = game.endsAt * 1000;
				const untilMs = Math.max(game.settledAtMs, Math.min(nowMs, endMs));
				const accrued = accrueTagGameState(game, untilMs);
				const finished = nowMs >= endMs;
				if (finished) game = { ...accrued, phase: 'settling', revision: game.revision + 1 };
				else if (untilMs - game.settledAtMs >= 10_000) game = { ...accrued, revision: game.revision + 1 };
				if (game !== entry.state) void updateTagGameState(game.gameId, (current) => {
					if (current.phase !== 'running' && current.phase !== 'settling') return null;
					const currentUntil = Math.max(current.settledAtMs, Math.min(nowMs, (current.endsAt ?? 0) * 1000));
					const currentAccrued = accrueTagGameState(current, currentUntil);
					if (current.endsAt && nowMs >= current.endsAt * 1000) return { ...currentAccrued, phase: 'ended', finalizedAt: nowSeconds, endReason: 'normal', revision: current.revision + 1 };
					return currentUntil - current.settledAtMs >= 10_000 ? { ...currentAccrued, revision: current.revision + 1 } : null;
				});
			}
			if (game.endsAt && (game.phase === 'running' || game.phase === 'settling') && nowMs >= game.endsAt * 1000 + TAG_GAME_FINAL_WAIT_MS) {
				const timedOut = { ...game, phase: 'ended' as const, finalizedAt: game.endsAt + TAG_GAME_FINAL_WAIT_MS / 1000, endReason: 'normal' as const };
				tagGameEvents.set(game.gameId, { ...entry, state: timedOut });
				await syncTagGameLifecycle(timedOut);
				refreshTagGameStateList();
			}
		}
		} finally { advancingTagGames = false; }
	}

	function handleRealtimeEnvelope(envelope: RealtimeEnvelope): void {
		if (envelope.eventType !== 'cooperation-defection') return;
		const parsed = parseCooperationDefectionEvent(envelope.event, envelope.channelId, realtimeEventRegistry);
		const eventSchedule = parsed ? getCooperationDefectionScheduleForInstance(parsed.instanceId, Date.now()) : null;
		if (!parsed || !eventSchedule) return;
		if (parseManualCooperationDefectionInstanceId(parsed.instanceId) && parsed.instanceId !== selectedManualCooperationDefectionInstanceId && !realtimeRecoveryInstanceIds.has(parsed.instanceId)) return;
		const state = ensureCooperationDefectionSession(parsed.instanceId);
		const next = applyCooperationDefectionAction(state, {
			id: envelope.event.id,
			pubkey: envelope.event.pubkey,
			createdAt: envelope.event.created_at * 1000,
			action: parsed.action
		});
		if (parsed.instanceId === cooperationDefectionSchedule.instanceId) cooperationDefectionSession = next;
		else recoveredCooperationDefectionSessions.set(parsed.instanceId, next);
		if (personaSnapshot && parsed.action.action === 'join' && envelope.event.pubkey === selfSigner?.pubkey) {
			realtimeRecoveryInstanceIds.add(parsed.instanceId);
			pendingRealtimeSettlement = true;
			void trackRealtimeEventInstance(personaSnapshot, parsed.instanceId);
		}
		if (parsed.instanceId === cooperationDefectionSchedule.instanceId) reconcileCooperationDefectionSession(Date.now());
		else {
			const settled = cooperationDefectionRealtimeBootstrapComplete ? settleCooperationDefectionSession(next, eventSchedule, Date.now()) : next;
			recoveredCooperationDefectionSessions.set(parsed.instanceId, settled);
			if (cooperationDefectionRealtimeBootstrapComplete) {
				const resultMessageDispatch = publishCooperationDefectionResultMessages(settled, eventSchedule);
				void settleOwnCooperationDefectionOutcomes(settled, resultMessageDispatch);
			}
		}
	}

	async function publishCooperationDefectionAction(action: Parameters<typeof buildCooperationDefectionActionTemplate>[0]['action']): Promise<string | null> {
		if (!selfSigner || !worldSession || realtimeStatus !== 'active') return null;
		const channel = worldSession.getChannel();
		if (!channel) return null;
		try {
			const event = finalizeRealtimeEvent(buildCooperationDefectionActionTemplate({ channelId: channel.channelId, relayHint: channel.relayHint,
				instanceId: cooperationDefectionSchedule.instanceId, action, createdAt: Math.floor(Date.now() / 1000) }), selfSigner.secretKey);
			const result = await worldSession.publishRealtime(event);
			if (result.outcome !== 'accepted' && result.outcome !== 'echoed') return null;
			handleRealtimeEnvelope({ event, channelId: channel.channelId, eventType: 'cooperation-defection', protocolVersion: 1,
				protocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey, instanceId: cooperationDefectionSchedule.instanceId,
				payload: action, definition: COOPERATION_DEFECTION_EVENT_DEFINITION });
			return event.id;
		} catch {
			return null;
		}
	}

	async function joinCooperationDefectionGroup(groupId: string, position: { x: number; y: number }): Promise<void> {
		if (devCooperationDefectionPlaygroundEnabled) {
			if (!selfIsActive || !selfLogicalPosition) return;
			if (Math.max(Math.abs(selfLogicalPosition.x - position.x), Math.abs(selfLogicalPosition.y - position.y)) > 1) {
				showTraceProximityFeedback(position, '近づくと参加地点を操作できる');
				return;
			}
			if (devCooperationDefectionPlayground) {
				devCooperationDefectionPlaygroundState = devCooperationDefectionPlayground.joinSelf(groupId);
				cooperationDefectionSchedule = devCooperationDefectionPlaygroundState.schedule;
				cooperationDefectionNowMs = devCooperationDefectionPlaygroundState.nowMs;
				cooperationDefectionSession = devCooperationDefectionPlaygroundState.session;
			}
			return;
		}
		if (!selfSigner || !selfIsActive || !selfLogicalPosition || cooperationDefectionSchedule.phase !== 'registration') return;
		if (Math.max(Math.abs(selfLogicalPosition.x - position.x), Math.abs(selfLogicalPosition.y - position.y)) > 1) {
			showTraceProximityFeedback(position, '近づくと参加地点を操作できる');
			return;
		}
		pendingCooperationDefectionJoin = { instanceId: cooperationDefectionSchedule.instanceId, groupId, position: { ...position } };
		cooperationDefectionRulesDialogMode = 'join-confirmation';
		cooperationDefectionRulesDialogOpen = true;
	}

	function discardPendingCooperationDefectionJoin(): void {
		cooperationDefectionRulesDialogOpen = false;
		pendingCooperationDefectionJoin = null;
	}

	async function confirmCooperationDefectionJoin(): Promise<void> {
		const pending = pendingCooperationDefectionJoin;
		if (!pending) return;
		const currentGroup = realtimeGroups.find((group) => group.id === pending.groupId);
		const isCurrentGroup = currentGroup?.position.x === pending.position.x && currentGroup.position.y === pending.position.y;
		const isInRange = Boolean(selfLogicalPosition && Math.max(
			Math.abs(selfLogicalPosition.x - pending.position.x),
			Math.abs(selfLogicalPosition.y - pending.position.y)
		) <= 1);
		const canStillJoin = Boolean(selfSigner && selfIsActive && selfLogicalPosition &&
			cooperationDefectionSchedule.phase === 'registration' && pending.instanceId === cooperationDefectionSchedule.instanceId &&
			isCurrentGroup && isInRange);
		discardPendingCooperationDefectionJoin();
		if (!canStillJoin) return;
		await publishCooperationDefectionAction({ action: 'join', groupId: pending.groupId });
	}

	async function chooseCooperationDefectionChoice(choice: CooperationDefectionChoice): Promise<void> {
		if (devCooperationDefectionPlaygroundEnabled) {
			if (devCooperationDefectionPlayground) {
				devCooperationDefectionPlaygroundState = devCooperationDefectionPlayground.chooseSelf(choice);
				cooperationDefectionSchedule = devCooperationDefectionPlaygroundState.schedule;
				cooperationDefectionNowMs = devCooperationDefectionPlaygroundState.nowMs;
				cooperationDefectionSession = devCooperationDefectionPlaygroundState.session;
			}
			return;
		}
		if (!cooperationDefectionCanChoose || !selfSigner || !cooperationDefectionSelfGroupId || !cooperationDefectionRound ||
			(cooperationDefectionSelection?.round === cooperationDefectionRound && cooperationDefectionSelection.commitPublished)) return;
		const nonce = createCooperationDefectionNonce();
		const action = buildCooperationDefectionCommitAction({ instanceId: cooperationDefectionSchedule.instanceId, groupId: cooperationDefectionSelfGroupId, round: cooperationDefectionRound, authorPubkey: selfSigner.pubkey, choice, nonce });
		const commitId = await publishCooperationDefectionAction(action);
		if (!commitId) return;
		cooperationDefectionSelection = { round: cooperationDefectionRound, choice, nonce, commitId, commitPublished: true, revealAttempted: false, revealStatus: 'idle' };
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
		const cooperationDefectionGroup = cooperationDefectionSchedule.phase === 'registration' ? realtimeGroups.find((group) => sameCell(group.position, position)) : undefined;
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
			tagGameTerminal: canUseTagGameTerminal && sameFieldCell(position, TAG_GAME_TERMINAL.position),
			cooperationDefectionGroupId: cooperationDefectionGroup?.id,
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
		if (target && accepted?.kind === 'open') traceReplyMode = selectTraceReplyTarget(traceReplyMode, target);
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
		if (target?.targetId !== targetId || !worldReader) return null;
		const event = await worldReader.getTracePreviewEvent(target.rootId, targetId);
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
		if (action.kind === 'tag-game-terminal') {
			tagGamePanelOpen = true;
			return;
		}
		if (action.kind === 'cooperation-defection-group') {
			const group = realtimeGroups.find((candidate) => candidate.id === action.groupId);
			if (group) void joinCooperationDefectionGroup(group.id, group.position);
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
			if (sameFieldCell(position, TAG_GAME_TERMINAL.position) && selfIsActive) {
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

	function watchTagGame(gameId: string): void {
		tagGameWatchedGameId = gameId;
		tagGameHudNowMs = Date.now();
		tagGameHudLastSecond = Math.floor(tagGameHudNowMs / 1000);
	}

	function stopWatchingTagGame(): void {
		tagGameWatchedGameId = null;
	}

	function fieldActionLabel(action: FieldCellAction): string {
		if (action.kind === 'mending-terminal') return '作業端末を使う';
		if (action.kind === 'adjustment-terminal') return '能力強化端末を使う';
		if (action.kind === 'tag-game-terminal') return '鬼ごっこ端末を使う';
		if (action.kind === 'cooperation-defection-group') return '参加地点から参加';
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
			deathPresentation ||
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
			deathPresentation ||
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
			deathPresentation ||
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
		if (deathPresentation) {
			if (event.code === 'Escape') event.preventDefault();
			return;
		}
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
			toggleChatter();
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
		if (deathPresentation && deathPresentationElement && event.target instanceof Node && !deathPresentationElement.contains(event.target)) {
			deathPresentationElement.focus();
			return;
		}
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
		if (deathPresentation) return;
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
		currentSession: ReturnType<typeof createWorldReadSession> | null,
		showPresentation = true
	): Promise<'reloaded' | 'presenting' | 'failed'> {
		if (devWorldSandboxEnabled || personaLifecycleTransition || deathTransitionInFlight) return 'failed';
		deathTransitionInFlight = true;
		stopPersonaInteractions('Persona lifetime ended.');
		const preparedExit = currentSession?.prepareTerminalExit(expected.signer.pubkey, 'death');
		const exitRequest = preparedExit?.kind === 'prepared' && currentSession?.getChannel()
			? { channelId: currentSession.getChannel()!.channelId, position: preparedExit.parsed.position,
				lastPositiveCreatedAt: preparedExit.parsed.createdAt }
			: undefined;
		try {
			const result = await transitionExpiredPersona(expected, exitRequest);
			if (result.kind === 'transitioned') {
				if (result.exit && preparedExit?.kind === 'prepared') {
					try { currentSession?.commitTerminalExit(result.exit); } catch { /* Durable death is already committed. */ }
				}
				storeRunTransitionNotice('dead');
				const canonicalPosition = preparedExit?.kind === 'prepared'
					? { ...preparedExit.parsed.position }
					: null;
				if (showPresentation) {
					if (result.exit && preparedExit?.kind === 'prepared') currentSession?.enableDeathLastWords();
					deathPresentationContent = '';
					startDeathPresentation(currentSession, canonicalPosition, null);
					const terminalExitPublication = result.exit && preparedExit?.kind === 'prepared' && currentSession
						? currentSession.publishTerminalExit().then(() => undefined).catch(() => undefined)
						: null;
					if (deathPresentation) deathPresentation = { ...deathPresentation, terminalExitPublication };
					return 'presenting';
				}
				try {
					if (result.exit && preparedExit?.kind === 'prepared') await currentSession?.publishTerminalExit();
				} catch {
					// The local death is already durable; World State exit is best effort.
				}
				disposePersonaWriter(currentSession);
				window.location.reload();
				return 'reloaded';
			}
			if (result.kind === 'superseded' || result.kind === 'not-expired') {
				// The writer and interaction paths were already stopped before the
				// lifecycle recheck. Reconcile the current lifecycle through the
				// normal startup path instead of reviving a stale writer in-place.
				disposePersonaWriter(currentSession);
				window.location.reload();
				return 'reloaded';
			}
			disposePersonaWriter(currentSession);
			enterReadOnlyFallback('Persona is unavailable for publishing.');
			return 'failed';
		} catch {
			enterReadOnlyFallback('Persona is unavailable for publishing.');
			return 'failed';
		} finally {
			deathTransitionInFlight = false;
		}
	}

	async function finishDeathPresentation(publish: boolean): Promise<void> {
		const presentation = deathPresentation;
		const currentSession = presentation?.session ?? null;
		const terminalExitPublication = presentation?.terminalExitPublication;
		if (!presentation || deathPresentationSubmitting) return;
		deathPresentationSubmitting = true;
		if (terminalExitPublication) await terminalExitPublication;
		if (publish && deathPresentationContent.trim()) {
			try { await currentSession?.publishDeathLastWords(deathPresentationContent); } catch { /* Last Words is best effort. */ }
		}
		clearDeathPresentationTimer();
		deathPresentation = null;
		deathPresentationContent = '';
		deathPresentationSubmitting = false;
		disposePersonaWriter(currentSession);
		window.location.reload();
	}

	async function checkPersonaExpiry(
		currentSession: ReturnType<typeof createWorldReadSession> | null
	): Promise<'unchanged' | 'reloaded' | 'presenting' | 'failed'> {
		// Startup restores the expired run through the explicit non-presenting path.
		// A runtime refresh must own a persona writer before it can start presentation;
		// the early anonymous reader cannot publish a terminal exit.
		if (devWorldSandboxEnabled || personaLifecycleTransition || !personaSnapshot || !currentSession) return 'unchanged';
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

	function changeDevCooperationDefectionPreset(preset: DevCooperationDefectionBotPreset): void {
		if (!devCooperationDefectionPlayground) return;
		devCooperationDefectionPlaygroundState = devCooperationDefectionPlayground.setPreset(preset);
	}

	function advanceDevCooperationDefectionPhase(): void {
		if (!devCooperationDefectionPlayground) return;
		devCooperationDefectionPlaygroundState = devCooperationDefectionPlayground.advance();
		cooperationDefectionSchedule = devCooperationDefectionPlaygroundState.schedule;
		cooperationDefectionNowMs = devCooperationDefectionPlaygroundState.nowMs;
		cooperationDefectionSession = devCooperationDefectionPlaygroundState.session;
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

	function openSelfProfile(trigger: HTMLButtonElement): void {
		lastSelfProfileTrigger = trigger;
		selfProfileDialogOpen = true;
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
		rememberTagGameEvidenceId(tagGamePositionEvidenceIdsByPubkey, message.pubkey, message.id);
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
		for (const effect of newLiveBubbleEffects(previousConversationState, conversationState)) soundController?.play(effect);
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
		soundController?.setVolume(volume);
		soundPreference = soundController?.preference ?? { ...soundPreference, volume };
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
	class={['app-shell', { 'action-dock-available': actionDockAvailable,
		'action-dock-keyboard-visible': composerKeyboardInset > 0 }]}
	data-realtime-status={realtimeStatus}
	data-trace-runtime={traceConversationController ? runtimeMode : undefined}
	style={`--composer-keyboard-inset: ${composerKeyboardInset}px;--composer-initial-preferred-height: ${INITIAL_COMPOSER_PREFERRED_HEIGHT}px;${composerPreferredHeight === null ? '' : `--composer-preferred-height: ${composerPreferredHeight}px;`}`}
>
	<FieldViewport
		bind:this={fieldViewportComponent}
		bind:viewportElement
		geometryReady={initialFieldGeometryReady}
		actionDockAvailable={actionDockAvailable}
		deathPresentationActive={deathPresentation !== null}
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
			{#if statusHudVisible && personaSnapshot}
				<div class="top-status-hud" data-top-status-hud {@attach observeTopStatusHud}>
					<UnifiedStatusHud
						expiresAtMs={tagGameHudWorkProjection?.effectiveExpiresAtMs ?? mendingProjection?.effectiveExpiresAtMs ?? personaSnapshot.gameState.lifespanExpiresAtMs}
						nowMs={tagGameHudProjection ? tagGameHudNowMs : lifespanHudNowMs ?? mendingNowMs}
						maximumLifespanMs={rootMaximumLifespanMs(personaSnapshot.activeRun.rootBuild.hallucinationResistance)}
						points={personaSnapshot.gameState.points}
						hasJob={Boolean(personaSnapshot.gameState.mendingJob)}
						{mendingProjection}
						tagGameProjection={tagGameHudProjection}
						animationScope={`${personaSnapshot.signer.pubkey}:${personaSnapshot.activeRun.runNumber}`}
					/>
					<div class="top-status-controls">
						<SoundControl
							volume={soundPreference.volume}
							onOpen={() => soundController?.unlock()}
							onVolume={updateSoundVolume}
						/>
					</div>
				</div>
			{:else}
				<div class="legacy-sound-control">
					<SoundControl
						volume={soundPreference.volume}
						onOpen={() => soundController?.unlock()}
						onVolume={updateSoundVolume}
					/>
				</div>
			{/if}
			<Chatter
				bind:this={chatterComponent}
				messages={recentMessageTimeline}
				tones={colorByPubkey}
				{selectedCharacterId}
				isDevWorldSandbox={devWorldSandboxEnabled}
				open={chatterOpen}
				statusHudBottom={statusHudVisible ? topStatusHudBottom : 0}
				onInitialized={initializeChatterVisibility}
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
				realtimeGroups={realtimeGroups}
				realtimeGroupTriggers={realtimeGroupTriggers}
				participatingCooperationDefectionGroupId={cooperationDefectionSchedule.phase === 'registration' ? cooperationDefectionSelfGroupId : null}
				{participantViews}
				{tagGameRoleByPubkey}
				tagGameTouchTargetIds={tagGameTouchTargetIds}
				{tagGameTouchAttempt}
				{tagGameHolderTransfer}
				tagGameEffect={tagGameDisplayedEffect?.effect ?? null}
				tagGameEffectActive={tagGameDisplayedEffect?.active ?? false}
				{selfProjectionId}
				{movingParticipantIds}
				{selfIsActive}
				{selfLogicalPosition}
				presentationTombstonePosition={deathPresentation?.canonicalPosition ?? null}
				{traceRootGhost}
				{fieldActionMenu}
				resolveFieldCellSelection={resolveFieldCellSelection}
				executeFieldCellAction={executeFieldCellAction}
				fieldActionLabel={fieldActionLabel}
				closeFieldActionMenu={closeFieldActionMenu}
				onOpenProfile={openProfile}
				onOpenSelfProfile={selfProfileCharacter ? openSelfProfile : undefined}
				traceMarkerWorldPosition={traceMarkerWorldPosition}
			/>
			{#if cooperationDefectionEventEnabled && (!devWorldSandboxEnabled || devCooperationDefectionFixtureEnabled)}
				<CooperationDefectionPanel
					schedule={cooperationDefectionSchedule}
					nowMs={cooperationDefectionNowMs}
					registrationDeadline={cooperationDefectionRegistrationDeadline?.deadline ?? null}
					registrationCountdown={cooperationDefectionRegistrationDeadline?.remaining ?? null}
					status={realtimeStatus}
					session={cooperationDefectionSession}
					selfGroupId={cooperationDefectionSelfGroupId}
					cancelled={cooperationDefectionSelfGroupCancelled}
					selfPubkey={cooperationDefectionActorPubkey}
					participantName={cooperationDefectionParticipantName}
					selectedChoice={cooperationDefectionSelectedChoice}
					commitStatus={cooperationDefectionCommitStatus}
					selectionFailed={Boolean(cooperationDefectionSelection && cooperationDefectionSelection.round === cooperationDefectionRound && cooperationDefectionSelection.revealStatus === 'failed')}
					canChoose={cooperationDefectionCanChoose}
					topOffset={statusHudVisible ? `calc(${topStatusHudBottom}px + 8px)` : null}
					message={devCooperationDefectionPlaygroundState?.message ?? null}
					{viewportElement}
					onPanelBounds={(bounds) => { cooperationDefectionPanelBounds = bounds; }}
					onChoice={(choice) => { void chooseCooperationDefectionChoice(choice); }}
				/>
			{/if}
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
			<div class="field-status-huds" data-field-status-huds style={`--top-status-hud-bottom:${statusHudVisible ? topStatusHudBottom : 0}px`}>
				<TagGameHud game={tagGameDisplayedGame} selfPubkey={personaSnapshot?.signer.pubkey ?? null} selfRunNumber={personaSnapshot?.activeRun.runNumber ?? null} nowMs={tagGameHudNowMs} {realtimeStatus} busy={tagGameBusy} localEffectPaused={tagGameDisplayedEffect?.locallyPaused ?? false} touchStatus={tagGameDisplayedGame ? tagGameTouchStatuses.get(tagGameDisplayedGame.gameId)?.label ?? null : null} onLeave={(gameId) => { void leaveTagGame(gameId); }} />
			</div>
		{/snippet}
	</FieldViewport>
	<TagGamePanel
		open={tagGamePanelOpen}
		games={visibleTagGameStates}
		selfPubkey={personaSnapshot?.signer.pubkey ?? null}
		selfRunNumber={personaSnapshot?.activeRun.runNumber ?? null}
		watchedGameId={tagGameWatchedGameId}
		nowMs={mendingNowMs}
		busy={tagGameBusy}
		reservedGameId={tagGameReservationGameId}
		reservedStatus={tagGameReservationStatus}
		reservationExpiresAtMs={personaSnapshot?.tagGame?.reservation?.expiresAtMs ?? null}
		onCreate={() => { void createTagGame(); }}
		onJoin={(gameId) => { void joinTagGame(gameId); }}
		onLeave={(gameId) => { void leaveTagGame(gameId); }}
		onCancel={(gameId) => { void cancelTagGame(gameId); }}
		onPropose={(gameId) => { void proposeTagGameStart(gameId); }}
		onConsent={(gameId, proposalId) => { void consentTagGameStart(gameId, proposalId); }}
		onExclude={(gameId, pubkey) => { void excludeTagGameParticipant(gameId, pubkey); }}
		onWatch={watchTagGame}
		onStopWatching={stopWatchingTagGame}
		onClose={() => { tagGamePanelOpen = false; }}
	/>

	{#if deathPresentation}
		<div
			class={['death-presentation-backdrop', { 'death-presentation-intro': deathPresentation.phase === 'intro' }]}
			data-death-presentation
			data-death-phase={deathPresentation.phase}
			role="dialog"
			aria-modal="true"
			aria-labelledby="death-presentation-title"
		>
			<section
				class={['death-presentation-card', { 'death-presentation-card-intro': deathPresentation.phase === 'intro' }]}
				bind:this={deathPresentationElement}
				tabindex="-1"
			>
				<h2 id="death-presentation-title">死亡</h2>
				{#if deathPresentation.phase === 'intro'}
					<p>一生が終わりました。</p>
				{:else}
					<p>一生が終わりました。最後に、世界にひとこと残せます。</p>
					<textarea
						aria-label="Last Words"
						bind:value={deathPresentationContent}
						maxlength="280"
						placeholder="残したい言葉（任意）"
						disabled={deathPresentationSubmitting}
					></textarea>
					<div class="death-presentation-actions">
					<ActionButton variant="secondary" type="button" onclick={() => { void finishDeathPresentation(false); }} disabled={deathPresentationSubmitting}>残さず進む</ActionButton>
					<ActionButton variant="secondary" type="button" onclick={() => { void finishDeathPresentation(true); }} disabled={deathPresentationSubmitting}>残して進む</ActionButton>
					</div>
				{/if}
			</section>
		</div>
	{/if}

	<CooperationDefectionRulesDialog open={cooperationDefectionRulesDialogOpen} mode={cooperationDefectionRulesDialogMode}
		registrationDeadline={cooperationDefectionRegistrationDeadline?.deadline ?? null}
		registrationCountdown={cooperationDefectionRegistrationDeadline?.remaining ?? null} onOpenChange={(open) => {
		if (!open) discardPendingCooperationDefectionJoin();
	}} onJoin={() => { void confirmCooperationDefectionJoin(); }} onViewRules={() => {
		cooperationDefectionRulesDialogMode = 'rules';
		cooperationDefectionRulesDialogOpen = true;
	}} onCancel={discardPendingCooperationDefectionJoin} />

	<ProfileDialog
		onOpenChange={handleProfileOpenChange}
		onCloseAutoFocus={restoreProfileTriggerFocus}
	/>
	<IdentitySelectionDialog selection={pendingIdentitySelection} rootPoints={pendingRootPoints} transitionNotice={runTransitionNotice} onSelect={(candidate, rootBuild) => { void chooseIdentity(candidate, rootBuild); }} onExportNsec={(candidate) => { void exportIdentityNsec(candidate); }} />
	<MendingDialog
		open={mendingDialogOpen}
		projection={mendingProjection}
		hasJob={Boolean(personaSnapshot?.gameState.mendingJob)}
		starting={mendingMutationInFlight && !Boolean(personaSnapshot?.gameState.mendingJob)}
		points={personaSnapshot?.gameState.points ?? 0}
		onOpenChange={(open) => { if (open) mendingDialogOpen = true; else closeMendingTerminal(); }}
		onCollect={() => { void mutateMending('collect'); }}
		collectFeedback={collectFeedback}
		startupFeedback={mendingStartupFeedback}
	/>
	<AdjustmentDialog
		open={adjustmentDialogOpen}
		points={personaSnapshot?.gameState.points ?? 0}
		abilities={personaSnapshot?.gameState.abilities ?? { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }}
		busy={abilityMutationInFlight}
		onOpenChange={(open) => { adjustmentDialogOpen = open; }}
		onUpgrade={(key) => { void mutateAbility(key); }}
		upgradeFeedback={upgradeFeedback}
	/>
	<SelfProfileDialog
		open={selfProfileDialogOpen}
		persona={personaSnapshot}
		mendingProjection={mendingProjection}
		nowMs={mendingNowMs}
		clearBlockedReason={clearBlockedReason}
		clearBusy={clearMutationInFlight}
		avatarTone={colorByPubkey[selfProjectionId] ?? 'coral'}
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
			cooperationDefectionPlaygroundEnabled={devCooperationDefectionPlaygroundEnabled}
			botPreset={devCooperationDefectionPlaygroundState?.preset ?? 'cooperative'}
			canAdvanceCooperationDefection={Boolean(devCooperationDefectionPlaygroundState && devCooperationDefectionPlayground?.canAdvance())}
			onCharacterChange={selectSandboxCharacter}
			onReset={resetDevScenario}
			onAddLiveReply={injectDevTraceLiveReply}
			onInjectLiveSpeech={injectDevLiveSpeech}
			onBotPresetChange={changeDevCooperationDefectionPreset}
			onAdvanceCooperationDefection={advanceDevCooperationDefectionPhase}
		/>
	{:else if selfPositionWriteState.kind === 'retryable' && !isWorldSelfActive}
		<WorldEntryControls onRetry={retryWorldEntry} />
	{/if}

	{#if runtimeMode === 'relay' || devTraceReplyFixtureEnabled}
		<ActionDock
			bind:this={composerComponent}
			{selectedSpeechType}
			submissionInProgress={composerSubmissionInProgress}
			hasUnreadReplies={traceReadSnapshot.hasUnreadReplies}
			chatterOpen={chatterOpen}
			onToggleChatter={toggleChatter}
			character={selfProfileCharacter ?? speechSuggestionCharacter}
		avatarTone={colorByPubkey[selfProjectionId] ?? 'coral'}
			canOpenSelfProfile={selfProfileCharacter !== null}
			onOpenSelfProfile={openSelfProfile}
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
	.top-status-hud {
		position: absolute;
		top: max(8px, env(safe-area-inset-top));
		right: max(12px, env(safe-area-inset-right));
		left: max(12px, env(safe-area-inset-left));
		z-index: 12;
		display: grid;
		width: auto;
		gap: 3px;
		pointer-events: none;
	}
	.top-status-controls { display: grid; justify-items: end; }
	.top-status-controls, .legacy-sound-control { pointer-events: auto; }
	.legacy-sound-control { position: absolute; top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); z-index: 10; }
	.field-status-huds {
		position: absolute;
		top: max(max(108px, env(safe-area-inset-top) + 108px), calc(var(--top-status-hud-bottom, 0px) + 52px));
		right: max(12px, env(safe-area-inset-right));
		z-index: 10;
		display: grid;
		width: min(310px, calc(100vw - 24px));
		gap: 6px;
		pointer-events: none;
	}
	@media (max-width: 700px) {
		.field-status-huds { top: max(max(100px, env(safe-area-inset-top) + 100px), calc(var(--top-status-hud-bottom, 0px) + 52px)); width: min(252px, calc(100vw - 24px)); gap: 4px; }
	}

	.app-shell {
		--action-dock-padding-block: 8px;
		--action-dock-border-width: 1px;
		--composer-preferred-height: var(--composer-initial-preferred-height);
		--action-dock-height: calc(
			var(--composer-preferred-height)
			+ var(--action-dock-padding-block)
			+ var(--action-dock-padding-block)
			+ var(--action-dock-border-width)
			+ env(safe-area-inset-bottom)
		);
		--action-reserved-height: calc(
			var(--composer-initial-preferred-height)
			+ var(--action-dock-padding-block)
			+ var(--action-dock-padding-block)
			+ var(--action-dock-border-width)
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

	.action-dock-available {
		padding-bottom: var(--action-reserved-height);
	}

	.death-presentation-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgb(8 7 14 / 70%);
		pointer-events: auto;
}

	.death-presentation-card {
		--action-secondary-background: rgb(255 255 255 / 8%);
		--action-secondary-background-hover: rgb(255 255 255 / 15%);
		--action-secondary-foreground: #fff;
		--action-secondary-border: rgb(255 255 255 / 42%);
		--action-disabled-background: #424858;
		--action-disabled-border: #5a6170;
		--action-disabled-foreground: #d2d6df;
		width: min(100%, 460px);
		padding: 24px;
		border: 1px solid rgb(255 255 255 / 18%);
		border-radius: 18px;
		background: var(--surface-elevated, #211c2c);
		box-shadow: 0 18px 60px rgb(0 0 0 / 35%);
		color: var(--text-primary, #fff);
		outline: none;
	}

	.death-presentation-card-intro {
		width: min(100%, 900px);
		padding: 32px;
		border-color: transparent;
		background: transparent;
		box-shadow: none;
		text-align: center;
	}

	.death-presentation-card h2 {
		margin: 0 0 8px;
		font-size: 2rem;
		line-height: 1;
		transition: font-size 500ms ease, letter-spacing 500ms ease, opacity 500ms ease;
	}

	.death-presentation-card-intro h2 {
		font-size: clamp(5rem, 22vw, 12rem);
		letter-spacing: 0.12em;
		text-shadow: 0 8px 40px rgb(0 0 0 / 48%);
	}

	.death-presentation-card-intro p {
		margin-bottom: 0;
		font-size: 1.1rem;
		letter-spacing: 0.08em;
		opacity: 0.82;
	}

	.death-presentation-card p {
		margin: 0 0 16px;
		color: var(--text-secondary, #d2cce0);
	}

	.death-presentation-card textarea {
		width: 100%;
		min-height: 108px;
		resize: vertical;
		box-sizing: border-box;
		padding: 12px;
		border: 1px solid rgb(255 255 255 / 22%);
		border-radius: 10px;
		background: rgb(0 0 0 / 18%);
		color: inherit;
		font: inherit;
	}

	.death-presentation-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 16px;
	}

	.death-presentation-actions :global(button) {
		min-width: 148px;
	}

	@media (prefers-reduced-motion: reduce) {
		.death-presentation-card h2 { transition: none; }
	}

	@media (max-width: 700px) {
		.app-shell {
			--action-dock-height: calc(var(--composer-preferred-height) + 8px + 46px + 8px + var(--action-dock-padding-block) + var(--action-dock-border-width) + env(safe-area-inset-bottom));
			--action-reserved-height: calc(var(--composer-initial-preferred-height) + 8px + 46px + 8px + var(--action-dock-padding-block) + var(--action-dock-border-width) + env(safe-area-inset-bottom));
		}
	}

</style>
