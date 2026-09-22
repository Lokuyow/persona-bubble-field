<script lang="ts">
	import { asset } from '$app/paths';
	import type { Character } from '$lib/character';
	import CharacterAvatar from '$lib/CharacterAvatar.svelte';
	import FieldParticipant from '$lib/FieldParticipant.svelte';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import type { FieldCellAction } from '$lib/fieldSelection';
	import type { Bounds, Direction, FieldSize, GridPosition, Size, WorldPoint } from '$lib/geometry';
	import type { ProjectedParticipant } from '$lib/presenceProjection';
	import type { Participant } from '$lib/frontend/presencePresentation';
	import { isWithinTraceInvestigationRange, type TraceRootCell } from '$lib/traceInvestigation';
	import type { ParsedWorldMessage } from '$lib/nostrProtocol';
	import { ADJUSTMENT_TERMINAL, FIXED_FIELD_FACILITIES } from '$lib/fieldFacilities';
	import type { RiftHole } from '$lib/rift';

	const FIELD_BACKGROUND_ASSET = '/field/prototype-danchi-courtyard.webp';
	const TRACE_ICON_ASSET = '/trace/trace-icon.svg';
	const TRACE_DEATH_ICON_ASSET = '/trace/trace-death-icon.svg';
	const MENDING_TERMINAL_ASSET = '/field/objects/mending-terminal.webp';
	const ADJUSTMENT_TERMINAL_ASSET = '/field/objects/adjustment-terminal.webp';
	const RIFT_ASSET = '/field/objects/rift.webp';

	export type FieldParticipantView = ProjectedParticipant<Participant>;
	export type TraceMarkerCell = TraceRootCell & Readonly<{
		occupied: boolean;
		inInvestigationRange: boolean;
		read: boolean;
		unreadReply: boolean;
		kind: 'normal' | 'death';
	}>;
	export type TraceRootGhost = Readonly<{
		event: Pick<ParsedWorldMessage, 'id'>;
		character: Character;
		tone: BubbleTone;
		world: WorldPoint;
		compact: boolean;
	}>;
	export type FieldActionMenu = Readonly<{
		position: GridPosition;
		actions: readonly FieldCellAction[];
	}>;

	type Props = Readonly<{
		geometryReady: boolean;
		fieldAreaBounds: Bounds;
		fieldWorldSize: Size;
		fieldArtworkBounds: Bounds;
		field: FieldSize;
		cellSize: number;
		camera: WorldPoint;
		cameraAnimating: boolean;
		traceMarkerCells: readonly TraceMarkerCell[];
		proximityFeedback: Readonly<{ position: GridPosition; label: string }> | null;
		traceOnlyCellTriggers: readonly GridPosition[];
		facilityCellTriggers: readonly GridPosition[];
		realtimeHoles: readonly RiftHole[];
		realtimeHoleTriggers: readonly RiftHole[];
		participatingRiftHoleId: string | null;
		participantViews: readonly FieldParticipantView[];
		selfProjectionId: string;
		movingParticipantIds: ReadonlySet<string>;
		selfIsActive: boolean;
		selfLogicalPosition: GridPosition | null;
		presentationTombstonePosition: GridPosition | null;
		traceRootGhost: TraceRootGhost | null;
		fieldActionMenu: FieldActionMenu | null;
		resolveFieldCellSelection: (position: GridPosition, trigger?: HTMLButtonElement) => void;
		executeFieldCellAction: (action: FieldCellAction, position: GridPosition, trigger?: HTMLButtonElement) => void;
		fieldActionLabel: (action: FieldCellAction) => string;
		closeFieldActionMenu: () => void;
		onOpenProfile: (characterId: string, trigger: HTMLButtonElement) => void;
		onOpenSelfProfile?: (trigger: HTMLButtonElement) => void;
		traceMarkerWorldPosition: (position: GridPosition) => WorldPoint;
	}>;

	let {
		geometryReady,
		fieldAreaBounds,
		fieldWorldSize,
		fieldArtworkBounds,
		field,
		cellSize,
		camera,
		cameraAnimating,
		traceMarkerCells,
		proximityFeedback,
		traceOnlyCellTriggers,
		facilityCellTriggers,
		realtimeHoles,
		realtimeHoleTriggers,
		participatingRiftHoleId,
		participantViews,
		selfProjectionId,
		movingParticipantIds,
		selfIsActive,
		selfLogicalPosition,
		presentationTombstonePosition,
		traceRootGhost,
		fieldActionMenu,
		resolveFieldCellSelection,
		executeFieldCellAction,
		fieldActionLabel,
		closeFieldActionMenu,
		onOpenProfile,
		onOpenSelfProfile,
		traceMarkerWorldPosition,
	}: Props = $props();

