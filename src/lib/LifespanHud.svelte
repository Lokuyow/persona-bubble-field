<script lang="ts">
	import { formatRemainingLifespan } from '$lib/lifespanHud';

	type Props = Readonly<{
		expiresAtMs: number;
		nowMs: number;
	}>;

	let { expiresAtMs, nowMs }: Props = $props();
	let label = $derived(formatRemainingLifespan(expiresAtMs, nowMs));
</script>

<div class="lifespan-hud" aria-label={label}>{label}</div>

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

		@media (max-width: 700px) {
			padding: 5px 9px;
			font-size: 12px;
		}
	}
</style>
