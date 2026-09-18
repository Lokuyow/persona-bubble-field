<script lang="ts">
	import { CHARACTER_CATALOG } from '$lib/character';
	import type { SpeechType } from '$lib/conversation';
	import { DEV_SCENARIOS, devScenarioCategories, type DevScenario } from './devScenarios';
	import type { DevRiftBotPreset } from './devRiftPlayground';
	type Props = {
		scenario: DevScenario;
		selectedCharacterId: string;
		traceReplyFixtureEnabled: boolean;
		canAddLiveReply: boolean;
		riftPlaygroundEnabled: boolean;
		botPreset: DevRiftBotPreset;
		canAdvanceRift: boolean;
		onCharacterChange: (characterId: string) => void;
		onReset: () => void;
		onAddLiveReply: () => void;
		onInjectLiveSpeech: (speechType: SpeechType) => void;
		onBotPresetChange: (preset: DevRiftBotPreset) => void;
		onAdvanceRift: () => void;
	};
	let { scenario, selectedCharacterId, traceReplyFixtureEnabled, canAddLiveReply, riftPlaygroundEnabled, botPreset, canAdvanceRift,
		onCharacterChange, onReset, onAddLiveReply, onInjectLiveSpeech, onBotPresetChange, onAdvanceRift }: Props = $props();
</script>

