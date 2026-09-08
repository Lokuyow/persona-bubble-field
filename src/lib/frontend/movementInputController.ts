import type { Direction } from '$lib/geometry';

type MovementHoldOwner = 'keyboard' | 'pointer';
type MovementHoldSource = 'page' | 'composer-editor';

export type MovementInputControllerOptions = Readonly<{
	requestMovement: (direction: Direction) => void;
	canUseArrowForMovement: (event: KeyboardEvent) => boolean;
	canUseWASDForMovement: (event: KeyboardEvent) => boolean;
	isComposerEditorKeyboardEvent: (event: Event) => boolean;
	getComposerEditorIsEmpty: () => boolean | null;
	isProfileDialogOpen: () => boolean;
	isDocumentHidden: () => boolean;
	cancelPointerGesture: () => void;
}>;

export type MovementInputController = Readonly<{
	handleKeydown: (event: KeyboardEvent) => void;
	handleKeyup: (event: KeyboardEvent) => void;
	handleFocusIn: (event: FocusEvent) => void;
	handleWindowBlur: () => void;
	handleVisibilityChange: () => void;
	takeOverPointer: (pointerId: number, direction: Direction) => void;
	updatePointer: (pointerId: number, direction: Direction) => void;
	stopPointer: (pointerId: number) => void;
	cancelMovementHold: () => void;
	destroy: () => void;
}>;

const KEYBOARD_CHORD_DELAY_MS = 50;
const MOVEMENT_HOLD_INTERVAL_MS = 500;

