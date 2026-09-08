<script lang="ts">
	import { onMount } from 'svelte';
	import { getVirtualKeyboardBottomInset, getVisualViewportKeyboardInset, type ViewportRect } from '$lib/keyboardInset';

	type VirtualKeyboardLike = {
		boundingRect: DOMRectReadOnly;
		overlaysContent: boolean;
		addEventListener: (type: 'geometrychange', listener: EventListener) => void;
		removeEventListener: (type: 'geometrychange', listener: EventListener) => void;
	};

	type Props = Readonly<{
		runtimeMode: 'relay' | 'dev';
		onKeyboardInsetChange: (inset: number) => void;
	}>;

	let { runtimeMode, onKeyboardInsetChange }: Props = $props();
	let composerFocused = false;
	let virtualKeyboard: VirtualKeyboardLike | undefined;
	let visualViewport: VisualViewport | null = null;

	function layoutViewportRect(): ViewportRect {
		return {
			left: 0,
			top: 0,
			right: window.innerWidth,
			bottom: window.innerHeight,
			width: window.innerWidth,
			height: window.innerHeight
		};
	}

	function isComposerEditorFocusEvent(event: Event): boolean {
		const path = event.composedPath();
		return path.some((target) => target instanceof HTMLElement && target.matches('ehagaki-composer')) &&
			path.some((target) => target instanceof HTMLElement && (
				target.isContentEditable || target.matches('input, textarea')
			));
	}

	function updateKeyboardInset(): void {
		if (virtualKeyboard) {
			onKeyboardInsetChange(getVirtualKeyboardBottomInset(layoutViewportRect(), virtualKeyboard.boundingRect));
			return;
		}
		if (!visualViewport) {
			onKeyboardInsetChange(0);
			return;
		}
		onKeyboardInsetChange(getVisualViewportKeyboardInset({
			layoutViewportHeight: window.innerHeight,
			visualViewportHeight: visualViewport.height,
			visualViewportOffsetTop: visualViewport.offsetTop,
			visualViewportScale: visualViewport.scale,
			composerFocused
		}));
	}

	function handleComposerFocusIn(event: FocusEvent): void {
		if (!isComposerEditorFocusEvent(event)) return;
		composerFocused = true;
		updateKeyboardInset();
	}

	function handleComposerFocusOut(): void {
		queueMicrotask(() => {
			composerFocused = document.activeElement instanceof HTMLElement && document.activeElement.matches('ehagaki-composer');
			updateKeyboardInset();
		});
	}

	onMount(() => {
		virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
		visualViewport = window.visualViewport;
		let changedVirtualKeyboardOverlaysContent = false;
		let previousVirtualKeyboardOverlaysContent: boolean | null = null;

		if (runtimeMode === 'relay' && virtualKeyboard) {
			const previousOverlaysContent = virtualKeyboard.overlaysContent;
			previousVirtualKeyboardOverlaysContent = previousOverlaysContent;
			if (!previousOverlaysContent) {
				virtualKeyboard.overlaysContent = true;
				changedVirtualKeyboardOverlaysContent = true;
			}
			virtualKeyboard.addEventListener('geometrychange', updateKeyboardInset);
		}
		visualViewport?.addEventListener('resize', updateKeyboardInset);
		visualViewport?.addEventListener('scroll', updateKeyboardInset);
		updateKeyboardInset();

		return () => {
			virtualKeyboard?.removeEventListener('geometrychange', updateKeyboardInset);
			if (changedVirtualKeyboardOverlaysContent && virtualKeyboard && previousVirtualKeyboardOverlaysContent !== null) {
				virtualKeyboard.overlaysContent = previousVirtualKeyboardOverlaysContent;
			}
			visualViewport?.removeEventListener('resize', updateKeyboardInset);
			visualViewport?.removeEventListener('scroll', updateKeyboardInset);
			onKeyboardInsetChange(0);
		};
	});
</script>

<svelte:window onresize={updateKeyboardInset} />
<svelte:document onfocusin={handleComposerFocusIn} onfocusout={handleComposerFocusOut} />
