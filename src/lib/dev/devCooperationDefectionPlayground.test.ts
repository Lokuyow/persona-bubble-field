import { describe, expect, it } from 'vitest';
import { createDevCooperationDefectionPlayground, DEV_COOPERATION_DEFECTION_PLAYGROUND_ACTORS } from './devCooperationDefectionPlayground';

const field = { columns: 16, rows: 8 } as const;

function toSelection(runtime: ReturnType<typeof createDevCooperationDefectionPlayground>) {
	 runtime.joinSelf();
	 runtime.advance();
	 runtime.advance();
	 return runtime;
}

describe('DEV CooperationDefection Playground', () => {
	it('uses deterministic local actors and joins the minimum participant set', () => {
		const runtime = createDevCooperationDefectionPlayground(field);
		const state = runtime.joinSelf();
		expect(state.session.actions.filter((event) => event.action.action === 'join').map((event) => event.pubkey)).toEqual([...DEV_COOPERATION_DEFECTION_PLAYGROUND_ACTORS]);
		expect(state.session.actions.every((event) => /^[0-9a-f]{64}$/.test(event.pubkey))).toBe(true);
	});

	it('supplies bot actions through production CooperationDefection settlement for a successful result', () => {
		const runtime = toSelection(createDevCooperationDefectionPlayground(field));
		runtime.chooseSelf('cooperate');
		const result = runtime.advance();
		expect(result.session.results[0]?.kind).toBe('all-cooperate');
		expect(result.session.results[0]?.outcomes.every((outcome) => outcome.kind === 'points' && outcome.points === 1_000)).toBe(true);
	});

	it('supports a failed cooperation result and missing reveal preset without production persistence', () => {
		const split = toSelection(createDevCooperationDefectionPlayground(field, 'split'));
		split.chooseSelf('defect');
		expect(split.advance().session.results[0]?.kind).toBe('cooperation-failure');
		const missing = toSelection(createDevCooperationDefectionPlayground(field, 'missing-reveal'));
		missing.chooseSelf('cooperate');
		expect(missing.advance().session.results[0]?.kind).toBe('insufficient');
	});
});
