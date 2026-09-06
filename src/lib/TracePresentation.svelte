<script lang="ts">
	import { Avatar } from 'bits-ui';
	import { asset } from '$app/paths';
	import BubbleSurface from './BubbleSurface.svelte';
	import type { Size } from './geometry';
	import type { WorldPoint } from './geometry';
	import type { TraceBubblePresentationLayout } from './traceBubblePresentation';
	import type { BubbleMeasurement } from './SpeechBubble.svelte';
	import { bubbleToneStyle, specialTailExtension, tailGeometry, tailOutlineOpeningPoints, tailStart } from './bubblePresentation';

	type TraceSelectionDetails = Readonly<{ index: number; total: number }> | null;
	type Props = Readonly<{
		layout: TraceBubblePresentationLayout | null;
		ready: boolean;
		selectedTraceDetails: TraceSelectionDetails;
		replyRefresh: 'loading' | 'unavailable' | 'settled' | null;
		traceRootTailTarget: WorldPoint | null;
		bubbleOverflowById: Readonly<Record<string, boolean>>;
		onSelectSpeech: (id: string) => void;
		onOpenProfile: (characterId: string, trigger: HTMLButtonElement) => void;
		onSelectAdjacentRoot: (direction: -1 | 1) => void;
		onBubbleMeasurement: (id: string, measurement: BubbleMeasurement) => void;
		onBubbleMeasurementRemoved: (id: string) => void;
		registerBubbleRemeasure: (id: string, measure: () => void) => () => void;
		onReplyFootprint: (id: string, size: Size) => void;
		onReplyFootprintRemoved: (id: string) => void;
		registerReplyRemeasure: (id: string, measure: () => void) => () => void;
	}>;

	let {
		layout,
		ready,
		selectedTraceDetails,
		replyRefresh,
		traceRootTailTarget,
		bubbleOverflowById,
		onSelectSpeech,
		onOpenProfile,
		onSelectAdjacentRoot,
		onBubbleMeasurement,
		onBubbleMeasurementRemoved,
		registerBubbleRemeasure,
		onReplyFootprint,
		onReplyFootprintRemoved,
		registerReplyRemeasure
	}: Props = $props();

	function bodyMeasurement(node: HTMLElement): BubbleMeasurement {
		const content = node.querySelector<HTMLElement>('.bubble-content');
		const rect = node.getBoundingClientRect();
		return {
			size: { width: rect.width, height: rect.height },
			overflow: content ? content.scrollHeight > content.clientHeight : false
		};
	}

	function observeRootBubble(node: HTMLElement) {
		const { reportMeasurement, removeMeasurement, register } = {
			reportMeasurement: onBubbleMeasurement,
			removeMeasurement: onBubbleMeasurementRemoved,
			register: registerBubbleRemeasure
		};
		const id = node.dataset.bubbleId!;
		const report = () => reportMeasurement(id, bodyMeasurement(node));
		const observer = new ResizeObserver(report);
		observer.observe(node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		if (content) observer.observe(content);
		const unregister = register(id, report);
		report();
		return {
			destroy() {
				unregister();
				observer.disconnect();
				removeMeasurement(id);
			}
		};
	}

	function observeReplyCard(node: HTMLElement) {
		const { reportMeasurement, reportFootprint, removeMeasurement, removeFootprint, register } = {
			reportMeasurement: onBubbleMeasurement,
			reportFootprint: onReplyFootprint,
			removeMeasurement: onBubbleMeasurementRemoved,
			removeFootprint: onReplyFootprintRemoved,
			register: registerReplyRemeasure
		};
		const id = node.dataset.bubbleId!;
		// Preserve current physical geometry: both reporting paths measure this card root.
		const report = () => {
			const body = bodyMeasurement(node);
			reportMeasurement(id, body);
			reportFootprint(id, body.size);
		};
		const observer = new ResizeObserver(report);
		observer.observe(node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		if (content) observer.observe(content);
		const unregister = register(id, report);
		report();
		return {
			destroy() {
				unregister();
				observer.disconnect();
				removeMeasurement(id);
				removeFootprint(id);
			}
		};
	}
</script>

{#if layout}
	{#each layout.cards as bubble (bubble.id)}
		<div
			use:observeReplyCard
			class={`bubble bubble-normal trace-reply-card bubble-${bubble.tone} tone-${bubble.tone}${bubble.reply.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
			class:trace-presentation-pending={!ready}
			data-trace-reply-id={bubble.reply.id}
			data-trace-geometry-ready={ready ? 'ready' : 'pending'}
			data-trace-role={bubble.role}
			data-trace-current-reply-id={bubble.role === 'current' ? bubble.reply.id : undefined}
			data-trace-parent-id={bubble.role === 'parent' ? bubble.reply.id : undefined}
			data-speech-type={bubble.reply.speechType}
			data-bubble-id={bubble.id}
			style={`${bubbleToneStyle(bubble.tone, true)}; transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
		>
			{#if bubble.reply.speechType !== 'normal' && bubble.shape}
				<BubbleSurface bubbleId={bubble.id} shape={bubble.shape} variant="trace" speechType={bubble.reply.speechType} />
			{/if}
			<button class="trace-reply-author-profile" data-trace-author-block type="button" aria-label={`${bubble.character.name} のプロフィールを開く`} onclick={(event) => { event.stopPropagation(); onOpenProfile(bubble.character.characterId, event.currentTarget); }}>
				<span class="trace-reply-author-avatar"><Avatar.Root class={`avatar avatar-${bubble.tone}`}><Avatar.Image src={asset(`/${bubble.character.picture}`)} alt="" /><Avatar.Fallback>{bubble.character.name.slice(0, 1)}</Avatar.Fallback></Avatar.Root></span>
				<span class="trace-reply-author-name">{bubble.character.name}</span>
			</button>
			<button class="trace-reply-content-button" type="button" onclick={(event) => { event.stopPropagation(); onSelectSpeech(bubble.reply.id); }}>
				<span class="bubble-content">{bubble.reply.content}</span>
				{#if bubbleOverflowById[bubble.id]}<span class="bubble-ellipsis" aria-hidden="true">…</span>{/if}
			</button>
		</div>
	{/each}
	{#key layout.root.id}
	<div class="trace-root-card" class:trace-presentation-pending={!ready} data-trace-geometry-ready={ready ? 'ready' : 'pending'} style={`transform: translate3d(${layout.root.anchor.x}px, ${layout.root.anchor.y}px, 0);`}>
		<button
			type="button"
			use:observeRootBubble
			class={`bubble bubble-normal trace-root-bubble trace-current-bubble bubble-${layout.root.tone} tone-${layout.root.tone}${layout.root.event.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
			data-bubble-id={layout.root.id}
			data-trace-root-id={layout.root.event.id}
			data-trace-current-id={layout.root.event.id}
			data-trace-current-kind="root"
			data-speech-type={layout.root.event.speechType}
			style={bubbleToneStyle(layout.root.tone, true)}
			onclick={(event) => { event.stopPropagation(); onSelectSpeech(layout.root.event.id); }}
		>
			{#if layout.root.event.speechType !== 'normal' && layout.root.shape}
				{@const rootOpening = traceRootTailTarget ? tailOutlineOpeningPoints(tailGeometry(tailStart(layout.root.anchor, layout.root.size), traceRootTailTarget, 11, 2, specialTailExtension(layout.root.event.speechType)), layout.root.anchor) : null}
				<BubbleSurface bubbleId={layout.root.id} shape={layout.root.shape} variant="trace" speechType={layout.root.event.speechType} outlineOpenings={rootOpening ? [{ id: `trace-root-${layout.root.event.id}`, points: rootOpening }] : []} />
			{/if}
			<span class:trace-root-compact={layout.root.compact} class="bubble-content">{layout.root.event.content}</span>
			{#if bubbleOverflowById[layout.root.id]}<span class="bubble-ellipsis" aria-hidden="true">…</span>{/if}
		</button>
		{#if selectedTraceDetails && selectedTraceDetails.total > 1}
			<div class="trace-root-selector" aria-label="Trace roots in this cell">
				<button type="button" aria-label="Previous trace root" disabled={selectedTraceDetails.index === 0} onclick={() => onSelectAdjacentRoot(-1)}>‹</button>
				<span>{selectedTraceDetails.index + 1}/{selectedTraceDetails.total}</span>
				<button type="button" aria-label="Next trace root" disabled={selectedTraceDetails.index === selectedTraceDetails.total - 1} onclick={() => onSelectAdjacentRoot(1)}>›</button>
			</div>
		{/if}
		{#if replyRefresh && replyRefresh !== 'settled'}
			<span class="trace-reply-status" data-reply-refresh={replyRefresh}>
				{replyRefresh === 'loading' ? 'Loading…' : 'Replies unavailable'}
			</span>
		{/if}
	</div>
	{/key}
{/if}

<style>
	.bubble { position: absolute; display: flex; align-items: center; justify-content: center; background: var(--tone-background); border: 1px solid var(--tone-outline); border-radius: 18px; color: #364142; font-size: 16px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.35; text-align: center; will-change: transform; }
	.speech-bubble-special { background: transparent; border-color: transparent; border-radius: 0; }
	.speech-bubble-special.bubble-normal::after { content: none; }
	.bubble-content { position: relative; z-index: 1; min-width: 0; max-width: 100%; overflow: hidden; white-space: pre-line; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; text-align: left; }
	.bubble-ellipsis { position: absolute; right: 8px; bottom: 5px; z-index: 2; padding-left: 0.5em; background: var(--tone-background); line-height: 1; pointer-events: none; }
	.bubble-normal { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); padding: 12px 15px; }
	.bubble-normal::after { content: ''; position: absolute; left: calc(50% + var(--tail-seam-offset-x, 0px)); bottom: -1px; width: 11px; height: 3px; transform: translateX(-50%); background: var(--tone-background); pointer-events: none; z-index: 1; }
	.trace-root-bubble,
	.trace-reply-card { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); padding: 12px 15px; border-style: dashed; background: var(--trace-surface, color-mix(in srgb, var(--tone-background) 91%, transparent)); pointer-events: auto; }
	.trace-root-card,
	.trace-reply-card { position: absolute; pointer-events: auto; }
	.trace-presentation-pending { visibility: hidden; pointer-events: none; }
	.trace-root-card { z-index: 1; display: flex; }
	.trace-root-card .trace-root-bubble { position: relative; }
	.trace-reply-card { z-index: 2; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 6px; align-items: start; min-width: 144px; }
	.trace-reply-author-profile { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; padding: 0; gap: 3px; border: 0; background: transparent; color: #40504b; font-size: 12px; font-weight: 800; line-height: 1.1; text-align: center; }
	.trace-reply-author-avatar { position: relative; display: block; order: -1; width: 36px; height: 36px; flex: 0 0 auto; }
	.trace-reply-author-avatar :global(.avatar) { width: 36px; height: 36px; }
	.trace-reply-author-name { display: block; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.trace-reply-content-button { position: relative; z-index: 1; grid-column: 2; grid-row: 1; min-width: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
	.trace-reply-author-profile:focus-visible,
	.trace-reply-content-button:focus-visible,
	.trace-root-bubble:focus-visible { outline: 3px solid #6dabb9; outline-offset: 2px; }
	.trace-root-compact { -webkit-line-clamp: 1; line-clamp: 1; }
	.trace-root-bubble.speech-bubble-special,
	.trace-reply-card.speech-bubble-special { background: transparent; }
	.trace-root-bubble .bubble-content,
	.trace-reply-card .bubble-content { color: #26312f; opacity: 1; }
	.trace-root-selector { position: absolute; top: calc(100% + 5px); left: 50%; z-index: 4; display: flex; align-items: center; gap: 6px; padding: 3px 5px; border: 1px solid rgba(65, 77, 73, 0.22); border-radius: 999px; background: rgba(250, 250, 244, 0.94); box-shadow: 0 4px 12px rgba(44, 54, 50, 0.14); color: #53625d; font-size: 10px; transform: translateX(-50%); pointer-events: auto; }
	.trace-root-selector button { display: grid; width: 26px; height: 26px; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: inherit; font-size: 20px; line-height: 1; cursor: pointer; }
	.trace-root-selector button:disabled { opacity: 0.32; cursor: default; }
	.trace-root-selector button:focus-visible { outline: 2px solid #6dabb9; }
	.trace-reply-status { position: absolute; top: calc(100% + 42px); left: 50%; width: max-content; max-width: 180px; padding: 2px 7px; border-radius: 999px; background: rgba(250, 250, 244, 0.88); color: #68736f; font-size: 9px; font-weight: 700; transform: translateX(-50%); }
</style>
