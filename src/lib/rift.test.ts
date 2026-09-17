import { describe, expect, it } from 'vitest';
import {
	applyRiftAction,
	buildManualRiftInstanceId,
	buildRiftCommitAction,
	buildRiftRevealAction,
	createRiftSession,
	getRiftRoundSchedule,
	getRiftSchedule,
	getRiftScheduleForInstance,
	isRiftSettlementComplete,
	parseRiftAction,
	parseManualRiftInstanceId,
	riftScheduleIntervalsOverlap,
	settleRiftSession,
	type RiftAction,
	type RiftActionEvent,
	type RiftSessionState
} from './rift';

const FIELD = { columns: 16, rows: 8, cellSize: 50 };
const INSTANCE = 'io.github.lokuyow.persona-bubble-field:realtime:rift:1:instance:2026-01-01';
const SCHEDULE = getRiftSchedule(Date.UTC(2026, 0, 1, 12, 0));

function hex(value: number): string {
	return value.toString(16).padStart(64, '0');
}

function actionEvent(id: number, pubkey: string, createdAt: number, action: RiftAction): RiftActionEvent {
	return { id: hex(id), pubkey, createdAt, action };
}

function addAction(state: RiftSessionState, id: number, pubkey: string, createdAt: number, action: RiftAction): RiftSessionState {
	return applyRiftAction(state, actionEvent(id, pubkey, createdAt, action));
}

function addJoins(count: number): { state: RiftSessionState; pubkeys: string[]; holeId: string } {
	let state = createRiftSession({ instanceId: INSTANCE, field: FIELD });
	const holeId = state.holes[0].id;
	const pubkeys = Array.from({ length: count }, (_, index) => hex(40 + index));
	for (let index = 0; index < count; index += 1) state = addAction(state, index + 1, pubkeys[index], SCHEDULE.registrationAtMs + 100 + index, { action: 'join', holeId });
	return { state, pubkeys, holeId };
}

function addRoundActions(state: RiftSessionState, pubkeys: readonly string[], holeId: string, round: 1 | 2 | 3, choices: readonly ('maintain' | 'escape')[], reveal = true): RiftSessionState {
	let next = state;
	const roundSchedule = getRiftRoundSchedule(SCHEDULE, round);
	for (let index = 0; index < pubkeys.length; index += 1) {
		const nonce = hex(100 + round * 10 + index);
		const commit = buildRiftCommitAction({ instanceId: INSTANCE, holeId, round, authorPubkey: pubkeys[index], choice: choices[index], nonce });
		const commitId = 1000 + round * 100 + index;
		next = addAction(next, commitId, pubkeys[index], roundSchedule.selectionAtMs + 100 + index, commit);
		if (reveal) next = addAction(next, commitId + 100, pubkeys[index], roundSchedule.resultAtMs + 1000 + index, { action: 'reveal', holeId, round, commitId: hex(commitId), choice: choices[index], nonce });
	}
	return next;
}

