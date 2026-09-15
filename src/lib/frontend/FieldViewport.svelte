<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { viewportPointToLogicalCell } from '$lib/fieldSelection';
	import type { Bounds, Direction, FieldSize, GridPosition, WorldPoint } from '$lib/geometry';
	import { clampJoystickThumb, isJoystickDrag, joystickDirection, type JoystickPoint } from '$lib/pointerJoystick';
	import type { Snippet } from 'svelte';

	type Props = Readonly<{
		viewportElement?: HTMLElement;
		geometryReady: boolean;
		composerAvailable: boolean;
		fieldAreaBounds: Bounds;
		field: FieldSize;
		camera: WorldPoint;
		resolveFieldCellSelection: (position: GridPosition) => void;
		closeFieldActionMenu: () => void;
		onPointerMovementTakeover: (pointerId: number, direction: Direction) => void;
		onPointerMovementUpdate: (pointerId: number, direction: Direction) => void;
		onPointerMovementStop: (pointerId: number) => void;
		speechAreaVisualBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
		children: Snippet;
	}>;

	export type FieldViewportHandle = Readonly<{ cancelPointerGesture: () => void }>;

	let {
		viewportElement = $bindable(),
		geometryReady,
		composerAvailable,
		fieldAreaBounds,
		field,
		camera,
		resolveFieldCellSelection,
		closeFieldActionMenu,
		onPointerMovementTakeover,
		onPointerMovementUpdate,
		onPointerMovementStop,
		speechAreaVisualBounds,
		children
	}: Props = $props();

	let pointerJoystick = $state.raw<Readonly<{ center: WorldPoint; thumb: WorldPoint; direction: Direction }> | null>(null);
	let cancelPointerGestureImpl = () => {};
	export function cancelPointerGesture(): void { cancelPointerGestureImpl(); }

	const pointerGesture: Attachment<HTMLElement> = (node) => {
		let activeGesture: Readonly<{ pointerId: number; start: JoystickPoint; anchor: GridPosition | null; dragging: boolean; captureOwner: HTMLElement }> | null = null;
		const interactive = 'button, input, textarea, select, [contenteditable="true"], .field-action-menu, .composer-dock, .sandbox-controls, [role="dialog"], .bubble-content, .trace-reply-card';
		const textSelectionTarget = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest('.bubble-content, .trace-root-bubble, .trace-root-card, .timeline-content')) return true;
			return event.composedPath().some((target) => target instanceof HTMLElement && target.matches('.bubble-content, .trace-root-bubble, .trace-root-card, .timeline-content'));
		};
		const origin = (event: PointerEvent): HTMLElement | null => {
			for (const target of event.composedPath()) {
				if (!(target instanceof HTMLElement)) continue;
				if (target.matches('[data-field-gesture-origin="selectable"]')) return target;
				if (target.matches(interactive)) return null;
			}
			return null;
		};
		const release = (id: number) => { if (node.hasPointerCapture(id)) node.releasePointerCapture(id); };
		const cancel = () => {
			const gesture = activeGesture; activeGesture = null;
			if (gesture) { onPointerMovementStop(gesture.pointerId); try { if (gesture.captureOwner.hasPointerCapture(gesture.pointerId)) gesture.captureOwner.releasePointerCapture(gesture.pointerId); release(gesture.pointerId); } catch { /* capture may already be lost */ } }
			pointerJoystick = null;
		};
		const finish = (event: PointerEvent, select: boolean) => {
			const gesture = activeGesture;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			activeGesture = null;
			try { if (gesture.captureOwner.hasPointerCapture(event.pointerId)) gesture.captureOwner.releasePointerCapture(event.pointerId); release(event.pointerId); } catch { /* capture may already be lost */ }
			if (gesture.dragging) {
				event.preventDefault();
				onPointerMovementStop(event.pointerId);
			}
			pointerJoystick = null;
			if (select && !gesture.dragging && gesture.captureOwner === node && gesture.anchor) resolveFieldCellSelection(gesture.anchor);
		};
		const down = (event: PointerEvent) => {
			if (!event.isPrimary || event.button !== 0 || activeGesture) return;
			if (event.target instanceof Element && event.target.closest('.trace-root-bubble, .trace-reply-content-button')) return;
			const gestureOrigin = origin(event);
			if (textSelectionTarget(event)) return;
			if (event.composedPath().some((target) => target instanceof HTMLElement && target.matches('.composer-dock, [role="dialog"], .sandbox-controls')) ||
				(!textSelectionTarget(event) && event.composedPath().some((target) => target instanceof HTMLElement && target.matches('button, input, textarea, select, [contenteditable="true"], .field-action-menu, .trace-reply-card')) && !gestureOrigin)) return;
			const start = { x: event.clientX, y: event.clientY };
			const anchor = viewportPointToLogicalCell({ point: start, fieldArea: fieldAreaBounds, camera, field });
			activeGesture = { pointerId: event.pointerId, start, anchor, dragging: false, captureOwner: gestureOrigin ?? node };
			try { (gestureOrigin ?? node).setPointerCapture(event.pointerId); } catch { /* synthetic events may not be capturable */ }
		};
		const move = (event: PointerEvent) => {
			const gesture = activeGesture; if (!gesture || gesture.pointerId !== event.pointerId) return;
			const current = { x: event.clientX, y: event.clientY };
			if (!gesture.dragging) {
				if (!isJoystickDrag(gesture.start, current)) return;
				const direction = joystickDirection(gesture.start, current); if (!direction) return;
				activeGesture = { ...gesture, dragging: true };
				try { if (gesture.captureOwner !== node && gesture.captureOwner.hasPointerCapture(event.pointerId)) gesture.captureOwner.releasePointerCapture(event.pointerId); node.setPointerCapture(event.pointerId); } catch { /* capture may already be lost */ }
				pointerJoystick = { center: gesture.start, thumb: clampJoystickThumb(gesture.start, current), direction };
				closeFieldActionMenu(); onPointerMovementTakeover(event.pointerId, direction); return;
			}
			const direction = joystickDirection(gesture.start, current); if (!direction) return;
			pointerJoystick = { center: gesture.start, thumb: clampJoystickThumb(gesture.start, current), direction };
			onPointerMovementUpdate(event.pointerId, direction);
		};
		node.addEventListener('pointerdown', down); node.addEventListener('pointermove', move);
		node.addEventListener('pointerup', (event) => finish(event, true)); node.addEventListener('pointercancel', (event) => finish(event, false));
		node.addEventListener('lostpointercapture', (event) => { if (activeGesture && event.target === node) finish(event as PointerEvent, false); });
		cancelPointerGestureImpl = cancel;
		return () => { cancel(); cancelPointerGestureImpl = () => {}; };
	};
