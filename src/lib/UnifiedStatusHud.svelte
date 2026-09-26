<script lang="ts">
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import PlayerPause from '~icons/tabler/player-pause';
	import Tool from '~icons/tabler/tool';
	import Wallet from '~icons/tabler/wallet';
	import { Meter } from 'bits-ui';
	import { formatMendingRate, formatRemainingDuration, formatRemainingLifespan } from '$lib/lifespanHud';
	import type { MendingProjection } from '$lib/mending';
	import type { TagGameHudProjection } from '$lib/tagGameHud';
	import { projectUnifiedStatusMeterValues, STATUS_HUD_POINTS_MAX } from '$lib/unifiedStatusHud';

	type Props = Readonly<{
		expiresAtMs: number;
		nowMs: number;
		maximumLifespanMs: number;
		points: number;
		hasJob: boolean;
		mendingProjection: MendingProjection | null;
		tagGameProjection?: TagGameHudProjection | null;
	}>;

	let { expiresAtMs, nowMs, maximumLifespanMs, points, hasJob, mendingProjection, tagGameProjection = null }: Props = $props();
	let remainingMs = $derived(Math.max(0, expiresAtMs - nowMs));
	let meterValues = $derived(projectUnifiedStatusMeterValues(points, remainingMs, maximumLifespanMs));
	let lifespanValue = $derived(meterValues.lifespan);
	let lifespanText = $derived(formatRemainingLifespan(expiresAtMs, nowMs).replace(/^寿命\s+/, ''));
	let pointValue = $derived(meterValues.points);
	let formattedPoints = $derived(points.toLocaleString('en-US'));
	let mendingState = $derived(!hasJob || !mendingProjection ? null : !mendingProjection.completed ? '作業中' : mendingProjection.lifespanExtensionRateHundredthsPerHour > 0 ? '延命中' : '作業停止中');
	let pointRate = $derived(hasJob && mendingProjection ? `${(mendingProjection.pointRateHundredthsPerMinute / 100).toFixed(2)} pt/分` : null);
	let lifespanRate = $derived(hasJob && mendingProjection ? `+${formatMendingRate(mendingProjection.lifespanExtensionRateHundredthsPerHour, 100)}h/h` : null);
	let lifespanAriaValue = $derived(`${lifespanText}、最大 ${maximumLifespanMs / (24 * 60 * 60 * 1_000)}日`);
</script>

