import {
	getContextCapacityMinutes,
	getHallucinationExtensionHundredths,
	getInferenceRateHundredths,
	type PersonaAbilityLevels
} from './personaGameState';
import {
	INFERENCE_ACCELERATION_BUDGET_MS,
	rootContextCompressionMultiplierTenths,
	rootInferenceAccelerationMultiplierTenths,
	rootMaximumLifespanMs,
	rootOverflowLifespanPercent,
	type RootBuild,
	ZERO_ROOT_BUILD
} from './rootProgression';

export const MENDING_HOUR_MS = 60 * 60 * 1000;
export const MENDING_MINUTE_MS = 60 * 1000;
export const POINT_PROGRESS_SCALE = 60_000_000;

export type MendingJob = Readonly<{
	startedAtMs: number;
	checkpointAtMs: number;
	processedDurationMs: number;
	unclaimedPoints: number;
}>;

export type MendingState = Readonly<{
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	inferenceAccelerationUsedMs: number;
	abilities: PersonaAbilityLevels;
	mendingJob: MendingJob | null;
}>;

export type MendingProjection = Readonly<{
	processedDurationMs: number;
	processedThroughMs: number;
	remainingDurationMs: number;
	regularDurationMs: number;
	overflowDurationMs: number;
	effectiveExpiresAtMs: number;
	lifespanExtensionMs: number;
	lifespanExtensionPerHour: Readonly<{ numerator: number; denominator: number }> | null;
	points: number;
	pointProgressTicks: number;
	nextPointRemainingMs: number | null;
	completed: boolean;
	accelerationMultiplierTenths: number;
	accelerationRemainingMs: number;
	contextCapacityMs: number;
	maximumLifespanMs: number;
	pointRateHundredthsPerMinute: number;
	lifespanExtensionRateHundredthsPerHour: number;
}>;

export type MendingSettlement = Readonly<{
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	inferenceAccelerationUsedMs: number;
	mendingJob: MendingJob;
}>;

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value);
}

