<script lang="ts">
	import type { Character } from './character';
	import type { BubbleTone } from './bubblePresentation';
	import type { GridPosition, WorldPoint } from './geometry';
	import CharacterAvatar from './CharacterAvatar.svelte';

	type Props = Readonly<{
		id: string;
		character: Character;
		color: BubbleTone;
		self: boolean;
		position: GridPosition;
		world: WorldPoint;
		movementAnimation: boolean;
		onProfile: (position: GridPosition, trigger: HTMLButtonElement) => void;
	}>;

	let {
		id,
		character,
		color,
		self,
		position,
		world,
		movementAnimation,
		onProfile
	}: Props = $props();
</script>

<div
	class="participant"
	data-participant-id={id}
	data-self={self ? 'true' : undefined}
	data-position={`${position.x},${position.y}`}
	data-movement-animation={movementAnimation ? 'active' : undefined}
	style={`left: ${world.x}px; top: ${world.y}px;`}
>
	<button
		class="participant-profile-trigger"
		type="button"
		aria-label={`${character.name} のプロフィールを開く`}
		onclick={(event) => {
			event.stopPropagation();
			onProfile(position, event.currentTarget as HTMLButtonElement);
		}}
	>
		<CharacterAvatar class={`avatar avatar-${color}`} {character} />
		<span class="participant-name" class:participant-name-self={self} aria-hidden="true">{character.name}</span>
	</button>
</div>

<style>
	.participant {
		position: absolute;
		z-index: 3;
		width: var(--cell-size);
		height: var(--cell-size);
		transform: translate(-50%, -50%);
		will-change: left, top;
	}

	.participant-profile-trigger {
		position: relative;
		display: block;
		width: 100%;
		height: 100%;
		padding: 0;
		border: 0;
		background: transparent;
	}

	.participant-profile-trigger:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 3px;
	}

	.participant-name {
		position: absolute;
		bottom: 1px;
		left: 50%;
		display: block;
		width: max-content;
		max-width: calc(var(--avatar-size) + 4px);
		box-sizing: border-box;
		transform: translateX(-50%);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		padding: 1px 6px 1px;
		border-radius: 999px;
		background: rgba(247, 247, 239, 0.74);
		color: #596662;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.03em;

		@media (max-width: 700px) {
			font-size: 8px;
		}
	}

	.participant-name-self {
		border: 2px solid var(--color-accent);
		background: var(--color-accent-soft);
		font-weight: 800;
	}
</style>
