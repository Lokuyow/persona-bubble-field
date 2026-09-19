<script lang="ts">
	import { Dialog } from 'bits-ui';
	import Coins from '~icons/tabler/coins';
	import Clock from '~icons/tabler/clock';
	import ChevronDown from '~icons/tabler/chevron-down';
	import ChevronUp from '~icons/tabler/chevron-up';
	import Heart from '~icons/tabler/heart';
	import Wallet from '~icons/tabler/wallet';
	import type { MendingProjection } from '$lib/mending';
	import { formatElapsedDuration, formatRemainingDuration } from '$lib/lifespanHud';

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		points: number;
		onOpenChange: (open: boolean) => void;
		onStart: () => void;
		onCollect: () => void;
	}>;

	let { open, projection, hasJob, points: ownedPointsValue, onOpenChange, onStart, onCollect }: Props = $props();
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
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content class="mending-dialog-content" preventScroll={false}>
				<div class="terminal-dialog-header">
					<div>
						<Dialog.Title>作業中</Dialog.Title>
						<Dialog.Description class="sr-only">時間の経過で成果が蓄積され、ポイントと寿命延長を受け取れます。</Dialog.Description>
					</div>
					<div class="owned-points" data-mending-icon="wallet" aria-label={`所持ポイント ${ownedPoints} pt`}>
						<Wallet aria-hidden="true" />
						<span>{ownedPoints} pt</span>
					</div>
				</div>
				{#if !hasJob}
					<section class="idle-state">
						<p>作業を開始すると、時間に応じて成果が蓄積されます。</p>
						<button class="terminal-primary-action" type="button" onclick={onStart}>作業を開始</button>
					</section>
				{:else}
					<section class="progress-section" aria-label="作業の進捗">
						<strong class="progress-heading">{projection?.completed ? '上限に達しました' : `上限まで あと${remainingDuration}`}</strong>
						<div class="progress-track" role="progressbar" aria-label="作業の蓄積進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressPercent)}>
							<div class="progress-value" style={`width: ${progressPercent}%;`}></div>
						</div>
					</section>
					<section class="result-section" aria-labelledby="mending-result-title">
						<h3 id="mending-result-title">今受け取れる</h3>
						<div class="result-list">
							<div class="result-row" data-mending-icon="coins"><Coins aria-hidden="true" /><span>+{unclaimedPoints} pt</span></div>
							<div class="result-row" data-mending-icon="heart"><Heart aria-hidden="true" /><span>寿命 +{lifespanDuration}</span></div>
						</div>
					</section>
					{#if nextPointSeconds !== null}
						<p class="next-point" data-mending-icon="clock"><Clock aria-hidden="true" />次の1ptまで {nextPointSeconds}秒</p>
					{/if}
					<section class="details-section" aria-label="作業の詳細">
						<button class="details-toggle" type="button" aria-expanded={detailsOpen} onclick={() => detailsOpen = !detailsOpen}>
							<span>{detailsOpen ? '詳細を閉じる' : '詳細を見る'}</span>
							{#if detailsOpen}<ChevronUp aria-hidden="true" />{:else}<ChevronDown aria-hidden="true" />{/if}
						</button>
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
					<button class="terminal-primary-action" type="button" onclick={onCollect}>成果を受け取る</button>
				{/if}
				<Dialog.Close class="terminal-secondary-action">閉じる</Dialog.Close>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.mending-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(2, 8, 18, 0.72); backdrop-filter: blur(2px); }
	:global(.mending-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 18px; width: min(calc(100vw - 32px), 700px); max-height: calc(100svh - 32px); overflow: auto; padding: clamp(20px, 4vw, 34px); border: 1px solid rgba(68, 222, 222, 0.7); border-radius: 14px; background: linear-gradient(145deg, rgba(4, 26, 38, 0.98), rgba(3, 14, 28, 0.96)); box-shadow: 0 0 28px rgba(26, 214, 224, 0.2), inset 0 0 22px rgba(28, 184, 202, 0.08); color: #ecfeff; transform: translate(-50%, -50%); }
	:global(.mending-dialog-content)::before { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background-image: linear-gradient(rgba(67, 214, 221, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(67, 214, 221, 0.035) 1px, transparent 1px); background-size: 22px 22px; content: ''; pointer-events: none; }
	.terminal-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(68, 222, 222, 0.36); }
	:global(.mending-dialog-content h2) { margin: 0; color: #f2ffff; font-size: clamp(1.6rem, 4vw, 2.25rem); letter-spacing: 0.08em; }
	:global(.mending-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.owned-points { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 5px; padding-top: 4px; color: rgba(208, 246, 248, 0.78); font-size: 0.9rem; }
	.owned-points :global(svg), .result-row :global(svg), .next-point :global(svg), .details-toggle :global(svg) { width: 18px; height: 18px; }
	.owned-points :global(svg) { color: #9de8ed; }
	.progress-section, .result-section, .details-section { display: grid; gap: 10px; }
	.progress-heading { color: #f2ffff; font-size: clamp(1.35rem, 4vw, 2rem); }
	.progress-track { height: 13px; overflow: hidden; border: 1px solid rgba(68, 222, 222, 0.78); border-radius: 999px; background: rgba(1, 35, 47, 0.86); }
	.progress-value { height: 100%; min-width: 2px; background: linear-gradient(90deg, #27e6dd, #80ffff); box-shadow: 0 0 12px rgba(39, 230, 221, 0.7); }
	.result-section h3 { margin: 0; padding-top: 4px; color: #a4ffff; font-size: 1.05rem; letter-spacing: 0.08em; }
	.result-list { display: grid; gap: 10px; }
	.result-row, .next-point, .details-toggle { display: flex; align-items: center; gap: 9px; }
	.result-row { color: #f2ffff; font-size: 1.15rem; font-weight: 800; }
	.result-row :global(svg) { color: #85ffff; }
	.next-point { margin: 0; color: rgba(208, 246, 248, 0.82); }
	.next-point :global(svg) { color: #9de8ed; }
	.details-toggle { justify-content: space-between; width: 100%; min-height: 40px; padding: 8px 0; border: 0; border-top: 1px solid rgba(68, 222, 222, 0.24); border-bottom: 1px solid rgba(68, 222, 222, 0.24); background: transparent; color: #a4ffff; font: inherit; font-weight: 800; text-align: left; cursor: pointer; }
	.details-content { display: grid; gap: 8px; padding: 2px 0 4px; color: rgba(208, 246, 248, 0.78); font-size: 0.92rem; line-height: 1.45; }
	.details-content p { margin: 0; display: flex; justify-content: space-between; gap: 16px; }
	.details-content strong { color: #f2ffff; font-weight: 700; text-align: right; }
	.idle-state { display: grid; gap: 14px; }
	.idle-state p { margin: 0; color: rgba(208, 246, 248, 0.78); }
	.terminal-primary-action, :global(.terminal-secondary-action) { min-height: 46px; border-radius: 7px; font: inherit; font-weight: 800; cursor: pointer; }
	.terminal-primary-action { border: 1px solid #72ffff; background: linear-gradient(135deg, #20cfd0, #087eaa); box-shadow: 0 0 15px rgba(45, 229, 231, 0.3); color: #02141e; }
	:global(.terminal-secondary-action) { border: 1px solid rgba(141, 208, 218, 0.42); background: rgba(8, 31, 47, 0.7); color: rgba(224, 250, 252, 0.86); text-align: center; }
	:global(.mending-dialog-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 560px) { .terminal-dialog-header { flex-direction: column; } .owned-points { padding-top: 0; } .details-content p { align-items: flex-start; flex-direction: column; gap: 2px; } .details-content strong { text-align: left; } }
</style>
