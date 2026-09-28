<script lang="ts">
	import { tagGameCountdownSeconds } from '$lib/tagGamePresentation';
	let { startAt, nowMs }: Readonly<{ startAt: number; nowMs: number }> = $props();
	let seconds = $derived(tagGameCountdownSeconds(startAt, nowMs));
</script>

{#if seconds !== null}
	<div class="countdown" data-tag-game-countdown data-countdown-seconds={seconds} role="timer" aria-label={`鬼ごっこ開始まであと${seconds}秒`}>
		<strong aria-hidden="true">{seconds}</strong>
	</div>
{/if}

<style>
	.countdown {
		position: fixed;
		inset: 0;
		z-index: 120;
		display: grid;
		place-items: center;
		background: rgb(12 18 26 / 38%);
		color: #fff;
		pointer-events: none;
	}

	.countdown strong {
		font-size: clamp(8rem, 34vw, 24rem);
		font-weight: 900;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		text-shadow: 0 5px 24px rgb(0 0 0 / 72%), 0 0 4px rgb(0 0 0 / 95%);
	}
</style>
