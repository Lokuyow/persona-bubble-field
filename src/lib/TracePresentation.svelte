<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import BubbleSurface from './BubbleSurface.svelte';
	import CharacterAvatar from './CharacterAvatar.svelte';
	import NormalTraceRootSurface from './NormalTraceRootSurface.svelte';
	import type { Size } from './geometry';
	import type { BubbleTailConnection } from './bubblePresentation';
	import type { TraceBubblePresentationLayout } from './traceBubblePresentation';
	import type { BubbleMeasurement } from './SpeechBubble.svelte';
	import { bubbleToneStyle, tailOutlineOpeningPoints } from './bubblePresentation';

	type Props = Readonly<{
		layout: TraceBubblePresentationLayout | null;
		ready: boolean;
		currentSpeechId: string | null;
		replyRefresh: 'loading' | 'unavailable' | 'settled' | null;
		traceRootTailConnection: BubbleTailConnection | null;
		bubbleOverflowById: Readonly<Record<string, boolean>>;
		onSelectSpeech: (id: string) => void;
		onOpenProfile: (characterId: string, pubkey: string, trigger: HTMLButtonElement) => void;
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
		currentSpeechId,
		replyRefresh,
		traceRootTailConnection,
		bubbleOverflowById,
		onSelectSpeech,
		onOpenProfile,
		onBubbleMeasurement,
		onBubbleMeasurementRemoved,
		registerBubbleRemeasure,
		onReplyFootprint,
		onReplyFootprintRemoved,
		registerReplyRemeasure
	}: Props = $props();

	let rootOpening = $derived.by(() => layout && traceRootTailConnection
		? tailOutlineOpeningPoints(traceRootTailConnection.tail, layout.root.anchor)
		: null);
	let showCurrentSelection = $derived(Boolean(layout && layout.cards.length > 0 && currentSpeechId));
	type ReplyHitAreaState = { pointer: 'profile' | 'content' | null; focus: 'profile' | 'content' | null };
	let replyHitAreaStateById = $state<Record<string, ReplyHitAreaState>>({});
	function setReplyHitArea(id: string, source: 'pointer' | 'focus', hitArea: 'profile' | 'content', active: boolean): void {
		const state = replyHitAreaStateById[id] ?? { pointer: null, focus: null };
		replyHitAreaStateById = { ...replyHitAreaStateById, [id]: { ...state, [source]: active ? hitArea : state[source] === hitArea ? null : state[source] } };
	}

	function bodyMeasurement(node: HTMLElement): BubbleMeasurement {
		const content = node.querySelector<HTMLElement>('.bubble-content');
		const rect = node.getBoundingClientRect();
		return {
			size: { width: rect.width, height: rect.height },
			overflow: content ? content.scrollHeight > content.clientHeight : false
		};
	}

	const observeRootBubble: Attachment<HTMLElement> = (node) => untrack(() => {
		const id = node.dataset.bubbleId!;
		const report = () => untrack(() => onBubbleMeasurement(id, bodyMeasurement(node)));
		const observer = new ResizeObserver(report);
		observer.observe(node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		if (content) observer.observe(content);
		const unregister = registerBubbleRemeasure(id, report);
		report();
		return () => untrack(() => {
			unregister();
			observer.disconnect();
			onBubbleMeasurementRemoved(id);
		});
	});

	const observeReplyCard: Attachment<HTMLElement> = (node) => untrack(() => {
		const id = node.dataset.bubbleId!;
		// Preserve current physical geometry: both reporting paths measure this card root.
		const report = () => untrack(() => {
			const body = bodyMeasurement(node);
			onBubbleMeasurement(id, body);
			onReplyFootprint(id, body.size);
			const surface = node.querySelector<SVGSVGElement>('.bubble-surface');
			const profile = node.querySelector<HTMLElement>('.trace-reply-author-profile');
			const profileClip = surface?.querySelector<SVGRectElement>('[data-reply-hit-area="profile"]');
			const contentClip = surface?.querySelector<SVGRectElement>('[data-reply-hit-area="content"]');
			if (surface && profile && profileClip && contentClip) {
				const viewBox = surface.viewBox.baseVal;
				const svgBox = surface.getBoundingClientRect();
				const profileBox = profile.getBoundingClientRect();
				const split = viewBox.x + ((profileBox.right - svgBox.left) / svgBox.width) * viewBox.width;
				profileClip.setAttribute('width', String(Math.max(0, split - viewBox.x)));
				contentClip.setAttribute('x', String(Math.min(viewBox.x + viewBox.width, split)));
				contentClip.setAttribute('width', String(Math.max(0, viewBox.x + viewBox.width - split)));
			}
		});
		const observer = new ResizeObserver(report);
		observer.observe(node);
		const content = node.querySelector<HTMLElement>('.bubble-content');
		if (content) observer.observe(content);
		const profile = node.querySelector<HTMLElement>('.trace-reply-author-profile');
		if (profile) observer.observe(profile);
		const surface = node.querySelector<SVGSVGElement>('.bubble-surface');
		if (surface) observer.observe(surface);
		const unregister = registerReplyRemeasure(id, report);
		report();
		return () => untrack(() => {
			unregister();
			observer.disconnect();
			const nextHitAreaState = { ...replyHitAreaStateById };
			delete nextHitAreaState[id];
			replyHitAreaStateById = nextHitAreaState;
			onBubbleMeasurementRemoved(id);
			onReplyFootprintRemoved(id);
		});
	});
</script>

{#if layout}
	{#each layout.cards as bubble (bubble.id)}
		<div
			{@attach observeReplyCard}
			class={`bubble bubble-normal trace-reply-card bubble-${bubble.tone} tone-${bubble.tone}${bubble.reply.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
			class:trace-presentation-pending={!ready}
			data-trace-reply-id={bubble.reply.id}
			data-trace-geometry-ready={ready ? 'ready' : 'pending'}
			data-trace-role={bubble.role}
			data-trace-current-reply-id={bubble.role === 'current' ? bubble.reply.id : undefined}
			data-trace-selection={showCurrentSelection && currentSpeechId === bubble.reply.id ? 'current' : undefined}
			class:trace-current-selected={showCurrentSelection && currentSpeechId === bubble.reply.id}
			data-trace-parent-id={bubble.role === 'parent' ? bubble.reply.id : undefined}
			data-speech-type={bubble.reply.speechType}
			data-bubble-id={bubble.id}
			style={`${bubbleToneStyle(bubble.tone, true)}; transform: translate3d(${bubble.anchor.x}px, ${bubble.anchor.y}px, 0);`}
		>
			{#if bubble.reply.speechType !== 'normal' && bubble.shape}
				<BubbleSurface bubbleId={bubble.id} shape={bubble.shape} variant="trace" speechType={bubble.reply.speechType} selected={showCurrentSelection && currentSpeechId === bubble.reply.id} replyHitAreaHover hoveredReplyHitArea={replyHitAreaStateById[bubble.id]?.pointer ?? replyHitAreaStateById[bubble.id]?.focus ?? null} />
			{/if}
			<button class="trace-reply-author-profile" data-trace-author-block type="button" aria-label={`${bubble.character.name} のプロフィールを開く`} onpointerenter={() => setReplyHitArea(bubble.id, 'pointer', 'profile', true)} onpointerleave={() => setReplyHitArea(bubble.id, 'pointer', 'profile', false)} onfocus={() => setReplyHitArea(bubble.id, 'focus', 'profile', true)} onblur={() => setReplyHitArea(bubble.id, 'focus', 'profile', false)} onclick={(event) => { event.stopPropagation(); onOpenProfile(bubble.character.characterId, bubble.reply.pubkey, event.currentTarget); }}>
				<span class="trace-reply-author-avatar"><CharacterAvatar class={`avatar avatar-${bubble.tone}`} character={bubble.character} /></span>
				<span class="trace-reply-author-name">{bubble.character.name}</span>
			</button>
			<button class="trace-reply-content-button" type="button" onpointerenter={() => setReplyHitArea(bubble.id, 'pointer', 'content', true)} onpointerleave={() => setReplyHitArea(bubble.id, 'pointer', 'content', false)} onfocus={() => setReplyHitArea(bubble.id, 'focus', 'content', true)} onblur={() => setReplyHitArea(bubble.id, 'focus', 'content', false)} onclick={(event) => { event.stopPropagation(); onSelectSpeech(bubble.reply.id); }}>
				<span class="bubble-content">{bubble.reply.content}</span>
				{#if bubbleOverflowById[bubble.id]}<span class="bubble-ellipsis" aria-hidden="true">…</span>{/if}
			</button>
		</div>
	{/each}
	{#key layout.root.id}
	<div class="trace-root-card" class:trace-presentation-pending={!ready} data-trace-geometry-ready={ready ? 'ready' : 'pending'} style={`transform: translate3d(${layout.root.anchor.x}px, ${layout.root.anchor.y}px, 0);`}>
		<button
			type="button"
			{@attach observeRootBubble}
			class={`bubble bubble-normal trace-root-bubble trace-current-bubble bubble-${layout.root.tone} tone-${layout.root.tone}${layout.root.event.speechType !== 'normal' ? ' speech-bubble-special' : ''}`}
			data-bubble-id={layout.root.id}
			data-trace-root-id={layout.root.event.id}
			data-trace-current-id={layout.root.event.id}
			data-trace-current-kind="root"
			data-trace-selection={showCurrentSelection && currentSpeechId === layout.root.event.id ? 'current' : undefined}
			class:trace-current-selected={showCurrentSelection && currentSpeechId === layout.root.event.id}
			data-speech-type={layout.root.event.speechType}
			style={bubbleToneStyle(layout.root.tone, true)}
			onclick={(event) => { event.stopPropagation(); onSelectSpeech(layout.root.event.id); }}
		>
			{#if layout.root.event.speechType === 'normal'}
				<NormalTraceRootSurface bubbleId={layout.root.id} size={layout.root.size} outlineOpening={rootOpening ? { id: `trace-root-${layout.root.event.id}`, points: rootOpening } : null} selected={showCurrentSelection && currentSpeechId === layout.root.event.id} />
			{:else if layout.root.shape}
				<BubbleSurface bubbleId={layout.root.id} shape={layout.root.shape} variant="trace" speechType={layout.root.event.speechType} outlineOpenings={rootOpening ? [{ id: `trace-root-${layout.root.event.id}`, points: rootOpening }] : []} selected={showCurrentSelection && currentSpeechId === layout.root.event.id} />
			{/if}
			<span class:trace-root-compact={layout.root.compact} class="bubble-content">{layout.root.event.content}</span>
			{#if bubbleOverflowById[layout.root.id]}<span class="bubble-ellipsis" aria-hidden="true">…</span>{/if}
		</button>
		{#if replyRefresh === 'unavailable'}
			<span class="trace-reply-status" data-reply-refresh="unavailable">
				Replies unavailable
			</span>
		{/if}
	</div>
	{/key}
{/if}

<style>
	.bubble { position: absolute; display: flex; align-items: center; justify-content: center; background: var(--tone-background); border: 1px solid var(--tone-outline); border-radius: 18px; color: #364142; font-size: 16px; font-weight: 800; letter-spacing: 0.02em; line-height: 1.35; text-align: center; will-change: transform; }
	.speech-bubble-special { background: transparent; border-color: transparent; border-radius: 0; }
	.speech-bubble-special.bubble-normal::after { content: none; }
	.bubble-content { position: relative; z-index: 1; min-width: 0; max-width: 100%; overflow: hidden; white-space: pre-line; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; text-align: left; user-select: text; -webkit-user-select: text; }
	.bubble-ellipsis { position: absolute; right: 8px; bottom: 5px; z-index: 2; padding-left: 0.5em; background: var(--tone-background); line-height: 1; pointer-events: none; }
	.bubble-normal { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); padding: 12px 15px; }
	.bubble-normal::after { content: ''; position: absolute; left: calc(50% + var(--tail-seam-offset-x, 0px)); bottom: -1px; width: 11px; height: 3px; transform: translateX(-50%); background: var(--tone-background); pointer-events: none; z-index: 1; }
	.trace-reply-card.bubble-normal::after { content: none; }
	.trace-root-bubble.bubble-normal::after { content: none; }
	.trace-root-bubble,
	.trace-reply-card { width: fit-content; min-width: 72px; max-width: min(240px, calc(100% - 32px)); padding: 12px 15px; border-style: dashed; background: var(--trace-surface); pointer-events: auto; }
	.trace-root-card,
	.trace-reply-card { position: absolute; pointer-events: auto; }
	.trace-presentation-pending { visibility: hidden; pointer-events: none; }
	.trace-root-card { z-index: 1; display: flex; }
	.trace-root-card .trace-root-bubble { position: relative; }
	.trace-root-bubble:not(.speech-bubble-special) { background: transparent; border-color: transparent; }
	.trace-reply-card { z-index: 2; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 0; align-items: stretch; min-width: 144px; padding: 0; }
	.trace-reply-card.trace-current-selected:not(.speech-bubble-special)::before { content: ''; position: absolute; inset: 0; z-index: 2; border: 2px solid var(--color-accent); border-radius: inherit; pointer-events: none; box-sizing: border-box; }
	.trace-reply-author-profile { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-self: stretch; padding: 12px 7px 12px 15px; gap: 3px; border: 0; border-radius: 17px 0 0 17px; background: transparent; color: #40504b; font-size: 12px; font-weight: 800; line-height: 1.1; text-align: center; cursor: pointer; transition: background-color 120ms ease; }
	.trace-reply-card:not(.speech-bubble-special) .trace-reply-author-profile::after { content: ''; position: absolute; top: 10%; right: 0; bottom: 10%; width: 1px; background: color-mix(in srgb, var(--tone-outline) 24%, var(--trace-surface)); opacity: 0.65; pointer-events: none; }
	.trace-reply-author-avatar { position: relative; display: block; order: -1; width: 36px; height: 36px; flex: 0 0 auto; }
	.trace-reply-author-avatar :global(.avatar) { width: 36px; height: 36px; }
	.trace-reply-author-name { display: block; max-width: 60px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.trace-reply-content-button { position: relative; z-index: 1; grid-column: 2; grid-row: 1; align-self: stretch; justify-self: stretch; min-width: 0; padding: 12px 15px 12px 7px; border: 0; border-radius: 0 17px 17px 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease; user-select: text; -webkit-user-select: text; }
	.trace-reply-author-profile:hover { background: color-mix(in srgb, var(--tone-outline) 12%, var(--trace-surface)); }
	.trace-reply-content-button:hover { background: color-mix(in srgb, var(--tone-outline) 12%, var(--trace-surface)); }
	.trace-reply-author-profile:focus-visible,
	.trace-reply-content-button:focus-visible,
	.trace-root-bubble:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	.trace-root-compact { -webkit-line-clamp: 1; line-clamp: 1; }
	.trace-root-bubble.speech-bubble-special,
	.trace-reply-card.speech-bubble-special { background: transparent; }
	.trace-reply-card.speech-bubble-special .trace-reply-author-profile,
	.trace-reply-card.speech-bubble-special .trace-reply-author-profile:hover,
	.trace-reply-card.speech-bubble-special .trace-reply-content-button,
	.trace-reply-card.speech-bubble-special .trace-reply-content-button:hover { border-radius: 0; background: transparent; }
	.trace-root-bubble .bubble-content,
	.trace-reply-card .bubble-content { color: #26312f; opacity: 1; }
	.trace-reply-status { position: absolute; top: calc(100% + 42px); left: 50%; width: max-content; max-width: 180px; padding: 2px 7px; border-radius: 999px; background: rgba(250, 250, 244, 0.88); color: #68736f; font-size: 9px; font-weight: 700; transform: translateX(-50%); }
	@media (max-width: 700px) {
		.bubble { font-size: 13px; }
		.bubble-normal,
		.trace-root-bubble,
		.trace-reply-card { min-width: 60px; max-width: min(180px, calc(100% - 32px)); padding: 8px 10px; }
		.trace-reply-card { min-width: 112px; padding: 0; }
		.trace-reply-author-profile { font-size: 10px; }
		.trace-reply-author-profile { padding: 8px 5px 8px 10px; }
		.trace-reply-content-button { padding: 8px 10px 8px 5px; }
		.trace-reply-author-avatar,
		.trace-reply-author-avatar :global(.avatar) { width: 28px; height: 28px; }
		.trace-reply-author-name { max-width: 48px; }
	}
</style>
