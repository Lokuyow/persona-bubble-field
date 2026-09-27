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
		tagGameRole?: 'participant' | 'holder' | null;
		tagGameEffect?: 'benefit' | 'calamity' | null;
		tagGameEffectActive?: boolean;
		tagGameTouchTarget?: boolean;
		tagGameTouchAttemptId?: number | null;
		tagGameTouchAttemptOffset?: WorldPoint | null;
		tagGameHolderTransferId?: number | null;
		onProfile: (position: GridPosition, trigger: HTMLButtonElement) => void;
		onSelfProfile?: (trigger: HTMLButtonElement) => void;
	}>;

	let {
		id,
		character,
		color,
		self,
		position,
		world,
		movementAnimation,
		tagGameRole = null,
		tagGameEffect = null,
		tagGameEffectActive = false,
		tagGameTouchTarget = false,
		tagGameTouchAttemptId = null,
		tagGameTouchAttemptOffset = null,
		tagGameHolderTransferId = null,
		onProfile,
		onSelfProfile
	}: Props = $props();
</script>

<div
	class={['participant', { 'tag-game-touch-attempt': self && tagGameTouchAttemptId !== null, 'tag-game-touch-target': tagGameTouchTarget }]}
	data-participant-id={id}
	data-self={self ? 'true' : undefined}
	data-position={`${position.x},${position.y}`}
	data-movement-animation={movementAnimation ? 'active' : undefined}
	data-tag-game-role={tagGameRole ?? undefined}
	data-tag-game-effect={tagGameRole === 'holder' ? tagGameEffect ?? undefined : undefined}
	data-tag-game-effect-active={tagGameRole === 'holder' ? String(tagGameEffectActive) : undefined}
	data-tag-game-touch-attempt={self && tagGameTouchAttemptId !== null ? tagGameTouchAttemptId : undefined}
	data-tag-game-touch-target={tagGameTouchTarget ? 'true' : undefined}
	data-tag-game-holder-transfer={tagGameRole === 'holder' && tagGameHolderTransferId !== null ? tagGameHolderTransferId : undefined}
	style={`left: ${world.x}px; top: ${world.y}px; --tag-game-touch-x: ${tagGameTouchAttemptOffset?.x ?? 0}px; --tag-game-touch-y: ${tagGameTouchAttemptOffset?.y ?? 0}px;`}