describe('Rift schedule and domain', () => {
	it('uses deterministic JST boundaries independent of browser timezone', () => {
		const before = getRiftSchedule(Date.UTC(2026, 0, 1, 11, 44, 59, 999));
		const warning = getRiftSchedule(Date.UTC(2026, 0, 1, 11, 45));
		const registration = getRiftSchedule(Date.UTC(2026, 0, 1, 11, 55));
		const game = getRiftSchedule(Date.UTC(2026, 0, 1, 12, 0));
		expect(before.phase).toBe('dormant');
		expect(warning.phase).toBe('warning');
		expect(registration.phase).toBe('registration');
		expect(game.phase).toBe('game');
		expect(game.dateKey).toBe('2026-01-01');
		expect(game.instanceId).toBe(warning.instanceId);
	});

	it('reconstructs a manual schedule from its canonical ID and preserves Rift round timing', () => {
		const createdAt = 1_767_272_400;
		const instanceId = buildManualRiftInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		expect(parseManualRiftInstanceId(instanceId)).toEqual({ createdAt, nonce: '0123456789abcdef0123456789abcdef' });
		const registration = getRiftScheduleForInstance(instanceId, createdAt * 1000);
		expect(registration?.phase).toBe('registration');
		expect(registration?.warningAtMs).toBe(registration?.registrationAtMs);
		expect(registration?.gameAtMs).toBe(createdAt * 1000 + 300_000);
		expect(getRiftScheduleForInstance(instanceId, (createdAt + 630) * 1000)?.phase).toBe('ended');
		expect(() => buildManualRiftInstanceId(createdAt, '0123456789ABCDEF0123456789ABCDEF')).toThrow();
	});

	it('treats every non-empty manual/scheduled interval intersection as a conflict', () => {
		const scheduled = { warningAtMs: 20 * 60 * 60 * 1000 + 45 * 60 * 1000, endedAtMs: 21 * 60 * 60 * 1000 + 30 * 60 * 1000 };
		expect(riftScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.warningAtMs - 5 * 60 * 1000, endedAtMs: scheduled.warningAtMs + 5 * 60 * 1000 })).toBe(true);
		expect(riftScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.endedAtMs, endedAtMs: scheduled.endedAtMs + 1 })).toBe(false);
		expect(riftScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.warningAtMs - 1, endedAtMs: scheduled.warningAtMs })).toBe(false);
	});

	it('places at least one deterministic hole and avoids fixed facilities', () => {
		const first = createRiftSession({ instanceId: INSTANCE, field: FIELD });
		const second = createRiftSession({ instanceId: INSTANCE, field: FIELD });
		expect(first.holes).toEqual(second.holes);
		expect(first.holes.length).toBeGreaterThanOrEqual(1);
		expect(first.holes.some((hole) => hole.position.x === 12 && hole.position.y === 3)).toBe(false);
	});

	it('switches a participant to the latest selected hole and deterministically caps a crowded hole at six', () => {
		const { state: crowded, pubkeys, holeId } = addJoins(7);
		const secondHole = crowded.holes[1];
		const switched = addAction(crowded, 500, pubkeys[0], SCHEDULE.registrationAtMs + 5000, { action: 'join', holeId: secondHole.id });
		const snap = settleRiftSession(switched, SCHEDULE, SCHEDULE.gameAtMs + 1);
		expect(snap.participantSnapshot?.[holeId]).toHaveLength(6);
		expect(snap.participantSnapshot?.[secondHole.id]).toEqual([pubkeys[0]]);
	});

	it('publishes only a commitment during secret selection and rejects a mismatched reveal', () => {
		const { state, pubkeys, holeId } = addJoins(3);
		const round = getRiftRoundSchedule(SCHEDULE, 1);
		const nonce = hex(700);
		const commit = buildRiftCommitAction({ instanceId: INSTANCE, holeId, round: 1, authorPubkey: pubkeys[0], choice: 'maintain', nonce });
		expect(commit).toEqual({ action: 'commit', holeId, round: 1, commitment: expect.any(String) });
		expect(JSON.stringify(commit)).not.toContain('maintain');
		expect(JSON.stringify(commit)).not.toContain(nonce);
		expect(parseRiftAction({ ...commit, choice: 'maintain', nonce })).toBeNull();
		const withBadReveal = addAction(addAction(state, 701, pubkeys[0], round.selectionAtMs + 1, commit), 702, pubkeys[0], round.resultAtMs + 1,
			buildRiftRevealAction({ holeId, round: 1, commitId: hex(9999), choice: 'maintain', nonce }));
		const settled = settleRiftSession(withBadReveal, SCHEDULE, round.revealCutoffAtMs);
		expect(settled.results[0].kind).toBe('insufficient');
	});

	it.each([[3, 2], [4, 3], [5, 4], [6, 4]] as const)('calculates required maintainers for %s valid participants', (count, required) => {
		const { state, pubkeys, holeId } = addJoins(count);
		const withChoices = addRoundActions(state, pubkeys, holeId, 1, pubkeys.map(() => 'maintain'));
		const settled = settleRiftSession(withChoices, SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(settled.results[0].requiredMaintain).toBe(required);
	});

	it('awards all maintainers twenty points, and mixed success awards ten and one hundred', () => {
		const all = addJoins(3);
		const allState = settleRiftSession(addRoundActions(all.state, all.pubkeys, all.holeId, 1, ['maintain', 'maintain', 'maintain']), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(allState.results[0].kind).toBe('all-maintain');
		expect(allState.results[0].outcomes.map((outcome) => outcome.points)).toEqual([20, 20, 20]);

		const mixed = addJoins(3);
		const mixedState = settleRiftSession(addRoundActions(mixed.state, mixed.pubkeys, mixed.holeId, 1, ['maintain', 'maintain', 'escape']), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(mixedState.results[0].kind).toBe('mixed-success');
		expect(mixedState.results[0].outcomes.map((outcome) => outcome.points)).toEqual([10, 10, 100]);
	});

	it('closes a hole and kills only escape participants on threshold failure', () => {
		const { state, pubkeys, holeId } = addJoins(3);
		const failed = settleRiftSession(addRoundActions(state, pubkeys, holeId, 1, ['maintain', 'escape', 'escape']), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(failed.results[0].kind).toBe('threshold-failure');
		expect(failed.results[0].outcomes.every((outcome) => outcome.kind === 'death')).toBe(true);
		expect(failed.closedHoleIds).toContain(holeId);
	});

	it('treats missing reveals and fewer than three valid participants as safe non-results', () => {
		const { state, pubkeys, holeId } = addJoins(3);
		const missing = settleRiftSession(addRoundActions(state, pubkeys, holeId, 1, ['maintain', 'maintain', 'maintain'], false), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(missing.results[0].kind).toBe('insufficient');
		expect(missing.results[0].outcomes).toEqual([]);
	});

	it('completes three rounds and does not run later rounds after closure', () => {
		const { state, pubkeys, holeId } = addJoins(3);
		let withRounds = state;
		for (const round of [1, 2, 3] as const) withRounds = addRoundActions(withRounds, pubkeys, holeId, round, ['maintain', 'maintain', 'maintain']);
		const complete = settleRiftSession(withRounds, SCHEDULE, getRiftRoundSchedule(SCHEDULE, 3).revealCutoffAtMs);
		expect(complete.results).toHaveLength(3);
		expect(complete.closedHoleIds).toEqual([]);
	});

	it('keeps recovery open through every round and closes it for terminal no-outcome states', () => {
		const { state, pubkeys, holeId } = addJoins(3);
		const roundOne = settleRiftSession(addRoundActions(state, pubkeys, holeId, 1, ['maintain', 'maintain', 'maintain']), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(isRiftSettlementComplete(roundOne, { ...SCHEDULE, phase: 'ended' }, pubkeys[0])).toBe(false);

		const allRounds = settleRiftSession(
			[1, 2, 3].reduce((current, round) => addRoundActions(current, pubkeys, holeId, round as 1 | 2 | 3, ['maintain', 'maintain', 'maintain']), state),
			{ ...SCHEDULE, phase: 'ended' },
			getRiftRoundSchedule(SCHEDULE, 3).revealCutoffAtMs
		);
		expect(isRiftSettlementComplete(allRounds, { ...SCHEDULE, phase: 'ended' }, pubkeys[0])).toBe(true);

		const closed = settleRiftSession(addRoundActions(state, pubkeys, holeId, 1, ['maintain', 'escape', 'escape']), SCHEDULE, getRiftRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(isRiftSettlementComplete(closed, { ...SCHEDULE, phase: 'ended' }, pubkeys[1])).toBe(true);
		expect(isRiftSettlementComplete(closed, { ...SCHEDULE, phase: 'ended' }, hex(999))).toBe(true);
	});
});
