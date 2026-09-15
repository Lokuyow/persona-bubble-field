import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openDB, type IDBPDatabase } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DATABASE_NAME,
	DATABASE_VERSION,
	PLAYER_LIFECYCLE_STORE_NAME,
	ROOT_SECRET_STORE_NAME,
	collectCompletedMending,
	loadOrCreateLifecycle,
	selectIdentity,
	startMending,
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
	it('imports without browser storage and fails only when persistence is used', async () => {
		vi.stubGlobal('indexedDB', undefined);
		await expect(loadOrCreateLifecycle()).rejects.toThrow('Lifecycle storage could not be opened.');
	});

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

	it('cleanly replaces pre-v4 prototype stores instead of reading them', async () => {
		const old = await openDB(DATABASE_NAME, 3, {
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
		const collected = await collectCompletedMending(started);
		expect(collected.kind).toBe('collected');
		if (collected.kind !== 'collected') return;
		expect(collected.persona.gameState.mendingJob).toBeNull();
		expect(collected.persona.activeRun.revision).toBe(2);
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
		const initial = await loadOrCreateLifecycle();
		if (initial.kind !== 'created') throw new Error('Expected fresh state.');
		let unselected = new Set(initial.selection.candidates.slice(1).map((candidate) => candidate.characterId));
		const selected = await selectIdentity(initial.selection.generation, initial.selection.candidates[0]);
		if (selected.kind !== 'selected') throw new Error('Expected selected state.');
		let current = selected.persona;
		let reappeared = false;
		for (let generation = 2; generation <= 6 && !reappeared; generation += 1) {
			vi.mocked(Date.now).mockReturnValue(TIME + generation * 8 * 24 * 60 * 60 * 1000);
			const transition = await transitionExpiredPersona(current);
			expect(transition.kind).toBe('transitioned');
			const pending = await loadOrCreateLifecycle();
			if (pending.kind !== 'selecting') throw new Error('Expected next selection.');
			reappeared = pending.selection.candidates.some((candidate) => unselected.has(candidate.characterId));
			unselected = new Set([...unselected, ...pending.selection.candidates.slice(1).map((candidate) => candidate.characterId)]);
			const next = await selectIdentity(pending.selection.generation, pending.selection.candidates[0]);
			if (next.kind !== 'selected') throw new Error('Expected next selected state.');
			current = next.persona;
		}
		expect(reappeared).toBe(true);
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
