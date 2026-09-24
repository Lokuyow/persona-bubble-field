import { describe, expect, it } from 'vitest';
import {
	assertPrototypeWorldConfig,
	PROTOTYPE_AUTHORITATIVE_RELAYS,
	PROTOTYPE_CHANNEL_ID,
	PROTOTYPE_CREATOR_PUBKEY,
	PROTOTYPE_PREFERRED_WORLD_RELAY_HINT,
	PROTOTYPE_WORLD_CONFIG
} from './prototypeWorldConfig';

describe('prototype World authority config', () => {
	it('pins the current channel, creator, authoritative Relays, hint, and revision', () => {
		expect(PROTOTYPE_WORLD_CONFIG).toEqual({
			configRevision: 1,
			channelId: '3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b',
			creatorPubkey: '89ae5e1f887b68ebc093b1e971164f59ee1e8d3bb02fd1fe168f77d7e4b2c10b',
			authoritativeRelays: [
				'wss://yabu.me/',
				'wss://relay-jp.nostr.wirednet.jp/',
				'wss://r.kojira.io/',
				'wss://relay.nostrfy.org/',
				'wss://nos.lol/'
			],
			preferredRelayHint: 'wss://nos.lol/'
		});
		expect(PROTOTYPE_AUTHORITATIVE_RELAYS).toContain(PROTOTYPE_PREFERRED_WORLD_RELAY_HINT);
		expect(PROTOTYPE_WORLD_CONFIG.channelId).toBe(PROTOTYPE_CHANNEL_ID);
		expect(PROTOTYPE_WORLD_CONFIG.creatorPubkey).toBe(PROTOTYPE_CREATOR_PUBKEY);
		expect(() => assertPrototypeWorldConfig(PROTOTYPE_WORLD_CONFIG)).not.toThrow();
	});

	it('rejects invalid revision, duplicated or noncanonical relays, and a hint outside the authority set', () => {
		expect(() => assertPrototypeWorldConfig({ ...PROTOTYPE_WORLD_CONFIG, configRevision: 0 })).toThrow('Invalid prototype World config');
		expect(() => assertPrototypeWorldConfig({ ...PROTOTYPE_WORLD_CONFIG, authoritativeRelays: ['wss://nos.lol/', 'wss://nos.lol/'] })).toThrow('Invalid prototype World config');
		expect(() => assertPrototypeWorldConfig({ ...PROTOTYPE_WORLD_CONFIG, authoritativeRelays: ['https://nos.lol/'] })).toThrow('Invalid prototype World config');
		expect(() => assertPrototypeWorldConfig({ ...PROTOTYPE_WORLD_CONFIG, preferredRelayHint: 'wss://other.example/' })).toThrow('Invalid prototype World config');
	});
});
