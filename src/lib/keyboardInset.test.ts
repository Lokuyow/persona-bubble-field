import { describe, expect, it } from 'vitest';
import { getVirtualKeyboardBottomInset, getVisualViewportKeyboardInset } from './keyboardInset';

const viewport = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };

describe('keyboard inset', () => {
	it('uses only the bottom-covered portion of a full-width VirtualKeyboard', () => {
		expect(getVirtualKeyboardBottomInset(viewport, {
			left: 0, top: 544, right: 390, bottom: 844, width: 390, height: 300
		})).toBe(300);
		expect(getVirtualKeyboardBottomInset(viewport, {
			left: 0, top: 620, right: 390, bottom: 780, width: 390, height: 160
		})).toBe(0);
	});

	it('does not raise a full-width dock for a floating keyboard', () => {
		expect(getVirtualKeyboardBottomInset(viewport, {
			left: 80, top: 544, right: 310, bottom: 844, width: 230, height: 300
		})).toBe(0);
	});

	it('uses VisualViewport only while the Composer is focused, at normal scale, and with a keyboard-sized inset', () => {
		const input = {
			layoutViewportHeight: 844,
			visualViewportHeight: 544,
			visualViewportOffsetTop: 0,
			visualViewportScale: 1,
			composerFocused: true
		};
		expect(getVisualViewportKeyboardInset(input)).toBe(300);
		expect(getVisualViewportKeyboardInset({ ...input, composerFocused: false })).toBe(0);
		expect(getVisualViewportKeyboardInset({ ...input, visualViewportScale: 1.25 })).toBe(0);
		expect(getVisualViewportKeyboardInset({ ...input, visualViewportHeight: 830 })).toBe(0);
	});

	it('clamps VisualViewport bottom coverage at zero', () => {
		expect(getVisualViewportKeyboardInset({
			layoutViewportHeight: 800,
			visualViewportHeight: 790,
			visualViewportOffsetTop: 20,
			visualViewportScale: 1,
			composerFocused: true
		})).toBe(0);
	});
});
