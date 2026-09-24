<script lang="ts">
	import PrimaryButton from '$lib/PrimaryButton.svelte';
	import type { TagGameState } from '$lib/tagGame';
	type Props = Readonly<{
		open: boolean;
		games: readonly TagGameState[];
		selfPubkey: string | null;
		nowMs: number;
		busy?: boolean;
		onCreate: () => void;
		onJoin: (gameId: string) => void;
		onLeave: (gameId: string) => void;
		onPropose: (gameId: string) => void;
		onConsent: (gameId: string, proposalId: string) => void;
		onExclude: (gameId: string, pubkey: string) => void;
		onClose: () => void;
	}>;
	let { open, games, selfPubkey, nowMs, busy = false, onCreate, onJoin, onLeave, onPropose, onConsent, onExclude, onClose }: Props = $props();
	const labels = { lobby: '募集中', proposed: '開始確認中', countdown: '開始準備中', running: '開催中', settling: '最終精算中', ended: '終了', interrupted: '中断' } as const;
</script>

{#if open}
	<div class="backdrop">
		<div class="panel" role="dialog" aria-modal="true" aria-labelledby="tag-game-title">
			<header><h2 id="tag-game-title">鬼ごっこ</h2><button type="button" aria-label="閉じる" onclick={onClose}>×</button></header>
			<p>最大8人、3分間のプレイヤー主催イベントです。募集参加中も脱出と能力強化を行えます。</p>
			<PrimaryButton onclick={onCreate} disabled={busy || !selfPubkey}>鬼ごっこを開催</PrimaryButton>
			{#if games.length === 0}<p>現在募集中の開催はありません。</p>{/if}
			<ul>
				{#each games as game (game.gameId)}
					<li>
						<div><strong>{game.hostPubkey === selfPubkey ? 'あなたの開催' : `開催者 ${game.hostPubkey.slice(0, 8)}`}</strong><span>{labels[game.phase]}・{game.participant.filter((player) => player.status === 'registered' || player.status === 'active').length}/8人</span></div>
						{#if game.ownerPubkey}<p class="game-status">所持者 {game.ownerPubkey === selfPubkey ? 'あなた' : game.ownerPubkey.slice(0, 8)}・{game.effect === 'benefit' ? '恩恵' : '災厄'}{#if game.endsAt}・残り{Math.max(0, Math.ceil((game.endsAt * 1000 - nowMs) / 1000))}秒{/if}</p>{/if}
						{#if game.phase === 'ended' || game.phase === 'interrupted'}
							<div class="results" aria-label="鬼ごっこ結果">
								{#each game.participant as player (player.pubkey)}
									<span>{player.pubkey === selfPubkey ? 'あなた' : player.pubkey.slice(0, 8)}・{player.status === 'dead' ? '死亡' : player.status === 'left' ? '脱出' : player.status === 'temporarily-ineligible' ? '一時対象外' : '参加'}・{player.points}pt・寿命-{Math.ceil(player.lifespanLossMs / 60_000)}分</span>
								{/each}
							</div>
						{/if}
						{#if game.phase === 'lobby'}
							{#if game.participant.some((player) => player.pubkey === selfPubkey)}
								<PrimaryButton onclick={() => onLeave(game.gameId)} disabled={busy}>辞退</PrimaryButton>
								{#if game.hostPubkey === selfPubkey}<PrimaryButton onclick={() => onPropose(game.gameId)} disabled={busy || game.participant.length < 2}>開始を提案</PrimaryButton>{/if}
							{:else}<PrimaryButton onclick={() => onJoin(game.gameId)} disabled={busy || !selfPubkey || game.participant.length >= 8}>参加申請</PrimaryButton>{/if}
						{:else if game.phase === 'proposed' && game.proposalId && game.participant.some((player) => player.pubkey === selfPubkey)}
							{#if game.participant.find((player) => player.pubkey === selfPubkey)?.consentProposalId === game.proposalId}
								<span>同意済み</span>
							{:else}<PrimaryButton onclick={() => onConsent(game.gameId, game.proposalId!)} disabled={busy}>開始に同意</PrimaryButton>{/if}
							<PrimaryButton onclick={() => onLeave(game.gameId)} disabled={busy}>今回は辞退</PrimaryButton>
						{/if}
						{#if game.phase === 'proposed' && game.hostPubkey === selfPubkey}
							{#each game.participant.filter((player) => player.pubkey !== selfPubkey && player.consentProposalId !== game.proposalId) as player (player.pubkey)}
								<PrimaryButton onclick={() => onExclude(game.gameId, player.pubkey)} disabled={busy}>未応答者を除外して再提案</PrimaryButton>
							{/each}
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.backdrop { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: rgba(20, 24, 30, .48); }
	.panel { width: min(520px, 100%); max-height: min(80vh, 720px); overflow: auto; padding: 20px; border-radius: 16px; background: var(--surface, #fff); color: var(--text-primary, #20242a); box-shadow: 0 18px 60px rgba(0,0,0,.24); }
	header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
	h2 { margin: 0; }
	header button { width: 44px; height: 44px; border: 0; background: transparent; font-size: 24px; }
	ul { display: grid; gap: 10px; margin: 16px 0 0; padding: 0; list-style: none; }
	li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; padding: 12px; border: 1px solid var(--border-subtle, #d8dce0); border-radius: 10px; }
	li div { display: grid; gap: 3px; }
	.game-status { width: 100%; margin: 0; }
	.results { display: grid; width: 100%; gap: 3px; color: var(--text-secondary, #666); font-size: .88rem; }
	li span { color: var(--text-secondary, #666); font-size: .9rem; }
</style>
