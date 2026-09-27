<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import SpeechMonologue from '~icons/hako/speech-monologue';
	import SpeechNormal from '~icons/hako/speech-normal';
	import SpeechShout from '~icons/hako/speech-shout';
	import LayoutSidebarLeftCollapse from '~icons/tabler/layout-sidebar-left-collapse';
	import LayoutSidebarLeftExpand from '~icons/tabler/layout-sidebar-left-expand';
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
	import CharacterAvatar from '$lib/CharacterAvatar.svelte';
	import SpeechSuggestions from '$lib/frontend/SpeechSuggestions.svelte';
	import SoundControl from '$lib/frontend/SoundControl.svelte';
	import type { SpeechType } from '$lib/conversation';
	import type { Character } from '$lib/character';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import type { SpeechSuggestionConversationEntry } from '$lib/speechSuggestions';
	import { Popover, Tooltip } from 'bits-ui';
	import { onMount } from 'svelte';

	type Props = ComponentProps<typeof HostOwnedComposerLite> & {
		selectedSpeechType: SpeechType;
		submissionInProgress: boolean;
		volume: number;
		onSoundOpen: () => void;
		onVolume: (volume: number) => void;
		hasUnreadReplies: boolean;
		character: Character;
		avatarTone: BubbleTone;
		canOpenSelfProfile: boolean;
		suggestionConversation: readonly SpeechSuggestionConversationEntry[];
		chatterOpen: boolean;
		onToggleChatter: () => void;
		onSpeechTypeChange: (next: SpeechType) => void;
		onOpenSelfProfile: (trigger: HTMLButtonElement) => void;
		submitCandidate: (content: string, signal: AbortSignal) => Promise<Readonly<{ eventId: string }>>;
	};
	let { selectedSpeechType, submissionInProgress, volume, onSoundOpen, onVolume, onSpeechTypeChange, onOpenSelfProfile, submitContent, submitCandidate,
		desiredContext, loadPreview, onPreviewClear, onEditorEmptyChange, onPreferredHeightChange,
		 hasUnreadReplies, character, avatarTone, suggestionConversation, canOpenSelfProfile, chatterOpen, onToggleChatter }: Props = $props();
	let composerComponent: { focusEditor(): boolean; blurEditor(): boolean; applyContentIfEmpty(content: string): Promise<boolean> } | null = null;
	let editorIsEmpty = $state<boolean | null>(null);
	let explanationVisible = $state(false);
	let tooltipsDisabled = $state(true);

	function handleUnreadPopoverOutside(event: PointerEvent): void {
		if (!explanationVisible) return;
		const interactedWithPopover = event.composedPath().some((target) =>
			target instanceof Element && Boolean(target.closest('.trace-unread-indicator, .trace-unread-explanation'))
		);
		if (!interactedWithPopover) explanationVisible = false;
	}

	onMount(() => {
		const hoverCapability = window.matchMedia('(hover: hover) and (pointer: fine)');
		const updateTooltipAvailability = (): void => { tooltipsDisabled = !hoverCapability.matches; };
		updateTooltipAvailability();
		hoverCapability.addEventListener('change', updateTooltipAvailability);
		document.addEventListener('pointerdown', handleUnreadPopoverOutside, true);
		return () => {
			hoverCapability.removeEventListener('change', updateTooltipAvailability);
			document.removeEventListener('pointerdown', handleUnreadPopoverOutside, true);
		};
	});

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

	<div class="action-dock" aria-label="主要操作">
	<div class="action-dock-content">
		<Tooltip.Provider disabled={tooltipsDisabled} delayDuration={400} skipDelayDuration={100} disableHoverableContent>
		<div class="composer-controls-left">
		{#if canOpenSelfProfile}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<button {...props} class="profile-trigger" type="button" aria-label="自分のプロフィールを開く" onclick={(event) => onOpenSelfProfile(event.currentTarget)}>
						<span class="profile-trigger-avatar" aria-hidden="true"><CharacterAvatar class={`avatar avatar-${avatarTone} profile-trigger-character-avatar`} {character} /></span>
					</button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content role="tooltip" class="action-dock-tooltip" side="top" sideOffset={8}>自分のプロフィール</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
		{/if}
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class={['chatter-toggle', { 'action-selected': chatterOpen }]}
						type="button"
						aria-label={chatterOpen ? 'Chatterを閉じる' : 'Chatterを開く'}
						aria-pressed={chatterOpen}
						aria-keyshortcuts="C"
						onclick={onToggleChatter}
					>
						<span class="chatter-toggle-icon" data-chatter-icon={chatterOpen ? 'layout-sidebar-left-collapse' : 'layout-sidebar-left-expand'} aria-hidden="true">
							{#if chatterOpen}<LayoutSidebarLeftCollapse />{:else}<LayoutSidebarLeftExpand />{/if}
						</span>
					</button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content role="tooltip" class="action-dock-tooltip" side="top" sideOffset={8}>{chatterOpen ? 'Chatterを閉じる' : 'Chatterを開く'}</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
		{#if hasUnreadReplies}
			<Popover.Root bind:open={explanationVisible}>
				<Popover.Trigger>
					{#snippet child({ props })}
						<button {...props} class="trace-unread-indicator" type="button" aria-label="あなたへの返信の痕跡があります">
							<span aria-hidden="true">●</span>
						</button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content
						side="top"
						align="center"
						sideOffset={8}
						avoidCollisions
						collisionPadding={{ top: 16, right: 16, bottom: 16, left: 16 }}
						onInteractOutside={() => { explanationVisible = false; }}
					>
						{#snippet child({ wrapperProps, props })}
							<div {...wrapperProps}>
								<div {...props} class="trace-unread-explanation" role="status">
									どこかにあなたへの返信の痕跡があります
								</div>
							</div>
						{/snippet}
					</Popover.Content>
				</Popover.Portal>
			</Popover.Root>
		{/if}
		<SoundControl {volume} onOpen={onSoundOpen} onVolume={onVolume} />
		</div>
		<div class="composer-controls-right">
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class="speech-type-toggle"
						type="button"
						data-speech-type={selectedSpeechType}
						aria-label={`発言タイプ: ${SPEECH_TYPE_LABELS[selectedSpeechType]}（クリックで${SPEECH_TYPE_LABELS[nextSpeechType(selectedSpeechType)]}へ）`}
						disabled={submissionInProgress}
						onclick={cycleSpeechType}
					>
						<span class="speech-type-icon" data-speech-icon={selectedSpeechType} aria-hidden="true">
							{#if selectedSpeechType === 'normal'}
								<SpeechNormal />
							{:else if selectedSpeechType === 'shout'}
								<SpeechShout />
							{:else}
								<SpeechMonologue />
							{/if}
						</span>
					</button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content role="tooltip" class="action-dock-tooltip" side="top" sideOffset={8}>発言タイプ：{SPEECH_TYPE_LABELS[selectedSpeechType]}</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
		<SpeechSuggestions
			{character}
			speechType={selectedSpeechType}
			conversation={suggestionConversation}
			editorIsEmpty={editorIsEmpty}
			{submissionInProgress}
			applyContentIfEmpty={(content) => composerComponent?.applyContentIfEmpty(content) ?? Promise.resolve(false)}
			{submitCandidate}
		/>
		</div>
		</Tooltip.Provider>
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
	.action-dock {
		position: fixed;
		bottom: var(--composer-keyboard-inset);
		left: 0;
		right: 0;
		z-index: 12;
		height: var(--action-dock-visible-height, var(--action-dock-height));
		padding: var(--action-dock-padding-block) 16px
			calc(var(--action-dock-padding-block) + env(safe-area-inset-bottom));
		border-top: var(--action-dock-border-width) solid rgba(57, 67, 64, 0.14);
		background: rgba(245, 241, 233, 0.98);
	}

	:global(.action-dock-keyboard-visible) .action-dock {
		--action-dock-visible-height: calc(var(--action-dock-height) - env(safe-area-inset-bottom));
		padding-bottom: var(--action-dock-padding-block);
	}

	.action-dock-content {
		display: flex;
		width: min(1120px, 100%);
		height: 100%;
		align-items: stretch;
		gap: 8px;
		margin: 0 auto;
		min-width: 0;
	}

	.profile-trigger { flex: 0 0 54px; width: 54px; min-width: 44px; min-height: 44px; height: 54px; padding: 3px; border: 1px solid var(--action-icon-border); border-radius: 12px; background: var(--action-icon-background); box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1); cursor: pointer; overflow: hidden; }
	.profile-trigger-avatar { display: block; position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: 8px; background: transparent; }
	:global(.profile-trigger-character-avatar) { position: absolute; inset: 0; width: 100%; height: 100%; border: 2px solid rgba(255, 255, 255, 0.88); border-radius: 42% 58% 48% 52%; box-shadow: 0 5px 10px rgba(58, 70, 61, 0.16); transform: none; }
	:global(.profile-trigger-character-avatar img) { display: block; width: 100%; height: 100%; object-fit: contain; object-position: center; transform: scale(1.12); transform-origin: center; }
	:global(.action-dock-tooltip) { z-index: 30; padding: 5px 8px; border: 1px solid rgba(82, 77, 68, 0.24); border-radius: 6px; background: rgba(50, 56, 52, 0.96); color: #fffdf2; font-size: 11px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
	.profile-trigger:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	.composer-controls-left, .composer-controls-right { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.composer-controls-left { grid-column: 1; }
	.composer-controls-right { grid-column: 3; }
	.composer-editor-slot { grid-column: 2; }
	.composer-controls-right :global(.suggestions-anchor) { height: 54px; }
	.chatter-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 54px;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		border: 1px solid var(--action-icon-border);
		border-radius: 12px;
		background: var(--action-icon-background);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1);
		color: var(--action-icon-foreground);
		font-weight: 800;
		cursor: pointer;
	}
	.chatter-toggle[aria-pressed='false']:hover:not(:disabled) { background: var(--action-icon-background-hover); }
	.chatter-toggle[aria-pressed='false']:active:not(:disabled) { background: var(--action-icon-background-active); }
	.profile-trigger:hover, .speech-type-toggle:hover:not(:disabled) { background: var(--action-icon-background-hover); }
	.profile-trigger:active, .speech-type-toggle:active:not(:disabled) { background: var(--action-icon-background-active); }
	.chatter-toggle-icon { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; }
	.chatter-toggle-icon :global(svg) { width: 24px; height: 24px; }
	.chatter-toggle:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }

	.speech-type-toggle {
		flex: 0 0 54px;
		min-width: 44px;
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0 4px;
		border: 1px solid var(--action-icon-border);
		border-radius: 12px;
		background: var(--action-icon-background);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1);
		color: var(--action-icon-foreground);
		font-size: 10px;
		font-weight: 800;
		line-height: 1.15;
		white-space: normal;
	}

	.speech-type-icon {
		display: inline-flex;
		width: 24px;
		height: 24px;
		align-items: center;
		justify-content: center;
	}

	.speech-type-icon :global(svg) {
		width: 24px;
		height: 24px;
	}

	.trace-unread-indicator {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 54px;
		min-width: 44px;
		min-height: 44px;
		padding: 0;
		border: 1px solid var(--action-notification-border);
		border-radius: 10px;
		background: var(--action-notification-background);
		color: var(--action-notification-foreground);
		font-size: 14px;
		cursor: pointer;
	}
	.trace-unread-indicator:hover { background: var(--action-notification-background-hover); }
	.trace-unread-indicator:active { background: var(--action-notification-background-active); }

	.trace-unread-explanation {
		z-index: 40;
		width: max-content;
		max-width: min(360px, calc(100vw - 32px - env(safe-area-inset-left) - env(safe-area-inset-right)));
		padding: 6px 8px;
		border: 1px solid rgba(82, 77, 68, 0.24);
		border-radius: 8px;
		background: rgba(50, 56, 52, 0.94);
		color: #fffdf2;
		font-size: 12px;
		font-weight: 700;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.speech-type-toggle:hover:not(:disabled) {
		background: var(--action-icon-background-hover);
	}

	.speech-type-toggle:active:not(:disabled) {
		background: var(--action-icon-background-active);
	}

	.speech-type-toggle:disabled {
		cursor: wait;
		border-color: var(--action-disabled-border);
		background: var(--action-disabled-background);
		color: var(--action-disabled-foreground);
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

	.action-dock-content :global(.host-owned-composer) {
		width: 100%;
		height: 100%;
		min-width: 0;
	}

	@media (max-width: 700px) {
		.action-dock-content { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 46px; column-gap: 0; row-gap: 8px; }
		.composer-editor-slot { grid-column: 1 / -1; grid-row: 1; }
		.composer-controls-left, .composer-controls-right { grid-row: 2; gap: 4px; }
		.composer-controls-left { grid-column: 1; justify-self: start; }
		.composer-controls-right { grid-column: 2; justify-self: end; }
		.composer-controls-left .profile-trigger { flex-basis: 44px; width: 44px; height: 44px; }
		.composer-controls-left .chatter-toggle, .composer-controls-left .trace-unread-indicator { flex-basis: 44px; width: 44px; height: 44px; }
		.composer-controls-left :global(.sound-control) { margin: 0; }
		.composer-controls-right .speech-type-toggle, .composer-controls-right :global(.suggestions-anchor) { flex-basis: 44px; width: 44px; height: 44px; }
	}
	@media (min-width: 701px) {
		.action-dock-content { --action-dock-desktop-control-size: 54px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: minmax(var(--action-dock-desktop-control-size), 1fr); }
		.composer-controls-left, .composer-editor-slot, .composer-controls-right { grid-row: 1; }
		.composer-controls-left, .composer-controls-right { align-self: center; }
		.profile-trigger, .chatter-toggle, .trace-unread-indicator, .speech-type-toggle, .composer-controls-right :global(.suggestions-anchor) { width: var(--action-dock-desktop-control-size); height: var(--action-dock-desktop-control-size); }
		.profile-trigger, .chatter-toggle, .trace-unread-indicator, .speech-type-toggle { flex-basis: var(--action-dock-desktop-control-size); }
	}
</style>
