<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	type Props = Omit<HTMLButtonAttributes, 'class'> & Readonly<{
		children?: Snippet;
		class?: string;
		variant: 'primary' | 'secondary' | 'tertiary';
		intent?: 'normal' | 'cancel' | 'danger';
	}>;

	let { children, class: className, variant, intent = 'normal', ...buttonProps }: Props = $props();
</script>

<button class={['action-button', `action-button-${variant}`, `action-button-intent-${intent}`, className]} data-action-variant={variant} data-action-intent={intent} {...buttonProps}>
	{#if children}{@render children()}{/if}
</button>
