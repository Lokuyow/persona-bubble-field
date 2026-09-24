import { describe, expect, it } from 'vitest';
import type { VerifiedEvent } from 'nostr-tools/pure';
import {
	applyCooperationDefectionAction,
	buildManualCooperationDefectionInstanceId,
	buildCooperationDefectionCommitAction,
	buildCooperationDefectionRevealAction,
	buildCooperationDefectionActionTemplate,
	COOPERATION_DEFECTION_EVENT_TYPE,
	COOPERATION_DEFECTION_PROTOCOL_KEY,
	createCooperationDefectionSession,
	COOPERATION_DEFECTION_CONSULTATION_MS,
	COOPERATION_DEFECTION_RESULT_MS,
	COOPERATION_DEFECTION_ROUND_COUNT,
	COOPERATION_DEFECTION_ROUND_MS,
	COOPERATION_DEFECTION_SELECTION_MS,
	getCooperationDefectionRoundSchedule,
	getCooperationDefectionSchedule,
	getCooperationDefectionScheduleForInstance,
	isCooperationDefectionSettlementComplete,
	parseCooperationDefectionAction,
	parseCooperationDefectionEvent,
	isRetiredRiftSettlementInstanceId,
	parseManualCooperationDefectionInstanceId,
	selectCanonicalManualCooperationDefectionControl,
	cooperationDefectionScheduleIntervalsOverlap,
	snapshotCooperationDefectionParticipants,
	settleCooperationDefectionSession,
	type CooperationDefectionAction,
	type CooperationDefectionActionEvent,
	type CooperationDefectionSessionState
} from './cooperationDefection';
import { buildRealtimeEventTemplate, finalizeRealtimeEvent, REALTIME_CONTROL_PROTOCOL_KEY, type RealtimeControlEnvelope } from './realtimeEvents';

const FIELD = { columns: 16, rows: 8, cellSize: 50 };
const INSTANCE = 'io.github.lokuyow.persona-bubble-field:realtime:cooperation-defection:1:instance:2026-01-01';
const SCHEDULE = getCooperationDefectionSchedule(Date.UTC(2026, 0, 1, 12, 0));

function hex(value: number): string {
	return value.toString(16).padStart(64, '0');
}

function actionEvent(id: number, pubkey: string, createdAt: number, action: CooperationDefectionAction): CooperationDefectionActionEvent {
	return { id: hex(id), pubkey, createdAt, action };
}

function addAction(state: CooperationDefectionSessionState, id: number, pubkey: string, createdAt: number, action: CooperationDefectionAction): CooperationDefectionSessionState {
	return applyCooperationDefectionAction(state, actionEvent(id, pubkey, createdAt, action));
}

function addJoins(count: number): { state: CooperationDefectionSessionState; pubkeys: string[]; groupId: string } {
	let state = createCooperationDefectionSession({ instanceId: INSTANCE, field: FIELD });
	const groupId = state.groups[0].id;
	const pubkeys = Array.from({ length: count }, (_, index) => hex(40 + index));
	for (let index = 0; index < count; index += 1) state = addAction(state, index + 1, pubkeys[index], SCHEDULE.registrationAtMs + 100 + index, { action: 'join', groupId });
	return { state, pubkeys, groupId };
}

function addRoundActions(state: CooperationDefectionSessionState, pubkeys: readonly string[], groupId: string, round: 1 | 2 | 3, choices: readonly ('cooperate' | 'defect')[], reveal = true, instanceId = INSTANCE): CooperationDefectionSessionState {
	let next = state;
	const roundSchedule = getCooperationDefectionRoundSchedule(SCHEDULE, round);
	for (let index = 0; index < pubkeys.length; index += 1) {
		const nonce = hex(100 + round * 10 + index);
		const commit = buildCooperationDefectionCommitAction({ instanceId, groupId, round, authorPubkey: pubkeys[index], choice: choices[index], nonce });
		const commitId = 1000 + round * 100 + index;
		next = addAction(next, commitId, pubkeys[index], roundSchedule.selectionAtMs + 100 + index, commit);
		if (reveal) next = addAction(next, commitId + 100, pubkeys[index], roundSchedule.resultAtMs + 1000 + index, { action: 'reveal', groupId, round, commitId: hex(commitId), choice: choices[index], nonce });
	}
	return next;
}