>
	{#if tagGameRole === 'holder' && tagGameEffect}
		<span class={['tag-game-effect-aura', `tag-game-effect-aura-${tagGameEffect}`, { 'tag-game-effect-aura-paused': !tagGameEffectActive }]} aria-hidden="true">
			<svg viewBox="0 0 76 76" focusable="false">
				{#if tagGameEffect === 'benefit'}
					<circle class="fuku-aura-glow" cx="38" cy="38" r="34.5" />
					<circle class="fuku-aura-ring" cx="38" cy="38" r="35.5" />
					<path class="fuku-aura-flare fuku-aura-flare-one" d="M17 7L21 11L17 15L13 11Z" />
					<path class="fuku-aura-flare fuku-aura-flare-two" d="M60 57L63 60L60 63L57 60Z" />
				{:else}
					<path class="oni-aura-shadow" d="M35 2L42 4L47 2L51 9L60 10L59 17L68 20L64 27L74 34L68 39L73 47L64 51L66 58L57 60L52 72L44 68L38 74L32 68L23 72L20 63L11 60L15 53L3 48L10 42L2 34L9 29L5 21L14 18L17 9L27 11Z" />
					<path class="oni-aura-outline" d="M35 2L42 4L47 2L51 9L60 10L59 17L68 20L64 27M74 34L68 39L73 47L64 51M66 58L57 60L52 72L44 68M38 74L32 68L23 72M20 63L11 60L15 53L3 48M2 34L9 29L5 21L14 18L17 9L27 11" />
					<path class="oni-aura-shard oni-aura-shard-one" d="M29 10L34 1L39 12Z" />
					<path class="oni-aura-shard oni-aura-shard-two" d="M67 29L76 35L65 40Z" />
					<path class="oni-aura-shard oni-aura-shard-three" d="M45 66L40 76L33 66Z" />
					<path class="oni-aura-shard oni-aura-shard-four" d="M9 45L0 40L11 33Z" />
				{/if}
			</svg>
		</span>
	{/if}
	<button
		class="participant-profile-trigger"
		data-field-gesture-origin="selectable"
		type="button"
		ondragstart={(event) => event.preventDefault()}
		aria-label={`${character.name} のプロフィールを開く`}
		onclick={(event) => {
			event.stopPropagation();
			const trigger = event.currentTarget as HTMLButtonElement;
			if (self && onSelfProfile) onSelfProfile(trigger);
			else onProfile(position, trigger);
		}}
	>
		<CharacterAvatar class={`avatar avatar-${color}`} {character} />
		<span class="participant-name" class:participant-name-self={self} aria-hidden="true">{character.name}</span>
	</button>
	{#if tagGameRole === 'holder' && tagGameEffect}
		<span class={['tag-game-effect-visuals', `tag-game-effect-visuals-${tagGameEffect}`, { 'tag-game-effect-visuals-paused': !tagGameEffectActive }]}
			role="img" aria-label={`${tagGameEffect === 'benefit' ? '福' : '鬼'}${tagGameEffectActive ? '' : '・効果停止中'}`}>
			<svg viewBox="0 0 76 76" aria-hidden="true" focusable="false">
				{#if tagGameEffect === 'benefit'}
					<g class="fuku-mallet" data-fuku-mallet>
						<path class="fuku-mallet-handle-outline" d="M51 2L71 20" />
						<path class="fuku-mallet-handle" d="M51 2L71 20" />
						<rect class="fuku-mallet-head" x="34" y="-13" width="34" height="18" rx="9" />
						<path class="fuku-mallet-head-highlight" d="M39 -10H60" />
						<path class="fuku-mallet-endcap" d="M38 -12V4M64 -12V4" />
						<rect class="fuku-mallet-white-band" x="48" y="-9" width="8" height="10" rx="3" />
					</g>
				{:else}
					<g class="oni-horns" data-oni-horns>
						<ellipse class="oni-horn-root" cx="17" cy="18" rx="9" ry="5" />
						<ellipse class="oni-horn-root" cx="59" cy="18" rx="9" ry="5" />
						<path class="oni-horn" d="M12 24C6 19 4 11 7 3C9-3 14-8 19-11C17-3 19 3 23 8C26 13 26 19 23 24Z" />
						<path class="oni-horn" d="M64 24C70 19 72 11 69 3C67-3 62-8 57-11C59-3 57 3 53 8C50 13 50 19 53 24Z" />
						<path class="oni-horn-ridge" d="M10 10C11 3 15-2 18-5M66 10C65 3 61-2 58-5" />
					</g>
				{/if}
			</svg>
		</span>
	{:else if tagGameRole === 'participant'}
		<span class="tag-game-participant-mark" role="img" aria-label="鬼ごっこ参加者"></span>
	{/if}
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
		z-index: 1;
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

	[data-tag-game-holder-transfer] .participant-profile-trigger::after {
		position: absolute;
		inset: -2px;
		border: 2px solid rgba(255, 236, 130, .94);
		border-radius: 50%;
		box-shadow: 0 0 0 2px rgba(255, 255, 255, .86), 0 0 12px rgba(255, 236, 130, .8);
		content: '';
		pointer-events: none;
	}
	.tag-game-touch-target .participant-profile-trigger::before {
		position: absolute;
		inset: -3px;
		z-index: 1;
		border: 2px dashed rgba(244, 214, 106, .92);
		border-radius: 50%;
		box-shadow: 0 0 0 2px rgba(21, 31, 39, .72), 0 0 8px rgba(244, 214, 106, .55);
		content: '';
		pointer-events: none;
	}
	.tag-game-touch-attempt { animation: tag-game-lunge 200ms ease-out; }
	[data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: tag-game-holder-transfer 600ms ease-out both; }
	@keyframes tag-game-lunge {
		0%, 100% { translate: 0 0; }
		34% { translate: var(--tag-game-touch-x) var(--tag-game-touch-y); }
	}
	@keyframes tag-game-holder-transfer {
		0% { opacity: 0; transform: scale(.88); }
		24% { opacity: 1; transform: scale(1.06); }
		100% { opacity: 0; transform: scale(1.14); }
	}
	.tag-game-effect-aura,
	.tag-game-effect-visuals {
		position: absolute;
		inset: 0;
		display: block;
		pointer-events: none;
	}
	.tag-game-effect-aura { z-index: 0; }
	.tag-game-effect-visuals { z-index: 2; }
	.tag-game-effect-aura svg,
	.tag-game-effect-visuals svg { display: block; width: 100%; height: 100%; overflow: visible; }
	.tag-game-effect-aura-paused { opacity: .76; }
	.tag-game-effect-visuals-paused { opacity: .92; }

	.fuku-aura-glow { fill: none; stroke: rgba(255, 244, 225, .76); stroke-width: 5; filter: drop-shadow(0 0 3px rgba(255, 168, 118, .8)); }
	.fuku-aura-ring { fill: none; stroke: rgba(221, 65, 47, .9); stroke-width: 1.9; stroke-dasharray: 12 5 2 8; transform-box: fill-box; transform-origin: center; animation: fuku-aura-turn 9s linear infinite; }
	.fuku-aura-flare { fill: #ffe8a8; stroke: #d94a39; stroke-width: 1; transform-box: fill-box; transform-origin: center; }
	.fuku-aura-flare-one { animation: fuku-aura-flicker 3.8s ease-in-out infinite; }
	.fuku-aura-flare-two { animation: fuku-aura-flicker 4.6s ease-in-out -2s infinite; }
	.tag-game-effect-aura-paused .fuku-aura-ring { stroke-dasharray: 3 4; }
	.tag-game-effect-aura-paused .fuku-aura-ring,
	.tag-game-effect-aura-paused .fuku-aura-flare { animation: none; }

	.oni-aura-shadow { fill: rgba(9, 7, 18, .2); stroke: rgba(18, 13, 31, .9); stroke-width: 4; filter: drop-shadow(0 0 4px rgba(18, 12, 35, .92)); }
	.oni-aura-outline { fill: none; stroke: #78678f; stroke-width: 3; stroke-linecap: square; stroke-linejoin: bevel; filter: drop-shadow(0 0 3px rgba(61, 45, 91, .95)); transform-box: fill-box; transform-origin: center; animation: oni-aura-waver 4.6s ease-in-out infinite alternate; }
	.oni-aura-shard { fill: #252034; stroke: #82729c; stroke-width: 1.2; stroke-linejoin: bevel; transform-box: fill-box; transform-origin: center; }
	.oni-aura-shard-one { animation: oni-aura-shard 3.9s ease-in-out infinite alternate; }
	.oni-aura-shard-two { fill: #342747; animation: oni-aura-shard 4.4s ease-in-out -1.5s infinite alternate-reverse; }
	.oni-aura-shard-three { fill: #1c1927; animation: oni-aura-shard 4.1s ease-in-out -.8s infinite alternate; }
	.oni-aura-shard-four { fill: #30243b; animation: oni-aura-shard 4.3s ease-in-out -1.9s infinite alternate-reverse; }
	.tag-game-effect-aura-paused .oni-aura-outline,
	.tag-game-effect-aura-paused .oni-aura-shard { animation: none; }
	.tag-game-effect-aura-paused .oni-aura-outline { stroke-dasharray: 5 3; }

	.fuku-mallet { stroke-linecap: round; stroke-linejoin: round; }
	.fuku-mallet-handle-outline { fill: none; stroke: #a82e2d; stroke-width: 10; }
	.fuku-mallet-handle { fill: none; stroke: #fff4e6; stroke-width: 6; }
	.fuku-mallet-head { fill: #dc4938; stroke: #fff5e9; stroke-width: 2; }
	.fuku-mallet-head-highlight { fill: none; stroke: #ffb99a; stroke-width: 1.5; }
	.fuku-mallet-endcap { fill: none; stroke: #f0cc76; stroke-width: 2.2; }
	.fuku-mallet-white-band { fill: #fff7ed; stroke: #b63831; stroke-width: .8; }

	.oni-horn-root { fill: #171323; stroke: #88779f; stroke-width: 1.5; }
	.oni-horn { fill: #201a2b; stroke: #9a8aaf; stroke-width: 2.2; stroke-linejoin: round; }
	.oni-horn-ridge { fill: none; stroke: #c2b5cf; stroke-width: 1.7; stroke-linecap: round; opacity: .82; }

	.tag-game-participant-mark {
		position: absolute;
		top: 2px;
		right: 2px;
		z-index: 1;
		width: 9px;
		height: 9px;
		border: 2px solid #fff;
		border-radius: 50%;
		background: #58717d;
		box-shadow: 0 0 0 1px rgba(47, 68, 78, .65);
		pointer-events: none;
	}
	@keyframes fuku-aura-turn { to { transform: rotate(360deg); } }
	@keyframes fuku-aura-flicker { 0%, 22%, 100% { opacity: .4; transform: scale(.8); } 48% { opacity: 1; transform: scale(1.16); } }
	@keyframes oni-aura-waver { from { transform: rotate(-1.2deg) translateY(0); opacity: .78; } to { transform: rotate(1.2deg) translateY(1px); opacity: 1; } }
	@keyframes oni-aura-shard { from { opacity: .5; transform: translateY(1px) rotate(-2deg); } to { opacity: .95; transform: translateY(-1px) rotate(3deg); } }

	@media (prefers-reduced-motion: reduce) {
		.tag-game-touch-attempt, [data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: none; }
		.tag-game-effect-aura * { animation: none !important; }
		.tag-game-effect-aura-paused,
		.tag-game-effect-visuals-paused { opacity: .84; }
		.tag-game-touch-attempt .participant-profile-trigger { outline: 3px solid rgba(244, 214, 106, .92); outline-offset: 3px; }
		[data-tag-game-holder-transfer] .participant-profile-trigger::after { opacity: 1; transform: scale(1.08); }
	}
</style>
