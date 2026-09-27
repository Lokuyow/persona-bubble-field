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
					<g class="fuku-halo" fill="none" pointer-events="none">
						<circle class="fuku-halo-soft-ring" cx="38" cy="38" r="37.4" stroke="#d94a36" stroke-width="5" opacity=".28" />
						<circle class="fuku-halo-light-ring" cx="38" cy="38" r="39.2" stroke="#fff9f1" stroke-width="1.7" opacity=".66" />
						<g class="fuku-halo-rays" transform="translate(38 38)">
							<g class="fuku-halo-rays-warm" fill="#df4c36" stroke="#fff6ed" stroke-width=".9" opacity=".69">
								<path d="M-1.5-35 L-2.9-44.5 L2.9-44.5 L1.5-35Z" transform="rotate(-121)" />
								<path d="M-1.5-35 L-2.9-44.5 L2.9-44.5 L1.5-35Z" transform="rotate(-72)" />
								<path d="M-1.5-35 L-2.9-44.5 L2.9-44.5 L1.5-35Z" transform="rotate(-25)" />
								<path d="M-1.5-35 L-2.9-44.5 L2.9-44.5 L1.5-35Z" transform="rotate(99)" />
							</g>
							<g class="fuku-halo-rays-light" fill="#fffdfa" stroke="#dd5a44" stroke-width=".95" opacity=".76">
								<path d="M-1.4-35 L-2.6-43 L2.6-43 L1.4-35Z" transform="rotate(-143)" />
								<path d="M-1.4-35 L-2.6-43 L2.6-43 L1.4-35Z" transform="rotate(-96)" />
								<path d="M-1.4-35 L-2.6-43 L2.6-43 L1.4-35Z" transform="rotate(-48)" />
								<path d="M-1.4-35 L-2.6-43 L2.6-43 L1.4-35Z" transform="rotate(0)" />
								<path d="M-1.4-35 L-2.6-43 L2.6-43 L1.4-35Z" transform="rotate(123)" />
							</g>
						</g>
					</g>
				{:else}
					<g class="oni-smoke oni-smoke-left"><path d="M20 4C12 -2 5 7 7 13C-5 15 -10 28 -4 34C-13 41 -9 52 1 54C-1 64 10 70 22 70C16 61 18 55 22 49C15 42 15 37 22 31C14 23 16 15 20 4Z" fill="#68458e" fill-opacity=".27" stroke="#b19bd1" stroke-opacity=".4" stroke-width="1.35" /></g>
					<g class="oni-smoke oni-smoke-right"><path d="M57 16C69 8 78 18 75 27C86 31 87 39 78 45C89 55 77 65 65 64C64 69 58 71 52 72C58 63 57 58 53 52C63 45 64 36 57 29Z" fill="#392948" fill-opacity=".29" stroke="#a68bc5" stroke-opacity=".44" stroke-width="1.4" /></g>
					<path class="oni-smoke-trail" d="M17 51C6 54 6 65 19 70C27 72 30 77 38 77C46 77 54 74 58 67" fill="none" stroke="#8a69b1" stroke-opacity=".25" stroke-width="3.2" stroke-linecap="round" />
					<path class="oni-smoke-particle" d="M3 27L6 30L3 33L0 30ZM80 40L84 44L80 48L76 44ZM65 70L68 73L65 76L62 73Z" fill="#76539a" fill-opacity=".3" />
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
					<g class="fuku-mallet" data-fuku-mallet transform="translate(69 11) rotate(-28)">
						<rect class="fuku-mallet-handle" data-fuku-mallet-handle x="-3" y="-11" width="6" height="30" rx="1.8" fill="#ffe3ab" stroke="white" stroke-width="2" />
						<rect class="fuku-mallet-head" data-fuku-mallet-head x="-15" y="-25" width="30" height="16" rx="5.8" fill="#e23c2c" stroke="white" stroke-width="2.4" />
						<path class="fuku-mallet-endcap" d="M-9.5 -22V-12M9.5 -22V-12" stroke="#ffdc83" stroke-width="3.5" stroke-linecap="round" />
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

	.oni-smoke { transform-box: fill-box; transform-origin: center; }
	.oni-smoke-left { animation: oni-smoke-drift 9s ease-in-out infinite alternate; }
	.oni-smoke-right { animation: oni-smoke-drift 10s ease-in-out -5s infinite alternate-reverse; }
	.oni-smoke-trail,
	.oni-smoke-particle { pointer-events: none; }
	.tag-game-effect-aura-paused .oni-smoke { animation: none; }

	.fuku-mallet { stroke-linecap: round; stroke-linejoin: round; }

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
	@keyframes oni-smoke-drift { from { transform: translate(.6px, .3px) scale(.985); opacity: .8; } to { transform: translate(-.8px, -.4px) scale(1.015); opacity: 1; } }

	@media (prefers-reduced-motion: reduce) {
		.tag-game-touch-attempt, [data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: none; }
		.tag-game-effect-aura * { animation: none !important; }
		.tag-game-effect-aura-paused,
		.tag-game-effect-visuals-paused { opacity: .84; }
		.tag-game-touch-attempt .participant-profile-trigger { outline: 3px solid rgba(244, 214, 106, .92); outline-offset: 3px; }
		[data-tag-game-holder-transfer] .participant-profile-trigger::after { opacity: 1; transform: scale(1.08); }
	}
</style>
