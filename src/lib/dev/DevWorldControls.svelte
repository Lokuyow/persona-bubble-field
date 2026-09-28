<script lang="ts">
	import { CHARACTER_CATALOG } from '$lib/character';
	import type { SpeechType } from '$lib/conversation';
	import { DEV_SCENARIOS, devScenarioCategories, type DevScenario } from './devScenarios';
	import type { DevCooperationDefectionBotPreset } from './devCooperationDefectionPlayground';
	import { isBlockedFacilityCell } from '$lib/fieldFacilities';
	import type { GridPosition } from '$lib/geometry';
	import type { Direction } from '$lib/geometry';
	import { DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_BOT_B_PUBKEY, DEV_TAG_GAME_SELF_PUBKEY, type DevTagGamePlaygroundSnapshot } from './devTagGamePlayground';
	type Props = {
		scenario: DevScenario;
		selectedCharacterId: string;
		traceReplyFixtureEnabled: boolean;
		canAddLiveReply: boolean;
		cooperationDefectionPlaygroundEnabled: boolean;
		botPreset: DevCooperationDefectionBotPreset;
		canAdvanceCooperationDefection: boolean;
		tagGamePlaygroundEnabled: boolean;
		tagGamePlayground: DevTagGamePlaygroundSnapshot | null;
		onCharacterChange: (characterId: string) => void;
		onReset: () => void;
		onAddLiveReply: () => void;
		onInjectLiveSpeech: (speechType: SpeechType) => void;
		onBotPresetChange: (preset: DevCooperationDefectionBotPreset) => void;
		onAdvanceCooperationDefection: () => void;
		onTagGameAdvanceShort: () => void;
		onTagGameAdvanceEffect: () => void;
		onTagGameAdvanceEnd: () => void;
		onTagGameBotTouch: (direction: Direction) => void;
		onTagGameBotPosition: (pubkey: string, position: GridPosition) => void;
		onOpenTagGamePanel: () => void;
	};
	let { scenario, selectedCharacterId, traceReplyFixtureEnabled, canAddLiveReply, cooperationDefectionPlaygroundEnabled, botPreset, canAdvanceCooperationDefection,
		tagGamePlaygroundEnabled, tagGamePlayground,
		onCharacterChange, onReset, onAddLiveReply, onInjectLiveSpeech, onBotPresetChange, onAdvanceCooperationDefection,
		onTagGameAdvanceShort, onTagGameAdvanceEffect, onTagGameAdvanceEnd, onTagGameBotTouch, onTagGameBotPosition, onOpenTagGamePanel }: Props = $props();
	const botA = DEV_TAG_GAME_BOT_A_PUBKEY;
	const botB = DEV_TAG_GAME_BOT_B_PUBKEY;
	const botTouchDirections: readonly { direction: Direction; label: string }[] = [
		{ direction: 'up', label: '↑' }, { direction: 'right', label: '→' }, { direction: 'down', label: '↓' }, { direction: 'left', label: '←' }
	];
	function fieldPositions(): GridPosition[] {
		const field = tagGamePlayground?.presence.field;
		if (!field) return [];
		const positions: GridPosition[] = [];
		for (let y = 0; y < field.rows; y += 1) for (let x = 0; x < field.columns; x += 1) {
			const position = { x, y };
			if (!isBlockedFacilityCell(position)) positions.push(position);
		}
		return positions;
	}
</script>

