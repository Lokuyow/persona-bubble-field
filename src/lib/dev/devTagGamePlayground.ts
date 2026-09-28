import { debugSetParticipantPosition, moveParticipant, type PresenceField, type PresenceState } from '../presence';
import { isBlockedFacilityCell } from '../fieldFacilities';
import { DEV_WORLD_SELF_ID } from '../devWorldSandbox';
import { TAG_GAME_BENEFIT_POINTS_PER_SECOND, TAG_GAME_GAME_MS, TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND, TAG_GAME_MAX_EFFECT_MS, TAG_GAME_MAX_LIFESPAN_LOSS_MS, TAG_GAME_MAX_POINTS, TAG_GAME_TRANSFER_COOLDOWN_MS, createTagGameSchedule, isTagGameTransferCooldownActive, tagGameScheduledEffectAt, type TagGameParticipant, type TagGameState } from '../tagGame';
import type { Direction, GridPosition } from '../geometry';

export const DEV_TAG_GAME_SELF_PUBKEY = 'f'.repeat(64);
export const DEV_TAG_GAME_BOT_A_PUBKEY = 'b'.repeat(64);
export const DEV_TAG_GAME_BOT_B_PUBKEY = 'c'.repeat(64);
// The synthetic game identity is projected onto DEV World's selectable `you` participant.
export const DEV_TAG_GAME_SELF_ID = DEV_WORLD_SELF_ID;
export const DEV_TAG_GAME_BOT_A_ID = DEV_TAG_GAME_BOT_A_PUBKEY;
export const DEV_TAG_GAME_BOT_B_ID = DEV_TAG_GAME_BOT_B_PUBKEY;
export const DEV_TAG_GAME_ACTORS = [DEV_TAG_GAME_SELF_PUBKEY, DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_BOT_B_PUBKEY] as const;
export type DevTagGameSound = 'tag-game-start' | 'tag-game-switch' | 'tag-game-transfer' | 'tag-game-end' | 'tag-game-benefit' | 'tag-game-calamity';
export type DevTagGamePlaygroundSnapshot = Readonly<{
	game: TagGameState | null;
	presence: PresenceState;
	nowMs: number;
	message: string | null;
	sound: Readonly<{ sequence: number; effect: DevTagGameSound }> | null;
}>;

const SEED = 'dev-tag-game-playground-v1';
const PROPOSAL_ID = 'd'.repeat(64);
const PREFERRED_POSITIONS: readonly GridPosition[] = [{ x: 5, y: 4 }, { x: 7, y: 4 }, { x: 6, y: 6 }];

function participant(pubkey: string, registeredAt: number): TagGameParticipant {
	return { pubkey, runNumber: 1, registeredAt, status: 'registered', points: 0, lifespanLossMs: 0, benefitMs: 0, calamityMs: 0 };
}

function initialPresence(field: PresenceField, nowMs: number): PresenceState {
	const available: GridPosition[] = [];
	for (const requested of PREFERRED_POSITIONS) {
		const position = { x: Math.min(field.columns - 1, requested.x), y: Math.min(field.rows - 1, requested.y) };
		if (!isBlockedFacilityCell(position) && !available.some((entry) => entry.x === position.x && entry.y === position.y)) available.push(position);
	}
	for (let y = 0; y < field.rows; y += 1) for (let x = 0; x < field.columns; x += 1) {
		const position = { x, y };
		if (!isBlockedFacilityCell(position) && !available.some((entry) => entry.x === x && entry.y === y)) available.push(position);
	}
	const positions = DEV_TAG_GAME_ACTORS.map((_, index) => available[index]);
	return { field: { ...field }, participants: DEV_TAG_GAME_ACTORS.map((id, index) => ({ id: index === 0 ? DEV_TAG_GAME_SELF_ID : id, position: positions[index], lastActivityAt: nowMs, status: 'active' })) };
}

export class DevTagGamePlayground {
	private state: DevTagGamePlaygroundSnapshot;
	private lastAccruedAtMs: number | null = null;
	private soundSequence = 0;