<section class="unified-status-hud" aria-label="寿命とポイント" data-unified-status-hud data-saved-points={points} data-maximum-lifespan-ms={maximumLifespanMs} data-tag-game-projection={tagGameProjection ? 'true' : undefined}>
	<div class="meter-grid">
		<div class="meter-row lifespan-row">
			<div class="meter-heading">
				<span class="meter-label"><Heart aria-hidden="true" />寿命</span>
				<strong class="lifespan-value" data-lifespan-value>{lifespanText}</strong>
			</div>
			<Meter.Root class="status-meter lifespan-meter" value={lifespanValue} min={0} max={maximumLifespanMs} aria-label="寿命" aria-valuetext={lifespanAriaValue} data-lifespan-meter data-meter-value={lifespanValue}>
				<div class="meter-fill lifespan-fill" style={`width:${maximumLifespanMs > 0 ? lifespanValue / maximumLifespanMs * 100 : 0}%`}></div>
			</Meter.Root>
		</div>
		<div class="meter-row points-row">
			<div class="meter-heading">
				<span class="meter-label"><Wallet aria-hidden="true" />ポイント</span>
				<strong class="points-value" data-points-value>{formattedPoints}<span>pt</span></strong>
			</div>
			<Meter.Root class="status-meter points-meter" value={pointValue} min={0} max={STATUS_HUD_POINTS_MAX} aria-label="ポイント" aria-valuetext={`${formattedPoints}pt、${STATUS_HUD_POINTS_MAX.toLocaleString('en-US')}ptまで`} data-points-meter data-meter-value={pointValue}>
				<div class="meter-fill points-fill" style={`width:${pointValue / STATUS_HUD_POINTS_MAX * 100}%`}></div>
			</Meter.Root>
		</div>
	</div>
	{#if tagGameProjection && (tagGameProjection.confirmedLossNotSavedMs > 0 || tagGameProjection.predictedLossMs > 0 || tagGameProjection.calamityRateActive)}
		<div class="projection-row lifespan-projection" data-tag-game-projection-row="lifespan">
			{#if tagGameProjection.calamityRateActive}<strong>−1時間/秒・予測中</strong>{/if}
			{#if tagGameProjection.confirmedLossNotSavedMs > 0}<span>鬼ごっこ確定分 −{formatRemainingDuration(tagGameProjection.confirmedLossNotSavedMs)}・保存待ち</span>{/if}
			{#if tagGameProjection.predictedLossMs > 0}<span>未確定予測 −{formatRemainingDuration(tagGameProjection.predictedLossMs)}</span>{/if}
		</div>
	{/if}
	{#if tagGameProjection && (tagGameProjection.confirmedPointsNotSaved > 0 || tagGameProjection.predictedPoints > 0 || tagGameProjection.benefitRateActive)}
		<div class="projection-row points-projection" data-tag-game-projection-row="points">
			{#if tagGameProjection.benefitRateActive}<strong>+50pt/秒・予測中</strong>{/if}
			{#if tagGameProjection.confirmedPointsNotSaved > 0}<span>鬼ごっこ確定分 +{tagGameProjection.confirmedPointsNotSaved.toLocaleString('en-US')}pt・保存待ち</span>{/if}
			{#if tagGameProjection.predictedPoints > 0}<span>未確定予測 +{tagGameProjection.predictedPoints.toLocaleString('en-US')}pt</span>{/if}
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
</section>

<style>
	.unified-status-hud {
		box-sizing: border-box;
		width: 100%;
		padding: 9px 14px 8px;
		border: 1px solid rgba(132, 142, 255, .48);
		border-radius: 12px;
		background: linear-gradient(110deg, rgba(10, 17, 35, .92), rgba(15, 17, 42, .86));
		box-shadow: 0 4px 18px rgba(0, 0, 0, .2), inset 0 0 14px rgba(100, 105, 220, .08);
		color: rgba(239, 241, 255, .94);
		font-size: 13px;
		line-height: 1.2;
		pointer-events: none;
		display: grid;
		gap: 6px;

		.meter-row { min-width: 0; display: grid; gap: 4px; }
		.meter-grid { display: grid; gap: 6px; min-width: 0; }
		.meter-heading { min-width: 0; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
		.meter-label { display: inline-flex; align-items: center; gap: 6px; color: rgba(226, 230, 255, .82); font-size: .9em; font-weight: 700; }
		.meter-label :global(svg) { width: 15px; height: 15px; }
		.lifespan-value, .points-value { font-size: 1.05em; font-weight: 780; font-variant-numeric: tabular-nums; }
		.points-value { color: #fff; }
		.points-value span { margin-left: 3px; font-size: .9em; font-weight: 700; }
		:global(.status-meter) { box-sizing: border-box; display: block; position: relative; height: 14px; overflow: hidden; border: 1px solid rgba(236, 239, 255, .2); border-radius: 0; background: rgba(3, 7, 20, .58); }
		.meter-fill { height: 100%; min-width: 0; border-radius: 0; transition: width 180ms linear; }
		.lifespan-fill { background: linear-gradient(90deg, #e19b6b, #f2c47b); box-shadow: 0 0 10px rgba(241, 180, 114, .3); }
		.points-fill { background: linear-gradient(90deg, #7b81ff, #b8adff); box-shadow: 0 0 10px rgba(135, 137, 255, .34); }
		.projection-row { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 2px 12px; color: rgba(226, 230, 255, .86); font-size: .78em; }
		.projection-row strong { color: #fff; font-weight: 750; }
		.mending-row { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 6px; }
		.mending-status { display: grid; width: 16px; height: 16px; place-items: center; color: #b9b8ff; }
		.mending-status :global(svg) { width: 16px; height: 16px; }
		.mending-rate { min-width: 0; display: flex; justify-content: space-between; gap: 12px; color: rgba(226, 230, 255, .86); font-size: .82em; font-weight: 600; }

		@media (min-width: 960px) {
			.meter-grid { grid-template-columns: max-content minmax(0, 1fr) max-content; }
			.meter-row { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; column-gap: 14px; row-gap: 0; }
			.meter-heading { display: contents; }
			.meter-label { grid-column: 1; grid-row: 1; align-self: center; white-space: nowrap; }
			.meter-row :global(.status-meter) { grid-column: 2; grid-row: 1; align-self: center; width: 100%; }
			.lifespan-value, .points-value { grid-column: 3; grid-row: 1; align-self: center; text-align: right; white-space: nowrap; }
		}

		@media (max-width: 700px) {
			padding: 7px 10px;
			font-size: 11px;
			gap: 5px;
			.meter-grid { gap: 5px; }
			:global(.status-meter) { height: 12px; }
		}
	}
	@media (prefers-reduced-motion: reduce) { .unified-status-hud .meter-fill { transition: none; } }
</style>
