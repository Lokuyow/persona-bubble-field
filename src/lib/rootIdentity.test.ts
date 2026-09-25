import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { finalizeEvent } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATABASE_NAME,
	DATABASE_VERSION,
	LIFECYCLE_UPGRADE_BLOCKED_MESSAGE,
	PLAYER_LIFECYCLE_STORE_NAME,
	ROOT_SECRET_STORE_NAME,
	WORLD_WRITE_JOURNAL_STORE_NAME,
	applyRealtimeOutcome,
	applyRealtimeLifespanLoss,
	activateTagGameRun,
	applyTagGameCumulative,
	completeRealtimeEventInstance,
	clearPersona,
	confirmWorldPosition,
	collectMending,
	exportClearedIdentityNsec,
	getRealtimeSettlementLedger,
	loadOrCreateLifecycle,
	loadWorldWriteJournal,
	reserveWorldPositive,
	selectIdentity,
	startMending,
	trackRealtimeEventInstance,
	reserveTagGameParticipation,
	confirmTagGameParticipation,
	beginTagGameReservationRecovery,
	transitionRealtimeDeath,
	transitionExpiredPersona,
	upgradePersonaAbility,
	type LoadLifecycleResult,
	type PendingSelection,
	type PersonaSnapshot,
	type SelectIdentityOptions
} from './rootIdentity';
import type { RootBuild } from './rootProgression';
import { buildWorldStateEventTemplate } from './nostrProtocol';
import { projectMending } from './mending';

const TIME = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const connections: IDBPDatabase[] = [];
const ZERO_BUILD: RootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 };
type SelectingLifecycle = Readonly<{ kind: 'selecting'; selection: PendingSelection; rootPoints: number }>;

async function records(storeName: string): Promise<Record<string, unknown>> {
	const db = await openDB(DATABASE_NAME, DATABASE_VERSION);
	connections.push(db);
	const tx = db.transaction(storeName, 'readonly');
	const keys = await tx.store.getAllKeys();
	const values = await tx.store.getAll();
	await tx.done;
	return Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
}

async function putPlayer(value: unknown): Promise<void> {
	const db = await openDB(DATABASE_NAME, DATABASE_VERSION);
	connections.push(db);
	await db.put(PLAYER_LIFECYCLE_STORE_NAME, value, 'player-lifecycle');
}

function restored(result: LoadLifecycleResult): PersonaSnapshot {
	if (result.kind !== 'restored') throw new Error('Expected a running lifecycle.');
	return result.persona;
}

async function selected(build: RootBuild = ZERO_BUILD, options: SelectIdentityOptions = {}): Promise<PersonaSnapshot> {
	const pending = await loadOrCreateLifecycle();
	if (pending.kind !== 'created' && pending.kind !== 'selecting') throw new Error('Expected a pending selection.');
	const result = await selectIdentity(pending.selection.generation, pending.selection.candidates[0], build, options);
	if (result.kind !== 'selected') throw new Error(`Expected selected state, got ${result.kind}.`);
	return result.persona;
}

beforeEach(() => {
	vi.stubGlobal('indexedDB', new IDBFactory());
	vi.spyOn(Date, 'now').mockReturnValue(TIME);
});

