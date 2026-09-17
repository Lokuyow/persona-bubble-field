export type PrototypeWorldConfig = {
	readonly channelId: string;
	readonly metadataDiscoveryRelays: readonly string[];
	readonly preferredRelayHint: string;
};

export const PROTOTYPE_CHANNEL_ID =
	'3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b';

export const PROTOTYPE_METADATA_DISCOVERY_RELAYS = Object.freeze([
	'wss://nos.lol/',
	'wss://x.kojira.io/',
	'wss://relay.nostr.wirednet.jp/',
	'wss://yabu.me/'
]) as readonly string[];

export const PROTOTYPE_PREFERRED_WORLD_RELAY_HINT = 'wss://nos.lol/';

export const PROTOTYPE_WORLD_CONFIG: PrototypeWorldConfig = Object.freeze({
	channelId: PROTOTYPE_CHANNEL_ID,
	metadataDiscoveryRelays: PROTOTYPE_METADATA_DISCOVERY_RELAYS,
	preferredRelayHint: PROTOTYPE_PREFERRED_WORLD_RELAY_HINT
});

/**
 * DEV/test-only world injection used by browser fixtures. Production builds
 * always use the configured prototype channel and relay discovery set.
 */
export function resolvePrototypeWorldConfig(): PrototypeWorldConfig {
	if (!import.meta.env.DEV || typeof window === 'undefined') return PROTOTYPE_WORLD_CONFIG;
	const override = (window as Window & {
		__personaBubbleFieldTestWorldConfig?: Partial<PrototypeWorldConfig>;
	}).__personaBubbleFieldTestWorldConfig;
	if (!override) return PROTOTYPE_WORLD_CONFIG;
	return Object.freeze({
		...PROTOTYPE_WORLD_CONFIG,
		...override,
		metadataDiscoveryRelays: override.metadataDiscoveryRelays ?? PROTOTYPE_WORLD_CONFIG.metadataDiscoveryRelays
	});
}
