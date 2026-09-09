export const INITIAL_LIFESPAN_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_LIFESPAN_MS = 14 * 24 * 60 * 60 * 1000;

export const ABILITY_LEVEL_LIMITS = {
	inferenceEfficiency: 4,
	contextCapacity: 3,
	hallucinationSuppression: 4
} as const;

export type PersonaAbilityLevels = Readonly<{
	inferenceEfficiency: number;
	contextCapacity: number;
	hallucinationSuppression: number;
}>;

export type PersonaGameState = Readonly<{
	version: 1;
	personaPubkey: string;
	lifespanExpiresAtMs: number;
	points: number;
	abilities: PersonaAbilityLevels;
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
	if (candidate.version !== 1 || !isCanonicalPubkey(candidate.personaPubkey) ||
		!isSafeTimestamp(candidate.lifespanExpiresAtMs) ||
		typeof candidate.points !== 'number' || !Number.isFinite(candidate.points) || candidate.points < 0 ||
		typeof candidate.abilities !== 'object' || candidate.abilities === null || Array.isArray(candidate.abilities)) return false;
	const abilities = candidate.abilities as Readonly<Record<string, unknown>>;
	return isAbilityLevel(abilities.inferenceEfficiency, ABILITY_LEVEL_LIMITS.inferenceEfficiency) &&
		isAbilityLevel(abilities.contextCapacity, ABILITY_LEVEL_LIMITS.contextCapacity) &&
		isAbilityLevel(abilities.hallucinationSuppression, ABILITY_LEVEL_LIMITS.hallucinationSuppression);
}

export function createInitialPersonaGameState(personaPubkey: string, birthAtMs: number): PersonaGameState {
	if (!isCanonicalPubkey(personaPubkey) || !isSafeTimestamp(birthAtMs) ||
		birthAtMs > Number.MAX_SAFE_INTEGER - INITIAL_LIFESPAN_MS) {
		throw new TypeError('Invalid persona lifecycle input.');
	}
	return {
		version: 1,
		personaPubkey,
		lifespanExpiresAtMs: birthAtMs + INITIAL_LIFESPAN_MS,
		points: 0,
		abilities: { inferenceEfficiency: 0, contextCapacity: 0, hallucinationSuppression: 0 }
	};
}

export function isPersonaExpired(gameState: PersonaGameState, nowMs: number): boolean {
	if (!isValidPersonaGameState(gameState) || !isSafeTimestamp(nowMs)) throw new TypeError('Invalid persona lifecycle input.');
	return nowMs >= gameState.lifespanExpiresAtMs;
}
