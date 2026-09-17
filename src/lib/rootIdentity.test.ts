import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATABASE_NAME,
	DATABASE_VERSION,
	PLAYER_LIFECYCLE_STORE_NAME,
	ROOT_SECRET_STORE_NAME,
	authorizeActiveRun,
	collectMending,
	applyRealtimeOutcome,
	completeRealtimeEventInstance,
	getRealtimeSettlementLedger,
	trackRealtimeEventInstance,
	transitionRealtimeDeath,
	loadOrCreateLifecycle,
	selectIdentity,
	startMending,
	upgradePersonaAbility,
	transitionExpiredPersona,
	type LoadLifecycleResult,
	type PersonaSnapshot
} from './rootIdentity';

const TIME = 1_700_000_000_000;
const connections: IDBPDatabase[] = [];

async function records(storeName: string): Promise<Record<string, unknown>> {
	const db = await openDB(DATABASE_NAME, DATABASE_VERSION);
	connections.push(db);
	const tx = db.transaction(storeName, 'readonly');
	const keys = await tx.store.getAllKeys();
	const values = await tx.store.getAll();
	await tx.done;
	return Object.fromEntries(keys.map((key, index) => [String(key), values[index]]));
}

async function putRecord(storeName: string, key: string, value: unknown): Promise<void> {
	const db = await openDB(DATABASE_NAME, DATABASE_VERSION);
	connections.push(db);
	await db.put(storeName as never, value as never, key);
}

async function deleteRecord(storeName: string, key: string): Promise<void> {
	const db = await openDB(DATABASE_NAME, DATABASE_VERSION);
	connections.push(db);
	await db.delete(storeName as never, key);
}