function isSafeTimestamp(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

export function isValidPointProgressTicks(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0 && value < POINT_PROGRESS_SCALE;
}

export function isValidMendingJob(value: unknown): value is MendingJob {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return isSafeTimestamp(candidate.startedAtMs) && isSafeTimestamp(candidate.checkpointAtMs) &&
		(candidate.checkpointAtMs as number) >= (candidate.startedAtMs as number) &&
		isSafeInteger(candidate.processedDurationMs) && (candidate.processedDurationMs as number) >= 0 &&
		isSafeInteger(candidate.unclaimedPoints) && (candidate.unclaimedPoints as number) >= 0 &&
		(candidate.checkpointAtMs as number) <= Number.MAX_SAFE_INTEGER - (candidate.processedDurationMs as number);
}

/** Creates an empty bucket. Ability effects are intentionally not stored on it. */
export function createMendingJob(startedAtMs: number): MendingJob;
export function createMendingJob(_abilities: PersonaAbilityLevels, startedAtMs: number): MendingJob;
export function createMendingJob(first: number | PersonaAbilityLevels, second?: number): MendingJob {
	const startedAtMs = typeof first === 'number' ? first : second;
	if (!isSafeTimestamp(startedAtMs)) throw new TypeError('Invalid mending start time.');
	return { startedAtMs, checkpointAtMs: startedAtMs, processedDurationMs: 0, unclaimedPoints: 0 };
}

function addSafe(first: number, second: number): number {
	const result = BigInt(first) + BigInt(second);
	if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending timestamp is unsafe.');
	return Number(result);
}

function subtractSafe(first: number, second: number): number {
	return Math.max(0, first - second);
}

function multiplyDuration(durationMs: number, numerator: number, denominator: number): number {
	const value = BigInt(durationMs) * BigInt(numerator) / BigInt(denominator);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending result is unsafe.');
	return Number(value);
}

function pointSegment(pointProgressTicks: number, durationMs: number, rateHundredths: number, multiplierTenths: number): Readonly<{ points: number; pointProgressTicks: number }> {
	if (!isValidPointProgressTicks(pointProgressTicks) || !isSafeInteger(durationMs) || durationMs < 0) throw new TypeError('Invalid point progress.');
	const ticks = BigInt(pointProgressTicks) + BigInt(durationMs) * BigInt(rateHundredths) * BigInt(multiplierTenths);
	const points = ticks / BigInt(POINT_PROGRESS_SCALE);
	if (points > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending points are unsafe.');
	return { points: Number(points), pointProgressTicks: Number(ticks % BigInt(POINT_PROGRESS_SCALE)) };
}

function addPoints(first: number, second: number): number {
	const result = BigInt(first) + BigInt(second);
	if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending points are unsafe.');
	return Number(result);
}

function resolveAbilities(state: MendingState): PersonaAbilityLevels {
	return state.abilities;
}

function applyExtension(expiry: number, segmentEndMs: number, durationMs: number, rateHundredths: number, maximumLifespanMs: number): Readonly<{ expiry: number; extension: number }> {
	if (durationMs <= 0 || rateHundredths <= 0) return { expiry, extension: 0 };
	const raw = multiplyDuration(durationMs, rateHundredths, 100);
	const cap = addSafe(segmentEndMs, maximumLifespanMs);
	const available = Math.max(0, cap - expiry);
	const extension = Math.min(raw, available);
	return { expiry: addSafe(expiry, extension), extension };
}

function segmentEnd(checkpointAtMs: number, elapsedBeforeMs: number, durationMs: number): number {
	return addSafe(checkpointAtMs, elapsedBeforeMs + durationMs);
}

/** Projects only the time since the persisted checkpoint using current abilities. */
export function projectMending(state: MendingState, nowMs: number, rootBuild: RootBuild = ZERO_ROOT_BUILD): MendingProjection {
	if (!isSafeTimestamp(nowMs) || !isValidPointProgressTicks(state.pointProgressTicks) || !isValidRootBuildForProjection(rootBuild)) throw new TypeError('Invalid mending input.');
	if (!state.mendingJob) return {
		processedDurationMs: 0,
		processedThroughMs: nowMs,
		remainingDurationMs: 0,
		regularDurationMs: 0,
		overflowDurationMs: 0,
		effectiveExpiresAtMs: state.lifespanExpiresAtMs,
		lifespanExtensionMs: 0,
		lifespanExtensionPerHour: null,
		points: 0,
		pointProgressTicks: state.pointProgressTicks,
		nextPointRemainingMs: null,
		completed: false,
		accelerationMultiplierTenths: 10,
		accelerationRemainingMs: 0,
		contextCapacityMs: 0,
		maximumLifespanMs: rootMaximumLifespanMs(rootBuild.hallucinationResistance),
		pointRateHundredthsPerMinute: getInferenceRateHundredths(state.abilities.inferenceEfficiency),
		lifespanExtensionRateHundredthsPerHour: getHallucinationExtensionHundredths(state.abilities.hallucinationSuppression)
	};
	if (!isValidMendingJob(state.mendingJob)) throw new TypeError('Invalid mending job.');
	const job = state.mendingJob;
	const abilities = resolveAbilities(state);
	const elapsedMs = Math.max(0, nowMs - job.checkpointAtMs);
	const contextCapacityMs = getContextCapacityMinutes(abilities.contextCapacity) * MENDING_MINUTE_MS * rootContextCompressionMultiplierTenths(rootBuild.contextCompression) / 10;
	const processedDurationMs = Math.min(contextCapacityMs, job.processedDurationMs + elapsedMs);
	const regularDurationMs = Math.max(0, processedDurationMs - job.processedDurationMs);
	const overflowDurationMs = elapsedMs - regularDurationMs;
	const usedMs = Math.min(INFERENCE_ACCELERATION_BUDGET_MS, state.inferenceAccelerationUsedMs);
	const accelerationRemainingMs = Math.max(0, INFERENCE_ACCELERATION_BUDGET_MS - usedMs);
	const acceleratedDurationMs = Math.min(regularDurationMs, accelerationRemainingMs);
	const normalDurationMs = regularDurationMs - acceleratedDurationMs;
	const baseRate = getInferenceRateHundredths(abilities.inferenceEfficiency);
	const accelerationMultiplierTenths = rootInferenceAccelerationMultiplierTenths(rootBuild.inferenceAcceleration);
	let progressTicks = state.pointProgressTicks;
	let generatedPoints = 0;
	for (const segment of [[acceleratedDurationMs, accelerationMultiplierTenths], [normalDurationMs, 10]] as const) {
		const result = pointSegment(progressTicks, segment[0], baseRate, segment[1]);
		generatedPoints = addPoints(generatedPoints, result.points);
		progressTicks = result.pointProgressTicks;
	}
	let expiry = state.lifespanExpiresAtMs;
	let extension = 0;
	const regularRate = getHallucinationExtensionHundredths(abilities.hallucinationSuppression);
	const currentPointRateHundredthsPerMinute = processedDurationMs >= contextCapacityMs ? 0 : state.inferenceAccelerationUsedMs + regularDurationMs < INFERENCE_ACCELERATION_BUDGET_MS ? baseRate * accelerationMultiplierTenths / 10 : baseRate;
	const currentLifespanExtensionRateHundredthsPerHour = processedDurationMs >= contextCapacityMs ? regularRate * rootOverflowLifespanPercent(rootBuild.contextCompression) / 100 : regularRate;
	for (const [durationMs, rateHundredths, offset] of [
		[acceleratedDurationMs, regularRate, 0],
		[normalDurationMs, regularRate, acceleratedDurationMs],
		[overflowDurationMs, regularRate * rootOverflowLifespanPercent(rootBuild.contextCompression) / 100, regularDurationMs]
	] as const) {
		const result = applyExtension(expiry, segmentEnd(job.checkpointAtMs, offset, durationMs), durationMs, rateHundredths, rootMaximumLifespanMs(rootBuild.hallucinationResistance));
		expiry = result.expiry;
		extension = addPoints(extension, result.extension);
	}
	const totalUnclaimedPoints = addPoints(job.unclaimedPoints, generatedPoints);
	const nextPointRemainingMs = processedDurationMs >= contextCapacityMs || progressTicks === POINT_PROGRESS_SCALE - 1
		? null
		: Math.max(1, Math.ceil((POINT_PROGRESS_SCALE - progressTicks) / (baseRate * (acceleratedDurationMs < regularDurationMs ? 10 : accelerationMultiplierTenths))));
	return {
		processedDurationMs,
		processedThroughMs: addSafe(job.checkpointAtMs, elapsedMs),
		remainingDurationMs: Math.max(0, contextCapacityMs - processedDurationMs),
		regularDurationMs,
		overflowDurationMs,
		effectiveExpiresAtMs: expiry,
		lifespanExtensionMs: extension,
		lifespanExtensionPerHour: { numerator: currentLifespanExtensionRateHundredthsPerHour, denominator: 100 },
		points: totalUnclaimedPoints,
		pointProgressTicks: progressTicks,
		nextPointRemainingMs,
		completed: processedDurationMs >= contextCapacityMs,
		accelerationMultiplierTenths,
		accelerationRemainingMs: Math.max(0, accelerationRemainingMs - acceleratedDurationMs),
		contextCapacityMs,
		maximumLifespanMs: rootMaximumLifespanMs(rootBuild.hallucinationResistance),
		pointRateHundredthsPerMinute: currentPointRateHundredthsPerMinute,
		lifespanExtensionRateHundredthsPerHour: currentLifespanExtensionRateHundredthsPerHour
	};
}

function isValidRootBuildForProjection(value: RootBuild): boolean {
	return Number.isSafeInteger(value.inferenceAcceleration) && value.inferenceAcceleration >= 0 && value.inferenceAcceleration <= 3 &&
		Number.isSafeInteger(value.contextCompression) && value.contextCompression >= 0 && value.contextCompression <= 3 &&
		Number.isSafeInteger(value.hallucinationResistance) && value.hallucinationResistance >= 0 && value.hallucinationResistance <= 3;
}

export function isMendingExpired(state: MendingState, nowMs: number, rootBuild: RootBuild = ZERO_ROOT_BUILD): boolean {
	return nowMs >= projectMending(state, nowMs, rootBuild).effectiveExpiresAtMs;
}

/** Settles the checkpoint. Collection transfers unclaimed points; checkpointing alone does not. */
export function settleMending(state: MendingState, nowMs: number, rootBuild: RootBuild = ZERO_ROOT_BUILD, collect = false): MendingSettlement | null {
	if (!state.mendingJob) throw new TypeError('No mending job exists.');
	const projection = projectMending(state, nowMs, rootBuild);
	if (projection.regularDurationMs + projection.overflowDurationMs <= 0) return null;
	const ownedPoints = collect ? addPoints(state.points, projection.points) : state.points;
	return {
		lifespanExpiresAtMs: projection.effectiveExpiresAtMs,
		points: ownedPoints,
		pointProgressTicks: projection.pointProgressTicks,
		inferenceAccelerationUsedMs: Math.min(INFERENCE_ACCELERATION_BUDGET_MS, state.inferenceAccelerationUsedMs + projection.regularDurationMs),
		mendingJob: {
			startedAtMs: collect ? nowMs : state.mendingJob.startedAtMs,
			checkpointAtMs: nowMs,
			processedDurationMs: collect ? 0 : projection.processedDurationMs,
			unclaimedPoints: collect ? 0 : projection.points
		}
	};
}

export function materializeMending(state: MendingState, nowMs: number, rootBuild: RootBuild = ZERO_ROOT_BUILD): MendingSettlement | null {
	return settleMending(state, nowMs, rootBuild, true);
}
