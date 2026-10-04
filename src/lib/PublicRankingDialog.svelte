<script lang="ts">
	import { Dialog } from 'bits-ui';
	import ChartBar from '~icons/tabler/chart-bar';
	import Clock from '~icons/tabler/clock';
	import Trophy from '~icons/tabler/trophy';
	import X from '~icons/tabler/x';
	import type { Event as NostrEvent } from 'nostr-tools/pure';
	import CharacterAvatar from './CharacterAvatar.svelte';
	import { formatRemainingDuration } from './lifespanHud';
	import { projectPublicRankings, type PublicRankingRow } from './publicRankings';
	import type { createWorldReadSession } from './worldReadSession';

	type Props = Readonly<{
		open: boolean;
		session: ReturnType<typeof createWorldReadSession> | null;
		selfPubkey: string | null;
		onOpenChange: (open: boolean) => void;
	}>;

	let { open, session, selfPubkey, onOpenChange }: Props = $props();
	let selectedRanking = $state<'points' | 'lifespan'>('points');
	let channelId = $state<string | null>(null);
	let rankingEvents = $state.raw<readonly NostrEvent[]>([]);
	let viewerNowMs = $state(Date.now());
	let skeletonFinished = $state(false);
	let readCompleted = $state(false);
	let generation = 0;
	const projection = $derived(channelId
		? projectPublicRankings({ events: rankingEvents, channelId, viewerNowMs, selfPubkey })
		: { points: [], lifespan: [] });

	$effect(() => {
		const activeSession = session;
		if (!open || !activeSession) return;
		const currentGeneration = ++generation;
		const eventsById = new Map<string, NostrEvent>();
		channelId = null;
		rankingEvents = [];
		viewerNowMs = Date.now();
		selectedRanking = 'points';
		skeletonFinished = false;
		readCompleted = false;
		const skeletonTimer = window.setTimeout(() => {
			if (currentGeneration === generation) skeletonFinished = true;
		}, 3_000);
		const read = activeSession.openPublicRankingRead((event, currentChannelId) => {
			if (currentGeneration !== generation) return;
			eventsById.set(event.id, event);
			channelId = currentChannelId;
			rankingEvents = [...eventsById.values()];
			viewerNowMs = Date.now();
			const next = projectPublicRankings({ events: rankingEvents, channelId: currentChannelId, viewerNowMs, selfPubkey });
			if (next.points.length > 0) {
				skeletonFinished = true;
			}
		}, () => {
			if (currentGeneration !== generation) return;
			readCompleted = true;
			skeletonFinished = true;
		});
		return () => {
			generation++;
			window.clearTimeout(skeletonTimer);
			read.close();
		};
	});

	function focusTitle(event: globalThis.Event): void {
		event.preventDefault();
		document.querySelector<HTMLElement>('.ranking-dialog-title')?.focus({ preventScroll: true });
	}

	function rowStatus(row: PublicRankingRow): string | null {
		return row.terminalState === 'death' ? '死亡' : row.terminalState === 'clear' ? '脱出' : null;
	}

	function rowValue(row: PublicRankingRow, ranking: 'points' | 'lifespan'): string {
		if (ranking === 'points') return `${row.points} pt`;
		if (row.terminalState === 'death') return '死亡';
		if (row.terminalState === 'clear') return '脱出';
		return formatRemainingDuration(row.remainingLifespanMs);
	}
</script>

