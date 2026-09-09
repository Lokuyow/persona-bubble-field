import type { SpeechType } from './conversation';
import { resolveSpeechSubmission, type SpeechSubmission } from './speechSubmission';
import type { TraceReplyIdentity } from './traceReplyMode';

export type SpeechPublicationContext = Readonly<{
	generation: number;
	target: TraceReplyIdentity | null;
}>;

export type SpeechPublicationOutcome =
	| Readonly<{ kind: 'succeeded'; eventId: string }>
	| Readonly<{ kind: 'out-of-range' | 'failed' | 'blocked' | 'pending' | 'unavailable' }>;

export type SpeechPublicationCoreOptions = Readonly<{
	getSelectedSpeechType: () => SpeechType;
	getSubmissionInProgress: () => boolean;
	setSubmissionInProgress: (value: boolean) => void;
	waitForReady: (signal: AbortSignal) => Promise<void>;
	isCurrentContext: (context: SpeechPublicationContext) => boolean;
	publish: (submission: SpeechSubmission, context: SpeechPublicationContext, signal: AbortSignal) => Promise<SpeechPublicationOutcome>;
	onSucceeded: (context: SpeechPublicationContext) => void;
	onOutOfRange: (context: SpeechPublicationContext) => void;
}>;

function abortError(): DOMException {
	return new DOMException('Submission was cancelled.', 'AbortError');
}

export function createSpeechPublicationCore(options: SpeechPublicationCoreOptions) {
	return {
		async publish(
			content: string,
			context: SpeechPublicationContext,
			publicationOptions: Readonly<{ signal: AbortSignal; shortcutId?: string }>
		): Promise<Readonly<{ eventId: string }>> {
			const { signal } = publicationOptions;
			if (signal.aborted) throw abortError();
			if (options.getSubmissionInProgress()) throw new Error('A speech submission is already in progress.');
			const submission = resolveSpeechSubmission({
				content,
				shortcutId: publicationOptions.shortcutId,
				selectedSpeechType: options.getSelectedSpeechType()
			});
			options.setSubmissionInProgress(true);
			try {
				await options.waitForReady(signal);
				if (signal.aborted) throw abortError();
				if (!options.isCurrentContext(context)) throw new Error('Speech reply target changed before publication.');
				const result = await options.publish(submission, context, signal);
				if (signal.aborted) throw abortError();
				if (result.kind === 'succeeded') {
					options.onSucceeded(context);
					return { eventId: result.eventId };
				}
				if (result.kind === 'out-of-range') options.onOutOfRange(context);
				throw new Error('Message was not confirmed by Relay.');
			} finally {
				options.setSubmissionInProgress(false);
			}
		}
	};
}
