<script lang="ts">
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import PlayerPause from '~icons/tabler/player-pause';
	import Tool from '~icons/tabler/tool';
	import Wallet from '~icons/tabler/wallet';
	import { formatMendingRate, formatRemainingLifespan } from '$lib/lifespanHud';
	import type { MendingProjection } from '$lib/mending';
	import type { TagGameHudProjection } from '$lib/tagGameHud';

	type Props = Readonly<{
		expiresAtMs: number;
		nowMs: number;
		points: number;
		hasJob: boolean;
		mendingProjection: MendingProjection | null;
		tagGameProjection?: TagGameHudProjection | null;
	}>;

	let { expiresAtMs, nowMs, points, hasJob, mendingProjection, tagGameProjection = null }: Props = $props();
	let displayExpiresAtMs = $derived(tagGameProjection?.expiresAtMs ?? expiresAtMs);
	let displayPoints = $derived(tagGameProjection?.points ?? points);
	let displayLabel = $derived(formatRemainingLifespan(displayExpiresAtMs, nowMs));
	let displayLifespanValue = $derived(displayLabel.replace(/^寿命\s+/, ''));
	let mendingState = $derived(!hasJob || !mendingProjection ? null : !mendingProjection.completed ? '作業中' : mendingProjection.lifespanExtensionRateHundredthsPerHour > 0 ? '延命中' : '作業停止中');
	let pointRate = $derived(hasJob && mendingProjection ? `${(mendingProjection.pointRateHundredthsPerMinute / 100).toFixed(2)} pt/分` : null);
	let lifespanRate = $derived(hasJob && mendingProjection ? `+${formatMendingRate(mendingProjection.lifespanExtensionRateHundredthsPerHour, 100)}h/h` : null);
</script>


<div class="lifespan-hud" aria-label={mendingState ? `${displayLabel}、ポイント ${displayPoints}pt、${mendingState}` : `${displayLabel}、ポイント ${displayPoints}pt`} data-saved-points={points} data-tag-game-projection={tagGameProjection ? 'true' : undefined}>
	<span class="lifespan-value" data-stat-icon="heart"><Heart aria-hidden="true" /><span class="stat-value" data-tag-game-projected-lifespan={tagGameProjection?.expiresAtMs}>{displayLifespanValue}</span></span>
	<span class="points-value" data-stat-icon="wallet"><Wallet aria-hidden="true" /><span class="stat-value" data-tag-game-projected-points={tagGameProjection?.points}>{displayPoints}pt</span></span>
	{#if tagGameProjection && (tagGameProjection.confirmedLossNotSavedMs > 0 || tagGameProjection.predictedLossMs > 0 || tagGameProjection.calamityRateActive)}
		<div class="tag-game-prediction" data-tag-game-projection-row="lifespan">
			{#if tagGameProjection.calamityRateActive}<strong>-1時間/秒・予測</strong>{/if}
			{#if tagGameProjection.confirmedLossNotSavedMs > 0}<span>鬼ごっこ確定分・保存待ち</span>{/if}
			{#if tagGameProjection.predictedLossMs > 0}<span>未確定予測を含む</span>{/if}
		</div>
	{/if}
	{#if tagGameProjection && (tagGameProjection.confirmedPointsNotSaved > 0 || tagGameProjection.predictedPoints > 0 || tagGameProjection.benefitRateActive)}
		<div class="tag-game-prediction" data-tag-game-projection-row="points">
			{#if tagGameProjection.benefitRateActive}<strong>+50pt/秒・予測</strong>{/if}
			{#if tagGameProjection.confirmedPointsNotSaved > 0}<span>鬼ごっこ確定分・保存待ち</span>{/if}
			{#if tagGameProjection.predictedPoints > 0}<span>未確定予測を含む</span>{/if}
		</div>
	{/if}
	{#if mendingState}
		<div class="mending-row" data-mending-row>
			<span class="mending-status" data-mending-status data-mending-icon={mendingState === '作業中' ? 'tool' : mendingState === '延命中' ? 'heart-plus' : 'player-pause'} role="img" aria-label={mendingState}>
				{#if mendingState === '作業中'}<Tool aria-hidden="true" />{:else if mendingState === '延命中'}<HeartPlus aria-hidden="true" />{:else}<PlayerPause aria-hidden="true" />{/if}
			</span>
			<span class="mending-rate" data-mending-rate><span>{pointRate}</span><span>{lifespanRate}</span></span>
		</div>
	{/if}
</div>

<style>
	.lifespan-hud {
		position: relative;
		min-width: 0;
		width: 100%;
		padding: 8px 10px;
		border: 1px solid rgba(132, 142, 255, 0.52);
		border-radius: 10px;
		background: linear-gradient(145deg, rgba(10, 17, 35, 0.82), rgba(15, 17, 42, 0.72));
		box-shadow: 0 0 16px rgba(92, 105, 255, 0.16), inset 0 0 14px rgba(100, 105, 220, 0.08);
		color: rgba(239, 241, 255, 0.92);
		font-size: 14px;
		font-weight: 600;
		line-height: 1.35;
		pointer-events: none;
		white-space: nowrap;
		display: grid;
		gap: 4px;
		text-align: right;

		.lifespan-value {
			display: grid;
			grid-template-columns: 16px minmax(0, 1fr);
			align-items: center;
			gap: 6px;
			width: 100%;
			color: #fff;
			font-size: 1.18em;
			font-weight: 800;
		}

		.points-value { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 6px; width: 100%; color: rgba(226, 230, 255, 0.86); }
		.stat-value { text-align: right; }
		.lifespan-value :global(svg), .points-value :global(svg) { width: 16px; height: 16px; flex: 0 0 auto; }

		.mending-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 6px; width: 100%; }
		.mending-status { display: grid; width: 16px; height: 16px; place-items: center; color: #b9b8ff; }
		.mending-status :global(svg) { width: 16px; height: 16px; }

		.mending-rate { display: flex; justify-content: space-between; gap: 12px; width: 100%; color: rgba(226, 230, 255, 0.86); font-size: 0.82em; font-weight: 600; }
		.tag-game-prediction { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 8px; width: 100%; color: rgba(226, 230, 255, .9); font-size: .78em; }
		.tag-game-prediction strong { color: #fff; font-weight: 750; }

		@media (max-width: 700px) {
			padding: 7px 10px;
			font-size: 11px;
		}
	}
</style>
