export function formatContextCapacityMinutes(minutes: number): string {
	return minutes < 60 ? `${minutes}分` : `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
