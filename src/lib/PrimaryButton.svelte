<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = Omit<HTMLButtonAttributes, 'class'> & Readonly<{
		children?: Snippet;
		class?: string;
	}>;

	let { children, class: className, ...buttonProps }: Props = $props();
</script>

<button class={['site-primary-button', className]} {...buttonProps}>
	{#if children}{@render children()}{/if}
</button>

<style>
	.site-primary-button {
		min-height: 50px;
		border: 1px solid var(--color-primary-border);
		border-radius: 9px;
		background: var(--color-primary-background);
		box-shadow: 0 0 16px var(--color-primary-shadow);
		color: var(--color-primary-foreground);
		font: inherit;
		font-weight: 800;
		cursor: pointer;
	}

	.site-primary-button:hover:not(:disabled) { background: var(--color-primary-background-hover); }
	.site-primary-button:active:not(:disabled) { background: var(--color-primary-background-active); }
	.site-primary-button:disabled {
		border-color: var(--color-primary-disabled-border);
		background: var(--color-primary-disabled-background);
		box-shadow: none;
		color: var(--color-primary-disabled-foreground);
		cursor: not-allowed;
	}
	.site-primary-button:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
</style>
