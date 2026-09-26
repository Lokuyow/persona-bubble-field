<script lang="ts">
	import PrimaryButton from '$lib/PrimaryButton.svelte';
	import { canLeaveTagGame, formatTagGameRemainingTime, isTagGameScheduledEffectActive, tagGameTransferStatus } from '$lib/tagGameHud';
	import { tagGameScheduledEffectAt } from '$lib/tagGame';
	import { tagGameParticipantLabel } from '$lib/tagGamePresentation';
	import type { TagGameState } from '$lib/tagGame';

	type Props = Readonly<{
		game: TagGameState | null;
		selfPubkey: string | null;
		selfRunNumber: number | null;
		nowMs: number;
		realtimeStatus: 'inactive' | 'active' | 'degraded';
		busy: boolean;
		localEffectPaused?: boolean;
		touchStatus?: string | null;
		onLeave: (gameId: string) => void;
	}>;

	let { game, selfPubkey, selfRunNumber, nowMs, realtimeStatus, busy, localEffectPaused = false, touchStatus = null, onLeave }: Props = $props();
	const own = $derived(game?.participant.find((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber) ?? null);
	const holder = $derived(game?.participant.find((member) => member.pubkey === game.ownerPubkey) ?? null);
	const endsAtMs = $derived((game?.endsAt ?? 0) * 1000);
	const remaining = $derived(game ? formatTagGameRemainingTime(endsAtMs, nowMs) : '00:00');
	const scheduledEffect = $derived(game ? tagGameScheduledEffectAt(game, nowMs) : null);
	const effectScheduleCurrent = $derived(Boolean(game && isTagGameScheduledEffectActive(game, nowMs)));
	const effectActive = $derived(Boolean(game && effectScheduleCurrent && !game.holderChallengeId && !localEffectPaused && holder?.status === 'active'));
	const pausedLabel = $derived(game?.phase === 'settling' || (game?.phase === 'running' && nowMs >= endsAtMs)
		? '最終精算中・効果停止'
		: game?.holderChallengeId ? '応答確認中・効果停止'
			: holder?.status === 'temporarily-ineligible' ? '所持者が一時対象外・効果停止'
				: localEffectPaused ? '安全停止中・効果停止'
					: '効果停止中');
	const currentEffect = $derived(scheduledEffect ?? game?.effect ?? null);
	const effectName = $derived(currentEffect === 'benefit' ? '恩恵' : '災厄');
	const holderName = $derived(game?.ownerPubkey && game ? tagGameParticipantLabel(game, game.ownerPubkey, selfPubkey) : '未定');
	const effectAction = $derived(currentEffect === 'benefit' ? '所持者以外が追いかけて奪う' : '所持者が追いかけて押し付ける');
	const transferStatus = $derived(game ? tagGameTransferStatus(game, effectActive, nowMs) : '転移不可');
	const canLeave = $derived(Boolean(game && canLeaveTagGame(game, own?.status, nowMs)));
</script>

{#if game}
	<aside class="game-hud" aria-label="鬼ごっこ進行状況" data-tag-game-hud data-tag-game-hud-id={game.gameId} data-realtime-status={realtimeStatus}>
		<div class="game-hud-time" aria-label={`残り ${remaining}`}><span>残り</span><strong data-tag-game-remaining>{remaining}</strong></div>
		<div class={['game-hud-effect', currentEffect ?? 'calamity', { paused: !effectActive }]} data-tag-game-effect={currentEffect} data-tag-game-effect-active={effectActive ? 'true' : 'false'}>
			<strong>{effectName}・{holderName}</strong>
			<span>{effectActive ? effectAction : pausedLabel}</span>
		</div>
		<div class="game-hud-footer">
			<span data-tag-game-cooldown>{transferStatus}</span>
			{#if canLeave}<PrimaryButton class="tag-game-leave" data-tag-game-leave={game.gameId} onclick={() => onLeave(game.gameId)} disabled={busy}>退出</PrimaryButton>{/if}
		</div>
		{#if touchStatus}<p class="touch-status" data-tag-game-touch-status aria-live="polite">{touchStatus}</p>{/if}
	</aside>
{/if}

<style>
	.game-hud { width: min(310px, 100%); padding: 8px 11px; border: 1px solid rgba(170, 183, 195, .42); border-radius: 10px; background: linear-gradient(145deg, rgba(10, 17, 35, .84), rgba(15, 17, 42, .76)); box-shadow: 0 4px 16px rgba(0, 0, 0, .2), inset 0 0 12px rgba(100, 105, 220, .06); color: rgba(239, 241, 255, .94); font-size: 12px; line-height: 1.25; pointer-events: none; }
	.game-hud-time { display: flex; align-items: baseline; gap: 8px; }
	.game-hud-time span { color: rgba(226, 230, 255, .82); font-weight: 700; }
	.game-hud-time strong { font-size: 30px; font-weight: 850; line-height: 1; font-variant-numeric: tabular-nums; font-feature-settings: 'tnum'; letter-spacing: .015em; }
	.game-hud-effect { display: grid; gap: 2px; margin-top: 6px; padding: 6px 8px; border-left: 3px solid #2e8b57; border-radius: 5px; background: rgba(46, 139, 87, .18); }
	.game-hud-effect.calamity { border-color: #d15b4e; background: rgba(180, 72, 59, .2); }
	.game-hud-effect.paused { border-style: dashed; opacity: .78; }
	.game-hud-effect span { color: rgba(226, 230, 255, .88); }
	.game-hud-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; margin-top: 3px; }
	.game-hud-footer > span { font-weight: 650; }
	.touch-status { margin: 3px 0 0; color: rgba(226, 230, 255, .78); font-size: .9em; }
	.game-hud :global(.tag-game-leave) { min-height: 32px; padding: 4px 10px; pointer-events: auto; }
	@media (max-width: 700px) {
		.game-hud { width: min(252px, 100%); padding: 6px 8px; border-radius: 8px; font-size: 11px; }
		.game-hud-time strong { font-size: 25px; }
		.game-hud-effect { margin-top: 4px; padding: 5px 7px; }
		.game-hud-footer { min-height: 30px; }
	}
</style>
