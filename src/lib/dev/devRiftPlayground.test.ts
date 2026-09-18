import { describe, expect, it } from 'vitest';
import { createDevRiftPlayground, DEV_RIFT_PLAYGROUND_ACTORS } from './devRiftPlayground';

const field = { columns: 16, rows: 8 } as const;

function toSelection(runtime: ReturnType<typeof createDevRiftPlayground>) {
	 runtime.joinSelf();
	 runtime.advance();
	 runtime.advance();
	 return runtime;
}

describe('DEV Rift Playground', () => {
	it('uses deterministic local actors and joins the minimum participant set', () => {
		const runtime = createDevRiftPlayground(field);
		const state = runtime.joinSelf();
		expect(state.session.actions.filter((event) => event.action.action === 'join').map((event) => event.pubkey)).toEqual([...DEV_RIFT_PLAYGROUND_ACTORS]);
		expect(state.session.actions.every((event) => /^[0-9a-f]{64}$/.test(event.pubkey))).toBe(true);
	});

	it('supplies bot actions through production Rift settlement for a successful result', () => {
		const runtime = toSelection(createDevRiftPlayground(field));
		runtime.chooseSelf('maintain');
		const result = runtime.advance();
		expect(result.session.results[0]?.kind).toBe('all-maintain');
		expect(result.session.results[0]?.outcomes.every((outcome) => outcome.kind === 'points' && outcome.points === 20)).toBe(true);
	});

	it('supports split failure and missing reveal presets without production persistence', () => {
		const split = toSelection(createDevRiftPlayground(field, 'split'));
		split.chooseSelf('escape');
		expect(split.advance().session.results[0]?.kind).toBe('threshold-failure');
		const missing = toSelection(createDevRiftPlayground(field, 'missing-reveal'));
		missing.chooseSelf('maintain');
		expect(missing.advance().session.results[0]?.kind).toBe('insufficient');
	});
});
