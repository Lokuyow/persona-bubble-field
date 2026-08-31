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

	type HostOwnedPreferredHeightChangeEvent = Event & {
		detail?: Readonly<{ height?: unknown }>;
	};

	type HostOwnedEditorEmptyChangeEvent = Event & {
		detail?: Readonly<{ isEmpty?: unknown }>;
	};

	type HostOwnedComposerElement = HTMLElement & {
		assetBase: string | null;
		editorIsEmpty: boolean | null;
		preferredHeight: number | null;
		whenReady(): Promise<void>;
		focusEditor(): void;
		blurEditor(): void;
		configureHostOwned(options: Readonly<{
			editorSubmitButtonEnabled?: boolean;
			keyboardButtonBarEnabled?: boolean;
			enterKeyBehavior?: 'newline' | 'submit';
			editorMinLines?: number;
			editorMaxLines?: number;
			submit: (
				output: HostOwnedComposerOutput,
				options: Readonly<{ signal: AbortSignal }>
			) => Promise<void | Readonly<{ eventId: string }>>;
		}>): void;
	};

	type Props = {
		submitContent: (content: string, signal: AbortSignal) => Promise<Readonly<{ eventId: string }>>;
		onEditorEmptyChange?: (isEmpty: boolean | null) => void;
		onPreferredHeightChange?: (height: number) => void;
	};

	let { submitContent, onEditorEmptyChange, onPreferredHeightChange }: Props = $props();
	let host: HTMLDivElement;
	let loadFailed = $state(false);
	let composerReady = false;
	let composer: HostOwnedComposerElement | null = null;

	export function focusEditor(): boolean {
		if (!composerReady || !composer) return false;
		composer.focusEditor();
		return true;
	}

	export function blurEditor(): boolean {
		if (!composerReady || !composer) return false;
		composer.blurEditor();
		return true;
	}

	onMount(() => {
		let disposed = false;
		onEditorEmptyChange?.(null);
		const handlePreferredHeightChange = (event: Event) => {
			const height = (event as HostOwnedPreferredHeightChangeEvent).detail?.height;
			if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
				onPreferredHeightChange?.(height);
			}
		};
		const handleEditorEmptyChange = (event: Event) => {
			const isEmpty = (event as HostOwnedEditorEmptyChangeEvent).detail?.isEmpty;
			if (typeof isEmpty === 'boolean') onEditorEmptyChange?.(isEmpty);
		};

		void (async () => {
			try {
				await import(/* @vite-ignore */ HOST_OWNED_ENTRY);
				await customElements.whenDefined(HOST_OWNED_TAG_NAME);
				if (disposed) return;

				composer = document.createElement(HOST_OWNED_TAG_NAME) as HostOwnedComposerElement;
				composer.assetBase = HOST_OWNED_ASSET_BASE;
				composer.addEventListener('ehagaki-editor-empty-change', handleEditorEmptyChange);
				composer.addEventListener('ehagaki-preferred-height-change', handlePreferredHeightChange);
				composer.configureHostOwned({
					editorSubmitButtonEnabled: true,
					keyboardButtonBarEnabled: false,
					enterKeyBehavior: 'submit',
					editorMinLines: 1,
					editorMaxLines: 3,
					submit: async (output, { signal }) => {
						if (signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
						// This integration intentionally ignores composer-owned tags and context.
						return submitContent(output.content, signal);
					}
				});
				host.append(composer);
				await composer.whenReady();
				if (!disposed) {
					composerReady = true;
					onEditorEmptyChange?.(composer.editorIsEmpty);
					const height = composer.preferredHeight;
					if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
						onPreferredHeightChange?.(height);
					}
				}
			} catch {
				if (!disposed) loadFailed = true;
			}
		})();

		return () => {
			disposed = true;
			composerReady = false;
			onEditorEmptyChange?.(null);
			composer?.removeEventListener('ehagaki-editor-empty-change', handleEditorEmptyChange);
			composer?.removeEventListener('ehagaki-preferred-height-change', handlePreferredHeightChange);
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
