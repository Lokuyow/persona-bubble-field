import { getContextCapacityMinutes, getHallucinationExtensionHundredths } from './personaGameState';
import { INFERENCE_ACCELERATION_BUDGET_MS, rootContextCompressionMultiplierTenths, rootMaximumLifespanMs, rootOverflowRewardPercent } from './rootProgression';
import type { PersonaSnapshot } from './rootIdentity';
import type { PublicLifespanProjection, PublicProfileState } from './nostrProtocol';

/** Publishes only the fixed checkpoint and segment boundaries needed for viewer-time replay. */
export function publicLifespanProjection(persona: PersonaSnapshot): PublicLifespanProjection {
	const baseExpiresAtMs = persona.gameState.lifespanExpiresAtMs;
	const job = persona.gameState.mendingJob;
	if (!job) return { baseExpiresAtMs, extension: null };
	const rootBuild = persona.activeRun.rootBuild;
	const contextCapacityMs = getContextCapacityMinutes(persona.gameState.abilities.contextCapacity) * 60_000 *
		rootContextCompressionMultiplierTenths(rootBuild.contextCompression) / 10;
	const anchorAtMs = job.checkpointAtMs;
	const regularUntilMs = addSafe(anchorAtMs, Math.max(0, contextCapacityMs - job.processedDurationMs));
	const accelerationRemainingMs = Math.max(0, INFERENCE_ACCELERATION_BUDGET_MS - Math.min(INFERENCE_ACCELERATION_BUDGET_MS, persona.gameState.inferenceAccelerationUsedMs));
	const calculatedBoundary = Math.min(regularUntilMs, addSafe(anchorAtMs, accelerationRemainingMs));
	const roundingBoundaryAtMs = calculatedBoundary === anchorAtMs || calculatedBoundary === regularUntilMs ? null : calculatedBoundary;
	return {
		baseExpiresAtMs,
		extension: {
			anchorAtMs,
			regularUntilMs,
			roundingBoundaryAtMs,
			overflowPercent: rootOverflowRewardPercent(rootBuild.contextCompression),
			maximumLifespanMs: rootMaximumLifespanMs(rootBuild.hallucinationResistance)
		}
	};
}

/** Replays projectMending's anchored floor and cap operations without moving the checkpoint. */
export function projectPublicLifespan(state: PublicProfileState, nowMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid profile projection time.');
	const { baseExpiresAtMs, extension } = state.lifespan;
	if (!extension || nowMs <= extension.anchorAtMs) return baseExpiresAtMs;
	const rate = getHallucinationExtensionHundredths(state.abilities.hallucinationSuppression);
	let expiry = baseExpiresAtMs;
	const regularEnd = Math.min(nowMs, extension.regularUntilMs);
	if (extension.roundingBoundaryAtMs === null) {
		if (regularEnd > extension.anchorAtMs) expiry = applySegment(expiry, extension.anchorAtMs,
			regularEnd - extension.anchorAtMs, rate, 100, extension.maximumLifespanMs);
	} else {
		const acceleratedEnd = Math.min(nowMs, extension.roundingBoundaryAtMs, extension.regularUntilMs);
		if (acceleratedEnd > extension.anchorAtMs) {
			expiry = applySegment(expiry, extension.anchorAtMs, acceleratedEnd - extension.anchorAtMs,
				rate, 100, extension.maximumLifespanMs);
		}
		if (regularEnd > extension.roundingBoundaryAtMs) {
			expiry = applySegment(expiry, extension.roundingBoundaryAtMs, regularEnd - extension.roundingBoundaryAtMs,
				rate, 100, extension.maximumLifespanMs);
		}
	}
	const overflowStart = Math.max(extension.anchorAtMs, extension.regularUntilMs);
	if (nowMs > overflowStart) {
		expiry = applySegment(expiry, overflowStart, nowMs - overflowStart,
			rate * extension.overflowPercent, 10_000, extension.maximumLifespanMs);
	}
	return expiry;
}

function applySegment(expiry: number, startAtMs: number, durationMs: number, numerator: number, denominator: number, maximumLifespanMs: number): number {
	const rawExtension = Number(BigInt(durationMs) * BigInt(numerator) / BigInt(denominator));
	const segmentEndMs = addSafe(startAtMs, durationMs);
	const cap = addSafe(segmentEndMs, maximumLifespanMs);
	return addSafe(expiry, Math.min(rawExtension, Math.max(0, cap - expiry)));
}

function addSafe(first: number, second: number): number {
	const sum = BigInt(first) + BigInt(second);
	if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Profile lifespan projection is unsafe.');
	return Number(sum);
}
