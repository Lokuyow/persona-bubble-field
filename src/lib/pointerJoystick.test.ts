import { describe, expect, it } from 'vitest';
import {
	clampJoystickThumb,
	POINTER_JOYSTICK_THRESHOLD,
	isJoystickDrag,
	joystickDirection
} from './pointerJoystick';

describe('pointer joystick gesture interpretation', () => {
	it('classifies threshold distances deterministically', () => {
		const start = { x: 10, y: 20 };
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD - 0.01, y: 20 })).toBe(false);
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD, y: 20 })).toBe(true);
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD + 0.01, y: 20 })).toBe(true);
	});

	it('maps dominant axes to cardinal directions and leaves zero displacement directionless', () => {
		const start = { x: 0, y: 0 };
		expect(joystickDirection(start, { x: 0, y: 0 })).toBeNull();
		expect(joystickDirection(start, { x: 0, y: -10 })).toBe('up');
		expect(joystickDirection(start, { x: 0, y: 10 })).toBe('down');
		expect(joystickDirection(start, { x: -10, y: 0 })).toBe('left');
		expect(joystickDirection(start, { x: 10, y: 0 })).toBe('right');
		expect(joystickDirection(start, { x: 20, y: 19 })).toBe('right');
		expect(joystickDirection(start, { x: 19, y: 20 })).toBe('down');
		expect(joystickDirection(start, { x: 20, y: 20 })).toBe('right');
	});

	it('clamps the thumb while preserving short displacement', () => {
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toEqual({ x: 3, y: 4 });
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 30, y: 40 }, 10)).toEqual({ x: 6, y: 8 });
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 0, y: 0 }, 10)).toEqual({ x: 0, y: 0 });
	});
});
