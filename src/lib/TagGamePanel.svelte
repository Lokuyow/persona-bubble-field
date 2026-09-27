<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Dialog } from 'bits-ui';
	import { asset } from '$app/paths';
	import X from '~icons/tabler/x';
	import HelpCircle from '~icons/tabler/help-circle';
	import ChevronDown from '~icons/tabler/chevron-down';
	import ActionButton from '$lib/ActionButton.svelte';
	import { resolveCharacterFromPubkey } from '$lib/characterAssignment';
	import { newlyConfirmedTagGameParticipants, tagGameCharacterName, tagGameConfirmedParticipants, tagGameParticipantLabel } from '$lib/tagGamePresentation';
	import type { TagGameState } from '$lib/tagGame';
	type Props = Readonly<{
		open: boolean;
		games: readonly TagGameState[];
		selfPubkey: string | null;
		selfRunNumber: number | null;
		watchedGameId: string | null;
		nowMs: number;
		busy?: boolean;
		reservedGameId?: string | null;
		reservedStatus?: 'pending' | 'registered' | 'active' | null;
		reservationExpiresAtMs?: number | null;
		onCreate: () => void;
		onJoin: (gameId: string) => void;
		onLeave: (gameId: string) => void;
		onCancel: (gameId: string) => void;
		onPropose: (gameId: string) => void;
		onConsent: (gameId: string, proposalId: string) => void;
		onExclude: (gameId: string, pubkey: string) => void;
		onWatch: (gameId: string) => void;
		onStopWatching: () => void;
		onOpenChange: (open: boolean) => void;
	}>;
	let { open, games, selfPubkey, selfRunNumber, watchedGameId, nowMs, busy = false, reservedGameId = null, reservedStatus = null, reservationExpiresAtMs = null, onCreate, onJoin, onLeave, onCancel, onPropose, onConsent, onExclude, onWatch, onStopWatching, onOpenChange }: Props = $props();
	const labels = { lobby: '募集中', proposed: '開始確認中', countdown: '開始準備中', running: '開催中', settling: '最終精算中', ended: '終了', interrupted: '中断' } as const;
	const selfActiveGameId = $derived(games.find((game) => (game.phase === 'running' || game.phase === 'settling') && game.participant.some((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber && (member.status === 'active' || member.status === 'temporarily-ineligible')))?.gameId ?? null);
	const ownHostLobby = $derived(games.find((game) => game.hostPubkey === selfPubkey && (game.phase === 'lobby' || game.phase === 'proposed')) ?? null);
	const reservationCurrent = $derived(Boolean(reservedGameId && !(reservationExpiresAtMs !== null && reservationExpiresAtMs <= nowMs)));
	const createAllowed = $derived(Boolean(selfPubkey && !reservationCurrent && !ownHostLobby && !games.some((game) => game.participant.some((member) => member.pubkey === selfPubkey && ['registered', 'active', 'temporarily-ineligible'].includes(member.status)) && !['ended', 'interrupted'].includes(game.phase))));
	const joinableGames = $derived(selfPubkey && !reservationCurrent && !ownHostLobby ? games.filter((game) => game.phase === 'lobby' && game.hostPubkey !== selfPubkey && game.participant.length < 8) : []);
	const GAME_SLOTS = Array.from({ length: 8 }, (_, index) => index);
	let knownGames = new Map<string, TagGameState>();
	let highlightedPubkeys = $state<readonly string[]>([]);
	let highlightTimeout: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const additions: Array<{ game: TagGameState; pubkey: string }> = [];
		for (const game of games) {
			for (const pubkey of newlyConfirmedTagGameParticipants(knownGames.get(game.gameId) ?? null, game)) additions.push({ game, pubkey });
			knownGames.set(game.gameId, game);
		}
		if (!open || additions.length === 0) return;
		highlightedPubkeys = additions.map(({ pubkey }) => pubkey);
		if (highlightTimeout) clearTimeout(highlightTimeout);
		highlightTimeout = setTimeout(() => { highlightedPubkeys = []; highlightTimeout = undefined; }, 3_500);
	});
	onDestroy(() => { if (highlightTimeout) clearTimeout(highlightTimeout); });
	function isHighlighted(pubkey: string): boolean { return highlightedPubkeys.includes(pubkey); }
	function hostLabel(game: TagGameState): string {
		if (game.hostPubkey === selfPubkey) return 'あなたの開催';
		const name = tagGameCharacterName(game.hostPubkey, selfPubkey);
		const sameName = games.filter((candidate) => candidate.hostPubkey !== selfPubkey && tagGameCharacterName(candidate.hostPubkey, selfPubkey) === name);
		return sameName.length > 1 ? `開催者 ${name}（同名${sameName.findIndex((candidate) => candidate.gameId === game.gameId) + 1}）` : `開催者 ${name}`;
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="tag-game-dialog-overlay" />
			<Dialog.Content class="tag-game-dialog-content" preventScroll={false}>
				<header><Dialog.Title class="tag-game-title">鬼ごっこ</Dialog.Title><Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close></header>
				<section class="tag-game-intro" aria-label="鬼ごっこの概要">
					<p class="tag-game-meta">2〜8人 · 2分</p>
					<p class="tag-game-intro-line">福を奪い、鬼を押し付ける。</p>
					<p class="tag-game-risk">鬼になった者は、毎秒1時間の寿命を失います。寿命が尽きれば死亡します。</p>
					<details class="tag-game-rules">
						<summary><span class="tag-game-rules-label"><HelpCircle aria-hidden="true" /> <span class="tag-game-rules-closed">ルールを見る</span><span class="tag-game-rules-open">ルールを閉じる</span></span><span class="tag-game-rules-chevron" aria-hidden="true"><ChevronDown /></span></summary>
						<div class="tag-game-rules-content">
							<div class="tag-game-effect-card tag-game-effect-benefit"><div class="tag-game-effect-heading"><strong>福</strong><strong>+50pt / 秒</strong></div><p>福を持たない者は、所持者にタッチして福を奪えます。</p></div>
							<div class="tag-game-effect-card tag-game-effect-calamity"><div class="tag-game-effect-heading"><strong>鬼</strong><strong>寿命 −1時間 / 秒</strong></div><p>鬼は他の参加者にタッチして、鬼を押し付けられます。</p></div>
							<section class="tag-game-rule-item"><h3>切り替え</h3><p>福と鬼は交互に切り替わります。</p></section>
							<section class="tag-game-rule-item"><h3>タッチ</h3><p>隣接した相手にのみタッチできます。</p></section>
						</div>
					</details>
				</section>
				{#if createAllowed}<ActionButton variant={joinableGames.length === 0 ? 'primary' : 'secondary'} onclick={onCreate} disabled={busy}>鬼ごっこを開催</ActionButton>
				{:else if ownHostLobby}<p class="reservation-state">募集を開催中</p>
				{:else if reservationCurrent}<p class="reservation-state">{reservedStatus === 'pending' ? '参加申請済み（受理待ち）' : reservedStatus === 'active' ? '鬼ごっこに参加中' : '参加申請済み（参加登録済み）'}</p>
				{:else}<p class="reservation-state">ほかの開催回に参加中</p>{/if}
				{#if games.length === 0}<p>現在募集中の開催はありません。</p>{/if}
				{#if reservationCurrent && reservedGameId && reservedStatus !== 'active' && !games.some((game) => game.gameId === reservedGameId)}
					<p class="reservation-state">表示されていない開催への{reservedStatus === 'pending' ? '参加申請' : '参加登録'}があります。</p>
					<ActionButton variant="tertiary" intent="cancel" data-tag-game-cancel-reservation={reservedGameId} onclick={() => onLeave(reservedGameId)} disabled={busy}>参加予約を取り消す</ActionButton>
				{/if}
				<ul>
					{#each games as game (game.gameId)}
						{@const hostCharacter = resolveCharacterFromPubkey(game.hostPubkey)}
						{@const confirmedParticipants = tagGameConfirmedParticipants(game)}
						<li>
							<div class="host-identity">{#if hostCharacter}<img class="tag-game-avatar" src={asset(`/${hostCharacter.picture}`)} alt="" />{/if}<strong>{hostLabel(game)}</strong><span>{labels[game.phase]}</span></div>
							<strong class="participant-count">参加者 {confirmedParticipants.length} / 8人</strong>
							{#if game.phase === 'lobby' || game.phase === 'proposed' || game.phase === 'countdown'}
								<ol class="participant-slots" aria-label="参加者枠">
									{#each GAME_SLOTS as slot}
										{@const player = confirmedParticipants[slot]}
										{#if player}
											{@const character = resolveCharacterFromPubkey(player.pubkey)}
											<li class={['participant-slot', { 'participant-slot-arrival': isHighlighted(player.pubkey) }]} data-tag-game-participant-slot={player.pubkey}>
												{#if character}<img src={asset(`/${character.picture}`)} alt="" />{/if}
												<strong title={tagGameParticipantLabel(game, player.pubkey, selfPubkey)}>{tagGameParticipantLabel(game, player.pubkey, selfPubkey)}</strong>
												{#if player.pubkey === game.hostPubkey}<small>開催者</small>
												{:else if player.pubkey === selfPubkey}<small>あなた</small>
												{:else if game.phase === 'proposed' && player.consentProposalId === game.proposalId && player.consented}<small>同意済み</small>
												{:else if game.phase === 'proposed'}<small>同意待ち</small>{/if}
											</li>
										{:else}<li class="participant-slot participant-slot-empty" aria-label={`空き参加枠 ${slot + 1}`}>空き</li>{/if}
									{/each}
								</ol>
							{/if}
							{#if game.ownerPubkey}<p class="game-status">所持者 {tagGameParticipantLabel(game, game.ownerPubkey, selfPubkey)}・{game.effect === 'benefit' ? '福' : '鬼'}{#if game.endsAt}・残り{Math.max(0, Math.ceil((game.endsAt * 1000 - nowMs) / 1000))}秒{/if}</p>{/if}
							{#if game.phase === 'running' || game.phase === 'settling'}
								{#if watchedGameId === game.gameId}<ActionButton variant="tertiary" onclick={onStopWatching} disabled={busy}>観戦を解除</ActionButton>
								{:else if selfActiveGameId === null}<ActionButton variant="tertiary" data-tag-game-watch={game.gameId} onclick={() => onWatch(game.gameId)} disabled={busy}>観戦する</ActionButton>
								{:else if selfActiveGameId === game.gameId}<span>参加中</span>{/if}
							{/if}
							{#if (game.phase === 'ended' || game.phase === 'interrupted') && game.startedAt}
								<div class="results" aria-label="鬼ごっこ結果">
									{#each game.participant as player (player.pubkey)}
									<span>{tagGameParticipantLabel(game, player.pubkey, selfPubkey)}・{player.status === 'dead' ? '死亡' : player.status === 'left' ? '退出' : player.status === 'temporarily-ineligible' ? '一時対象外' : '参加'}・{player.points}pt・寿命-{Math.ceil(player.lifespanLossMs / 60_000)}分・福{Math.floor(player.benefitMs / 1000)}秒・鬼{Math.floor(player.calamityMs / 1000)}秒</span>
									{/each}
								</div>
							{/if}
							{#if game.phase === 'lobby'}
								{#if game.participant.some((player) => player.pubkey === selfPubkey)}
									{#if game.hostPubkey === selfPubkey}<ActionButton variant="tertiary" intent="cancel" onclick={() => onCancel(game.gameId)} disabled={busy}>募集を取り消す</ActionButton><ActionButton variant="primary" onclick={() => onPropose(game.gameId)} disabled={busy || game.participant.length < 2}>開始を提案</ActionButton>
									{:else}<p class="reservation-state">{game.participant.some((player) => player.pubkey === selfPubkey) ? '参加申請済み（参加登録済み）' : '参加申請済み（受理待ち）'}</p><ActionButton variant="tertiary" intent="cancel" onclick={() => onLeave(game.gameId)} disabled={busy}>申請を取り消す</ActionButton>{/if}
							{:else if reservationCurrent && reservedGameId === game.gameId}<p class="reservation-state">参加申請済み（受理待ち）</p><ActionButton variant="tertiary" intent="cancel" onclick={() => onLeave(game.gameId)} disabled={busy}>申請を取り消す</ActionButton>
								{:else}<ActionButton variant="primary" onclick={() => onJoin(game.gameId)} disabled={busy || !selfPubkey || reservationCurrent || game.participant.length >= 8}>参加申請</ActionButton>{/if}
							{:else if game.phase === 'proposed' && game.proposalId && game.participant.some((player) => player.pubkey === selfPubkey)}
								<p class="reservation-state">参加登録済み</p>
								{#if game.hostPubkey === selfPubkey}<span>開催者は同意済み</span>
								{:else if game.participant.find((player) => player.pubkey === selfPubkey)?.consentProposalId === game.proposalId}
									<span>同意済み</span>
								{:else}<ActionButton variant="primary" onclick={() => onConsent(game.gameId, game.proposalId!)} disabled={busy}>開始に同意</ActionButton>{/if}
								{#if game.hostPubkey !== selfPubkey}<ActionButton variant="tertiary" intent="cancel" onclick={() => onLeave(game.gameId)} disabled={busy}>今回は辞退</ActionButton>{/if}
							{/if}
							{#if game.phase === 'proposed' && game.hostPubkey === selfPubkey}<ActionButton variant="tertiary" intent="cancel" onclick={() => onCancel(game.gameId)} disabled={busy}>募集を取り消す</ActionButton>{/if}
							{#if game.phase === 'proposed' && game.hostPubkey === selfPubkey}
								{#each game.participant.filter((player) => player.pubkey !== selfPubkey && player.consentProposalId !== game.proposalId) as player (player.pubkey)}
									<ActionButton variant="tertiary" onclick={() => onExclude(game.gameId, player.pubkey)} disabled={busy}>未応答者を除外して再提案</ActionButton>
								{/each}
							{/if}
						</li>
					{/each}
				</ul>
			</Dialog.Content>
		</Dialog.Portal>
{/if}
	</Dialog.Root>

<style>
	:global(.tag-game-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(20, 24, 30, .48); }
	:global(.tag-game-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; width: min(520px, calc(100vw - 40px)); max-height: min(80vh, 720px); overflow: auto; padding: 20px; border: 0; border-radius: 16px; background: var(--surface, #fff); color: var(--text-primary, #20242a); box-shadow: 0 18px 60px rgba(0,0,0,.24); transform: translate(-50%, -50%); }
	.host-identity { display: flex; align-items: center; gap: 8px; }
	.host-identity .tag-game-avatar { position: static; width: 32px; height: 32px; object-fit: contain; flex: 0 0 auto; pointer-events: none; }
	.reservation-state { margin: 0; font-weight: 600; }
	.tag-game-intro { display: grid; gap: 8px; margin: 12px 0; }
	.tag-game-intro p { margin: 0; }
	.tag-game-meta { color: var(--text-secondary, #666); font-size: .9rem; }
	.tag-game-intro-line { font-weight: 650; }
	.tag-game-risk { padding: 9px 11px; border: 1px solid color-mix(in srgb, #b85d54 28%, var(--border-subtle, #d8dce0)); border-radius: 8px; background: color-mix(in srgb, #b85d54 8%, var(--surface, #fff)); color: color-mix(in srgb, #8f3932 78%, var(--text-primary, #20242a)); font-size: .9rem; line-height: 1.5; }
	.tag-game-rules { border: 1px solid var(--action-tertiary-border, #727c82); border-radius: 10px; background: var(--action-tertiary-background, #f2f3f4); }
	.tag-game-rules summary { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px; border-radius: inherit; cursor: pointer; font-weight: 700; list-style: none; }
	.tag-game-rules summary::-webkit-details-marker { display: none; }
	.tag-game-rules summary:focus-visible { outline: 3px solid var(--color-focus-ring, #6dabb9); outline-offset: 2px; }
	.tag-game-rules-label { display: inline-flex; align-items: center; gap: 8px; }
	.tag-game-rules-label :global(svg), .tag-game-rules-chevron { width: 20px; height: 20px; }
	.tag-game-rules-open { display: none; }
	.tag-game-rules[open] { border-color: var(--action-tertiary-border, #727c82); }
	.tag-game-rules[open] summary { border-radius: 10px 10px 0 0; }
	.tag-game-rules[open] .tag-game-rules-closed { display: none; }
	.tag-game-rules[open] .tag-game-rules-open { display: inline; }
	.tag-game-rules[open] .tag-game-rules-chevron { transform: rotate(180deg); }
	.tag-game-rules-content { display: grid; gap: 12px; padding: 12px; border-top: 1px solid var(--action-tertiary-border, #727c82); line-height: 1.5; }
	.tag-game-effect-card { padding: 12px; border: 1px solid color-mix(in srgb, var(--tag-game-effect-accent) 38%, var(--border-subtle, #d8dce0)); border-left: 3px solid var(--tag-game-effect-accent); border-radius: 8px; background: color-mix(in srgb, var(--tag-game-effect-accent) 8%, var(--surface, #fff)); color: var(--text-primary, #20242a); }
	.tag-game-effect-benefit { --tag-game-effect-accent: #b38a2e; }
	.tag-game-effect-calamity { --tag-game-effect-accent: #8065ad; }
	.tag-game-effect-heading { display: flex; justify-content: space-between; gap: 12px; }
	.tag-game-effect-heading strong:last-child { text-align: right; }
	.tag-game-effect-card p, .tag-game-rule-item p { margin: 6px 0 0; font-size: .92rem; line-height: 1.5; }
	.tag-game-rule-item h3 { margin: 0; font-size: .95rem; }
	.tag-game-rules-content > .tag-game-rule-item { display: block; }
	@media (prefers-reduced-motion: no-preference) { .tag-game-rules-chevron { transition: transform 140ms ease; } }
	@media (prefers-reduced-motion: reduce) { .tag-game-rules-chevron { transition: none; } }
	.participant-count { width: 100%; }
	.participant-slots { display: grid; width: 100%; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
	.participant-slot { display: grid; min-width: 0; min-height: 54px; grid-template-columns: 28px minmax(0, 1fr); grid-template-rows: 1fr auto; align-items: center; column-gap: 5px; padding: 4px; overflow: hidden; border: 1px solid var(--border-subtle, #d8dce0); border-radius: 8px; background: color-mix(in srgb, var(--surface, #fff) 94%, transparent); }
	.participant-slot img { width: 26px; height: 26px; grid-row: 1 / 3; object-fit: contain; }
	.participant-slot strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .78rem; }
	.participant-slot small { min-width: 0; overflow: hidden; color: var(--text-secondary, #666); text-overflow: ellipsis; white-space: nowrap; font-size: .65rem; }
	.participant-slot-empty { display: grid; place-items: center; border-style: dashed; color: var(--text-secondary, #888); font-size: .72rem; }
	.participant-slot-arrival { animation: participant-arrival 850ms ease-out 2; }
	header { position: sticky; top: -20px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: -20px -20px 0; padding: 20px; background: var(--surface, #fff); }
	:global(.tag-game-title) { margin: 0; }
	ul { display: grid; gap: 10px; margin: 16px 0 0; padding: 0; list-style: none; }
	li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; justify-content: space-between; padding: 12px; border: 1px solid var(--border-subtle, #d8dce0); border-radius: 10px; }
	li div { display: grid; gap: 3px; }
	.game-status { width: 100%; margin: 0; }
	.results { display: grid; width: 100%; gap: 3px; color: var(--text-secondary, #666); font-size: .88rem; }
	li span { color: var(--text-secondary, #666); font-size: .9rem; }
	@keyframes participant-arrival { 50% { border-color: var(--color-accent, #426b9c); background: color-mix(in srgb, var(--surface, #fff) 78%, var(--color-accent, #426b9c)); } }
	@media (prefers-reduced-motion: reduce) { .participant-slot-arrival { animation: none; border-color: var(--color-accent, #426b9c); } }
</style>