</script>

<div
	class="field-area"
	style={`top: ${fieldAreaBounds.y}px; left: ${fieldAreaBounds.x}px; width: ${fieldAreaBounds.width}px; height: ${fieldAreaBounds.height}px;`}
	aria-label="Field area"
>
	<div
		class={['field-scene', { 'field-scene-hidden': !geometryReady }]}
		data-camera-animation={cameraAnimating ? 'active' : undefined}
		style={`--cell-size: ${cellSize}px; --avatar-size: calc(var(--cell-size) - 4px); width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
	>
		<div
			class="field-artwork"
			style={`left: ${fieldArtworkBounds.x}px; top: ${fieldArtworkBounds.y}px; width: ${fieldArtworkBounds.width}px; height: ${fieldArtworkBounds.height}px; --field-background-image: url("${asset(FIELD_BACKGROUND_ASSET)}");`}
			aria-hidden="true"
		></div>
		<div
			class="field-grid"
			aria-hidden="true"
		></div>
		<div class="trace-marker-layer" aria-hidden="true">
			{#if presentationTombstonePosition}
				{const world = traceMarkerWorldPosition(presentationTombstonePosition)}
				<span
					class="trace-marker death-presentation-tombstone"
					data-death-presentation-tombstone
					data-death-presentation-tombstone-position={`${presentationTombstonePosition.x},${presentationTombstonePosition.y}`}
					style={`left: ${world.x}px; top: ${world.y}px; --trace-icon-image: url("${asset(TRACE_DEATH_ICON_ASSET)}");`}
				></span>
			{/if}
			{#each traceMarkerCells as cell (`${cell.position.x},${cell.position.y}`)}
				{#if !cell.occupied}
					{const world = traceMarkerWorldPosition(cell.position)}
					<span
						class="trace-marker"
						data-trace-marker-position={`${cell.position.x},${cell.position.y}`}
						data-trace-marker-kind={cell.kind}
						data-trace-root-read={cell.read ? 'true' : 'false'}
						data-trace-root-unread-reply={cell.unreadReply ? 'true' : undefined}
						class:trace-marker-read={cell.read}
						class:trace-marker-unread-reply={cell.unreadReply}
						style={`left: ${world.x}px; top: ${world.y}px; --trace-icon-image: url("${asset(cell.kind === 'death' ? TRACE_DEATH_ICON_ASSET : TRACE_ICON_ASSET)}");`}
					></span>
				{/if}
				{#if cell.inInvestigationRange}
					<span
						class="trace-investigation-indicator"
						data-trace-indicator-position={`${cell.position.x},${cell.position.y}`}
						aria-hidden="true"
						style={`left: ${(cell.position.x + 1) * cellSize - 10}px; top: ${cell.position.y * cellSize + 10}px;`}
					>⌕</span>
				{/if}
			{/each}
		</div>
		<div class="field-facility-layer" aria-hidden="true">
			{#each FIXED_FIELD_FACILITIES as facility (facility.kind)}
				<span class={['field-facility', facility.kind === 'mending-terminal' ? 'field-mending-terminal' : 'field-adjustment-terminal']} data-field-facility={facility.kind}
					style={`left: ${(facility.position.x + 0.5) * cellSize}px; top: ${(facility.position.y + 0.5) * cellSize}px;`}><img src={asset(facility.kind === 'mending-terminal' ? MENDING_TERMINAL_ASSET : ADJUSTMENT_TERMINAL_ASSET)} alt="" /></span>
			{/each}
		</div>
		<div class="realtime-hole-layer" aria-label="綻びの抜け穴">
			{#each realtimeHoles as hole (hole.id)}
				<span class={['realtime-hole', { 'realtime-hole-participating': hole.id === participatingRiftHoleId }]} data-realtime-hole-id={hole.id} data-realtime-hole-position={`${hole.position.x},${hole.position.y}`}
					data-realtime-hole-participating={hole.id === participatingRiftHoleId ? 'true' : undefined}
					style={`left: ${(hole.position.x + 0.5) * cellSize}px; top: ${(hole.position.y + 0.5) * cellSize}px;`}><img src={asset(RIFT_ASSET)} alt="" /></span>
			{/each}
		</div>
		{#if proximityFeedback}
			<div
				class="trace-proximity-feedback"
				role="status"
				aria-live="polite"
				style={`left: ${(proximityFeedback.position.x + 0.5) * cellSize}px; top: ${(proximityFeedback.position.y + 0.18) * cellSize}px;`}
			>{proximityFeedback.label}</div>
		{/if}
		<div class="field-cell-selection-layer" aria-label="Trace investigation cells">
			{#each realtimeHoleTriggers as hole (hole.id)}
				<button
					class={['field-cell-selection-trigger', 'realtime-hole-trigger', { 'realtime-hole-trigger-participating': hole.id === participatingRiftHoleId }]}
					data-field-gesture-origin="selectable"
					type="button"
					data-realtime-hole-trigger={hole.id}
					data-cell-position={`${hole.position.x},${hole.position.y}`}
					aria-label={hole.id === participatingRiftHoleId ? '抜け穴へ参加済み（参加先）' : '抜け穴へ参加'}
					aria-pressed={hole.id === participatingRiftHoleId}
					style={`left: ${hole.position.x * cellSize}px; top: ${hole.position.y * cellSize}px;`}
					ondragstart={(event) => event.preventDefault()}
					onclick={(event) => { event.stopPropagation(); resolveFieldCellSelection(hole.position, event.currentTarget as HTMLButtonElement); }}
				></button>
			{/each}
			{#each facilityCellTriggers as position (`facility-${position.x},${position.y}`)}
				<button
					class="field-cell-selection-trigger"
					data-field-gesture-origin="selectable"
					type="button"
					ondragstart={(event) => event.preventDefault()}
					data-cell-position={`${position.x},${position.y}`}
					aria-label={position.x === ADJUSTMENT_TERMINAL.position.x && position.y === ADJUSTMENT_TERMINAL.position.y ? '能力強化端末' : '作業端末'}
					style={`left: ${position.x * cellSize}px; top: ${position.y * cellSize}px;`}
					onclick={(event) => { event.stopPropagation(); resolveFieldCellSelection(position, event.currentTarget as HTMLButtonElement); }}
				></button>
			{/each}
			{#each traceOnlyCellTriggers as position (`${position.x},${position.y}`)}
				<button
					class="field-cell-selection-trigger"
					data-field-gesture-origin="selectable"
					type="button"
					ondragstart={(event) => event.preventDefault()}
					data-cell-position={`${position.x},${position.y}`}
					aria-label={!selfIsActive || (selfLogicalPosition && isWithinTraceInvestigationRange(selfLogicalPosition, position))
						? '痕跡を調べる'
						: '痕跡を調べる（近づくと調べられる）'}
					style={`left: ${position.x * cellSize}px; top: ${position.y * cellSize}px;`}
					onclick={(event) => {
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
				onSelfProfile={onOpenSelfProfile}
			/>
		{/each}
		{#if traceRootGhost}
			<div
				class={['trace-ghost', { 'trace-ghost-compact': traceRootGhost.compact }]}
				data-trace-ghost-root-id={traceRootGhost.event.id}
				style={`left: ${traceRootGhost.world.x}px; top: ${traceRootGhost.world.y}px;`}
			>
				<button
					class="trace-ghost-profile-trigger"
					data-field-gesture-origin="selectable"
					type="button"
					ondragstart={(event) => event.preventDefault()}
					aria-label={`${traceRootGhost.character.name} のプロフィールを開く`}
					onclick={(event) => {
						event.stopPropagation();
						onOpenProfile(traceRootGhost.character.characterId, event.currentTarget as HTMLButtonElement);
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
				{#each fieldActionMenu.actions as action, index (`${action.kind}-${action.kind === 'participant' ? action.participantId : action.kind === 'trace' ? action.rootId : 'terminal'}-${index}`)}
					<button
						type="button"
						role="menuitem"
						data-cell-action={action.kind}
						onclick={(event) => {
							event.stopPropagation();
							executeFieldCellAction(action, fieldActionMenu!.position, event.currentTarget as HTMLButtonElement);
						}}
					>{fieldActionLabel(action)}</button>
				{/each}
			</div>
		{/if}
	</div>
</div>
<style>
	.field-area {
		position: absolute;
		z-index: 2;
		overflow: hidden;
		background: transparent;
		touch-action: pinch-zoom;
		user-select: none;
		-webkit-user-select: none;
	}

	.field-scene {
		position: absolute;
		top: 0;
		left: 0;
		will-change: transform;
	}

	.field-scene-hidden {
		visibility: hidden;
	}

	.field-grid {
		position: absolute;
		inset: 0;
		background-image:
			linear-gradient(to right, rgba(101, 122, 105, 0.16) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(101, 122, 105, 0.16) 1px, transparent 1px),
			linear-gradient(rgba(255, 250, 224, 0.2), rgba(255, 250, 224, 0.2));
		background-size: var(--cell-size) var(--cell-size), var(--cell-size) var(--cell-size),
			100% 100%;
		background-repeat: repeat, repeat, no-repeat;
		box-shadow:
			0 24px 65px rgba(67, 75, 62, 0.12),
			inset 0 0 0 1px rgba(95, 111, 96, 0.3);
	}

	.field-artwork {
		position: absolute;
		z-index: 0;
		background-image: var(--field-background-image, none);
		background-size: 100% 100%;
		background-repeat: no-repeat;
		pointer-events: none;
	}

	.field-grid::after {
		position: absolute;
		inset: 0;
		border: 2px solid rgba(68, 91, 73, 0.48);
		box-shadow: inset 0 0 0 10px rgba(112, 137, 108, 0.2);
		content: '';
		pointer-events: none;
	}

	.trace-marker-layer {
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
	}

	.field-facility-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; }
	.field-facility {
		position: absolute; display: grid; width: calc(var(--cell-size) * 0.84); height: calc(var(--cell-size) * 0.84);
		place-items: center; border: 0; border-radius: 0; background: none; box-shadow: none;
		transform: translate(-50%, -50%); pointer-events: none;
	}
	.field-facility img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
	.realtime-hole-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; }
	.realtime-hole {
		position: absolute; display: grid; width: calc(var(--cell-size) * 0.84); height: calc(var(--cell-size) * 0.84);
		place-items: center; transform: translate(-50%, -50%); pointer-events: none;
	}
	.realtime-hole img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
	.realtime-hole-participating { border: 2px solid #8d4692; border-radius: 50%; box-shadow: 0 0 0 3px rgba(141, 70, 146, .28); }
	.realtime-hole-participating::after { content: '参加済み'; position: absolute; top: calc(100% + 3px); left: 50%; padding: 1px 4px; border-radius: 4px; background: #8d4692; color: white; font-size: 9px; line-height: 1.2; white-space: nowrap; transform: translateX(-50%); }

	.trace-marker {
		position: absolute;
		width: max(22px, min(40px, calc(var(--cell-size) * 0.36)));
		height: max(22px, min(40px, calc(var(--cell-size) * 0.36)));
		color: #526886;
		opacity: 0.72;
		background-color: currentColor;
		-webkit-mask-image: var(--trace-icon-image);
		-webkit-mask-position: center;
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-size: contain;
		mask-image: var(--trace-icon-image);
		mask-position: center;
		mask-repeat: no-repeat;
		mask-size: contain;
		pointer-events: none;
		transform: translate(-50%, -50%);
	}

	.trace-marker-read:not(.trace-marker-unread-reply) {
		opacity: 0.66;
		filter: grayscale(1) brightness(1.12);
	}

	.trace-marker-unread-reply {
		color: #cf06fe;
		filter: none;
	}

	.death-presentation-tombstone {
		z-index: 6;
		width: max(30px, min(52px, calc(var(--cell-size) * 0.46)));
		height: max(30px, min(52px, calc(var(--cell-size) * 0.46)));
		color: #a9b5c5;
		opacity: 0.96;
		filter: drop-shadow(0 2px 5px rgba(0, 0, 0, 0.5));
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
	.realtime-hole-trigger-participating { border-radius: 50%; }

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
</style>