</script>

<section
	class={['field-viewport', {
		'initial-field-geometry-ready': geometryReady,
		'composer-available': composerAvailable
	}]}
	bind:this={viewportElement}
	aria-label="Conversation field"
	{@attach pointerGesture}
>
	<div
		class="speech-area"
		style={`top: ${speechAreaVisualBounds.y}px; height: ${speechAreaVisualBounds.height}px; left: ${speechAreaVisualBounds.x}px; width: ${speechAreaVisualBounds.width}px;`}
		aria-hidden="true"
	></div>
	{@render children()}
	<div class="viewport-vignette" aria-hidden="true"></div>
</section>
{#if pointerJoystick}
	<div class="pointer-joystick" data-pointer-joystick={pointerJoystick.direction} aria-hidden="true" style={`left: ${pointerJoystick.center.x}px; top: ${pointerJoystick.center.y}px;`}>
		<div class="pointer-joystick-base"></div><div class="pointer-joystick-thumb" style={`--joystick-thumb-x: ${pointerJoystick.thumb.x}px; --joystick-thumb-y: ${pointerJoystick.thumb.y}px;`}></div>
	</div>
{/if}

<style>
	.field-viewport {
		position: relative;
		min-height: 100svh;
		flex: 1;
		overflow: hidden;
		isolation: isolate;
		background: transparent;
		touch-action: pinch-zoom;
	}

	.pointer-joystick { position: absolute; z-index: 7; width: 96px; height: 96px; transform: translate(-50%, -50%); pointer-events: none; }
	.pointer-joystick-base, .pointer-joystick-thumb { position: absolute; border-radius: 50%; pointer-events: none; }
	.pointer-joystick-base { inset: 0; border: 1px solid rgba(50, 82, 70, 0.32); background: rgba(221, 235, 221, 0.32); }
	.pointer-joystick-thumb { left: calc(50% + var(--joystick-thumb-x)); top: calc(50% + var(--joystick-thumb-y)); width: 32px; height: 32px; transform: translate(-50%, -50%); border: 1px solid rgba(43, 77, 63, 0.48); background: rgba(108, 153, 132, 0.58); }

	.field-viewport.composer-available {
		min-height: 0;
	}

	.field-viewport::before {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: transparent;
		content: '';
	}

	.speech-area {
		position: absolute;
		z-index: 1;
		pointer-events: none;
	}

	.viewport-vignette {
		position: absolute;
		inset: 0;
		z-index: 7;
		pointer-events: none;
		box-shadow: inset 0 0 80px rgba(89, 101, 82, 0.12);
	}
</style>
