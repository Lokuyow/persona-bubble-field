import { MAX_LIFESPAN_MS, type PersonaAbilityLevels } from './personaGameState';

export const MENDING_HOUR_MS = 60 * 60 * 1000;
export const POINT_PROGRESS_SCALE = 1_188_000_000;

export type MendingRational = Readonly<{ numerator: number; denominator: number }>;

export type MendingJob = Readonly<{
	startedAtMs: number;
	maximumDurationMs: number;
	lifespanExtensionPerHour: MendingRational;
	pointIntervalMs: number;
}>;

export type MendingState = Readonly<{
	lifespanExpiresAtMs: number;
	pointProgressTicks: number;
	mendingJob: MendingJob | null;
}>;

export type MendingProjection = Readonly<{
	processedDurationMs: number;
	processedThroughMs: number;
	remainingDurationMs: number;
	effectiveExpiresAtMs: number;
	lifespanExtensionMs: number;
	lifespanExtensionPerHour: MendingRational | null;
	points: number;
	pointProgressTicks: number;
	nextPointRemainingMs: number | null;
	completed: boolean;
}>;

const LIFESPAN_EXTENSION_BY_LEVEL: readonly MendingRational[] = [
	{ numerator: 4, denominator: 5 }, { numerator: 9, denominator: 10 }, { numerator: 1, denominator: 1 },
	{ numerator: 11, denominator: 10 }, { numerator: 5, denominator: 4 }
];
const MAXIMUM_DURATION_BY_LEVEL = [8, 12, 18, 24].map((hours) => hours * MENDING_HOUR_MS);
const POINT_INTERVAL_BY_LEVEL = [60, 55, 50, 45, 40].map((minutes) => minutes * 60 * 1000);
const POINT_TICKS_PER_MS_BY_INTERVAL = new Map(POINT_INTERVAL_BY_LEVEL.map((intervalMs) => [intervalMs, POINT_PROGRESS_SCALE / intervalMs]));

