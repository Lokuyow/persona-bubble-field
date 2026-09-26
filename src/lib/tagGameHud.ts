import {
	createTagGameSchedule,
	tagGameScheduledEffectAt,
	TAG_GAME_BENEFIT_POINTS_PER_SECOND,
	TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND,
	TAG_GAME_MAX_LIFESPAN_LOSS_MS,
	TAG_GAME_MAX_POINTS,
	TAG_GAME_TRANSFER_COOLDOWN_MS,
	isTagGameTransferCooldownActive,
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
	holderActivityAtMs?: number;
	/** Organizer-local safety stop; never inferred by other participants. */
	effectPausedAtMs?: number;
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

export function isTagGameScheduledEffectActive(game: TagGameState, nowMs: number): boolean {
	return tagGameScheduledEffectAt(game, nowMs) !== null;
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
		const holderActivityAtMs = input.holderActivityAtMs ?? Math.max(game.startedAt * 1_000, game.transferAt ?? 0, game.lastHolderResponseAtMs ?? 0);
		const until = Math.min(input.nowMs, game.endsAt * 1000, holderActivityAtMs + 23_000,
			input.effectPausedAtMs ?? Number.POSITIVE_INFINITY);
		let cursor = Math.max(game.settledAtMs, game.startedAt * 1_000);
		let boundary = 0;
		let benefitDurationMs = 0;
		let calamityDurationMs = 0;
		for (const interval of schedule) {
			const intervalStart = game.startedAt * 1_000 + boundary;
			boundary += interval.durationMs;
			const intervalEnd = game.startedAt * 1_000 + boundary;
			const duration = Math.max(0, Math.min(until, intervalEnd) - Math.max(cursor, intervalStart));
			if (interval.effect === 'benefit') benefitDurationMs += duration;
			else calamityDurationMs += duration;
		}
		if (benefitDurationMs > 0) {
			const projectedCumulative = Math.min(TAG_GAME_MAX_POINTS,
				Math.floor((own.benefitMs + benefitDurationMs) * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1000));
			predictedPoints = Math.max(0, projectedCumulative - own.points);
		}
		if (calamityDurationMs > 0) {
			const projectedCumulative = Math.min(TAG_GAME_MAX_LIFESPAN_LOSS_MS,
				Math.floor((own.calamityMs + calamityDurationMs) * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1000));
			predictedLossMs = Math.max(0, projectedCumulative - own.lifespanLossMs);
		}
		const currentEffect = tagGameScheduledEffectAt(game, input.nowMs);
		const beforeLocalStop = input.effectPausedAtMs === undefined || input.nowMs < input.effectPausedAtMs;
		benefitRateActive = currentEffect === 'benefit' && input.nowMs < holderActivityAtMs + 23_000 && beforeLocalStop;
		calamityRateActive = currentEffect === 'calamity' && input.nowMs < holderActivityAtMs + 23_000 && beforeLocalStop;
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
	if (game.phase === 'settling' || (game.phase === 'running' && game.endsAt !== undefined && nowMs >= game.endsAt * 1_000)) return '最終精算中';
	if (game.phase !== 'running') return '転移不可';
	if (!effectActive) return '効果停止中';
	return '';
}

export function tagGameCooldownRemainingMs(game: TagGameState, effectActive: boolean, nowMs: number): number {
	if (game.phase !== 'running' || game.startedAt === undefined || !effectActive || game.endsAt === undefined || nowMs >= game.endsAt * 1_000) return 0;
	const transferredAtMs = game.transferAt ?? game.startedAt * 1_000;
	return isTagGameTransferCooldownActive({ transferAtMs: game.transferAt, startedAtMs: game.startedAt * 1_000, nowMs })
		? Math.max(0, transferredAtMs + TAG_GAME_TRANSFER_COOLDOWN_MS - nowMs)
		: 0;
}

export function canLeaveTagGame(game: TagGameState, memberStatus: TagGameParticipant['status'] | undefined, nowMs: number): boolean {
	return game.phase === 'running' && game.endsAt !== undefined && nowMs < game.endsAt * 1_000 &&
		(memberStatus === 'active' || memberStatus === 'temporarily-ineligible');
}
