<script lang="ts">
	import { onMount } from 'svelte';

	const HOST_OWNED_ENTRY = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/ehagaki-composer.js';
	const HOST_OWNED_ASSET_BASE = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/';
	const HOST_OWNED_TAG_NAME = 'ehagaki-composer';

	type HostOwnedComposerOutput = Readonly<{
		content: string;
		tags: readonly string[][];
		context: unknown;
	}>;

	type HostOwnedComposerElement = HTMLElement & {
		assetBase: string | null;
		configureHostOwned(options: Readonly<{
			keyboardButtonBarEnabled?: boolean;
			enterKeyBehavior?: 'newline' | 'submit';
			submit: (
				output: HostOwnedComposerOutput,
				options: Readonly<{ signal: AbortSignal }>
			) => Promise<void | Readonly<{ eventId: string }>>;
		}>): void;
	};

	type Props = {
		submitContent: (content: string) => Promise<Readonly<{ eventId: string }>>;
	};

	let { submitContent }: Props = $props();
	let host: HTMLDivElement;
	let loadFailed = $state(false);

	onMount(() => {
		let disposed = false;
		let composer: HostOwnedComposerElement | null = null;

		void (async () => {
			try {
				await import(/* @vite-ignore */ HOST_OWNED_ENTRY);
				await customElements.whenDefined(HOST_OWNED_TAG_NAME);
				if (disposed) return;

				composer = document.createElement(HOST_OWNED_TAG_NAME) as HostOwnedComposerElement;
				composer.assetBase = HOST_OWNED_ASSET_BASE;
				composer.configureHostOwned({
					keyboardButtonBarEnabled: false,
					enterKeyBehavior: 'submit',
					submit: async (output, { signal }) => {
						if (signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
						// This integration intentionally ignores composer-owned tags and context.
						return submitContent(output.content);
					}
				});
				host.append(composer);
			} catch {
				if (!disposed) loadFailed = true;
			}
		})();

		return () => {
			disposed = true;
			composer?.remove();
		};
	});
</script>

<div class="host-owned-composer" bind:this={host}>
	{#if loadFailed}
		<p class="composer-load-error" role="status">Composer unavailable. Reload to try again.</p>
	{/if}
</div>

<style>
	.host-owned-composer {
		height: 100%;
	}

	.host-owned-composer :global(ehagaki-composer) {
		display: block;
		height: 100%;
	}

	.composer-load-error {
		display: grid;
		height: 100%;
		margin: 0;
		place-items: center;
		border: 1px solid rgba(125, 98, 88, 0.25);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.72);
		color: #7d6258;
		font-size: 12px;
		font-weight: 700;
	}
</style>
