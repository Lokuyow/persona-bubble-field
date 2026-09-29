import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { getPublicKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyInteractionReward, loadOrCreateLifecycle, selectIdentity, type PersonaSnapshot } from './rootIdentity';
import { buildTraceReplyTemplate, buildWorldMessageTemplate, finalizeWorldEvent, parseTraceReplyCandidate, parseWorldMessage, validateTraceReplyCandidate, type ChannelReference } from './nostrProtocol';
import { openTraceDatabase, TRACE_REWARD_OUTBOX_STORE } from './traceDatabase';
import { reconcileTraceReplyCache } from './traceReplyCache';
import { reconcileTraceRootCache } from './traceRootCache';
import { loadPendingTraceRewardOutbox, markTraceReplyRead, markTraceRootRead } from './traceReadState';
import { settlePendingTraceRewards } from './traceRewards';

const CHANNEL_ID = 'a'.repeat(64);
const SELF_SECRET = new Uint8Array(32).fill(30);
const OTHER_SECRET = new Uint8Array(32).fill(67);
const SELF = getPublicKey(SELF_SECRET);
const channel: ChannelReference = { channelId: CHANNEL_ID, relayHint: 'wss://relay.example.com' };

async function activePersona(): Promise<PersonaSnapshot> {
	const lifecycle = await loadOrCreateLifecycle();
	if (lifecycle.kind === 'restored') return lifecycle.persona;
	if (lifecycle.kind !== 'created' && lifecycle.kind !== 'selecting') throw new Error('Could not initialize test Account.');
	const selected = await selectIdentity(lifecycle.selection.generation, lifecycle.selection.candidates[0],
		{ inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 });
	if (selected.kind !== 'selected') throw new Error('Could not select test Identity.');
	return selected.persona;
}

function makeTraceRoot(secret: Uint8Array, content: string, createdAt: number, x: number) {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const raw = finalizeWorldEvent(buildWorldMessageTemplate({ channel, content: `${content}-${attempt}`, createdAt,
			position: { x, y: 0 }, speechType: 'normal' }), secret);
		if (BigInt(`0x${raw.id}`) % 5n === 0n) return raw;
	}
	throw new Error('Could not create deterministic trace root.');
}

describe('Trace interaction reward settlement', () => {
	beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));
	afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

	it('settles old unread roots and validated unread replies once, then retires an old-Run claim', async () => {
		const persona = await activePersona();
		const rootForReplyRaw = makeTraceRoot(SELF_SECRET, 'reply root', 1, 0);
		const rootForRewardRaw = makeTraceRoot(OTHER_SECRET, 'unread root', 1, 1);
		const rootForReply = parseWorldMessage(rootForReplyRaw, CHANNEL_ID)!;
		const rootForReward = parseWorldMessage(rootForRewardRaw, CHANNEL_ID)!;
		const replyRaw = finalizeWorldEvent(buildTraceReplyTemplate({ root: rootForReply, parent: rootForReply,
			content: 'a reply to the current Identity', speechType: 'normal', createdAt: 2 }), OTHER_SECRET);
		const candidate = parseTraceReplyCandidate(replyRaw)!;
		const reply = validateTraceReplyCandidate(candidate, rootForReply, rootForReply)!;
		const effectiveRoots = await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 },
			rawEvents: [rootForReplyRaw, rootForRewardRaw] });
		await reconcileTraceReplyCache({ channelId: CHANNEL_ID, effectiveRoots, rawEvents: [replyRaw], personaPubkey: SELF });
		const rewardTarget = { identity: persona.activeRun.identity, runNumber: persona.activeRun.runNumber };
		await expect(markTraceRootRead({ channelId: CHANNEL_ID, personaPubkey: SELF, rootId: rootForReward.id, rewardTarget })).resolves.toBe(true);
		await expect(markTraceReplyRead({ channelId: CHANNEL_ID, personaPubkey: SELF, rootId: rootForReply.id,
			replyId: reply.id, rewardTarget, rewardEvidence: { id: reply.id, pubkey: reply.pubkey, parentPubkey: reply.parentPubkey } })).resolves.toBe(true);
		expect(await loadPendingTraceRewardOutbox()).toHaveLength(2);

		expect(await settlePendingTraceRewards({ kind: 'trace-root-read', channelId: CHANNEL_ID, eventId: rootForReward.id })).toEqual([{ points: 5 }]);
		expect(await settlePendingTraceRewards({ kind: 'trace-reply-read', channelId: CHANNEL_ID, eventId: reply.id })).toEqual([{ points: 10 }]);
		// Background reconciliation remains silent when there is no new settlement.
		expect(await settlePendingTraceRewards()).toEqual([]);
		const rewarded = await loadOrCreateLifecycle();
		expect(rewarded.kind).toBe('restored');
		if (rewarded.kind !== 'restored') return;
		expect(rewarded.persona.gameState.points).toBe(persona.gameState.points + 15);
		expect(rewarded.persona.activeRun.revision).toBe(persona.activeRun.revision + 2);
		await settlePendingTraceRewards();
		const repeated = await loadOrCreateLifecycle();
		expect(repeated.kind === 'restored' ? repeated.persona.gameState.points : -1).toBe(persona.gameState.points + 15);

		const staleRootRaw = makeTraceRoot(OTHER_SECRET, 'old Run', 3, 2);
		const staleRoot = parseWorldMessage(staleRootRaw, CHANNEL_ID)!;
		await reconcileTraceRootCache({ channelId: CHANNEL_ID, field: { columns: 10, rows: 1 }, rawEvents: [staleRootRaw] });
		await markTraceRootRead({ channelId: CHANNEL_ID, personaPubkey: SELF, rootId: staleRoot.id,
			rewardTarget: { identity: persona.activeRun.identity, runNumber: persona.activeRun.runNumber + 1 } });
		await settlePendingTraceRewards();
		const traceDb = await openTraceDatabase();
		const staleOutbox = (await traceDb.getAll(TRACE_REWARD_OUTBOX_STORE)).find((record) => record.eventId === staleRoot.id);
		expect(staleOutbox?.status).toBe('stale');
		traceDb.close();
		const current = await loadOrCreateLifecycle();
		expect(current.kind === 'restored' ? current.persona.gameState.points : -1).toBe(persona.gameState.points + 15);
	});

	it('deduplicates reply-post rewards by Identity, Run, and immediate parent', async () => {
		const persona = await activePersona();
		const request = { kind: 'trace-reply-post' as const, channelId: CHANNEL_ID, eventId: 'b'.repeat(64), parentId: 'c'.repeat(64),
			identity: persona.activeRun.identity, runNumber: persona.activeRun.runNumber };
		expect(await applyInteractionReward(request)).toEqual({ kind: 'applied' });
		expect(await applyInteractionReward({ ...request, eventId: 'd'.repeat(64) })).toEqual({ kind: 'duplicate' });
		const current = await loadOrCreateLifecycle();
		expect(current.kind === 'restored' ? current.persona.gameState.points : -1).toBe(persona.gameState.points + 10);
	});
});
