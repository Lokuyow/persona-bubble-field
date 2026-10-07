<script lang="ts">
	import { Dialog } from 'bits-ui';
	import X from '~icons/tabler/x';
	import ActionButton from './ActionButton.svelte';
	import TagGameEffectSymbol from './TagGameEffectSymbol.svelte';
	import { asset } from '$app/paths';
	import { resolveCharacterFromPubkey } from './characterAssignment';
	import { tagGameParticipantLabel, tagGameResultLifespan, tagGameResultParticipants, tagGameResultTime } from './tagGamePresentation';
	import type { TagGameState } from './tagGame';

	type Props = {
		open: boolean;
		game: TagGameState | null;
		selfPubkey: string | null;
		settlementNote?: string | null;
		onOpenChange: (open: boolean) => void;
	};
	let { open, game, selfPubkey, settlementNote = null, onOpenChange }: Props = $props();
	let title = $derived(game?.phase === 'interrupted' ? '鬼ごっこ中断' : '鬼ごっこ終了');
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if game}
		<Dialog.Portal>
			<Dialog.Overlay class="tag-game-result-overlay" />
			<Dialog.Content class="tag-game-result-dialog dialog-mobile-layout" data-tag-game-result-game={game.gameId} preventScroll={false}>
				<div class="dialog-mobile-scroll-content">
					<header>
						<Dialog.Title>{title}</Dialog.Title>
						<Dialog.Close class="action-button action-button-tertiary action-button-close dialog-close-header" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
					</header>
					{#if settlementNote}<p class="settlement-note">{settlementNote}</p>{/if}
					<ol aria-label="参加者全員の結果">
						{#each tagGameResultParticipants(game, selfPubkey) as player (player.pubkey)}
							{@const character = resolveCharacterFromPubkey(player.pubkey)}
							<li class={['result-card', { 'result-card-self': player.pubkey === selfPubkey }]} data-tag-game-result-participant={player.pubkey} data-tag-game-result-self={player.pubkey === selfPubkey ? 'true' : undefined}>
								<div class="result-identity">
									{#if character}<img src={asset(`/${character.picture}`)} alt="" />{/if}
									<strong>{tagGameParticipantLabel(game, player.pubkey, selfPubkey)}</strong>
									{#if player.pubkey === selfPubkey}<small>あなた</small>{/if}
									{#if player.status === 'dead'}<small class="result-status result-status-dead">死亡</small>
									{:else if player.status === 'left'}<small class="result-status">退出</small>
									{:else if player.status === 'cleared'}<small class="result-status">脱出</small>
									{:else if player.status === 'temporarily-ineligible'}<small class="result-status">一時対象外</small>{/if}
								</div>
								<div class="result-values">
									<span class="effect benefit"><svg viewBox="0 0 32 32" aria-hidden="true"><TagGameEffectSymbol effect="benefit" presentation="rule" /></svg>福 {tagGameResultTime(player.benefitMs)}秒</span>
									<span class="points">ポイント +{player.points}pt</span>
								</div>
								<div class="result-values">
									<span class="effect calamity"><svg viewBox="0 0 32 32" aria-hidden="true"><TagGameEffectSymbol effect="calamity" presentation="rule" /></svg>鬼 {tagGameResultTime(player.calamityMs)}秒</span>
									<span class="lifespan">寿命 −{tagGameResultLifespan(player.lifespanLossMs)}</span>
								</div>
							</li>
						{/each}
					</ol>
					</div>
				<div class="dialog-mobile-close-footer">
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</div>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.tag-game-result-overlay) { position: fixed; inset: 0; z-index: 120; background: rgba(20, 24, 30, .56); }
	:global(.tag-game-result-dialog) { --dialog-mobile-padding-top: 16px; --dialog-mobile-padding-inline: 16px; --dialog-mobile-close-footer-inset: 16px; --dialog-mobile-scroll-gap: 12px; position: fixed; top: 50%; left: 50%; z-index: 121; display: grid; width: min(520px, calc(100vw - 28px)); max-height: min(86vh, 760px); gap: 12px; overflow: auto; padding: 16px; border: 0; border-radius: 16px; background: var(--surface, #fff); color: var(--text-primary, #20242a); box-shadow: 0 18px 60px rgba(0,0,0,.3); transform: translate(-50%, -50%); }
	header { position: sticky; top: -16px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -16px -16px 0; padding: 12px 16px; background: var(--surface, #fff); }
	header :global(h2) { margin: 0; font-size: 1.2rem; }
	.settlement-note { margin: 0; padding: 9px 11px; border-radius: 8px; background: color-mix(in srgb, #b38a2e 12%, var(--surface, #fff)); color: var(--text-secondary, #555); font-size: .88rem; line-height: 1.5; }
	ol { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
	.result-card { display: grid; gap: 6px; min-width: 0; padding: 9px 11px; border: 1px solid var(--border-subtle, #d8dce0); border-radius: 10px; background: var(--surface, #fff); }
	.result-card-self { border-color: color-mix(in srgb, var(--color-accent, #426b9c) 34%, var(--border-subtle, #d8dce0)); background: color-mix(in srgb, var(--color-accent, #426b9c) 8%, var(--surface, #fff)); }
	.result-identity { display: flex; min-width: 0; align-items: center; gap: 7px; }
	.result-identity img { width: 30px; height: 30px; flex: 0 0 auto; object-fit: contain; }
	.result-identity strong { min-width: 0; overflow-wrap: anywhere; }
	.result-identity small { padding: 2px 6px; border-radius: 999px; background: color-mix(in srgb, var(--text-secondary, #666) 10%, var(--surface, #fff)); color: var(--text-secondary, #666); font-size: .72rem; }
	.result-identity .result-status-dead { color: #a13131; }
	.result-values { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding-left: 37px; font-size: .9rem; line-height: 1.4; }
	.effect { display: inline-flex; align-items: center; gap: 4px; font-weight: 650; }
	.effect svg { width: 21px; height: 21px; flex: 0 0 auto; }
	.benefit { color: #876615; }
	.calamity { color: #6d528f; }
	.points, .lifespan { font-variant-numeric: tabular-nums; }
	@media (max-width: 420px) { .result-values { padding-left: 0; gap: 3px 10px; font-size: .85rem; } }
</style>
