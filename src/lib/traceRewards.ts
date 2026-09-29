import { applyInteractionReward } from './rootIdentity';
import { loadPendingTraceRewardOutbox, settleTraceRewardOutbox } from './traceReadState';

/** Reconciles the Trace-side outbox with the Account-side idempotent reward ledger. */
export async function settlePendingTraceRewards(): Promise<void> {
	const pending = await loadPendingTraceRewardOutbox();
	for (const record of pending) {
		try {
			const result = await applyInteractionReward({
				kind: record.kind,
				channelId: record.channelId,
				eventId: record.eventId,
				identity: record.identity,
				runNumber: record.runNumber
			});
			await settleTraceRewardOutbox(record.key, result.kind === 'stale' ? 'stale' : 'processed');
		} catch {
			// Keep the durable outbox pending so a later startup or read can retry it.
		}
	}
}
