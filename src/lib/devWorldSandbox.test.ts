import { describe, expect, it, vi } from 'vitest';
import { projectPresence } from './presenceProjection';
import { createPresenceState, getParticipant } from './presence';
import {
	createDevWorldPresence,
	DEV_WORLD_SELF_ID,
	DEV_WORLD_SELF_PRESENTATION,
	isDevWorldSandboxEnabled,
	moveDevWorldSelf,
	resetDevWorldPresence
} from './devWorldSandbox';

const field = { columns: 16, rows: 8 };

function selfAt(position: { x: number; y: number }, now = 100) {
	return createPresenceState(field, now, [{ id: DEV_WORLD_SELF_ID, position }]);
}

describe('DEV world sandbox', () => {
	it('only activates for the explicit query in a development build', () => {
		expect(isDevWorldSandboxEnabled(true, new URLSearchParams('?devWorld=1'))).toBe(true);
		expect(isDevWorldSandboxEnabled(true, new URLSearchParams())).toBe(false);
		expect(isDevWorldSandboxEnabled(true, new URLSearchParams('?devWorld=true'))).toBe(false);
		expect(isDevWorldSandboxEnabled(false, new URLSearchParams('?devWorld=1'))).toBe(false);
	});

	it('creates the deterministic self and its fixed presentation', () => {
		const presence = createDevWorldPresence(field, 100);

		expect(presence).toEqual({
			field,
			participants: [{
				id: DEV_WORLD_SELF_ID,
				position: { x: 7, y: 3 },
				lastActivityAt: 100,
				status: 'active'
			}]
		});
		expect(DEV_WORLD_SELF_PRESENTATION).toEqual({ name: 'Dev Wanderer', initials: 'DEV', color: 'sky' });
	});

	it.each([
		['up', { x: 7, y: 2 }],
		['down', { x: 7, y: 4 }],
		['left', { x: 6, y: 3 }],
		['right', { x: 8, y: 3 }]
	] as const)('moves one cell %s', (direction, expected) => {
		const result = moveDevWorldSelf(createDevWorldPresence(field, 100), direction, 200);

		expect(result.moved).toBe(true);
		expect(getParticipant(result.state, DEV_WORLD_SELF_ID)).toMatchObject({
			position: expected,
			lastActivityAt: 200,
			status: 'active'
		});
	});

	it('blocks field edges and occupied cells', () => {
		const edge = moveDevWorldSelf(selfAt({ x: 0, y: 0 }), 'up', 200);
		const occupied = createPresenceState(field, 100, [
			{ id: DEV_WORLD_SELF_ID, position: { x: 7, y: 3 } },
			{ id: 'dummy-test-only', position: { x: 8, y: 3 } }
		]);
		const blocked = moveDevWorldSelf(occupied, 'right', 200);

		expect(edge.moved).toBe(false);
		expect(getParticipant(edge.state, DEV_WORLD_SELF_ID)?.position).toEqual({ x: 0, y: 0 });
		expect(blocked.moved).toBe(false);
		expect(getParticipant(blocked.state, DEV_WORLD_SELF_ID)?.position).toEqual({ x: 7, y: 3 });
	});

	it('resets moved state to the deterministic initial presence', () => {
		const moved = moveDevWorldSelf(createDevWorldPresence(field, 100), 'right', 200).state;

		expect(getParticipant(moved, DEV_WORLD_SELF_ID)?.position).toEqual({ x: 8, y: 3 });
		expect(resetDevWorldPresence(field, 300)).toEqual({
			field,
			participants: [{
				id: DEV_WORLD_SELF_ID,
				position: { x: 7, y: 3 },
				lastActivityAt: 300,
				status: 'active'
			}]
		});
	});

	it('projects the moved self and follows it with the existing camera', () => {
		const initial = createDevWorldPresence(field, 100);
		const moved = moveDevWorldSelf(initial, 'right', 200).state;
		const options = {
			cellSize: 56,
			fieldAreaBounds: { x: 0, y: 260, width: 390, height: 584 },
			fieldWorldSize: { width: 896, height: 448 }
		};
		const initialProjection = projectPresence(initial, [{ id: DEV_WORLD_SELF_ID }], options);
		const movedProjection = projectPresence(moved, [{ id: DEV_WORLD_SELF_ID }], options);

		expect(movedProjection.participants).toMatchObject([{ id: DEV_WORLD_SELF_ID, position: { x: 8, y: 3 } }]);
		expect(movedProjection.camera.x).toBeGreaterThan(initialProjection.camera.x);
	});

	it('does not construct a WebSocket while creating, moving, or resetting local state', () => {
		const websocket = vi.fn();
		vi.stubGlobal('WebSocket', websocket);
		try {
			const presence = createDevWorldPresence(field, 100);
			moveDevWorldSelf(presence, 'right', 200);
			resetDevWorldPresence(field, 300);

			expect(websocket).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
