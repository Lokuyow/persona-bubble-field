import {
	applyRiftAction,
	buildRiftCommitAction,
	buildRiftRevealAction,
	createRiftSession,
	getRiftRoundSchedule,
	getRiftScheduleForInstance,
	snapshotRiftParticipants,
	settleRiftSession,
	type RiftActionEvent,
	type RiftChoice,
	type RiftSchedule,
	type RiftSessionState
} from '../rift';
import { RIFT_CONSULTATION_MS, RIFT_ROUND_COUNT, RIFT_ROUND_MS, RIFT_SELECTION_MS, RIFT_REVEAL_GRACE_MS } from '../rift';
import type { FieldSize } from '../geometry';
type PlaygroundField = Pick<FieldSize, 'columns' | 'rows'>;

export const DEV_RIFT_PLAYGROUND_SELF_PUBKEY = 'a'.repeat(64);
export const DEV_RIFT_PLAYGROUND_BOT_A_PUBKEY = 'b'.repeat(64);
export const DEV_RIFT_PLAYGROUND_BOT_B_PUBKEY = 'c'.repeat(64);
export const DEV_RIFT_PLAYGROUND_ACTORS = [
	DEV_RIFT_PLAYGROUND_SELF_PUBKEY,
	DEV_RIFT_PLAYGROUND_BOT_A_PUBKEY,
	DEV_RIFT_PLAYGROUND_BOT_B_PUBKEY
] as const;

export type DevRiftBotPreset = 'cooperative' | 'split' | 'escape' | 'missing-reveal';
export type DevRiftPlaygroundState = Readonly<{
	schedule: RiftSchedule;
	nowMs: number;
	session: RiftSessionState;
	preset: DevRiftBotPreset;
	selfJoined: boolean;
	selfChoice: RiftChoice | null;
	message: string | null;
}>;

const INSTANCE_ID = 'rift-playground:local:1';
const REGISTRATION_AT = 0;
const GAME_AT = 1_000;

function scheduleAt(nowMs: number): RiftSchedule {
	const endedAtMs = GAME_AT + RIFT_ROUND_COUNT * RIFT_ROUND_MS;
	const phase: RiftSchedule['phase'] = nowMs < REGISTRATION_AT ? 'dormant' : nowMs < GAME_AT ? 'registration' : nowMs < endedAtMs ? 'game' : 'ended';
	return { dateKey: 'playground', instanceId: INSTANCE_ID, warningAtMs: -1, registrationAtMs: REGISTRATION_AT, gameAtMs: GAME_AT, endedAtMs, phase };
}

function eventId(seed: string): string {
	return [...seed].map((character) => character.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64);
}

function actionEvent(pubkey: string, action: RiftActionEvent['action'], createdAt: number, seed: string): RiftActionEvent {
	return { id: eventId(seed), pubkey, action, createdAt };
}

function botChoices(preset: DevRiftBotPreset): readonly [RiftChoice, RiftChoice] {
	if (preset === 'escape') return ['escape', 'escape'];
	if (preset === 'split') return ['maintain', 'escape'];
	return ['maintain', 'maintain'];
}

export function createDevRiftPlayground(field: PlaygroundField, preset: DevRiftBotPreset = 'cooperative'): DevRiftPlayground {
	return new DevRiftPlayground(field, preset);
}

export class DevRiftPlayground {
	private readonly field: PlaygroundField;
	private state: DevRiftPlaygroundState;
	private phaseIndex = 0;
	private readonly phases = [
		GAME_AT - 500,
		GAME_AT + 1,
		GAME_AT + RIFT_CONSULTATION_MS + 1,
		GAME_AT + RIFT_CONSULTATION_MS + RIFT_SELECTION_MS + RIFT_REVEAL_GRACE_MS + 1,
		GAME_AT + RIFT_ROUND_MS + 1,
		GAME_AT + RIFT_ROUND_MS + RIFT_CONSULTATION_MS + 1,
		GAME_AT + RIFT_ROUND_MS + RIFT_CONSULTATION_MS + RIFT_SELECTION_MS + RIFT_REVEAL_GRACE_MS + 1,
		GAME_AT + RIFT_ROUND_MS * 2 + 1,
		GAME_AT + RIFT_ROUND_MS * 2 + RIFT_CONSULTATION_MS + 1,
		GAME_AT + RIFT_ROUND_MS * 2 + RIFT_CONSULTATION_MS + RIFT_SELECTION_MS + RIFT_REVEAL_GRACE_MS + 1,
		GAME_AT + RIFT_ROUND_MS * 3 + 1
	] as const;

	constructor(field: PlaygroundField, preset: DevRiftBotPreset) {
		this.field = field;
		this.state = { schedule: scheduleAt(this.phases[0]), nowMs: this.phases[0], session: this.newSession(), preset, selfJoined: false, selfChoice: null, message: null };
	}

	private newSession(): RiftSessionState {
		return createRiftSession({ instanceId: INSTANCE_ID, field: { ...this.field, cellSize: 0 } });
	}

	private update(nowMs: number, session: RiftSessionState, patch: Partial<DevRiftPlaygroundState> = {}): DevRiftPlaygroundState {
		this.state = { ...this.state, ...patch, nowMs, schedule: scheduleAt(nowMs), session };
		return this.state;
	}

	get snapshot(): DevRiftPlaygroundState { return this.state; }

