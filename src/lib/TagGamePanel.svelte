<script lang="ts">
	import PrimaryButton from '$lib/PrimaryButton.svelte';
	import { createTagGameSchedule, tagGamePredictedRemainingLifespanMinutes, TAG_GAME_BENEFIT_POINTS_PER_SECOND, TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND, type TagGameState } from '$lib/tagGame';
	type Props = Readonly<{
		open: boolean;
		games: readonly TagGameState[];
		selfPubkey: string | null;
		selfRunNumber: number | null;
		hudGameId: string | null;
		watchedGameId: string | null;
		effectiveLifespanMs: number | null;
		realtimeStatus: 'inactive' | 'active' | 'degraded';
		nowMs: number;
		busy?: boolean;
		onCreate: () => void;
		onJoin: (gameId: string) => void;
		onLeave: (gameId: string) => void;
		onPropose: (gameId: string) => void;
		onConsent: (gameId: string, proposalId: string) => void;
		onExclude: (gameId: string, pubkey: string) => void;
		onWatch: (gameId: string) => void;
		onStopWatching: () => void;
		onClose: () => void;
	}>;
	let { open, games, selfPubkey, selfRunNumber, hudGameId, watchedGameId, effectiveLifespanMs, realtimeStatus, nowMs, busy = false, onCreate, onJoin, onLeave, onPropose, onConsent, onExclude, onWatch, onStopWatching, onClose }: Props = $props();
	const labels = { lobby: '募集中', proposed: '開始確認中', countdown: '開始準備中', running: '開催中', settling: '最終精算中', ended: '終了', interrupted: '中断' } as const;
	const activeGames = $derived(games.filter((game) => game.gameId === hudGameId && (game.phase === 'running' || game.phase === 'settling')));
	const selfActiveGameId = $derived(games.find((game) => (game.phase === 'running' || game.phase === 'settling') && game.participant.some((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber && (member.status === 'active' || member.status === 'temporarily-ineligible')))?.gameId ?? null);
	function pendingOwnEarnings(game: TagGameState): Readonly<{ points: number; lossMs: number }> {
		if (game.phase !== 'running' || game.holderChallengeId || !game.startedAt || !game.seed || !game.effect) return { points: 0, lossMs: 0 };
		const own = game.participant.find((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber);
		if (!own || own.pubkey !== game.ownerPubkey || own.status !== 'active') return { points: 0, lossMs: 0 };
		const elapsed = Math.max(0, Math.min(nowMs, (game.endsAt ?? game.startedAt + 180) * 1000) - game.startedAt * 1000);
		const intervals = createTagGameSchedule(game.seed);
		let boundary = 0;
		for (const interval of intervals) {
			boundary += interval.durationMs;
			if (elapsed < boundary) {
				const cursor = Math.max(game.settledAtMs, game.startedAt * 1000 + boundary - interval.durationMs);
				const duration = Math.max(0, Math.min(nowMs, game.startedAt * 1000 + boundary) - cursor);
				return interval.effect === 'benefit'
					? { points: Math.floor((own.benefitMs + duration) * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1000) - own.points, lossMs: 0 }
					: { points: 0, lossMs: Math.floor((own.calamityMs + duration) * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1000) - own.lifespanLossMs };
			}
		}
		return { points: 0, lossMs: 0 };
	}
</script>

{#if activeGames.length > 0}
	<aside class="field-hud" aria-label="鬼ごっこ進行状況" data-tag-game-hud data-tag-game-hud-id={hudGameId ?? undefined} data-realtime-status={realtimeStatus}>
		{#each activeGames as game (game.gameId)}
			{@const own = game.participant.find((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber)}
			{@const pending = pendingOwnEarnings(game)}
			{@const cooldown = Math.max(0, 3 - Math.ceil((nowMs - (game.transferAt ?? nowMs)) / 1000))}
			<strong>鬼ごっこ・残り{Math.max(0, Math.ceil(((game.endsAt ?? 0) * 1000 - nowMs) / 1000))}秒</strong>
			<p>参加者: {game.participant.filter((member) => member.status === 'active').map((member) => member.pubkey === game.ownerPubkey ? (member.pubkey === selfPubkey ? 'あなた(所持者)' : `${member.pubkey.slice(0, 8)}(所持者)`) : (member.pubkey === selfPubkey ? 'あなた' : member.pubkey.slice(0, 8))).join('、')}</p>
			<p>所持者: {game.participant.find((member) => member.pubkey === game.ownerPubkey)?.pubkey === selfPubkey ? 'あなた' : (game.ownerPubkey ?? '').slice(0, 8)}・{game.effect === 'benefit' ? '恩恵' : '災厄'}・転移後{cooldown}秒</p>
			{#if own}<p>予測: {own.points + pending.points}pt・寿命残り約{tagGamePredictedRemainingLifespanMinutes(effectiveLifespanMs, pending.lossMs)}分</p>{/if}
			{#if game.phase === 'running' && (own?.status === 'active' || own?.status === 'temporarily-ineligible')}
				<PrimaryButton class="tag-game-leave" data-tag-game-leave={game.gameId} onclick={() => onLeave(game.gameId)} disabled={busy}>退出を申請</PrimaryButton>
				<small>開催者が退出を確定すると精算されます</small>
			{/if}
		{/each}
	</aside>
{/if}

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
						{#if game.phase === 'running' || game.phase === 'settling'}
							{#if watchedGameId === game.gameId}<PrimaryButton onclick={onStopWatching} disabled={busy}>観戦を解除</PrimaryButton>
							{:else if selfActiveGameId === null}<PrimaryButton data-tag-game-watch={game.gameId} onclick={() => onWatch(game.gameId)} disabled={busy}>観戦する</PrimaryButton>
							{:else if selfActiveGameId === game.gameId}<span>参加中</span>{/if}
						{/if}
						{#if game.phase === 'ended' || game.phase === 'interrupted'}
							<div class="results" aria-label="鬼ごっこ結果">
								{#each game.participant as player (player.pubkey)}
									<span>{player.pubkey === selfPubkey ? 'あなた' : player.pubkey.slice(0, 8)}・{player.status === 'dead' ? '死亡' : player.status === 'left' ? '脱出' : player.status === 'temporarily-ineligible' ? '一時対象外' : '参加'}・{player.points}pt・寿命-{Math.ceil(player.lifespanLossMs / 60_000)}分・恩恵{Math.floor(player.benefitMs / 1000)}秒・災厄{Math.floor(player.calamityMs / 1000)}秒</span>
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
	.field-hud { position: fixed; z-index: 55; top: 12px; right: 12px; width: min(330px, calc(100vw - 24px)); padding: 10px 12px; border: 1px solid var(--border-subtle, #d8dce0); border-radius: 12px; background: color-mix(in srgb, var(--surface, #fff) 94%, transparent); color: var(--text-primary, #20242a); box-shadow: 0 4px 18px rgba(0,0,0,.16); font-size: .84rem; pointer-events: auto; }
	.field-hud p { margin: 4px 0 0; }
	.field-hud small { display: block; margin-top: 4px; color: var(--text-secondary, #666); }
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
