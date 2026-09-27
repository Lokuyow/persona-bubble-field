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
					<path class="fuku-aura-glow" d="M17 -3Q24 2 29 -7L34 -4L38 -10L43 -3L50 -7L56 2Q61 -2 65 1M79 15L73 23L84 28L79 34M83 50L75 56L81 63L72 66M57 80L50 75L43 85L37 79M22 83L20 74L11 78L8 70M-7 55L1 49L-8 42L-3 37M-9 23L1 20L-4 12L5 10" />
					<path class="fuku-aura-ring" d="M17 -3L23 2L29 -7L34 -4L38 -10L43 -3L50 -7L56 2L65 1M79 15L73 23L84 28L79 34M83 50L75 56L81 63L72 66M57 80L50 75L43 85L37 79M22 83L20 74L11 78L8 70M-7 55L1 49L-8 42L-3 37M-9 23L1 20L-4 12L5 10" />
					<path class="fuku-aura-flare fuku-aura-flare-one" d="M13 -6L20 0L16 8L8 5Z" />
					<path class="fuku-aura-flare fuku-aura-flare-two" d="M75 47L84 51L79 61L71 57Z" />
					<path class="fuku-aura-flare fuku-aura-flare-three" d="M-7 35L-12 27L-3 24L2 31Z" />
				{:else}
					<path class="oni-aura-shadow" d="M35 -10L42 -6L48 -10L52 -2L62 -5L63 4L74 5L70 15L83 18L77 27L86 34L78 40L84 48L74 53L78 62L66 64L63 77L53 72L46 84L39 77L31 86L26 76L15 81L13 69L2 67L6 57L-8 52L-1 43L-10 36L-1 29L-7 18L4 13L2 3L15 6L20 -5L29 0Z" />
					<path class="oni-aura-outline" d="M35 -10L42 -6L48 -10L52 -2L62 -5L63 4L74 5L70 15L83 18L77 27M86 34L78 40L84 48L74 53M78 62L66 64L63 77L53 72M46 84L39 77L31 86L26 76L15 81M13 69L2 67L6 57L-8 52M-10 36L-1 29L-7 18L4 13L2 3L15 6L20 -5L29 0" />
					<path class="oni-aura-shard oni-aura-shard-one" d="M26 0L32 -10L39 2Z" />
					<path class="oni-aura-shard oni-aura-shard-two" d="M78 23L88 30L77 36Z" />
					<path class="oni-aura-shard oni-aura-shard-three" d="M53 75L49 87L42 77Z" />
					<path class="oni-aura-shard oni-aura-shard-four" d="M-8 44L-13 35L0 32Z" />
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
						<path class="fuku-mallet-handle-outline" d="M62 -1L74 16" />
						<path class="fuku-mallet-handle" d="M62 -1L74 16" />
						<rect class="fuku-mallet-head" x="36" y="-20" width="34" height="19" rx="9.5" />
						<path class="fuku-mallet-head-highlight" d="M42 -16H64" />
						<path class="fuku-mallet-endcap" d="M39 -17V-5M67 -17V-5" />
						<rect class="fuku-mallet-white-band" x="51" y="-18" width="7" height="15" rx="3" />
					</g>
				{:else}
					<g class="oni-horns" data-oni-horns>
						<ellipse class="oni-horn-root" cx="18" cy="20" rx="8" ry="5.5" />
						<ellipse class="oni-horn-root" cx="58" cy="20" rx="8" ry="5.5" />
						<path class="oni-horn" d="M10 24Q8 21 10 17L16 -10Q18 -16 22 -11L28 17Q29 22 25 24Q18 27 10 24Z" />
						<path class="oni-horn" d="M66 24Q68 21 66 17L60 -10Q58 -16 54 -11L48 17Q47 22 51 24Q58 27 66 24Z" />
						<path class="oni-horn-ridge" d="M12 16L18 -9M64 16L58 -9" />
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

	.fuku-aura-glow { fill: none; stroke: rgba(255, 244, 225, .9); stroke-width: 7; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 4px rgba(255, 143, 102, .95)); }
	.fuku-aura-ring { fill: none; stroke: rgba(221, 65, 47, .98); stroke-width: 3.4; stroke-dasharray: 22 7 5 12 2 9; stroke-linecap: square; stroke-linejoin: bevel; transform-box: fill-box; transform-origin: center; animation: fuku-aura-waver 5.7s ease-in-out infinite alternate; }
	.fuku-aura-flare { fill: #fff1c9; stroke: #d94a39; stroke-width: 1.2; stroke-linejoin: bevel; transform-box: fill-box; transform-origin: center; }
	.fuku-aura-flare-one { animation: fuku-aura-flicker 3.8s ease-in-out infinite; }
	.fuku-aura-flare-two { fill: #e95b42; stroke: #ffe4a4; animation: fuku-aura-flicker 4.6s ease-in-out -2s infinite; }
	.fuku-aura-flare-three { fill: #ffd789; stroke: #fff4df; animation: fuku-aura-flicker 5.2s ease-in-out -3.1s infinite; }
	.tag-game-effect-aura-paused .fuku-aura-ring { stroke-dasharray: 5 4 2 7; }
	.tag-game-effect-aura-paused .fuku-aura-ring,
	.tag-game-effect-aura-paused .fuku-aura-flare { animation: none; }

	.oni-aura-shadow { fill: rgba(9, 7, 18, .34); stroke: rgba(18, 13, 31, .98); stroke-width: 5; filter: drop-shadow(0 0 5px rgba(18, 12, 35, .98)); }
	.oni-aura-outline { fill: none; stroke: #a493bc; stroke-width: 4.2; stroke-linecap: square; stroke-linejoin: bevel; filter: drop-shadow(0 0 4px rgba(61, 45, 91, 1)); transform-box: fill-box; transform-origin: center; animation: oni-aura-waver 4.6s ease-in-out infinite alternate; }
	.oni-aura-shard { fill: #252034; stroke: #aa98c4; stroke-width: 1.8; stroke-linejoin: bevel; transform-box: fill-box; transform-origin: center; }
	.oni-aura-shard-one { animation: oni-aura-shard 3.9s ease-in-out infinite alternate; }
	.oni-aura-shard-two { fill: #342747; animation: oni-aura-shard 4.4s ease-in-out -1.5s infinite alternate-reverse; }
	.oni-aura-shard-three { fill: #1c1927; animation: oni-aura-shard 4.1s ease-in-out -.8s infinite alternate; }
	.oni-aura-shard-four { fill: #30243b; animation: oni-aura-shard 4.3s ease-in-out -1.9s infinite alternate-reverse; }
	.tag-game-effect-aura-paused .oni-aura-outline,
	.tag-game-effect-aura-paused .oni-aura-shard { animation: none; }
	.tag-game-effect-aura-paused .oni-aura-outline { stroke-dasharray: 5 3; }

	.fuku-mallet { stroke-linecap: round; stroke-linejoin: round; }
	.fuku-mallet-handle-outline { fill: none; stroke: #a82e2d; stroke-width: 9; }
	.fuku-mallet-handle { fill: none; stroke: #fff4e6; stroke-width: 5; }
	.fuku-mallet-head { fill: #dc4938; stroke: #fff5e9; stroke-width: 2; }
	.fuku-mallet-head-highlight { fill: none; stroke: #ffb99a; stroke-width: 1.5; }
	.fuku-mallet-endcap { fill: none; stroke: #f0cc76; stroke-width: 2.2; }
	.fuku-mallet-white-band { fill: #fff7ed; stroke: #b63831; stroke-width: .8; }

	.oni-horn-root { fill: #110e1c; stroke: #a493bc; stroke-width: 2; }
	.oni-horn { fill: #201a2b; stroke: #b0a0c5; stroke-width: 2.8; stroke-linejoin: round; }
	.oni-horn-ridge { fill: none; stroke: #c2b5cf; stroke-width: 2; stroke-linecap: round; opacity: .9; }

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
	@keyframes fuku-aura-waver { from { transform: rotate(-1.2deg) translateY(0); opacity: .68; } to { transform: rotate(1.1deg) translateY(1px); opacity: 1; } }
	@keyframes fuku-aura-flicker { 0%, 22%, 100% { opacity: .48; transform: scale(.84) rotate(-3deg); } 48% { opacity: 1; transform: scale(1.12) rotate(4deg); } }
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
