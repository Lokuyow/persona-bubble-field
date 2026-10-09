import { describe, expect, it } from 'vitest';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools/pure';
import {
	buildPublicProfileStateTemplate,
	buildWorldStateEventTemplate,
	finalizeWorldEvent,
	type ChannelReference
} from './nostrProtocol';
import { resolveWorldCharacterFromPubkey } from './worldCharacterAssignment';
import { projectPublicRankings } from './publicRankings';

const CHANNEL_ID = 'a'.repeat(64);
const channel: ChannelReference = { channelId: CHANNEL_ID, relayHint: 'wss://relay.example.com' };
const NOW = 1_700_000_000_000;

function mappedSecret(seed: number): Uint8Array {
	for (let value = seed; value < seed + 10_000; value++) {
		const secret = new Uint8Array(32);
		secret[28] = (value >>> 24) & 0xff;
		secret[29] = (value >>> 16) & 0xff;
		secret[30] = (value >>> 8) & 0xff;
		secret[31] = value & 0xff;
		if (resolveWorldCharacterFromPubkey(getPublicKey(secret))) return secret;
	}
	throw new Error('No assigned test character found.');
}

const secrets = [mappedSecret(5), mappedSecret(10_005), mappedSecret(20_005)];

function profile(secret: Uint8Array, options: Readonly<{ createdAt?: number; runNumber?: number; points?: number; expiry?: number; version?: number }> = {}): Event {
	const template = buildPublicProfileStateTemplate({
		channel,
		createdAt: options.createdAt ?? 1_699_999_990,
		runNumber: options.runNumber ?? 1,
		points: options.points ?? 0,
		abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 },
		rootPoints: 0,
		lifespan: { baseExpiresAtMs: options.expiry ?? NOW + 60_000, extension: null }
	});
	const parsedContent = JSON.parse(template.content);
	if (options.version !== undefined) parsedContent.version = options.version;
	return finalizeEvent({ ...template, content: JSON.stringify(parsedContent) }, secret);
}

function exit(secret: Uint8Array, options: Readonly<{ createdAt: number; runNumber?: number; reason?: 'death' | 'clear' }> ): Event {
	return finalizeWorldEvent(buildWorldStateEventTemplate({
		channel,
		position: { x: 8, y: 0 },
		slot: 'exit',
		createdAt: options.createdAt,
		...(options.runNumber === undefined ? {} : { runNumber: options.runNumber }),
		...(options.reason === undefined ? {} : { exitReason: options.reason })
	}), secret);
}

function ranking(events: readonly Event[], selfSecret?: Uint8Array) {
	return projectPublicRankings({ events, channelId: CHANNEL_ID, viewerNowMs: NOW, selfPubkey: selfSecret ? getPublicKey(selfSecret) : null });
}

describe('public profile rankings', () => {
	it('canonicalizes profile envelopes before validation and does not fall back from invalid latest state', () => {
		const old = profile(secrets[0]!, { points: 100 });
		const invalidLatest = profile(secrets[0]!, { createdAt: old.created_at + 1, points: 200, version: 3 });
		expect(ranking([old, invalidLatest]).points).toEqual([]);
		expect(ranking([invalidLatest, old]).points).toEqual([]);
	});

	it('uses a canonical terminal exit before comparing its Run to the public Profile', () => {
		const sameRunDeath = exit(secrets[0]!, { createdAt: 2_000, runNumber: 1, reason: 'death' });
		const newerOtherRun = exit(secrets[0]!, { createdAt: 2_001, runNumber: 2, reason: 'clear' });
		const currentProfile = profile(secrets[0]!, { runNumber: 1, expiry: NOW + 60_000 });
		for (const events of [[sameRunDeath, newerOtherRun, currentProfile], [newerOtherRun, currentProfile, sameRunDeath]]) {
			expect(ranking(events).points[0]?.terminalState).toBeNull();
		}
	});

	it('chooses the lowest event ID for same-second terminal exits independent of Relay arrival order', () => {
		const death = exit(secrets[0]!, { createdAt: 2_010, runNumber: 1, reason: 'death' });
		const clear = exit(secrets[0]!, { createdAt: 2_010, runNumber: 1, reason: 'clear' });
		const canonical = death.id < clear.id ? death : clear;
		const expected = canonical === death ? 'death' : 'clear';
		const currentProfile = profile(secrets[0]!, { expiry: NOW + 60_000 });
		for (const events of [[death, clear, currentProfile], [clear, currentProfile, death]]) {
			expect(ranking(events).points[0]?.terminalState).toBe(expected);
		}
	});

	it('orders points and lifespan deterministically, retaining terminal rows and preferring matching clear over expiry', () => {
		const dead = profile(secrets[0]!, { points: 10, expiry: NOW - 1 });
		const survivor = profile(secrets[1]!, { points: 30, expiry: NOW + 30_000 });
		const cleared = profile(secrets[2]!, { points: 20, expiry: NOW - 1 });
		const clearExit = exit(secrets[2]!, { createdAt: 2_500, runNumber: 1, reason: 'clear' });
		const projection = ranking([dead, survivor, cleared, clearExit], secrets[1]);
		expect(projection.points.map((row) => row.points)).toEqual([30, 20, 10]);
		expect(projection.points.find((row) => row.points === 20)).toMatchObject({ terminalState: 'clear', isSelf: false });
		expect(projection.points.find((row) => row.points === 30)?.isSelf).toBe(true);
		expect(projection.lifespan.map((row) => row.terminalState)).toEqual(['death', null, 'clear']);
	});

	it('limits each independently ordered ranking to its top 20 rows', () => {
		const events = Array.from({ length: 25 }, (_, index) => profile(mappedSecret(1_000_000 + index * 10_000), {
			points: index,
			expiry: NOW + (index + 1) * 1_000
		}));
		const projection = ranking(events);

		expect(projection.points).toHaveLength(20);
		expect(projection.points.map((row) => row.points)).toEqual(Array.from({ length: 20 }, (_, index) => 24 - index));
		expect(projection.lifespan).toHaveLength(20);
		expect(projection.lifespan.map((row) => row.remainingLifespanMs)).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) * 1_000));
	});

	it('maps matching death reason to death and ignores exits with a missing Run number', () => {
		const state = profile(secrets[0]!, { expiry: NOW + 60_000 });
		expect(ranking([state, exit(secrets[0]!, { createdAt: 3_000, runNumber: 1, reason: 'death' })]).points[0]?.terminalState).toBe('death');
		expect(ranking([state, exit(secrets[0]!, { createdAt: 3_001 })]).points[0]?.terminalState).toBeNull();
	});
});
