<script lang="ts">
	import { CHARACTER_CATALOG } from '$lib/character';
	type Props = {
		selectedCharacterId: string;
		traceReplyFixtureEnabled: boolean;
		canAddLiveReply: boolean;
		onCharacterChange: (characterId: string) => void;
		onReset: () => void;
		onAddLiveReply: () => void;
	};
	let { selectedCharacterId, traceReplyFixtureEnabled, canAddLiveReply,
		onCharacterChange, onReset, onAddLiveReply }: Props = $props();
</script>

<div class="sandbox-controls" aria-label="DEV sandbox controls">
	<label class="sandbox-character-picker">
		<span>Character</span>
		<select aria-label="Select sandbox character" value={selectedCharacterId} onchange={(event) => onCharacterChange((event.currentTarget as HTMLSelectElement).value)}>
			{#each CHARACTER_CATALOG as character (character.characterId)}
				<option value={character.characterId}>{character.characterId} — {character.name}</option>
			{/each}
		</select>
	</label>
	{#if traceReplyFixtureEnabled}
		<button
			class="sandbox-live-reply"
			type="button"
			disabled={!canAddLiveReply}
			onclick={onAddLiveReply}
		>Add live trace reply</button>
	{/if}
	<button class="sandbox-reset" type="button" onclick={onReset}>Reset sandbox</button>
</div>

<style>
	.sandbox-controls {
		position: absolute;
		z-index: 10;
	}

	.sandbox-controls {
		bottom: 76px;
		left: 50%;
		z-index: 11;
		display: flex;
		align-items: center;
		gap: 10px;
		transform: translateX(-50%);
	}

	:global(.composer-available) .sandbox-controls {
		bottom: calc(var(--composer-dock-height) + 76px);
	}

	.sandbox-character-picker {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #596662;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
	}

	.sandbox-character-picker select {
		max-width: 205px;
		min-height: 38px;
		padding: 0 9px;
		border: 1px solid rgba(57, 67, 64, 0.2);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.86);
		color: #3f4a47;
		font: inherit;
	}

	.sandbox-reset,
	.sandbox-live-reply {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-reset,
	.sandbox-live-reply {
		min-height: 38px;
		padding: 0 11px;
		border-radius: 999px;
		font-size: 10px;
		letter-spacing: 0.04em;
	}

	.sandbox-live-reply:disabled {
		opacity: 0.48;
	}

	.sandbox-reset:focus-visible,
	.sandbox-live-reply:focus-visible,
	.sandbox-character-picker select:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 700px) {
		.sandbox-controls {
			bottom: 76px;
			flex-direction: column;
			gap: 7px;
		}

		.sandbox-character-picker {
			width: min(100vw - 32px, 280px);
			justify-content: space-between;
		}

		.sandbox-character-picker select {
			max-width: 210px;
			flex: 1;
		}
	}
</style>
