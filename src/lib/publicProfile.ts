import { getHallucinationExtensionHundredths } from './personaGameState';
import { projectMending } from './mending';
import { rootMaximumLifespanMs, rootOverflowRewardPercent } from './rootProgression';
import type { PersonaSnapshot } from './rootIdentity';
import type { PublicLifespanProjection, PublicProfileState } from './nostrProtocol';

/** Projects only display inputs; it never creates or mutates local game state. */
export function publicLifespanProjection(persona: PersonaSnapshot, nowMs: number): PublicLifespanProjection {
	const rootBuild = persona.activeRun.rootBuild;
	const hasJob = persona.gameState.mendingJob !== null;
	const projection = projectMending(persona.gameState, nowMs, rootBuild);
	return {
		active: hasJob,
		projectedAtMs: nowMs,
		expiresAtMs: projection.effectiveExpiresAtMs,
		regularRemainingMs: hasJob ? projection.remainingDurationMs : 0,
		overflowRewardPercent: rootOverflowRewardPercent(rootBuild.contextCompression),
		maximumLifespanMs: rootMaximumLifespanMs(rootBuild.hallucinationResistance)
	};
}

/** Replays the compact public lifespan projection at viewer time. */
export function projectPublicLifespan(state: PublicProfileState, nowMs: number): number {
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError('Invalid profile projection time.');
	const life = state.lifespan;
	if (!life.active || nowMs <= life.projectedAtMs) return life.expiresAtMs;
	const extensionRate = getHallucinationExtensionHundredths(state.abilities.hallucinationSuppression);
	let expiry = life.expiresAtMs;
	const elapsed = nowMs - life.projectedAtMs;
	const regular = Math.min(elapsed, life.regularRemainingMs);
	if (regular > 0) {
		const endAt = safeAdd(life.projectedAtMs, regular);
		expiry = applyDuration(expiry, endAt, regular, extensionRate, 100, life.maximumLifespanMs);
	}
	const overflow = elapsed - regular;
	if (overflow > 0) {
		const endAt = safeAdd(life.projectedAtMs, elapsed);
		expiry = applyDuration(expiry, endAt, overflow,
			extensionRate * life.overflowRewardPercent, 10_000, life.maximumLifespanMs);
	}
	return expiry;
}

function applyDuration(expiry: number, segmentEnd: number, duration: number, numerator: number, denominator: number, maximumLifespanMs: number): number {
	const extension = Number(BigInt(duration) * BigInt(numerator) / BigInt(denominator));
	const cap = safeAdd(segmentEnd, maximumLifespanMs);
	return safeAdd(expiry, Math.min(extension, Math.max(0, cap - expiry)));
}

function safeAdd(first: number, second: number): number {
	const sum = BigInt(first) + BigInt(second);
	if (sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('Profile lifespan projection is unsafe.');
	return Number(sum);
}