<div class="sandbox-controls" class:chatter-scenario={scenario.fixture.kind === 'chatter-timeline'} class:trace-scenario={scenario.fixture.kind === 'trace'} class:cooperation-defection-scenario={scenario.fixture.kind === 'cooperation-defection-static' || scenario.fixture.kind === 'cooperation-defection-playground' || scenario.fixture.kind === 'tag-game-playground'} aria-label="DEV sandbox controls">
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
	{#if cooperationDefectionPlaygroundEnabled}
		<div class="sandbox-cooperation-defection-tools" aria-label="Cooperation and Defection Playground tools">
			<label>Bot choices
				<select aria-label="Select Cooperation and Defection bot preset" value={botPreset} onchange={(event) => onBotPresetChange((event.currentTarget as HTMLSelectElement).value as DevCooperationDefectionBotPreset)}>
					<option value="cooperative">Cooperative</option><option value="split">Split</option><option value="defection">Defection</option><option value="missing-reveal">Missing reveal</option>
				</select>
			</label>
			<button type="button" aria-label="Advance Cooperation and Defection Playground phase" disabled={!canAdvanceCooperationDefection} onclick={onAdvanceCooperationDefection}>Next phase</button>
		</div>
	{/if}
	{#if tagGamePlaygroundEnabled && tagGamePlayground}
		<section class="sandbox-tag-game-tools" aria-label="Tag Game Playground controls" data-dev-tag-game-controls>
			<button type="button" aria-label="Open DEV tag-game panel" onclick={onOpenTagGamePanel}>鬼ごっこパネル</button>
			<div class="tag-game-time-controls">
				<button type="button" aria-label="Advance tag-game time 5 seconds" onclick={onTagGameAdvanceShort}>+5秒</button>
				<button type="button" aria-label="Advance to next tag-game effect" onclick={onTagGameAdvanceEffect}>次の効果</button>
				<button type="button" aria-label="Advance to tag-game end" onclick={onTagGameAdvanceEnd}>終了へ</button>
			</div>
			<div class="tag-game-bot-controls">
				{#each [{ id: botA, label: 'BOT A' }, { id: botB, label: 'BOT B' }] as bot (bot.id)}
					<label>{bot.label} 配置
						<select aria-label={`Set ${bot.label} position`} value={tagGamePlayground.presence.participants.find((participant) => participant.id === bot.id)?.position ? `${tagGamePlayground.presence.participants.find((participant) => participant.id === bot.id)!.position.x},${tagGamePlayground.presence.participants.find((participant) => participant.id === bot.id)!.position.y}` : ''} onchange={(event) => {
							const [x, y] = (event.currentTarget as HTMLSelectElement).value.split(',').map(Number);
							onTagGameBotPosition(bot.id, { x, y });
						}}>
							{#each fieldPositions() as position (`${position.x},${position.y}`)}<option value={`${position.x},${position.y}`}>{position.x}, {position.y}</option>{/each}
						</select>
					</label>
				{/each}
				{#each botTouchDirections as entry (entry.direction)}<button type="button" aria-label={`BOT touches player ${entry.direction}`} onclick={() => onTagGameBotTouch(entry.direction)}>{entry.label}</button>{/each}
			</div>
			<div class="tag-game-local-totals" aria-label="Local tag-game totals">
				{#each tagGamePlayground.game?.participant ?? [] as player (player.pubkey)}
					<span>{player.pubkey === DEV_TAG_GAME_SELF_PUBKEY ? '自分' : player.pubkey === botA ? 'BOT A' : 'BOT B'}: {player.points}pt・寿命-{Math.ceil(player.lifespanLossMs / 60_000)}分・福{Math.floor(player.benefitMs / 1000)}秒・鬼{Math.floor(player.calamityMs / 1000)}秒</span>
				{/each}
			</div>
			{#if tagGamePlayground.message}<p role="status">{tagGamePlayground.message}</p>{/if}
		</section>
	{/if}
	<button class="sandbox-reset" type="button" onclick={onReset}>Reset scenario</button>
	</div>
</div>

<style>
	.sandbox-controls {
		position: absolute;
		z-index: 10;
	}
	.sandbox-scenario-picker, .sandbox-cooperation-defection-tools, .sandbox-tag-game-tools { display: flex; align-items: center; gap: 6px; }
	.sandbox-tag-game-tools { flex-wrap: wrap; max-width: min(600px, calc(100vw - 40px)); }
	.tag-game-time-controls, .tag-game-bot-controls { display: flex; align-items: center; gap: 5px; }
	.sandbox-tag-game-tools label { display: flex; align-items: center; gap: 4px; }
	.sandbox-tag-game-tools button, .sandbox-tag-game-tools select { min-height: 38px; padding: 0 8px; border: 1px solid rgba(57,67,64,.2); border-radius: 999px; background: rgba(255,255,255,.9); color: #3f4a47; font: inherit; font-size: 10px; font-weight: 800; pointer-events: auto; }
	.tag-game-local-totals { display: flex; flex-wrap: wrap; gap: 4px 10px; width: 100%; color: #3f4a47; font-size: 10px; }
	.sandbox-tag-game-tools p { margin: 0; font-size: 10px; }
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

	:global(.action-dock-available) .sandbox-controls {
		top: 8px;
	}
	.sandbox-controls.chatter-scenario { top: 132px; }
	.sandbox-controls.trace-scenario { top: auto; right: 12px; bottom: 12px; left: auto; width: min(340px, calc(100vw - 360px)); align-items: stretch; transform: none; }
	.sandbox-controls.trace-scenario .sandbox-control-panel { flex-direction: column; align-items: stretch; }
	.sandbox-controls.trace-scenario .sandbox-scenario-picker,
	.sandbox-controls.trace-scenario .sandbox-character-picker,
	.sandbox-controls.trace-scenario .sandbox-speech-injector { width: 100%; max-width: none; }
	.sandbox-controls.cooperation-defection-scenario { top: auto; bottom: 8px; }
	:global(.action-dock-available) .sandbox-controls.cooperation-defection-scenario { top: auto; bottom: calc(var(--action-reserved-height) + 8px); }

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
	.sandbox-scenario-picker select, .sandbox-cooperation-defection-tools select { min-height: 38px; max-width: 220px; padding: 0 9px; border: 1px solid rgba(57, 67, 64, 0.2); border-radius: 10px; background: rgba(255,255,255,.86); color: #3f4a47; font: inherit; }

	.sandbox-reset,
	.sandbox-live-reply,
	.sandbox-cooperation-defection-tools button,
	.sandbox-speech-injector button {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.sandbox-reset,
	.sandbox-live-reply,
	.sandbox-cooperation-defection-tools button,
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
	.sandbox-character-picker select:focus-visible,
	.sandbox-tag-game-tools button:focus-visible,
	.sandbox-tag-game-tools select:focus-visible {
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
		.sandbox-controls.trace-scenario { top: 8px; right: auto; bottom: auto; left: 50%; width: auto; align-items: center; transform: translateX(-50%); }
		.sandbox-controls.trace-scenario .sandbox-control-panel { align-items: center; }
		.sandbox-controls.cooperation-defection-scenario { top: auto; right: 12px; bottom: 8px; left: auto; width: min(340px, calc(100vw - 24px)); align-items: stretch; transform: none; }
		:global(.action-dock-available) .sandbox-controls.cooperation-defection-scenario { top: auto; bottom: 8px; }
		.sandbox-mobile-toggle-wrapper { display: block; }
		.sandbox-control-panel { flex-direction: column; gap: 7px; }
		.sandbox-control-panel { display: none; }
		.sandbox-mobile-toggle-wrapper[open] + .sandbox-control-panel { display: flex; }
		.sandbox-scenario-picker, .sandbox-cooperation-defection-tools { width: min(100vw - 32px, 340px); justify-content: space-between; }
		.sandbox-tag-game-tools { width: min(100vw - 32px, 340px); max-height: 38vh; overflow: auto; align-items: stretch; flex-direction: column; padding: 8px; border-radius: 12px; background: rgba(255,255,255,.94); pointer-events: auto; }
		.tag-game-bot-controls { flex-wrap: wrap; }
		.tag-game-bot-controls label { flex: 1 1 120px; justify-content: space-between; }
		.tag-game-bot-controls select { max-width: 130px; }
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
