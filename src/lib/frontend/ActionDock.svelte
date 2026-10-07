<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import SpeechMonologue from '~icons/hako/speech-monologue';
	import SpeechNormal from '~icons/hako/speech-normal';
	import SpeechShout from '~icons/hako/speech-shout';
	import LayoutSidebarLeftCollapse from '~icons/tabler/layout-sidebar-left-collapse';
	import LayoutSidebarLeftExpand from '~icons/tabler/layout-sidebar-left-expand';
	import BookmarkPlus from '~icons/tabler/bookmark-plus';
	import HostOwnedComposerLite from '$lib/HostOwnedComposerLite.svelte';
	import CharacterAvatar from '$lib/CharacterAvatar.svelte';
	import SpeechSuggestions from '$lib/frontend/SpeechSuggestions.svelte';
	import SoundControl from '$lib/frontend/SoundControl.svelte';
	import type { SpeechType } from '$lib/conversation';
	import type { Character } from '$lib/character';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import type { SpeechSuggestionConversationEntry } from '$lib/speechSuggestions';
	import { Popover, Tooltip } from 'bits-ui';
	import { onMount, tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { Bounds } from '$lib/geometry';

	type Props = ComponentProps<typeof HostOwnedComposerLite> & {
		onBoundsChange: (bounds: Bounds | null) => void;
		boundsRevision: string;
		selectedSpeechType: SpeechType;
		submissionInProgress: boolean;
		volume: number;
		onSoundOpen: () => void;
		onVolume: (volume: number) => void;
		hasUnreadReplies: boolean;
		unreadBaselineSnapshot: import('$lib/traceReadState').TraceReadSnapshot | null;
		character: Character;
		avatarTone: BubbleTone;
		canOpenSelfProfile: boolean;
		suggestionConversation: readonly SpeechSuggestionConversationEntry[];
		chatterOpen: boolean;
		onToggleChatter: () => void;
		onSpeechTypeChange: (next: SpeechType) => void;
		manualTraceSelected: boolean;
		manualTraceEnabled: boolean;
		manualTraceStatus: 'idle' | 'sending' | 'unknown' | 'confirmed';
		onToggleManualTrace: () => void;
		onOpenSelfProfile: (trigger: HTMLButtonElement) => void;
		submitCandidate: (content: string, signal: AbortSignal) => Promise<Readonly<{ eventId: string }>>;
	};
	let { onBoundsChange, boundsRevision, selectedSpeechType, submissionInProgress, volume, onSoundOpen, onVolume, onSpeechTypeChange, onOpenSelfProfile, submitContent, submitCandidate,
		desiredContext, loadPreview, onPreviewClear, onEditorEmptyChange, onPreferredHeightChange,
	 hasUnreadReplies, unreadBaselineSnapshot, character, avatarTone, suggestionConversation, canOpenSelfProfile, chatterOpen, onToggleChatter,
	 manualTraceSelected, manualTraceEnabled, manualTraceStatus, onToggleManualTrace }: Props = $props();
	let remeasureBounds = () => {};
	const observeBounds: Attachment<HTMLElement> = (node) => untrack(() => {
		const measure = () => untrack(() => {
			const rect = node.getBoundingClientRect();
			onBoundsChange({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
		});
		const observer = new ResizeObserver(measure);
		observer.observe(node); remeasureBounds = measure; measure();
		return () => untrack(() => { observer.disconnect(); remeasureBounds = () => {}; onBoundsChange(null); });
	});
	$effect(() => { void boundsRevision; void tick().then(() => remeasureBounds()); });
	let composerComponent: { focusEditor(): boolean; blurEditor(): boolean; applyContentIfEmpty(content: string): Promise<boolean> } | null = null;
	let editorIsEmpty = $state<boolean | null>(null);
	let explanationVisible = $state(false);
	let tooltipsDisabled = $state(true);
	let unreadBaselineInitialized = false;
	let previousUnreadState = false;
	let unreadArrivalFeedback = $state(false);

	$effect(() => {
		const baseline = unreadBaselineSnapshot;
		const unread = hasUnreadReplies;
		if (!baseline) {
			unreadBaselineInitialized = false;
			unreadArrivalFeedback = false;
			previousUnreadState = unread;
			return;
		}
		if (!unreadBaselineInitialized) {
			unreadBaselineInitialized = true;
			previousUnreadState = baseline.hasUnreadReplies;
		}
		if (!previousUnreadState && unread) {
			unreadArrivalFeedback = false;
			requestAnimationFrame(() => { unreadArrivalFeedback = true; });
		}
		previousUnreadState = unread;
	});

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

	<div class="action-dock" {@attach observeBounds} aria-label="主要操作">
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
							<span class={['trace-unread-arrival-ring', { active: unreadArrivalFeedback }]} aria-hidden="true" onanimationend={() => { unreadArrivalFeedback = false; }}></span>
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
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						class={['manual-trace-toggle', { 'action-selected': manualTraceSelected }]}
						type="button"
						aria-label={`書置きを投稿（100pt消費${manualTraceStatus === 'unknown' ? '・結果未確認' : manualTraceStatus === 'sending' ? '・送信中' : ''}）`}
						aria-pressed={manualTraceSelected}
						data-manual-trace-status={manualTraceStatus}
						disabled={!manualTraceEnabled || submissionInProgress}
						onclick={onToggleManualTrace}
					>
						<span class="manual-trace-icon" aria-hidden="true"><BookmarkPlus /></span>
						<span class="manual-trace-cost" aria-hidden="true">100pt</span>
					</button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content role="tooltip" class="action-dock-tooltip" side="top" sideOffset={8}>書置き（投稿時に100pt消費）{manualTraceStatus === 'sending' ? '・送信中' : manualTraceStatus === 'unknown' ? '・結果未確認のため同じイベントを自動再試行します' : ''}</Tooltip.Content>
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
		--action-icon-border: #c4cbd0;
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
	.manual-trace-toggle {
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
		cursor: pointer;
	}
	.manual-trace-toggle.action-selected[aria-pressed='true']:not(:disabled) { border-color: var(--action-selected-border); background: var(--action-selected-background); color: var(--action-selected-foreground); }
	.manual-trace-toggle.action-selected[aria-pressed='true']:hover:not(:disabled) { background: var(--action-selected-background-hover); }
	.manual-trace-toggle.action-selected[aria-pressed='true']:active:not(:disabled) { background: var(--action-selected-background-active); }
	.manual-trace-toggle:disabled { cursor: not-allowed; background: var(--action-icon-background); }
	.manual-trace-toggle:disabled .manual-trace-icon, .manual-trace-toggle:disabled .manual-trace-cost { opacity: 0.32; }
	.manual-trace-toggle:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	.manual-trace-icon, .manual-trace-icon :global(svg) { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; }
	.manual-trace-toggle { flex-direction: column; gap: 0; }
	.manual-trace-cost { font-size: 9px; font-weight: 800; line-height: 1; }

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
	.trace-unread-arrival-ring {
		position: absolute;
		inset: 2px;
		border: 2px solid currentColor;
		border-radius: inherit;
		pointer-events: none;
		opacity: 0;
	}
	.trace-unread-arrival-ring.active {
		animation: trace-unread-arrival var(--motion-duration-interaction) var(--motion-easing-standard) both;
	}
	@keyframes trace-unread-arrival { from { opacity: .8; scale: .8; } to { opacity: 0; scale: 1.35; } }
	@media (prefers-reduced-motion: reduce) {
		.trace-unread-arrival-ring.active { animation-name: trace-unread-arrival-reduced; }
		@keyframes trace-unread-arrival-reduced { from { opacity: .8; } to { opacity: 0; } }
	}

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
		.composer-controls-right .speech-type-toggle, .composer-controls-right .manual-trace-toggle, .composer-controls-right :global(.suggestions-anchor) { flex-basis: 44px; width: 44px; height: 44px; }
	}
	@media (max-width: 360px) {
		.action-dock-content { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) 46px 46px; }
		.composer-controls-left, .composer-controls-right { grid-column: 1; }
		.composer-controls-left { grid-row: 2; justify-self: start; }
		.composer-controls-right { grid-row: 3; justify-self: end; }
	}
	@media (min-width: 701px) {
		.action-dock-content { --action-dock-desktop-control-size: 54px; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: minmax(var(--action-dock-desktop-control-size), 1fr); }
		.composer-controls-left, .composer-editor-slot, .composer-controls-right { grid-row: 1; }
		.composer-controls-left, .composer-controls-right { align-self: center; }
		.profile-trigger, .chatter-toggle, .trace-unread-indicator, .speech-type-toggle, .manual-trace-toggle, .composer-controls-right :global(.suggestions-anchor) { width: var(--action-dock-desktop-control-size); height: var(--action-dock-desktop-control-size); }
		.profile-trigger, .chatter-toggle, .trace-unread-indicator, .speech-type-toggle, .manual-trace-toggle { flex-basis: var(--action-dock-desktop-control-size); }
	}
</style>