function restored(result: LoadLifecycleResult): PersonaSnapshot {
	if (result.kind !== 'restored') throw new Error('Expected a running lifecycle.');
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
	it('atomically creates a root and a fixed three-candidate selection', async () => {
		const result = await loadOrCreateLifecycle();
		expect(result.kind).toBe('created');
		if (result.kind !== 'created') return;
		expect(result.selection.candidates).toHaveLength(3);
		expect(new Set(result.selection.candidates.map((candidate) => candidate.characterId)).size).toBe(3);
		expect(Object.keys(await records(ROOT_SECRET_STORE_NAME)).sort()).toEqual(['encrypted-root-entropy', 'root-wrapping-key']);
		expect(Object.keys(await records(PLAYER_LIFECYCLE_STORE_NAME))).toEqual(['player-lifecycle']);
		const rootRecords = await records(ROOT_SECRET_STORE_NAME);
		await expect(crypto.subtle.exportKey('raw', rootRecords['root-wrapping-key'] as CryptoKey)).rejects.toBeDefined();
	});

	it('cleanly replaces pre-v5 prototype stores instead of reading them', async () => {
		const old = await openDB(DATABASE_NAME, 4, {
			upgrade(db) {
				db.createObjectStore('persona-bubble-field-account-state');
				db.createObjectStore('persona-bubble-field-game-state');
			}
		});
		await old.put('persona-bubble-field-account-state', 'old', 'secret-key');
		await old.put('persona-bubble-field-game-state', { version: 1 }, 'game-state');
		await old.close();
		const result = await loadOrCreateLifecycle();
		expect(result.kind).toBe('created');
		const db = await openDB(DATABASE_NAME);
		expect(Array.from(db.objectStoreNames).sort()).toEqual([PLAYER_LIFECYCLE_STORE_NAME, ROOT_SECRET_STORE_NAME].sort());
		await db.close();
	});

	it('converges concurrent fresh initialization on one pending selection', async () => {
		const results = await Promise.all([loadOrCreateLifecycle(), loadOrCreateLifecycle(), loadOrCreateLifecycle()]);
		const selections = results.map((result) => result.kind === 'created' || result.kind === 'selecting' ? result.selection : null);
		expect(selections.every(Boolean)).toBe(true);
		expect(JSON.stringify(selections[0])).toBe(JSON.stringify(selections[1]));
		expect(JSON.stringify(selections[1])).toBe(JSON.stringify(selections[2]));
	});

	it('converges conflicting concurrent candidate selections on one Identity', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const [first, second] = await Promise.all([
			selectIdentity(selection.selection.generation, selection.selection.candidates[0]),
			selectIdentity(selection.selection.generation, selection.selection.candidates[1])
		]);
		expect([first.kind, second.kind].filter((kind) => kind === 'selected')).toHaveLength(1);
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: unknown[]; mode: { kind: string } };
		expect(lifecycle.identities).toHaveLength(1);
		expect(lifecycle.mode.kind).toBe('running');
	});

	it('authorizes only the persisted current Identity and Run, independent of revision', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const candidate = selection.selection.candidates[0];
		const identity = { generation: 1, accountIndex: candidate.accountIndex, pubkey: candidate.pubkey };
		expect(await authorizeActiveRun({ identity, runNumber: 1 })).toBe('superseded');
		const selected = await selectIdentity(selection.selection.generation, candidate);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		expect(await authorizeActiveRun({ identity, runNumber: 1 })).toBe('authorized');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		expect(await authorizeActiveRun({ identity, runNumber: 1 })).toBe('authorized');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 24 * 60 * 60 * 1000);
		expect((await transitionExpiredPersona(started.persona)).kind).toBe('transitioned');
		expect(await authorizeActiveRun({ identity, runNumber: 1 })).toBe('superseded');
	});

	it('atomically applies a realtime points outcome once across concurrent tabs', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		expect(await trackRealtimeEventInstance(selected.persona, 'rift-instance')).toBe(true);
		const outcome = { id: 'rift-instance:outcome-1', kind: 'points' as const, points: 100, instanceId: 'rift-instance' };
		const results = await Promise.all([applyRealtimeOutcome(selected.persona, outcome), applyRealtimeOutcome(selected.persona, outcome)]);
		expect(results.filter((result) => result.kind === 'applied')).toHaveLength(1);
		expect(results.some((result) => result.kind === 'duplicate')).toBe(true);
		const current = restored(await loadOrCreateLifecycle());
		expect(current.gameState.points).toBe(100);
		const ledger = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { realtimeSettlementLedger: { appliedOutcomeIds: string[]; pendingInstanceIds: string[] } };
		expect(ledger.realtimeSettlementLedger.appliedOutcomeIds).toEqual([outcome.id]);
		expect(ledger.realtimeSettlementLedger.pendingInstanceIds).toEqual(['rift-instance']);
		expect(await completeRealtimeEventInstance(current, 'rift-instance')).toBe(true);
		expect((await getRealtimeSettlementLedger(current))?.pendingInstanceIds).toEqual([]);
	});

	it('retains recovery markers until each instance is explicitly complete', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		await trackRealtimeEventInstance(selected.persona, 'rift-instance-1');
		await trackRealtimeEventInstance(selected.persona, 'rift-instance-2');
		await applyRealtimeOutcome(selected.persona, { id: 'outcome-1', kind: 'points', points: 20, instanceId: 'rift-instance-1' });
		await applyRealtimeOutcome(selected.persona, { id: 'outcome-2', kind: 'points', points: 10, instanceId: 'rift-instance-2' });
		const afterPoints = restored(await loadOrCreateLifecycle());
		expect((await getRealtimeSettlementLedger(afterPoints))?.pendingInstanceIds).toEqual(['rift-instance-1', 'rift-instance-2']);
		expect(await completeRealtimeEventInstance(afterPoints, 'rift-instance-1')).toBe(true);
		expect((await getRealtimeSettlementLedger(afterPoints))?.pendingInstanceIds).toEqual(['rift-instance-2']);
		expect(await completeRealtimeEventInstance(afterPoints, 'rift-instance-2')).toBe(true);
		expect((await getRealtimeSettlementLedger(afterPoints))?.pendingInstanceIds).toEqual([]);
	});

	it('does not add points to an expired run and closes an event-death run only once', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 7 * 24 * 60 * 60 * 1000);
		const expired = await applyRealtimeOutcome(selected.persona, { id: 'expired-points', kind: 'points', points: 20, instanceId: 'rift-instance' });
		expect(expired.kind).toBe('expired');
		expect(restored(await loadOrCreateLifecycle()).gameState.points).toBe(0);
		const death = { id: 'rift-instance:death-1', kind: 'death' as const, instanceId: 'rift-instance' };
		expect((await transitionRealtimeDeath(selected.persona, death)).kind).toBe('stale');

		vi.mocked(Date.now).mockReturnValue(TIME);
		const current = restored(await loadOrCreateLifecycle());
		expect((await transitionRealtimeDeath(current, death)).kind).toBe('transitioned');
		expect((await transitionRealtimeDeath(current, death)).kind).toBe('stale');
		expect((await applyRealtimeOutcome(current, { id: 'stale-points', kind: 'points', points: 20, instanceId: 'rift-instance' })).kind).toBe('stale');
		const selecting = await loadOrCreateLifecycle();
		expect(selecting.kind).toBe('selecting');
		if (selecting.kind === 'selecting') {
			expect(selecting.selection.generation).toBe(2);
			const fresh = await selectIdentity(selecting.selection.generation, selecting.selection.candidates[0]);
			if (fresh.kind !== 'selected') throw new Error('Expected the next run to be selected.');
			expect(await getRealtimeSettlementLedger(fresh.persona)).toEqual(expect.objectContaining({ pendingInstanceIds: [], appliedOutcomeIds: [] }));
		}
	});

	it('selects one candidate by CAS and re-derives the signer after reload', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const chosen = selection.selection.candidates[0];
		const unselected = selection.selection.candidates.slice(1).map((candidate) => candidate.characterId);
		const result = await selectIdentity(selection.selection.generation, chosen);
		expect(result.kind).toBe('selected');
		const persona = restored(await loadOrCreateLifecycle());
		expect(persona.signer.pubkey).toBe(chosen.pubkey);
		expect(persona.identity.characterId).toBe(chosen.characterId);
		expect(persona.activeRun.runNumber).toBe(1);
		expect(persona.activeRun.revision).toBe(0);
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ characterId: string }> };
		expect(lifecycle.identities.map((identity) => identity.characterId)).not.toEqual(expect.arrayContaining(unselected));
	});

	it('keeps concurrent mending mutations single-apply', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const [first, second] = await Promise.all([startMending(selected.persona), startMending(selected.persona)]);
		expect([first.kind, second.kind].sort()).toEqual(['started', expect.stringMatching(/blocked|superseded/)]);
		const started = first.kind === 'started' ? first.persona : second.kind === 'started' ? second.persona : null;
		if (!started) throw new Error('Expected a winning mending start.');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 60 * 60 * 1000);
		const collected = await collectMending(started);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.mendingJob).toEqual(expect.objectContaining({ startedAtMs: TIME + 8 * 60 * 60 * 1000 }));
		expect(collected.persona.activeRun.revision).toBe(2);
	});

	it('collects a partial bucket and rolls over without losing point progress', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const collectedAt = TIME + 2.48 * 60 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(collectedAt);
		const collected = await collectMending(started.persona);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.points).toBe(2);
		expect(collected.persona.gameState.pointProgressTicks).toBe(570_240_000);
		expect(collected.persona.gameState.mendingJob).toEqual(expect.objectContaining({ startedAtMs: collectedAt }));
		expect(collected.persona.activeRun.revision).toBe(2);
	});

	it('persists a zero-point partial collection and carries it into the next bucket', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const firstAt = TIME + 40 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(firstAt);
		const partial = await collectMending(started.persona);
		expect(partial.kind).toBe('collected');
		if (partial.kind !== 'collected') return;
		expect(partial.persona.gameState.points).toBe(0);
		expect(partial.persona.gameState.pointProgressTicks).toBe(792_000_000);
		vi.mocked(Date.now).mockReturnValue(firstAt + 20 * 60 * 1000);
		const completed = await collectMending(partial.persona);
		expect(completed.kind).toBe('collected');
		if (completed.kind !== 'collected') return;
		expect(completed.persona.gameState.points).toBe(1);
		expect(completed.persona.gameState.pointProgressTicks).toBe(0);
	});

	it('collects while persisted expiry has passed if projected lifespan remains', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const stored = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		stored.mode.activeRun.gameState.lifespanExpiresAtMs = TIME + 60 * 60 * 1000;
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', stored);
		const now = TIME + 2 * 60 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(now);
		const current = restored(await loadOrCreateLifecycle());
		const collected = await collectMending(current);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.points).toBe(2);
		expect(collected.persona.gameState.lifespanExpiresAtMs).toBeGreaterThan(now);
	});

	it('rejects collection at exact projected expiry without mutating the bucket', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const stored = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		stored.mode.activeRun.gameState.lifespanExpiresAtMs = TIME + 60 * 60 * 1000;
		stored.mode.activeRun.gameState.points = 7;
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', stored);
		const exactExpiry = TIME + 5 * 60 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(exactExpiry);
		const current = restored(await loadOrCreateLifecycle());
		const result = await collectMending(current);
		expect(result.kind).toBe('expired');
		if (result.kind !== 'expired') return;
		expect(result.persona.gameState.points).toBe(7);
		expect(result.persona.gameState.lifespanExpiresAtMs).toBe(TIME + 60 * 60 * 1000);
		expect(result.persona.gameState.mendingJob).toEqual(current.gameState.mendingJob);
		expect(result.persona.activeRun.revision).toBe(current.activeRun.revision);
		expect((await transitionExpiredPersona(result.persona)).kind).toBe('transitioned');
		expect((await loadOrCreateLifecycle()).kind).toBe('selecting');
	});

	it('single-applies concurrent and stale collection for one bucket', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const started = await startMending(selected.persona);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const now = TIME + 2 * 60 * 60 * 1000;
		vi.mocked(Date.now).mockReturnValue(now);
		const [first, second] = await Promise.all([collectMending(started.persona), collectMending(started.persona)]);
		expect([first.kind, second.kind].filter((kind) => kind === 'collected')).toHaveLength(1);
		expect([first.kind, second.kind].some((kind) => kind === 'superseded')).toBe(true);
		const after = restored(await loadOrCreateLifecycle());
		expect(after.gameState.points).toBe(2);
		expect(after.gameState.mendingJob).toEqual(expect.objectContaining({ startedAtMs: now }));
		expect(after.activeRun.revision).toBe(2);
		const stale = await collectMending(started.persona);
		expect(stale.kind).toBe('superseded');
		const unchanged = restored(await loadOrCreateLifecycle());
		expect(unchanged.gameState.points).toBe(2);
		expect(unchanged.activeRun.revision).toBe(2);
	});

	it('snapshots the latest abilities only for the next bucket after collection', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const stored = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		stored.mode.activeRun.gameState.points = 10;
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', stored);
		const funded = restored(await loadOrCreateLifecycle());
		const started = await startMending(funded);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const originalJob = started.persona.gameState.mendingJob;
		const upgraded = await upgradePersonaAbility(started.persona, 'inferenceEfficiency');
		expect(upgraded.kind).toBe('upgraded');
		if (upgraded.kind !== 'upgraded') return;
		expect(upgraded.persona.gameState.mendingJob).toEqual(originalJob);
		vi.mocked(Date.now).mockReturnValue(TIME + 60 * 60 * 1000);
		const collected = await collectMending(upgraded.persona);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.abilities.inferenceEfficiency).toBe(1);
		expect(collected.persona.gameState.mendingJob).toEqual(expect.objectContaining({
			maximumDurationMs: 8 * 60 * 60 * 1000,
			lifespanExtensionPerHour: { numerator: 9, denominator: 10 },
			pointIntervalMs: 60 * 60 * 1000
		}));
	});

	it('atomically upgrades abilities and preserves a running mending snapshot', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const seeded = { ...(await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object, mode: { kind: 'running', activeRun: { ...selected.persona.activeRun, gameState: { ...selected.persona.gameState, points: 10 } } } };
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', seeded);
		const funded = restored(await loadOrCreateLifecycle());
		const started = await startMending(funded);
		if (started.kind !== 'started') throw new Error('Expected mending start.');
		const job = started.persona.gameState.mendingJob;
		const actual = await upgradePersonaAbility(started.persona, 'inferenceEfficiency');
		expect(actual.kind).toBe('upgraded');
		if (actual.kind !== 'upgraded') return;
		expect(actual.persona.gameState.points).toBe(5);
		expect(actual.persona.gameState.abilities.inferenceEfficiency).toBe(1);
		expect(actual.persona.gameState.mendingJob).toEqual(job);
	});

	it('single-applies concurrent upgrades and does not lose different-ability updates', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const funded = { ...selected.persona, gameState: { ...selected.persona.gameState, points: 30 } };
		const stored = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object;
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', { ...stored, mode: { kind: 'running', activeRun: { ...funded.activeRun, gameState: funded.gameState } } });
		const current = restored(await loadOrCreateLifecycle());
		const [first, second] = await Promise.all([
			upgradePersonaAbility(current, 'inferenceEfficiency'),
			upgradePersonaAbility(current, 'hallucinationSuppression')
		]);
		expect([first.kind, second.kind].filter((kind) => kind === 'upgraded')).toHaveLength(1);
		const latest = restored(await loadOrCreateLifecycle());
		expect(latest.gameState.points).toBe(25);
		expect(latest.activeRun.revision).toBe(1);
	});

	it('does not commit an ability upgrade at exact expiry', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const stored = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as object;
		const fundedGameState = { ...selected.persona.gameState, points: 10 };
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', {
			...stored,
			mode: { kind: 'running', activeRun: { ...selected.persona.activeRun, gameState: fundedGameState } }
		});
		const funded = restored(await loadOrCreateLifecycle());
		vi.mocked(Date.now).mockReturnValue(funded.gameState.lifespanExpiresAtMs);
		const result = await upgradePersonaAbility(funded, 'inferenceEfficiency');
		expect(result.kind).toBe('expired');
		const latest = restored(await loadOrCreateLifecycle());
		expect(latest.gameState.points).toBe(10);
		expect(latest.gameState.abilities).toEqual(funded.gameState.abilities);
		expect(latest.activeRun.revision).toBe(funded.activeRun.revision);
		expect((await transitionExpiredPersona(funded)).kind).toBe('transitioned');
		expect((await loadOrCreateLifecycle()).kind).toBe('selecting');
	});

	it('treats stale mending after death as lifecycle supersession, not corruption', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 24 * 60 * 60 * 1000);
		expect((await transitionExpiredPersona(selected.persona)).kind).toBe('transitioned');
		const staleStart = await startMending(selected.persona);
		expect(staleStart.kind).toBe('superseded');
		if (staleStart.kind !== 'superseded') return;
		expect(staleStart.lifecycle.kind).toBe('selecting');

		const latest = await loadOrCreateLifecycle();
		if (latest.kind !== 'selecting') throw new Error('Expected pending selection.');
		const next = await selectIdentity(latest.selection.generation, latest.selection.candidates[0]);
		if (next.kind !== 'selected') throw new Error('Expected next selected state.');
		const staleCollect = await collectMending(selected.persona);
		expect(staleCollect.kind).toBe('superseded');
		if (staleCollect.kind === 'superseded') expect(staleCollect.lifecycle.kind).toBe('restored');
	});

	it('rolls back fresh initialization when the aggregate transaction aborts', async () => {
		const originalPut = IDBObjectStore.prototype.put;
		let fail = true;
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (fail && this.name === PLAYER_LIFECYCLE_STORE_NAME) {
				fail = false;
				throw new DOMException('Injected fresh transaction failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(loadOrCreateLifecycle()).rejects.toThrow('Account operation failed.');
		vi.mocked(IDBObjectStore.prototype.put).mockRestore();
		expect(await records(ROOT_SECRET_STORE_NAME)).toEqual({});
		expect(await records(PLAYER_LIFECYCLE_STORE_NAME)).toEqual({});
	});

	it('rolls back a mending mutation when its aggregate transaction aborts', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const originalPut = IDBObjectStore.prototype.put;
		let fail = true;
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (fail && this.name === PLAYER_LIFECYCLE_STORE_NAME) {
				fail = false;
				throw new DOMException('Injected mending transaction failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(startMending(selected.persona)).rejects.toThrow('Account operation failed.');
		vi.mocked(IDBObjectStore.prototype.put).mockRestore();
		const restoredPersona = restored(await loadOrCreateLifecycle());
		expect(restoredPersona.gameState.mendingJob).toBeNull();
	});

	it('rolls back death transition when its aggregate transaction aborts', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 24 * 60 * 60 * 1000);
		const originalPut = IDBObjectStore.prototype.put;
		let fail = true;
		vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
			if (fail && this.name === PLAYER_LIFECYCLE_STORE_NAME) {
				fail = false;
				throw new DOMException('Injected death transaction failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		});
		await expect(transitionExpiredPersona(selected.persona)).rejects.toThrow('Account operation failed.');
		vi.mocked(IDBObjectStore.prototype.put).mockRestore();
		const restoredPersona = restored(await loadOrCreateLifecycle());
		expect(restoredPersona.identity.status).toBe('alive');
		expect(restoredPersona.activeRun.runNumber).toBe(1);
	});

	it('closes the dead Identity and persists the next generation selection', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 24 * 60 * 60 * 1000);
		const transition = await transitionExpiredPersona(selected.persona);
		expect(transition.kind).toBe('transitioned');
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ status: string; runHistory: Array<{ outcome: string; runNumber: number }> }>; mode: { kind: string; pendingSelection: { generation: number; candidates: unknown[] } } };
		expect(lifecycle.identities).toHaveLength(1);
		expect(lifecycle.identities[0]).toMatchObject({ status: 'dead', runHistory: [{ outcome: 'dead', runNumber: 1 }] });
		expect(lifecycle.mode.kind).toBe('selecting');
		expect(lifecycle.mode.pendingSelection.generation).toBe(2);
		expect(lifecycle.mode.pendingSelection.candidates).toHaveLength(3);
	});

	it('allows an unselected character to reappear in a later generation without adding it to history', async () => {
		vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
			new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
			return array;
		});
		const initial = await loadOrCreateLifecycle();
		if (initial.kind !== 'created') throw new Error('Expected fresh state.');
		expect(initial.selection.candidates.map((candidate) => candidate.characterId)).toEqual(['011', '026', '039']);
		const selected = await selectIdentity(initial.selection.generation, initial.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 2 * 8 * 24 * 60 * 60 * 1000);
		expect((await transitionExpiredPersona(selected.persona)).kind).toBe('transitioned');
		const second = await loadOrCreateLifecycle();
		if (second.kind !== 'selecting') throw new Error('Expected second selection.');
		expect(second.selection.candidates.map((candidate) => candidate.characterId)).toEqual(['015', '010', '038']);
		const secondSelected = await selectIdentity(second.selection.generation, second.selection.candidates[0]);
		if (secondSelected.kind !== 'selected') throw new Error('Expected second selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 3 * 8 * 24 * 60 * 60 * 1000);
		expect((await transitionExpiredPersona(secondSelected.persona)).kind).toBe('transitioned');
		const third = await loadOrCreateLifecycle();
		if (third.kind !== 'selecting') throw new Error('Expected third selection.');
		expect(third.selection.candidates.map((candidate) => candidate.characterId)).toEqual(['040', '018', '014']);
		expect(third.selection.candidates[1].characterId).toBe('018');
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ characterId: string }> };
		expect(lifecycle.identities.map((identity) => identity.characterId)).not.toContain('018');
	});

	it('converges concurrent death transitions on one next generation', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const selected = await selectIdentity(selection.selection.generation, selection.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		vi.mocked(Date.now).mockReturnValue(TIME + 8 * 24 * 60 * 60 * 1000);
		const [first, second] = await Promise.all([
			transitionExpiredPersona(selected.persona),
			transitionExpiredPersona(selected.persona)
		]);
		expect([first.kind, second.kind].filter((kind) => kind === 'transitioned')).toHaveLength(1);
		const lifecycle = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as { identities: Array<{ generation: number; status: string }>; mode: { kind: string; pendingSelection?: { generation: number } } };
		expect(lifecycle.identities.filter((identity) => identity.status === 'dead')).toHaveLength(1);
		expect(lifecycle.mode).toEqual({ kind: 'selecting', pendingSelection: expect.objectContaining({ generation: 2 }) });
	});

	it('fails closed for partial, decrypt, derivation, and impossible generation state', async () => {
		const initial = await loadOrCreateLifecycle();
		if (initial.kind !== 'created') throw new Error('Expected fresh state.');
		await deleteRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle');
		expect((await loadOrCreateLifecycle()).kind).toBe('corrupt');

		vi.stubGlobal('indexedDB', new IDBFactory());
		const fresh = await loadOrCreateLifecycle();
		if (fresh.kind !== 'created') throw new Error('Expected fresh state after partial reset.');
		const root = await records(ROOT_SECRET_STORE_NAME);
		const encrypted = root['encrypted-root-entropy'] as { ciphertext: Uint8Array };
		encrypted.ciphertext[0] ^= 1;
		await putRecord(ROOT_SECRET_STORE_NAME, 'encrypted-root-entropy', encrypted);
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'root-decrypt' });

		vi.stubGlobal('indexedDB', new IDBFactory());
		vi.mocked(Date.now).mockReturnValue(TIME);
		const selectedState = await loadOrCreateLifecycle();
		if (selectedState.kind !== 'created') throw new Error('Expected fresh state after reset.');
		const selected = await selectIdentity(selectedState.selection.generation, selectedState.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		player.identities[0].pubkey = 'f'.repeat(64);
		player.mode.activeRun.identity.pubkey = 'f'.repeat(64);
		player.mode.activeRun.gameState.personaPubkey = 'f'.repeat(64);
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', player);
		expect(await loadOrCreateLifecycle()).toEqual({ kind: 'corrupt', reason: 'derivation-mismatch' });
	});

	it('fails closed for invalid pending candidates and impossible pending generation', async () => {
		const initial = await loadOrCreateLifecycle();
		if (initial.kind !== 'created') throw new Error('Expected fresh state.');
		const player = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		player.mode.pendingSelection.candidates[1] = player.mode.pendingSelection.candidates[0];
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', player);
		expect((await loadOrCreateLifecycle()).kind).toBe('corrupt');

		vi.stubGlobal('indexedDB', new IDBFactory());
		const next = await loadOrCreateLifecycle();
		if (next.kind !== 'created') throw new Error('Expected fresh state after reset.');
		const impossible = (await records(PLAYER_LIFECYCLE_STORE_NAME))['player-lifecycle'] as any;
		impossible.mode.pendingSelection.generation = 2;
		await putRecord(PLAYER_LIFECYCLE_STORE_NAME, 'player-lifecycle', impossible);
		expect((await loadOrCreateLifecycle()).kind).toBe('corrupt');
	});
});
