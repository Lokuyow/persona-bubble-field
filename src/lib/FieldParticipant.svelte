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
			role="img" aria-label={`${tagGameEffect === 'benefit' ? '祝福' : '呪い'}${tagGameEffectActive ? '' : '・効果停止中'}`}>
			<svg viewBox="0 0 76 76" aria-hidden="true" focusable="false">
				{#if tagGameEffect === 'benefit'}
					<circle class="blessing-halo" cx="38" cy="38" r="34.5" />
					<circle class="blessing-orbit" cx="38" cy="38" r="36" />
					<path class="blessing-star blessing-star-one" d="M0 -5L1.4 -1.4L5 0L1.4 1.4L0 5L-1.4 1.4L-5 0L-1.4 -1.4Z" transform="translate(38 2)" />
					<path class="blessing-star blessing-star-two" d="M0 -5L1.4 -1.4L5 0L1.4 1.4L0 5L-1.4 1.4L-5 0L-1.4 -1.4Z" transform="translate(74 38) scale(.8)" />
					<path class="blessing-star blessing-star-three" d="M0 -5L1.4 -1.4L5 0L1.4 1.4L0 5L-1.4 1.4L-5 0L-1.4 -1.4Z" transform="translate(38 74) scale(.72)" />
					<path class="blessing-star blessing-star-four" d="M0 -5L1.4 -1.4L5 0L1.4 1.4L0 5L-1.4 1.4L-5 0L-1.4 -1.4Z" transform="translate(2 38) scale(.86)" />
				{:else}
					<path class="curse-shadow" d="M35 2L42 4L47 2L51 9L60 10L59 17L68 20L64 27L74 34L68 39L73 47L64 51L66 58L57 60L52 72L44 68L38 74L32 68L23 72L20 63L11 60L15 53L3 48L10 42L2 34L9 29L5 21L14 18L17 9L27 11Z" />
					<path class="curse-outline" d="M35 2L42 4L47 2L51 9L60 10L59 17L68 20L64 27M74 34L68 39L73 47L64 51M66 58L57 60L52 72L44 68M38 74L32 68L23 72M20 63L11 60L15 53L3 48M2 34L9 29L5 21L14 18L17 9L27 11" />
					<path class="curse-shard curse-shard-one" d="M31 8L37 1L40 11Z" />
					<path class="curse-shard curse-shard-two" d="M67 31L75 37L65 41Z" />
					<path class="curse-shard curse-shard-three" d="M42 67L37 75L33 66Z" />
					<path class="curse-shard curse-shard-four" d="M9 42L1 37L11 33Z" />
					<path class="curse-crack" d="M25 17L30 25L27 31M52 49L46 46L43 53" />
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
	.tag-game-effect-visuals {
		position: absolute;
		inset: 0;
		z-index: 0;
		display: block;
		pointer-events: none;
	}
	.tag-game-effect-visuals svg { display: block; width: 100%; height: 100%; overflow: visible; }
	.tag-game-effect-visuals-paused { opacity: .76; }
	.tag-game-effect-visuals-paused .blessing-orbit { stroke-dasharray: 2 4; }
	.tag-game-effect-visuals-paused .blessing-orbit,
	.tag-game-effect-visuals-paused .blessing-star { animation: none; }
	.blessing-halo { fill: none; stroke: rgba(255, 249, 222, .76); stroke-width: 5; filter: drop-shadow(0 0 3px rgba(255, 233, 164, .88)); }
	.blessing-orbit { fill: none; stroke: rgba(229, 201, 126, .86); stroke-width: 1.6; stroke-dasharray: 13 6 3 7; transform-box: fill-box; transform-origin: center; animation: blessing-orbit 8s linear infinite; }
	.blessing-star { fill: #fff9df; stroke: #e7c875; stroke-width: .7; transform-box: fill-box; transform-origin: center; filter: drop-shadow(0 0 2px rgba(255, 229, 151, .95)); }
	.blessing-star-one { animation: blessing-sparkle 2.7s ease-in-out infinite; }
	.blessing-star-two { animation: blessing-sparkle 3.1s ease-in-out -1.2s infinite; }
	.blessing-star-three { animation: blessing-sparkle 3.5s ease-in-out -.7s infinite; }
	.blessing-star-four { animation: blessing-sparkle 2.9s ease-in-out -2s infinite; }
	.curse-shadow { fill: rgba(37, 22, 65, .24); stroke: rgba(54, 31, 91, .48); stroke-width: 4; filter: drop-shadow(0 0 3px rgba(48, 24, 77, .62)); }
	.curse-outline { fill: none; stroke: #a35cb0; stroke-width: 3.8; stroke-linecap: square; stroke-linejoin: bevel; filter: drop-shadow(0 0 3px rgba(214, 72, 170, .96)); transform-box: fill-box; transform-origin: center; animation: curse-waver 3.8s ease-in-out infinite alternate; }
	.curse-shard { fill: #d45ca8; stroke: #4e286d; stroke-width: 1.1; transform-box: fill-box; transform-origin: center; }
	.curse-shard-one { animation: curse-shard 3.3s ease-in-out infinite alternate; }
	.curse-shard-two { fill: #8e47a7; animation: curse-shard 4s ease-in-out -1.5s infinite alternate-reverse; }
	.curse-shard-three { fill: #b34791; animation: curse-shard 3.7s ease-in-out -.8s infinite alternate; }
	.curse-shard-four { fill: #a747a2; animation: curse-shard 3.5s ease-in-out -1.9s infinite alternate-reverse; }
	.curse-crack { fill: none; stroke: #b04b98; stroke-width: 1.4; stroke-linecap: square; opacity: .86; }
	.tag-game-effect-visuals-paused .curse-outline,
	.tag-game-effect-visuals-paused .curse-shard { animation: none; }
	.tag-game-effect-visuals-paused .curse-outline { stroke-dasharray: 5 3; }
	@keyframes blessing-orbit { to { transform: rotate(360deg); } }
	@keyframes blessing-sparkle { 0%, 22%, 100% { opacity: .34; transform: scale(.72); } 48% { opacity: 1; transform: scale(1.18); } }
	@keyframes curse-waver { from { transform: rotate(-1.5deg) translateY(0); opacity: .82; } to { transform: rotate(1.5deg) translateY(1px); opacity: 1; } }
	@keyframes curse-shard { from { opacity: .52; transform: translateY(1px) rotate(-2deg); } to { opacity: 1; transform: translateY(-1px) rotate(3deg); } }
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
	@media (prefers-reduced-motion: reduce) {
		.tag-game-touch-attempt, [data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: none; }
		.tag-game-effect-visuals * { animation: none !important; }
		.tag-game-touch-attempt .participant-profile-trigger { outline: 3px solid rgba(244, 214, 106, .92); outline-offset: 3px; }
		[data-tag-game-holder-transfer] .participant-profile-trigger::after { opacity: 1; transform: scale(1.08); }
	}
</style>
