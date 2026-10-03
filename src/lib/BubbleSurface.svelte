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
		selected?: boolean;
		replyHitAreaHover?: boolean;
		hoveredReplyHitArea?: 'profile' | 'content' | null;
	}>;

	let { bubbleId, shape, variant, speechType, outlineOpenings = [], selected = false, replyHitAreaHover = false, hoveredReplyHitArea = null }: Props = $props();
	let outlineMask = $derived(speechOutlineMaskId(bubbleId));
	let profileHitAreaClip = $derived(`${outlineMask}-profile-hit-area`);
	let contentHitAreaClip = $derived(`${outlineMask}-content-hit-area`);
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
	{#if variant === 'trace' && replyHitAreaHover}
		<defs>
			<clipPath id={profileHitAreaClip} clipPathUnits="userSpaceOnUse">
				<rect data-reply-hit-area="profile" x={shape.bounds.x} y={shape.bounds.y} width="0" height={shape.bounds.height} />
			</clipPath>
			<clipPath id={contentHitAreaClip} clipPathUnits="userSpaceOnUse">
				<rect data-reply-hit-area="content" x={shape.bounds.x + shape.bounds.width} y={shape.bounds.y} width="0" height={shape.bounds.height} />
			</clipPath>
			<path id={`${outlineMask}-reply-hover-shape`} d={shape.path} />
		</defs>
	{/if}
	<path class="bubble-surface-fill" class:trace-bubble-surface-fill={variant === 'trace'} d={shape.path} />
	{#if variant === 'trace' && replyHitAreaHover}
		<use class="trace-profile-hit-area-hover" class:active={hoveredReplyHitArea === 'profile'} href={`#${outlineMask}-reply-hover-shape`} clip-path={`url(#${profileHitAreaClip})`} />
		<use class="trace-content-hit-area-hover" class:active={hoveredReplyHitArea === 'content'} href={`#${outlineMask}-reply-hover-shape`} clip-path={`url(#${contentHitAreaClip})`} />
	{/if}
	<path class="bubble-surface-outline" class:trace-bubble-surface-outline={variant === 'trace'} class:trace-current-selection-outline={selected && variant === 'trace'} d={shape.path} mask={hasOutlineMask ? `url(#${outlineMask})` : undefined} />
</svg>

<style>
	.bubble-surface { position: absolute; z-index: 0; display: block; overflow: visible; pointer-events: none; }
	.bubble-surface-fill { fill: var(--tone-background); }
	.bubble-surface-outline { fill: none; stroke: var(--tone-outline); stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; }
	.trace-bubble-surface-fill { fill: var(--trace-surface); }
	.trace-bubble-surface-outline { stroke-dasharray: 4 3; }
	.trace-current-selection-outline { stroke: var(--color-accent); stroke-width: 2; stroke-dasharray: none; }
	.trace-profile-hit-area-hover,
	.trace-content-hit-area-hover { fill: color-mix(in srgb, var(--tone-outline) 26%, var(--trace-surface)); opacity: 0; pointer-events: none; }
	.trace-profile-hit-area-hover.active,
	.trace-content-hit-area-hover.active { opacity: 1; }
</style>
