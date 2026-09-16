const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60 * 1000;

function formatDuration(minutes: number): string {
	if (minutes === 0) return '0分';
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return remainingMinutes === 0 ? `${hours}時間` : `${hours}時間${remainingMinutes}分`;
	}
	return `${minutes}分`;
}

export function formatElapsedDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('Invalid duration.');
	const minutes = Math.floor(durationMs / MINUTE_MS);
	return minutes === 0 && durationMs > 0 ? '1分未満' : formatDuration(minutes);
}

export function formatRemainingDuration(durationMs: number): string {
	if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('Invalid duration.');
	return formatDuration(Math.ceil(durationMs / MINUTE_MS));
}

export function formatMendingRate(numerator: number, denominator: number): string {
	return (numerator / denominator).toFixed(2).replace(/(\.\d)0$/, '$1');
}

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
