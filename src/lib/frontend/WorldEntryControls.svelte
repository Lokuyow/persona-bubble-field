<script lang="ts">
	let { onRetry }: { onRetry: () => void } = $props();
</script>

<div class="world-controls" aria-label="World entry controls">
	<button class="world-entry-retry" type="button" onclick={onRetry}>Enter field again</button>
</div>

<style>
	.world-controls {
		position: absolute;
		z-index: 10;
	}

	.world-controls {
		bottom: 76px;
		left: 50%;
		z-index: 11;
		transform: translateX(-50%);
	}

	:global(.composer-available) .world-controls {
		bottom: calc(var(--composer-dock-height) + 76px);
	}

	.world-entry-retry {
		border: 1px solid rgba(57, 67, 64, 0.2);
		background: rgba(255, 255, 255, 0.86);
		box-shadow: 0 5px 12px rgba(58, 70, 61, 0.14);
		color: #3f4a47;
		font-weight: 800;
	}

	.world-entry-retry {
		min-height: 38px;
		padding: 0 14px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 800;
		letter-spacing: 0.04em;
	}

	.world-entry-retry:focus-visible {
		outline: 3px solid var(--color-focus-ring);
		outline-offset: 2px;
	}

	@media (max-width: 700px) {
		.world-controls {
			bottom: 76px;
		}
	}
</style>
