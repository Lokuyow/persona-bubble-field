<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
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
		getFieldAreaBounds,
		getFieldWorldSize,
		getResponsiveCellSize,
		mergedBubblePreferredAnchor,
		normalBubblePreferredAnchor,
		placeBubbles,
		type Direction,
		type Size,
		type WorldPoint
	} from '$lib/geometry';
	import {
		DEV_WORLD_SELF_ID,
		getDevWorldCharacter,
		isDevWorldSandboxEnabled,
		moveDevWorldSelf,
		resetDevWorldPresence,
		resolveDevWorldCharacterId
	} from '$lib/devWorldSandbox';
	import { CHARACTER_CATALOG } from '$lib/character';
	import { projectPresence } from '$lib/presenceProjection';
	import type { PresenceState } from '$lib/presence';
	import type { ParsedWorldMessage } from '$lib/nostrProtocol';
	import { createWorldReadSession, type WorldReadConnectionStatus } from '$lib/worldReadSession';

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

	type AvatarColor = 'coral' | 'lavender' | 'mint' | 'yellow' | 'sky' | 'peach' | 'rose' | 'blue';
	type Participant = {
		id: string;
		name: string;
		initials: string;
		color: AvatarColor;
		picture?: string;
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
	let devWorldSandboxEnabled = false;
	let selectedCharacterId = '001';

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
	$: presenceProjection = getPresenceProjection(presenceState, selectedCharacterId);
	$: camera = presenceProjection.camera;
	$: actualFieldTop = presenceProjection.actualFieldTop;
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

	$: participantViews = presenceProjection.participants;

	$: participantById = new Map(participantViews.map((participant) => [participant.id, participant]));

	$: visibleParticipantIds = presenceProjection.visibleParticipantIds;
	$: visibleParticipantKey = [...visibleParticipantIds].sort().join('|');
	$: syncVisibility(visibleParticipantKey, visibleParticipantIds);

	$: visibleNormalBubbles = conversationState.normalBubbles
		.map((bubble) => {
			const speaker = participantById.get(bubble.pubkey);
			if (!speaker || !isInsideFieldArea(speaker.screen)) return null;
			const size = bubbleSizes[bubble.id] ?? DEFAULT_BUBBLE_SIZES.normal;
			const preferred = normalBubblePreferredAnchor(
				speaker.screen.x,
				speaker.position.y,
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
			const visibleMembers = members.filter((member) => isInsideFieldArea(member.screen));
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
				visibleMembers.map((member) => ({ x: member.screen.x, y: member.position.y })),
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

	onMount(() => {
		let mounted = true;
		let startRequested = false;
		let session: ReturnType<typeof createWorldReadSession> | null = null;
		devWorldSandboxEnabled = isDevWorldSandboxEnabled(import.meta.env.DEV, new URLSearchParams(window.location.search));

		if (devWorldSandboxEnabled) {
			selectedCharacterId = resolveDevWorldCharacterId(new URLSearchParams(window.location.search));
			resetSandbox();
		}

		const begin = async () => {
			if (devWorldSandboxEnabled || startRequested || !hasUsableViewport()) return;
			startRequested = true;
			session = createWorldReadSession({
				field: FIELD,
				onPresenceChanged: setPresence,
				onLiveMessage: receiveLiveMessage,
				onStatusChanged: (status) => { connectionStatus = status; }
			});

			try {
				const bootstrap = await session.start();
				if (!mounted) return;
				setPresence(bootstrap.presence);
				restoreBootstrapConversation(bootstrap.messages, bootstrap.presence, Date.now());
				session.completeBootstrap();
			} catch {
				// The session reports a concise fatal status to the UI.
			}
		};

		const updateViewport = () => {
			if (!viewportElement) return;
			const rect = viewportElement.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return;
			viewportSize = { width: rect.width, height: rect.height };
			if (!devWorldSandboxEnabled) void begin();
		};
		const handleKeydown = (event: KeyboardEvent) => {
			if (event.repeat || isEditableTarget(event.target)) return;
			const direction = directionFromKey(event.key);
			if (!direction) return;
			event.preventDefault();
			moveSandboxSelf(direction);
		};

		const observer = new ResizeObserver(updateViewport);
		observer.observe(viewportElement);
		updateViewport();
		if (devWorldSandboxEnabled) window.addEventListener('keydown', handleKeydown);
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
			observer.disconnect();
			window.removeEventListener('keydown', handleKeydown);
			window.clearInterval(expiryTimer);
			session?.dispose();
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
		if (participant.color === 'lavender') return 'violet';
		if (participant.color === 'rose') return 'rose';
		if (participant.color === 'peach' || participant.color === 'yellow' || participant.color === 'coral') return 'peach';
		return 'sky';
	}

	function mergedBubbleTone(members: readonly Participant[]): string {
		return participantTone(members[0] ?? { color: 'lavender' });
	}

	function participantModels(state: PresenceState, selectedId = selectedCharacterId): readonly Participant[] {
		return state.participants
			.filter((participant) => participant.status === 'active')
			.map((participant) => {
				if (devWorldSandboxEnabled && participant.id === DEV_WORLD_SELF_ID) {
					const character = getDevWorldCharacter(selectedId);
					return {
						id: participant.id,
						name: character.name,
						initials: '',
						picture: character.picture,
						color: 'sky' as const
					};
				}
				return {
					id: participant.id,
					name: `${participant.id.slice(0, 8)}…${participant.id.slice(-6)}`,
					initials: '?',
					color: colorByPubkey[participant.id] ?? AVATAR_COLORS[0]
				};
			});
	}

	function getPresenceProjection(state: PresenceState, selectedId = selectedCharacterId) {
		return projectPresence(state, participantModels(state, selectedId), {
			cellSize,
			fieldAreaBounds,
			fieldWorldSize
		});
	}

	function hasUsableViewport(): boolean {
		return viewportSize.width > 0 && viewportSize.height > 0;
	}

	function setPresence(nextPresence: PresenceState): void {
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
	}

	function directionFromKey(key: string): Direction | null {
		if (key === 'ArrowUp') return 'up';
		if (key === 'ArrowDown') return 'down';
		if (key === 'ArrowLeft') return 'left';
		if (key === 'ArrowRight') return 'right';
		return null;
	}

	function isEditableTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement && (
			target.matches('input, textarea, select') || target.isContentEditable
		);
	}

	function moveSandboxSelf(direction: Direction): void {
		if (!devWorldSandboxEnabled) return;
		const result = moveDevWorldSelf(presenceState, direction, Date.now());
		if (result.moved) setPresence(result.state);
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
</script>

<svelte:head>
	<title>{devWorldSandboxEnabled ? 'Persona Bubble Field — DEV World Sandbox' : 'Persona Bubble Field — read-only world'}</title>
	<link rel="icon" href={`${base}/favicon.svg`} />
	<meta
		name="description"
		content={devWorldSandboxEnabled
			? 'A local-only development sandbox with no Relay connection or publishing.'
			: 'A read-only view of the current prototype world from Nostr relays.'}
	/>
</svelte:head>

<main class="app-shell">
	<div class="topbar">
		<div class="brand-lockup">
			<span class="brand-mark" aria-hidden="true">✳</span>
			<div>
				<p class="brand-name">persona field</p>
				<p class="brand-subtitle">{devWorldSandboxEnabled ? 'DEV World Sandbox' : 'read-only Relay world'}</p>
			</div>
		</div>
		<div class="prototype-badge"><span></span>{devWorldSandboxEnabled ? 'DEV sandbox · local only' : 'spectator / read only'}</div>
	</div>

	<section class="field-viewport" bind:this={viewportElement} aria-label="Conversation field">
		<div
			class="speech-area"
			style={`top: ${speechAreaVisualBounds.y}px; height: ${speechAreaVisualBounds.height}px; left: ${speechAreaVisualBounds.x}px; width: ${speechAreaVisualBounds.width}px;`}
			aria-hidden="true"
		>
			<span>speech area / provisional</span>
		</div>
		<div
			class="field-area"
			style={`top: ${fieldAreaBounds.y}px; height: ${fieldAreaBounds.height}px;`}
			aria-label="Field area"
		>
			<div
				class="field-scene"
				style={`--cell-size: ${cellSize}px; --avatar-size: ${cellSize === 56 ? 52 : 68}px; width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
			>
				<div class="field-grid" aria-hidden="true"></div>
				<div class="field-sun" aria-hidden="true"></div>
				<div class="field-label field-label-top">the little clearing</div>
				<div class="field-label field-label-bottom">16 × 8 / {devWorldSandboxEnabled ? 'DEV sandbox' : 'Relay world'}</div>

				{#each participantViews as participant (participant.id)}
					<div
						class="participant"
						data-position={`${participant.position.x},${participant.position.y}`}
						style={`left: ${participant.world.x}px; top: ${participant.world.y}px;`}
						aria-label={participant.name}
					>
						<div class={`avatar avatar-${participant.color}`}>
							{#if participant.picture}
								<img src={`${base}/${participant.picture}`} alt="" aria-hidden="true" />
							{:else}
								<span>{participant.initials}</span>
							{/if}
						</div>
						<span class="participant-name">{participant.name}</span>
					</div>
				{/each}
			</div>
		</div>

		<svg class="tail-layer" viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`} aria-hidden="true">
			{#each positionedNormalBubbles as bubble (bubble.id)}
				{@const start = tailStart(bubble.anchor, bubble.size)}
				<line class={`tail tail-${bubble.tone}`} x1={start.x} y1={start.y} x2={bubble.speaker.screen.x} y2={bubble.speaker.screen.y - 18} />
			{/each}
			{#each positionedMergedBubbles as bubble (bubble.id)}
				{@const start = tailStart(bubble.anchor, bubble.size)}
				{#each bubble.members as member (member.id)}
					<line class={`tail tail-${bubble.tone}`} x1={start.x} y1={start.y} x2={member.screen.x} y2={member.screen.y - 18} />
				{/each}
			{/each}
		</svg>

		<div class="bubble-layer" aria-live="polite">
			{#each positionedVisibleBubbles as bubble (bubble.id)}
				<div
					use:observeBubble={bubble.id}
					class={`bubble bubble-${bubble.kind} bubble-${bubble.tone}`}
					data-bubble-id={bubble.id}
					data-speech-type={bubble.speechType}
					style={`transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
				>
					<span>{bubble.text}</span>
					{#if bubble.kind === 'merged'}<small>{bubble.memberPubkeys.length} people · merged</small>{/if}
				</div>
			{/each}
		</div>

		<div class="viewport-vignette" aria-hidden="true"></div>
		<div class="camera-chip"><span class="camera-dot"></span>{devWorldSandboxEnabled ? 'self camera · DEV' : 'spectator camera · origin'}</div>
	</section>

	<div class="status-panel">
		<div>
			<p class="panel-kicker">{devWorldSandboxEnabled ? 'DEV sandbox' : 'prototype world'} · {presenceState.participants.filter((participant) => participant.status === 'active').length} active</p>
			<p class="status-message" aria-live="polite">
				{#if devWorldSandboxEnabled}local only · Relay connection disabled · publishing disabled
				{:else if connectionStatus.kind === 'bootstrapping'}connecting to prototype world…
				{:else if connectionStatus.kind === 'available'}world live
				{:else if connectionStatus.kind === 'degraded'}world live · limited relay availability
				{:else}world unavailable · {connectionStatus.message}
				{/if}
			</p>
		</div>
	</div>

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
			<div class="sandbox-direction-pad">
				<span aria-hidden="true"></span>
				<button type="button" aria-label="Move up" on:click={() => moveSandboxSelf('up')}>↑</button>
				<span aria-hidden="true"></span>
				<button type="button" aria-label="Move left" on:click={() => moveSandboxSelf('left')}>←</button>
				<button type="button" aria-label="Move down" on:click={() => moveSandboxSelf('down')}>↓</button>
				<button type="button" aria-label="Move right" on:click={() => moveSandboxSelf('right')}>→</button>
			</div>
			<button class="sandbox-reset" type="button" on:click={resetSandbox}>Reset sandbox</button>
		</div>
	{/if}

	<p class="footer-note">{devWorldSandboxEnabled ? 'DEV sandbox · local only · no Relay connection · no publishing' : 'read-only Relay state · DOM participants · SVG tails · no publishing'}</p>
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
	}

	.app-shell {
		position: relative;
		display: flex;
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
	.sandbox-controls {
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
		border: 1px solid rgba(95, 111, 96, 0.3);
		background-color: rgba(199, 211, 192, 0.3);
		background-image:
			linear-gradient(to right, rgba(101, 122, 105, 0.16) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(101, 122, 105, 0.16) 1px, transparent 1px);
		background-size: var(--cell-size) var(--cell-size);
		box-shadow: 0 24px 65px rgba(67, 75, 62, 0.12), inset 0 0 0 16px rgba(255, 255, 255, 0.11);
	}

	.field-sun {
		position: absolute;
		top: 87px;
		right: 132px;
		width: 112px;
		height: 112px;
		border-radius: 50%;
		background: rgba(246, 211, 133, 0.42);
		filter: blur(1px);
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

	.avatar {
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
		transform: translate(-50%, -50%) rotate(-4deg);
	}

	.avatar-coral { background: #f0a488; }
	.avatar-lavender { background: #b6afe1; }
	.avatar-mint { background: #99c6ac; }
	.avatar-yellow { background: #e8c774; }
	.avatar-sky { background: #9bc6d5; }
	.avatar-peach { background: #eab994; }
	.avatar-rose { background: #dca1b2; }
	.avatar-blue { background: #90b4d0; }

	.avatar img {
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

	.tail {
		stroke-width: 2.2;
		stroke-linecap: round;
		opacity: 0.82;
		stroke-dasharray: 3 5;
	}

	.tail-sky { stroke: #6dabb9; }
	.tail-violet { stroke: #887db7; }
	.tail-peach { stroke: #cf8d6a; }
	.tail-rose { stroke: #bc7891; }

	.bubble-layer {
		z-index: 6;
	}

	.bubble {
		position: absolute;
		display: flex;
		min-height: 50px;
		align-items: center;
		justify-content: center;
		border: 1px solid rgba(57, 67, 64, 0.11);
		border-radius: 17px 17px 17px 7px;
		box-shadow: 0 13px 26px rgba(60, 72, 65, 0.14);
		color: #364142;
		font-size: 13px;
		font-weight: 800;
		letter-spacing: 0.02em;
		line-height: 1.35;
		text-align: center;
		will-change: transform;
	}

	.bubble-normal {
		width: 184px;
		padding: 12px 15px;
	}

	.bubble-merged {
		width: 218px;
		min-height: 58px;
		flex-direction: column;
		gap: 3px;
		padding: 12px 16px 10px;
		border-radius: 19px;
	}

	.bubble-merged small {
		color: #7c779d;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
	}

	.bubble-sky { background: #d9edf0; }
	.bubble-violet { background: #e2def5; }
	.bubble-peach { background: #f6dfce; }
	.bubble-rose { background: #f1d9df; }

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

	.sandbox-controls {
		bottom: 76px;
		left: 50%;
		z-index: 11;
		display: flex;
		align-items: center;
		gap: 10px;
		transform: translateX(-50%);
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

	.sandbox-direction-pad {
		display: grid;
		grid-template-columns: repeat(3, 38px);
		gap: 4px;
	}

	.sandbox-direction-pad button,
	.sandbox-reset {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-direction-pad button {
		display: grid;
		width: 38px;
		height: 38px;
		place-items: center;
		border-radius: 10px;
		font-size: 18px;
	}

	.sandbox-reset {
		min-height: 38px;
		padding: 0 11px;
		border-radius: 999px;
		font-size: 10px;
		letter-spacing: 0.04em;
	}

	.sandbox-direction-pad button:focus-visible,
	.sandbox-reset:focus-visible,
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
