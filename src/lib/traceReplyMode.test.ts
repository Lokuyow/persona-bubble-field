import { describe, expect, it } from 'vitest';
import { clearTraceReplyMode, completeTraceReplySubmission, createTraceReplyMode, selectTraceReplyTarget } from './traceReplyMode';

const a = { rootId: 'root', targetId: 'a', position: { x: 1, y: 1 } };
describe('Trace reply draft ownership', () => {
	it('clears a top-level draft once, preserving A through preview clear or conversation close', () => {
		const selected = selectTraceReplyTarget(createTraceReplyMode(), a);
		expect(selected.clearContentVersion).toBe(1);
		const closed = clearTraceReplyMode(selected);
		expect(closed.target).toBeNull();
		expect(closed.draftIdentity).toEqual({ rootId: 'root', targetId: 'a' });
		expect(selectTraceReplyTarget(closed, a).clearContentVersion).toBe(1);
		expect(selectTraceReplyTarget(selected, a).clearContentVersion).toBe(1);
	});
	it('clears preserved drafts for a different event or root, and clears identity on range exit', () => {
		const closed = clearTraceReplyMode(selectTraceReplyTarget(createTraceReplyMode(), a));
		for (const target of [{ ...a, targetId: 'b' }, { ...a, rootId: 'other' }]) {
			expect(selectTraceReplyTarget(closed, target).clearContentVersion).toBe(2);
		}
		expect(clearTraceReplyMode(closed, true)).toMatchObject({ target: null, draftIdentity: null, clearContentVersion: 2 });
	});
	it('clears ownership after success without clearing a newer target', () => {
		const selected = selectTraceReplyTarget(createTraceReplyMode(), a);
		expect(completeTraceReplySubmission(selected, selected.generation)).toMatchObject({ target: null, draftIdentity: null });
		const next = selectTraceReplyTarget(selected, { ...a, targetId: 'b' });
		expect(completeTraceReplySubmission(next, selected.generation)).toBe(next);
	});
});