	constructor(private readonly field: PresenceField, nowMs = Date.now()) {
		this.state = { game: null, presence: initialPresence(field, nowMs), nowMs, message: null, sound: null };
	}

	get snapshot(): DevTagGamePlaygroundSnapshot { return this.state; }

	private emit(effect: DevTagGameSound): void {
		this.state = { ...this.state, sound: { sequence: ++this.soundSequence, effect } };
	}

	private save(game: TagGameState | null, nowMs = this.state.nowMs, message: string | null = this.state.message): DevTagGamePlaygroundSnapshot {
		this.state = { ...this.state, game, nowMs, message };
		return this.state;
	}

	create(nowMs: number): DevTagGamePlaygroundSnapshot {
		if (this.state.game && this.state.game.phase !== 'ended' && this.state.game.phase !== 'interrupted') return this.state;
		this.lastAccruedAtMs = null;
		const second = Math.floor(nowMs / 1_000);
		return this.save({ gameId: `${DEV_TAG_GAME_SELF_PUBKEY}:${second}:${'e'.repeat(32)}`, hostPubkey: DEV_TAG_GAME_SELF_PUBKEY, phase: 'lobby', revision: 0, updatedAt: second, participant: [participant(DEV_TAG_GAME_SELF_PUBKEY, second)], settledAtMs: nowMs }, nowMs, 'ローカル募集を作成しました。');
	}

	addBots(nowMs: number): DevTagGamePlaygroundSnapshot {
		const game = this.state.game;
		if (!game || game.phase !== 'lobby') return this.state;
		const current = new Set(game.participant.map((member) => member.pubkey));
		const bots = DEV_TAG_GAME_ACTORS.slice(1).filter((pubkey) => !current.has(pubkey)).map((pubkey) => participant(pubkey, Math.floor(nowMs / 1_000)));
		return this.save({ ...game, revision: game.revision + 1, updatedAt: Math.floor(nowMs / 1_000), participant: [...game.participant, ...bots] }, nowMs, 'BOTが募集に参加しました。');
	}

	propose(nowMs: number): DevTagGamePlaygroundSnapshot {
		const game = this.state.game;
		if (!game || game.phase !== 'lobby' || game.hostPubkey !== DEV_TAG_GAME_SELF_PUBKEY || game.participant.length < 2) return this.save(game, nowMs, '参加者が2人以上になるまで開始を提案できません。');
		const proposed = { ...game, phase: 'proposed' as const, proposalId: PROPOSAL_ID, proposalDeadline: Math.floor((nowMs + 30_000) / 1_000), revision: game.revision + 1, updatedAt: Math.floor(nowMs / 1_000), participant: game.participant.map((member) => member.pubkey === game.hostPubkey ? { ...member, consentProposalId: PROPOSAL_ID, consented: true } : { ...member, consented: false }) };
		return this.save(proposed, nowMs, '開始を提案しました。BOTの同意を待っています。');
	}

	botConsent(nowMs: number): DevTagGamePlaygroundSnapshot {
		const game = this.state.game;
		if (!game || game.phase !== 'proposed' || game.participant.length < 2) return this.state;
		const countdownAt = Math.floor((nowMs + 5_000) / 1_000);
		const proposed = { ...game, phase: 'countdown' as const, startAt: countdownAt, revision: game.revision + 1, updatedAt: Math.floor(nowMs / 1_000), participant: game.participant.map((member) => ({ ...member, consentProposalId: game.proposalId, consented: true })) };
		return this.save(proposed, nowMs, 'BOTが同意しました。カウントダウンを開始します。');
	}

	private running(game: TagGameState, startedAt: number): TagGameState {
		return { ...game, phase: 'running', startedAt, endsAt: startedAt + TAG_GAME_GAME_MS / 1_000, startAt: startedAt, seed: SEED, ownerPubkey: DEV_TAG_GAME_SELF_PUBKEY, effect: createTagGameSchedule(SEED)[0].effect, transferAt: startedAt * 1_000, lastHolderResponseAtMs: startedAt * 1_000, settledAtMs: startedAt * 1_000, participant: game.participant.map((member) => ({ ...member, status: 'active', benefitMs: 0, calamityMs: 0, points: 0, lifespanLossMs: 0 })) };
	}

