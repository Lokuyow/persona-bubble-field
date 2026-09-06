<script lang="ts">
	import type { SpeechType } from './conversation';
	import type { Size, WorldPoint } from './geometry';
	import type { TraceBubblePresentationLayout } from './traceBubblePresentation';
	import {
		bubbleCenter,
		bubbleToneStyle,
		mergedTailStart,
		specialTailExtension,
		tailGeometry,
		tailStart,
		traceRelationPath,
		traceTailMaskId,
		type BubbleTone
	} from './bubblePresentation';

	type NormalTail = Readonly<{ id: string; tone: BubbleTone; speechType: SpeechType; anchor: WorldPoint; size: Size; target: WorldPoint }>;
	type MergedTail = Readonly<{ id: string; tone: BubbleTone; speechType: SpeechType; anchor: WorldPoint; size: Size; members: readonly Readonly<{ id: string; target: WorldPoint }>[] }>;
	type Props = Readonly<{
		viewportSize: Size;
		traceReady: boolean;
		traceLayout: TraceBubblePresentationLayout | null;
		traceRootTailTarget: WorldPoint | null;
		normalTails: readonly NormalTail[];
		mergedTails: readonly MergedTail[];
	}>;

	let { viewportSize, traceReady, traceLayout, traceRootTailTarget, normalTails, mergedTails }: Props = $props();
</script>

<svg class="tail-layer" viewBox={`0 0 ${viewportSize.width} ${viewportSize.height}`} aria-hidden="true">
	{#if traceReady && traceLayout}
		{@const traceRoot = traceLayout.root}
		{#if traceRootTailTarget}
			{@const rootTail = tailGeometry(tailStart(traceRoot.anchor, traceRoot.size), traceRootTailTarget, 11, 2, specialTailExtension(traceRoot.event.speechType))}
			{#if traceRoot.event.speechType !== 'normal' && traceRoot.shape}
				<defs>
					<mask id={traceTailMaskId(traceRoot.id)} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width={viewportSize.width} height={viewportSize.height}>
						<rect x="0" y="0" width={viewportSize.width} height={viewportSize.height} fill="white" />
						<path d={traceRoot.shape.path} transform={`translate(${traceRoot.anchor.x} ${traceRoot.anchor.y})`} fill="black" />
					</mask>
				</defs>
			{/if}
			<polygon class={`tail trace-tail tail-${traceRoot.tone} tone-${traceRoot.tone}`} data-trace-tail-root-id={traceRoot.event.id} data-trace-tail-target={`${traceRootTailTarget.x},${traceRootTailTarget.y}`} points={rootTail.points} mask={traceRoot.event.speechType !== 'normal' ? `url(#${traceTailMaskId(traceRoot.id)})` : undefined} style={bubbleToneStyle(traceRoot.tone, true)} />
			<path class={`tail-outline trace-tail-outline tone-${traceRoot.tone}`} data-trace-tail-root-id={traceRoot.event.id} d={rootTail.outlinePath} mask={traceRoot.event.speechType !== 'normal' ? `url(#${traceTailMaskId(traceRoot.id)})` : undefined} style={bubbleToneStyle(traceRoot.tone, true)} />
		{/if}
		{#each traceLayout.cards as bubble (bubble.id)}
			{@const parent = traceLayout.cards.find((candidate) => candidate.reply.id === bubble.reply.parentId)}
			{#if parent}
				<path class="trace-relation-connector" data-trace-relation-reply-id={bubble.reply.id} d={traceRelationPath(bubbleCenter(parent.anchor, parent.footprint), bubbleCenter(bubble.anchor, bubble.footprint))} />
			{:else if bubble.reply.parentId === traceRoot.event.id}
				<path class="trace-relation-connector" data-trace-relation-reply-id={bubble.reply.id} d={traceRelationPath(bubbleCenter(traceRoot.anchor, traceRoot.footprint), bubbleCenter(bubble.anchor, bubble.footprint))} />
			{/if}
		{/each}
	{/if}
	{#each normalTails as bubble (bubble.id)}
		{@const tail = tailGeometry(tailStart(bubble.anchor, bubble.size), bubble.target, 11, 2, specialTailExtension(bubble.speechType))}
		<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={bubble.id} points={tail.points} style={bubbleToneStyle(bubble.tone)} />
		<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={bubble.id} d={tail.outlinePath} style={bubbleToneStyle(bubble.tone)} />
	{/each}
	{#each mergedTails as bubble (bubble.id)}
		{#each bubble.members as member, index (member.id)}
			{@const tail = tailGeometry(mergedTailStart(bubble.anchor, bubble.size, index, bubble.members.length), member.target, 9, 2, specialTailExtension(bubble.speechType))}
			<polygon class={`tail tail-${bubble.tone} tone-${bubble.tone}`} data-tail-participant-id={member.id} points={tail.points} style={bubbleToneStyle(bubble.tone)} />
			<path class={`tail-outline tone-${bubble.tone}`} data-tail-participant-id={member.id} d={tail.outlinePath} style={bubbleToneStyle(bubble.tone)} />
		{/each}
	{/each}
</svg>

<style>
	.tail-layer { position: absolute; inset: 0; z-index: 4; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
	.tail { fill: var(--tone-background); }
	.tail-outline { fill: none; stroke: var(--tone-outline); stroke-width: 1; stroke-linecap: round; stroke-linejoin: round; }
	.trace-relation-connector { fill: none; stroke: rgba(77, 101, 93, 0.64); stroke-width: 1.5; stroke-dasharray: 3 5; stroke-linecap: round; pointer-events: none; }
	.trace-tail { fill: var(--trace-surface); }
	.trace-tail-outline { stroke-dasharray: 4 3; }
</style>
