<script lang="ts">
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
	let mendingLabel = $derived(mendingProjection?.completed ? '繕い満杯' : mendingProjection?.lifespanExtensionPerHour ? `繕い中 +${formatMendingRate(mendingProjection.lifespanExtensionPerHour.numerator, mendingProjection.lifespanExtensionPerHour.denominator)}h/h` : null);
</script>

<div class="lifespan-hud" aria-label={mendingLabel ? `${label}、${mendingLabel}` : label}>
	<span>{label}</span>
	<span>ポイント {points.toFixed(2)}pt</span>
	{#if mendingLabel}<span class="mending-status">{mendingLabel}</span>{/if}
</div>

<style>
	.lifespan-hud {
		position: absolute;
		top: max(12px, env(safe-area-inset-top));
		right: max(12px, env(safe-area-inset-right));
		z-index: 8;
		padding: 8px 12px;
		border-radius: 999px;
		background: rgba(250, 250, 244, 0.82);
		color: #43524d;
		font-size: 16px;
		font-weight: 700;
		line-height: 1.25;
		pointer-events: none;
		white-space: nowrap;
		display: grid;
		gap: 2px;
		text-align: right;

		.mending-status {
			color: #667a70;
			font-size: 0.82em;
		}

		@media (max-width: 700px) {
			padding: 5px 9px;
			font-size: 12px;
		}
	}
</style>