	setPreset(preset: DevRiftBotPreset): DevRiftPlaygroundState {
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

	joinSelf(holeId?: string): DevRiftPlaygroundState {
		if (this.state.schedule.phase !== 'registration' || this.state.selfJoined) return this.state;
		let session = this.state.session;
		const hole = holeId ?? `${INSTANCE_ID}:hole:0`;
		for (const [index, pubkey] of DEV_RIFT_PLAYGROUND_ACTORS.entries()) {
			session = applyRiftAction(session, actionEvent(pubkey, { action: 'join', holeId: hole }, this.state.nowMs, `join-${index}`));
		}
		return this.update(this.state.nowMs, session, { selfJoined: true, message: 'Joined the local Rift with Bot A and Bot B.' });
	}

	chooseSelf(choice: RiftChoice): DevRiftPlaygroundState {
		const round = this.currentRound();
		const roundSchedule = getRiftRoundSchedule(this.state.schedule, round);
		if (!this.state.selfJoined || this.state.schedule.phase !== 'game' || this.state.nowMs < roundSchedule.selectionAtMs || this.state.nowMs >= roundSchedule.resultAtMs || this.state.selfChoice) return this.state;
		const nonce = `${round}`.repeat(64).slice(0, 64);
		const commit = buildRiftCommitAction({ instanceId: INSTANCE_ID, holeId: this.selfHole(), round, authorPubkey: DEV_RIFT_PLAYGROUND_SELF_PUBKEY, choice, nonce });
		const next = applyRiftAction(this.state.session, actionEvent(DEV_RIFT_PLAYGROUND_SELF_PUBKEY, commit, this.state.nowMs, `self-commit-${round}`));
		return this.update(this.state.nowMs, next, { selfChoice: choice, message: `Self committed ${choice}.` });
	}

	private currentRound(): 1 | 2 | 3 {
		for (const round of [1, 2, 3] as const) if (this.state.nowMs < getRiftRoundSchedule(this.state.schedule, round).endedAtMs) return round;
		return 3;
	}

	private selfHole(): string {
		return this.state.session.participantSnapshot ? Object.entries(this.state.session.participantSnapshot).find(([, ids]) => ids.includes(DEV_RIFT_PLAYGROUND_SELF_PUBKEY))?.[0] ?? `${INSTANCE_ID}:hole:0` : `${INSTANCE_ID}:hole:0`;
	}

	private supplyBots(session: RiftSessionState, round: 1 | 2 | 3): RiftSessionState {
		const choices = botChoices(this.state.preset);
		const holeId = this.selfHole();
		for (const [index, pubkey] of [DEV_RIFT_PLAYGROUND_BOT_A_PUBKEY, DEV_RIFT_PLAYGROUND_BOT_B_PUBKEY].entries()) {
			const choice = choices[index];
			const nonce = `${index + 4}${round}`.repeat(32).slice(0, 64);
			const commit = buildRiftCommitAction({ instanceId: INSTANCE_ID, holeId, round, authorPubkey: pubkey, choice, nonce });
			const roundSchedule = getRiftRoundSchedule(this.state.schedule, round);
			const commitEvent = actionEvent(pubkey, commit, roundSchedule.selectionAtMs + 1, `bot-commit-${round}-${index}`);
			session = applyRiftAction(session, commitEvent);
			if (this.state.preset !== 'missing-reveal' || index !== 1) {
				session = applyRiftAction(session, actionEvent(pubkey, buildRiftRevealAction({ holeId, round, commitId: commitEvent.id, choice, nonce }), roundSchedule.resultAtMs + 1, `bot-reveal-${round}-${index}`));
			}
		}
		return session;
	}

	advance(): DevRiftPlaygroundState {
		if (!this.canAdvance()) {
			if (this.state.schedule.phase === 'registration' && !this.state.selfJoined) {
				return this.update(this.state.nowMs, this.state.session, { message: 'Join the local Rift before advancing to the game.' });
			}
			if (this.state.schedule.phase === 'game' && !this.state.selfChoice) {
				return this.update(this.state.nowMs, this.state.session, { message: 'Choose Maintain or Escape before advancing to the result.' });
			}
			return this.state;
		}
		const nextIndex = this.phaseIndex + 1;
		const nextNow = this.phases[nextIndex];
		const enteringResult = nextIndex === 3 || nextIndex === 6 || nextIndex === 9;
		let session = this.state.session;
		if (scheduleAt(nextNow).phase === 'game') session = snapshotRiftParticipants(session, scheduleAt(nextNow));
		if (enteringResult) {
			const round = (nextIndex === 3 ? 1 : nextIndex === 6 ? 2 : 3) as 1 | 2 | 3;
			const selfChoice = this.state.selfChoice;
			if (!selfChoice) return this.state;
			const roundSchedule = getRiftRoundSchedule(this.state.schedule, round);
			const nonce = `${round}`.repeat(64).slice(0, 64);
			const commitId = this.state.session.actions.find((event) => event.pubkey === DEV_RIFT_PLAYGROUND_SELF_PUBKEY && event.action.action === 'commit' && event.action.round === round)?.id;
			if (commitId) {
				const selfReveal = actionEvent(DEV_RIFT_PLAYGROUND_SELF_PUBKEY, buildRiftRevealAction({ holeId: this.selfHole(), round, commitId, choice: selfChoice, nonce }), roundSchedule.resultAtMs + 1, `self-reveal-${round}`);
				session = applyRiftAction(session, selfReveal);
			}
			session = this.supplyBots(session, round);
			session = settleRiftSession(session, this.state.schedule, nextNow);
		}
		this.phaseIndex = nextIndex;
		const resetChoice = nextIndex === 4 || nextIndex === 7 ? null : this.state.selfChoice;
		return this.update(nextNow, session, { selfChoice: resetChoice, message: enteringResult ? 'Local domain settlement applied; production persistence was not called.' : null });
	}

	reset(): DevRiftPlaygroundState {
		const replacement = createDevRiftPlayground(this.field, this.state.preset);
		this.phaseIndex = replacement.phaseIndex;
		this.state = replacement.state;
		return this.state;
	}
}
