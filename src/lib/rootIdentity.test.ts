import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
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

	it('selects one candidate by CAS and re-derives the signer after reload', async () => {
		const selection = await loadOrCreateLifecycle();
		if (selection.kind !== 'created') throw new Error('Expected fresh state.');
		const chosen = selection.selection.candidates[0];
		const result = await selectIdentity(selection.selection.generation, chosen);
		expect(result.kind).toBe('selected');
		const persona = restored(await loadOrCreateLifecycle());
		expect(persona.signer.pubkey).toBe(chosen.pubkey);
		expect(persona.identity.characterId).toBe(chosen.characterId);
		expect(persona.activeRun.runNumber).toBe(1);
		expect(persona.activeRun.revision).toBe(0);
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
});
