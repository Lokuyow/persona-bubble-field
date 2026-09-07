<script lang="ts">
	import { asset } from '$app/paths';
	import { Avatar } from 'bits-ui';
	import type { Character } from './character';

	type Props = Readonly<{
		character: Character;
		class?: string;
	}>;

	let { character, class: className }: Props = $props();
</script>

<Avatar.Root class={className}>
	<Avatar.Image src={asset(`/${character.picture}`)} alt="" />
	<Avatar.Fallback>{character.name.slice(0, 1)}</Avatar.Fallback>
</Avatar.Root>

<style>
	:global(.avatar) {
		position: absolute;
		top: 50%;
		left: 50%;
		display: grid;
		width: var(--avatar-size);
		height: var(--avatar-size);
		box-sizing: border-box;
		place-items: center;
		border: 2px solid rgba(255, 255, 255, 0.88);
		border-radius: 42% 58% 48% 52%;
		box-shadow: 0 5px 10px rgba(58, 70, 61, 0.16);
		color: #374345;
		font-size: 11px;
		font-weight: 900;
		letter-spacing: 0.04em;
		transform: translate(-50%, -50%);
	}

	:global(.avatar-coral) { background: #f0a488; }
	:global(.avatar-lavender) { background: #b6afe1; }
	:global(.avatar-mint) { background: #99c6ac; }
	:global(.avatar-yellow) { background: #e8c774; }
	:global(.avatar-sky) { background: #9bc6d5; }
	:global(.avatar-peach) { background: #eab994; }
	:global(.avatar-rose) { background: #dca1b2; }
	:global(.avatar-blue) { background: #90b4d0; }

	:global(.avatar img) {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: center;
	}
</style>
