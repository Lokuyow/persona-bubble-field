<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = Omit<HTMLButtonAttributes, 'class'> & Readonly<{
		children?: Snippet;
		class?: string;
		variant: 'primary' | 'secondary' | 'tertiary';
	}>;

	let { children, class: className, variant, ...buttonProps }: Props = $props();
</script>

<button class={['action-button', `action-button-${variant}`, className]} data-action-variant={variant} {...buttonProps}>
	{#if children}{@render children()}{/if}
</button>
