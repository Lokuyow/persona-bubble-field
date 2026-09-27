<script lang="ts">
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import PlayerPause from '~icons/tabler/player-pause';
	import Tool from '~icons/tabler/tool';
	import Wallet from '~icons/tabler/wallet';
	import { Meter } from 'bits-ui';
	import { formatMendingRate, formatRemainingLifespan } from '$lib/lifespanHud';
	import type { MendingProjection } from '$lib/mending';
	import type { TagGameHudProjection } from '$lib/tagGameHud';
	import { getStatusValueChangeDirection, projectUnifiedStatusMeterValues, STATUS_HUD_POINTS_MAX, type StatusValueChangeDirection } from '$lib/unifiedStatusHud';

	type Props = Readonly<{
		expiresAtMs: number;
		nowMs: number;
		maximumLifespanMs: number;
		points: number;
		hasJob: boolean;
		mendingProjection: MendingProjection | null;
		tagGameProjection?: TagGameHudProjection | null;
		animationScope: string;
	}>;

	let { expiresAtMs, nowMs, maximumLifespanMs, points, hasJob, mendingProjection, tagGameProjection = null, animationScope }: Props = $props();
	let currentPoints = $derived(tagGameProjection?.points ?? points);
	let currentExpiresAtMs = $derived(tagGameProjection?.expiresAtMs ?? expiresAtMs);
	let tagGameBenefitActive = $derived(tagGameProjection?.benefitRateActive ?? false);
	let tagGameCalamityActive = $derived(tagGameProjection?.calamityRateActive ?? false);
	let remainingMs = $derived(Math.max(0, currentExpiresAtMs - nowMs));
	let meterValues = $derived(projectUnifiedStatusMeterValues(currentPoints, remainingMs, maximumLifespanMs));
	let lifespanValue = $derived(meterValues.lifespan);
	let lifespanText = $derived(formatRemainingLifespan(currentExpiresAtMs, nowMs).replace(/^寿命\s+/, ''));
	let pointValue = $derived(meterValues.points);
	let formattedPoints = $derived(currentPoints.toLocaleString('en-US'));
	let mendingState = $derived(!hasJob || !mendingProjection ? null : !mendingProjection.completed ? '作業中' : mendingProjection.lifespanExtensionRateHundredthsPerHour > 0 ? '延命中' : '作業停止中');
	let pointRate = $derived(hasJob && mendingProjection ? `${(mendingProjection.pointRateHundredthsPerMinute / 100).toFixed(2)} pt/分` : null);
	let lifespanRate = $derived(hasJob && mendingProjection ? `+${formatMendingRate(mendingProjection.lifespanExtensionRateHundredthsPerHour, 100)}h/h` : null);
	let lifespanAriaValue = $derived(`${lifespanText}、最大 ${maximumLifespanMs / (24 * 60 * 60 * 1_000)}日`);
	type ChangeFeedback = Readonly<{ sequence: number; direction: StatusValueChangeDirection }>;
	let lifespanFeedback = $state<ChangeFeedback | null>(null);
	let pointsFeedback = $state<ChangeFeedback | null>(null);
	let lastScope: string | null = null;
	let lastPoints: number | null = null;
	let lastEffectiveExpiresAtMs: number | null = null;
	let feedbackSequence = 0;

	$effect.pre(() => {
		const scope = animationScope;
		const nextPoints = currentPoints;
		// The effective deadline changes when actual projected lifespan changes;
		// the ordinary wall-clock countdown changes only `nowMs`.
		const nextExpiresAtMs = currentExpiresAtMs;
		if (lastScope !== scope) {
			lastScope = scope;
			lastPoints = nextPoints;
			lastEffectiveExpiresAtMs = nextExpiresAtMs;
			lifespanFeedback = null;
			pointsFeedback = null;
			return;
		}
		if (lastPoints !== null) {
			const direction = getStatusValueChangeDirection(lastPoints, nextPoints);
			if (direction) pointsFeedback = { sequence: ++feedbackSequence, direction };
		}
		if (lastEffectiveExpiresAtMs !== null) {
			const direction = getStatusValueChangeDirection(lastEffectiveExpiresAtMs, nextExpiresAtMs);
			if (direction) lifespanFeedback = { sequence: ++feedbackSequence, direction };
		}
		lastPoints = nextPoints;
		lastEffectiveExpiresAtMs = nextExpiresAtMs;
	});

	$effect(() => {
		const sequence = lifespanFeedback?.sequence;
		if (sequence === undefined) return;
		const timeout = window.setTimeout(() => {
			if (lifespanFeedback?.sequence === sequence) lifespanFeedback = null;
		}, 750);
		return () => window.clearTimeout(timeout);
	});
	$effect(() => {
		const sequence = pointsFeedback?.sequence;
		if (sequence === undefined) return;
		const timeout = window.setTimeout(() => {
			if (pointsFeedback?.sequence === sequence) pointsFeedback = null;
		}, 750);
		return () => window.clearTimeout(timeout);
	});
	function valueClass(feedback: ChangeFeedback | null): string {
		return feedback ? `value-changed value-${feedback.direction}` : '';
	}
