import { applyInteractionReward } from './rootIdentity';
import { loadPendingTraceRewardOutbox, settleTraceRewardOutbox } from './traceReadState';

export type TraceReadRewardTarget = Readonly<{
	kind: 'trace-root-read' | 'trace-reply-read';
	channelId: string;
	eventId: string;
}>;

export type AppliedTraceReadReward = Readonly<{ points: 5 | 10 }>;

/** Reconciles the Trace-side outbox with the Account-side idempotent reward ledger. */
export async function settlePendingTraceRewards(target?: TraceReadRewardTarget): Promise<readonly AppliedTraceReadReward[]> {
	const pending = await loadPendingTraceRewardOutbox();
	const applied: AppliedTraceReadReward[] = [];
	for (const record of pending) {
		if (target && (record.kind !== target.kind || record.channelId !== target.channelId || record.eventId !== target.eventId)) continue;
		try {
			const result = await applyInteractionReward({
				kind: record.kind,
				channelId: record.channelId,
				eventId: record.eventId,
				identity: record.identity,
				runNumber: record.runNumber
			});
			if (result.kind === 'applied' && target) applied.push({ points: record.kind === 'trace-root-read' ? 5 : 10 });
			try { await settleTraceRewardOutbox(record.key, result.kind === 'stale' ? 'stale' : 'processed'); } catch { /* Account ledger makes retry idempotent. */ }
		} catch {
			// Keep the durable outbox pending so a later startup or read can retry it.
		}
	}
	return applied;
}
