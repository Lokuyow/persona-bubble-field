<script lang="ts">
	import { onMount } from 'svelte';
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
	let error = $state<string | null>(null);
	let abortController: AbortController | null = null;
	let directSubmitController: AbortController | null = null;
	let sendingCandidate = $state<string | null>(null);
	let addingCandidate = $state<string | null>(null);
	const service = createSpeechSuggestionService();
	let busy = $derived(generating || submissionInProgress || sendingCandidate !== null || addingCandidate !== null);

	$effect(() => {
		if (editorIsEmpty !== true && candidates.length > 0) {
			candidates = [];
			panelOpen = false;
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
				error = '候補を生成できませんでした。もう一度お試しください。';
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
				error = '本文が入力されているため候補を追加できません。';
				return;
			}
			candidates = [];
			panelOpen = false;
			error = null;
		} catch {
			error = '候補をコンポーザーに追加できませんでした。';
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
				error = '候補を送信できませんでした。もう一度お試しください。';
			}
		} finally {
			sendingCandidate = null;
			directSubmitController = null;
		}
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
		<button
			class="suggestions-toggle"
			type="button"
			aria-label="AI発言候補を生成"
			title={editorIsEmpty === true ? '現在の会話から発言候補を生成' : '本文が空のときだけ候補を生成できます'}
			disabled={busy || editorIsEmpty !== true}
			onclick={() => void generate()}
		>
			<span aria-hidden="true">{generating ? '…' : '候補'}</span>
		</button>
		{#if panelOpen && candidates.length > 0}
			<div class="suggestion-panel" aria-label="発言候補">
				<p class="suggestion-heading">発言候補</p>
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
						<button
							class="suggestion-secondary"
							type="button"
							disabled={busy || editorIsEmpty !== true}
							aria-label={`候補${index + 1}をコンポーザーに追加`}
							title="コンポーザーに追加"
							onclick={() => void addCandidate(candidate)}
						>追加</button>
					</div>
				{/each}
			</div>
		{/if}
		{#if generating && (availability === 'downloadable' || availability === 'downloading')}
			<p class="suggestion-status" role="status">{availabilityLabel(availability)}</p>
		{:else if generating}
			<p class="suggestion-status" role="status">候補を生成中…</p>
		{:else if error}
			<p class="suggestion-status suggestion-error" role="status">{error}</p>
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
		width: 100%;
		height: 100%;
		min-height: 0;
		padding: 0 4px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1);
		color: #3f4a47;
		font-size: 10px;
		font-weight: 800;
		line-height: 1.15;
	}

	.suggestions-toggle:disabled { cursor: wait; opacity: 0.58; }
	.suggestions-toggle:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }

	.suggestion-panel {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
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

	.suggestion-heading { margin: 0 2px 2px; color: #59635e; font-size: 11px; font-weight: 800; }
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
	.suggestion-secondary {
		align-self: stretch;
		min-width: 48px;
		padding: 6px 8px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 8px;
		background: rgba(245, 241, 233, 0.9);
		color: #59635e;
		font: inherit;
		font-size: 11px;
		font-weight: 800;
	}
	.suggestion-secondary:hover:not(:disabled) { background: #e9f0e7; }
	.suggestion-content { min-width: 0; overflow-wrap: anywhere; }
	.suggestion-index { flex: 0 0 18px; color: #728379; font-weight: 800; text-align: center; }
	.suggestion-status {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 0;
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
	.suggestion-error { background: rgba(141, 72, 58, 0.94); }
</style>
