<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import BubbleSurface from './BubbleSurface.svelte';
	import type { SpeechType } from './conversation';
	import type { Size, WorldPoint } from './geometry';
	import type { SpeechBubbleShape } from './speechBubblePath';
	import {
		bubbleToneStyle,
		mergedBubbleStyle,
		liveTailSeamStyle,
		type BubbleTailConnection,
		type BubbleTone
	} from './bubblePresentation';

	export type BubbleMeasurement = Readonly<{ size: Size; overflow: boolean }>;
	export type LiveBubblePresentation = Readonly<{
		id: string;
		kind: 'normal' | 'merged';
		tone: BubbleTone;
		speechType: SpeechType;
		text: string;
		anchor: WorldPoint;
		size: Size;
		shape: SpeechBubbleShape | null;
		participantId?: string;
		memberCount?: number;
		tailConnections: readonly BubbleTailConnection[];
		outlineOpenings?: readonly Readonly<{ id: string; points: string }>[];
	}>;

	type Props = Readonly<{
		bubble: LiveBubblePresentation;
		overflow: boolean;
		arrivalEligible?: boolean;
		onMeasurement: (id: string, measurement: BubbleMeasurement) => void;
		onMeasurementRemoved: (id: string) => void;
		registerRemeasure: (id: string, measure: () => void) => () => void;
		onArrivalConsumed?: (id: string) => void;
	}>;

	let { bubble, overflow, arrivalEligible = false, onMeasurement, onMeasurementRemoved, registerRemeasure, onArrivalConsumed }: Props = $props();
	let arrivalOnMount = $state(untrack(() => arrivalEligible));

	function measure(node: HTMLElement): BubbleMeasurement {
		const content = node.querySelector<HTMLElement>('.bubble-content');
		const rect = node.getBoundingClientRect();
		return {
			size: { width: rect.width, height: rect.height },
			overflow: content ? content.scrollHeight > content.clientHeight : false
		};
	}

	const observeBubble: Attachment<HTMLElement> = (node) => untrack(() => {
		const id = node.dataset.bubbleId!;
		if (arrivalOnMount) onArrivalConsumed?.(id);
		const report = () => untrack(() => onMeasurement(id, measure(node)));
		const observer = new ResizeObserver(report);
		observer.observe(node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		if (content) observer.observe(content);
		const unregister = registerRemeasure(id, report);
		report();
		return () => untrack(() => {
			unregister();
			observer.disconnect();
			onMeasurementRemoved(id);
		});
	});

	let rootStyle = $derived([
		bubbleToneStyle(bubble.tone),
		bubble.kind === 'merged' ? mergedBubbleStyle(bubble.memberCount ?? 0) : '',
		bubble.kind === 'normal' && bubble.tailConnections[0] ? liveTailSeamStyle(bubble.tailConnections[0], false) : '',
		`transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0)`
	].filter(Boolean).join('; '));
</script>

<div
	{@attach observeBubble}
	class={['bubble', `bubble-${bubble.kind}`, `bubble-${bubble.tone}`, `tone-${bubble.tone}`, { 'speech-bubble-special': bubble.speechType !== 'normal', 'bubble-arrival': arrivalOnMount }]}
	data-bubble-id={bubble.id}
	data-bubble-participant-id={bubble.kind === 'normal' ? bubble.participantId : undefined}
	data-merged-members={bubble.kind === 'merged' ? bubble.memberCount : undefined}
	data-speech-type={bubble.speechType}
	style={rootStyle}
>
	<div class="bubble-visual" data-arrival-type={arrivalOnMount ? bubble.speechType : undefined}>
		{#if bubble.speechType !== 'normal' && bubble.shape}
			<BubbleSurface bubbleId={bubble.id} shape={bubble.shape} variant="live" speechType={bubble.speechType} outlineOpenings={bubble.outlineOpenings} />
		{/if}
		<span class="bubble-content">{bubble.text}</span>
		{#if overflow}
			<span class="bubble-ellipsis" aria-hidden="true">…</span>
		{/if}
		{#if bubble.kind === 'merged' && bubble.speechType === 'normal'}
			{#each bubble.tailConnections as connection (connection.participantId)}
				<span
					class="bubble-tail-connection"
					data-tail-participant-id={connection.participantId}
					style={liveTailSeamStyle(connection, true)}
					aria-hidden="true"
				></span>
			{/each}
		{/if}
	</div>
</div>

<style>
	.bubble { position: absolute; display: inline-flex; align-items: stretch; justify-content: stretch; color: #364142; font-size: 16px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.35; text-align: center; will-change: transform; }
	.bubble-visual { position: relative; display: flex; flex: 1 1 auto; min-width: 0; align-items: center; justify-content: center; background: var(--tone-background); border: 1px solid var(--tone-outline); border-radius: 18px; }
	.speech-bubble-special .bubble-visual { background: transparent; border-color: transparent; border-radius: 0; }
	.bubble[data-speech-type='shout'] { z-index: 3; }
	.speech-bubble-special.bubble-normal::after { content: none; }
	.bubble-arrival .bubble-visual { animation: bubble-arrival var(--motion-duration-interaction) var(--motion-easing-standard) both; }
	.bubble-arrival .bubble-visual[data-arrival-type='shout'] { animation-name: bubble-arrival-shout; }
	.bubble-arrival .bubble-visual[data-arrival-type='monologue'] { animation-name: bubble-arrival-monologue; }
	@keyframes bubble-arrival { from { opacity: 0; scale: .97; } to { opacity: 1; scale: 1; } }
	@keyframes bubble-arrival-shout { from { opacity: 0; scale: .93; } to { opacity: 1; scale: 1; } }
	@keyframes bubble-arrival-monologue { from { opacity: 0; } to { opacity: 1; } }
	.bubble-content { position: relative; z-index: 1; min-width: 0; max-width: 100%; overflow: hidden; white-space: pre-line; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; text-align: left; user-select: text; -webkit-user-select: text; }
	.bubble-ellipsis { position: absolute; right: 8px; bottom: 5px; z-index: 2; padding-left: 0.5em; background: var(--tone-background); line-height: 1; pointer-events: none; }
	.bubble-normal { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); }
	.bubble-normal > .bubble-visual { padding: 12px 15px; }
	.bubble-normal::after { content: ''; position: absolute; left: calc(var(--tail-seam-x) - 1px); top: calc(var(--tail-seam-y) - 1px); width: var(--tail-seam-width); height: var(--tail-seam-height); transform: translate(-50%, -50%); background: var(--tone-background); pointer-events: none; z-index: 1; }
	.bubble-merged { width: fit-content; max-width: min(var(--merged-bubble-max-width, 330px), calc(100% - 32px)); min-width: var(--merged-bubble-min-width, 100px); font-size: var(--merged-bubble-font-size, 13px); }
	.bubble-merged > .bubble-visual { padding: var(--merged-bubble-padding-y, 12px) var(--merged-bubble-padding-x, 16px); }
	.bubble-tail-connection { position: absolute; left: calc(var(--tail-seam-x) - 1px); top: calc(var(--tail-seam-y) - 1px); width: var(--tail-seam-width); height: var(--tail-seam-height); transform: translate(-50%, -50%); background: var(--tone-background); pointer-events: none; z-index: 1; }
	@media (max-width: 700px) {
		.bubble { font-size: 13px; }
		.bubble-normal { min-width: 60px; max-width: min(180px, calc(100% - 32px)); }
		.bubble-normal > .bubble-visual { padding: 8px 10px; }
		.bubble-merged {
			min-width: var(--merged-bubble-mobile-min-width, 72px);
			max-width: min(var(--merged-bubble-mobile-max-width, 220px), calc(100% - 32px));
			font-size: var(--merged-bubble-mobile-font-size, 15px);
		}
		.bubble-merged > .bubble-visual { padding: var(--merged-bubble-mobile-padding-y, 9px) var(--merged-bubble-mobile-padding-x, 12px); }
	}
	@media (prefers-reduced-motion: reduce) {
		.bubble-arrival .bubble-visual { animation-name: bubble-arrival-reduced; }
		.bubble-arrival .bubble-visual[data-arrival-type='shout'],
		.bubble-arrival .bubble-visual[data-arrival-type='monologue'] { animation-name: bubble-arrival-reduced; }
		@keyframes bubble-arrival-reduced { from { opacity: .35; } to { opacity: 1; } }
	}
</style>
