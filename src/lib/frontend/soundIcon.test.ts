import { describe, expect, it } from 'vitest';
import { soundIconName } from './soundIcon';

describe('soundIconName', () => {
	it('selects the muted icon at zero volume', () => {
		expect(soundIconName(0)).toBe('volume-off');
	});

	it('selects the low-volume icon below 0.34', () => {
		expect(soundIconName(0.01)).toBe('volume-4');
		expect(soundIconName(0.33)).toBe('volume-4');
	});

	it('selects the medium-volume icon from 0.34 through below 0.67', () => {
		expect(soundIconName(0.34)).toBe('volume-2');
		expect(soundIconName(0.66)).toBe('volume-2');
	});

	it('selects the high-volume icon from 0.67', () => {
		expect(soundIconName(0.67)).toBe('volume');
		expect(soundIconName(1)).toBe('volume');
	});
});
