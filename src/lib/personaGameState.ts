import { isMendingExpired, isValidMendingJob, isValidPointProgressTicks, type MendingJob } from './mending';

export const INITIAL_LIFESPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LIFESPAN_MS = 14 * 24 * 60 * 60 * 1000;

export const ABILITY_LEVEL_LIMITS = {
	inferenceEfficiency: 4,
	contextCapacity: 3,
	hallucinationSuppression: 4
} as const;

export type PersonaAbilityKey = keyof typeof ABILITY_LEVEL_LIMITS;

export type AbilityUpgrade = Readonly<{
	key: PersonaAbilityKey;
	level: number;
	cost: number;
	currentEffect: string;
	nextEffect: string | null;
}>;

const ABILITY_EFFECTS: Readonly<Record<PersonaAbilityKey, readonly string[]>> = {
	inferenceEfficiency: ['0.8h/h', '0.9h/h', '1.0h/h', '1.1h/h', '1.25h/h'],
	contextCapacity: ['8h', '12h', '18h', '24h'],
	hallucinationSuppression: ['60分 / 1pt', '55分 / 1pt', '50分 / 1pt', '45分 / 1pt', '40分 / 1pt']
};

const ABILITY_UPGRADE_COSTS: Readonly<Record<PersonaAbilityKey, readonly number[]>> = {
	inferenceEfficiency: [5, 10, 20, 40],
	contextCapacity: [10, 20, 40],
	hallucinationSuppression: [10, 20, 30, 40]
};

export function getAbilityUpgrade(key: PersonaAbilityKey, levels: PersonaAbilityLevels): AbilityUpgrade {
	const level = levels[key];
	const effects = ABILITY_EFFECTS[key];
	const costs = ABILITY_UPGRADE_COSTS[key];
	if (!isAbilityLevel(level, ABILITY_LEVEL_LIMITS[key])) throw new TypeError('Invalid ability levels.');
	return {
		key,
		level,
		cost: costs[level] ?? 0,
		currentEffect: effects[level],
		nextEffect: effects[level + 1] ?? null
	};
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
	version: 3;
	personaPubkey: string;
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	abilities: PersonaAbilityLevels;
	mendingJob: MendingJob | null;
}>;

function isCanonicalPubkey(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAbilityLevel(value: unknown, maximum: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function isValidPersonaGameState(value: unknown): value is PersonaGameState {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const candidate = value as Readonly<Record<string, unknown>>;
	if (candidate.version !== 3 || !isCanonicalPubkey(candidate.personaPubkey) ||
		!isSafeTimestamp(candidate.lifespanExpiresAtMs) ||
		typeof candidate.points !== 'number' || !Number.isSafeInteger(candidate.points) || candidate.points < 0 ||
		!isValidPointProgressTicks(candidate.pointProgressTicks) ||
		typeof candidate.abilities !== 'object' || candidate.abilities === null || Array.isArray(candidate.abilities)) return false;
	const abilities = candidate.abilities as Readonly<Record<string, unknown>>;
	return (candidate.mendingJob === null || isValidMendingJob(candidate.mendingJob)) && isAbilityLevel(abilities.inferenceEfficiency, ABILITY_LEVEL_LIMITS.inferenceEfficiency) &&
		isAbilityLevel(abilities.contextCapacity, ABILITY_LEVEL_LIMITS.contextCapacity) &&
		isAbilityLevel(abilities.hallucinationSuppression, ABILITY_LEVEL_LIMITS.hallucinationSuppression);
}

export function createInitialPersonaGameState(personaPubkey: string, birthAtMs: number): PersonaGameState {
	if (!isCanonicalPubkey(personaPubkey) || !isSafeTimestamp(birthAtMs) ||
		birthAtMs > Number.MAX_SAFE_INTEGER - INITIAL_LIFESPAN_MS) {
		throw new TypeError('Invalid persona lifecycle input.');
	}
	return {
		version: 3,
		personaPubkey,
		lifespanExpiresAtMs: birthAtMs + INITIAL_LIFESPAN_MS,
		points: 0,
		pointProgressTicks: 0,
		abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 },
		mendingJob: null
	};
}

export function isPersonaExpired(gameState: PersonaGameState, nowMs: number): boolean {
	if (!isValidPersonaGameState(gameState) || !isSafeTimestamp(nowMs)) throw new TypeError('Invalid persona lifecycle input.');
	return isMendingExpired(gameState, nowMs);
}
