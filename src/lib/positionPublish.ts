import type { ParsedPositionEvent, PositionSlot } from './nostrProtocol';

export type PositionPublishState = Readonly<{
	/** The latest Unix second represented by this planner, or null for fresh state. */
	lastPublishSecond: number | null;
	/** Number of slots consumed in lastPublishSecond. */
	consumedSlots: 0 | 1 | 2;
}>;

export type PositionPublishUnavailableReason = 'second-exhausted' | 'clock-regressed';

export type PositionPublishPlan =
	| Readonly<{
			kind: 'available';
			slot: PositionSlot;
			nextState: PositionPublishState;
		}>
	| Readonly<{
			kind: 'unavailable';
			reason: PositionPublishUnavailableReason;
		}>;

function assertCreatedAt(createdAt: number): void {
	if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
		throw new TypeError('created_at must be a non-negative safe integer in Unix seconds.');
	}
}

function stateFor(second: number, consumedSlots: 1 | 2): PositionPublishState {
	return { lastPublishSecond: second, consumedSlots };
}

/** Creates the state for a planner with no observed or attempted position publish. */
export function createPositionPublishState(): PositionPublishState {
	return { lastPublishSecond: null, consumedSlots: 0 };
}

/**
 * Plans one slot without mutating state. The caller should synchronously adopt
 * nextState once the planned event is handed to transport; relay results must
 * not make the same slot and created_at available for another event.
 */
export function planPositionPublish(
	state: PositionPublishState,
	createdAt: number
): PositionPublishPlan {
	assertCreatedAt(createdAt);

	if (state.lastPublishSecond !== null && createdAt < state.lastPublishSecond) {
		return { kind: 'unavailable', reason: 'clock-regressed' };
	}

	if (state.lastPublishSecond === createdAt && state.consumedSlots >= 2) {
		return { kind: 'unavailable', reason: 'second-exhausted' };
	}

	if (state.lastPublishSecond === createdAt && state.consumedSlots === 1) {
		return { kind: 'available', slot: 1, nextState: stateFor(createdAt, 2) };
	}

	return { kind: 'available', slot: 0, nextState: stateFor(createdAt, 1) };
}

/**
 * Reconstructs the planner from already-parsed position evidence. Only the
 * latest second is relevant; a visible slot 1 conservatively implies that
 * both slots for that second have been consumed.
 */
export function reconstructPositionPublishState(
	events: readonly ParsedPositionEvent[],
	pubkey: string
): PositionPublishState {
	const uniqueOwnEvents = new Map<string, ParsedPositionEvent>();
	for (const event of events) {
		if (event.pubkey === pubkey && !uniqueOwnEvents.has(event.id)) {
			uniqueOwnEvents.set(event.id, event);
		}
	}

	if (uniqueOwnEvents.size === 0) return createPositionPublishState();

	const latestSecond = Math.max(...[...uniqueOwnEvents.values()].map((event) => event.createdAt));
	const latestEvents = [...uniqueOwnEvents.values()].filter((event) => event.createdAt === latestSecond);

	if (latestEvents.length >= 2 || latestEvents[0].slot === 1) {
		return stateFor(latestSecond, 2);
	}

	return stateFor(latestSecond, 1);
}
