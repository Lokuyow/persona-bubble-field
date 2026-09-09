<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
	import SpeechSuggestions from '$lib/frontend/SpeechSuggestions.svelte';
	import type { SpeechType } from '$lib/conversation';
	import type { Character } from '$lib/character';
	import type { SpeechSuggestionConversationEntry } from '$lib/speechSuggestions';

	type Props = ComponentProps<typeof HostOwnedComposerLite> & {
		selectedSpeechType: SpeechType;
		submissionInProgress: boolean;
		hasUnreadReplies: boolean;
		character: Pick<Character, 'name' | 'about'>;
		suggestionConversation: readonly SpeechSuggestionConversationEntry[];
		onSpeechTypeChange: (next: SpeechType) => void;
	};
	let { selectedSpeechType, submissionInProgress, onSpeechTypeChange, submitContent,
		desiredContext, loadPreview, onPreviewClear, onEditorEmptyChange, onPreferredHeightChange,
		hasUnreadReplies, character, suggestionConversation }: Props = $props();
	let composerComponent: { focusEditor(): boolean; blurEditor(): boolean; applyContentIfEmpty(content: string): Promise<boolean> } | null = null;
	let editorIsEmpty = $state<boolean | null>(null);
	let explanationVisible = $state(false);

	$effect(() => {
		if (!hasUnreadReplies) explanationVisible = false;
	});

	const SPEECH_TYPE_ORDER: readonly SpeechType[] = ['normal', 'shout', 'monologue'];
	const SPEECH_TYPE_LABELS: Readonly<Record<SpeechType, string>> = {
		normal: '通常',
		shout: '叫び',
		monologue: 'モノローグ'
	};

	export function focusEditor(): boolean { return composerComponent?.focusEditor() ?? false; }
	export function blurEditor(): boolean { return composerComponent?.blurEditor() ?? false; }
	export function applyContentIfEmpty(content: string): Promise<boolean> {
		return composerComponent?.applyContentIfEmpty(content) ?? Promise.resolve(false);
	}

	function nextSpeechType(speechType: SpeechType): SpeechType {
		const index = SPEECH_TYPE_ORDER.indexOf(speechType);
		return SPEECH_TYPE_ORDER[(index + 1) % SPEECH_TYPE_ORDER.length];
	}

	function cycleSpeechType(): void {
		if (submissionInProgress) return;
		onSpeechTypeChange(nextSpeechType(selectedSpeechType));
	}

	function handleEditorEmptyChange(isEmpty: boolean | null): void {
		editorIsEmpty = isEmpty;
		onEditorEmptyChange?.(isEmpty);
	}

</script>

<div class="composer-dock" aria-label="Message composer">
	<div class="composer-dock-content">
		<button
			class="speech-type-toggle"
			type="button"
			data-speech-type={selectedSpeechType}
			aria-label={`発言タイプ: ${SPEECH_TYPE_LABELS[selectedSpeechType]}（クリックで${SPEECH_TYPE_LABELS[nextSpeechType(selectedSpeechType)]}へ）`}
			title={`発言タイプ: ${SPEECH_TYPE_LABELS[selectedSpeechType]}。クリックで${SPEECH_TYPE_LABELS[nextSpeechType(selectedSpeechType)]}へ`}
			disabled={submissionInProgress}
			onclick={cycleSpeechType}
		>
			<span aria-hidden="true">{SPEECH_TYPE_LABELS[selectedSpeechType]}</span>
		</button>
		<SpeechSuggestions
			{character}
			speechType={selectedSpeechType}
			conversation={suggestionConversation}
			editorIsEmpty={editorIsEmpty}
			{submissionInProgress}
			applyContentIfEmpty={(content) => composerComponent?.applyContentIfEmpty(content) ?? Promise.resolve(false)}
		/>
		{#if hasUnreadReplies}
			<button
				class="trace-unread-indicator"
				class:explanation-visible={explanationVisible}
				type="button"
				aria-label="あなたへの返信の痕跡があります"
				onclick={() => { explanationVisible = !explanationVisible; }}
			>
				<span aria-hidden="true">●</span>
				{#if explanationVisible}
					<span class="trace-unread-explanation" role="status">どこかにあなたへの返信の痕跡があります</span>
				{/if}
			</button>
		{/if}
		<div class="composer-editor-slot">
			<HostOwnedComposerLite
				bind:this={composerComponent}
				{submitContent}
				{desiredContext}
				{loadPreview}
				{onPreviewClear}
				onEditorEmptyChange={handleEditorEmptyChange}
				{onPreferredHeightChange}
			/>
		</div>
	</div>
</div>

<style>
	.composer-dock {
		position: fixed;
		bottom: var(--composer-keyboard-inset);
		left: 0;
		right: 0;
		z-index: 12;
		height: var(--composer-dock-visible-height, var(--composer-dock-height));
		padding: var(--composer-dock-padding-block) 16px
			calc(var(--composer-dock-padding-block) + env(safe-area-inset-bottom));
		border-top: var(--composer-dock-border-width) solid rgba(57, 67, 64, 0.14);
		background: rgba(245, 241, 233, 0.98);
	}

	:global(.composer-keyboard-visible) .composer-dock {
		--composer-dock-visible-height: calc(var(--composer-dock-height) - env(safe-area-inset-bottom));
		padding-bottom: var(--composer-dock-padding-block);
	}

	.composer-dock-content {
		display: flex;
		width: min(720px, 100%);
		height: 100%;
		align-items: stretch;
		gap: 8px;
		margin: 0 auto;
		min-width: 0;
	}

	.speech-type-toggle {
		flex: 0 0 54px;
		min-width: 0;
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
		white-space: normal;
	}

	.trace-unread-indicator {
		position: relative;
		flex: 0 0 34px;
		min-width: 0;
		min-height: 0;
		padding: 0;
		border: 1px solid rgba(169, 93, 73, 0.46);
		border-radius: 10px;
		background: rgba(255, 244, 232, 0.94);
		color: #b45c48;
		font-size: 14px;
		cursor: pointer;
	}

	.trace-unread-explanation {
		position: absolute;
		left: 50%;
		bottom: calc(100% + 8px);
		width: max-content;
		max-width: 230px;
		padding: 6px 8px;
		border: 1px solid rgba(82, 77, 68, 0.18);
		border-radius: 8px;
		background: rgba(50, 56, 52, 0.94);
		color: #fffdf2;
		font-size: 11px;
		font-weight: 700;
		line-height: 1.3;
		pointer-events: none;
	}

	.speech-type-toggle:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.98);
	}

	.speech-type-toggle:disabled {
		cursor: wait;
		opacity: 0.58;
	}

	.speech-type-toggle:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	.composer-editor-slot {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.composer-dock-content :global(.host-owned-composer) {
		width: 100%;
		height: 100%;
		min-width: 0;
	}
</style>
