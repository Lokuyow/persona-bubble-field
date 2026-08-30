<script lang="ts">
	import { page } from '$app/state';
	import { asset } from '$app/paths';
	import { Avatar, Dialog, ScrollArea } from 'bits-ui';
	import { getCharacterById } from '$lib/character';

	let {
		onOpenChange,
		onCloseAutoFocus
	}: {
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
	} = $props();

	const profileCharacterId = $derived(page.state.profileCharacterId);
	const character = $derived(profileCharacterId ? getCharacterById(profileCharacterId) ?? null : null);
	const open = $derived(character !== null);
</script>


{#if character}
	<Dialog.Root {open} {onOpenChange}>
		<Dialog.Portal>
			<Dialog.Overlay class="profile-dialog-overlay" />
			<Dialog.Content class="profile-dialog-content" {onCloseAutoFocus}>
				<div class="profile-dialog-header">
					<Avatar.Root class="profile-dialog-avatar">
						<Avatar.Image src={asset(`/${character.picture}`)} alt="" />
						<Avatar.Fallback>{character.name.slice(0, 1)}</Avatar.Fallback>
					</Avatar.Root>
					<div>
						<Dialog.Title>{character.name}</Dialog.Title>
						<Dialog.Description class="visually-hidden">キャラクターのプロフィール</Dialog.Description>
					</div>
				</div>

				<ScrollArea.Root class="profile-dialog-scroll-area" type="auto">
					<ScrollArea.Viewport class="profile-dialog-scroll-viewport">
						<p class="profile-dialog-about">{character.about}</p>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar class="profile-dialog-scrollbar" orientation="vertical">
						<ScrollArea.Thumb class="profile-dialog-scroll-thumb" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>

				<footer class="profile-dialog-footer">
					<Dialog.Close class="profile-dialog-close">閉じる</Dialog.Close>
				</footer>
			</Dialog.Content>
		</Dialog.Portal>
	</Dialog.Root>
{/if}

<style>
	:global(.profile-dialog-overlay) {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(35, 44, 41, 0.48);
		backdrop-filter: blur(3px);
	}

	:global(.profile-dialog-content) {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: 101;
		display: flex;
		width: min(calc(100vw - 32px), 480px);
		height: min(520px, calc(100dvh - 32px));
		max-height: calc(100dvh - 32px);
		box-sizing: border-box;
		flex-direction: column;
		gap: 18px;
		padding: 24px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 24px;
		background: #f7f7ef;
		box-shadow: 0 22px 60px rgba(32, 42, 38, 0.32);
		color: #374345;
		font-family: 'Trebuchet MS', 'Avenir Next', system-ui, sans-serif;
		outline: none;
		transform: translate(-50%, -50%);
	}

	.profile-dialog-header {
		display: flex;
		align-items: center;
		flex-direction: column;
		gap: 16px;
		text-align: center;
	}

	.profile-dialog-header :global([data-dialog-title]) {
		margin: 0;
		font-size: 22px;
		font-weight: 900;
		letter-spacing: 0.03em;
	}

	:global(.profile-dialog-avatar) {
		display: grid;
		width: 256px;
		height: 256px;
		flex: 0 0 auto;
		place-items: center;
		overflow: hidden;
		border: 2px solid rgba(255, 255, 255, 0.88);
		border-radius: 42% 58% 48% 52%;
		background: #9bc6d5;
		box-shadow: 0 5px 10px rgba(58, 70, 61, 0.16);
		color: #374345;
		font-size: 20px;
		font-weight: 900;
	}

	:global(.profile-dialog-avatar img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: center;
	}

	:global(.profile-dialog-scroll-area) {
		position: relative;
		min-height: 0;
		flex: 1 1 auto;
		overflow: hidden;
		border: 1px solid rgba(57, 67, 64, 0.12);
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.66);
	}

:global(.profile-dialog-scroll-viewport) {
		position: absolute;
		inset: 0;
		padding: 16px 22px 16px 16px;
		box-sizing: border-box;
	}

	.profile-dialog-about {
		margin: 0;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1.7;
	}

	:global(.profile-dialog-scrollbar) {
		display: flex;
		width: 10px;
		padding: 2px;
		border-radius: 999px;
		background: rgba(86, 105, 98, 0.12);
	}

	:global(.profile-dialog-scroll-thumb) {
		flex: 1;
		border-radius: inherit;
		background: #8fa8a0;
	}

	.profile-dialog-footer {
		display: flex;
		justify-content: flex-end;
	}

	:global(.profile-dialog-close) {
		min-height: 42px;
		padding: 0 18px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 999px;
		background: #d9edf0;
		box-shadow: 0 4px 10px rgba(58, 70, 61, 0.14);
		color: #374345;
		font: inherit;
		font-size: 13px;
		font-weight: 900;
		letter-spacing: 0.04em;
	}

	:global(.profile-dialog-close:focus-visible) {
		outline: 3px solid #6dabb9;
		outline-offset: 2px;
	}

	:global(.visually-hidden) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	@media (max-width: 700px) {
		:global(.profile-dialog-content) {
			gap: 14px;
			padding: 20px;
		}

		.profile-dialog-header :global([data-dialog-title]) { font-size: 19px; }
		.profile-dialog-about { font-size: 14px; }
	}
</style>