	private accrue(game: TagGameState, fromMs: number, untilMs: number): TagGameState {
		if (game.phase !== 'running' || !game.startedAt || !game.endsAt || untilMs <= fromMs) return game;
		const startMs = game.startedAt * 1_000;
		const endMs = Math.min(untilMs, game.endsAt * 1_000);
		const from = Math.max(fromMs, startMs);
		if (endMs <= from) return game;
		let owner = game.ownerPubkey;
		let boundary = 0;
		for (const interval of createTagGameSchedule(game.seed!)) {
			const intervalStart = startMs + boundary;
			const intervalEnd = intervalStart + interval.durationMs;
			boundary += interval.durationMs;
			const segmentStart = Math.max(from, intervalStart);
			const segmentEnd = Math.min(endMs, intervalEnd);
			if (segmentEnd <= segmentStart) continue;
			const activeDuration = segmentEnd - segmentStart;
			const member = game.participant.find((candidate) => candidate.pubkey === owner);
			if (member && interval.effect === 'benefit') {
				const total = Math.min(TAG_GAME_MAX_POINTS, Math.floor((member.benefitMs + activeDuration) * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1_000));
				const points = Math.max(0, total - member.points);
				game = { ...game, participant: game.participant.map((candidate) => candidate.pubkey === owner ? { ...candidate, benefitMs: Math.min(TAG_GAME_MAX_EFFECT_MS, candidate.benefitMs + activeDuration), points: Math.min(TAG_GAME_MAX_POINTS, candidate.points + points) } : candidate) };
			} else if (interval.effect === 'calamity') {
				const holder = game.participant.find((candidate) => candidate.pubkey === owner);
				if (holder) {
					const loss = Math.min(TAG_GAME_MAX_LIFESPAN_LOSS_MS, Math.floor((holder.calamityMs + activeDuration) * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1_000)) - Math.floor(holder.calamityMs * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1_000);
					game = { ...game, participant: game.participant.map((candidate) => candidate.pubkey === owner ? { ...candidate, calamityMs: Math.min(TAG_GAME_MAX_EFFECT_MS, candidate.calamityMs + activeDuration), lifespanLossMs: Math.min(TAG_GAME_MAX_LIFESPAN_LOSS_MS, candidate.lifespanLossMs + Math.max(0, loss)) } : candidate) };
				}
			}
			if (segmentEnd >= endMs) break;
		}
		return { ...game, settledAtMs: endMs, effect: tagGameScheduledEffectAt(game, Math.max(startMs, endMs - 1)) ?? game.effect };
	}

	advanceTo(targetMs: number): DevTagGamePlaygroundSnapshot {
		if (!Number.isSafeInteger(targetMs) || targetMs < this.state.nowMs) return this.state;
		let game = this.state.game;
		const previousEffect = game?.phase === 'running' ? tagGameScheduledEffectAt(game, Math.max(game.startedAt! * 1_000, this.state.nowMs - 1)) : null;
		if (game?.phase === 'countdown' && targetMs >= (game.startAt ?? 0) * 1_000) {
			game = this.running(game, game.startAt!);
			this.lastAccruedAtMs = game.startedAt! * 1_000;
			this.emit('tag-game-start');
		}
		if (game?.phase === 'running') {
			const until = Math.min(targetMs, game.endsAt! * 1_000);
			game = this.accrue(game, this.lastAccruedAtMs ?? game.settledAtMs, until);
			this.lastAccruedAtMs = until;
			if (until >= game.endsAt! * 1_000) {
				game = { ...game, phase: 'ended', revision: game.revision + 1, updatedAt: Math.floor(until / 1_000), settledAtMs: until, finalizedAt: Math.floor(until / 1_000), endReason: 'normal' };
				this.emit('tag-game-end');
			} else {
				const effect = tagGameScheduledEffectAt(game, targetMs);
				if (effect && previousEffect && effect !== previousEffect) this.emit('tag-game-switch');
			}
		}
		return this.save(game, targetMs, game?.phase === 'ended' ? 'ゲームが終了しました。ローカル表示用の累積値は確定しました。' : this.state.message);
	}

