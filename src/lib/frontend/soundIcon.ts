export type SoundIconName = 'volume-off' | 'volume-4' | 'volume-2' | 'volume';

export function soundIconName(volume: number): SoundIconName {
	if (volume === 0) return 'volume-off';
	if (volume < 0.34) return 'volume-4';
	if (volume < 0.67) return 'volume-2';
	return 'volume';
}
