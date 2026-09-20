import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATABASE_NAME,
	DATABASE_VERSION,
	PLAYER_LIFECYCLE_STORE_NAME,
	ROOT_SECRET_STORE_NAME,
	applyRealtimeOutcome,
	clearPersona,
	collectMending,
	exportClearedIdentityNsec,
	getRealtimeSettlementLedger,
	loadOrCreateLifecycle,
	selectIdentity,
	startMending,
	trackRealtimeEventInstance,
	transitionRealtimeDeath,
	transitionExpiredPersona,
	upgradePersonaAbility,
	type LoadLifecycleResult,
	type PendingSelection,
	type PersonaSnapshot,
	type SelectIdentityOptions
} from './rootIdentity';
import type { RootBuild } from './rootProgression';

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
		expect(await trackRealtimeEventInstance(funded, 'rift-pending')).toBe(true);
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
		expect(await trackRealtimeEventInstance(persona, 'rift')).toBe(true);
		expect((await getRealtimeSettlementLedger(persona))?.pendingInstanceIds).toEqual(['rift']);
	});
});
