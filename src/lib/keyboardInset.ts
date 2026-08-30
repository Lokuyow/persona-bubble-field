export type ViewportRect = Readonly<{
	left: number;
	top: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}>;

export const MIN_VISUAL_VIEWPORT_KEYBOARD_INSET_PX = 100;

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function hasFiniteRect(rect: ViewportRect): boolean {
	return [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite);
}

/**
 * Returns the part of a full-width bottom keyboard that actually covers the
 * layout viewport. Floating keyboards intentionally leave a full-width dock
 * at the viewport edge.
 */
export function getVirtualKeyboardBottomInset(viewport: ViewportRect, keyboard: ViewportRect): number {
	if (!hasFiniteRect(viewport) || !hasFiniteRect(keyboard) || viewport.width <= 0 || viewport.height <= 0) return 0;
	const coversViewportWidth = keyboard.left <= viewport.left && keyboard.right >= viewport.right;
	const reachesViewportBottom = keyboard.bottom >= viewport.bottom;
	if (!coversViewportWidth || !reachesViewportBottom || keyboard.top >= viewport.bottom) return 0;
	return clamp(viewport.bottom - Math.max(viewport.top, keyboard.top), 0, viewport.height);
}

/**
 * VisualViewport is only a fallback when the VirtualKeyboard geometry API is
 * unavailable. Focus, scale, and a meaningful inset keep browser chrome and
 * pinch-zoom changes from being treated as an IME.
 */
export function getVisualViewportKeyboardInset(input: Readonly<{
	layoutViewportHeight: number;
	visualViewportHeight: number;
	visualViewportOffsetTop: number;
	visualViewportScale: number;
	composerFocused: boolean;
}>): number {
	const { layoutViewportHeight, visualViewportHeight, visualViewportOffsetTop, visualViewportScale, composerFocused } = input;
	if (!composerFocused || visualViewportScale !== 1) return 0;
	if (![layoutViewportHeight, visualViewportHeight, visualViewportOffsetTop].every(Number.isFinite)) return 0;
	const inset = Math.max(0, layoutViewportHeight - (visualViewportHeight + visualViewportOffsetTop));
	return inset >= MIN_VISUAL_VIEWPORT_KEYBOARD_INSET_PX ? inset : 0;
}
