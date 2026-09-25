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
	{#if tagGameRole === 'holder'}
		<span class={['tag-game-holder-label', { 'tag-game-holder-label-paused': !tagGameEffectActive }]} role="img" aria-label={`${tagGameEffect === 'benefit' ? '恩恵' : '災厄'}${tagGameEffectActive ? '' : '・効果停止中'}`}>
			<strong>{tagGameEffect === 'benefit' ? '恩恵' : '災厄'}</strong>
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

	[data-tag-game-role='holder'] .participant-profile-trigger::after {
		position: absolute;
		inset: 1px;
		border: 3px solid #2e8b57;
		border-radius: 50%;
		box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 0 10px rgba(46, 139, 87, .68);
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
	[data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: tag-game-holder-transfer 600ms ease-out; }
	@keyframes tag-game-lunge {
		0%, 100% { translate: 0 0; }
		34% { translate: var(--tag-game-touch-x) var(--tag-game-touch-y); }
	}
	@keyframes tag-game-holder-transfer {
		0% { box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 0 3px 2px rgba(255, 236, 130, .9); }
		100% { box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 0 10px rgba(46, 139, 87, .68); }
	}
	[data-tag-game-role='holder'][data-tag-game-effect='calamity'] .participant-profile-trigger::after { border-color: #b4483b; box-shadow: 0 0 0 2px rgba(255, 255, 255, .9), 0 0 10px rgba(180, 72, 59, .68); }
	[data-tag-game-role='holder'][data-tag-game-effect-active='false'] .participant-profile-trigger::after { border-style: dashed; opacity: .62; }
	.tag-game-holder-label {
		position: absolute;
		top: -25px;
		left: 50%;
		z-index: 2;
		display: block;
		max-width: calc(var(--cell-size) - 4px);
		padding: 2px 6px;
		border: 1px solid rgba(255, 255, 255, .9);
		border-radius: 999px;
		background: #e4f2e9;
		box-shadow: 0 1px 5px rgba(0, 0, 0, .25);
		transform: translateX(-50%);
		white-space: nowrap;
		pointer-events: none;
	}
	.tag-game-holder-label strong { color: #226b42; font-size: 10px; }
	[data-tag-game-effect='calamity'] .tag-game-holder-label { background: #f7e8e5; }
	[data-tag-game-effect='calamity'] .tag-game-holder-label strong { color: #85372e; }
	.tag-game-holder-label-paused { opacity: .72; }
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
	@media (max-width: 700px) {
		.tag-game-holder-label { top: -24px; max-width: calc(var(--cell-size) - 2px); padding: 2px 5px; }
		.tag-game-holder-label strong { font-size: 9px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.tag-game-touch-attempt, [data-tag-game-holder-transfer] .participant-profile-trigger::after { animation: none; }
		.tag-game-touch-attempt .participant-profile-trigger { outline: 3px solid rgba(244, 214, 106, .92); outline-offset: 3px; }
		[data-tag-game-holder-transfer] .participant-profile-trigger::after { box-shadow: 0 0 0 3px rgba(255, 236, 130, .9), 0 0 12px rgba(255, 236, 130, .8); }
	}
</style>