afterEach(() => {
	while (connections.length) connections.pop()!.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('Root / Identity / Run lifecycle', () => {
	it('allows clear and ability upgrade during a tag-game reservation, then gates both during the Run lock and settles cumulatively once', async () => {
		const initial = await selected(ZERO_BUILD, { initialPoints: 200_000 });
		const gameId = `game-${'a'.repeat(64)}`;
		expect(await reserveTagGameParticipation(initial, gameId)).toBe(true);
		const upgraded = await upgradePersonaAbility(initial, 'inferenceEfficiency');
		expect(upgraded.kind).toBe('upgraded');
		if (upgraded.kind !== 'upgraded') return;
		const afterUpgrade = upgraded.persona;
		expect((await clearPersona(afterUpgrade)).kind).toBe('cleared');
	});

	it('allows only one simultaneous organizer reservation for the same Run', async () => {
		const persona = await selected();
		const [first, second] = await Promise.all([
			reserveTagGameParticipation(persona, `game-${'a'.repeat(64)}`),
			reserveTagGameParticipation(persona, `game-${'b'.repeat(64)}`)
		]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
	});

	it('accepts a normal final settlement arriving after 180 seconds, applies its delta atomically, and releases the Run', async () => {
		const persona = await selected(ZERO_BUILD, { initialPoints: 200_000 });
		const gameId = `game-${'b'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, gameId)).toBe(true);
		expect(await activateTagGameRun(persona, gameId, TIME, TIME + 180_000, TIME + 210_000)).toBe(true);
		expect(await clearPersona(persona)).toEqual({ kind: 'blocked', reason: 'tag-game' });
		expect((await upgradePersonaAbility(persona, 'inferenceEfficiency')).kind).toBe('blocked');
		expect(await trackRealtimeEventInstance(persona, 'cooperation-defection:official-instance')).toBe(true);
		const partial = await applyTagGameCumulative(persona, gameId, 250, HOUR, false);
		expect(partial.kind).toBe('applied');
		if (partial.kind !== 'applied') return;
		expect(partial.persona.gameState.points).toBe(persona.gameState.points + 250);
		expect(partial.persona.gameState.lifespanExpiresAtMs).toBe(persona.gameState.lifespanExpiresAtMs - HOUR);
		expect((await getRealtimeSettlementLedger(partial.persona))?.pendingInstanceIds).toEqual(['cooperation-defection:official-instance']);
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 185_000);
		const final = await applyTagGameCumulative(persona, gameId, 500, 2 * HOUR, true);
		expect(final.kind).toBe('applied');
		if (final.kind !== 'applied') return;
		expect(final.persona.gameState.points).toBe(persona.gameState.points + 500);
		expect(final.persona.gameState.lifespanExpiresAtMs).toBe(persona.gameState.lifespanExpiresAtMs - 2 * HOUR);
		expect((await getRealtimeSettlementLedger(final.persona))?.pendingInstanceIds).toEqual(['cooperation-defection:official-instance']);
		expect(await completeRealtimeEventInstance(final.persona, 'cooperation-defection:official-instance')).toBe(true);
		expect((await getRealtimeSettlementLedger(final.persona))?.pendingInstanceIds).toEqual([]);
		expect((await upgradePersonaAbility(final.persona, 'inferenceEfficiency')).kind).toBe('upgraded');
	});

	it('releases the last confirmed settlement after the finite final wait when reload cannot fetch a final event', async () => {
		const persona = await selected();
		const gameId = `game-${'d'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, gameId)).toBe(true);
		expect(await activateTagGameRun(persona, gameId, TIME, TIME + 180_000, TIME + 210_000)).toBe(true);
		const partial = await applyTagGameCumulative(persona, gameId, 300, HOUR, false);
		expect(partial.kind).toBe('applied');
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 210_001);
		const recovered = restored(await loadOrCreateLifecycle());
		expect(recovered.gameState.points).toBe(persona.gameState.points + 300);
		expect(recovered.gameState.lifespanExpiresAtMs).toBe(persona.gameState.lifespanExpiresAtMs - HOUR);
		expect((await upgradePersonaAbility(recovered, 'inferenceEfficiency')).kind).toBe('upgraded');
	});

	it('settles against effective work lifespan and atomically records a tag-game death with its exit receipt', async () => {
		const working = await selected(ZERO_BUILD, { initialLifespanMs: 2 * DAY });
		const started = await startMending(working);
		if (started.kind !== 'started') throw new Error('Expected mending to start.');
		const gameId = `game-${'e'.repeat(64)}`;
		expect(await reserveTagGameParticipation(started.persona, gameId)).toBe(true);
		expect(await activateTagGameRun(started.persona, gameId, TIME, TIME + 180_000, TIME + 210_000)).toBe(true);
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 60_000);
		const projection = projectMending(started.persona.gameState, TIME + 60_000, started.persona.activeRun.rootBuild);
		const survived = await applyTagGameCumulative(started.persona, gameId, 0, 60_000, false);
		expect(survived.kind).toBe('applied');
		const afterWorkLoss = restored(await loadOrCreateLifecycle());
		expect(afterWorkLoss.gameState.lifespanExpiresAtMs).toBe(projection.effectiveExpiresAtMs - 60_000);

		const deathGameId = gameId;
		expect(await trackRealtimeEventInstance(afterWorkLoss, 'cooperation-defection:death-instance')).toBe(true);
		const exit = { channelId: 'a'.repeat(64), position: { x: 4, y: 2 }, lastPositiveCreatedAt: Math.floor(TIME / 1000) };
		const death = await applyTagGameCumulative(afterWorkLoss, deathGameId, 4_500, 324_000_000, true, () => exit);
		expect(death.kind).toBe('transitioned');
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected next-generation selection after tag-game death.');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ pubkey: string; status: string }>; realtimeSettlementLedger: { tagGameReceipt?: { gameId: string; points: number; lifespanLossMs: number }; pendingInstanceIds: string[] } };
		expect(player.identities.find((identity) => identity.pubkey === working.signer.pubkey)?.status).toBe('dead');
		expect(player.realtimeSettlementLedger.tagGameReceipt).toEqual({ gameId: deathGameId, points: 4_500, lifespanLossMs: 324_000_000 });
		expect(player.realtimeSettlementLedger.pendingInstanceIds).toEqual([]);
		expect(Object.values(await records(WORLD_WRITE_JOURNAL_STORE_NAME))[0]).toMatchObject({ exitSecond: expect.any(Number) });
	});

	it('serializes Run close against game start so an old Run cannot enter after clear', async () => {
		const persona = await selected(ZERO_BUILD, { initialPoints: 200_000 });
		const gameId = `game-${'c'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, gameId)).toBe(true);
		const [activation, clearing] = await Promise.all([
			activateTagGameRun(persona, gameId, TIME, TIME + 180_000, TIME + 210_000),
			clearPersona(persona)
		]);
		if (clearing.kind === 'cleared') expect(activation).toBe(false);
		else {
			expect(clearing).toEqual({ kind: 'blocked', reason: 'tag-game' });
			expect(activation).toBe(true);
		}
	});

	it('expires an unaccepted join reservation after reload but retains a reservation confirmed by the organizer', async () => {
		const persona = await selected();
		const gameId = `game-${'9'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, gameId, true)).toBe(true);
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 30_001);
		expect((await loadOrCreateLifecycle()).kind).toBe('restored');
		expect(await reserveTagGameParticipation(persona, gameId, true)).toBe(true);
		expect(await confirmTagGameParticipation(persona, gameId)).toBe(true);
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 60_000);
		expect((await loadOrCreateLifecycle()).kind).toBe('restored');
		expect(await reserveTagGameParticipation(restored(await loadOrCreateLifecycle()), `${gameId}-other`)).toBe(false);
	});

	it('persists one finite known-game recovery deadline and clears it after a valid organizer state', async () => {
		const persona = await selected();
		const gameId = `${'9'.repeat(64)}:1:${'8'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, gameId)).toBe(true);
		const deadline = TIME + 30_000;
		expect(await beginTagGameReservationRecovery(persona, gameId, deadline)).toBe(true);
		expect(await beginTagGameReservationRecovery(persona, gameId, deadline + 30_000)).toBe(true);
		let restoredPersona = restored(await loadOrCreateLifecycle());
		expect(restoredPersona.tagGame?.reservation).toMatchObject({ gameId, recoveryDeadlineMs: deadline });
		expect(await confirmTagGameParticipation(restoredPersona, gameId)).toBe(true);
		restoredPersona = restored(await loadOrCreateLifecycle());
		expect(restoredPersona.tagGame?.reservation).toEqual({ gameId, identity: persona.activeRun.identity, runNumber: persona.activeRun.runNumber });
	});

	it('allows a new reservation to replace an expired pending reservation atomically', async () => {
		const persona = await selected();
		const oldGameId = `game-${'8'.repeat(64)}`;
		const nextGameId = `game-${'7'.repeat(64)}`;
		expect(await reserveTagGameParticipation(persona, oldGameId, true)).toBe(true);
		vi.spyOn(Date, 'now').mockReturnValue(TIME + 30_001);
		expect(await reserveTagGameParticipation(persona, nextGameId)).toBe(true);
		const current = restored(await loadOrCreateLifecycle());
		expect(current.tagGame?.reservation?.gameId).toBe(nextGameId);
	});

	it('preserves a valid v7 Root and active Player while adding the write journal', async () => {
		const original = await selected();
		const root = await records(ROOT_SECRET_STORE_NAME);
		const player = await records(PLAYER_LIFECYCLE_STORE_NAME);
		while (connections.length) connections.pop()!.close();
		vi.stubGlobal('indexedDB', new IDBFactory());
		const old = await openDB(DATABASE_NAME, 7, { upgrade(db) {
			db.createObjectStore(ROOT_SECRET_STORE_NAME);
			db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
		} });
		for (const [key, value] of Object.entries(root)) await old.put(ROOT_SECRET_STORE_NAME, value, key);
		for (const [key, value] of Object.entries(player)) await old.put(PLAYER_LIFECYCLE_STORE_NAME, value, key);
		old.close();
		const upgraded = restored(await loadOrCreateLifecycle());
		expect(upgraded.signer.pubkey).toBe(original.signer.pubkey);
		expect(upgraded.activeRun.runNumber).toBe(original.activeRun.runNumber);
		expect(await records(WORLD_WRITE_JOURNAL_STORE_NAME)).toEqual({});
	});

	it('fails closed while an old tab blocks the v7 to v8 upgrade', async () => {
		const old = await openDB(DATABASE_NAME, 7, { upgrade(db) {
			db.createObjectStore(ROOT_SECRET_STORE_NAME);
			db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
		} });
		await expect(loadOrCreateLifecycle()).rejects.toThrow(LIFECYCLE_UPGRADE_BLOCKED_MESSAGE);
		old.close();
	});

	it('serializes slot reservations across tabs and never reuses a consumed second', async () => {
		const persona = await selected();
		const scope = { identity: persona.signer.identity, runNumber: persona.activeRun.runNumber, channelId: 'c'.repeat(64) };
		const input = { scope, kind: 'position' as const, nowSecond: TIME / 1000,
			observedSecond: null, observedConsumedSlots: 0 as const, observedExitSecond: null };
		const first = await reserveWorldPositive(input);
		const second = await reserveWorldPositive(input);
		expect(first).toMatchObject({ kind: 'reserved', reservation: { slot: 0 } });
		expect(second).toMatchObject({ kind: 'reserved', reservation: { slot: 1 } });
		expect(await reserveWorldPositive(input)).toEqual({ kind: 'wait', untilSecond: TIME / 1000 + 1 });
		expect(await reserveWorldPositive({ ...input, nowSecond: TIME / 1000 + 1 })).toMatchObject({ kind: 'reserved', reservation: { slot: 0 } });
		expect(await loadWorldWriteJournal(scope)).toMatchObject({ lastReservedSecond: TIME / 1000 + 1, consumedSlots: 1 });
	});

	it('commits the terminal fence with death and rejects an old Run reservation', async () => {
		const persona = await selected(ZERO_BUILD, { initialLifespanMs: 1_000 });
		const scope = { identity: persona.signer.identity, runNumber: persona.activeRun.runNumber, channelId: 'c'.repeat(64) };
		const reserved = await reserveWorldPositive({ scope, kind: 'position', nowSecond: TIME / 1000,
			observedSecond: null, observedConsumedSlots: 0, observedExitSecond: null });
		expect(reserved.kind).toBe('reserved');
		if (reserved.kind !== 'reserved') throw new Error('Expected a position reservation.');
		const oldEvent = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: scope.channelId, relayHint: 'wss://nos.lol/' },
			position: { x: 2, y: 1 }, slot: 0, createdAt: reserved.reservation.createdAt
		}), persona.signer.secretKey);
		vi.mocked(Date.now).mockReturnValue(TIME + 1_001);
		const result = await transitionExpiredPersona(persona, { channelId: scope.channelId,
			position: { x: 2, y: 1 }, lastPositiveCreatedAt: TIME / 1000 });
		expect(result).toMatchObject({ kind: 'transitioned', exit: { createdAt: Math.floor((TIME + 1_001) / 1000), position: { x: 2, y: 1 } } });
		const journal = Object.values(await records(WORLD_WRITE_JOURNAL_STORE_NAME))[0] as { exitSecond: number };
		expect(journal.exitSecond).toBe(Math.floor((TIME + 1_001) / 1000));
		expect(await confirmWorldPosition(scope, reserved.reservation, oldEvent)).toBe(false);
		expect(await reserveWorldPositive({ scope, kind: 'position', nowSecond: TIME / 1000 + 2,
			observedSecond: null, observedConsumedSlots: 0, observedExitSecond: null })).toEqual({ kind: 'stale' });
	});

	it('does not restore a confirmed position from an earlier Run of the same Identity', async () => {
		const first = await selected(ZERO_BUILD, { initialPoints: 100_000 });
		const channelId = 'c'.repeat(64);
		const scope = { identity: first.signer.identity, runNumber: first.activeRun.runNumber, channelId };
		const prior = await reserveWorldPositive({ scope, kind: 'position', nowSecond: TIME / 1000,
			observedSecond: null, observedConsumedSlots: 0, observedExitSecond: null });
		if (prior.kind !== 'reserved') throw new Error('Expected first Run reservation.');
		const oldEvent = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId, relayHint: 'wss://nos.lol/' }, position: { x: 2, y: 1 },
			slot: 0, createdAt: prior.reservation.createdAt
		}), first.signer.secretKey);
		expect(await confirmWorldPosition(scope, prior.reservation, oldEvent)).toBe(true);
		expect((await clearPersona(first)).kind).toBe('cleared');
		const selecting = await loadOrCreateLifecycle();
		if (selecting.kind !== 'selecting') throw new Error('Expected selection after clear.');
		const reusable = selecting.selection.reusableIdentities.find((item) => item.pubkey === first.signer.pubkey);
		if (!reusable) throw new Error('Expected reusable Identity.');
		const next = await selectIdentity(selecting.selection.generation, reusable,
			{ inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (next.kind !== 'selected') throw new Error(`Expected a new Run, got ${next.kind}.`);
		const nextScope = { identity: next.persona.signer.identity, runNumber: next.persona.activeRun.runNumber, channelId };
		expect((await loadWorldWriteJournal(nextScope))?.confirmedPosition).toBeNull();
		expect(await reserveWorldPositive({ scope: nextScope, kind: 'position', nowSecond: TIME / 1000,
			observedSecond: null, observedConsumedSlots: 0, observedExitSecond: null })).toEqual({ kind: 'wait', untilSecond: TIME / 1000 + 1 });
		expect(await reserveWorldPositive({ scope: nextScope, kind: 'position', nowSecond: TIME / 1000 + 1,
			observedSecond: null, observedConsumedSlots: 0, observedExitSecond: null })).toMatchObject({ kind: 'reserved', reservation: { slot: 0 } });
	});
	it('persists an explicit short initial lifespan, does not reset it on restore, and applies it to the next Run', async () => {
		const first = await selected(ZERO_BUILD, { initialLifespanMs: 3_000 });
		expect(first.gameState.lifespanExpiresAtMs).toBe(TIME + 3_000);
		expect(restored(await loadOrCreateLifecycle()).gameState.lifespanExpiresAtMs).toBe(TIME + 3_000);

		vi.mocked(Date.now).mockReturnValue(TIME + 3_001);
		expect((await transitionExpiredPersona(first)).kind).toBe('transitioned');
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected post-death selection.');

		vi.mocked(Date.now).mockReturnValue(TIME + 4_000);
		const second = await selectIdentity(pending.selection.generation, pending.selection.candidates[0], ZERO_BUILD, { initialLifespanMs: 3_000 });
		if (second.kind !== 'selected') throw new Error(`Expected selected state, got ${second.kind}.`);
		expect(second.persona.gameState.lifespanExpiresAtMs).toBe(TIME + 7_000);
	});

	it('creates a Root, fixed three selection, and no active signer before Run start', async () => {
		const result = await loadOrCreateLifecycle();
		expect(result.kind).toBe('created');
		if (result.kind !== 'created') return;
		expect(result.rootPoints).toBe(0);
		expect(result.selection.candidates).toHaveLength(3);
		expect(result.selection.reusableIdentities).toEqual([]);
		expect(Object.keys(await records(ROOT_SECRET_STORE_NAME)).sort()).toEqual(['encrypted-root-entropy', 'root-wrapping-key']);
	});

	it('keeps Root secret while resetting a v6 Player state automatically', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) { db.createObjectStore(ROOT_SECRET_STORE_NAME); db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME); } });
		const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const entropy = new Uint8Array(16).fill(7);
		const iv = new Uint8Array(12).fill(3);
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, entropy));
		await old.put(ROOT_SECRET_STORE_NAME, wrappingKey, 'root-wrapping-key');
		await old.put(ROOT_SECRET_STORE_NAME, { version: 1, iv, ciphertext }, 'encrypted-root-entropy');
		await old.put(PLAYER_LIFECYCLE_STORE_NAME, { schemaVersion: 1, mode: { kind: 'obsolete' } }, 'player-lifecycle');
		await old.close();
		const result = await loadOrCreateLifecycle();
		expect(result.kind).toBe('selecting');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { schemaVersion: number; rootPoints: number };
		expect(player).toMatchObject({ schemaVersion: 2, rootPoints: 0 });
		const root = (await records(ROOT_SECRET_STORE_NAME))['encrypted-root-entropy'] as { ciphertext: Uint8Array };
		expect([...root.ciphertext]).toEqual([...ciphertext]);
	});

	it('fails closed when valid v6 Root records have no Player lifecycle record', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) {
			db.createObjectStore(ROOT_SECRET_STORE_NAME);
			db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
		} });
		const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const entropy = new Uint8Array(16).fill(8);
		const iv = new Uint8Array(12).fill(4);
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, entropy));
		await old.put(ROOT_SECRET_STORE_NAME, wrappingKey, 'root-wrapping-key');
		await old.put(ROOT_SECRET_STORE_NAME, { version: 1, iv, ciphertext }, 'encrypted-root-entropy');
		await old.close();
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'partial-state' });
		expect(Object.keys(await records(PLAYER_LIFECYCLE_STORE_NAME))).toEqual([]);
		expect([...((await records(ROOT_SECRET_STORE_NAME))['encrypted-root-entropy'] as { ciphertext: Uint8Array }).ciphertext]).toEqual([...ciphertext]);
	});

	it('fails closed when a v6 Player record exists without Root records', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) {
			db.createObjectStore(ROOT_SECRET_STORE_NAME);
			db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
		} });
		await old.put(PLAYER_LIFECYCLE_STORE_NAME, { schemaVersion: 1, mode: { kind: 'obsolete' } }, 'player-lifecycle');
		await old.close();
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'partial-state' });
		expect(Object.keys(await records(PLAYER_LIFECYCLE_STORE_NAME))).toEqual(['player-lifecycle']);
	});

	it('fails closed for a v6 Root-only partial state', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) { db.createObjectStore(ROOT_SECRET_STORE_NAME); } });
		await old.close();
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'partial-state' });
	});

	it('fails closed for a v6 Player-only partial state', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) { db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME); } });
		await old.close();
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'partial-state' });
	});

	it('fails closed for an invalid v6 Root while keeping the migration boundary strict', async () => {
		const old = await openDB(DATABASE_NAME, 6, { upgrade(db) {
			db.createObjectStore(ROOT_SECRET_STORE_NAME);
			db.createObjectStore(PLAYER_LIFECYCLE_STORE_NAME);
		} });
		await old.put(ROOT_SECRET_STORE_NAME, { version: 99 }, 'encrypted-root-entropy');
		await old.put(PLAYER_LIFECYCLE_STORE_NAME, { schemaVersion: 1 }, 'player-lifecycle');
		await old.close();
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'root-record' });
	});

	it('fails closed for malformed current-schema Player state', async () => {
		await loadOrCreateLifecycle();
		await putPlayer({ schemaVersion: 2, rootPoints: -1, identities: [], mode: { kind: 'broken' } });
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'player-state' });
	});

	it('freezes Root build and restores it unchanged', async () => {
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'created') throw new Error('Expected the initial selection.');
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, rootPoints: 3 });
		const persona = await selected({ inferenceAcceleration: 1, contextCompression: 1, hallucinationResistance: 1 });
		expect(restored(await loadOrCreateLifecycle()).activeRun.rootBuild).toEqual(persona.activeRun.rootBuild);
		const invalid = await selectIdentity(1, { accountIndex: 1, pubkey: 'f'.repeat(64), characterId: persona.identity.characterId }, { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		expect(invalid.kind).not.toBe('selected');
	});

	it('settles work at an ability upgrade checkpoint without moving unclaimed points into owned points', async () => {
		const persona = await selected();
		const started = await startMending(persona);
		if (started.kind !== 'started') throw new Error('Expected started work.');
		await applyRealtimeOutcome(started.persona, { id: 'funding', kind: 'points', points: 10, instanceId: 'funding' });
		const funded = restored(await loadOrCreateLifecycle());
		vi.mocked(Date.now).mockReturnValue(TIME + HOUR);
		const upgraded = await upgradePersonaAbility(funded, 'inferenceEfficiency');
		expect(upgraded.kind).toBe('upgraded');
		if (upgraded.kind !== 'upgraded') return;
		expect(upgraded.persona.gameState.abilities.inferenceEfficiency).toBe(2);
		expect(upgraded.persona.gameState.points).toBe(9);
		expect(upgraded.persona.gameState.mendingJob?.unclaimedPoints).toBe(5);
		expect(upgraded.persona.gameState.mendingJob?.processedDurationMs).toBe(5 * 60 * 1000);
	});

	it('subtracts exactly 72 hours from an idle Run and preserves the Run', async () => {
		const persona = await selected();
		const prepareExit = vi.fn(() => ({ channelId: 'a'.repeat(64), position: { x: 2, y: 3 }, lastPositiveCreatedAt: Math.floor(TIME / 1000) }));
		const loss = await applyRealtimeLifespanLoss(persona, { id: 'lifespan-loss-idle', kind: 'lifespan-loss', lifespanLossMs: 72 * HOUR, instanceId: 'game-instance' }, prepareExit);
		expect(loss.kind).toBe('survived');
		expect(prepareExit).not.toHaveBeenCalled();
		const latest = restored(await loadOrCreateLifecycle());
		expect(latest.activeRun.runNumber).toBe(persona.activeRun.runNumber);
		expect(latest.gameState.lifespanExpiresAtMs).toBe(persona.gameState.lifespanExpiresAtMs - 72 * HOUR);
		expect((await getRealtimeSettlementLedger(latest))?.appliedOutcomeIds).toContain('lifespan-loss-idle');
	});

	it('checkpoints active Mending before subtracting lifespan without collecting points or losing carry', async () => {
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'created' && pending.kind !== 'selecting') throw new Error('Expected a pending selection.');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object;
		await putPlayer({ ...player, rootPoints: 1 });
		const persona = await selected({ inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 1 });
		const started = await startMending(persona);
		if (started.kind !== 'started') throw new Error('Expected started work.');
		const nowMs = TIME + 90 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(nowMs);
		const projection = projectMending(started.persona.gameState, nowMs, started.persona.activeRun.rootBuild);
		const loss = await applyRealtimeLifespanLoss(started.persona, { id: 'lifespan-loss-mending', kind: 'lifespan-loss', lifespanLossMs: 72 * HOUR, instanceId: 'game-instance' });
		expect(loss.kind).toBe('survived');
		const latest = restored(await loadOrCreateLifecycle());
		expect(latest.gameState.points).toBe(started.persona.gameState.points);
		expect(latest.gameState.lifespanExpiresAtMs).toBe(projection.effectiveExpiresAtMs - 72 * HOUR);
		expect(latest.gameState.pointProgressTicks).toBe(projection.pointProgressTicks);
		expect(latest.gameState.mendingJob).toMatchObject({
			startedAtMs: started.persona.gameState.mendingJob?.startedAtMs,
			checkpointAtMs: nowMs,
			processedDurationMs: projection.processedDurationMs,
			unclaimedPoints: projection.points
		});
	});

	it.each([3, 2] as const)('atomically closes the Run when a 72-hour loss leaves %s days of lifespan', async (daysRemaining) => {
		const persona = await selected(ZERO_BUILD, { initialLifespanMs: daysRemaining * DAY });
		const exit = { channelId: 'a'.repeat(64), position: { x: 2, y: 3 }, lastPositiveCreatedAt: Math.floor(TIME / 1000) };
		const prepareExit = vi.fn(() => exit);
		const loss = await applyRealtimeLifespanLoss(persona, { id: `lifespan-loss-death-${daysRemaining}`, kind: 'lifespan-loss', lifespanLossMs: 72 * HOUR, instanceId: 'game-instance' }, prepareExit);
		expect(loss.kind).toBe('transitioned');
		expect(prepareExit).toHaveBeenCalledOnce();
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected next-generation selection after death.');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ pubkey: string; status: string }>; realtimeSettlementLedger: { appliedOutcomeIds: string[]; pendingInstanceIds: string[] } };
		expect(player.identities.find((identity) => identity.pubkey === persona.signer.pubkey)?.status).toBe('dead');
		expect(player.realtimeSettlementLedger.appliedOutcomeIds).toContain(`lifespan-loss-death-${daysRemaining}`);
		expect(player.realtimeSettlementLedger.pendingInstanceIds).toEqual([]);
		const journal = Object.values(await records(WORLD_WRITE_JOURNAL_STORE_NAME))[0] as { exitSecond: number };
		expect(journal.exitSecond).toBeGreaterThanOrEqual(Math.floor(TIME / 1000));
	});

	it('does not prepare a terminal exit from an obsolete Run snapshot', async () => {
		const persona = await selected();
		const newer = restored(await loadOrCreateLifecycle());
		await applyRealtimeOutcome(newer, { id: 'revision-advance', kind: 'points', points: 1, instanceId: 'other-instance' });
		const prepareExit = vi.fn(() => ({ channelId: 'a'.repeat(64), position: { x: 2, y: 3 }, lastPositiveCreatedAt: Math.floor(TIME / 1000) }));
		const result = await applyRealtimeLifespanLoss(persona, { id: 'lifespan-loss-stale', kind: 'lifespan-loss', lifespanLossMs: 72 * HOUR, instanceId: 'game-instance' }, prepareExit);
		expect(result.kind).toBe('stale');
		expect(prepareExit).not.toHaveBeenCalled();
	});

	it('does not overwrite a competing ability upgrade and can retry against the current Run revision', async () => {
		const persona = await selected();
		expect((await applyRealtimeOutcome(persona, { id: 'upgrade-funding', kind: 'points', points: 1, instanceId: 'funding' })).kind).toBe('applied');
		const funded = restored(await loadOrCreateLifecycle());
		const outcome = { id: 'lifespan-loss-concurrent', kind: 'lifespan-loss' as const, lifespanLossMs: 72 * HOUR, instanceId: 'game-instance' };
		const [lossResult, upgradeResult] = await Promise.all([
			applyRealtimeLifespanLoss(funded, outcome),
			upgradePersonaAbility(funded, 'inferenceEfficiency')
		]);
		expect(['survived', 'stale', 'duplicate'].includes(lossResult.kind)).toBe(true);
		expect(['upgraded', 'superseded'].includes(upgradeResult.kind)).toBe(true);
		let latest = restored(await loadOrCreateLifecycle());
		if (!(await getRealtimeSettlementLedger(latest))?.appliedOutcomeIds.includes(outcome.id)) {
			expect((await applyRealtimeLifespanLoss(latest, outcome)).kind).toBe('survived');
			latest = restored(await loadOrCreateLifecycle());
		}
		if (latest.gameState.abilities.inferenceEfficiency === 1) {
			const upgraded = await upgradePersonaAbility(latest, 'inferenceEfficiency');
			expect(upgraded.kind).toBe('upgraded');
		}
		latest = restored(await loadOrCreateLifecycle());
		expect(latest.gameState.abilities.inferenceEfficiency).toBe(2);
		expect(latest.gameState.lifespanExpiresAtMs).toBe(funded.gameState.lifespanExpiresAtMs - 72 * HOUR);
	});

	it('deduplicates automatic message reservations across concurrent tabs in the active Run', async () => {
		const persona = await selected();
		const input = { scope: { identity: persona.activeRun.identity, runNumber: persona.activeRun.runNumber, channelId: 'a'.repeat(64) },
			kind: 'message' as const, nowSecond: Math.floor(TIME / 1000), observedSecond: null, observedConsumedSlots: 0 as const,
			observedExitSecond: null, messageDedupeId: 'f'.repeat(64) };
		const results = await Promise.all([reserveWorldPositive(input), reserveWorldPositive(input)]);
		expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
		expect(results.filter((result) => result.kind === 'duplicate')).toHaveLength(1);
	});

	it('collects partial work as integer owned points and keeps the bucket active', async () => {
		const persona = await selected();
		const started = await startMending(persona);
		if (started.kind !== 'started') throw new Error('Expected started work.');
		vi.mocked(Date.now).mockReturnValue(TIME + 2 * 60 * 1000);
		const collected = await collectMending(started.persona);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.points).toBe(2);
		expect(collected.persona.gameState.mendingJob).toMatchObject({ processedDurationMs: 0, unclaimedPoints: 0, checkpointAtMs: TIME + 2 * 60 * 1000 });
	});

	it('converges concurrent collection and stale mutations through the Run revision', async () => {
		const persona = await selected();
		const started = await startMending(persona);
		if (started.kind !== 'started') throw new Error('Expected started work.');
		vi.mocked(Date.now).mockReturnValue(TIME + HOUR);
		const results = await Promise.all([collectMending(started.persona), collectMending(started.persona)]);
		expect(results.filter((result) => result.kind === 'collected')).toHaveLength(1);
		expect(results.some((result) => result.kind === 'superseded')).toBe(true);
		expect(restored(await loadOrCreateLifecycle()).gameState.points).toBe(5);
	});

	it('blocks clear while a realtime instance is pending and awards exactly one RP concurrently', async () => {
		const persona = await selected();
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...persona.activeRun, gameState: { ...persona.gameState, points: 100_000 } } } });
		const funded = restored(await loadOrCreateLifecycle());
		expect(await trackRealtimeEventInstance(funded, 'cooperation-defection-pending')).toBe(true);
		expect(await clearPersona(funded)).toEqual({ kind: 'blocked', reason: 'pending-realtime' });
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, realtimeSettlementLedger: { schemaVersion: 1, identity: funded.activeRun.identity, runNumber: funded.activeRun.runNumber, pendingInstanceIds: [], appliedOutcomeIds: [] } });
		const current = restored(await loadOrCreateLifecycle());
		const results = await Promise.all([clearPersona(current), clearPersona(current)]);
		expect(results.filter((result) => result.kind === 'cleared')).toHaveLength(1);
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { rootPoints: number; mode: { kind: string } };
		expect(lifecycle).toMatchObject({ rootPoints: 1, mode: { kind: 'selecting' } });
	});

	it('reuses a cleared Identity for a fresh Run and permits nsec only after clear', async () => {
		const persona = await selected();
		expect(await exportClearedIdentityNsec(persona.activeRun.identity)).toBeNull();
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...persona.activeRun, gameState: { ...persona.gameState, points: 100_000 } } } });
		const funded = restored(await loadOrCreateLifecycle());
		expect((await clearPersona(funded)).kind).toBe('cleared');
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected post-clear selection.');
		const cleared = pending.selection.reusableIdentities[0];
		expect(cleared.pubkey).toBe(persona.signer.pubkey);
		const nsec = await exportClearedIdentityNsec({ generation: cleared.generation, accountIndex: cleared.accountIndex, pubkey: cleared.pubkey });
		expect(nsec).toMatch(/^nsec1/);
		const fresh = await selectIdentity(pending.selection.generation, cleared, { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		expect(fresh.kind).toBe('selected');
		if (fresh.kind !== 'selected') return;
		expect(fresh.persona.signer.pubkey).toBe(persona.signer.pubkey);
		expect(fresh.persona.activeRun.runNumber).toBe(2);
		expect(fresh.persona.gameState.points).toBe(0);
		expect(fresh.persona.gameState.abilities).toEqual({ inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
	});

	it('keeps all previously cleared Identities reusable after consecutive normal clears', async () => {
		const fundAndClear = async (persona: PersonaSnapshot): Promise<SelectingLifecycle> => {
			await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...persona.activeRun, gameState: { ...persona.gameState, points: 100_000 } } } });
			const funded = restored(await loadOrCreateLifecycle());
			expect((await clearPersona(funded)).kind).toBe('cleared');
			const pending = await loadOrCreateLifecycle();
			if (pending.kind !== 'selecting') throw new Error('Expected post-clear selection.');
			return pending as SelectingLifecycle;
		};

		const first = await selected();
		const afterFirstClear = await fundAndClear(first);
		const second = await selectIdentity(afterFirstClear.selection.generation, afterFirstClear.selection.candidates[0], { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (second.kind !== 'selected') throw new Error('Expected the second Run.');
		const afterSecondClear = await fundAndClear(second.persona);
		expect(afterSecondClear.selection.reusableIdentities.map((identity) => identity.pubkey)).toEqual(expect.arrayContaining([first.identity.pubkey, second.persona.identity.pubkey]));

		const firstCandidate = afterSecondClear.selection.reusableIdentities.find((identity) => identity.pubkey === first.identity.pubkey);
		if (!firstCandidate) throw new Error('Expected the first cleared Identity to remain reusable.');
		const reusedFirst = await selectIdentity(afterSecondClear.selection.generation, firstCandidate, { inferenceAcceleration: 2, contextCompression: 0, hallucinationResistance: 0 });
		if (reusedFirst.kind !== 'selected') throw new Error('Expected the cleared Identity to start again.');
		expect(reusedFirst.persona.signer.pubkey).toBe(first.signer.pubkey);
		expect(reusedFirst.persona.activeRun.runNumber).toBe(2);
		const afterReusedFirstClear = await fundAndClear(reusedFirst.persona);
		expect(afterReusedFirstClear.selection.reusableIdentities.map((identity) => identity.pubkey)).toEqual(expect.arrayContaining([first.identity.pubkey, second.persona.identity.pubkey]));
	});

	it('keeps every cleared Identity reusable after later clears while excluding dead Identities', async () => {
		const fundAndClear = async (persona: PersonaSnapshot): Promise<SelectingLifecycle> => {
			await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...persona.activeRun, gameState: { ...persona.gameState, points: 100_000 } } } });
			const funded = restored(await loadOrCreateLifecycle());
			expect((await clearPersona(funded)).kind).toBe('cleared');
			const pending = await loadOrCreateLifecycle();
			if (pending.kind !== 'selecting') throw new Error('Expected post-clear selection.');
			return pending as SelectingLifecycle;
		};

		const first = await selected();
		const afterFirstClear = await fundAndClear(first);
		const second = await selectIdentity(afterFirstClear.selection.generation, afterFirstClear.selection.candidates[0], { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (second.kind !== 'selected') throw new Error('Expected the second Run.');
		vi.mocked(Date.now).mockReturnValue(TIME + DAY * 7);
		expect((await transitionExpiredPersona(second.persona)).kind).toBe('transitioned');
		const afterDeath = await loadOrCreateLifecycle();
		if (afterDeath.kind !== 'selecting') throw new Error('Expected post-death selection.');
		const third = await selectIdentity(afterDeath.selection.generation, afterDeath.selection.candidates[0], { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (third.kind !== 'selected') throw new Error('Expected the third Run.');
		const afterThirdClear = await fundAndClear(third.persona);
		const reusableAfterThird = afterThirdClear.selection.reusableIdentities.map((identity) => identity.pubkey);
		expect(reusableAfterThird).toEqual(expect.arrayContaining([first.identity.pubkey, third.persona.identity.pubkey]));
		expect(reusableAfterThird).not.toContain(second.persona.identity.pubkey);

		const firstCandidate = afterThirdClear.selection.reusableIdentities.find((identity) => identity.pubkey === first.identity.pubkey);
		if (!firstCandidate) throw new Error('Expected the first cleared Identity to remain reusable.');
		const reusedFirst = await selectIdentity(afterThirdClear.selection.generation, firstCandidate, { inferenceAcceleration: 2, contextCompression: 0, hallucinationResistance: 0 });
		if (reusedFirst.kind !== 'selected') throw new Error('Expected the cleared Identity to start again.');
		expect(reusedFirst.persona.signer.pubkey).toBe(first.signer.pubkey);
		expect(reusedFirst.persona.activeRun.runNumber).toBe(2);
		const afterReusedFirstClear = await fundAndClear(reusedFirst.persona);
		expect(afterReusedFirstClear.selection.reusableIdentities.map((identity) => identity.pubkey)).toEqual(expect.arrayContaining([first.identity.pubkey, third.persona.identity.pubkey]));
	});

	it('does not expose cleared Identities after a later normal death', async () => {
		const first = await selected();
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...first.activeRun, gameState: { ...first.gameState, points: 100_000 } } } });
		const funded = restored(await loadOrCreateLifecycle());
		expect((await clearPersona(funded)).kind).toBe('cleared');
		const afterClear = await loadOrCreateLifecycle();
		if (afterClear.kind !== 'selecting') throw new Error('Expected post-clear selection.');
		const next = await selectIdentity(afterClear.selection.generation, afterClear.selection.candidates[0], { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (next.kind !== 'selected') throw new Error('Expected the next Run.');
		vi.mocked(Date.now).mockReturnValue(TIME + DAY * 7);
		expect((await transitionExpiredPersona(next.persona)).kind).toBe('transitioned');
		const afterDeath = await loadOrCreateLifecycle();
		if (afterDeath.kind !== 'selecting') throw new Error('Expected post-death selection.');
		expect(afterDeath.selection.reusableIdentities).toEqual([]);
		expect(afterDeath.selection.candidates).toHaveLength(3);
		expect(afterDeath.selection.candidates.some((candidate) => candidate.pubkey === first.identity.pubkey)).toBe(false);
	});

	it('uses the same fixed-three-only selection after realtime death', async () => {
		const first = await selected();
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...first.activeRun, gameState: { ...first.gameState, points: 100_000 } } } });
		const funded = restored(await loadOrCreateLifecycle());
		expect((await clearPersona(funded)).kind).toBe('cleared');
		const afterClear = await loadOrCreateLifecycle();
		if (afterClear.kind !== 'selecting') throw new Error('Expected post-clear selection.');
		const next = await selectIdentity(afterClear.selection.generation, afterClear.selection.candidates[0], { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 });
		if (next.kind !== 'selected') throw new Error('Expected the next Run.');
		expect((await transitionRealtimeDeath(next.persona, { id: 'realtime-death', kind: 'death', instanceId: 'realtime-death' })).kind).toBe('transitioned');
		const afterDeath = await loadOrCreateLifecycle();
		if (afterDeath.kind !== 'selecting') throw new Error('Expected post-realtime-death selection.');
		expect(afterDeath.selection.reusableIdentities).toEqual([]);
		expect(afterDeath.selection.candidates).toHaveLength(3);
	});

	it('applies initial points only when creating a fresh Run', async () => {
		const first = await selected(ZERO_BUILD, { initialPoints: 100_000 });
		expect(first.gameState.points).toBe(100_000);

		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...first.activeRun, gameState: { ...first.gameState, points: 42 } } } });
		expect(restored(await loadOrCreateLifecycle()).gameState.points).toBe(42);

		vi.mocked(Date.now).mockReturnValue(TIME + 1);
		const current = restored(await loadOrCreateLifecycle());
		await putPlayer({ ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...current.activeRun, gameState: { ...current.gameState, points: 100_000 } } } });
		expect((await clearPersona(restored(await loadOrCreateLifecycle()))).kind).toBe('cleared');
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected post-clear selection.');
		const reusable = pending.selection.reusableIdentities[0];
		if (!reusable) throw new Error(`Expected reusable Identity: ${JSON.stringify(pending.selection)}`);
		const reused = await selectIdentity(pending.selection.generation, reusable, { inferenceAcceleration: 1, contextCompression: 0, hallucinationResistance: 0 }, { initialPoints: 100_000 });
		if (reused.kind !== 'selected') throw new Error(`Expected reused Run, got ${reused.kind}.`);
		expect(reused.persona.activeRun.runNumber).toBe(2);
		expect(reused.persona.signer.pubkey).toBe(first.signer.pubkey);
		expect(reused.persona.gameState.points).toBe(100_000);
	});

	it('does not transition a realtime death twice or from a stale lifecycle', async () => {
		const first = await selected();
		const outcome = { id: 'realtime-death-once', kind: 'death' as const, instanceId: 'realtime-death-instance' };
		expect((await transitionRealtimeDeath(first, outcome)).kind).toBe('transitioned');
		expect((await transitionRealtimeDeath(first, outcome)).kind).toBe('stale');

		const running = await selected();
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as Record<string, unknown>;
		await putPlayer({ ...player, realtimeSettlementLedger: {
			schemaVersion: 1,
			identity: running.activeRun.identity,
			runNumber: running.activeRun.runNumber,
			pendingInstanceIds: [],
			appliedOutcomeIds: [outcome.id]
		} });
		expect((await transitionRealtimeDeath(running, outcome)).kind).toBe('duplicate');
	});

	it('does not award RP on death and does not reuse a dead Identity', async () => {
		const persona = await selected();
		vi.mocked(Date.now).mockReturnValue(TIME + DAY * 7);
		expect((await transitionExpiredPersona(persona)).kind).toBe('transitioned');
		const pending = await loadOrCreateLifecycle();
		if (pending.kind !== 'selecting') throw new Error('Expected selection.');
		expect(pending.rootPoints).toBe(0);
		expect(pending.selection.reusableIdentities).toEqual([]);
	});

	it('keeps a pending ledger scoped to the active Run', async () => {
		const persona = await selected();
		expect(await trackRealtimeEventInstance(persona, 'io.github.lokuyow.persona-bubble-field:realtime:rift:1:instance:2026-09-24')).toBe(true);
		expect(await trackRealtimeEventInstance(persona, 'cooperation-defection:1:instance:2026-09-24')).toBe(true);
		expect((await getRealtimeSettlementLedger(persona))?.pendingInstanceIds).toHaveLength(2);
		expect(await completeRealtimeEventInstance(persona, 'io.github.lokuyow.persona-bubble-field:realtime:rift:1:instance:2026-09-24')).toBe(true);
		expect((await getRealtimeSettlementLedger(persona))?.pendingInstanceIds).toEqual(['cooperation-defection:1:instance:2026-09-24']);
	});
});
