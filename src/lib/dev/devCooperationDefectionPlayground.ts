import {
	applyCooperationDefectionAction,
	buildCooperationDefectionCommitAction,
	buildCooperationDefectionRevealAction,
	createCooperationDefectionSession,
	getCooperationDefectionRoundSchedule,
	getCooperationDefectionScheduleForInstance,
	snapshotCooperationDefectionParticipants,
	settleCooperationDefectionSession,
	type CooperationDefectionActionEvent,
	type CooperationDefectionChoice,
	type CooperationDefectionSchedule,
	type CooperationDefectionSessionState
} from '../cooperationDefection';
import { COOPERATION_DEFECTION_CONSULTATION_MS, COOPERATION_DEFECTION_ROUND_COUNT, COOPERATION_DEFECTION_ROUND_MS, COOPERATION_DEFECTION_SELECTION_MS, COOPERATION_DEFECTION_REVEAL_GRACE_MS } from '../cooperationDefection';
import type { FieldSize } from '../geometry';
type PlaygroundField = Pick<FieldSize, 'columns' | 'rows'>;

export const DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY = 'a'.repeat(64);
export const DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_A_PUBKEY = 'b'.repeat(64);
export const DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_B_PUBKEY = 'c'.repeat(64);
export const DEV_COOPERATION_DEFECTION_PLAYGROUND_ACTORS = [
	DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY,
	DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_A_PUBKEY,
	DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_B_PUBKEY
] as const;

export type DevCooperationDefectionBotPreset = 'cooperative' | 'split' | 'defection' | 'missing-reveal';
export type DevCooperationDefectionPlaygroundState = Readonly<{
	schedule: CooperationDefectionSchedule;
	nowMs: number;
	session: CooperationDefectionSessionState;
	preset: DevCooperationDefectionBotPreset;
	selfJoined: boolean;
	selfChoice: CooperationDefectionChoice | null;
	message: string | null;
}>;

const INSTANCE_ID = 'cooperation-defection-playground:local:1';
const REGISTRATION_AT = 0;
const GAME_AT = 1_000;

function scheduleAt(nowMs: number): CooperationDefectionSchedule {
	const endedAtMs = GAME_AT + COOPERATION_DEFECTION_ROUND_COUNT * COOPERATION_DEFECTION_ROUND_MS;
	const phase: CooperationDefectionSchedule['phase'] = nowMs < REGISTRATION_AT ? 'dormant' : nowMs < GAME_AT ? 'registration' : nowMs < endedAtMs ? 'game' : 'ended';
	return { dateKey: 'playground', instanceId: INSTANCE_ID, warningAtMs: -1, registrationAtMs: REGISTRATION_AT, gameAtMs: GAME_AT, endedAtMs, phase };
}

