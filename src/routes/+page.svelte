<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import {
		applyVisibility,
		createConversationState,
		getPrototypeDisplayDuration,
		pruneExpired,
		receiveMessage,
		type ConversationMessage,
		type ConversationState,
		type SpeechType
	} from '$lib/conversation';
	import {
		clampCamera,
		clampToBounds,
		fieldLocalToViewport,
		getActualFieldTop,
		getFieldAreaBounds,
		getFieldWorldSize,
		getResponsiveCellSize,
		gridToWorld,
		mergedBubblePreferredAnchor,
		moveOneCell,
		normalBubblePreferredAnchor,
		placeBubbles,
		worldToScreen,
		type Direction,
		type GridPosition,
		type Size,
		type WorldPoint
	} from '$lib/geometry';

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

	type Participant = {
		id: string;
		name: string;
		initials: string;
		color: string;
		position: GridPosition;
		isSelf?: boolean;
	};

	const PARTICIPANTS: Participant[] = [
		{ id: 'you', name: 'you', initials: 'YU', color: 'coral', position: { x: 7, y: 4 }, isSelf: true },
		{ id: 'mio', name: 'mio', initials: 'MI', color: 'lavender', position: { x: 8, y: 2 } },
		{ id: 'sena', name: 'sena', initials: 'SE', color: 'mint', position: { x: 9, y: 2 } },
		{ id: 'riku', name: 'riku', initials: 'RI', color: 'yellow', position: { x: 10, y: 2 } },
		{ id: 'haru', name: 'haru', initials: 'HA', color: 'sky', position: { x: 4, y: 3 } },
		{ id: 'nagi', name: 'nagi', initials: 'NA', color: 'peach', position: { x: 5, y: 6 } },
		{ id: 'yui', name: 'yui', initials: 'YI', color: 'rose', position: { x: 12, y: 5 } },
		{ id: 'toma', name: 'toma', initials: 'TO', color: 'blue', position: { x: 3, y: 6 } }
	];

	let playerPosition: GridPosition = { ...PARTICIPANTS[0].position };
	let viewportElement: HTMLElement;
	let viewportSize: Size = DEFAULT_VIEWPORT;
	let lastMoveMessage = '矢印キーまたは下のパッドで移動';
	let bubbleSizes: Record<string, Size> = {};
	let conversationState: ConversationState = createConversationState();
	let lastPlacedAnchorById: Record<string, WorldPoint> = {};
	let selectedSpeakerId = PARTICIPANTS[0].id;
	let selectedSpeechType: SpeechType = 'normal';
	let composerText = '';
	let conversationStatus = 'local conversation is empty';
	let localMessageSequence = 0;
	let lastVisibilityKey: string | null = null;

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
	$: camera = clampCamera(
		gridToWorld(playerPosition, cellSize),
		{ width: fieldAreaBounds.width, height: fieldAreaBounds.height },
		fieldWorldSize
	);
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

	$: participantViews = PARTICIPANTS.map((participant) => {
		const position = participant.isSelf ? playerPosition : participant.position;
		const world = gridToWorld(position, cellSize);
		const fieldLocalScreen = worldToScreen(world, camera);
		return { ...participant, position, world, screen: fieldLocalToViewport(fieldLocalScreen, fieldAreaBounds) };
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
		const updateViewport = () => {
			if (!viewportElement) return;
			const rect = viewportElement.getBoundingClientRect();
			viewportSize = { width: rect.width, height: rect.height };
		};

		const observer = new ResizeObserver(updateViewport);
		observer.observe(viewportElement);
		updateViewport();
		const expiryTimer = window.setInterval(() => {
			conversationState = pruneExpired(conversationState, Date.now());
		}, 250);

		return () => {
			observer.disconnect();
			window.clearInterval(expiryTimer);
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

	function sendMessage(event: SubmitEvent) {
		event.preventDefault();
		if (!composerText.trim()) return;

		const receivedAt = Date.now();
		const message: ConversationMessage = {
			id: `local:${receivedAt}:${localMessageSequence++}`,
			pubkey: selectedSpeakerId,
			content: composerText,
			speechType: selectedSpeechType,
			createdAt: receivedAt,
			receivedAt
		};
		const isSpeakerVisible = visibleParticipantIds.has(selectedSpeakerId);
		conversationState = receiveMessage(conversationState, message, {
			isSpeakerVisible,
			duration: getPrototypeDisplayDuration(message.content),
			now: receivedAt
		});
		conversationStatus = isSpeakerVisible
			? `${selectedSpeakerId} spoke · ${selectedSpeechType}`
			: `${selectedSpeakerId} is offscreen · message not shown`;
		composerText = '';
	}

	function move(direction: Direction) {
		const occupied = PARTICIPANTS.filter((participant) => !participant.isSelf).map((participant) => participant.position);
		const next = moveOneCell(playerPosition, direction, FIELD, occupied);
		if (!next) {
			lastMoveMessage = 'そこへは移動できません';
			return;
		}

		playerPosition = next;
		lastMoveMessage = `field ${next.x + 1}, ${next.y + 1}`;
	}

	function handleKeydown(event: KeyboardEvent) {
		const directionByKey: Partial<Record<string, Direction>> = {
			ArrowUp: 'up',
			ArrowDown: 'down',
			ArrowLeft: 'left',
			ArrowRight: 'right'
		};
		const direction = directionByKey[event.key];
		if (!direction) return;

		event.preventDefault();
		move(direction);
	}

	function tailStart(anchor: WorldPoint, size: Size): WorldPoint {
		return { x: anchor.x + size.width / 2, y: anchor.y + size.height };
	}
</script>

<svelte:head>
	<title>Persona Bubble Field — local prototype</title>
	<link rel="icon" href={`${base}/favicon.svg`} />
	<meta
		name="description"
		content="A local field prototype for testing character movement, camera follow, bubbles, and SVG tails."
	/>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<main class="app-shell">
	<div class="topbar">
		<div class="brand-lockup">
			<span class="brand-mark" aria-hidden="true">✳</span>
			<div>
				<p class="brand-name">persona field</p>
				<p class="brand-subtitle">local conversation prototype</p>
			</div>
		</div>
		<div class="prototype-badge"><span></span> prototype / local only</div>
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
				style={`--cell-size: ${cellSize}px; --avatar-size: ${cellSize === 56 ? 40 : 46}px; width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
			>
				<div class="field-grid" aria-hidden="true"></div>
				<div class="field-sun" aria-hidden="true"></div>
				<div class="field-label field-label-top">the little clearing</div>
				<div class="field-label field-label-bottom">16 × 8 / fixed field</div>

				{#each participantViews as participant (participant.id)}
					<div
						class:player={participant.isSelf}
						class="participant"
						style={`left: ${participant.world.x}px; top: ${participant.world.y}px;`}
						aria-label={`${participant.name}${participant.isSelf ? ' (you)' : ''}`}
					>
						<div class={`avatar avatar-${participant.color}`}>
							{#if participant.isSelf}<span class="avatar-ring" aria-hidden="true"></span>{/if}
							<span>{participant.initials}</span>
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
		<div class="camera-chip"><span class="camera-dot"></span> camera follows you</div>
	</section>

	<div class="status-panel">
		<div>
			<p class="panel-kicker">movement prototype</p>
			<p class="status-message" aria-live="polite">{lastMoveMessage}</p>
		</div>
		<div class="position-readout">
			<span>your cell</span>
			<strong>{playerPosition.x + 1}<i>/</i>{playerPosition.y + 1}</strong>
		</div>
	</div>

	<form class="conversation-composer" aria-label="Local conversation controls" onsubmit={sendMessage}>
		<div class="composer-heading">
			<span class="control-kicker">local conversation</span>
			<span class="conversation-status" aria-live="polite">{conversationStatus}</span>
		</div>
		<div class="composer-fields">
			<label>
				<span>speaker</span>
				<select aria-label="Speaker" bind:value={selectedSpeakerId}>
					{#each PARTICIPANTS as participant}
						<option value={participant.id}>{participant.name}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>type</span>
				<select aria-label="Speech type" bind:value={selectedSpeechType}>
					<option value="normal">normal</option>
					<option value="shout">shout</option>
					<option value="monologue">monologue</option>
				</select>
			</label>
			<label class="composer-text-field">
				<span>message</span>
				<input aria-label="Message text" bind:value={composerText} placeholder="say something locally" />
			</label>
			<button type="submit">send</button>
		</div>
	</form>

	<div class="controls-panel" aria-label="Movement controls">
		<div class="control-copy">
			<span class="control-kicker">move one cell</span>
			<span class="control-hint">arrow keys / tap pad</span>
		</div>
		<div class="d-pad">
			<button type="button" class="d-pad-button up" aria-label="Move up" onclick={() => move('up')}>↑</button>
			<button type="button" class="d-pad-button left" aria-label="Move left" onclick={() => move('left')}>←</button>
			<button type="button" class="d-pad-button down" aria-label="Move down" onclick={() => move('down')}>↓</button>
			<button type="button" class="d-pad-button right" aria-label="Move right" onclick={() => move('right')}>→</button>
		</div>
	</div>

	<p class="footer-note">static field · DOM participants · SVG tails · no relay connection</p>
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
	.conversation-composer,
	.controls-panel,
	.footer-note,
	.camera-chip {
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
	.control-kicker,
	.control-hint,
	.position-readout span,
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
		display: flex;
		width: calc(var(--cell-size) + 8px);
		transform: translate(-50%, -15%);
		flex-direction: column;
		align-items: center;
		gap: 5px;
		will-change: left, top;
	}

	.avatar {
		position: relative;
		display: grid;
		width: var(--avatar-size);
		height: var(--avatar-size);
		place-items: center;
		border: 2px solid rgba(255, 255, 255, 0.88);
		border-radius: 42% 58% 48% 52%;
		box-shadow: 0 5px 10px rgba(58, 70, 61, 0.16);
		color: #374345;
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.04em;
		transform: rotate(-4deg);
	}

	.avatar-ring {
		position: absolute;
		inset: -7px;
		border: 1.5px dashed rgba(224, 119, 87, 0.86);
		border-radius: 50%;
		animation: breathe 2.8s ease-in-out infinite;
	}

	.avatar-coral { background: #f0a488; }
	.avatar-lavender { background: #b6afe1; }
	.avatar-mint { background: #99c6ac; }
	.avatar-yellow { background: #e8c774; }
	.avatar-sky { background: #9bc6d5; }
	.avatar-peach { background: #eab994; }
	.avatar-rose { background: #dca1b2; }
	.avatar-blue { background: #90b4d0; }

	.participant-name {
		padding: 2px 7px 3px;
		border-radius: 999px;
		background: rgba(247, 247, 239, 0.74);
		color: #596662;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.03em;
	}

	.player {
		z-index: 5;
	}

	.player .avatar {
		border-color: #fffaf1;
		box-shadow: 0 7px 14px rgba(173, 85, 63, 0.25);
	}

	.player .participant-name {
		background: #fff9ed;
		color: #c86751;
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

	.panel-kicker,
	.control-kicker {
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

	.conversation-composer {
		top: 66px;
		left: 50%;
		z-index: 11;
		width: min(570px, calc(100% - 32px));
		padding: 9px 11px 10px;
		border: 1px solid rgba(57, 67, 64, 0.12);
		border-radius: 14px;
		background: rgba(255, 253, 245, 0.82);
		box-shadow: 0 8px 22px rgba(60, 72, 65, 0.09);
		backdrop-filter: blur(8px);
		transform: translateX(-50%);
	}

	.composer-heading,
	.composer-fields,
	.composer-fields label {
		display: flex;
	}

	.composer-heading {
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 6px;
	}

	.conversation-status {
		overflow: hidden;
		color: #89918a;
		font-size: 9px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.composer-fields {
		align-items: end;
		gap: 7px;
	}

	.composer-fields label {
		min-width: 0;
		flex-direction: column;
		gap: 3px;
		color: #87908b;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.composer-fields select,
	.composer-fields input,
	.composer-fields button {
		min-height: 30px;
		border: 1px solid rgba(57, 67, 64, 0.14);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.76);
		color: #46514d;
		font-size: 11px;
	}

	.composer-fields select,
	.composer-fields input {
		padding: 5px 7px;
	}

	.composer-text-field {
		flex: 1;
	}

	.composer-fields button {
		padding: 5px 12px;
		background: #e2def5;
		color: #645a91;
		cursor: pointer;
		font-weight: 800;
		text-transform: lowercase;
	}

	.composer-fields button:hover,
	.composer-fields button:focus-visible {
		background: #d5cfef;
		outline: 2px solid rgba(136, 125, 183, 0.3);
		outline-offset: 2px;
	}

	.position-readout {
		display: flex;
		align-items: baseline;
		gap: 7px;
		padding-left: 22px;
		border-left: 1px solid rgba(63, 76, 69, 0.2);
	}

	.position-readout span {
		color: #87908b;
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.position-readout strong {
		color: #c8755c;
		font-size: 22px;
		letter-spacing: -0.04em;
	}

	.position-readout i {
		padding: 0 3px;
		color: #a6aaa0;
		font-size: 14px;
		font-style: normal;
	}

	.controls-panel {
		right: 32px;
		bottom: 24px;
		display: flex;
		align-items: center;
		gap: 18px;
	}

	.control-copy {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}

	.control-hint {
		color: #a0a49d;
		font-size: 10px;
	}

	.d-pad {
		display: grid;
		width: 110px;
		height: 110px;
		grid-template: repeat(3, 1fr) / repeat(3, 1fr);
		gap: 5px;
	}

	.d-pad-button {
		border: 1px solid rgba(55, 68, 64, 0.15);
		border-radius: 10px;
		background: rgba(255, 253, 245, 0.75);
		box-shadow: 0 4px 10px rgba(77, 83, 65, 0.08);
		color: #69736d;
		cursor: pointer;
		font-size: 19px;
		transition: transform 120ms ease, background 120ms ease, color 120ms ease;
	}

	.d-pad-button:hover,
	.d-pad-button:focus-visible {
		background: #fff9ed;
		color: #cd755b;
		outline: 2px solid rgba(215, 127, 97, 0.35);
		outline-offset: 2px;
	}

	.d-pad-button:active {
		transform: scale(0.94);
	}

	.d-pad-button.up { grid-area: 1 / 2; }
	.d-pad-button.left { grid-area: 2 / 1; }
	.d-pad-button.down { grid-area: 3 / 2; }
	.d-pad-button.right { grid-area: 2 / 3; }

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

	@keyframes breathe {
		0%, 100% { transform: scale(0.97); opacity: 0.76; }
		50% { transform: scale(1.03); opacity: 1; }
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
		.position-readout { padding-left: 14px; }
		.position-readout strong { font-size: 19px; }

		.controls-panel {
			right: 14px;
			bottom: 13px;
			gap: 10px;
		}

		.conversation-composer {
			top: 60px;
			width: calc(100% - 20px);
			padding: 8px;
		}

		.composer-fields { gap: 4px; }
		.composer-fields label { font-size: 8px; }
		.composer-fields select,
		.composer-fields input,
		.composer-fields button {
			min-height: 28px;
			font-size: 10px;
		}
		.composer-fields select { max-width: 74px; }
		.composer-fields button { padding: 5px 9px; }

		.control-copy { display: none; }
		.d-pad { width: 92px; height: 92px; gap: 4px; }
		.d-pad-button { border-radius: 8px; font-size: 16px; }

		.camera-chip {
			right: 16px;
			bottom: 132px;
			font-size: 8px;
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
		.position-readout { display: none; }
	}

	@media (prefers-reduced-motion: reduce) {
		.avatar-ring { animation: none; }
		.d-pad-button { transition: none; }
	}
</style>
