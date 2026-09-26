<script lang="ts">
	import X from '~icons/tabler/x';
	import Sparkles2 from '~icons/tabler/sparkles-2';
	import { Tooltip } from 'bits-ui';
	import { onMount } from 'svelte';
	import ActionButton from '$lib/ActionButton.svelte';
	import type { Character } from '$lib/character';
	import type { SpeechType } from '$lib/conversation';
	import {
		createSpeechSuggestionService,
		type SpeechSuggestionAvailability,
		type SpeechSuggestionConversationEntry,
		type SpeechSuggestionProgress
	} from '$lib/speechSuggestions';

	type Props = {
		character: Pick<Character, 'name' | 'about'>;
		speechType: SpeechType;
		conversation: readonly SpeechSuggestionConversationEntry[];
		editorIsEmpty: boolean | null;
		submissionInProgress: boolean;
		applyContentIfEmpty: (content: string) => Promise<boolean>;
		submitCandidate: (content: string, signal: AbortSignal) => Promise<Readonly<{ eventId: string }>>;
	};

	let { character, speechType, conversation, editorIsEmpty, submissionInProgress, applyContentIfEmpty, submitCandidate }: Props = $props();
	let availability = $state<SpeechSuggestionAvailability>('unsupported');
	let candidates = $state<readonly string[]>([]);
	let progress = $state(0);
	let generating = $state(false);
	let panelOpen = $state(false);
	let error = $state<Readonly<{ kind: 'generation' | 'operation'; message: string }> | null>(null);
	let abortController: AbortController | null = null;
	let directSubmitController: AbortController | null = null;
	let sendingCandidate = $state<string | null>(null);
	let addingCandidate = $state<string | null>(null);
	const service = createSpeechSuggestionService();
	let busy = $derived(generating || submissionInProgress || sendingCandidate !== null || addingCandidate !== null);

	$effect(() => {
		if (editorIsEmpty !== true) {
			if (error?.kind === 'operation') error = null;
			if (candidates.length > 0) {
				candidates = [];
				panelOpen = false;
			}
		}
	});

	function availabilityLabel(value: SpeechSuggestionAvailability): string {
		if (value === 'downloadable' || value === 'downloading') return `モデル準備中 ${Math.round(progress * 100)}%`;
		return '候補を生成';
	}

	function handleProgress(next: SpeechSuggestionProgress): void {
		progress = next.progress;
		availability = next.availability;
	}

	async function generate(): Promise<void> {
		if (busy || editorIsEmpty !== true) return;
		generating = true;
		error = null;
		candidates = [];
		panelOpen = false;
		progress = 0;
		abortController?.abort();
		abortController = new AbortController();
		try {
			candidates = await service.generate({ character, speechType, conversation }, {
				signal: abortController.signal,
				onProgress: handleProgress
			});
			availability = 'available';
			panelOpen = true;
		} catch (cause) {
			if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
				error = { kind: 'generation', message: '候補を生成できませんでした。もう一度お試しください。' };
				const current = await service.availability().catch(() => 'unsupported' as const);
				availability = current;
			}
		} finally {
			generating = false;
			abortController = null;
		}
	}

	async function addCandidate(candidate: string): Promise<void> {
		if (busy || editorIsEmpty !== true) return;
		addingCandidate = candidate;
		try {
			const applied = await applyContentIfEmpty(candidate);
			if (!applied) {
				error = { kind: 'operation', message: '本文が入力されているため候補を追加できません。' };
				return;
			}
			candidates = [];
			panelOpen = false;
			error = null;
		} catch {
			error = { kind: 'operation', message: '候補をコンポーザーに追加できませんでした。' };
		} finally {
			addingCandidate = null;
		}
	}

	async function sendCandidate(candidate: string): Promise<void> {
		if (busy || editorIsEmpty !== true) return;
		sendingCandidate = candidate;
		directSubmitController?.abort();
		directSubmitController = new AbortController();
		try {
			await submitCandidate(candidate, directSubmitController.signal);
			candidates = [];
			panelOpen = false;
			error = null;
		} catch (cause) {
			if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
				error = { kind: 'operation', message: '候補を送信できませんでした。もう一度お試しください。' };
			}
		} finally {
			sendingCandidate = null;
			directSubmitController = null;
		}
	}

	function closePanel(): void {
		panelOpen = false;
		if (error?.kind === 'operation') error = null;
	}

	onMount(() => {
		let disposed = false;
		void service.availability().then((next) => {
			if (!disposed) availability = next;
		}).catch(() => {
			if (!disposed) availability = 'unsupported';
		});
		return () => {
			disposed = true;
			abortController?.abort();
			directSubmitController?.abort();
			service.dispose();
		};
	});
</script>