describe('CooperationDefection schedule and domain', () => {
	it('uses the new protocol key and rejects the retired protocol and choice values', () => {
		expect(COOPERATION_DEFECTION_EVENT_TYPE).toBe('cooperation-defection');
		expect(COOPERATION_DEFECTION_PROTOCOL_KEY).toBe('io.github.lokuyow.persona-bubble-field:realtime:cooperation-defection:1');
		const groupId = `${INSTANCE}:group:0`;
		expect(parseCooperationDefectionAction({ action: 'reveal', groupId, round: 1, commitId: hex(1), choice: 'maintain', nonce: hex(2) })).toBeNull();
		const legacy = finalizeRealtimeEvent(buildRealtimeEventTemplate({
			channelId: 'a'.repeat(64), relayHint: 'wss://relay.test/', eventType: 'rift', protocolVersion: 1,
			instanceId: 'rift:1:manual:1700000000:0123456789abcdef0123456789abcdef',
			payload: { action: 'join', groupId: 'rift:1:manual:1700000000:0123456789abcdef0123456789abcdef:group:0' }, createdAt: 1_700_000_000
		}), new Uint8Array(32).fill(30));
		expect(parseCooperationDefectionEvent(legacy, 'a'.repeat(64))).toBeNull();
		expect(isRetiredRiftSettlementInstanceId('io.github.lokuyow.persona-bubble-field:realtime:rift:1:instance:2026-09-24')).toBe(true);
		expect(isRetiredRiftSettlementInstanceId('rift:1:manual:1700000000:0123456789abcdef0123456789abcdef')).toBe(true);
		expect(isRetiredRiftSettlementInstanceId('io.github.lokuyow.persona-bubble-field:realtime:rift:1:instance:2026-99-99')).toBe(false);
		expect(isRetiredRiftSettlementInstanceId(`${INSTANCE}:instance:2026-09-24`)).toBe(false);
	});

	it('uses deterministic JST boundaries independent of browser timezone', () => {
		const before = getCooperationDefectionSchedule(Date.UTC(2026, 0, 1, 11, 44, 59, 999));
		const warning = getCooperationDefectionSchedule(Date.UTC(2026, 0, 1, 11, 45));
		const registration = getCooperationDefectionSchedule(Date.UTC(2026, 0, 1, 11, 55));
		const game = getCooperationDefectionSchedule(Date.UTC(2026, 0, 1, 12, 0));
		expect(before.phase).toBe('dormant');
		expect(warning.phase).toBe('warning');
		expect(registration.phase).toBe('registration');
		expect(game.phase).toBe('game');
		expect(game.dateKey).toBe('2026-01-01');
		expect(game.instanceId).toBe(warning.instanceId);
	});

	it('reconstructs a manual schedule from its canonical ID and preserves CooperationDefection round timing', () => {
		const createdAt = 1_767_272_400;
		const instanceId = buildManualCooperationDefectionInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		expect(parseManualCooperationDefectionInstanceId(instanceId)).toEqual({ createdAt, nonce: '0123456789abcdef0123456789abcdef' });
		const registration = getCooperationDefectionScheduleForInstance(instanceId, createdAt * 1000);
		expect(registration?.phase).toBe('registration');
		expect(registration?.warningAtMs).toBe(registration?.registrationAtMs);
		expect(registration?.gameAtMs).toBe(createdAt * 1000 + 300_000);
		expect(getCooperationDefectionScheduleForInstance(instanceId, (createdAt + 630) * 1000)?.phase).toBe('ended');
		expect(() => buildManualCooperationDefectionInstanceId(createdAt, '0123456789ABCDEF0123456789ABCDEF')).toThrow();
	});

	it('uses the current adjustable phase parameters for all CooperationDefection schedules', () => {
		expect(COOPERATION_DEFECTION_CONSULTATION_MS).toBe(30_000);
		expect(COOPERATION_DEFECTION_SELECTION_MS).toBe(30_000);
		expect(COOPERATION_DEFECTION_RESULT_MS).toBe(20_000);
		expect(COOPERATION_DEFECTION_ROUND_MS).toBe(80_000);
		const firstRound = getCooperationDefectionRoundSchedule(SCHEDULE, 1);
		const finalRound = getCooperationDefectionRoundSchedule(SCHEDULE, COOPERATION_DEFECTION_ROUND_COUNT);
		expect(firstRound.selectionAtMs - firstRound.consultationAtMs).toBe(COOPERATION_DEFECTION_CONSULTATION_MS);
		expect(firstRound.resultAtMs - firstRound.selectionAtMs).toBe(COOPERATION_DEFECTION_SELECTION_MS);
		expect(firstRound.endedAtMs - firstRound.resultAtMs).toBe(COOPERATION_DEFECTION_RESULT_MS);
		expect(finalRound.endedAtMs - SCHEDULE.gameAtMs).toBe(240_000);
		expect(SCHEDULE.endedAtMs - SCHEDULE.gameAtMs).toBe(240_000);
	});

	it('treats every non-empty manual/scheduled interval intersection as a conflict', () => {
		const scheduled = { warningAtMs: 20 * 60 * 60 * 1000 + 45 * 60 * 1000, endedAtMs: 21 * 60 * 60 * 1000 + 30 * 60 * 1000 };
		expect(cooperationDefectionScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.warningAtMs - 5 * 60 * 1000, endedAtMs: scheduled.warningAtMs + 5 * 60 * 1000 })).toBe(true);
		expect(cooperationDefectionScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.endedAtMs, endedAtMs: scheduled.endedAtMs + 1 })).toBe(false);
		expect(cooperationDefectionScheduleIntervalsOverlap(scheduled, { registrationAtMs: scheduled.warningAtMs - 1, endedAtMs: scheduled.warningAtMs })).toBe(false);
	});

	it('excludes an ended manual control before selecting the canonical active candidate', () => {
		const nowMs = Date.UTC(2026, 0, 2, 10, 0);
		const endedAt = Math.floor((nowMs - 20 * 60 * 1000) / 1000);
		const activeAt = Math.floor((nowMs - 60 * 1000) / 1000);
		const control = (createdAt: number, id: string): RealtimeControlEnvelope => ({
			event: { id, created_at: createdAt } as VerifiedEvent,
			channelId: 'a'.repeat(64),
			protocolKey: REALTIME_CONTROL_PROTOCOL_KEY,
			instanceId: buildManualCooperationDefectionInstanceId(createdAt, '0123456789abcdef0123456789abcdef'),
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY }
		});
		const selected = selectCanonicalManualCooperationDefectionControl([control(activeAt, 'b'.repeat(64)), control(endedAt, 'a'.repeat(64))], nowMs);
		expect(selected?.event.id).toBe('b'.repeat(64));
	});

	it('places at least one deterministic group and avoids fixed facilities', () => {
		const first = createCooperationDefectionSession({ instanceId: INSTANCE, field: FIELD });
		const second = createCooperationDefectionSession({ instanceId: INSTANCE, field: FIELD });
		expect(first.groups).toEqual(second.groups);
		expect(first.groups.length).toBeGreaterThanOrEqual(1);
		expect(first.groups.some((group) => group.position.x === 12 && group.position.y === 3)).toBe(false);
	});

	it('switches a participant to the latest selected group and deterministically caps a crowded group at six', () => {
		const { state: crowded, pubkeys, groupId } = addJoins(7);
		const secondGroup = crowded.groups[1];
		const switched = addAction(crowded, 500, pubkeys[0], SCHEDULE.registrationAtMs + 5000, { action: 'join', groupId: secondGroup.id });
		const snap = settleCooperationDefectionSession(switched, SCHEDULE, SCHEDULE.gameAtMs + 1);
		expect(snap.participantSnapshot?.[groupId]).toHaveLength(6);
		expect(snap.participantSnapshot?.[secondGroup.id]).toEqual([pubkeys[0]]);
	});

	it.each([0, 1, 2])('cancels a group with %i effective participants at game start without creating a round result', (count) => {
		const { state, pubkeys, groupId } = addJoins(count);
		const beforeRegistrationEnds = snapshotCooperationDefectionParticipants(state, { ...SCHEDULE, phase: 'registration' });
		expect(beforeRegistrationEnds.participantSnapshot).toBeNull();
		expect(beforeRegistrationEnds.cancelledGroupIds).toEqual([]);
		if (pubkeys[0]) expect(isCooperationDefectionSettlementComplete(state, { ...SCHEDULE, phase: 'game' }, pubkeys[0])).toBe(false);

		const settled = settleCooperationDefectionSession(state, { ...SCHEDULE, phase: 'game' }, SCHEDULE.gameAtMs + 1);
		expect(settled.participantSnapshot?.[groupId] ?? []).toHaveLength(count);
		expect(settled.cancelledGroupIds).toContain(groupId);
		expect(settled.results).toEqual([]);
		for (const pubkey of pubkeys) expect(isCooperationDefectionSettlementComplete(settled, { ...SCHEDULE, phase: 'game' }, pubkey)).toBe(true);
	});

	it('cancels only the underfilled group while another group proceeds and settles normally', () => {
		const { state: crowded, pubkeys } = addJoins(7);
		const [underfilledGroup, activeGroup] = crowded.groups;
		if (!underfilledGroup || !activeGroup) throw new Error('Expected two groups for seven registered participants.');
		let reassigned = crowded;
		for (let index = 2; index < 7; index += 1) {
			reassigned = addAction(reassigned, 500 + index, pubkeys[index], SCHEDULE.registrationAtMs + 1_000 + index, { action: 'join', groupId: activeGroup.id });
		}
		const activePubkeys = pubkeys.slice(2, 5);
		const withChoices = addRoundActions(reassigned, activePubkeys, activeGroup.id, 1, ['cooperate', 'cooperate', 'cooperate']);
		const settled = settleCooperationDefectionSession(withChoices, SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);

		expect(settled.cancelledGroupIds).toContain(underfilledGroup.id);
		expect(settled.cancelledGroupIds).not.toContain(activeGroup.id);
		expect(settled.results.map((result) => result.groupId)).toEqual([activeGroup.id]);
		expect(settled.results[0]?.kind).toBe('all-cooperate');
		expect(settled.results[0]?.outcomes).toHaveLength(3);
		expect(isCooperationDefectionSettlementComplete(settled, { ...SCHEDULE, phase: 'game' }, pubkeys[0])).toBe(true);
		expect(isCooperationDefectionSettlementComplete(settled, { ...SCHEDULE, phase: 'game' }, pubkeys[2])).toBe(false);
	});

	it('publishes only a commitment during secret selection and rejects a mismatched reveal', () => {
		const { state, pubkeys, groupId } = addJoins(3);
		const round = getCooperationDefectionRoundSchedule(SCHEDULE, 1);
		const nonce = hex(700);
		const commit = buildCooperationDefectionCommitAction({ instanceId: INSTANCE, groupId, round: 1, authorPubkey: pubkeys[0], choice: 'cooperate', nonce });
		expect(commit).toEqual({ action: 'commit', groupId, round: 1, commitment: expect.any(String) });
		expect(JSON.stringify(commit)).not.toContain('cooperate');
		expect(JSON.stringify(commit)).not.toContain(nonce);
		expect(parseCooperationDefectionAction({ ...commit, choice: 'cooperate', nonce })).toBeNull();
		const withBadReveal = addAction(addAction(state, 701, pubkeys[0], round.selectionAtMs + 1, commit), 702, pubkeys[0], round.resultAtMs + 1,
			buildCooperationDefectionRevealAction({ groupId, round: 1, commitId: hex(9999), choice: 'cooperate', nonce }));
		const settled = settleCooperationDefectionSession(withBadReveal, SCHEDULE, round.revealCutoffAtMs);
		expect(settled.results[0].kind).toBe('insufficient');
	});

	it.each([[3, 2], [4, 3], [5, 4], [6, 4]] as const)('calculates required cooperators for %s valid participants', (count, required) => {
		const { state, pubkeys, groupId } = addJoins(count);
		const withChoices = addRoundActions(state, pubkeys, groupId, 1, pubkeys.map(() => 'cooperate'));
		const settled = settleCooperationDefectionSession(withChoices, SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(settled.results[0].requiredCooperators).toBe(required);
	});

	it('awards all cooperators one thousand points, and mixed success awards one hundred and ten thousand', () => {
		const all = addJoins(3);
		const allState = settleCooperationDefectionSession(addRoundActions(all.state, all.pubkeys, all.groupId, 1, ['cooperate', 'cooperate', 'cooperate']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(allState.results[0].kind).toBe('all-cooperate');
		expect(allState.results[0].outcomes.map((outcome) => outcome.points)).toEqual([1_000, 1_000, 1_000]);

		const mixed = addJoins(3);
		const mixedState = settleCooperationDefectionSession(addRoundActions(mixed.state, mixed.pubkeys, mixed.groupId, 1, ['cooperate', 'cooperate', 'defect']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(mixedState.results[0].kind).toBe('cooperation-success');
		expect(mixedState.results[0].outcomes.map((outcome) => outcome.points)).toEqual([100, 100, 10_000]);
	});

	it('closes a group after threshold failure and applies a fixed 72-hour loss only to defectors', () => {
		const { state, pubkeys, groupId } = addJoins(3);
		const failed = settleCooperationDefectionSession(addRoundActions(state, pubkeys, groupId, 1, ['cooperate', 'defect', 'defect']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(failed.results[0].kind).toBe('cooperation-failure');
		expect(failed.results[0].outcomes.map((outcome) => [outcome.pubkey, outcome.kind, outcome.lifespanLossMs])).toEqual([
			[pubkeys[1], 'lifespan-loss', 72 * 60 * 60 * 1000], [pubkeys[2], 'lifespan-loss', 72 * 60 * 60 * 1000]
		]);
		expect(failed.closedGroupIds).toContain(groupId);
		const beyondFailure = settleCooperationDefectionSession(addRoundActions(failed, pubkeys, groupId, 2, ['cooperate', 'cooperate', 'cooperate']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 3).revealCutoffAtMs);
		expect(beyondFailure.results).toHaveLength(1);
	});

	it('treats missing reveals and fewer than three valid participants as safe non-results', () => {
		const { state, pubkeys, groupId } = addJoins(3);
		const missing = settleCooperationDefectionSession(addRoundActions(state, pubkeys, groupId, 1, ['cooperate', 'cooperate', 'cooperate'], false), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(missing.results[0].kind).toBe('insufficient');
		expect(missing.results[0].outcomes).toEqual([]);
	});

	it('completes three rounds and does not run later rounds after closure', () => {
		const { state, pubkeys, groupId } = addJoins(3);
		let withRounds = state;
		for (const round of [1, 2, 3] as const) withRounds = addRoundActions(withRounds, pubkeys, groupId, round, ['cooperate', 'cooperate', 'cooperate']);
		const complete = settleCooperationDefectionSession(withRounds, SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 3).revealCutoffAtMs);
		expect(complete.results).toHaveLength(3);
		expect(complete.closedGroupIds).toEqual([]);
	});

	it('keeps recovery open through every round and closes it for terminal no-outcome states', () => {
		const { state, pubkeys, groupId } = addJoins(3);
		const roundOne = settleCooperationDefectionSession(addRoundActions(state, pubkeys, groupId, 1, ['cooperate', 'cooperate', 'cooperate']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(isCooperationDefectionSettlementComplete(roundOne, { ...SCHEDULE, phase: 'ended' }, pubkeys[0])).toBe(false);

		const allRounds = settleCooperationDefectionSession(
			[1, 2, 3].reduce((current, round) => addRoundActions(current, pubkeys, groupId, round as 1 | 2 | 3, ['cooperate', 'cooperate', 'cooperate']), state),
			{ ...SCHEDULE, phase: 'ended' },
			getCooperationDefectionRoundSchedule(SCHEDULE, 3).revealCutoffAtMs
		);
		expect(isCooperationDefectionSettlementComplete(allRounds, { ...SCHEDULE, phase: 'ended' }, pubkeys[0])).toBe(true);

		const closed = settleCooperationDefectionSession(addRoundActions(state, pubkeys, groupId, 1, ['cooperate', 'defect', 'defect']), SCHEDULE, getCooperationDefectionRoundSchedule(SCHEDULE, 1).revealCutoffAtMs);
		expect(isCooperationDefectionSettlementComplete(closed, { ...SCHEDULE, phase: 'ended' }, pubkeys[1])).toBe(true);
		expect(isCooperationDefectionSettlementComplete(closed, { ...SCHEDULE, phase: 'ended' }, hex(999))).toBe(true);
	});

	it('produces deterministic outcome and publication IDs within the wire limit', () => {
		const longInstance = buildManualCooperationDefectionInstanceId(1_767_272_400, '0123456789abcdef0123456789abcdef');
		let longSession = createCooperationDefectionSession({ instanceId: longInstance, field: FIELD });
		const longSchedule = { ...SCHEDULE, instanceId: longInstance };
		const groupId = longSession.groups[0].id;
		const pubkeys = [hex(40), hex(41), hex(42)];
		for (let index = 0; index < pubkeys.length; index += 1) longSession = addAction(longSession, index + 1, pubkeys[index], SCHEDULE.registrationAtMs + 100 + index, { action: 'join', groupId });
		const outcomeState = settleCooperationDefectionSession(
			addRoundActions(longSession, pubkeys, groupId, 1, ['cooperate', 'cooperate', 'cooperate'], true, longInstance),
			longSchedule, getCooperationDefectionRoundSchedule(longSchedule, 1).revealCutoffAtMs
		);
		const ids = outcomeState.results[0].outcomes.map((outcome) => outcome.id);
		expect(new Set(ids).size).toBe(3);
		expect(ids.every((id) => id.length <= 240)).toBe(true);
		expect(outcomeState.results[0].outcomes.every((outcome) => outcome.id.includes(`${COOPERATION_DEFECTION_EVENT_TYPE}:1:outcome:`))).toBe(true);
	});
});