{#snippet rankingRows(rows: readonly PublicRankingRow[], ranking: 'points' | 'lifespan')}
	<ol class="ranking-rows" data-ranking-rows={ranking}>
		{#each rows as row, index (row.key)}
			{@const status = ranking === 'points' ? rowStatus(row) : null}
			<li class="ranking-row" data-ranking-row data-ranking-state={row.terminalState ?? 'alive'}>
				<span class="ranking-place">{index + 1}</span>
				<CharacterAvatar character={row.character} class="avatar ranking-avatar" />
				<span class="ranking-name-group">
					<strong class="ranking-name">{row.character.name}</strong>
					<span class="ranking-badges">{#if status}<span class="ranking-state">{status}</span>{/if}{#if row.isSelf}<span class="ranking-self">自分</span>{/if}</span>
				</span>
				<strong class="ranking-value">{rowValue(row, ranking)}</strong>
			</li>
		{/each}
	</ol>
{/snippet}

<Dialog.Root bind:open={() => open, onOpenChange}>
	<Dialog.Portal>
			<Dialog.Overlay class="ranking-dialog-overlay" />
			<Dialog.Content class="ranking-dialog-content" data-ranking-dialog preventScroll={false} onOpenAutoFocus={focusTitle}>
				<header class="ranking-dialog-header">
					<div class="ranking-heading">
						<Trophy aria-hidden="true" />
						<Dialog.Title class="ranking-dialog-title" tabindex={-1}>ランキング</Dialog.Title>
						<Dialog.Description class="sr-only">公開Profile Stateから取得したポイントと寿命のランキングです。</Dialog.Description>
					</div>
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</header>
				<div class="ranking-tabs" role="group" aria-label="ランキングの種類">
					<button type="button" class="action-selected" aria-pressed={selectedRanking === 'points'} data-ranking-tab="points" onclick={() => { selectedRanking = 'points'; }}>
						<ChartBar aria-hidden="true" /><span>ポイント</span>
					</button>
					<button type="button" class="action-selected" aria-pressed={selectedRanking === 'lifespan'} data-ranking-tab="lifespan" onclick={() => { selectedRanking = 'lifespan'; }}>
						<Clock aria-hidden="true" /><span>寿命</span>
					</button>
				</div>
				<div class="ranking-columns">
					<section class="ranking-column" data-ranking-column="points" data-selected={selectedRanking === 'points'} aria-label="ポイントランキング" aria-busy={!readCompleted}>
						<h2 class="ranking-column-heading"><ChartBar aria-hidden="true" />ポイント</h2>
						{#if skeletonFinished && projection.points.length > 0}
							{@render rankingRows(projection.points, 'points')}
						{/if}
					</section>
					<section class="ranking-column" data-ranking-column="lifespan" data-selected={selectedRanking === 'lifespan'} aria-label="寿命ランキング" aria-busy={!readCompleted}>
						<h2 class="ranking-column-heading"><Clock aria-hidden="true" />寿命</h2>
						{#if skeletonFinished && projection.lifespan.length > 0}
							{@render rankingRows(projection.lifespan, 'lifespan')}
						{/if}
					</section>
					{#if !skeletonFinished}
						<div class="ranking-shared-state" data-ranking-skeleton aria-hidden="true">
							<div class="ranking-skeleton">
								{#each [0, 1, 2, 3, 4] as row (row)}
									<div class="ranking-skeleton-row"><span></span><span></span><span></span></div>
								{/each}
							</div>
						</div>
					{:else if projection.points.length === 0 && projection.lifespan.length === 0}
						{#if readCompleted}
							<p class="ranking-empty ranking-shared-state" data-ranking-empty>ランキング情報がありません</p>
						{:else}
							<p class="ranking-loading ranking-shared-state" data-ranking-loading>ランキングを取得中…</p>
						{/if}
					{/if}
				</div>
			</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.ranking-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(4, 7, 18, .72); backdrop-filter: blur(2px); }
	:global(.ranking-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 0; width: min(640px, calc(100vw - 24px)); max-height: calc(100svh - 28px); overflow: auto; padding: 22px; border: 1px solid rgba(122, 135, 255, .62); border-radius: 18px; background: linear-gradient(180deg, rgba(12, 18, 46, .98), rgba(8, 12, 33, .98)); box-shadow: 0 20px 80px rgba(0, 0, 0, .48), 0 0 34px rgba(90, 103, 255, .13); color: #f4f6ff; transform: translate(-50%, -50%); }
	.ranking-dialog-header { position: sticky; top: -22px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -22px -22px 16px; padding: 18px 22px 14px; background: linear-gradient(180deg, rgba(12, 18, 46, 1), rgba(12, 18, 46, .98)); }
	.ranking-heading { display: flex; align-items: center; min-width: 0; gap: 9px; }
	.ranking-heading > :global(svg) { width: 22px; height: 22px; color: #aeb6ff; }
	:global(.ranking-dialog-title) { margin: 0; color: #f4f6ff; font-size: 22px; line-height: 1.2; font-weight: 800; letter-spacing: .03em; }
	.ranking-dialog-header :global(.action-button-close) { flex: 0 0 auto; }
	:global(.ranking-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.ranking-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
	.ranking-tabs button { display: inline-flex; justify-content: center; align-items: center; gap: 8px; min-height: 44px; border: 1px solid rgba(174, 182, 255, .42); border-radius: 9px; background: rgba(19, 26, 61, .78); color: #d8dcf5; font: inherit; font-weight: 700; cursor: pointer; }
	.ranking-tabs button:focus-visible { outline: 3px solid var(--action-focus-ring); outline-offset: 2px; }
	.ranking-tabs button :global(svg) { width: 18px; height: 18px; }
	.ranking-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; min-width: 0; }
	.ranking-shared-state { grid-column: 1 / -1; }
	.ranking-column { min-width: 0; }
	.ranking-column-heading { display: none; align-items: center; gap: 7px; margin: 0 0 12px; color: #d8dcf5; font-size: 16px; }
	.ranking-column-heading :global(svg) { width: 18px; height: 18px; color: #aeb6ff; }
	.ranking-rows { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
	.ranking-row { display: grid; grid-template-columns: 30px 38px minmax(0, 1fr) auto; align-items: center; gap: 10px; min-width: 0; padding: 10px 12px; border: 1px solid rgba(174, 182, 255, .22); border-radius: 11px; background: rgba(19, 26, 61, .62); }
	.ranking-place { color: #aeb6ff; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; text-align: center; }
	.ranking-row :global(.ranking-avatar.avatar) { position: relative; top: auto; left: auto; width: 38px; height: 38px; transform: none; }
	.ranking-name-group { display: grid; gap: 3px; min-width: 0; }
	.ranking-name { overflow: hidden; color: #f4f6ff; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
	.ranking-badges { display: flex; gap: 5px; min-height: 17px; }
	.ranking-state, .ranking-self { width: fit-content; padding: 1px 6px; border-radius: 999px; font-size: 11px; line-height: 1.35; }
	.ranking-state { background: rgba(214, 126, 145, .2); color: #f2b2c0; }
	.ranking-self { background: rgba(174, 182, 255, .13); color: #b8bfdc; }
	.ranking-value { color: #f4f6ff; font-size: 14px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
	.ranking-empty, .ranking-loading { display: grid; min-height: 180px; place-items: center; margin: 0; color: #b8bfdc; text-align: center; }
	.ranking-skeleton { display: grid; gap: 8px; }
	.ranking-skeleton-row { display: grid; grid-template-columns: 30px 38px minmax(0, 1fr); align-items: center; gap: 10px; height: 59px; padding: 10px 12px; border: 1px solid rgba(174, 182, 255, .12); border-radius: 11px; background: rgba(19, 26, 61, .45); }
	.ranking-skeleton-row span { height: 13px; border-radius: 7px; background: linear-gradient(90deg, rgba(174, 182, 255, .1), rgba(174, 182, 255, .25), rgba(174, 182, 255, .1)); background-size: 200% 100%; animation: ranking-shimmer 1.2s ease-in-out infinite; }
	.ranking-skeleton-row span:first-child { width: 20px; }
	.ranking-skeleton-row span:nth-child(2) { width: 38px; height: 38px; border-radius: 42% 58% 48% 52%; }
	@keyframes ranking-shimmer { to { background-position: -200% 0; } }
	@media (prefers-reduced-motion: reduce) { .ranking-skeleton-row span { animation: none; } }
	@media (max-width: 540px) { :global(.ranking-dialog-content) { padding: 16px; } .ranking-dialog-header { top: -16px; margin: -16px -16px 14px; padding: 15px 16px 12px; } .ranking-row { grid-template-columns: 24px 34px minmax(0, 1fr) auto; gap: 7px; padding: 9px 8px; } .ranking-row :global(.ranking-avatar.avatar) { width: 34px; height: 34px; } .ranking-value { max-width: 82px; font-size: 12px; white-space: normal; } }
	@media (min-width: 640px) {
		:global(.ranking-dialog-content) { grid-template-rows: auto minmax(0, 1fr); width: min(920px, calc(100vw - 48px)); }
		.ranking-tabs { display: none; }
		.ranking-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
		.ranking-column-heading { display: flex; }
	}
	@media (max-width: 639px) { .ranking-column:not([data-selected="true"]) { display: none; } }
</style>
