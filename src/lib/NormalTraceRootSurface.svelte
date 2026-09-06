<script lang="ts">
	import type { Size } from './geometry';
	import { NORMAL_TRACE_ROOT_RADIUS, speechOutlineMaskId } from './bubblePresentation';

	type Props = Readonly<{
		bubbleId: string;
		size: Size;
		outlineOpening: Readonly<{ id: string; points: string }> | null;
	}>;

	let { bubbleId, size, outlineOpening }: Props = $props();
	let outlineMask = $derived(speechOutlineMaskId(bubbleId));
	let outlineRadius = $derived(Math.max(0, NORMAL_TRACE_ROOT_RADIUS - 0.5));
</script>

<svg class="normal-trace-root-surface" viewBox={`0 0 ${size.width} ${size.height}`} style={`left: -1px; top: -1px; width: ${size.width}px; height: ${size.height}px;`} aria-hidden="true">
	{#if outlineOpening}
		<defs>
			<mask id={outlineMask} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width={size.width} height={size.height}>
				<rect x="0" y="0" width={size.width} height={size.height} fill="white" />
				<polygon data-tail-opening={outlineOpening.id} points={outlineOpening.points} fill="black" />
			</mask>
		</defs>
	{/if}
	<rect class="normal-trace-root-fill" x="0" y="0" width={size.width} height={size.height} rx={NORMAL_TRACE_ROOT_RADIUS} />
	<rect class="normal-trace-root-outline" x="0.5" y="0.5" width={Math.max(0, size.width - 1)} height={Math.max(0, size.height - 1)} rx={outlineRadius} mask={outlineOpening ? `url(#${outlineMask})` : undefined} />
</svg>

<style>
	.normal-trace-root-surface { position: absolute; z-index: 0; overflow: visible; pointer-events: none; }
	.normal-trace-root-fill { fill: var(--trace-surface); }
	.normal-trace-root-outline { fill: none; stroke: var(--tone-outline); stroke-width: 1; stroke-dasharray: 4 3; stroke-linecap: round; stroke-linejoin: round; }
</style>
