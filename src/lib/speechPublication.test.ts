import { describe, expect, it, vi } from 'vitest';
import { createSpeechPublicationCore, type SpeechPublicationContext, type SpeechPublicationOutcome } from './speechPublication';

const topLevel: SpeechPublicationContext = { generation: 1, target: null };

function fixture() {
	let submissionInProgress = false;
	const publish = vi.fn<(submission: { content: string; speechType: 'normal' | 'shout' | 'monologue' }, context: SpeechPublicationContext, signal: AbortSignal) => Promise<SpeechPublicationOutcome>>(async () => ({ kind: 'succeeded', eventId: 'event-id' }));
	const onSucceeded = vi.fn();
	const onOutOfRange = vi.fn();
	const core = createSpeechPublicationCore({
		getSelectedSpeechType: () => 'shout',
		getSubmissionInProgress: () => submissionInProgress,
		setSubmissionInProgress: (value) => { submissionInProgress = value; },
		isPublicationAllowed: () => true,
		waitForReady: async () => {},
		isCurrentContext: () => true,
		publish,
		onSucceeded,
		onOutOfRange
	});
	return { core, publish, onSucceeded, onOutOfRange, isInProgress: () => submissionInProgress };
}

describe('speech publication core', () => {
	it('shares the same publish path for speech type resolution and success reset', async () => {
		const f = fixture();
		await expect(f.core.publish('candidate', topLevel, { signal: new AbortController().signal })).resolves.toEqual({ eventId: 'event-id' });
		expect(f.publish).toHaveBeenCalledWith({ content: 'candidate', speechType: 'shout' }, topLevel, expect.any(AbortSignal));
		expect(f.onSucceeded).toHaveBeenCalledWith(topLevel);
		expect(f.isInProgress()).toBe(false);
	});

	it('fails closed when another submission starts first and rechecks context after readiness', async () => {
		const f = fixture();
		let finish!: () => void;
		const waitForReady = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
		let current = true;
		let gate = false;
		const gatedCore = createSpeechPublicationCore({
			getSelectedSpeechType: () => 'normal', getSubmissionInProgress: () => gate,
			setSubmissionInProgress: (value) => { gate = value; }, isPublicationAllowed: () => true, waitForReady,
			isCurrentContext: () => current, publish: f.publish,
			onSucceeded: f.onSucceeded, onOutOfRange: f.onOutOfRange
		});
		const first = gatedCore.publish('first', topLevel, { signal: new AbortController().signal });
		await expect(gatedCore.publish('second', topLevel, { signal: new AbortController().signal })).rejects.toThrow('already in progress');
		current = false;
		finish();
		await expect(first).rejects.toThrow('target changed');
		expect(f.publish).not.toHaveBeenCalled();
	});

	it('does not turn abort into a publish failure or mutate success state', async () => {
		const f = fixture();
		const controller = new AbortController();
		const waitForReady = vi.fn(async (signal: AbortSignal) => {
			controller.abort();
			if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
		});
		const core = createSpeechPublicationCore({
			getSelectedSpeechType: () => 'normal', getSubmissionInProgress: f.isInProgress,
			setSubmissionInProgress: (value) => { /* fixture gate is not relevant here */ void value; },
			isPublicationAllowed: () => true,
			waitForReady, isCurrentContext: () => true, publish: f.publish,
			onSucceeded: f.onSucceeded, onOutOfRange: f.onOutOfRange
		});
		await expect(core.publish('candidate', topLevel, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
		expect(f.publish).not.toHaveBeenCalled();
	});

	it('blocks readiness and publication when the persona lifecycle ends', async () => {
		const f = fixture();
		let allowed = true;
		const waitForReady = vi.fn(async () => { allowed = false; });
		const core = createSpeechPublicationCore({
			getSelectedSpeechType: () => 'normal', getSubmissionInProgress: f.isInProgress,
			setSubmissionInProgress: (value) => { /* fixture gate is not relevant here */ void value; },
			isPublicationAllowed: () => allowed,
			waitForReady, isCurrentContext: () => true, publish: f.publish,
			onSucceeded: f.onSucceeded, onOutOfRange: f.onOutOfRange
		});
		allowed = false;
		await expect(core.publish('before-ready', topLevel, { signal: new AbortController().signal })).rejects.toThrow('unavailable');
		expect(waitForReady).not.toHaveBeenCalled();
		allowed = true;
		await expect(core.publish('candidate', topLevel, { signal: new AbortController().signal })).rejects.toThrow('unavailable');
		expect(waitForReady).toHaveBeenCalledTimes(1);
		expect(f.publish).not.toHaveBeenCalled();
	});
});
