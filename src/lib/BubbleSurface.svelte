<script lang="ts">
	import type { SpeechBubbleShape } from './speechBubblePath';
	import type { SpeechType } from './conversation';
	import { bubbleSurfaceStyle, speechOutlineMaskId } from './bubblePresentation';

	type Props = Readonly<{
		bubbleId: string;
		shape: SpeechBubbleShape;
		variant: 'live' | 'trace';
		speechType: Exclude<SpeechType, 'normal'>;
		outlineOpenings?: readonly Readonly<{ id: string; points: string }>[];
	}>;

	let { bubbleId, shape, variant, speechType, outlineOpenings = [] }: Props = $props();
	let outlineMask = $derived(speechOutlineMaskId(bubbleId));
	let hasOutlineMask = $derived(outlineOpenings.length > 0);
</script>

<svg
	class="bubble-surface"
	class:trace-bubble-surface={variant === 'trace'}
	data-speech-surface={speechType}
	data-visual-bounds={`${shape.bounds.x},${shape.bounds.y},${shape.bounds.width},${shape.bounds.height}`}
	viewBox={`${shape.bounds.x} ${shape.bounds.y} ${shape.bounds.width} ${shape.bounds.height}`}
	style={bubbleSurfaceStyle(shape)}
	aria-hidden="true"
>
	{#if hasOutlineMask}
		<defs>
			<mask id={outlineMask} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={shape.bounds.x} y={shape.bounds.y} width={shape.bounds.width} height={shape.bounds.height}>
				<rect x={shape.bounds.x} y={shape.bounds.y} width={shape.bounds.width} height={shape.bounds.height} fill="white" />
			{#each outlineOpenings as opening}
				<polygon data-tail-opening={opening.id} points={opening.points} fill="black" />
				{/each}
			</mask>
		</defs>
	{/if}
	<path class="bubble-surface-fill" class:trace-bubble-surface-fill={variant === 'trace'} d={shape.path} />
	<path class="bubble-surface-outline" class:trace-bubble-surface-outline={variant === 'trace'} d={shape.path} mask={hasOutlineMask ? `url(#${outlineMask})` : undefined} />
</svg>

<style>
	.bubble-surface { position: absolute; z-index: 0; display: block; overflow: visible; pointer-events: none; }
	.bubble-surface-fill { fill: var(--tone-background); }
	.bubble-surface-outline { fill: none; stroke: var(--tone-outline); stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; }
	.trace-bubble-surface-fill { fill: var(--trace-surface); }
	.trace-bubble-surface-outline { stroke-dasharray: 4 3; }
</style>
