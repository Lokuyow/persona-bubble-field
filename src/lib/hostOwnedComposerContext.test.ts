import { describe, expect, it, vi } from 'vitest';
import { noteEncode } from 'nostr-tools/nip19';
import { createComposerContextSync, matchesComposerSubmit, type ComposerContextPatch, type ComposerDesiredContext, type HostOwnedComposerOutput } from './hostOwnedComposerContext';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const request = (generation: number, targetId: string | null, clearContentVersion = 0): ComposerDesiredContext =>
	({ generation, targetId, clearContentVersion });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function fixture() {
	const onPreviewClear = vi.fn();
	const setContext = vi.fn(async (patch: ComposerContextPatch) => { sync.contextUpdated(patch.reply); });
	const sync = createComposerContextSync({ setContext, onPreviewClear });
	return { sync, setContext, onPreviewClear };
}

describe('Host-owned combined context synchronization', () => {
	it('clears content and sets the target in one acknowledged call without a user-clear notification', async () => {
		const f = fixture();
		f.sync.request(request(1, a, 1)); f.sync.ready(); await flush();
		expect(f.setContext.mock.calls).toEqual([[{ content: null, reply: noteEncode(a) }]]);
		expect(f.sync.snapshot()).toEqual({ generation: 1, appliedGeneration: 1, fullySynced: true });
		expect(f.onPreviewClear).not.toHaveBeenCalled();
		f.sync.contextUpdated(null);
		expect(f.onPreviewClear).toHaveBeenCalledWith(1);
	});

	it('consumes stale acknowledgements and applies only the latest queued target with its clear request', async () => {
		const f = fixture();
		let finish!: () => void;
		f.setContext.mockImplementationOnce((patch) => new Promise<void>((resolve) => {
			finish = () => { f.sync.contextUpdated(patch.reply); resolve(); };
		}));
		f.sync.request(request(1, a, 1)); f.sync.ready();
		f.sync.request(request(2, b, 2));
		f.sync.request(request(3, null, 2));
		finish(); await flush();
		expect(f.setContext.mock.calls).toEqual([
			[{ content: null, reply: noteEncode(a) }], [{ content: null, reply: null }]
		]);
		expect(f.onPreviewClear).not.toHaveBeenCalled();
		expect(f.sync.snapshot().appliedGeneration).toBe(3);
	});

	it('retains a cleared draft when the same target is reopened after preview clear', async () => {
		const f = fixture();
		f.sync.request(request(1, a, 1)); f.sync.ready(); await flush();
		f.sync.request(request(2, null, 1)); await flush();
		f.sync.request(request(3, a, 1)); await flush();
		expect(f.setContext.mock.calls.at(-1)).toEqual([{ reply: noteEncode(a) }]);
	});

	it.each(['reject', 'missing-ack', 'wrong-ack'])('fails closed after %s without an automatic retry loop', async (failure) => {
		const f = fixture();
		f.setContext.mockImplementationOnce(async () => {
			if (failure === 'reject') throw new Error('context failed');
			if (failure === 'wrong-ack') f.sync.contextUpdated(noteEncode(b));
		});
		f.sync.request(request(1, a, 1)); f.sync.ready(); await flush();
		expect(f.sync.snapshot().fullySynced).toBe(false);
		expect(f.setContext).toHaveBeenCalledTimes(1);
		f.sync.request(request(2, a, 1)); await flush();
		expect(f.setContext.mock.calls.at(-1)).toEqual([{ content: null, reply: noteEncode(a) }]);
		expect(f.sync.snapshot().fullySynced).toBe(true);
	});

	it('holds desired changes throughout submit and resumes after the host terminal notification', async () => {
		const f = fixture();
		f.sync.request(request(1, a, 1)); f.sync.ready(); await flush();
		expect(f.sync.beginSubmit().fullySynced).toBe(true);
		f.sync.request(request(2, b, 2)); await flush();
		expect(f.setContext).toHaveBeenCalledTimes(1);
		f.sync.finishSubmit(true); await flush();
		expect(f.setContext.mock.calls.at(-1)).toEqual([{ reply: noteEncode(b), content: null }]);
		expect(f.sync.snapshot().fullySynced).toBe(true);
	});

	it('does not let slow preview hydration apply a stale target or lose its unconsumed clear', async () => {
		let finish!: (event: null) => void;
		const loadPreview = vi.fn(() => new Promise<null>((resolve) => { finish = resolve; }));
		const setContext = vi.fn(async (patch: ComposerContextPatch) => { sync.contextUpdated(patch.reply); });
		const sync = createComposerContextSync({ setContext, loadPreview, onPreviewClear: vi.fn() });
		sync.request(request(1, a, 1)); sync.ready();
		sync.request(request(2, null, 1)); finish(null); await flush();
		expect(setContext.mock.calls).toEqual([[{ content: null, reply: null }]]);
		expect(sync.snapshot().fullySynced).toBe(true);
	});

	it('repairs unexpected references without adopting them or clearing the draft', async () => {
		const f = fixture(); f.sync.request(request(1, a)); f.sync.ready(); await flush();
		f.sync.contextUpdated(noteEncode(b)); await flush();
		expect(f.setContext.mock.calls.at(-1)).toEqual([{ reply: noteEncode(a) }]);
		expect(f.onPreviewClear).not.toHaveBeenCalled();
		f.sync.dispose(); f.sync.request(request(2, b)); await flush();
		expect(f.setContext).toHaveBeenCalledTimes(2);
	});
});

describe('structured submit authority check', () => {
	const output = (eventId: string | null): HostOwnedComposerOutput => ({ content: 'draft', tags: [['e', b]],
		context: { reply: eventId ? { eventId, relayHints: ['wss://untrusted.test'], authorPubkey: b } : null, quotes: [], channel: null } });
	it('compares only structured event IDs and sync generation, without treating hints as authority', () => {
		const envelope = { output: output(a), generation: 1, appliedGeneration: 1, fullySynced: true };
		expect(matchesComposerSubmit(envelope, request(1, a))).toBe(true);
		for (const changed of [
			{ ...envelope, output: output(b) }, { ...envelope, output: output(null) },
			{ ...envelope, fullySynced: false }, { ...envelope, generation: 0 }, { ...envelope, appliedGeneration: 0 }
		]) expect(matchesComposerSubmit(changed, request(1, a))).toBe(false);
		expect(matchesComposerSubmit({ ...envelope, output: output(null) }, request(1, null))).toBe(true);
		expect(matchesComposerSubmit(envelope, request(1, null))).toBe(false);
	});
});
