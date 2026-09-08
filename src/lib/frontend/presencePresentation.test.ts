import { describe, expect, it } from 'vitest';
import { BUBBLE_TONES } from '../bubblePresentation';
import { DEV_WORLD_SELF_ID, getDevWorldCharacter } from '../devWorldSandbox';
import { createPresenceState } from '../presence';
import { allocateParticipantColors, projectFrontendPresence } from './presencePresentation';

describe('participant colors', () => {
	it('retains survivors, removes departed participants and assigns unused tones in sorted order', () => {
		const previous = Object.freeze({ b: 'mint' as const, gone: 'coral' as const });
		const ids = Object.freeze(['c', 'b', 'a']);
		expect(allocateParticipantColors(previous, ids)).toEqual({ a: 'coral', b: 'mint', c: 'lavender' });
		expect(allocateParticipantColors(previous, ['a', 'b', 'c'])).toEqual(allocateParticipantColors(previous, ids));
		expect(previous).toEqual({ b: 'mint', gone: 'coral' });
		expect(ids).toEqual(['c', 'b', 'a']);
	});

	it('keeps the sorted-index palette fallback when every tone is occupied', () => {
		const ids = Array.from({ length: 11 }, (_, index) => String(index).padStart(2, '0'));
		const colors = allocateParticipantColors({}, [...ids].reverse());
		expect(ids.map((id) => colors[id])).toEqual([...BUBBLE_TONES, ...BUBBLE_TONES.slice(0, 3)]);
		expect(allocateParticipantColors(colors, ids)).toEqual(colors);
		expect(allocateParticipantColors(colors, [])).toEqual({});
	});
});

describe('frontend presence projection', () => {
	it('uses explicit old and next colors without changing either snapshot', () => {
		const presence = createPresenceState({ columns: 16, rows: 8 }, 100, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } }
		]);
		const geometry = { cellSize: 50, fieldAreaBounds: { x: 0, y: 200, width: 300, height: 200 }, fieldWorldSize: { width: 800, height: 400 } };
		const input = { presence, selectedCharacterId: '001', selfProjectionId: DEV_WORLD_SELF_ID, geometry };
		const oldColors = Object.freeze({ [DEV_WORLD_SELF_ID]: 'mint' as const });
		const nextColors = Object.freeze({ [DEV_WORLD_SELF_ID]: 'coral' as const });
		const previous = projectFrontendPresence({ ...input, colors: oldColors });
		const next = projectFrontendPresence({ ...input, colors: nextColors });
		expect(previous.participants[0].color).toBe('mint');
		expect(next.participants[0].color).toBe('coral');
		expect(next.camera).toEqual(previous.camera);
		expect(next.participants[0].character).toEqual(getDevWorldCharacter('001'));
		expect(projectFrontendPresence({ ...input, selectedCharacterId: '002', colors: {} }).participants[0])
			.toMatchObject({ color: BUBBLE_TONES[0], character: getDevWorldCharacter('002') });
		expect(projectFrontendPresence({ ...input, selfProjectionId: 'missing', colors: {} }).camera).not.toEqual(next.camera);
		expect(projectFrontendPresence({ ...input, geometry: { ...geometry, cellSize: 40 }, colors: {} }).participants[0].world)
			.not.toEqual(next.participants[0].world);
		expect(oldColors[DEV_WORLD_SELF_ID]).toBe('mint');
	});
});
