import {
	createTagGameSchedule,
	TAG_GAME_BENEFIT_POINTS_PER_SECOND,
	TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND,
	TAG_GAME_MAX_LIFESPAN_LOSS_MS,
	TAG_GAME_MAX_POINTS,
	type TagGameParticipant,
	type TagGameState
} from './tagGame';

export type TagGameHudProjectionInput = Readonly<{
	game: TagGameState | null;
	selfPubkey: string | null;
	selfRunNumber: number | null;
	localLockGameId: string | null;
	localAppliedPoints: number;
	localAppliedLossMs: number;
	savedPoints: number;
	effectiveExpiresAtMs: number;
	nowMs: number;
}>;

export type TagGameHudProjection = Readonly<{
	points: number;
	expiresAtMs: number;
	confirmedPointsNotSaved: number;
	confirmedLossNotSavedMs: number;
	predictedPoints: number;
	predictedLossMs: number;
	benefitRateActive: boolean;
	calamityRateActive: boolean;
}>;

export function isOrganizerConfirmedTagGameEffectCurrent(game: TagGameState, nowMs: number): boolean {
	if (game.phase !== 'running' || !game.seed || game.seed.length > 256 || game.startedAt === undefined || game.endsAt === undefined ||
		nowMs < game.startedAt * 1000 || nowMs >= game.endsAt * 1000) return false;
	const elapsed = nowMs - game.startedAt * 1000;
	let boundary = 0;
	const interval = createTagGameSchedule(game.seed).find((entry) => {
		boundary += entry.durationMs;
		return elapsed < boundary;
	});
	return interval?.effect === game.effect;
}

export function projectTagGameHud(input: TagGameHudProjectionInput): TagGameHudProjection {
	const empty = {
		points: input.savedPoints,
		expiresAtMs: input.effectiveExpiresAtMs,
		confirmedPointsNotSaved: 0,
		confirmedLossNotSavedMs: 0,
		predictedPoints: 0,
		predictedLossMs: 0,
		benefitRateActive: false,
		calamityRateActive: false
	};
	const game = input.game;
	if (!game || !input.selfPubkey || input.selfRunNumber === null) return empty;
	const own = game.participant.find((member) => member.pubkey === input.selfPubkey && member.runNumber === input.selfRunNumber);
	if (!own) return empty;

	const hasMatchingLocalLock = input.localLockGameId === game.gameId;
	const confirmedPointsNotSaved = Math.max(0, own.points - (hasMatchingLocalLock ? input.localAppliedPoints : 0));
	const confirmedLossNotSavedMs = Math.max(0, own.lifespanLossMs - (hasMatchingLocalLock ? input.localAppliedLossMs : 0));
	let predictedPoints = 0;
	let predictedLossMs = 0;
	let benefitRateActive = false;
	let calamityRateActive = false;

	if (game.phase === 'running' && game.seed && game.seed.length <= 256 && game.startedAt !== undefined && game.endsAt !== undefined &&
		!game.holderChallengeId && game.ownerPubkey === input.selfPubkey && own.status === 'active' &&
		input.nowMs >= game.settledAtMs && input.nowMs < game.endsAt * 1000) {
		const schedule = createTagGameSchedule(game.seed);
		let boundary = 0;
		const elapsedAtCheckpoint = game.settledAtMs - game.startedAt * 1000;
		const currentInterval = schedule.find((interval) => {
			boundary += interval.durationMs;
			return elapsedAtCheckpoint < boundary;
		});
		// The signed effect is authoritative. If its scheduled switch has passed but
		// the organizer has not confirmed the next state, stop projecting here.
		if (currentInterval?.effect === game.effect) {
			const intervalEnd = game.startedAt * 1000 + boundary;
			const until = Math.min(input.nowMs, game.endsAt * 1000, intervalEnd);
			const duration = Math.max(0, until - game.settledAtMs);
			if (duration > 0 && game.effect === 'benefit') {
				const projectedCumulative = Math.min(TAG_GAME_MAX_POINTS,
					Math.floor((own.benefitMs + duration) * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1000));
				predictedPoints = Math.max(0, projectedCumulative - own.points);
				benefitRateActive = input.nowMs < intervalEnd;
			} else if (duration > 0 && game.effect === 'calamity') {
				const projectedCumulative = Math.min(TAG_GAME_MAX_LIFESPAN_LOSS_MS,
					Math.floor((own.calamityMs + duration) * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1000));
				predictedLossMs = Math.max(0, projectedCumulative - own.lifespanLossMs);
				calamityRateActive = input.nowMs < intervalEnd;
			}
		}
	}

	return {
		points: input.savedPoints + confirmedPointsNotSaved + predictedPoints,
		expiresAtMs: input.effectiveExpiresAtMs - confirmedLossNotSavedMs - predictedLossMs,
		confirmedPointsNotSaved,
		confirmedLossNotSavedMs,
		predictedPoints,
		predictedLossMs,
		benefitRateActive,
		calamityRateActive
	};
}

export function formatTagGameRemainingTime(endsAtMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.ceil((endsAtMs - nowMs) / 1000));
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function tagGameTransferStatus(game: TagGameState, effectActive: boolean, nowMs: number): string {
	const cooldownSeconds = Math.max(0, Math.ceil(((game.transferAt ?? 0) + 3_000 - nowMs) / 1_000));
	if (cooldownSeconds > 0) return `転移禁止 ${cooldownSeconds}秒`;
	if (game.phase === 'settling' || (game.phase === 'running' && game.endsAt !== undefined && nowMs >= game.endsAt * 1_000)) return '最終精算中';
	if (game.phase !== 'running') return '転移不可';
	return effectActive ? '転移禁止なし' : '効果停止中';
}

export function canLeaveTagGame(game: TagGameState, memberStatus: TagGameParticipant['status'] | undefined, nowMs: number): boolean {
	return game.phase === 'running' && game.endsAt !== undefined && nowMs < game.endsAt * 1_000 &&
		(memberStatus === 'active' || memberStatus === 'temporarily-ineligible');
}
