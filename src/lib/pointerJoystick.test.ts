import { describe, expect, it } from 'vitest';
import {
	clampJoystickThumb,
	POINTER_JOYSTICK_THRESHOLD,
	isJoystickDrag,
	joystickDirection
} from './pointerJoystick';

describe('pointer joystick gesture interpretation', () => {
	const pointAt = (degrees: number) => {
		const radians = degrees * Math.PI / 180;
		return { x: Math.cos(radians), y: Math.sin(radians) };
	};

	it('classifies threshold distances deterministically', () => {
		const start = { x: 10, y: 20 };
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD - 0.01, y: 20 })).toBe(false);
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD, y: 20 })).toBe(true);
		expect(isJoystickDrag(start, { x: 10 + POINTER_JOYSTICK_THRESHOLD + 0.01, y: 20 })).toBe(true);
	});

	it('maps all eight sector centers to cardinal and diagonal directions', () => {
		const start = { x: 0, y: 0 };
		const directions = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'] as const;
		for (const [index, direction] of directions.entries()) {
			expect(joystickDirection(start, pointAt(index * 45))).toBe(direction);
		}
	});

	it('uses the clockwise sector at deterministic 22.5 degree boundaries', () => {
		const start = { x: 0, y: 0 };
		const tangent = Math.tan(Math.PI / 8);

		expect(joystickDirection(start, { x: 1, y: tangent - 0.001 })).toBe('right');
		expect(joystickDirection(start, { x: 1, y: tangent })).toBe('down-right');
		expect(joystickDirection(start, { x: 1, y: tangent + 0.001 })).toBe('down-right');

		expect(joystickDirection(start, { x: tangent + 0.001, y: 1 })).toBe('down-right');
		expect(joystickDirection(start, { x: tangent, y: 1 })).toBe('down');
		expect(joystickDirection(start, { x: tangent - 0.001, y: 1 })).toBe('down');

		expect(joystickDirection(start, { x: 1, y: -tangent - 0.001 })).toBe('up-right');
		expect(joystickDirection(start, { x: 1, y: -tangent })).toBe('right');
		expect(joystickDirection(start, { x: 1, y: -tangent + 0.001 })).toBe('right');
	});

	it('leaves zero displacement directionless', () => {
		expect(joystickDirection({ x: 0, y: 0 }, { x: 0, y: 0 })).toBeNull();
	});

	it('clamps the thumb while preserving short displacement', () => {
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toEqual({ x: 3, y: 4 });
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 30, y: 40 }, 10)).toEqual({ x: 6, y: 8 });
		expect(clampJoystickThumb({ x: 0, y: 0 }, { x: 0, y: 0 }, 10)).toEqual({ x: 0, y: 0 });
	});
});