export function createMovementInputController(
	options: MovementInputControllerOptions
): MovementInputController {
	let movementHoldOwner: MovementHoldOwner | null = null;
	let movementHoldDirection: Direction | null = null;
	let movementHoldSource: MovementHoldSource | null = null;
	const pressedKeyboardMovementKeys = new Set<string>();
	let movementHoldPointerId: number | null = null;
	let holdTimer: ReturnType<typeof setInterval> | null = null;
	let keyboardChordTimer: ReturnType<typeof setTimeout> | null = null;

	const cancelKeyboardChordTimer = () => {
		if (keyboardChordTimer === null) return;
		clearTimeout(keyboardChordTimer);
		keyboardChordTimer = null;
	};

	const clearMovementHold = () => {
		movementHoldOwner = null;
		movementHoldDirection = null;
		movementHoldSource = null;
		pressedKeyboardMovementKeys.clear();
		movementHoldPointerId = null;
		cancelKeyboardChordTimer();
		if (holdTimer !== null) {
			clearInterval(holdTimer);
			holdTimer = null;
		}
	};

	const requestMovement = (direction: Direction) => {
		options.requestMovement(direction);
	};

	const startMovementTimer = () => {
		holdTimer = setInterval(() => {
			if (!movementHoldOwner ||
				(movementHoldOwner === 'keyboard' && movementHoldSource === 'composer-editor' && options.getComposerEditorIsEmpty() !== true) ||
				options.isProfileDialogOpen()) {
				clearMovementHold();
				return;
			}
			if (movementHoldDirection) requestMovement(movementHoldDirection);
		}, MOVEMENT_HOLD_INTERVAL_MS);
	};

	const rephaseMovementTimer = () => {
		if (holdTimer === null) return;
		clearInterval(holdTimer);
		startMovementTimer();
	};

	const resolveKeyboardChord = () => {
		cancelKeyboardChordTimer();
		const direction = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
		movementHoldDirection = direction;
		if (direction) requestMovement(direction);
		startMovementTimer();
	};

	const takeOverPointer = (pointerId: number, direction: Direction) => {
		clearMovementHold();
		movementHoldOwner = 'pointer';
		movementHoldDirection = direction;
		movementHoldPointerId = pointerId;
		requestMovement(direction);
		startMovementTimer();
	};

	const updatePointer = (pointerId: number, direction: Direction) => {
		if (movementHoldOwner === 'pointer' && movementHoldPointerId === pointerId) {
			movementHoldDirection = direction;
		}
	};

	const stopPointer = (pointerId: number) => {
		if (movementHoldOwner === 'pointer' && movementHoldPointerId === pointerId) clearMovementHold();
	};

	const handleKeydown = (event: KeyboardEvent) => {
		const arrowDirection = directionFromKey(event.key);
		const wasdDirection = directionFromCode(event.code);
		const direction = arrowDirection ?? wasdDirection;
		if (!direction || movementHoldOwner === 'pointer') return;
		const canMove = arrowDirection
			? options.canUseArrowForMovement(event)
			: options.canUseWASDForMovement(event);
		if (!canMove) {
			clearMovementHold();
			return;
		}

		// Browser repeat events only suppress the browser default. Movement is
		// driven by the explicit hold timer below, never by repeat frequency.
		event.preventDefault();
		if (event.repeat) return;
		const source: MovementHoldSource = arrowDirection && options.isComposerEditorKeyboardEvent(event)
			? 'composer-editor'
			: 'page';
		const keyToken = event.code || event.key;
		pressedKeyboardMovementKeys.add(keyToken);
		const nextDirection = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
		if (movementHoldOwner !== 'keyboard') {
			clearMovementHold();
			pressedKeyboardMovementKeys.add(keyToken);
			movementHoldOwner = 'keyboard';
			movementHoldSource = source;
			movementHoldDirection = nextDirection;
			keyboardChordTimer = setTimeout(resolveKeyboardChord, KEYBOARD_CHORD_DELAY_MS);
			return;
		}
		if (keyboardChordTimer !== null) {
			if (nextDirection === 'up-right' || nextDirection === 'down-right' ||
				nextDirection === 'down-left' || nextDirection === 'up-left') {
				clearTimeout(keyboardChordTimer);
				keyboardChordTimer = null;
				movementHoldDirection = nextDirection;
				requestMovement(nextDirection);
				startMovementTimer();
			} else {
				movementHoldDirection = nextDirection;
			}
			return;
		}
		const previousDirection = movementHoldDirection;
		movementHoldDirection = nextDirection;
		if (nextDirection !== previousDirection) {
			if (!nextDirection) return;
			requestMovement(nextDirection);
			rephaseMovementTimer();
		}
	};

	const handleKeyup = (event: KeyboardEvent) => {
		const keyToken = event.code || event.key;
		if (keyboardChordTimer !== null) resolveKeyboardChord();
		if (!pressedKeyboardMovementKeys.delete(keyToken) || movementHoldOwner !== 'keyboard') return;
		const nextDirection = directionFromKeyboardMovementKeys(pressedKeyboardMovementKeys);
		if (!nextDirection) {
			if (pressedKeyboardMovementKeys.size === 0) clearMovementHold();
			else movementHoldDirection = null;
			return;
		}
		movementHoldDirection = nextDirection;
	};

	const handleFocusIn = (event: FocusEvent) => {
		if (movementHoldOwner === 'keyboard' && !options.isComposerEditorKeyboardEvent(event)) clearMovementHold();
	};

	const handleWindowBlur = () => {
		clearMovementHold();
		options.cancelPointerGesture();
	};

	const handleVisibilityChange = () => {
		if (!options.isDocumentHidden()) return;
		clearMovementHold();
		options.cancelPointerGesture();
	};

	const destroy = () => {
		clearMovementHold();
		options.cancelPointerGesture();
	};

	return {
		handleKeydown,
		handleKeyup,
		handleFocusIn,
		handleWindowBlur,
		handleVisibilityChange,
		takeOverPointer,
		updatePointer,
		stopPointer,
		cancelMovementHold: clearMovementHold,
		destroy
	};
}

function directionFromKey(key: string): Direction | null {
	if (key === 'ArrowUp') return 'up';
	if (key === 'ArrowDown') return 'down';
	if (key === 'ArrowLeft') return 'left';
	if (key === 'ArrowRight') return 'right';
	return null;
}

function directionFromCode(code: string): Direction | null {
	if (code === 'KeyW') return 'up';
	if (code === 'KeyA') return 'left';
	if (code === 'KeyS') return 'down';
	if (code === 'KeyD') return 'right';
	return null;
}

function directionFromKeyboardMovementKeys(keys: Iterable<string>): Direction | null {
	const activeDirections = new Set<Direction>();
	for (const key of keys) {
		const direction = directionFromCode(key) ?? directionFromKey(key);
		if (direction) activeDirections.add(direction);
	}
	const x = activeDirections.has('left') === activeDirections.has('right')
		? 0 : activeDirections.has('right') ? 1 : -1;
	const y = activeDirections.has('up') === activeDirections.has('down')
		? 0 : activeDirections.has('down') ? 1 : -1;
	if (x === 0 && y === 0) return null;
	if (x === 0) return y < 0 ? 'up' : 'down';
	if (y === 0) return x < 0 ? 'left' : 'right';
	if (x > 0 && y < 0) return 'up-right';
	if (x > 0 && y > 0) return 'down-right';
	if (x < 0 && y > 0) return 'down-left';
	return 'up-left';
}
