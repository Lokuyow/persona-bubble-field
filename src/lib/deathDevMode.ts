export const DEATH_DEV_INITIAL_LIFESPAN_MS = 3_000;

export function isDeathDevMode(dev: boolean, mode: string): boolean {
	return dev && mode === 'death';
}

export function resolveInitialLifespanMs(
	dev: boolean,
	mode: string,
	productionLifespanMs: number
): number {
	return isDeathDevMode(dev, mode) ? DEATH_DEV_INITIAL_LIFESPAN_MS : productionLifespanMs;
}

export const deathDevMode = isDeathDevMode(import.meta.env.DEV, import.meta.env.MODE);