<div class="sandbox-controls" class:chatter-scenario={scenario.fixture.kind === 'chatter-timeline'} class:rift-scenario={scenario.fixture.kind === 'rift-static' || scenario.fixture.kind === 'rift-playground'} aria-label="DEV sandbox controls">
	<details class="sandbox-mobile-toggle-wrapper">
		<summary class="sandbox-mobile-toggle">DEV controls</summary>
	</details>
	<div class="sandbox-control-panel">
	<form class="sandbox-scenario-picker" method="get">
		<input type="hidden" name="devWorld" value="1" />
		<input type="hidden" name="devCharacter" value={selectedCharacterId} />
		<label>
			<span>Scenario</span>
			<select aria-label="Select DEV scenario" name="devScenario" value={scenario.id}>
				{#each devScenarioCategories() as category}
					<optgroup label={category}>
						{#each DEV_SCENARIOS.filter((candidate) => candidate.category === category) as candidate (candidate.id)}
							<option value={candidate.id}>{candidate.label}</option>
						{/each}
					</optgroup>
				{/each}
			</select>
		</label>
		<button type="submit" aria-label="Open selected DEV scenario">Open</button>
		<small>{scenario.description}</small>
	</form>
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
	<div class="sandbox-speech-injector" aria-label="DEV speech sound injector">
		<span>Live speech sound</span>
		<button type="button" aria-label="Inject live Normal speech" onclick={() => onInjectLiveSpeech('normal')}>Normal</button>
		<button type="button" aria-label="Inject live Shout speech" onclick={() => onInjectLiveSpeech('shout')}>Shout</button>
		<button type="button" aria-label="Inject live Monologue speech" onclick={() => onInjectLiveSpeech('monologue')}>Monologue</button>
	</div>
	{#if riftPlaygroundEnabled}
		<div class="sandbox-rift-tools" aria-label="Rift Playground tools">
			<label>Bot preset
				<select aria-label="Select Rift bot preset" value={botPreset} onchange={(event) => onBotPresetChange((event.currentTarget as HTMLSelectElement).value as DevRiftBotPreset)}>
					<option value="cooperative">Cooperative</option><option value="split">Split</option><option value="escape">Escape</option><option value="missing-reveal">Missing reveal</option>
				</select>
			</label>
			<button type="button" aria-label="Advance Rift Playground phase" disabled={!canAdvanceRift} onclick={onAdvanceRift}>Next phase</button>
		</div>
	{/if}
	<button class="sandbox-reset" type="button" onclick={onReset}>Reset scenario</button>
	</div>
</div>

<style>
	.sandbox-controls {
		position: absolute;
		z-index: 10;
	}
	.sandbox-scenario-picker, .sandbox-rift-tools { display: flex; align-items: center; gap: 6px; }
	.sandbox-scenario-picker { flex-wrap: wrap; max-width: 300px; }
	.sandbox-scenario-picker small { width: 100%; color: #596662; font-size: 9px; }

	.sandbox-controls {
		top: 8px;
		left: 50%;
		z-index: 11;
		pointer-events: none;
		display: flex;
		align-items: center;
		gap: 10px;
		transform: translateX(-50%);
	}
	.sandbox-control-panel { display: flex; align-items: center; gap: 10px; }
	.sandbox-mobile-toggle-wrapper { display: none; }
	.sandbox-mobile-toggle { min-height: 32px; padding: 8px 12px; border: 1px solid rgba(57, 67, 64, 0.2); border-radius: 999px; background: rgba(255, 255, 255, 0.9); color: #3f4a47; font-size: 10px; font-weight: 800; pointer-events: auto; cursor: pointer; }
	.sandbox-mobile-toggle::marker { content: ''; }
	.sandbox-controls label,
	.sandbox-controls select,
	.sandbox-controls button {
		pointer-events: auto;
	}

	:global(.composer-available) .sandbox-controls {
		top: 8px;
	}
	.sandbox-controls.chatter-scenario { top: 132px; }
	.sandbox-controls.rift-scenario { top: 148px; }
	:global(.composer-available) .sandbox-controls.rift-scenario { top: 148px; }

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
	.sandbox-scenario-picker select, .sandbox-rift-tools select { min-height: 38px; max-width: 220px; padding: 0 9px; border: 1px solid rgba(57, 67, 64, 0.2); border-radius: 10px; background: rgba(255,255,255,.86); color: #3f4a47; font: inherit; }

	.sandbox-reset,
	.sandbox-live-reply,
	.sandbox-rift-tools button,
	.sandbox-speech-injector button {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-reset,
	.sandbox-live-reply,
	.sandbox-rift-tools button,
	.sandbox-speech-injector button {
		min-height: 38px;
		padding: 0 11px;
		border-radius: 999px;
		font-size: 10px;
		letter-spacing: 0.04em;
	}

	.sandbox-speech-injector {
		display: flex;
		align-items: center;
		gap: 5px;
		width: max-content;
	}

	.sandbox-speech-injector span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

	.sandbox-live-reply:disabled {
		opacity: 0.48;
	}

	.sandbox-speech-injector button {
		padding-inline: 7px;
	}

	.sandbox-reset:focus-visible,
	.sandbox-live-reply:focus-visible,
	.sandbox-character-picker select:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 700px) {
		.sandbox-controls {
			top: 8px;
			flex-direction: column;
			gap: 7px;
		}
		.sandbox-controls.chatter-scenario { top: 8px; }
		.sandbox-controls.rift-scenario { top: 148px; }
		.sandbox-mobile-toggle-wrapper { display: block; }
		.sandbox-control-panel { flex-direction: column; gap: 7px; }
		.sandbox-control-panel { display: none; }
		.sandbox-mobile-toggle-wrapper[open] + .sandbox-control-panel { display: flex; }
		.sandbox-scenario-picker, .sandbox-rift-tools { width: min(100vw - 32px, 340px); justify-content: space-between; }
		.sandbox-scenario-picker select { flex: 1; max-width: none; }

		.sandbox-character-picker {
			width: min(100vw - 32px, 280px);
			justify-content: space-between;
		}

		.sandbox-speech-injector {
			width: 100%;
			justify-content: center;
			gap: 4px;
		}

		.sandbox-speech-injector button {
			min-width: 0;
			flex: 1;
			padding-inline: 3px;
		}

		.sandbox-character-picker select {
			max-width: 210px;
			flex: 1;
		}
	}
</style>
