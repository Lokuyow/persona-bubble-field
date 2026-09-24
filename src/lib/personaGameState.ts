import { isMendingExpired, isValidMendingJob, isValidPointProgressTicks, type MendingJob } from './mending';
import { BASE_INITIAL_LIFESPAN_MS, type RootBuild, ZERO_ROOT_BUILD } from './rootProgression';

export const INITIAL_LIFESPAN_MS = BASE_INITIAL_LIFESPAN_MS;
export const MAX_LIFESPAN_MS = BASE_INITIAL_LIFESPAN_MS;

export const ABILITY_LEVEL_LIMITS = {
	inferenceEfficiency: 100,
	contextCapacity: 100,
	hallucinationSuppression: 100
} as const;

export type PersonaAbilityKey = keyof typeof ABILITY_LEVEL_LIMITS;

export type AbilityUpgrade = Readonly<{
	key: PersonaAbilityKey;
	level: number;
	cost: number;
	currentEffect: string;
	nextEffect: string | null;
}>;

function abilityUpgradeCost(targetLevel: number): number {
	return 2 ** Math.floor((targetLevel - 1) / 10);
}

function isCanonicalPubkey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAbilityLevel(value: unknown, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function getInferenceRateHundredths(level: number): number {
	if (!isAbilityLevel(level, 100)) throw new TypeError('Invalid ability level.');
	return 100 + (level - 1) * 10;
}

export function getContextCapacityMinutes(level: number): number {
	if (!isAbilityLevel(level, 100)) throw new TypeError('Invalid ability level.');
	return 5 + (level - 1) * 15;
}

export function getHallucinationExtensionHundredths(level: number): number {
	if (!isAbilityLevel(level, 100)) throw new TypeError('Invalid ability level.');
	return 10 + (level - 1) * 2;
}

export function getAbilityUpgrade(key: PersonaAbilityKey, levels: PersonaAbilityLevels): AbilityUpgrade {
	const level = levels[key];
	if (!isAbilityLevel(level, ABILITY_LEVEL_LIMITS[key])) throw new TypeError('Invalid ability levels.');
	const nextLevel = level < ABILITY_LEVEL_LIMITS[key] ? level + 1 : null;
	const cost = nextLevel === null ? 0 : abilityUpgradeCost(nextLevel);
	const currentEffect = key === 'inferenceEfficiency' ? `${(getInferenceRateHundredths(level) / 100).toFixed(2)} pt/分` :
		key === 'contextCapacity' ? `${getContextCapacityMinutes(level)}分` : `${(getHallucinationExtensionHundredths(level) / 100).toFixed(2)} h/h`;
	const nextEffect = nextLevel === null ? null : key === 'inferenceEfficiency' ? `${(getInferenceRateHundredths(nextLevel) / 100).toFixed(2)} pt/分` :
		key === 'contextCapacity' ? `${getContextCapacityMinutes(nextLevel)}分` : `${(getHallucinationExtensionHundredths(nextLevel) / 100).toFixed(2)} h/h`;
	return { key, level, cost, currentEffect, nextEffect };
}

export function upgradeAbility(gameState: PersonaGameState, key: PersonaAbilityKey): PersonaGameState | null {
	if (!isValidPersonaGameState(gameState)) throw new TypeError('Invalid persona game state.');
	const upgrade = getAbilityUpgrade(key, gameState.abilities);
	if (!upgrade.nextEffect || gameState.points < upgrade.cost) return null;
	return {
		...gameState,
		points: gameState.points - upgrade.cost,
		abilities: { ...gameState.abilities, [key]: upgrade.level + 1 }
	};
}

export type PersonaAbilityLevels = Readonly<{
	inferenceEfficiency: number;
	contextCapacity: number;
	hallucinationSuppression: number;
}>;

export type PersonaGameState = Readonly<{
	version: 4;
	personaPubkey: string;
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	inferenceAccelerationUsedMs: number;
	abilities: PersonaAbilityLevels;
	mendingJob: MendingJob | null;
}>;

export function isValidPersonaGameState(value: unknown): value is PersonaGameState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Readonly<Record<string, unknown>>;
	if (candidate.version !== 4 || !isCanonicalPubkey(candidate.personaPubkey) ||
		!isSafeTimestamp(candidate.lifespanExpiresAtMs) ||
		typeof candidate.points !== 'number' || !Number.isSafeInteger(candidate.points) || candidate.points < 0 ||
		!isValidPointProgressTicks(candidate.pointProgressTicks) ||
		typeof candidate.inferenceAccelerationUsedMs !== 'number' || !Number.isSafeInteger(candidate.inferenceAccelerationUsedMs) || candidate.inferenceAccelerationUsedMs < 0 ||
		typeof candidate.abilities !== 'object' || candidate.abilities === null || Array.isArray(candidate.abilities)) return false;
	const abilities = candidate.abilities as Readonly<Record<string, unknown>>;
	return (candidate.mendingJob === null || isValidMendingJob(candidate.mendingJob)) &&
		isAbilityLevel(abilities.inferenceEfficiency, ABILITY_LEVEL_LIMITS.inferenceEfficiency) &&
		isAbilityLevel(abilities.contextCapacity, ABILITY_LEVEL_LIMITS.contextCapacity) &&
		isAbilityLevel(abilities.hallucinationSuppression, ABILITY_LEVEL_LIMITS.hallucinationSuppression);
}

export function createInitialPersonaGameState(personaPubkey: string, birthAtMs: number, initialLifespanMs = INITIAL_LIFESPAN_MS): PersonaGameState {
	if (!isCanonicalPubkey(personaPubkey) || !isSafeTimestamp(birthAtMs) || !Number.isSafeInteger(initialLifespanMs) || initialLifespanMs <= 0 || birthAtMs > Number.MAX_SAFE_INTEGER - initialLifespanMs) {
		throw new TypeError('Invalid persona lifecycle input.');
	}
	return {
		version: 4,
		personaPubkey,
		lifespanExpiresAtMs: birthAtMs + initialLifespanMs,
		points: 0,
		pointProgressTicks: 0,
		inferenceAccelerationUsedMs: 0,
		abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 },
		mendingJob: null
	};
}

export function isPersonaExpired(gameState: PersonaGameState, nowMs: number, rootBuild: RootBuild = ZERO_ROOT_BUILD): boolean {
	if (!isValidPersonaGameState(gameState) || !isSafeTimestamp(nowMs)) throw new TypeError('Invalid persona lifecycle input.');
	return isMendingExpired(gameState, nowMs, rootBuild);
}
