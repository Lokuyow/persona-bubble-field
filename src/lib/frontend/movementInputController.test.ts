import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Direction } from '$lib/geometry';
import {
	createMovementInputController,
	type MovementInputController,
	type MovementInputControllerOptions
} from './movementInputController';

type KeyEventInput = Readonly<{
	key: string;
	code: string;
	repeat?: boolean;
}>;

function keyboardEvent({ key, code, repeat = false }: KeyEventInput) {
	return {
		key,
		code,
		repeat,
		preventDefault: vi.fn()
	} as unknown as KeyboardEvent;
}

function createFixture() {
	const requests: Direction[] = [];
	const options: MovementInputControllerOptions = {
		requestMovement: (direction) => requests.push(direction),
		canUseArrowForMovement: () => true,
		canUseWASDForMovement: () => true,
		isComposerEditorKeyboardEvent: () => false,
		getComposerEditorIsEmpty: () => true,
		isProfileDialogOpen: () => false,
		isDocumentHidden: () => false,
		cancelPointerGesture: vi.fn()
	};

	return {
		controller: createMovementInputController(options),
		requests
	};
}

function press(controller: MovementInputController, event: KeyEventInput) {
	controller.handleKeydown(keyboardEvent(event));
}

function release(controller: MovementInputController, event: KeyEventInput) {
	controller.handleKeyup(keyboardEvent(event));
}

afterEach(() => {
	vi.useRealTimers();
});

describe('movement input controller', () => {
	it('starts a keyboard hold after chord resolution, repeats at the cadence, and stops on keyup', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 'ArrowRight', code: 'ArrowRight' });
		vi.advanceTimersByTime(49);
		expect(requests).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(requests).toEqual(['right']);
		vi.advanceTimersByTime(499);
		expect(requests).toEqual(['right']);
		vi.advanceTimersByTime(1);
		expect(requests).toEqual(['right', 'right']);

		release(controller, { key: 'ArrowRight', code: 'ArrowRight' });
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['right', 'right']);
		controller.destroy();
	});

	it.each([
		{ name: 'WASD up', events: [{ key: 'w', code: 'KeyW' }], expected: 'up' },
		{ name: 'WASD left', events: [{ key: 'a', code: 'KeyA' }], expected: 'left' },
		{ name: 'WASD down', events: [{ key: 's', code: 'KeyS' }], expected: 'down' },
		{ name: 'WASD right', events: [{ key: 'd', code: 'KeyD' }], expected: 'right' },
		{ name: 'Arrow up', events: [{ key: 'ArrowUp', code: 'ArrowUp' }], expected: 'up' },
		{ name: 'Arrow left', events: [{ key: 'ArrowLeft', code: 'ArrowLeft' }], expected: 'left' },
		{ name: 'Arrow down', events: [{ key: 'ArrowDown', code: 'ArrowDown' }], expected: 'down' },
		{ name: 'Arrow right', events: [{ key: 'ArrowRight', code: 'ArrowRight' }], expected: 'right' },
		{
			name: 'mixed diagonal',
			events: [{ key: 'w', code: 'KeyW' }, { key: 'ArrowRight', code: 'ArrowRight' }],
			expected: 'up-right'
		}
	])('resolves $name directions from keyboard keys', ({ events, expected }) => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		for (const event of events) press(controller, event);
		vi.advanceTimersByTime(50);

		expect(requests).toEqual([expected]);
		controller.destroy();
	});

	it('neutralizes opposite components and resumes the remaining direction', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 'w', code: 'KeyW' });
		vi.advanceTimersByTime(50);
		expect(requests).toEqual(['up']);

		press(controller, { key: 's', code: 'KeyS' });
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['up']);
		release(controller, { key: 's', code: 'KeyS' });
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['up', 'up']);
		release(controller, { key: 'w', code: 'KeyW' });
		controller.destroy();
	});

	it('deduplicates physical keys with the same logical direction', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 'w', code: 'KeyW' });
		press(controller, { key: 'ArrowUp', code: 'ArrowUp' });
		vi.advanceTimersByTime(50);
		expect(requests).toEqual(['up']);

		release(controller, { key: 'ArrowUp', code: 'ArrowUp' });
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['up', 'up']);
		release(controller, { key: 'w', code: 'KeyW' });
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['up', 'up']);
		controller.destroy();
	});

	it('immediately requests and re-phases the hold timer after a direction change', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 's', code: 'KeyS' });
		vi.advanceTimersByTime(50);
		vi.advanceTimersByTime(400);
		press(controller, { key: 'd', code: 'KeyD' });
		expect(requests).toEqual(['down', 'down-right']);
		vi.advanceTimersByTime(499);
		expect(requests).toEqual(['down', 'down-right']);
		vi.advanceTimersByTime(1);
		expect(requests).toEqual(['down', 'down-right', 'down-right']);
		release(controller, { key: 'd', code: 'KeyD' });
		release(controller, { key: 's', code: 'KeyS' });
		controller.destroy();
	});

	it('cancels an early chord timeout before the next movement key', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 'w', code: 'KeyW' });
		vi.advanceTimersByTime(20);
		release(controller, { key: 'w', code: 'KeyW' });
		expect(requests).toEqual(['up']);

		press(controller, { key: 'd', code: 'KeyD' });
		vi.advanceTimersByTime(29);
		expect(requests).toEqual(['up']);
		vi.advanceTimersByTime(1);
		expect(requests).toEqual(['up']);
		vi.advanceTimersByTime(20);
		expect(requests).toEqual(['up', 'right']);
		controller.destroy();
	});

	it('follows the remaining direction after releasing one side of a diagonal hold', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 's', code: 'KeyS' });
		press(controller, { key: 'd', code: 'KeyD' });
		expect(requests).toEqual(['down-right']);
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['down-right', 'down-right']);

		release(controller, { key: 'd', code: 'KeyD' });
		vi.advanceTimersByTime(499);
		expect(requests).toEqual(['down-right', 'down-right']);
		vi.advanceTimersByTime(1);
		expect(requests).toEqual(['down-right', 'down-right', 'down']);
		release(controller, { key: 's', code: 'KeyS' });
		controller.destroy();
	});

	it('ignores repeat keydown events as direct movement requests', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		press(controller, { key: 'd', code: 'KeyD' });
		vi.advanceTimersByTime(50);
		press(controller, { key: 'd', code: 'KeyD', repeat: true });
		expect(requests).toEqual(['right']);
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['right', 'right']);
		release(controller, { key: 'd', code: 'KeyD' });
		controller.destroy();
	});

	it('keeps pointer ownership from keyboard input and updates without restarting its timer', () => {
		vi.useFakeTimers();
		const { controller, requests } = createFixture();

		controller.takeOverPointer(7, 'right');
		press(controller, { key: 'a', code: 'KeyA' });
		release(controller, { key: 'a', code: 'KeyA' });
		expect(requests).toEqual(['right']);

		vi.advanceTimersByTime(400);
		controller.updatePointer(7, 'up');
		expect(requests).toEqual(['right']);
		vi.advanceTimersByTime(100);
		expect(requests).toEqual(['right', 'up']);

		controller.stopPointer(7);
		vi.advanceTimersByTime(500);
		expect(requests).toEqual(['right', 'up']);
		controller.destroy();
	});
});
