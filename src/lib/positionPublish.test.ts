import { describe, expect, it } from 'vitest';
import type { ParsedPositionEvent } from './nostrProtocol';
import {
	createPositionPublishState,
	planPositionPublish,
	reconstructPositionPublishState,
	type PositionPublishPlan
} from './positionPublish';

const OWN_PUBKEY = 'a'.repeat(64);
const OTHER_PUBKEY = 'b'.repeat(64);

function parsedPosition(
	id: string,
	pubkey: string,
	createdAt: number,
	slot: 0 | 1
): ParsedPositionEvent {
	return {
		id,
		pubkey,
		createdAt,
		slot,
		position: { x: 1, y: 2 }
	};
}

function availablePlan(plan: PositionPublishPlan): Extract<PositionPublishPlan, { kind: 'available' }> {
	if (plan.kind !== 'available') throw new Error(`Expected an available plan, got ${plan.reason}.`);
	return plan;
}

describe('position publish slot planner', () => {
	it('plans slot 0, slot 1, then exhaustion within one second', () => {
		const first = availablePlan(planPositionPublish(createPositionPublishState(), 100));
		const second = availablePlan(planPositionPublish(first.nextState, 100));
		const third = planPositionPublish(second.nextState, 100);

		expect(first).toEqual({
			kind: 'available',
			slot: 0,
			nextState: { lastPublishSecond: 100, consumedSlots: 1 }
		});
		expect(second).toEqual({
			kind: 'available',
			slot: 1,
			nextState: { lastPublishSecond: 100, consumedSlots: 2 }
		});
		expect(third).toEqual({ kind: 'unavailable', reason: 'second-exhausted' });
		expect(planPositionPublish(second.nextState, 101)).toEqual({
			kind: 'available',
			slot: 0,
			nextState: { lastPublishSecond: 101, consumedSlots: 1 }
		});
	});

	it('does not mutate state and is deterministic for the same input', () => {
		const state = { lastPublishSecond: 100, consumedSlots: 1 } as const;
		const snapshot = { ...state };

		expect(planPositionPublish(state, 100)).toEqual(planPositionPublish(state, 100));
		expect(state).toEqual(snapshot);
	});

	it.each([
		['negative', -1],
		['fractional', 100.5],
		['non-safe integer', Number.MAX_SAFE_INTEGER + 1]
	])('rejects %s createdAt', (_label, createdAt) => {
		expect(() => planPositionPublish(createPositionPublishState(), createdAt)).toThrow(TypeError);
	});

	it('fails closed when the clock regresses without resetting to slot 0', () => {
		const state = { lastPublishSecond: 100, consumedSlots: 2 } as const;

		expect(planPositionPublish(state, 99)).toEqual({ kind: 'unavailable', reason: 'clock-regressed' });
	});

	it('reconstructs fresh state from no own evidence', () => {
		expect(reconstructPositionPublishState([], OWN_PUBKEY)).toEqual(createPositionPublishState());
		expect(reconstructPositionPublishState([
		parsedPosition('other', OTHER_PUBKEY, 100, 0)
	], OWN_PUBKEY)).toEqual(createPositionPublishState());
	});

	it('reconstructs one own slot 0 as one consumed slot', () => {
		const state = reconstructPositionPublishState([
			parsedPosition('slot-0', OWN_PUBKEY, 100, 0)
		], OWN_PUBKEY);

		expect(state).toEqual({ lastPublishSecond: 100, consumedSlots: 1 });
		expect(planPositionPublish(state, 100)).toMatchObject({ kind: 'available', slot: 1 });
	});

	it.each([
		['slot 0 and slot 1', [parsedPosition('slot-0', OWN_PUBKEY, 100, 0), parsedPosition('slot-1', OWN_PUBKEY, 100, 1)]],
		['slot 1 only', [parsedPosition('slot-1', OWN_PUBKEY, 100, 1)]],
		['two distinct slot 0 events', [parsedPosition('slot-0-a', OWN_PUBKEY, 100, 0), parsedPosition('slot-0-b', OWN_PUBKEY, 100, 0)]],
		['two distinct slot 1 events', [parsedPosition('slot-1-a', OWN_PUBKEY, 100, 1), parsedPosition('slot-1-b', OWN_PUBKEY, 100, 1)]]
	] as const)('reconstructs %s as exhausted', (_label, events) => {
		const state = reconstructPositionPublishState(events, OWN_PUBKEY);

		expect(state).toEqual({ lastPublishSecond: 100, consumedSlots: 2 });
		expect(planPositionPublish(state, 100)).toEqual({ kind: 'unavailable', reason: 'second-exhausted' });
		expect(planPositionPublish(state, 101)).toMatchObject({ kind: 'available', slot: 0 });
	});

	it('deduplicates the same event ID across relay copies', () => {
		const event = parsedPosition('same-event', OWN_PUBKEY, 100, 0);

		expect(reconstructPositionPublishState([event, { ...event }], OWN_PUBKEY)).toEqual({
			lastPublishSecond: 100,
			consumedSlots: 1
		});
	});

	it('uses only the latest second and is independent of event arrival order', () => {
		const events = [
			parsedPosition('older-slot-1', OWN_PUBKEY, 99, 1),
			parsedPosition('newer-slot-0', OWN_PUBKEY, 100, 0),
			parsedPosition('newer-slot-1', OWN_PUBKEY, 100, 1)
		];

		expect(reconstructPositionPublishState(events, OWN_PUBKEY)).toEqual({
			lastPublishSecond: 100,
			consumedSlots: 2
		});
		expect(reconstructPositionPublishState([...events].reverse(), OWN_PUBKEY)).toEqual(
			reconstructPositionPublishState(events, OWN_PUBKEY)
		);
	});

	it('does not carry an older slot 1 into the latest second', () => {
		const state = reconstructPositionPublishState([
			parsedPosition('older-slot-1', OWN_PUBKEY, 99, 1),
			parsedPosition('newer-slot-0', OWN_PUBKEY, 100, 0)
		], OWN_PUBKEY);

		expect(state).toEqual({ lastPublishSecond: 100, consumedSlots: 1 });
		expect(planPositionPublish(state, 100)).toMatchObject({ kind: 'available', slot: 1 });
	});
});