function copyRational(value: MendingRational): MendingRational {
	return { numerator: value.numerator, denominator: value.denominator };
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidPointProgressTicks(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < POINT_PROGRESS_SCALE;
}

export function isValidMendingRational(value: unknown): value is MendingRational {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Readonly<Record<string, unknown>>;
	return isPositiveSafeInteger(candidate.numerator) && isPositiveSafeInteger(candidate.denominator);
}

export function isValidMendingJob(value: unknown): value is MendingJob {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Readonly<Record<string, unknown>>;
	if (!isSafeTimestamp(candidate.startedAtMs) || !isPositiveSafeInteger(candidate.maximumDurationMs) ||
		!isValidMendingRational(candidate.lifespanExtensionPerHour) || !isPositiveSafeInteger(candidate.pointIntervalMs)) return false;
	const matchesRate = (rate: MendingRational, candidates: readonly MendingRational[]) => candidates.some((candidate) =>
		candidate.numerator === rate.numerator && candidate.denominator === rate.denominator
	);
	return candidate.startedAtMs <= Number.MAX_SAFE_INTEGER - candidate.maximumDurationMs &&
		MAXIMUM_DURATION_BY_LEVEL.includes(candidate.maximumDurationMs) &&
		matchesRate(candidate.lifespanExtensionPerHour, LIFESPAN_EXTENSION_BY_LEVEL) &&
		POINT_TICKS_PER_MS_BY_INTERVAL.has(candidate.pointIntervalMs);
}

/** Resolves and snapshots the current ability effect when a job starts. */
export function createMendingJob(abilities: PersonaAbilityLevels, startedAtMs: number): MendingJob {
	if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new TypeError('Invalid mending start time.');
	const maximumDurationMs = MAXIMUM_DURATION_BY_LEVEL[abilities.contextCapacity];
	const lifespanExtensionPerHour = LIFESPAN_EXTENSION_BY_LEVEL[abilities.inferenceEfficiency];
	const pointIntervalMs = POINT_INTERVAL_BY_LEVEL[abilities.hallucinationSuppression];
	if (!maximumDurationMs || !lifespanExtensionPerHour || !pointIntervalMs) throw new TypeError('Invalid ability levels.');
	return { startedAtMs, maximumDurationMs, lifespanExtensionPerHour: copyRational(lifespanExtensionPerHour), pointIntervalMs };
}

function integerExtensionMs(durationMs: number, rate: MendingRational): number {
	const extension = BigInt(durationMs) * BigInt(rate.numerator) / BigInt(rate.denominator);
	if (extension > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending extension is unsafe.');
	return Number(extension);
}

function addSafe(first: number, second: number): number {
	const result = BigInt(first) + BigInt(second);
	if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending timestamp is unsafe.');
	return Number(result);
}

function pointProjection(progressTicks: number, processedDurationMs: number, pointIntervalMs: number): Readonly<{ points: number; pointProgressTicks: number }> {
	const ticksPerMs = POINT_TICKS_PER_MS_BY_INTERVAL.get(pointIntervalMs);
	if (!ticksPerMs || !isValidPointProgressTicks(progressTicks)) throw new TypeError('Invalid point progress.');
	const totalTicks = BigInt(progressTicks) + BigInt(processedDurationMs) * BigInt(ticksPerMs);
	const points = totalTicks / BigInt(POINT_PROGRESS_SCALE);
	if (points > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Mending points are unsafe.');
	return { points: Number(points), pointProgressTicks: Number(totalTicks % BigInt(POINT_PROGRESS_SCALE)) };
}

function remainingPointMs(pointProgressTicks: number, pointIntervalMs: number, completed: boolean): number | null {
	if (completed) return null;
	const ticksPerMs = POINT_TICKS_PER_MS_BY_INTERVAL.get(pointIntervalMs);
	if (!ticksPerMs) throw new TypeError('Invalid point interval.');
	return Math.ceil((POINT_PROGRESS_SCALE - pointProgressTicks) / ticksPerMs);
}

/** The sole persisted-state-to-lifespan projection, including the fourteen-day cap. */
export function projectMending(state: MendingState, nowMs: number): MendingProjection {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid mending time.');
	if (!state.mendingJob) return {
		processedDurationMs: 0,
		processedThroughMs: nowMs,
		remainingDurationMs: 0,
		effectiveExpiresAtMs: state.lifespanExpiresAtMs,
		lifespanExtensionMs: 0,
		lifespanExtensionPerHour: null,
		points: 0,
		pointProgressTicks: state.pointProgressTicks,
		nextPointRemainingMs: null,
		completed: false
	};
	const job = state.mendingJob;
	const processedDurationMs = Math.min(Math.max(nowMs - job.startedAtMs, 0), job.maximumDurationMs);
	const processedThroughMs = addSafe(job.startedAtMs, processedDurationMs);
	const effectiveExpiresAtMs = Math.min(
		addSafe(state.lifespanExpiresAtMs, integerExtensionMs(processedDurationMs, job.lifespanExtensionPerHour)),
		addSafe(processedThroughMs, MAX_LIFESPAN_MS)
	);
	const pointProjectionResult = pointProjection(state.pointProgressTicks, processedDurationMs, job.pointIntervalMs);
	return {
		processedDurationMs,
		processedThroughMs,
		remainingDurationMs: job.maximumDurationMs - processedDurationMs,
		effectiveExpiresAtMs,
		lifespanExtensionMs: effectiveExpiresAtMs - state.lifespanExpiresAtMs,
		lifespanExtensionPerHour: copyRational(job.lifespanExtensionPerHour),
		points: pointProjectionResult.points,
		pointProgressTicks: pointProjectionResult.pointProgressTicks,
		nextPointRemainingMs: remainingPointMs(pointProjectionResult.pointProgressTicks, job.pointIntervalMs, processedDurationMs === job.maximumDurationMs),
		completed: processedDurationMs === job.maximumDurationMs
	};
}

export function isMendingExpired(state: MendingState, nowMs: number): boolean {
	return nowMs >= projectMending(state, nowMs).effectiveExpiresAtMs;
}

export function materializeMending(state: MendingState & Readonly<{ abilities: PersonaAbilityLevels; points: number }>, nowMs: number): Readonly<{
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	mendingJob: MendingJob;
}> | null {
	if (!state.mendingJob) throw new TypeError('No mending job exists.');
	const projection = projectMending(state, nowMs);
	if (projection.processedDurationMs <= 0) return null;
	const points = addSafe(state.points, projection.points);
	return {
		lifespanExpiresAtMs: projection.effectiveExpiresAtMs,
		points,
		pointProgressTicks: projection.pointProgressTicks,
		mendingJob: createMendingJob(state.abilities, nowMs)
	};
}
