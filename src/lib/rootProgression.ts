export const BASE_INITIAL_LIFESPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const ROOT_ABILITY_RANK_LIMIT = 3;
export const ROOT_POINT_USABLE_CAP = 9;
export const INFERENCE_ACCELERATION_BUDGET_MS = 24 * 60 * 60 * 1000;

export type RootBuild = Readonly<{
	inferenceAcceleration: number;
	contextCompression: number;
	hallucinationResistance: number;
}>;

export const ZERO_ROOT_BUILD: RootBuild = {
	inferenceAcceleration: 0,
	contextCompression: 0,
	hallucinationResistance: 0
};

const INFERENCE_ACCELERATION_MULTIPLIERS_TENTHS = [10, 20, 30, 40] as const;
const CONTEXT_COMPRESSION_MULTIPLIERS_TENTHS = [10, 20, 30, 40] as const;
const OVERFLOW_REWARD_PERCENT = [0, 20, 35, 50] as const;
const MAXIMUM_LIFESPAN_DAYS = [7, 14, 21, 30] as const;

function isRank(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= ROOT_ABILITY_RANK_LIMIT;
}

export function isValidRootBuild(value: unknown): value is RootBuild {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isRank(candidate.inferenceAcceleration) && isRank(candidate.contextCompression) && isRank(candidate.hallucinationResistance) &&
		(candidate.inferenceAcceleration as number) + (candidate.contextCompression as number) + (candidate.hallucinationResistance as number) <= ROOT_POINT_USABLE_CAP;
}

export function rootBuildCost(build: RootBuild): number {
	if (!isValidRootBuild(build)) throw new TypeError('Invalid Root build.');
	return build.inferenceAcceleration + build.contextCompression + build.hallucinationResistance;
}

export function usableRootPoints(rootPoints: number): number {
	if (!Number.isSafeInteger(rootPoints) || rootPoints < 0) throw new TypeError('Invalid Root Points.');
	return Math.min(rootPoints, ROOT_POINT_USABLE_CAP);
}

export function isRootBuildAllocatable(build: RootBuild, rootPoints: number): boolean {
	return isValidRootBuild(build) && rootBuildCost(build) === usableRootPoints(rootPoints);
}

export function rootInferenceAccelerationMultiplierTenths(rank: number): number {
	if (!isRank(rank)) throw new TypeError('Invalid Root rank.');
	return INFERENCE_ACCELERATION_MULTIPLIERS_TENTHS[rank];
}

export function rootContextCompressionMultiplierTenths(rank: number): number {
	if (!isRank(rank)) throw new TypeError('Invalid Root rank.');
	return CONTEXT_COMPRESSION_MULTIPLIERS_TENTHS[rank];
}

export function rootOverflowRewardPercent(rank: number): number {
	if (!isRank(rank)) throw new TypeError('Invalid Root rank.');
	return OVERFLOW_REWARD_PERCENT[rank];
}

export function rootMaximumLifespanMs(rank: number): number {
	if (!isRank(rank)) throw new TypeError('Invalid Root rank.');
	return MAXIMUM_LIFESPAN_DAYS[rank] * 24 * 60 * 60 * 1000;
}