function eventId(seed: string): string {
	return [...seed].map((character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64);
}

function actionEvent(pubkey: string, action: CooperationDefectionActionEvent['action'], createdAt: number, seed: string): CooperationDefectionActionEvent {
	return { id: eventId(seed), pubkey, action, createdAt };
}

function botChoices(preset: DevCooperationDefectionBotPreset): readonly [CooperationDefectionChoice, CooperationDefectionChoice] {
	if (preset === 'defection') return ['defect', 'defect'];
	if (preset === 'split') return ['cooperate', 'defect'];
	return ['cooperate', 'cooperate'];
}

export function createDevCooperationDefectionPlayground(field: PlaygroundField, preset: DevCooperationDefectionBotPreset = 'cooperative'): DevCooperationDefectionPlayground {
	return new DevCooperationDefectionPlayground(field, preset);
}

export class DevCooperationDefectionPlayground {
	private readonly field: PlaygroundField;
	private state: DevCooperationDefectionPlaygroundState;
	private phaseIndex = 0;
	private readonly phases = [
		GAME_AT - 500,
		GAME_AT + 1,
		GAME_AT + COOPERATION_DEFECTION_CONSULTATION_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_CONSULTATION_MS + COOPERATION_DEFECTION_SELECTION_MS + COOPERATION_DEFECTION_REVEAL_GRACE_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS + COOPERATION_DEFECTION_CONSULTATION_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS + COOPERATION_DEFECTION_CONSULTATION_MS + COOPERATION_DEFECTION_SELECTION_MS + COOPERATION_DEFECTION_REVEAL_GRACE_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS * 2 + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS * 2 + COOPERATION_DEFECTION_CONSULTATION_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS * 2 + COOPERATION_DEFECTION_CONSULTATION_MS + COOPERATION_DEFECTION_SELECTION_MS + COOPERATION_DEFECTION_REVEAL_GRACE_MS + 1,
		GAME_AT + COOPERATION_DEFECTION_ROUND_MS * 3 + 1
	] as const;

	constructor(field: PlaygroundField, preset: DevCooperationDefectionBotPreset) {
		this.field = field;
		this.state = { schedule: scheduleAt(this.phases[0]), nowMs: this.phases[0], session: this.newSession(), preset, selfJoined: false, selfChoice: null, message: null };
	}

	private newSession(): CooperationDefectionSessionState {
		return createCooperationDefectionSession({ instanceId: INSTANCE_ID, field: { ...this.field, cellSize: 0 } });
	}

	private update(nowMs: number, session: CooperationDefectionSessionState, patch: Partial<DevCooperationDefectionPlaygroundState> = {}): DevCooperationDefectionPlaygroundState {
		this.state = { ...this.state, ...patch, nowMs, schedule: scheduleAt(nowMs), session };
		return this.state;
	}

	get snapshot(): DevCooperationDefectionPlaygroundState { return this.state; }

	setPreset(preset: DevCooperationDefectionBotPreset): DevCooperationDefectionPlaygroundState {
		return this.update(this.state.nowMs, this.state.session, { preset });
	}

	canAdvance(): boolean {
		if (this.phaseIndex >= this.phases.length - 1) return false;
		const nextIndex = this.phaseIndex + 1;
		const nextNow = this.phases[nextIndex];
		if (scheduleAt(nextNow).phase === 'game' && !this.state.selfJoined) return false;
		const enteringResult = nextIndex === 3 || nextIndex === 6 || nextIndex === 9;
		return !enteringResult || this.state.selfChoice !== null;
	}

	joinSelf(groupId?: string): DevCooperationDefectionPlaygroundState {
		if (this.state.schedule.phase !== 'registration' || this.state.selfJoined) return this.state;
		let session = this.state.session;
		const group = groupId ?? `${INSTANCE_ID}:group:0`;
		for (const [index, pubkey] of DEV_COOPERATION_DEFECTION_PLAYGROUND_ACTORS.entries()) {
			session = applyCooperationDefectionAction(session, actionEvent(pubkey, { action: 'join', groupId: group }, this.state.nowMs, `join-${index}`));
		}
		return this.update(this.state.nowMs, session, { selfJoined: true, message: 'Joined the local CooperationDefection with Bot A and Bot B.' });
	}

	chooseSelf(choice: CooperationDefectionChoice): DevCooperationDefectionPlaygroundState {
		const round = this.currentRound();
		const roundSchedule = getCooperationDefectionRoundSchedule(this.state.schedule, round);
		if (!this.state.selfJoined || this.state.schedule.phase !== 'game' || this.state.nowMs < roundSchedule.selectionAtMs || this.state.nowMs >= roundSchedule.resultAtMs || this.state.selfChoice) return this.state;
		const nonce = `${round}`.repeat(64).slice(0, 64);
		const commit = buildCooperationDefectionCommitAction({ instanceId: INSTANCE_ID, groupId: this.selfGroup(), round, authorPubkey: DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY, choice, nonce });
		const next = applyCooperationDefectionAction(this.state.session, actionEvent(DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY, commit, this.state.nowMs, `self-commit-${round}`));
		return this.update(this.state.nowMs, next, { selfChoice: choice, message: `Self committed ${choice}.` });
	}

	private currentRound(): 1 | 2 | 3 {
		for (const round of [1, 2, 3] as const) if (this.state.nowMs < getCooperationDefectionRoundSchedule(this.state.schedule, round).endedAtMs) return round;
		return 3;
	}

	private selfGroup(): string {
		return this.state.session.participantSnapshot ? Object.entries(this.state.session.participantSnapshot).find(([, ids]) => ids.includes(DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY))?.[0] ?? `${INSTANCE_ID}:group:0` : `${INSTANCE_ID}:group:0`;
	}

	private supplyBots(session: CooperationDefectionSessionState, round: 1 | 2 | 3): CooperationDefectionSessionState {
		const choices = botChoices(this.state.preset);
		const groupId = this.selfGroup();
		for (const [index, pubkey] of [DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_A_PUBKEY, DEV_COOPERATION_DEFECTION_PLAYGROUND_BOT_B_PUBKEY].entries()) {
			const choice = choices[index];
			const nonce = `${index + 4}${round}`.repeat(32).slice(0, 64);
			const commit = buildCooperationDefectionCommitAction({ instanceId: INSTANCE_ID, groupId, round, authorPubkey: pubkey, choice, nonce });
			const roundSchedule = getCooperationDefectionRoundSchedule(this.state.schedule, round);
			const commitEvent = actionEvent(pubkey, commit, roundSchedule.selectionAtMs + 1, `bot-commit-${round}-${index}`);
			session = applyCooperationDefectionAction(session, commitEvent);
			if (this.state.preset !== 'missing-reveal' || index !== 1) {
				session = applyCooperationDefectionAction(session, actionEvent(pubkey, buildCooperationDefectionRevealAction({ groupId, round, commitId: commitEvent.id, choice, nonce }), roundSchedule.resultAtMs + 1, `bot-reveal-${round}-${index}`));
			}
		}
		return session;
	}

	advance(): DevCooperationDefectionPlaygroundState {
		if (!this.canAdvance()) {
			if (this.state.schedule.phase === 'registration' && !this.state.selfJoined) {
				return this.update(this.state.nowMs, this.state.session, { message: 'ゲーム開始前に参加地点から参加してください。' });
			}
			if (this.state.schedule.phase === 'game' && !this.state.selfChoice) {
				return this.update(this.state.nowMs, this.state.session, { message: '結果発表へ進む前に選択してください。' });
			}
			return this.state;
		}
		const nextIndex = this.phaseIndex + 1;
		const nextNow = this.phases[nextIndex];
		const enteringResult = nextIndex === 3 || nextIndex === 6 || nextIndex === 9;
		let session = this.state.session;
		if (scheduleAt(nextNow).phase === 'game') session = snapshotCooperationDefectionParticipants(session, scheduleAt(nextNow));
		if (enteringResult) {
			const round = (nextIndex === 3 ? 1 : nextIndex === 6 ? 2 : 3) as 1 | 2 | 3;
			const selfChoice = this.state.selfChoice;
			if (!selfChoice) return this.state;
			const roundSchedule = getCooperationDefectionRoundSchedule(this.state.schedule, round);
			const nonce = `${round}`.repeat(64).slice(0, 64);
			const commitId = this.state.session.actions.find((event) => event.pubkey === DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY && event.action.action === 'commit' && event.action.round === round)?.id;
			if (commitId) {
				const selfReveal = actionEvent(DEV_COOPERATION_DEFECTION_PLAYGROUND_SELF_PUBKEY, buildCooperationDefectionRevealAction({ groupId: this.selfGroup(), round, commitId, choice: selfChoice, nonce }), roundSchedule.resultAtMs + 1, `self-reveal-${round}`);
				session = applyCooperationDefectionAction(session, selfReveal);
			}
			session = this.supplyBots(session, round);
			session = settleCooperationDefectionSession(session, this.state.schedule, nextNow);
		}
		this.phaseIndex = nextIndex;
		const resetChoice = nextIndex === 4 || nextIndex === 7 ? null : this.state.selfChoice;
		return this.update(nextNow, session, { selfChoice: resetChoice, message: enteringResult ? 'Local domain settlement applied; production persistence was not called.' : null });
	}

	reset(): DevCooperationDefectionPlaygroundState {
		const replacement = createDevCooperationDefectionPlayground(this.field, this.state.preset);
		this.phaseIndex = replacement.phaseIndex;
		this.state = replacement.state;
		return this.state;
	}
}
