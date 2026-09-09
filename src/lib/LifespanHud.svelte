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
		max-width: calc(100% - 24px);
		padding: 5px 9px;
		border: 1px solid rgba(57, 67, 64, 0.22);
		border-radius: 999px;
		background: rgba(250, 250, 244, 0.82);
		box-shadow: 0 4px 12px rgba(58, 70, 61, 0.12);
		color: #43524d;
		font-size: 12px;
		font-weight: 700;
		line-height: 1.25;
		pointer-events: none;
		white-space: nowrap;
	}
</style>
