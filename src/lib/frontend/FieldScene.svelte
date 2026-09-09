<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { asset } from '$app/paths';
	import type { Character } from '$lib/character';
	import CharacterAvatar from '$lib/CharacterAvatar.svelte';
	import FieldParticipant from '$lib/FieldParticipant.svelte';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import { viewportPointToLogicalCell, type FieldCellAction } from '$lib/fieldSelection';
	import type { Bounds, Direction, FieldSize, GridPosition, Size, WorldPoint } from '$lib/geometry';
	import { clampJoystickThumb, isJoystickDrag, joystickDirection, type JoystickPoint } from '$lib/pointerJoystick';
	import type { ProjectedParticipant } from '$lib/presenceProjection';
	import type { Participant } from '$lib/frontend/presencePresentation';
	import { isWithinTraceInvestigationRange, type TraceRootCell } from '$lib/traceInvestigation';
	import type { ParsedWorldMessage } from '$lib/nostrProtocol';

	const FIELD_BACKGROUND_ASSET = '/field/prototype-danchi-courtyard.webp';
	const TRACE_ICON_ASSET = '/trace/trace-icon-afterimage.svg';

	export type FieldParticipantView = ProjectedParticipant<Participant>;
	export type TraceLightCell = TraceRootCell & Readonly<{
		occupied: boolean;
		inInvestigationRange: boolean;
		read: boolean;
		unreadReply: boolean;
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
	export type PointerJoystick = Readonly<{
		center: WorldPoint;
		thumb: WorldPoint;
		direction: Direction;
	}>;
	export type FieldSceneHandle = Readonly<{
		cancelPointerGesture: () => void;
	}>;

	type Props = Readonly<{
		geometryReady: boolean;
		fieldAreaBounds: Bounds;
		fieldWorldSize: Size;
		field: FieldSize;
		cellSize: number;
		camera: WorldPoint;
		cameraAnimating: boolean;
		traceLightCells: readonly TraceLightCell[];
		proximityFeedback: Readonly<{ position: GridPosition }> | null;
		traceOnlyCellTriggers: readonly GridPosition[];
		participantViews: readonly FieldParticipantView[];
		selfProjectionId: string;
		movingParticipantIds: ReadonlySet<string>;
		selfIsActive: boolean;
		selfLogicalPosition: GridPosition | null;
		traceRootGhost: TraceRootGhost | null;
		fieldActionMenu: FieldActionMenu | null;
		resolveFieldCellSelection: (position: GridPosition, trigger?: HTMLButtonElement) => void;
		executeFieldCellAction: (action: FieldCellAction, position: GridPosition, trigger?: HTMLButtonElement) => void;
		fieldActionLabel: (action: FieldCellAction) => string;
		closeFieldActionMenu: () => void;
		onOpenProfile: (characterId: string, trigger: HTMLButtonElement) => void;
		traceLightWorldPosition: (position: GridPosition) => WorldPoint;
		onPointerMovementTakeover: (pointerId: number, direction: Direction) => void;
		onPointerMovementUpdate: (pointerId: number, direction: Direction) => void;
		onPointerMovementStop: (pointerId: number) => void;
	}>;

	let {
		geometryReady,
		fieldAreaBounds,
		fieldWorldSize,
		field,
		cellSize,
		camera,
		cameraAnimating,
		traceLightCells,
		proximityFeedback,
		traceOnlyCellTriggers,
		participantViews,
		selfProjectionId,
		movingParticipantIds,
		selfIsActive,
		selfLogicalPosition,
		traceRootGhost,
		fieldActionMenu,
		resolveFieldCellSelection,
		executeFieldCellAction,
		fieldActionLabel,
		closeFieldActionMenu,
		onOpenProfile,
		traceLightWorldPosition,
		onPointerMovementTakeover,
		onPointerMovementUpdate,
		onPointerMovementStop
	}: Props = $props();

	let pointerJoystick = $state.raw<PointerJoystick | null>(null);
	let cancelPointerGestureImpl = () => {};

	export function cancelPointerGesture(): void {
		cancelPointerGestureImpl();
	}

	const fieldSelectionPointer: Attachment<HTMLElement> = (node) => {
		let activeGesture: Readonly<{
			pointerId: number;
			start: JoystickPoint;
			anchor: GridPosition;
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
				onPointerMovementStop(gesture.pointerId);
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
			if (gesture.dragging) onPointerMovementStop(event.pointerId);
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
				onPointerMovementTakeover(event.pointerId, direction);
				return;
			}
			const direction = joystickDirection(gesture.start, current);
			if (!direction) return;
			pointerJoystick = {
				center: gesture.start,
				thumb: clampJoystickThumb(gesture.start, current),
				direction
			};
			onPointerMovementUpdate(event.pointerId, direction);
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
		cancelPointerGestureImpl = cancelGesture;
		return () => {
			cancelGesture();
			cancelPointerGestureImpl = () => {};
		};
	};

</script>

<div
	class="field-area"
	style={`top: ${fieldAreaBounds.y}px; left: ${fieldAreaBounds.x}px; width: ${fieldAreaBounds.width}px; height: ${fieldAreaBounds.height}px;`}
	aria-label="Field area"
	{@attach fieldSelectionPointer}
>
	<div
		class={['field-scene', { 'field-scene-hidden': !geometryReady }]}
		data-camera-animation={cameraAnimating ? 'active' : undefined}
		style={`--cell-size: ${cellSize}px; --avatar-size: calc(var(--cell-size) - 4px); width: ${fieldWorldSize.width}px; height: ${fieldWorldSize.height}px; transform: translate3d(${-camera.x}px, ${-camera.y}px, 0);`}
	>
		<div
			class="field-grid"
			style={`--field-background-image: url("${asset(FIELD_BACKGROUND_ASSET)}");`}
			aria-hidden="true"
		></div>
		<div class="trace-light-layer" aria-hidden="true">
			{#each traceLightCells as cell (`${cell.position.x},${cell.position.y}`)}
				{#if !cell.occupied}
					{const world = traceLightWorldPosition(cell.position)}
					<span
						class="trace-light"
						data-trace-light-position={`${cell.position.x},${cell.position.y}`}
						data-trace-root-read={cell.read ? 'true' : 'false'}
						data-trace-root-unread-reply={cell.unreadReply ? 'true' : undefined}
						class:trace-light-read={cell.read}
						class:trace-light-unread-reply={cell.unreadReply}
						style={`left: ${world.x}px; top: ${world.y}px; --trace-icon-image: url("${asset(TRACE_ICON_ASSET)}");`}
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
				{#each fieldActionMenu.actions as action, index (`${action.kind}-${action.kind === 'participant' ? action.participantId : action.rootId}-${index}`)}
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
		width: max(22px, min(28px, calc(var(--cell-size) * 0.34)));
		height: max(22px, min(28px, calc(var(--cell-size) * 0.34)));
		color: #59697f;
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

	.trace-light-read:not(.trace-light-unread-reply) {
		opacity: 0.5;
	}

	.trace-light-unread-reply {
		color: #cf06fe;
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