	moveBot(botPubkey: string, direction: Direction, nowMs: number): DevTagGamePlaygroundSnapshot {
		if (botPubkey !== DEV_TAG_GAME_BOT_A_ID && botPubkey !== DEV_TAG_GAME_BOT_B_ID) return this.state;
		const id = botPubkey;
		const moved = moveParticipant(this.state.presence, id, direction, nowMs);
		this.state = { ...this.state, presence: moved.state, nowMs };
		return this.state;
	}

	placeBot(botPubkey: string, position: GridPosition, nowMs: number): DevTagGamePlaygroundSnapshot {
		if (botPubkey !== DEV_TAG_GAME_BOT_A_ID && botPubkey !== DEV_TAG_GAME_BOT_B_ID) return this.state;
		this.state = { ...this.state, presence: debugSetParticipantPosition(this.state.presence, botPubkey, position), nowMs };
		return this.state;
	}

	moveSelf(direction: Direction, nowMs: number): DevTagGamePlaygroundSnapshot {
		const moved = moveParticipant(this.state.presence, DEV_TAG_GAME_SELF_ID, direction, nowMs);
		this.state = { ...this.state, presence: moved.state, nowMs };
		return this.state;
	}

	touch(actorPubkey: string, targetPubkey: string, nowMs: number): DevTagGamePlaygroundSnapshot {
		const advanced = this.advanceTo(nowMs);
		const game = advanced.game;
		if (!game || game.phase !== 'running' || !game.ownerPubkey || !game.startedAt || !game.seed) return this.save(game, nowMs, '試合中のみタッチできます。');
		const effect = tagGameScheduledEffectAt(game, nowMs);
		const actorAllowed = effect === 'benefit' ? actorPubkey !== game.ownerPubkey : actorPubkey === game.ownerPubkey;
		const targetAllowed = effect === 'benefit' ? targetPubkey === game.ownerPubkey : targetPubkey !== game.ownerPubkey;
		if (!effect || !actorAllowed || !targetAllowed) return this.save(game, nowMs, effect === 'benefit' ? '福のときは所持者以外が所持者を追いかけます。' : '鬼のときは所持者がほかの参加者を追いかけます。');
		if (isTagGameTransferCooldownActive({ transferAtMs: game.transferAt, startedAtMs: game.startedAt * 1_000, nowMs })) return this.save(game, nowMs, '転移クールダウン中です。');
		const actor = this.state.presence.participants.find((entry) => entry.id === (actorPubkey === DEV_TAG_GAME_SELF_PUBKEY ? DEV_TAG_GAME_SELF_ID : actorPubkey));
		const target = this.state.presence.participants.find((entry) => entry.id === (targetPubkey === DEV_TAG_GAME_SELF_PUBKEY ? DEV_TAG_GAME_SELF_ID : targetPubkey));
		if (!actor || !target || Math.max(Math.abs(actor.position.x - target.position.x), Math.abs(actor.position.y - target.position.y)) !== 1) return this.save(game, nowMs, 'タッチできる距離ではありません。');
		const next = { ...game, revision: game.revision + 1, updatedAt: Math.floor(nowMs / 1_000), ownerPubkey: effect === 'benefit' ? actorPubkey : targetPubkey, transferAt: nowMs, lastHolderResponseAtMs: nowMs, effect };
		this.emit('tag-game-transfer');
		return this.save(next, nowMs, '所持者が更新されました。転移クールダウンが始まりました。');
	}

	reset(nowMs = Date.now()): DevTagGamePlaygroundSnapshot {
		this.lastAccruedAtMs = null;
		this.state = { game: null, presence: initialPresence(this.field, nowMs), nowMs, message: null, sound: null };
		return this.state;
	}
}

export function createDevTagGamePlayground(field: PresenceField, nowMs?: number): DevTagGamePlayground {
	return new DevTagGamePlayground(field, nowMs);
}
