import { MAX_LIFESPAN_MS, type PersonaAbilityLevels } from './personaGameState';

export const MENDING_HOUR_MS = 60 * 60 * 1000;

export type MendingRational = Readonly<{ numerator: number; denominator: number }>;

export type MendingJob = Readonly<{
	startedAtMs: number;
	maximumDurationMs: number;
	lifespanExtensionPerHour: MendingRational;
	pointsPerHour: MendingRational;
}>;

export type MendingState = Readonly<{
	lifespanExpiresAtMs: number;
	mendingJob: MendingJob | null;
}>;

export type MendingProjection = Readonly<{
	processedDurationMs: number;
	processedThroughMs: number;
	effectiveExpiresAtMs: number;
	points: number;
	completed: boolean;
}>;

const LIFESPAN_EXTENSION_BY_LEVEL: readonly MendingRational[] = [
	{ numerator: 4, denominator: 5 }, { numerator: 9, denominator: 10 }, { numerator: 1, denominator: 1 },
	{ numerator: 11, denominator: 10 }, { numerator: 5, denominator: 4 }
];
const MAXIMUM_DURATION_BY_LEVEL = [8, 12, 18, 24].map((hours) => hours * MENDING_HOUR_MS);
const POINTS_BY_LEVEL: readonly MendingRational[] = [
	{ numerator: 1, denominator: 1 }, { numerator: 11, denominator: 10 }, { numerator: 6, denominator: 5 },
	{ numerator: 27, denominator: 20 }, { numerator: 3, denominator: 2 }
];

function copyRational(value: MendingRational): MendingRational {
	return { numerator: value.numerator, denominator: value.denominator };
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
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
		!isValidMendingRational(candidate.lifespanExtensionPerHour) || !isValidMendingRational(candidate.pointsPerHour)) return false;
	const matchesRate = (rate: MendingRational, candidates: readonly MendingRational[]) => candidates.some((candidate) =>
		candidate.numerator === rate.numerator && candidate.denominator === rate.denominator
	);
	return candidate.startedAtMs <= Number.MAX_SAFE_INTEGER - candidate.maximumDurationMs &&
		MAXIMUM_DURATION_BY_LEVEL.includes(candidate.maximumDurationMs) &&
		matchesRate(candidate.lifespanExtensionPerHour, LIFESPAN_EXTENSION_BY_LEVEL) &&
		matchesRate(candidate.pointsPerHour, POINTS_BY_LEVEL);
}

/** Resolves and snapshots the current ability effect when a job starts. */
export function createMendingJob(abilities: PersonaAbilityLevels, startedAtMs: number): MendingJob {
	if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) throw new TypeError('Invalid mending start time.');
	const maximumDurationMs = MAXIMUM_DURATION_BY_LEVEL[abilities.contextCapacity];
	const lifespanExtensionPerHour = LIFESPAN_EXTENSION_BY_LEVEL[abilities.inferenceEfficiency];
	const pointsPerHour = POINTS_BY_LEVEL[abilities.hallucinationSuppression];
	if (!maximumDurationMs || !lifespanExtensionPerHour || !pointsPerHour) throw new TypeError('Invalid ability levels.');
	return { startedAtMs, maximumDurationMs, lifespanExtensionPerHour: copyRational(lifespanExtensionPerHour), pointsPerHour: copyRational(pointsPerHour) };
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

/** The sole persisted-state-to-lifespan projection, including the fourteen-day cap. */
export function projectMending(state: MendingState, nowMs: number): MendingProjection {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid mending time.');
	if (!state.mendingJob) return {
		processedDurationMs: 0,
		processedThroughMs: nowMs,
		effectiveExpiresAtMs: state.lifespanExpiresAtMs,
		points: 0,
		completed: false
	};
	const job = state.mendingJob;
	const processedDurationMs = Math.min(Math.max(nowMs - job.startedAtMs, 0), job.maximumDurationMs);
	const processedThroughMs = addSafe(job.startedAtMs, processedDurationMs);
	const effectiveExpiresAtMs = Math.min(
		addSafe(state.lifespanExpiresAtMs, integerExtensionMs(processedDurationMs, job.lifespanExtensionPerHour)),
		addSafe(processedThroughMs, MAX_LIFESPAN_MS)
	);
	const points = processedDurationMs / MENDING_HOUR_MS * job.pointsPerHour.numerator / job.pointsPerHour.denominator;
	return { processedDurationMs, processedThroughMs, effectiveExpiresAtMs, points, completed: processedDurationMs === job.maximumDurationMs };
}

export function isMendingExpired(state: MendingState, nowMs: number): boolean {
	return nowMs >= projectMending(state, nowMs).effectiveExpiresAtMs;
}

export function materializeCompletedMending(state: MendingState): Readonly<{ lifespanExpiresAtMs: number; points: number }> {
	if (!state.mendingJob) throw new TypeError('No mending job exists.');
	const completedAtMs = state.mendingJob.startedAtMs + state.mendingJob.maximumDurationMs;
	const projection = projectMending(state, completedAtMs);
	return { lifespanExpiresAtMs: projection.effectiveExpiresAtMs, points: projection.points };
}
