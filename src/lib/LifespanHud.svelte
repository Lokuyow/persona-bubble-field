<script lang="ts">
	import Heart from '~icons/tabler/heart';
	import Wallet from '~icons/tabler/wallet';
	import { formatMendingRate, formatRemainingLifespan } from '$lib/lifespanHud';
	import type { MendingProjection } from '$lib/mending';

	type Props = Readonly<{
		expiresAtMs: number;
		nowMs: number;
		points: number;
		mendingProjection: MendingProjection | null;
	}>;

	let { expiresAtMs, nowMs, points, mendingProjection }: Props = $props();
	let label = $derived(formatRemainingLifespan(expiresAtMs, nowMs));
	let lifespanValue = $derived(label.replace(/^寿命\s+/, ''));
	let mendingLabel = $derived(mendingProjection?.completed ? '作業満杯' : mendingProjection?.lifespanExtensionPerHour ? `作業中 +${formatMendingRate(mendingProjection.lifespanExtensionPerHour.numerator, mendingProjection.lifespanExtensionPerHour.denominator)}h/h` : null);
</script>


<div class="lifespan-hud" aria-label={mendingLabel ? `${label}、ポイント ${points}pt、${mendingLabel}` : `${label}、ポイント ${points}pt`}>
	<span class="lifespan-value" data-stat-icon="heart"><Heart aria-hidden="true" /><span class="stat-value">{lifespanValue}</span></span>
	<span class="points-value" data-stat-icon="wallet"><Wallet aria-hidden="true" /><span class="stat-value">{points}pt</span></span>
	{#if mendingLabel}<span class="mending-status">{mendingLabel}</span>{/if}
</div>

<style>
	.lifespan-hud {
		position: absolute;
		top: max(12px, env(safe-area-inset-top));
		right: max(72px, calc(env(safe-area-inset-right) + 72px));
		z-index: 8;
		min-width: 172px;
		padding: 10px 14px;
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

		.mending-status {
			color: #b9b8ff;
			font-size: 0.88em;
			font-weight: 700;
		}

		@media (max-width: 700px) {
			min-width: 0;
			padding: 7px 10px;
			border-radius: 8px;
			font-size: 11px;
		}
	}
</style>
