<script lang="ts">
	import { onMount } from 'svelte';
	import { SPEECH_SHORTCUT_IDS } from './speechSubmission';
	import {
		createComposerContextSync,
		type ComposerContextPatch, type ComposerDesiredContext, type ComposerSubmitEnvelope,
		type HostOwnedComposerOutput
	} from './hostOwnedComposerContext';
	import type { Event as NostrEvent } from 'nostr-tools/pure';

	const HOST_OWNED_ENTRY = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/ehagaki-composer.js';
	const HOST_OWNED_ASSET_BASE = 'https://lokuyow.github.io/ehagaki/web-component/host-owned/';
	const HOST_OWNED_TAG_NAME = 'ehagaki-composer';

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
		setContext(context: ComposerContextPatch): Promise<void>;
		focusEditor(): void;
		blurEditor(): void;
		configureHostOwned(options: Readonly<{
			editorSubmitButtonEnabled?: boolean;
			keyboardButtonBarEnabled?: boolean;
			enterKeyBehavior?: 'newline' | 'submit';
			editorMinLines?: number;
			editorMaxLines?: number;
			submitShortcuts?: readonly Readonly<{
				id: string;
				modifiers: readonly ('ctrl' | 'meta' | 'ctrlOrMeta' | 'alt' | 'shift')[];
			}>[];
			submit: (
				output: HostOwnedComposerOutput,
				options: Readonly<{ signal: AbortSignal; shortcutId?: string }>
			) => Promise<void | Readonly<{ eventId: string }>>;
		}>): void;
	};

	type Props = {
		submitContent: (
			envelope: ComposerSubmitEnvelope,
			options: Readonly<{ signal: AbortSignal; shortcutId?: string }>
		) => Promise<Readonly<{ eventId: string }>>;
		desiredContext: ComposerDesiredContext;
		loadPreview?: (targetId: string) => Promise<NostrEvent | null>;
		onPreviewClear: (generation: number) => void;
		onEditorEmptyChange?: (isEmpty: boolean | null) => void;
		onPreferredHeightChange?: (height: number) => void;
	};

	let { submitContent, desiredContext, loadPreview, onPreviewClear, onEditorEmptyChange, onPreferredHeightChange }: Props = $props();
	let host: HTMLDivElement;
	let loadFailed = $state(false);
	let composerReady = false;
	let composer: HostOwnedComposerElement | null = null;
	const contextSync = createComposerContextSync({
		setContext: (patch) => composer!.setContext(patch),
		loadPreview: (targetId) => loadPreview?.(targetId) ?? Promise.resolve(null),
		onPreviewClear: (generation) => onPreviewClear(generation)
	});
	$effect(() => { contextSync.request(desiredContext); });

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
		const handleContextUpdated = (event: Event) => {
			contextSync.contextUpdated((event as CustomEvent<{ reply?: unknown }>).detail?.reply);
		};
		// Lite emits before synchronous sending/clear cleanup. Resume after that cleanup.
		const handlePostSuccess = () => queueMicrotask(() => contextSync.finishSubmit(true));
		const handlePostError = () => queueMicrotask(() => contextSync.finishSubmit(false));

		void (async () => {
			try {
				await import(/* @vite-ignore */ HOST_OWNED_ENTRY);
				await customElements.whenDefined(HOST_OWNED_TAG_NAME);
				if (disposed) return;

				composer = document.createElement(HOST_OWNED_TAG_NAME) as HostOwnedComposerElement;
				composer.assetBase = HOST_OWNED_ASSET_BASE;
				composer.addEventListener('ehagaki-editor-empty-change', handleEditorEmptyChange);
				composer.addEventListener('ehagaki-preferred-height-change', handlePreferredHeightChange);
				composer.addEventListener('ehagaki-composer-context-updated', handleContextUpdated);
				composer.addEventListener('ehagaki-post-success', handlePostSuccess);
				composer.addEventListener('ehagaki-post-error', handlePostError);
				composer.configureHostOwned({
					editorSubmitButtonEnabled: true,
					keyboardButtonBarEnabled: false,
					enterKeyBehavior: 'submit',
					editorMinLines: 1,
					editorMaxLines: 3,
					submitShortcuts: [
						{ id: SPEECH_SHORTCUT_IDS.shout, modifiers: ['ctrlOrMeta'] },
						{ id: SPEECH_SHORTCUT_IDS.monologue, modifiers: ['alt'] }
					],
					submit: async (output, { signal, shortcutId }) => {
						if (signal.aborted) throw new DOMException('Submission was cancelled.', 'AbortError');
						return submitContent({ output, ...contextSync.beginSubmit() }, { signal, shortcutId });
					}
				});
				host.append(composer);
				await composer.whenReady();
				if (!disposed) {
					composerReady = true;
					contextSync.ready();
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
			contextSync.dispose();
			composerReady = false;
			onEditorEmptyChange?.(null);
			composer?.removeEventListener('ehagaki-editor-empty-change', handleEditorEmptyChange);
			composer?.removeEventListener('ehagaki-preferred-height-change', handlePreferredHeightChange);
			composer?.removeEventListener('ehagaki-composer-context-updated', handleContextUpdated);
			composer?.removeEventListener('ehagaki-post-success', handlePostSuccess);
			composer?.removeEventListener('ehagaki-post-error', handlePostError);
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