</script>

<section class="unified-status-hud" aria-label="寿命とポイント" data-unified-status-hud data-saved-points={points} data-base-expires-at-ms={expiresAtMs} data-current-points={currentPoints} data-current-expires-at-ms={currentExpiresAtMs} data-current-remaining-ms={remainingMs} data-maximum-lifespan-ms={maximumLifespanMs} data-tag-game-projection={tagGameProjection ? 'true' : undefined}>
	<div class="meter-grid">
		<div class="meter-row lifespan-row">
			<div class="meter-heading">
				<span class="meter-label"><Heart aria-hidden="true" />寿命</span>
				<strong class={['lifespan-value', valueClass(lifespanFeedback), { 'tag-game-calamity': tagGameCalamityActive }]}
					data-lifespan-value data-value-change={lifespanFeedback?.direction} data-value-change-sequence={lifespanFeedback?.sequence}
					data-tag-game-flash={tagGameCalamityActive ? 'calamity' : undefined}>
					{lifespanText}
				</strong>
			</div>
			<Meter.Root class="status-meter lifespan-meter" value={lifespanValue} min={0} max={maximumLifespanMs} aria-label="寿命" aria-valuetext={lifespanAriaValue} data-lifespan-meter data-meter-value={lifespanValue}>
				<div class="meter-fill lifespan-fill" style={`width:${maximumLifespanMs > 0 ? lifespanValue / maximumLifespanMs * 100 : 0}%`}></div>
			</Meter.Root>
		</div>
		<div class="meter-row points-row">
			<div class="meter-heading">
				<span class="meter-label"><Wallet aria-hidden="true" />ポイント</span>
				<strong class={['points-value', valueClass(pointsFeedback), { 'tag-game-benefit': tagGameBenefitActive }]}
					data-points-value data-value-change={pointsFeedback?.direction} data-value-change-sequence={pointsFeedback?.sequence}
					data-tag-game-flash={tagGameBenefitActive ? 'benefit' : undefined}>
					{formattedPoints}<span>pt</span>
				</strong>
			</div>
			<Meter.Root class="status-meter points-meter" value={pointValue} min={0} max={STATUS_HUD_POINTS_MAX} aria-label="ポイント" aria-valuetext={`${formattedPoints}pt、${STATUS_HUD_POINTS_MAX.toLocaleString('en-US')}ptまで`} data-points-meter data-meter-value={pointValue}>
				<div class="meter-fill points-fill" style={`width:${pointValue / STATUS_HUD_POINTS_MAX * 100}%`}></div>
			</Meter.Root>
		</div>
	</div>
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
		.lifespan-value, .points-value { position: relative; font-size: 1.05em; font-weight: 780; font-variant-numeric: tabular-nums; --normal-value-color: rgba(239, 241, 255, .94); --change-color: #57e68a; color: var(--normal-value-color); }
		.points-value { --normal-value-color: #fff; }
		.points-value span { margin-left: 3px; font-size: .9em; font-weight: 700; }
		.value-changed { color: var(--change-color); }
		.value-increase { --change-color: #57e68a; }
		.value-decrease { --change-color: #ff6875; }
		.tag-game-benefit, .tag-game-calamity { --tag-game-color: #57e68a; animation: tag-game-value-pulse 1.5s linear infinite; }
		.tag-game-calamity { --tag-game-color: #ff6875; }
		:global(.status-meter) { box-sizing: border-box; display: block; position: relative; height: 14px; overflow: hidden; border: 1px solid rgba(236, 239, 255, .2); border-radius: 0; background: rgba(3, 7, 20, .58); }
		.meter-fill { height: 100%; min-width: 0; border-radius: 0; transition: width 180ms linear; }
		.lifespan-fill { background: linear-gradient(90deg, #e19b6b, #f2c47b); box-shadow: 0 0 10px rgba(241, 180, 114, .3); }
		.points-fill { background: linear-gradient(90deg, #7b81ff, #b8adff); box-shadow: 0 0 10px rgba(135, 137, 255, .34); }
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
	@keyframes tag-game-value-pulse {
		0%, 29.99% { color: var(--tag-game-color); }
		30%, 100% { color: var(--normal-value-color); }
	}
	@media (prefers-reduced-motion: reduce) {
		.unified-status-hud .meter-fill { transition: none; }
		.unified-status-hud .tag-game-benefit, .unified-status-hud .tag-game-calamity { animation: none; color: var(--tag-game-color); }
	}
</style>