{#if availability !== 'unsupported' && availability !== 'unavailable'}
	<div class="suggestions-anchor">
		<Tooltip.Root>
			<Tooltip.Trigger tabindex={-1}>
				{#snippet child({ props })}
					<span class="suggestions-tooltip-trigger" {...props}>
						<button
							class="suggestions-toggle"
							type="button"
							aria-label="AI発言候補を生成"
							disabled={busy || editorIsEmpty !== true}
							onclick={() => void generate()}
						>
							<span class="suggestions-toggle-icon" aria-hidden="true"><Sparkles2 /></span>
						</button>
					</span>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content role="tooltip" class="action-dock-tooltip" side="top" sideOffset={8}>AI発言候補を生成</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
		{#if panelOpen && candidates.length > 0}
			<div class="suggestion-panel" aria-label="発言候補">
				<div class="suggestion-header">
					<p class="suggestion-heading">発言候補</p>
					<ActionButton
						variant="tertiary"
						class="suggestion-close"
						type="button"
						aria-label="発言候補を閉じる"
						title="発言候補を閉じる"
						onclick={closePanel}
					><X aria-hidden="true" /></ActionButton>
				</div>
				{#if error?.kind === 'operation'}
					<p class="suggestion-status suggestion-error" role="status">{error.message}</p>
				{/if}
				{#each candidates as candidate, index}
					<div class="suggestion-item">
						<button
							class="suggestion-primary"
							type="button"
							disabled={busy || editorIsEmpty !== true}
							aria-label={`候補${index + 1}: ${candidate} をそのまま送信`}
							title="候補本文をそのまま送信"
							onclick={() => void sendCandidate(candidate)}
						>
							<span class="suggestion-index" aria-hidden="true">{index + 1}</span>
							<span class="suggestion-content">{candidate}</span>
						</button>
						<ActionButton
							variant="secondary"
							class="suggestion-secondary"
							type="button"
							disabled={busy || editorIsEmpty !== true}
							aria-label={`候補${index + 1}をコンポーザーに追加`}
							title="コンポーザーに追加"
							onclick={() => void addCandidate(candidate)}
						>追加</ActionButton>
					</div>
				{/each}
			</div>
		{/if}
		{#if generating && (availability === 'downloadable' || availability === 'downloading')}
			<p class="suggestion-status" role="status">{availabilityLabel(availability)}</p>
		{:else if generating}
			<p class="suggestion-status" role="status">候補を生成中…</p>
		{:else if error?.kind === 'generation' && !(panelOpen && candidates.length > 0)}
			<p class="suggestion-status suggestion-error" role="status">{error.message}</p>
		{/if}
	</div>
{/if}

<style>
	.suggestions-anchor {
		position: relative;
		flex: 0 0 54px;
		min-width: 0;
		min-height: 0;
	}

	.suggestions-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0;
		border: 1px solid var(--action-icon-border);
		border-radius: 12px;
		background: var(--action-icon-background);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1);
		color: var(--action-icon-foreground);
		font-size: 10px;
		font-weight: 800;
		line-height: 1.15;
	}
	.suggestions-tooltip-trigger { display: block; width: 100%; height: 100%; }
	.suggestions-toggle-icon { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; }
	.suggestions-toggle-icon :global(svg) { width: 24px; height: 24px; }
	.suggestions-toggle:hover:not(:disabled) { background: var(--action-icon-background-hover); }
	.suggestions-toggle:active:not(:disabled) { background: var(--action-icon-background-active); }

	.suggestions-toggle:disabled { border-color: var(--action-disabled-border); background: var(--action-disabled-background); color: var(--action-disabled-foreground); cursor: wait; }
	.suggestions-toggle:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }

	.suggestion-panel {
		position: absolute;
		bottom: calc(100% + 8px);
		left: auto;
		right: 0;
		z-index: 2;
		display: grid;
		width: min(420px, calc(100vw - 32px));
		gap: 6px;
		padding: 8px;
		border: 1px solid rgba(57, 67, 64, 0.18);
		border-radius: 12px;
		background: rgba(255, 253, 246, 0.98);
		box-shadow: 0 8px 24px rgba(58, 70, 61, 0.18);
	}

	.suggestion-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.suggestion-heading { margin: 0 2px 2px; color: #59635e; font-size: 11px; font-weight: 800; }
	.suggestion-panel :global(.suggestion-close) {
		flex: 0 0 44px;
		width: 44px;
		height: 44px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.suggestion-panel :global(.suggestion-close) :global(svg) { width: 24px; height: 24px; }
	.suggestion-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		width: 100%;
	}
	.suggestion-primary {
		display: flex;
		min-width: 0;
		gap: 8px;
		align-items: flex-start;
		padding: 8px;
		border: 1px solid rgba(57, 67, 64, 0.14);
		border-radius: 8px;
		background: #fff;
		color: #303936;
		font: inherit;
		font-size: 12px;
		font-weight: 700;
		line-height: 1.35;
		text-align: left;
	}
	.suggestion-primary:hover:not(:disabled) { background: #f1f6ef; }
	.suggestion-primary:disabled,
	.suggestion-secondary:disabled { cursor: not-allowed; opacity: 0.58; }
	.suggestion-primary:focus-visible,
	.suggestion-secondary:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 1px; }
	.suggestion-panel :global(.suggestion-secondary) {
		align-self: stretch;
		min-width: 48px;
		padding: 6px 8px;
		font: inherit;
		font-size: 11px;
		font-weight: 800;
	}
	.suggestion-content { min-width: 0; overflow-wrap: anywhere; }
	.suggestion-index { flex: 0 0 18px; color: #728379; font-weight: 800; text-align: center; }
	.suggestion-status {
		position: absolute;
		bottom: calc(100% + 8px);
		left: auto;
		right: 0;
		width: max-content;
		max-width: min(300px, calc(100vw - 32px));
		margin: 0;
		padding: 7px 9px;
		border-radius: 8px;
		background: rgba(50, 56, 52, 0.94);
		color: #fffdf2;
		font-size: 11px;
		font-weight: 700;
	}
	.suggestion-panel > .suggestion-error {
		position: static;
		width: auto;
		max-width: 100%;
		box-sizing: border-box;
		background: rgba(141, 72, 58, 0.94);
	}
	@media (max-width: 700px) {
		.suggestions-anchor { position: static; }
		.suggestion-panel { right: 16px; left: auto; }
		.suggestion-status { right: 16px; left: auto; }
	}
</style>
