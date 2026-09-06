<script lang="ts">
	import type { SpeechType } from './conversation';
	import type { Size, WorldPoint } from './geometry';
	import type { TraceBubblePresentationLayout } from './traceBubblePresentation';
	import {
		bubbleCenter,
		bubbleToneStyle,
		mergedTailStart,
		NORMAL_TRACE_ROOT_RADIUS,
		specialTailExtension,
		tailGeometry,
		tailStart,
		taperedBandGeometry,
		traceSurfaceOcclusionMaskId,
		type BubbleTone
	} from './bubblePresentation';

	const TRACE_RELATION_FOREGROUND_PARENT_WIDTH = 16;
	const TRACE_RELATION_FOREGROUND_CHILD_WIDTH = 0.4;
	const TRACE_RELATION_HALO_PARENT_WIDTH = 21;
	const TRACE_RELATION_HALO_CHILD_WIDTH = 1.2;

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
		{@const occlusionMask = traceSurfaceOcclusionMaskId(traceRoot.id)}
		<defs>
			<mask id={occlusionMask} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width={viewportSize.width} height={viewportSize.height}>
				<rect x="0" y="0" width={viewportSize.width} height={viewportSize.height} fill="white" />
				{#if traceRoot.shape}
					<path d={traceRoot.shape.path} transform={`translate(${traceRoot.anchor.x} ${traceRoot.anchor.y})`} fill="black" />
				{:else}
					<rect x={traceRoot.anchor.x} y={traceRoot.anchor.y} width={traceRoot.size.width} height={traceRoot.size.height} rx={NORMAL_TRACE_ROOT_RADIUS} fill="black" />
				{/if}
				{#each traceLayout.cards as bubble (bubble.id)}
					{#if bubble.shape}
						<path d={bubble.shape.path} transform={`translate(${bubble.anchor.x} ${bubble.anchor.y})`} fill="black" />
					{:else}
						<rect x={bubble.anchor.x} y={bubble.anchor.y} width={bubble.size.width} height={bubble.size.height} rx={NORMAL_TRACE_ROOT_RADIUS} fill="black" />
					{/if}
				{/each}
			</mask>
		</defs>
		<g data-trace-surface-occlusion-root-id={traceRoot.event.id} mask={`url(#${occlusionMask})`}>
			{#if traceRootTailTarget}
				{@const rootTail = tailGeometry(tailStart(traceRoot.anchor, traceRoot.size), traceRootTailTarget, 11, 2, specialTailExtension(traceRoot.event.speechType))}
				<polygon class={`tail trace-tail tail-${traceRoot.tone} tone-${traceRoot.tone}`} data-trace-tail-root-id={traceRoot.event.id} data-trace-tail-target={`${traceRootTailTarget.x},${traceRootTailTarget.y}`} points={rootTail.points} style={bubbleToneStyle(traceRoot.tone, true)} />
				<path class={`tail-outline trace-tail-outline tone-${traceRoot.tone}`} data-trace-tail-root-id={traceRoot.event.id} d={rootTail.outlinePath} style={bubbleToneStyle(traceRoot.tone, true)} />
			{/if}
			{#each traceLayout.cards as bubble (bubble.id)}
				{@const parent = traceLayout.cards.find((candidate) => candidate.reply.id === bubble.reply.parentId)}
				{@const relationStart = parent ? bubbleCenter(parent.anchor, parent.footprint) : bubble.reply.parentId === traceRoot.event.id ? bubbleCenter(traceRoot.anchor, traceRoot.footprint) : null}
				{#if relationStart}
					{@const relationEnd = bubbleCenter(bubble.anchor, bubble.footprint)}
					{@const halo = taperedBandGeometry(relationStart, relationEnd, TRACE_RELATION_HALO_PARENT_WIDTH, TRACE_RELATION_HALO_CHILD_WIDTH)}
					{@const foreground = taperedBandGeometry(relationStart, relationEnd, TRACE_RELATION_FOREGROUND_PARENT_WIDTH, TRACE_RELATION_FOREGROUND_CHILD_WIDTH)}
					<polygon class="trace-relation-halo" data-trace-relation-halo-reply-id={bubble.reply.id} points={halo.points} />
					<polygon class="trace-relation-connector" data-trace-relation-reply-id={bubble.reply.id} points={foreground.points} />
				{/if}
			{/each}
		</g>
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
	.trace-relation-halo { fill: rgba(238, 245, 238, 0.64); pointer-events: none; }
	.trace-relation-connector { fill: rgba(77, 101, 93, 0.72); pointer-events: none; }
	.trace-tail { fill: var(--trace-surface); }
	.trace-tail-outline { stroke-dasharray: 4 3; }
</style>
