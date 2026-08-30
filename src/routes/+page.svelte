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
		mergedBubblePreferredAnchor,
		normalBubblePreferredAnchor,
		placeBubbles,
		moveOneCell,
		type Direction,
		type Size,
		type WorldPoint,
		worldToScreen
	} from '$lib/geometry';
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
	import { createPresenceState, getActiveOccupancy, getParticipant, type PresenceState } from '$lib/presence';
	import type { ParsedWorldMessage } from '$lib/nostrProtocol';
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
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
	const MOVEMENT_DIRECTIONS: readonly Direction[] = ['up', 'down', 'left', 'right'];

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
	let conversationState: ConversationState = createConversationState();
	let lastPlacedAnchorById: Record<string, WorldPoint> = {};
	let lastVisibilityKey: string | null = null;
	let colorByPubkey: Record<string, AvatarColor> = {};
	let connectionStatus: WorldReadConnectionStatus = { kind: 'bootstrapping' };
	let selfAccount: AccountSnapshot | null = null;
	let selfPositionWriteState: SelfPositionWriteState = { kind: 'unavailable' };
	let selfMessageAvailability: SelfMessageAvailability = { kind: 'unavailable' };
	let composerPreferredHeight: number | null = null;
	let worldSession: ReturnType<typeof createWorldReadSession> | null = null;
	let runtimeMode: 'unresolved' | 'relay' | 'dev' = 'unresolved';
	let devWorldSandboxEnabled = false;
	let pendingComposerSubmission: Readonly<{
		resolve: () => void;
		reject: (error: Error) => void;
		cleanup: () => void;
	}> | null = null;
	let composerStartupError: Error | null = null;
	let entryRetryable = false;
	let selectedCharacterId = '001';
	let lastProfileTrigger: HTMLButtonElement | null = null;
	let composerEditorIsEmpty: boolean | null = null;
	let visualWorldById: Record<string, WorldPoint> = {};
	let visualCamera: WorldPoint | null = null;
	let visualMotion: VisualMotion | null = null;
	let visualAnimationFrame: number | null = null;
	let visualProjectionInitialized = false;
	let prefersReducedMotion = false;
	let stopKeyboardHold = () => {};

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
	$: movementCells = getMovementCells(
		presenceState,
		selfProjectionId,
		devWorldSandboxEnabled || (selfAccount !== null && isWorldSelfActive && selfPositionWriteState.kind !== 'pending')
	);
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

	$: participantViews = presenceProjection.participants.map((participant) => {
		const world = visualWorldById[participant.id] ?? participant.world;
		return {
			...participant,
			world,
			screen: fieldLocalToViewport(worldToScreen(world, camera), fieldAreaBounds)
		};
	});

	$: participantById = new Map(participantViews.map((participant) => [participant.id, participant]));

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
			if (visibleMembers.length === 0) {
				const lastAnchor = lastPlacedAnchorById[bubble.id];
				if (!lastAnchor) return null;
				return {
					...bubble,
					text: bubble.content,
					tone: mergedBubbleTone(members),
					anchor: lastAnchor,
					size,
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
				members: visibleMembers
			};
		})
		.filter((bubble): bubble is NonNullable<typeof bubble> => bubble !== null);

	$: placeableBubbles = [
		...visibleNormalBubbles,
		...visibleMergedBubbles.filter((bubble) => bubble.members.length > 0)
	];
	$: bubblePlacement = placeBubbles(
		placeableBubbles.map((bubble) => ({ id: bubble.id, preferred: bubble.anchor, size: bubble.size })),
		bubbleSafeBounds,
		cellSize
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
		const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
		prefersReducedMotion = reducedMotionQuery.matches;
		const handleReducedMotionChange = () => {
			prefersReducedMotion = reducedMotionQuery.matches;
			if (prefersReducedMotion) syncVisualToCanonical();
		};
		reducedMotionQuery.addEventListener('change', handleReducedMotionChange);
		devWorldSandboxEnabled = isDevWorldSandboxEnabled(import.meta.env.DEV, new URLSearchParams(window.location.search));
		runtimeMode = devWorldSandboxEnabled ? 'dev' : 'relay';

		if (devWorldSandboxEnabled) {
			selectedCharacterId = resolveDevWorldCharacterId(new URLSearchParams(window.location.search));
			resetSandbox();
			const devSpeech = new URLSearchParams(window.location.search).get('devSpeech');
			if (import.meta.env.DEV && devSpeech) {
				if (devSpeech === '1') seedDevSpeechNormalFixture();
				const mergedMemberCount = devSpeech === 'merged2' ? 2 : devSpeech === 'merged3' ? 3 : devSpeech === 'merged4' ? 4 : 0;
				if (mergedMemberCount > 0) seedDevSpeechMergedFixture(mergedMemberCount);
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

			try {
				const bootstrap = await session.start();
				if (!mounted) return;
				setPresence(bootstrap.presence);
				restoreBootstrapConversation(bootstrap.messages, bootstrap.presence, Date.now());
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
			viewportSize = { width: rect.width, height: rect.height };
			void tick().then(() => {
				if (mounted) syncVisualToCanonical();
			});
			if (!devWorldSandboxEnabled) void begin();
		};
		let heldDirection: Direction | null = null;
		let heldSource: 'page' | 'composer-editor' | null = null;
		let holdTimer: number | null = null;
		const clearKeyboardHold = () => {
			heldDirection = null;
			heldSource = null;
			if (holdTimer !== null) {
				window.clearInterval(holdTimer);
				holdTimer = null;
			}
		};
		stopKeyboardHold = clearKeyboardHold;
		const requestMovement = (direction: Direction) => {
			if (devWorldSandboxEnabled) moveSandboxSelf(direction);
			else moveWorldSelf(direction);
		};
		const startKeyboardHold = (direction: Direction, source: 'page' | 'composer-editor') => {
			clearKeyboardHold();
			heldDirection = direction;
			heldSource = source;
			requestMovement(direction);
			holdTimer = window.setInterval(() => {
				if (!heldDirection || (heldSource === 'composer-editor' && composerEditorIsEmpty !== true) || document.querySelector('.profile-dialog-content')) {
					clearKeyboardHold();
					return;
				}
				requestMovement(heldDirection);
			}, 500);
		};
		const handleKeydown = (event: KeyboardEvent) => {
			const direction = directionFromKey(event.key);
			if (!direction) return;
			if (!canUseArrowForMovement(event)) {
				clearKeyboardHold();
				return;
			}
			// Browser repeat events only suppress the browser default. Movement is
			// driven by the explicit hold timer below, never by repeat frequency.
			event.preventDefault();
			if (event.repeat) return;
			const source = isComposerEditorKeyboardEvent(event) ? 'composer-editor' : 'page';
			startKeyboardHold(direction, source);
		};
		const handleKeyup = (event: KeyboardEvent) => {
			const direction = directionFromKey(event.key);
			if (direction && direction === heldDirection) clearKeyboardHold();
		};
		const handleFocusIn = (event: FocusEvent) => {
			if (heldDirection && !isComposerEditorKeyboardEvent(event)) clearKeyboardHold();
		};
		const handleWindowBlur = () => clearKeyboardHold();
		const handleVisibilityChange = () => {
			if (document.hidden) clearKeyboardHold();
		};

		const observer = new ResizeObserver(updateViewport);
		observer.observe(viewportElement);
		updateViewport();
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('keyup', handleKeyup);
		document.addEventListener('focusin', handleFocusIn);
		window.addEventListener('blur', handleWindowBlur);
		document.addEventListener('visibilitychange', handleVisibilityChange);
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
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('keyup', handleKeyup);
			document.removeEventListener('focusin', handleFocusIn);
			window.removeEventListener('blur', handleWindowBlur);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			clearKeyboardHold();
			if (stopKeyboardHold === clearKeyboardHold) stopKeyboardHold = () => {};
			reducedMotionQuery.removeEventListener('change', handleReducedMotionChange);
			cancelVisualAnimation();
			window.clearInterval(expiryTimer);
			session?.dispose();
			if (worldSession === session) worldSession = null;
		};
	});

	function observeBubble(node: HTMLElement, id: string) {
		const update = () => {
			bubbleSizes = {
				...bubbleSizes,
				[id]: { width: node.offsetWidth, height: node.offsetHeight }
			};
		};

		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return {
			destroy() {
				observer.disconnect();
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
		if (key === lastVisibilityKey) return;
		lastVisibilityKey = key;
		conversationState = applyVisibility(conversationState, visiblePubkeys);
	}

	function participantTone(participant: Pick<Participant, 'color'>): string {
		return participant.color;
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

	function getMovementCells(state: PresenceState, selfId: string, enabled: boolean) {
		if (!enabled) return [];
		const self = getParticipant(state, selfId);
		if (!self || self.status !== 'active') return [];

		const occupied = getActiveOccupancy(state, selfId);
		return MOVEMENT_DIRECTIONS.flatMap((direction) => {
			const position = moveOneCell(self.position, direction, state.field, occupied);
			return position ? [{ direction, position }] : [];
		});
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
			document.querySelector('.profile-dialog-content')
		) return false;

		const path = event.composedPath();
		const isComposerEvent = path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer'));
		if (isComposerEvent) return isComposerEditorKeyboardEvent(event) && composerEditorIsEmpty === true;
		return !path.some((target) => target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		));
	}

	function handleComposerEditorEmptyChange(isEmpty: boolean | null): void {
		composerEditorIsEmpty = isEmpty;
		if (isEmpty !== true) stopKeyboardHold();
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

	async function submitComposerContent(content: string, signal: AbortSignal): Promise<Readonly<{ eventId: string }>> {
		await waitForMessageReady(signal);
		if (signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
		const result = await worldSession?.publishNormalMessage(content);
		if (result?.kind === 'succeeded') return { eventId: result.eventId };
		throw new Error('Message was not confirmed by Relay.');
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
		lastPlacedAnchorById = {};
		lastVisibilityKey = null;
		colorByPubkey = {};
		setPresence(resetDevWorldPresence(FIELD, Date.now()));
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

	function seedDevSpeechMergedFixture(mergedMemberCount: number): void {
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
			id: 'dev-speech-merged-message-a', pubkey: mergedPubkeys[0], content: 'merged fixture', createdAt: now
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

	function openProfile(characterId: string, trigger: HTMLButtonElement): void {
		lastProfileTrigger = trigger;
		pushState('', { ...page.state, profileCharacterId: characterId });
	}

	function handleProfileOpenChange(open: boolean): void {
		if (open) stopKeyboardHold();
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

	function tailStart(anchor: WorldPoint, size: Size): WorldPoint {
		return { x: anchor.x + size.width / 2, y: anchor.y + size.height };
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
		const minWidth = 234 + level * 18;
		const minHeight = 64 + level * 4;
		const paddingY = 14 + level;
		const paddingX = 20 + level * 2;
		const fontSize = 22 + level;
		return [
			`--merged-bubble-min-width: ${minWidth}px`,
			`--merged-bubble-min-height: ${minHeight}px`,
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

	function tailGeometry(start: WorldPoint, target: WorldPoint, width = 11, overlap = 2) {
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
		const seamProgress = Math.min(1, Math.max(0, (start.y - baseCenter.y) / (target.y - baseCenter.y || 1)));
		const seamCenterX = baseCenter.x + (target.x - baseCenter.x) * seamProgress;

		return {
			points: `${left.x},${left.y} ${right.x},${right.y} ${target.x},${target.y}`,
			outlinePath: `M ${left.x} ${left.y} L ${target.x} ${target.y} L ${right.x} ${right.y}`,
			seamOffsetX: seamCenterX - start.x
		};
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
	class:composer-preferred-height={composerPreferredHeight !== null}
	style={composerPreferredHeight === null ? undefined : `--composer-preferred-height: ${composerPreferredHeight}px`}
>
	<div class="topbar">
		<div class="brand-lockup">
			<span class="brand-mark" aria-hidden="true">✳</span>
		</div>
	</div>

	<section class="field-viewport" bind:this={viewportElement} aria-label="Conversation field">
		<div
			class="speech-area"
			style={`top: ${speechAreaVisualBounds.y}px; height: ${speechAreaVisualBounds.height}px; left: ${speechAreaVisualBounds.x}px; width: ${speechAreaVisualBounds.width}px;`}
			aria-hidden="true"
		>
		</div>
		<div
			class="field-area"
			style={`top: ${fieldAreaBounds.y}px; height: ${fieldAreaBounds.height}px;`}
			aria-label="Field area"
		>
			<div
				class="field-scene"
				data-camera-animation={visualMotion ? 'active' : undefined}
				style={`--cell-size: ${cellSize}px; --avatar-size: calc(var(--cell-size) - 4px); width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
			>
				<div class="field-grid" aria-hidden="true"></div>
				<div class="field-movement-layer" aria-label="Available movement cells">
					{#each movementCells as cell (cell.direction)}
						<button
							class="movement-cell"
							type="button"
							data-movement-direction={cell.direction}
							data-movement-position={`${cell.position.x},${cell.position.y}`}
							aria-label={`Move ${cell.direction}`}
							style={`left: ${cell.position.x * cellSize}px; top: ${cell.position.y * cellSize}px;`}
							on:click={() => moveSelfFromCell(cell.direction)}
						>
							<span class="movement-cell-chevron" aria-hidden="true"></span>
						</button>
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
							on:click={(event) => openProfile(participant.character.characterId, event.currentTarget)}
						>
							<Avatar.Root class={`avatar avatar-${participant.color}`}>
								<Avatar.Image src={asset(`/${participant.character.picture}`)} alt="" />
								<Avatar.Fallback>{participant.character.name.slice(0, 1)}</Avatar.Fallback>
							</Avatar.Root>
							<span class="participant-name" aria-hidden="true">{participant.character.name}</span>
						</button>
					</div>
				{/each}
			</div>
		</div>

		<svg class="tail-layer" viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`} aria-hidden="true">
			{#each positionedNormalBubbles as bubble (bubble.id)}
				{@const start = tailStart(bubble.anchor, bubble.size)}
				{@const target = tailTarget(bubble.speaker)}
				{@const tail = tailGeometry(start, target)}
				<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={bubble.speaker.id} points={tail.points} />
				<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={bubble.speaker.id} d={tail.outlinePath} />
			{/each}
			{#each positionedMergedBubbles as bubble (bubble.id)}
				{#each bubble.members as member, index (member.id)}
					{@const start = mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length)}
					{@const target = tailTarget(member)}
					{@const tail = tailGeometry(start, target, 9, 2)}
					<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={member.id} points={tail.points} />
					<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={member.id} d={tail.outlinePath} />
				{/each}
			{/each}
		</svg>

		<div class="bubble-layer" aria-live="polite">
			{#each positionedVisibleBubbles as bubble (bubble.id)}
				<div
					use:observeBubble={bubble.id}
					class={`bubble bubble-${bubble.kind} bubble-${bubble.tone} tone-${bubble.tone}`}
					data-bubble-id={bubble.id}
					data-bubble-participant-id={bubble.kind === 'normal' ? bubble.speaker.id : undefined}
					data-merged-members={bubble.kind === 'merged' ? bubble.memberPubkeys.length : undefined}
					data-speech-type={bubble.speechType}
					style={`${bubble.kind === 'merged' ? mergedBubbleStyle(bubble.memberPubkeys.length) : ''}; --tail-seam-offset-x: ${bubble.kind === 'normal' ? tailGeometry(tailStart(bubble.anchor, bubble.size), tailTarget(bubble.speaker)).seamOffsetX : 0}px; transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
				>
					<span>{bubble.text}</span>
					{#if bubble.kind === 'merged'}
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
			<button class="sandbox-reset" type="button" on:click={resetSandbox}>Reset sandbox</button>
		</div>
	{:else if selfPositionWriteState.kind === 'retryable' && !isWorldSelfActive}
		<div class="world-controls" aria-label="World entry controls">
			<button class="world-entry-retry" type="button" on:click={retryWorldEntry}>Enter field again</button>
		</div>
	{/if}

	{#if runtimeMode === 'relay'}
		<div class="composer-dock" aria-label="Message composer">
			<HostOwnedComposerLite
				submitContent={submitComposerContent}
				onEditorEmptyChange={handleComposerEditorEmptyChange}
				onPreferredHeightChange={setComposerPreferredHeight}
			/>
		</div>
	{/if}

</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(html) {
		background: #f5f1e9;
	}

	:global(body) {
		margin: 0;
		min-width: 320px;
		background: #f5f1e9;
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
		--composer-dock-height: clamp(132px, 20svh, 160px);
		position: relative;
		display: flex;
		height: 100svh;
		min-height: 100svh;
		flex-direction: column;
		overflow: hidden;
		background:
			radial-gradient(circle at 14% 12%, rgba(255, 255, 255, 0.7), transparent 28rem),
			#f5f1e9;
	}

	.topbar,
	.status-panel,
	.footer-note,
	.camera-chip,
	.sandbox-controls,
	.world-controls {
		position: absolute;
		z-index: 10;
	}

	.topbar {
		top: 0;
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: space-between;
		padding: 24px 32px;
		pointer-events: none;
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
		background: #e8e7da;
	}

	.composer-available .field-viewport {
		min-height: 0;
	}

	.composer-available.composer-preferred-height {
		--composer-dock-height: calc(
			var(--composer-preferred-height)
			+ var(--composer-dock-padding-block)
			+ var(--composer-dock-padding-block)
			+ var(--composer-dock-border-width)
			+ env(safe-area-inset-bottom)
		);
	}

	.composer-dock {
		z-index: 12;
		width: 100%;
		height: var(--composer-dock-height);
		flex: 0 0 var(--composer-dock-height);
		padding: var(--composer-dock-padding-block) 16px
			calc(var(--composer-dock-padding-block) + env(safe-area-inset-bottom));
		border-top: var(--composer-dock-border-width) solid rgba(57, 67, 64, 0.14);
		background: rgba(245, 241, 233, 0.98);
	}

	.composer-dock :global(.host-owned-composer) {
		width: min(720px, 100%);
		margin: 0 auto;
	}

	.field-viewport::before {
		position: absolute;
		inset: 0;
		z-index: -1;
		background:
			radial-gradient(circle at 50% 42%, rgba(255, 255, 255, 0.76), transparent 40%),
			linear-gradient(135deg, rgba(213, 219, 198, 0.44), transparent 52%),
			#e8e7da;
		content: '';
	}

	.field-scene {
		position: absolute;
		top: 0;
		left: 0;
		will-change: transform;
	}

	.field-area {
		position: absolute;
		right: 0;
		left: 0;
		z-index: 2;
		overflow: hidden;
		background: transparent;
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
			repeating-conic-gradient(
				from 90deg at 50% 50%,
				rgba(151, 169, 145, 0.12) 0deg 90deg,
				rgba(244, 246, 235, 0.08) 90deg 180deg
			);
		background-size: var(--cell-size) var(--cell-size), var(--cell-size) var(--cell-size),
			calc(var(--cell-size) * 2) calc(var(--cell-size) * 2);
		box-shadow:
			0 24px 65px rgba(67, 75, 62, 0.12),
			inset 0 0 0 1px rgba(95, 111, 96, 0.3),
			inset 0 0 0 16px rgba(255, 255, 255, 0.11);
	}

	.field-movement-layer {
		position: absolute;
		inset: 0;
		z-index: 1;
		pointer-events: none;
	}

	.movement-cell {
		position: absolute;
		display: grid;
		width: var(--cell-size);
		height: var(--cell-size);
		box-sizing: border-box;
		place-items: center;
		padding: 0;
		border: 1px solid rgba(64, 111, 96, 0.28);
		border-radius: 4px;
		background: rgba(120, 166, 148, 0.13);
		box-shadow: inset 0 0 18px rgba(255, 255, 255, 0.16);
		color: rgba(52, 101, 86, 0.68);
		cursor: pointer;
		font: inherit;
		pointer-events: auto;
		touch-action: manipulation;
		transition: background-color 120ms ease, border-color 120ms ease;
	}

	.movement-cell:hover {
		border-color: rgba(64, 111, 96, 0.4);
		background: rgba(120, 166, 148, 0.2);
	}

	.movement-cell:active {
		background: rgba(103, 151, 133, 0.26);
	}

	.movement-cell:focus-visible {
		outline: 3px solid #6dabb9;
		outline-offset: -5px;
	}

	.movement-cell-chevron {
		width: 8px;
		height: 8px;
		border-top: 1.5px solid currentColor;
		border-right: 1.5px solid currentColor;
	}

	.movement-cell[data-movement-direction='up'] .movement-cell-chevron {
		transform: translateY(2px) rotate(-45deg);
	}

	.movement-cell[data-movement-direction='right'] .movement-cell-chevron {
		transform: translateX(-2px) rotate(45deg);
	}

	.movement-cell[data-movement-direction='down'] .movement-cell-chevron {
		transform: translateY(-2px) rotate(135deg);
	}

	.movement-cell[data-movement-direction='left'] .movement-cell-chevron {
		transform: translateX(2px) rotate(-135deg);
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
		max-width: calc(var(--avatar-size) - 4px);
		box-sizing: border-box;
		transform: translateX(-50%);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		padding: 2px 7px 3px;
		border-radius: 999px;
		background: rgba(247, 247, 239, 0.74);
		color: #596662;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.03em;
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

	.bubble-layer {
		z-index: 6;
	}

	.bubble {
		position: absolute;
		display: flex;
		background: var(--tone-background);
		min-height: 50px;
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
		width: 184px;
		padding: 12px 15px;
	}

	.bubble-merged {
		width: max-content;
		max-width: calc(100% - 32px);
		min-width: var(--merged-bubble-min-width, 218px);
		min-height: var(--merged-bubble-min-height, 58px);
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
	.world-entry-retry {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-reset {
		min-height: 38px;
		padding: 0 11px;
		border-radius: 999px;
		font-size: 10px;
		letter-spacing: 0.04em;
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
		.topbar {
			padding: 16px 16px;
		}

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
