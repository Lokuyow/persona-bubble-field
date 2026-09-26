<script lang="ts">
	import { Dialog } from 'bits-ui';
	import Coins from '~icons/tabler/coins';
	import Clock from '~icons/tabler/clock';
	import ChevronDown from '~icons/tabler/chevron-down';
	import ChevronUp from '~icons/tabler/chevron-up';
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import PlayerPause from '~icons/tabler/player-pause';
	import Tool from '~icons/tabler/tool';
	import X from '~icons/tabler/x';
	import ArrowBarToDown from '~icons/tabler/arrow-bar-to-down';
	import Wallet from '~icons/tabler/wallet';
	import ActionButton from '$lib/ActionButton.svelte';
	import type { MendingProjection } from '$lib/mending';
	import { formatElapsedDuration, formatRemainingDuration } from '$lib/lifespanHud';

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		starting?: boolean;
		points: number;
		onOpenChange: (open: boolean) => void;
		onCollect: () => void;
		collectFeedback?: Readonly<{ id: number; points: number; lifespanMs: number }> | null;
		startupFeedback?: Readonly<{ id: number; phase: 'starting' | 'started' }> | null;
	}>;

	let { open, projection, hasJob, starting = false, points: ownedPointsValue, onOpenChange, onCollect, collectFeedback = null, startupFeedback = null }: Props = $props();
	let detailsOpen = $state(false);
	let remainingDuration = $derived(formatRemainingDuration(projection?.remainingDurationMs ?? 0));
	let lifespanDuration = $derived(formatElapsedDuration(projection?.lifespanExtensionMs ?? 0));
	let unclaimedPoints = $derived(String(projection?.points ?? 0));
	let ownedPoints = $derived(String(ownedPointsValue));
	let nextPointSeconds = $derived(projection?.nextPointRemainingMs === null || projection?.nextPointRemainingMs === undefined
		? null
		: Math.min(60, Math.max(1, Math.ceil(projection.nextPointRemainingMs / 1000))));
	let totalDurationMs = $derived((projection?.processedDurationMs ?? 0) + (projection?.remainingDurationMs ?? 0));
	let progressPercent = $derived(Math.min(100, totalDurationMs > 0 ? (projection?.processedDurationMs ?? 0) / totalDurationMs * 100 : 0));
	let pointRate = $derived(((projection?.pointRateHundredthsPerMinute ?? 0) / 100).toFixed(2));
	let lifespanRateMinutes = $derived(formatRateMinutes(projection?.lifespanExtensionRateHundredthsPerHour ?? 0));
	let accelerationMultiplier = $derived(((projection?.accelerationMultiplierTenths ?? 10) / 10).toFixed(2));
	let maximumLifespan = $derived(formatDaysOrDuration(projection?.maximumLifespanMs ?? 0));
	let accelerationRemaining = $derived(`有効作業 残り${formatElapsedDuration(projection?.accelerationRemainingMs ?? 0)}`);
	let overflowPointAvailable = $derived(Boolean(projection?.completed && (projection?.pointRateHundredthsPerMinute ?? 0) > 0));
	let overflowLifespanAvailable = $derived(Boolean(projection?.completed && (projection?.lifespanExtensionRateHundredthsPerHour ?? 0) > 0));
	let overflowRewardAvailable = $derived(overflowPointAvailable || overflowLifespanAvailable);
	let workStatusTitle = $derived(!projection?.completed ? '作業中' : overflowRewardAvailable ? '延命中' : '作業停止中');

	function formatRateMinutes(rateHundredthsPerHour: number): string {
		const minutes = rateHundredthsPerHour * 0.6;
		return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
	}

	function formatDaysOrDuration(durationMs: number): string {
		const dayMs = 24 * 60 * 60 * 1000;
		if (durationMs >= dayMs && durationMs % dayMs === 0) return `${durationMs / dayMs}日`;
		return formatElapsedDuration(durationMs);
	}

	$effect(() => {
		if (!open) detailsOpen = false;
	});

	function focusFirstAction(event: Event): void {
		const content = event.currentTarget;
		if (!(content instanceof HTMLElement)) return;
		const action = content.querySelector<HTMLButtonElement>('.collect-button:not(:disabled), .details-toggle:not(:disabled)');
		if (!action) return;
		event.preventDefault();
		action.focus();
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content class="mending-dialog-content" preventScroll={false} onOpenAutoFocus={focusFirstAction}>
				<div class="terminal-dialog-header">
					<div>
						<Dialog.Title class="mending-dialog-title">
							{#if !projection?.completed}<Tool aria-hidden="true" data-mending-icon="tool" />{:else if overflowRewardAvailable}<HeartPlus aria-hidden="true" data-mending-icon="heart-plus" />{:else}<PlayerPause aria-hidden="true" data-mending-icon="player-pause" />{/if}
							<span>{workStatusTitle}</span>
						</Dialog.Title>
						<Dialog.Description class="sr-only">時間の経過でポイントが蓄積し、寿命延長は作業の進行中に反映されます。</Dialog.Description>
					</div>
					<div class:points-highlight={collectFeedback} class="owned-points" data-mending-icon="wallet" aria-label={`所持ポイント ${ownedPoints} pt`}>
						<Wallet aria-hidden="true" />
						<span class="owned-points-value">{ownedPoints} pt</span>
					</div>
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</div>
				{#if collectFeedback}
					{#key collectFeedback.id}
						<div class="mending-success-feedback" aria-live="polite" aria-atomic="true">
							<strong>+{collectFeedback.points} pt</strong>
							<span>寿命 +{formatElapsedDuration(collectFeedback.lifespanMs)}</span>
						</div>
					{/key}
				{/if}
				{#if startupFeedback}
					{#key startupFeedback.id}
						<div class="mending-startup-feedback" aria-live="polite" aria-atomic="true">
							<span>{startupFeedback.phase === 'started' ? '作業を開始しました' : '起動中…'}</span>
						</div>
					{/key}
				{/if}
				{#if hasJob || starting}
					<section class="result-list" aria-label="作業の成果">
						<div class:success-flash={collectFeedback} class="result-card" data-mending-icon="coins">
							<Coins aria-hidden="true" />
							<div class="result-copy">
								<span class="result-label">未回収ポイント</span>
								<strong>+{unclaimedPoints} pt</strong>
								<span class:next-point-hidden={nextPointSeconds === null} class="next-point" data-mending-icon="clock" aria-hidden={nextPointSeconds === null}>
									{#if nextPointSeconds !== null}<Clock aria-hidden="true" />次の1ptまで {nextPointSeconds}秒{/if}
								</span>
							</div>
						</div>
						<div class:success-flash={collectFeedback} class="result-card" data-mending-icon="heart">
							<Heart aria-hidden="true" />
							<div class="result-copy">
								<span class="result-label">寿命延長</span>
								<strong>+{lifespanDuration}</strong>
								<span class="result-support">作業中に反映</span>
							</div>
						</div>
					</section>
					<section class="status-group" aria-label="作業の蓄積状況">
						<strong class:overflow-lifespan-status={overflowRewardAvailable} class="progress-heading">
							{#if !projection?.completed}
								<span class="progress-prefix">上限まで あと</span><span class="progress-duration">{remainingDuration}</span>
							{:else if overflowRewardAvailable}
								<span>通常作業は上限</span><span>{overflowPointAvailable && overflowLifespanAvailable ? 'ポイント・寿命延長が継続中' : overflowPointAvailable ? 'ポイント蓄積のみ継続中' : '寿命延長のみ継続中'}</span>
							{:else}
								上限に達しました
							{/if}
						</strong>
						<div class="progress-track" role="progressbar" aria-label="作業の蓄積進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressPercent)}>
							<div class="progress-value" style={`width: ${progressPercent}%;`}></div>
						</div>
					</section>
					<section class="action-group" aria-label="成果回収">
						<ActionButton variant="primary" class="collect-button" type="button" disabled={starting || (projection?.points ?? 0) < 1} onclick={onCollect}>
							<ArrowBarToDown aria-hidden="true" />成果を受け取る
						</ActionButton>
					</section>
					<section class="utility-group" aria-label="作業の詳細と操作">
						<section class="details-section" aria-label="作業の詳細">
						<ActionButton variant="tertiary" class="details-toggle" type="button" aria-expanded={detailsOpen} onclick={() => detailsOpen = !detailsOpen}>
							<span>{detailsOpen ? '詳細を閉じる' : '詳細を見る'}</span>
							{#if detailsOpen}<ChevronUp aria-hidden="true" />{:else}<ChevronDown aria-hidden="true" />{/if}
						</ActionButton>
						{#if detailsOpen}
							<div class="details-content">
								<p>現在のポイント速度 <strong>{pointRate} pt/分</strong></p>
								<p>最大蓄積 <strong>{formatElapsedDuration(projection?.contextCapacityMs ?? 0)}</strong></p>
								<p>1時間の作業で寿命 <strong>+{lifespanRateMinutes}分</strong></p>
								<p>推論加速 <strong>×{accelerationMultiplier}</strong>（{accelerationRemaining}）</p>
								<p>最大寿命 <strong>{maximumLifespan}</strong></p>
							</div>
						{/if}
						</section>
					</section>
				{/if}
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.mending-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(2, 8, 18, 0.72); backdrop-filter: blur(2px); }
	:global(.mending-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 0; width: min(720px, calc(100vw - 24px)); max-height: calc(100svh - 32px); overflow: auto; padding: 28px; border: 1px solid rgba(35, 220, 226, .78); border-radius: 18px; background: linear-gradient(180deg, rgba(4, 29, 43, .92), rgba(3, 20, 30, .94)); box-shadow: 0 0 0 1px rgba(53, 227, 232, .10) inset, 0 18px 60px rgba(0, 0, 0, .42), 0 0 30px rgba(26, 212, 220, .08); backdrop-filter: blur(14px); color: #ecfbff; transform: translate(-50%, -50%); }
	.mending-success-feedback { position: absolute; top: 72px; right: 34px; z-index: 1; display: grid; gap: 2px; pointer-events: none; color: #64f5f0; text-align: right; animation: mending-success-float 420ms ease-out both; }
	.mending-success-feedback strong { font-size: 18px; font-weight: 850; }
	.mending-success-feedback span { color: #cfe7ee; font-size: 13px; font-weight: 700; }
	.mending-startup-feedback { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; overflow: hidden; pointer-events: none; border: 1px solid rgba(53, 227, 232, .86); border-radius: inherit; color: #64f5f0; font-size: 16px; font-weight: 800; letter-spacing: .04em; text-shadow: 0 0 18px rgba(53, 227, 232, .7); animation: mending-startup-scan 3000ms ease-out both; box-shadow: 0 0 24px rgba(53, 227, 232, .18) inset; }
	.mending-startup-feedback::after { position: absolute; inset: 0; content: ''; background: linear-gradient(180deg, transparent 0%, rgba(53, 227, 232, .22) 48%, transparent 54%); animation: mending-startup-sweep 1000ms ease-out both; }
	.points-highlight { animation: mending-points-highlight 420ms ease-out; }
	.success-flash { animation: mending-card-flash 420ms ease-out; }
	@keyframes mending-success-float { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(-8px); } }
	@keyframes mending-card-flash { 0%, 100% { box-shadow: none; } 35% { box-shadow: 0 0 0 2px rgba(53, 227, 232, .4), 0 0 24px rgba(53, 227, 232, .34); } }
	@keyframes mending-points-highlight { 0%, 100% { color: #ecfbff; } 35% { color: #64f5f0; transform: scale(1.04); } }
	@media (prefers-reduced-motion: reduce) { .mending-success-feedback { animation-name: mending-success-fade; } .mending-startup-feedback { animation-name: mending-startup-fade; } .mending-startup-feedback::after { animation: none; } .success-flash { animation-name: mending-card-highlight; } .points-highlight { animation-name: mending-points-color; } }
	@keyframes mending-success-fade { from { opacity: 0; } to { opacity: 1; } }
	@keyframes mending-startup-scan { 0% { opacity: 0; } 8% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
	@keyframes mending-startup-sweep { from { opacity: 0; transform: translateY(-45%); } 45% { opacity: 1; } to { opacity: 0; transform: translateY(45%); } }
	@keyframes mending-startup-fade { 0% { opacity: 0; } 8% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
	@keyframes mending-card-highlight { 0%, 100% { box-shadow: none; } 35% { box-shadow: 0 0 0 2px rgba(53, 227, 232, .4); } }
	@keyframes mending-points-color { 0%, 100% { color: #ecfbff; } 35% { color: #64f5f0; } }
	.terminal-dialog-header { position: sticky; top: -24px; z-index: 2; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; margin: -24px -24px 22px; padding: 24px; background: linear-gradient(180deg, rgba(4, 29, 43, .98), rgba(3, 20, 30, .98)); }
	:global(.mending-dialog-content .mending-dialog-title) { display: inline-flex; align-items: center; min-width: 0; gap: 8px; margin: 0; color: #ecfbff; font-size: clamp(18px, 4vw, 22px); line-height: 1.15; font-weight: 800; letter-spacing: .03em; }
	:global(.mending-dialog-title svg) { flex: 0 0 auto; width: 22px; height: 22px; color: #35e3e8; }
	:global(.mending-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.owned-points { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; color: #ecfbff; white-space: nowrap; }
	.terminal-dialog-header > :global(.action-button-close) { grid-column: 3; }
	.owned-points :global(svg), :global(.details-toggle svg) { width: 18px; height: 18px; }
	.owned-points :global(svg) { color: #9bb4bf; }
	.owned-points-value { color: #ecfbff; font-size: 16px; font-weight: 800; }
	.status-group { margin-bottom: 14px; }
	.progress-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 3px 6px; margin: 0 0 8px; color: #cfe7ee; font-size: clamp(16px, 3vw, 20px); font-weight: 700; line-height: 1.3; letter-spacing: .01em; font-variant-numeric: tabular-nums; text-align: center; }
	.progress-prefix { color: #9bb4bf; font-size: .8em; font-weight: 600; }
	.progress-heading.overflow-lifespan-status { display: grid; gap: 2px; }
	.progress-heading.overflow-lifespan-status span { display: block; }
	.progress-duration { color: #35e3e8; font-weight: 800; }
	.progress-track { width: 100%; height: 11px; overflow: hidden; border: 1px solid rgba(53, 227, 232, .72); border-radius: 999px; background: #06303d; box-shadow: 0 0 0 1px rgba(53, 227, 232, .03) inset; }
	.progress-value { height: 100%; min-width: 2px; background: linear-gradient(90deg, #2ee3df, #64f5f0); border-radius: inherit; }
	.result-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; gap: 12px; margin-bottom: 14px; }
	.result-card { display: flex; align-items: center; gap: 14px; min-width: 0; min-height: 106px; padding: 14px 16px; border: 1px solid rgba(35, 220, 226, .32); border-radius: 12px; background: rgba(9, 40, 52, .62); }
	.result-card > :global(svg) { flex: 0 0 auto; width: 28px; height: 28px; color: #35e3e8; }
	.result-copy { display: grid; gap: 0; min-width: 0; }
	.result-label { margin-bottom: 3px; color: #9bb4bf; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
	.result-card strong { color: #ecfbff; font-size: 24px; font-weight: 850; line-height: 1.1; letter-spacing: .01em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.next-point, .result-support { display: inline-flex; align-items: center; gap: 6px; min-height: 16px; margin-top: 3px; color: #cfe7ee; font-size: 12px; line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; }
	.next-point-hidden { visibility: hidden; }
	.next-point :global(svg) { width: 15px; height: 15px; color: #35e3e8; }
	.action-group { display: grid; gap: 10px; margin: 4px 0 6px; }
	:global(.collect-button) { width: 100%; min-width: 0; min-height: 50px; height: 50px; padding: 0 14px; font-size: 16px; }
	:global(.collect-button svg) { flex: 0 0 auto; width: 24px; height: 24px; }
	:global(.details-toggle) { width: 100%; min-height: 44px; padding: 10px 0; color: #9bb4bf; font-weight: 400; text-align: center; }
	.utility-group { display: grid; gap: 6px; }
	.details-section { border-top: 1px solid rgba(35, 220, 226, .16); border-bottom: 1px solid rgba(35, 220, 226, .16); }
	:global(.details-toggle svg) { color: #9bb4bf; }
	.details-content { display: grid; gap: 8px; padding: 0 0 12px; color: rgba(208, 246, 248, 0.78); font-size: 0.92rem; line-height: 1.45; }
	.details-content p { margin: 0; display: flex; justify-content: space-between; gap: 16px; }
	.details-content strong { color: #f2ffff; font-weight: 700; text-align: right; }
	:global(.mending-dialog-content button:focus-visible:not(.action-button-close)) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 700px) { :global(.mending-dialog-content) { width: min(calc(100vw - 16px), 720px); padding: 24px; } .result-list { grid-template-columns: 1fr; } }
	@media (max-width: 560px) { :global(.mending-dialog-content) { padding: 22px 18px; border-radius: 14px; } .terminal-dialog-header { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin: -22px -18px 22px; padding: 22px 18px; } .owned-points { grid-row: 2; grid-column: 1 / 3; padding-top: 0; } .terminal-dialog-header > :global(.action-button-close) { grid-row: 1; grid-column: 2; } .details-content p { align-items: flex-start; flex-direction: column; gap: 2px; } .details-content strong { text-align: left; } }
</style>
