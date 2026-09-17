<script lang="ts">
	import { untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { Character } from '$lib/character';
import { requireWorldCharacterFromPubkey } from '$lib/worldCharacterAssignment';
	import { DEV_WORLD_SELF_ID, getDevWorldCharacter, getDevWorldFixtureCharacter } from '$lib/devWorldSandbox';
	import { MOBILE_FIELD_BREAKPOINT } from '$lib/geometry';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import type { RecentMessageTimeline } from '$lib/recentMessageTimeline';

	type Props = {
		messages: RecentMessageTimeline;
		tones: Readonly<Record<string, BubbleTone>>;
		selectedCharacterId: string;
		onOpenProfile: (characterId: string, trigger: HTMLButtonElement) => void;
		isDevWorldSandbox: boolean;
	};
	let { messages, tones, selectedCharacterId, onOpenProfile, isDevWorldSandbox }: Props = $props();
	let timelineOverflowById = $state.raw<Record<string, boolean>>({});
	let timelineEntryHeights = $state.raw<Record<string, number>>({});
	let timelineAvailableHeight = $state(0);
	let timelineInitialized = $state(false);
	let timelineOpen = $state(false);

	export function initialize(viewportWidth: number): void {
		if (timelineInitialized) return;
		timelineInitialized = true;
		timelineOpen = viewportWidth > MOBILE_FIELD_BREAKPOINT;
	}

	export function isInitialized(): boolean { return timelineInitialized; }
	export function toggle(): void { timelineOpen = !timelineOpen; }
	export function resetMeasurements(): void {
		timelineOverflowById = {};
		timelineEntryHeights = {};
		timelineAvailableHeight = 0;
	}

	function timelineCharacter(pubkey: string): Character {
		if (pubkey === DEV_WORLD_SELF_ID) return getDevWorldCharacter(selectedCharacterId);
		try {
			return requireWorldCharacterFromPubkey(pubkey);
		} catch (error) {
			if (isDevWorldSandbox) return getDevWorldFixtureCharacter(pubkey, selectedCharacterId);
			throw error;
		}
	}

	function timelineTone(pubkey: string): BubbleTone | null {
		return tones[pubkey] ?? null;
	}

	let timelineVisibleMessageCount = $derived.by(() => {
		let usedHeight = 0;
		let count = 0;
		for (const message of messages) {
			const height = timelineEntryHeights[message.id];
			if (height === undefined || usedHeight + height > timelineAvailableHeight + 1) break;
			usedHeight += height;
			count += 1;
		}
		return count;
	});
	let timelineVisibleMessages = $derived(messages.slice(0, timelineVisibleMessageCount));

	function showRecentMessageTimeline(): void {
		timelineOpen = true;
	}

	function hideRecentMessageTimeline(): void {
		timelineOpen = false;
	}

	const observeTimelineContent: Attachment<HTMLElement> = (node) => untrack(() => {
		const id = node.dataset.measurementId;
		if (!id) return;
		const update = () => untrack(() => {
			timelineOverflowById = {
				...timelineOverflowById,
				[id]: node.scrollHeight > node.clientHeight + 1
			};
		});
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return () => untrack(() => {
			observer.disconnect();
			const next = { ...timelineOverflowById };
			delete next[id];
			timelineOverflowById = next;
		});
	});

	const observeTimelineEntry: Attachment<HTMLElement> = (node) => untrack(() => {
		const id = node.dataset.measurementId;
		if (!id) return;
		const update = () => untrack(() => {
			const height = node.getBoundingClientRect().height;
			if (height <= 0) return;
				timelineEntryHeights = {
					...timelineEntryHeights,
					[id]: height
				};
		});
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return () => untrack(() => {
			observer.disconnect();
			const next = { ...timelineEntryHeights };
			delete next[id];
			timelineEntryHeights = next;
		});
	});

	const observeTimelineVisibleArea: Attachment<HTMLElement> = (node) => untrack(() => {
		const update = () => untrack(() => {
			timelineAvailableHeight = Math.max(0, node.clientHeight - 14);
		});
		const observer = new ResizeObserver(update);
		observer.observe(node);
		update();

		return () => untrack(() => {
			observer.disconnect();
			timelineAvailableHeight = 0;
		});
	});

</script>

{#if timelineInitialized && timelineOpen}
	<aside class={['recent-message-timeline', { 'timeline-has-messages': messages.length > 0 }]} aria-label="Chatter">
		<header class="timeline-header">
			<button
				class="timeline-hide-control"
				type="button"
				aria-label="Hide Chatter"
				aria-keyshortcuts="C"
				onclick={hideRecentMessageTimeline}
			>×</button>
			<h2>Chatter</h2>
		</header>
		<div class="timeline-visible-entries" {@attach observeTimelineVisibleArea}>
			{#each timelineVisibleMessages as message (message.id)}
				{const character = timelineCharacter(message.pubkey)}
				{const tone = timelineTone(message.pubkey)}
				<article
					class="timeline-entry"
					data-timeline-event-id={message.id}
					data-timeline-pubkey={message.pubkey}
					data-timeline-created-at={message.createdAt}
					data-timeline-tone={tone ?? 'default'}
				>
					<div class="timeline-content-shell">
						<div class="timeline-text" data-measurement-id={message.id} {@attach observeTimelineContent}>
							<button
								class={`timeline-name${tone ? ` tone-${tone}` : ''}`}
								type="button"
								aria-label={`${character.name} のプロフィールを開く`}
								onclick={(event) => onOpenProfile(character.characterId, event.currentTarget as HTMLButtonElement)}
							>{character.name}</button>
							<span class="timeline-content">{message.content}</span>
						</div>
						{#if timelineOverflowById[message.id]}
							<span class="timeline-ellipsis" aria-hidden="true">…</span>
						{/if}
					</div>
				</article>
			{/each}
		</div>
		<div class="timeline-measurements" aria-hidden="true">
			{#each messages as message (message.id)}
				{const character = timelineCharacter(message.pubkey)}
				{const tone = timelineTone(message.pubkey)}
				<article class="timeline-entry" data-measurement-id={message.id} {@attach observeTimelineEntry}>
					<div class="timeline-content-shell">
						<div class="timeline-text">
							<span class={`timeline-name${tone ? ` tone-${tone}` : ''}`}>{character.name}</span>
							<span class="timeline-content">{message.content}</span>
						</div>
					</div>
				</article>
			{/each}
		</div>
	</aside>
{:else if timelineInitialized}
	<button
		class="timeline-show-control"
		type="button"
		aria-label="Show Chatter"
		aria-keyshortcuts="C"
		onclick={showRecentMessageTimeline}
	>Chatter</button>
{/if}

<style>
	.recent-message-timeline {
		position: absolute;
		top: max(12px, env(safe-area-inset-top));
		left: max(12px, env(safe-area-inset-left));
		z-index: 9;
		display: flex;
		width: min(320px, calc(100% - 32px));
		max-height: min(380px, calc(100% - 24px));
		flex-direction: column;
		overflow: hidden;
		border: 1px solid rgba(132, 142, 255, 0.46);
		border-radius: 10px;
		background: linear-gradient(145deg, rgba(8, 15, 31, 0.84), rgba(14, 17, 39, 0.72));
		box-shadow: 0 0 16px rgba(80, 94, 255, 0.14), inset 0 0 14px rgba(96, 104, 220, 0.07);
		color: rgba(239, 241, 255, 0.9);
		pointer-events: auto;
	}

	.recent-message-timeline.timeline-has-messages {
		height: calc(100% - 24px);
		max-height: calc(100% - 24px);
	}

	.timeline-header {
		display: flex;
		align-items: center;
		justify-content: flex-start;
		padding: 9px 10px 8px;
		border-bottom: 1px solid rgba(132, 142, 255, 0.28);
		flex: 0 0 auto;
		gap: 12px;
	}

	.timeline-header h2 {
		margin: 0;
		color: #fff;
		font-size: 14px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		-webkit-text-stroke: 0;
		text-shadow: 0 0 8px rgba(143, 147, 255, 0.32);
	}

	.timeline-hide-control,
	.timeline-show-control {
		border: 1px solid rgba(132, 142, 255, 0.46);
		border-radius: 6px;
		background: rgba(22, 25, 58, 0.76);
		box-shadow: 0 0 9px rgba(92, 105, 255, 0.16);
		color: #e7e9ff;
		font-weight: 700;
	}

	.timeline-hide-control {
		display: grid;
		width: 44px;
		height: 44px;
		padding: 0;
		place-items: center;
		font-size: 24px;
		line-height: 1;
	}

	.timeline-visible-entries {
		flex: 1 1 auto;
		min-height: 0;
		padding: 0 10px 6px;
		overflow: visible;
	}

	.timeline-measurements {
		position: absolute;
		top: 0;
		right: 8px;
		left: 8px;
		visibility: hidden;
		pointer-events: none;
	}

	.timeline-entry:last-child { border-bottom: 0; }

	.timeline-name {
		user-select: text;
		-webkit-user-select: text;
		display: inline;
		max-width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		appearance: none;
		color: #fff;
		font-family: inherit;
		font-weight: 700;
		line-height: 1.45;
		margin-right: 0.35em;
		letter-spacing: 0.02em;
		text-align: left;
		cursor: pointer;
		vertical-align: top;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
	}

	.timeline-name.tone-coral { color: color-mix(in srgb, hsl(12, 96%, 42%) 70%, white 30%); }

	.timeline-name.tone-lavender { color: color-mix(in srgb, hsl(250, 72%, 42%) 70%, white 30%); }

	.timeline-name.tone-mint { color: color-mix(in srgb, hsl(145, 68%, 31%) 70%, white 30%); }

	.timeline-name.tone-yellow { color: color-mix(in srgb, hsl(48, 82%, 34%) 70%, white 30%); }

	.timeline-name.tone-sky { color: color-mix(in srgb, hsl(188, 72%, 32%) 70%, white 30%); }

	.timeline-name.tone-peach { color: color-mix(in srgb, hsl(28, 82%, 38%) 70%, white 30%); }

	.timeline-name.tone-rose { color: color-mix(in srgb, hsl(340, 72%, 40%) 70%, white 30%); }

	.timeline-name.tone-blue { color: color-mix(in srgb, hsl(210, 72%, 37%) 70%, white 30%); }

	.timeline-name:hover,
	.timeline-name:focus-visible {
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.18);
	}

	.timeline-content-shell {
		position: relative;
		min-width: 0;
	}

	.timeline-text {
		max-height: calc(1.45em * 5);
		overflow: hidden;
		color: rgba(239, 241, 255, 0.9);
		font-size: 16px;
		letter-spacing: 0.01em;
		line-height: 1.45;
		padding: 6px 0;
		overflow-wrap: anywhere;
		white-space: pre-line;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);

	 @media (width <= 700px) {
			font-size: 14px;
		}
	}

	.timeline-content {
		display: inline;
		color: inherit;
		font: inherit;
	}

	.timeline-ellipsis {
		position: absolute;
		right: 0;
		bottom: 0;
		padding-left: 0.35em;
		background: transparent;
		color: #fff;
		font-size: 13px;
		font-weight: 700;
		line-height: 1.45;
		-webkit-text-stroke: 0;
		text-shadow: 0 1px 1px rgba(0, 0, 0, 0.9);
	}

	.timeline-show-control {
		position: absolute;
		top: max(12px, env(safe-area-inset-top));
		left: max(12px, env(safe-area-inset-left));
		z-index: 9;
		min-height: 44px;
		padding: 0 12px;
		font-size: 14px;
		letter-spacing: 0.03em;
		pointer-events: auto;
	}

	.timeline-hide-control:focus-visible,
	.timeline-name:focus-visible,
	.timeline-show-control:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 2px;
	}
</style>
