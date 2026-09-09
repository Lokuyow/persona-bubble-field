const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

export function formatRemainingLifespan(expiresAtMs: number, nowMs: number): string {
	const remainingMs = Math.max(0, expiresAtMs - nowMs);
	const remainingMinutes = Math.floor(remainingMs / MINUTE_MS);

	if (remainingMs >= DAY_MS) {
		const days = Math.floor(remainingMs / DAY_MS);
		const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
		return `寿命 ${days}日 ${hours}時間`;
	}
	if (remainingMs >= HOUR_MS) {
		const hours = Math.floor(remainingMs / HOUR_MS);
		const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
		return `寿命 ${hours}時間 ${minutes}分`;
	}
	return `寿命 ${remainingMinutes}分`;
}
