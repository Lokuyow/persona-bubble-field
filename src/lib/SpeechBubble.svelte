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
		mergedTailConnectionStyle,
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
		tailSeamOffset: number;
		mergedTailConnections?: readonly Readonly<{ participantId: string; seamOffset: number }>[];
		outlineOpenings?: readonly Readonly<{ id: string; points: string }>[];
	}>;

	type Props = Readonly<{
		bubble: LiveBubblePresentation;
		overflow: boolean;
		onMeasurement: (id: string, measurement: BubbleMeasurement) => void;
		onMeasurementRemoved: (id: string) => void;
		registerRemeasure: (id: string, measure: () => void) => () => void;
	}>;

	let { bubble, overflow, onMeasurement, onMeasurementRemoved, registerRemeasure }: Props = $props();

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
		`--tail-seam-offset-x: ${bubble.tailSeamOffset}px`,
		`transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0)`
	].filter(Boolean).join('; '));
</script>

<div
	{@attach observeBubble}
	class={`bubble bubble-${bubble.kind} bubble-${bubble.tone} tone-${bubble.tone}${bubble.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
	data-bubble-id={bubble.id}
	data-bubble-participant-id={bubble.kind === 'normal' ? bubble.participantId : undefined}
	data-merged-members={bubble.kind === 'merged' ? bubble.memberCount : undefined}
	data-speech-type={bubble.speechType}
	style={rootStyle}
>
	{#if bubble.speechType !== 'normal' && bubble.shape}
		<BubbleSurface bubbleId={bubble.id} shape={bubble.shape} variant="live" speechType={bubble.speechType} outlineOpenings={bubble.outlineOpenings} />
	{/if}
	<span class="bubble-content">{bubble.text}</span>
	{#if overflow}
		<span class="bubble-ellipsis" aria-hidden="true">…</span>
	{/if}
	{#if bubble.kind === 'merged' && bubble.speechType === 'normal'}
		{#each bubble.mergedTailConnections ?? [] as connection, index (connection.participantId)}
			<span
				class="bubble-tail-connection"
				data-tail-participant-id={connection.participantId}
				style={`${mergedTailConnectionStyle(index, bubble.mergedTailConnections?.length ?? 0)} --tail-seam-offset-x: ${connection.seamOffset}px;`}
				aria-hidden="true"
			></span>
		{/each}
	{/if}
</div>

<style>
	.bubble { position: absolute; display: flex; align-items: center; justify-content: center; background: var(--tone-background); border: 1px solid var(--tone-outline); border-radius: 18px; color: #364142; font-size: 16px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.35; text-align: center; will-change: transform; }
	.bubble[data-speech-type='shout'] { z-index: 3; }
	.speech-bubble-special { background: transparent; border-color: transparent; border-radius: 0; }
	.speech-bubble-special.bubble-normal::after { content: none; }
	.bubble-content { position: relative; z-index: 1; min-width: 0; max-width: 100%; overflow: hidden; white-space: pre-line; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; text-align: left; user-select: text; -webkit-user-select: text; }
	.bubble-ellipsis { position: absolute; right: 8px; bottom: 5px; z-index: 2; padding-left: 0.5em; background: var(--tone-background); line-height: 1; pointer-events: none; }
	.bubble-normal { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); padding: 12px 15px; }
	.bubble-normal::after { content: ''; position: absolute; left: calc(50% + var(--tail-seam-offset-x, 0px)); bottom: -1px; width: 11px; height: 3px; transform: translateX(-50%); background: var(--tone-background); pointer-events: none; z-index: 1; }
	.bubble-merged { width: fit-content; max-width: min(var(--merged-bubble-max-width, 330px), calc(100% - 32px)); min-width: var(--merged-bubble-min-width, 100px); padding: var(--merged-bubble-padding-y, 12px) var(--merged-bubble-padding-x, 16px); font-size: var(--merged-bubble-font-size, 13px); }
	.bubble-tail-connection { position: absolute; bottom: -1px; width: 9px; height: 3px; transform: translateX(calc(-50% + var(--tail-seam-offset-x, 0px))); background: var(--tone-background); pointer-events: none; z-index: 1; }
	@media (max-width: 700px) {
		.bubble { font-size: 13px; }
		.bubble-normal { min-width: 60px; max-width: min(180px, calc(100% - 32px)); padding: 8px 10px; }
		.bubble-merged {
			min-width: var(--merged-bubble-mobile-min-width, 72px);
			max-width: min(var(--merged-bubble-mobile-max-width, 220px), calc(100% - 32px));
			padding: var(--merged-bubble-mobile-padding-y, 9px) var(--merged-bubble-mobile-padding-x, 12px);
			font-size: var(--merged-bubble-mobile-font-size, 15px);
		}
	}
</style>
