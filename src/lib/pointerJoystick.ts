import type { Direction } from './geometry';

export type JoystickPoint = Readonly<{ x: number; y: number }>;

export const POINTER_JOYSTICK_THRESHOLD = 12;
export const POINTER_JOYSTICK_MAX_RADIUS = 32;

export function isJoystickDrag(start: JoystickPoint, current: JoystickPoint): boolean {
	return Math.hypot(current.x - start.x, current.y - start.y) >= POINTER_JOYSTICK_THRESHOLD;
}

export function joystickDirection(start: JoystickPoint, current: JoystickPoint): Direction | null {
	const dx = current.x - start.x;
	const dy = current.y - start.y;
	if (dx === 0 && dy === 0) return null;
	if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
	return dy >= 0 ? 'down' : 'up';
}

export function clampJoystickThumb(start: JoystickPoint, current: JoystickPoint, maxRadius = POINTER_JOYSTICK_MAX_RADIUS): JoystickPoint {
	const dx = current.x - start.x;
	const dy = current.y - start.y;
	const distance = Math.hypot(dx, dy);
	if (distance === 0 || distance <= maxRadius) return { x: dx, y: dy };
	const scale = maxRadius / distance;
	return { x: dx * scale, y: dy * scale };
}
