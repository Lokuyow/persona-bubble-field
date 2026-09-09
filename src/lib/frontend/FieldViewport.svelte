<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = Readonly<{
		viewportElement?: HTMLElement;
		geometryReady: boolean;
		composerAvailable: boolean;
		speechAreaVisualBounds: Readonly<{ x: number; y: number; width: number; height: number }>;
		children: Snippet;
	}>;

	let {
		viewportElement = $bindable(),
		geometryReady,
		composerAvailable,
		speechAreaVisualBounds,
		children
	}: Props = $props();
</script>

<section
	class={['field-viewport', {
		'initial-field-geometry-ready': geometryReady,
		'composer-available': composerAvailable
	}]}
	bind:this={viewportElement}
	aria-label="Conversation field"
>
	<div
		class="speech-area"
		style={`top: ${speechAreaVisualBounds.y}px; height: ${speechAreaVisualBounds.height}px; left: ${speechAreaVisualBounds.x}px; width: ${speechAreaVisualBounds.width}px;`}
		aria-hidden="true"
	></div>
	{@render children()}
	<div class="viewport-vignette" aria-hidden="true"></div>
</section>

<style>
	.field-viewport {
		position: relative;
		min-height: 100svh;
		flex: 1;
		overflow: hidden;
		isolation: isolate;
		background: transparent;
		user-select: none;
		-webkit-user-select: none;
	}

	.field-viewport.composer-available {
		min-height: 0;
	}

	.field-viewport::before {
		position: absolute;
		inset: 0;
		z-index: -1;
		background: transparent;
		content: '';
	}

	.speech-area {
		position: absolute;
		z-index: 1;
		pointer-events: none;
	}

	.viewport-vignette {
		position: absolute;
		inset: 0;
		z-index: 7;
		pointer-events: none;
		box-shadow: inset 0 0 80px rgba(89, 101, 82, 0.12);
	}
</style>
