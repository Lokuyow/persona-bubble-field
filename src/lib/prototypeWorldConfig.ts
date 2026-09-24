export type PrototypeWorldConfig = Readonly<{
	readonly configRevision: number;
	readonly channelId: string;
	readonly creatorPubkey: string;
	readonly authoritativeRelays: readonly string[];
	readonly preferredRelayHint: string;
}>;

export function assertPrototypeWorldConfig(config: PrototypeWorldConfig): void {
	const isCanonicalRelay = (relay: string): boolean => {
		try {
			const url = new URL(relay);
			return (url.protocol === 'ws:' || url.protocol === 'wss:') && Boolean(url.hostname) && !relay.includes('#') && url.toString() === relay;
		} catch {
			return false;
		}
	};
	if (!Number.isSafeInteger(config.configRevision) || config.configRevision < 1 ||
		!/^[0-9a-f]{64}$/.test(config.channelId) || !/^[0-9a-f]{64}$/.test(config.creatorPubkey) ||
		config.authoritativeRelays.length === 0 || config.authoritativeRelays.some((relay) => !isCanonicalRelay(relay)) ||
		new Set(config.authoritativeRelays).size !== config.authoritativeRelays.length ||
		!isCanonicalRelay(config.preferredRelayHint) || !config.authoritativeRelays.includes(config.preferredRelayHint)) {
		throw new TypeError('Invalid prototype World config.');
	}
}

export const PROTOTYPE_CHANNEL_ID =
	'3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b';

export const PROTOTYPE_CREATOR_PUBKEY =
	'89ae5e1f887b68ebc093b1e971164f59ee1e8d3bb02fd1fe168f77d7e4b2c10b';

export const PROTOTYPE_AUTHORITATIVE_RELAYS = Object.freeze([
	'wss://yabu.me/',
	'wss://relay-jp.nostr.wirednet.jp/',
	'wss://r.kojira.io/',
	'wss://relay.nostrfy.org/',
	'wss://nos.lol/'
]) as readonly string[];

export const PROTOTYPE_PREFERRED_WORLD_RELAY_HINT = 'wss://nos.lol/';

export const PROTOTYPE_WORLD_CONFIG: PrototypeWorldConfig = Object.freeze({
	configRevision: 1,
	channelId: PROTOTYPE_CHANNEL_ID,
	creatorPubkey: PROTOTYPE_CREATOR_PUBKEY,
	authoritativeRelays: PROTOTYPE_AUTHORITATIVE_RELAYS,
	preferredRelayHint: PROTOTYPE_PREFERRED_WORLD_RELAY_HINT
});
