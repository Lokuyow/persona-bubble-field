<script lang="ts">
	import { Dialog, ScrollArea } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import X from '~icons/tabler/x';
	import type { Character } from '$lib/character';
	import CharacterAvatar from './CharacterAvatar.svelte';

	let {
		open, character, runLabel, description, avatarClass = '', dialogClass = 'profile-dialog-content', onOpenChange, onCloseAutoFocus,
		children
	}: {
		open: boolean;
		character: Character;
		runLabel: string | null;
		description: string;
		avatarClass?: string;
		dialogClass?: string;
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
		children: Snippet;
	} = $props();
	let initialFocusTarget: HTMLElement | null = $state(null);
	function focusInitialSection(event: Event) {
		event.preventDefault();
		initialFocusTarget?.focus();
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="profile-dialog-overlay" />
			<Dialog.Content class={`${dialogClass} self-profile-content`} preventScroll={false} {onCloseAutoFocus} onOpenAutoFocus={focusInitialSection}>
				<header class="profile-dialog-header self-profile-dialog-header">
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</header>
				<ScrollArea.Root class="profile-dialog-scroll-area self-profile-scroll" type="auto">
					<ScrollArea.Viewport class="profile-dialog-scroll-viewport self-profile-viewport">
						<div class="profile-dialog-sections self-profile-sections">
							<section class="profile-section" aria-labelledby="profile-presentation-heading">
								<h2 bind:this={initialFocusTarget} id="profile-presentation-heading" class="profile-section-heading" tabindex="-1" data-initial-focus>プロフィール</h2>
								<header class="profile-dialog-identity self-profile-head">
									<CharacterAvatar class={`profile-dialog-avatar self-profile-avatar ${avatarClass}`} {character} />
									<div class="profile-dialog-identity-text self-profile-identity">
										<Dialog.Title>{character.name}</Dialog.Title>
										<Dialog.Description class="visually-hidden">{description}</Dialog.Description>
										{#if runLabel}<span>{runLabel}</span>{/if}
									</div>
								</header>
								<p class="profile-dialog-about self-profile-about">{character.about}</p>
							</section>
							{@render children()}
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar class="profile-dialog-scrollbar self-profile-scrollbar" orientation="vertical"><ScrollArea.Thumb class="profile-dialog-scroll-thumb self-profile-thumb" /></ScrollArea.Scrollbar>
				</ScrollArea.Root>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.profile-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(35, 44, 41, .48); backdrop-filter: blur(3px); }
	:global(.profile-dialog-content), :global(.self-profile-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 12px; box-sizing: border-box; width: min(560px, calc(100vw - 32px)); max-height: min(760px, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px)); padding: 24px; overflow: hidden; border: 1px solid rgba(57, 67, 64, .26); border-radius: 24px; background: #f1f5f0; box-shadow: 0 22px 60px rgba(32, 42, 38, .28); color: #374345; font-family: 'Trebuchet MS', 'Avenir Next', system-ui, sans-serif; transform: translate(-50%, -50%); outline: none; }
	.profile-dialog-header { display: flex; justify-content: flex-end; }
	.profile-dialog-identity { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 18px; align-items: center; }
	:global(.profile-dialog-avatar) { position: relative !important; inset: auto !important; display: grid; width: 128px; height: 128px; flex: 0 0 auto; place-items: center; border: 2px solid rgba(255, 255, 255, .9); border-radius: 42% 58% 48% 52%; box-shadow: 0 5px 10px rgba(58, 70, 61, .14); color: #374345; font-size: 20px; font-weight: 900; transform: none !important; }
	:global(.profile-dialog-avatar img) { width: 100%; height: 100%; object-fit: contain; }
	.profile-dialog-identity-text { display: grid; gap: 5px; }
	:global(.profile-dialog-identity-text [data-dialog-title]) { margin: 0; font-size: 24px; font-weight: 900; }
	.profile-dialog-identity-text span { color: #75817d; font-size: 13px; font-weight: 900; letter-spacing: .04em; }
	:global(.visually-hidden) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	:global(.profile-dialog-scroll-area) { min-height: 0; overflow: hidden; }
	:global(.profile-dialog-scroll-viewport) { min-height: 0; max-height: 100%; overflow-y: auto; padding-right: 8px; }
	.profile-dialog-sections { display: grid; gap: 24px; }
	.profile-section { display: grid; gap: 10px; }
	.profile-section-heading { margin: 0; color: #56625e; font-size: 14px; font-weight: 900; letter-spacing: .04em; }
	.profile-dialog-about { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: #56625e; font-size: 14px; font-weight: 700; line-height: 1.65; }
	:global(.profile-dialog-scrollbar) { display: flex; width: 10px; padding: 2px; border-radius: 999px; background: rgba(86, 105, 98, .12); }
	:global(.profile-dialog-scroll-thumb) { flex: 1; border-radius: inherit; background: #8fa8a0; }
	@media (max-width: 600px) { :global(.profile-dialog-content), :global(.self-profile-content) { gap: 10px; width: min(560px, calc(100vw - 20px)); max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 16px); padding: 18px; } .profile-dialog-sections { gap: 18px; } .profile-dialog-identity { grid-template-columns: 96px minmax(0, 1fr); } :global(.profile-dialog-avatar) { width: 96px; height: 96px; border-radius: 32% 68% 42% 58%; } :global(.profile-dialog-identity-text [data-dialog-title]) { font-size: 20px; } }
</style>
