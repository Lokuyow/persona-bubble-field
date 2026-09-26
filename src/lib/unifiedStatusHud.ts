export const STATUS_HUD_POINTS_MAX = 100_000;

export type StatusValueChangeDirection = 'increase' | 'decrease';

export function getStatusValueChangeDirection(previous: number, current: number): StatusValueChangeDirection | null {
	if (current > previous) return 'increase';
	if (current < previous) return 'decrease';
	return null;
}

export type UnifiedStatusMeterValues = Readonly<{
	lifespan: number;
	points: number;
}>;

export function projectUnifiedStatusMeterValues(
	points: number,
	remainingLifespanMs: number,
	maximumLifespanMs: number
): UnifiedStatusMeterValues {
	if (!Number.isSafeInteger(points) || points < 0 || !Number.isFinite(remainingLifespanMs) || remainingLifespanMs < 0 ||
		!Number.isFinite(maximumLifespanMs) || maximumLifespanMs <= 0) throw new TypeError('Invalid status meter input.');
	return {
		lifespan: Math.min(maximumLifespanMs, remainingLifespanMs),
		points: Math.min(STATUS_HUD_POINTS_MAX, points)
	};
}
