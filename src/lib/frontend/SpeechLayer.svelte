<script lang="ts">
	import BubbleTailLayer from '$lib/BubbleTailLayer.svelte';
	import SpeechBubble, { type BubbleMeasurement, type LiveBubblePresentation } from '$lib/SpeechBubble.svelte';
	import TracePresentation from '$lib/TracePresentation.svelte';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import type { SpeechType } from '$lib/conversation';
	import type { Size, WorldPoint } from '$lib/geometry';
	import type { SpeechBubbleShape } from '$lib/speechBubblePath';
	import type { TraceBubblePresentationLayout } from '$lib/traceBubblePresentation';

	type NormalTail = Readonly<{
		id: string;
		tone: BubbleTone;
		speechType: SpeechType;
		anchor: WorldPoint;
		size: Size;
		target: WorldPoint;
		shape: SpeechBubbleShape | null;
	}>;
	type MergedTail = Readonly<{
		id: string;
		tone: BubbleTone;
		speechType: SpeechType;
		anchor: WorldPoint;
		size: Size;
		shape: SpeechBubbleShape | null;
		members: readonly Readonly<{ id: string; target: WorldPoint }>[];
	}>;

	type Props = Readonly<{
		viewportSize: Size;
		traceReady: boolean;
		traceLayout: TraceBubblePresentationLayout | null;
		traceRootTailTarget: WorldPoint | null;
		normalTails: readonly NormalTail[];
		mergedTails: readonly MergedTail[];
		liveBubblePresentations: readonly LiveBubblePresentation[];
		bubbleOverflowById: Readonly<Record<string, boolean>>;
		currentSpeechId: string | null;
		replyRefresh: 'loading' | 'unavailable' | 'settled' | null;
		onSelectSpeech: (id: string) => void;
		onOpenProfile: (characterId: string, trigger: HTMLButtonElement) => void;
		onBubbleMeasurement: (id: string, measurement: BubbleMeasurement) => void;
		onBubbleMeasurementRemoved: (id: string) => void;
		registerBubbleRemeasure: (id: string, measure: () => void) => () => void;
		onReplyFootprint: (id: string, size: Size) => void;
		onReplyFootprintRemoved: (id: string) => void;
		registerReplyRemeasure: (id: string, measure: () => void) => () => void;
	}>;

	let {
		viewportSize,
		traceReady,
		traceLayout,
		traceRootTailTarget,
		normalTails,
		mergedTails,
		liveBubblePresentations,
		bubbleOverflowById,
		currentSpeechId,
		replyRefresh,
		onSelectSpeech,
		onOpenProfile,
		onBubbleMeasurement,
		onBubbleMeasurementRemoved,
		registerBubbleRemeasure,
		onReplyFootprint,
		onReplyFootprintRemoved,
		registerReplyRemeasure
	}: Props = $props();
</script>

<BubbleTailLayer
	{viewportSize}
	traceReady={traceReady}
	traceLayout={traceLayout}
	{traceRootTailTarget}
	{normalTails}
	{mergedTails}
/>

<div class="bubble-layer" aria-live="polite">
	{#each liveBubblePresentations as bubble (bubble.id)}
		<SpeechBubble
			{bubble}
			overflow={bubbleOverflowById[bubble.id] ?? false}
			onMeasurement={onBubbleMeasurement}
			onMeasurementRemoved={onBubbleMeasurementRemoved}
			registerRemeasure={registerBubbleRemeasure}
		/>
	{/each}
	<TracePresentation
		layout={traceLayout}
		ready={traceReady}
		{currentSpeechId}
		{replyRefresh}
		{traceRootTailTarget}
		{bubbleOverflowById}
		onSelectSpeech={onSelectSpeech}
		onOpenProfile={onOpenProfile}
		onBubbleMeasurement={onBubbleMeasurement}
		onBubbleMeasurementRemoved={onBubbleMeasurementRemoved}
		registerBubbleRemeasure={registerBubbleRemeasure}
		onReplyFootprint={onReplyFootprint}
		onReplyFootprintRemoved={onReplyFootprintRemoved}
		registerReplyRemeasure={registerReplyRemeasure}
	/>
</div>
