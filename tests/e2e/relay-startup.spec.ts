import { expect, test, type Locator, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../src/lib/nostrProtocol';
import {
	buildRiftActionTemplate,
	buildRiftCommitAction,
	buildRiftRevealAction,
	buildManualRiftInstanceId,
	deriveRiftHolePositions,
	getRiftRoundSchedule,
	getRiftSchedule,
	getRiftScheduleForInstance,
	RIFT_CONSULTATION_MS,
	RIFT_PROTOCOL_KEY,
	type RiftAction
} from '../../src/lib/rift';
import { buildRealtimeControlEventTemplate, finalizeRealtimeEvent } from '../../src/lib/realtimeEvents';
import { SPEECH_SHORTCUT_IDS } from '../../src/lib/speechSubmission';
import { characterPicturePath } from '../../src/lib/character';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../src/lib/bip85';
import { ADJUSTMENT_TERMINAL, MENDING_TERMINAL } from '../../src/lib/fieldFacilities';

const CHANNEL_ID = '3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b';
const SEED_RELAYS = [
	'wss://nos.lol/',
	'wss://x.kojira.io/',
	'wss://relay.nostr.wirednet.jp/',
	'wss://yabu.me/'
] as const;
const AUTHORITATIVE_RELAYS = [
	'wss://yabu.me/',
	'wss://relay-jp.nostr.wirednet.jp/',
	'wss://nos.lol/',
	'wss://relay.damus.io/',
	'wss://snowflare.cc/',
	'wss://r.kojira.io/'
] as const;

// Deterministic fake signers are derived at test runtime from a zero root.
// Logical fixture labels are kept stable for the scenarios below; their actual
// BIP85 account indexes are selected from currently assigned character slots.
const FIXTURE_LABELS = [19, 20, 21, 23, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 43, 47, 51, 53, 55, 57, 59, 61, 63] as const;
const FIXTURE_CHILDREN: ReadonlyMap<number, Readonly<{ accountIndex: number; secret: Uint8Array }>> = await (async () => {
	const entropy = new Uint8Array(16);
	const seed = mnemonicToSeedSync(entropyToMnemonic(entropy, englishWordlist), '');
	const master = HDKey.fromMasterSeed(seed);
	seed.fill(0);
	try {
		const entries: Array<readonly [number, Readonly<{ accountIndex: number; secret: Uint8Array }>]> = [];
		const usedSlots = new Set<number>();
		for (let accountIndex = 1; accountIndex <= 100_000 && entries.length < FIXTURE_LABELS.length; accountIndex += 1) {
			const child = await deriveBip85NostrEntropy(master, 1, accountIndex);
			const character = resolveCharacterFromPubkey(getPublicKey(child));
			if (character && !usedSlots.has(character.slot)) {
				usedSlots.add(character.slot);
				entries.push([FIXTURE_LABELS[entries.length], { accountIndex, secret: child.slice() }]);
			}
			child.fill(0);
		}
		if (entries.length !== FIXTURE_LABELS.length) throw new Error('Could not find enough assigned fixture signers.');
		return new Map(entries);
	} finally {
		master.wipePrivateData();
		entropy.fill(0);
	}
})();

function fixtureSecret(value: number): Uint8Array {
	const entry = FIXTURE_CHILDREN.get(value);
	if (!entry) throw new Error(`Missing fixture signer ${value}.`);
	return entry.secret.slice();
}

function fixtureAccountIndexForSecret(secretKey: Uint8Array): number {
	for (const { accountIndex, secret } of FIXTURE_CHILDREN.values()) {
		if (secret.length === secretKey.length && secret.every((value, index) => value === secretKey[index])) return accountIndex;
	}
	throw new Error('Fixture secret is not derived from the zero root.');
}

// A public, verified kind 40 whose immutable id is the configured prototype
// channel. Keeping it in the browser-local fake Relay avoids all network I/O.
const CHANNEL_EVENT = {
	content: '{"name":"name: persona-bubble-field prototype","about":"about:\\nPrototype public chat channel for a spatial character chat client built on Nostr.","picture":"","relays":["wss://yabu.me/","wss://relay-jp.nostr.wirednet.jp/","wss://nos.lol/","wss://relay.damus.io/","wss://snowflare.cc/","wss://r.kojira.io/"]}',
	created_at: 1787801905,
	id: CHANNEL_ID,
	kind: 40,
	pubkey: '89ae5e1f887b68ebc093b1e971164f59ee1e8d3bb02fd1fe168f77d7e4b2c10b',
	sig: '7d86e48506fc1b5796b38b131e39a2ef7654f223b8388e81dd22c2be8102e76ffa6cf1517d09290d3b0477f54cc42fc3d5e1cccf913b462eb1296dbdc12212db',
	tags: [['client', 'lumilumi', '31990:84b0c46ab699ac35eb2ca286470b85e081db2087cdef63932236c397417782f5:1727506446612', 'wss://cagliostr.compile-error.net']]
} as const;

import { installHostOwnedStub } from './helpers/hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './helpers/fieldFrames';

function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

async function openProfile(page: Page): Promise<void> {
	const timeline = page.getByLabel('Chatter', { exact: true });
	if (await timeline.isVisible()) await page.getByRole('button', { name: 'Hide Chatter' }).click();
	await page.locator('[data-self="true"] .participant-profile-trigger').click();
	await expect(profileDialog(page)).toBeVisible();
}

function testEvents(nowMs = Date.now(), channelId = CHANNEL_ID) {
	const secret = fixtureSecret(19);
	const createdAt = Math.floor(nowMs / 1000);
	const channel = { channelId, relayHint: 'wss://nos.lol/' };
	return {
		message: finalizeEvent(buildWorldMessageTemplate({
			channel,
			content: 'bootstrap message',
			speechType: 'normal',
			position: { x: 3, y: 2 },
			createdAt
		}), secret),
		position: finalizeEvent(buildWorldStateEventTemplate({
			channel,
			position: { x: 3, y: 2 },
			slot: 0,
			createdAt
		}), secret)
	};
}

function upcomingRegistrationSchedule(): ReturnType<typeof getRiftSchedule> {
	let schedule = getRiftSchedule(Date.now());
	if (schedule.registrationAtMs <= Date.now()) schedule = getRiftSchedule(schedule.endedAtMs + 1);
	return schedule;
}

function signedRiftAction(secretKey: Uint8Array, schedule: ReturnType<typeof getRiftSchedule>, action: RiftAction, createdAtMs: number, channelId = CHANNEL_ID): NostrEvent {
	return finalizeEvent(buildRiftActionTemplate({
		channelId,
		relayHint: 'wss://nos.lol/',
		instanceId: schedule.instanceId,
		action,
		createdAt: Math.floor(createdAtMs / 1000)
	}), secretKey);
}

function syntheticChannelFixture() {
	const secret = fixtureSecret(63);
	const event = finalizeEvent({
		kind: 40,
		created_at: 1_800_000_000,
		tags: [],
		content: JSON.stringify({ name: 'synthetic Rift test channel', relays: [...AUTHORITATIVE_RELAYS] })
	}, secret);
	return {
		secret,
		event,
		worldConfig: { channelId: event.id, metadataDiscoveryRelays: SEED_RELAYS, preferredRelayHint: SEED_RELAYS[0] }
	};
}

function traceRuntimeEvents(rootPosition: { x: number; y: number } = { x: 4, y: 2 }) {
	const selfSecret = fixtureSecret(23);
	const rootSecret = fixtureSecret(29);
	const createdAt = Math.floor(Date.now() / 1000);
	const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
	const selfPosition = finalizeEvent(buildWorldStateEventTemplate({
		channel,
		position: { x: 3, y: 2 },
		slot: 0,
		createdAt
	}), selfSecret);
	const message = finalizeEvent(buildWorldMessageTemplate({
		channel,
		content: 'trace runtime participant',
		speechType: 'normal',
		position: { x: 8, y: 6 },
		createdAt
	}), rootSecret);
	let root = finalizeEvent(buildWorldMessageTemplate({
		channel,
		content: 'Relay trace root 0',
		speechType: 'shout',
		position: rootPosition,
		createdAt
	}), rootSecret);
	for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
		root = finalizeEvent(buildWorldMessageTemplate({
			channel,
			content: `Relay trace root ${attempt}`,
			speechType: 'shout',
			position: rootPosition,
			createdAt
		}), rootSecret);
	}
	const parsedRoot = parseWorldMessage(root, CHANNEL_ID);
	if (!parsedRoot) throw new Error('Relay trace root fixture did not parse.');
	const replySecret = fixtureSecret(31);
	const direct = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedRoot,
		content: 'Relay direct reply',
		speechType: 'normal',
		createdAt: createdAt + 1
	}), replySecret);
	const selfDirect = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedRoot,
		content: 'Relay own direct reply',
		speechType: 'normal',
		createdAt: createdAt + 1
	}), selfSecret);
	const directCandidate = parseTraceReplyCandidate(direct);
	const parsedDirect = directCandidate && validateTraceReplyCandidate(directCandidate, parsedRoot, parsedRoot);
	if (!parsedDirect) throw new Error('Relay direct reply fixture did not parse.');
	const deeper = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedDirect,
		content: 'Relay deeper branch reply',
		speechType: 'monologue',
		createdAt: createdAt + 2
	}), replySecret);
	const deeperCandidate = parseTraceReplyCandidate(deeper);
	const parsedDeeper = deeperCandidate && validateTraceReplyCandidate(deeperCandidate, parsedRoot, parsedDirect);
	if (!parsedDeeper) throw new Error('Relay deeper reply fixture did not parse.');
	const greatGrandchild = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedDeeper,
		content: 'Relay great-grandchild reply',
		speechType: 'shout',
		createdAt: createdAt + 3
	}), fixtureSecret(37));
	const currentLive = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedDirect,
		content: 'Relay live current child',
		speechType: 'normal',
		createdAt: createdAt + 4
	}), fixtureSecret(39));
	const staleOldGeneration = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedDirect,
		content: 'Relay stale old-generation child',
		speechType: 'normal',
		createdAt: createdAt + 5
	}), fixtureSecret(41));
	const invalid = { ...direct, id: 'f'.repeat(64), content: 'Relay invalid reply' };
	const live = finalizeEvent(buildTraceReplyTemplate({
		root: parsedRoot,
		parent: parsedRoot,
		content: 'Relay live direct reply',
		speechType: 'shout',
		createdAt: createdAt + 3
	}), fixtureSecret(33));
	return {
		selfSecret, selfPubkey: getPublicKey(selfSecret), selfPosition, message, root,
		direct, selfDirect, deeper, greatGrandchild, currentLive, staleOldGeneration, invalid, live
	};
}

async function installVirtualKeyboardStub(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const listeners = new Set<(event: Event) => void>();
		let overlaysContent = false;
		let boundingRect = {
			left: 0,
			top: window.innerHeight,
			right: window.innerWidth,
			bottom: window.innerHeight,
			width: window.innerWidth,
			height: 0
		};
		Object.defineProperty(navigator, 'virtualKeyboard', {
			configurable: true,
			value: {
				get overlaysContent() { return overlaysContent; },
				set overlaysContent(value: boolean) {
					overlaysContent = value;
				},
				get boundingRect() { return boundingRect; },
				addEventListener(type: string, listener: (event: Event) => void) {
					if (type === 'geometrychange') listeners.add(listener);
				},
				removeEventListener(type: string, listener: (event: Event) => void) {
					if (type === 'geometrychange') listeners.delete(listener);
				}
			}
		});
		Object.assign(window, {
			__virtualKeyboardTest: {
				setBottomInset(inset: number) {
					boundingRect = {
						left: 0,
						top: window.innerHeight - inset,
						right: window.innerWidth,
						bottom: window.innerHeight,
						width: window.innerWidth,
						height: inset
					};
					for (const listener of listeners) listener(new Event('geometrychange'));
				},
				state: () => ({ overlaysContent })
			}
		});
	});
}

async function installDelayedRelay(page: Page, options: {
	deferPrimaryEvents?: boolean;
	historyMessages?: readonly object[];
	primaryEvents?: Readonly<{ message: object; position: object }>;
	realtimeEvents?: readonly object[];
	deferRealtimeEvents?: boolean;
	realtimeTerminal?: 'eose' | 'closed' | 'timeout';
	realtimePublishOutcome?: 'accepted' | 'rejected' | 'echo' | 'no-response';
	traceRoots?: readonly object[];
	traceReplies?: readonly object[];
	deferTraceRoots?: boolean;
	deferTraceReplies?: boolean;
	persistAcrossReload?: boolean;
	channelEvent?: object;
	testWorldConfig?: { channelId: string; metadataDiscoveryRelays: readonly string[]; preferredRelayHint: string };
	hiddenSubscriptionLimit?: number;
} = {}): Promise<void> {
	const events = options.primaryEvents ?? testEvents();
	await page.addInitScript(({ seedRelays, authoritativeRelays, channelEvent, primaryEvents, historyMessages, realtimeEvents, deferPrimaryEvents, deferRealtimeEvents, realtimeTerminal, realtimePublishOutcome, traceRoots, traceReplies, deferTraceRoots, deferTraceReplies, persistAcrossReload, testWorldConfig, hiddenSubscriptionLimit }) => {
		type Listener = (event?: { type: string; data?: string; code?: number; reason?: string }) => void;
		type PendingRequest = { socket: FakeWebSocket; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] };
		const seed = new Set<string>(seedRelays);
		const authoritative = new Set<string>(authoritativeRelays);
		const pendingMetadata: PendingRequest[] = [];
		const pendingPrimary: PendingRequest[] = [];
		const pendingTraceRoots: PendingRequest[] = [];
		const pendingTraceReplies: PendingRequest[] = [];
		const pendingRealtime: PendingRequest[] = [];
		const activePrimary: PendingRequest[] = [];
		const activeTraceReplies: PendingRequest[] = [];
		const activeRealtime: PendingRequest[] = [];
		const closedTraceReplies: PendingRequest[] = [];
		const pendingPublishes: Array<{ socket: FakeWebSocket; event: Record<string, unknown> }> = [];
		const timelineHistory = (historyMessages ?? []) as Array<Record<string, unknown>>;
		const traceReplyHistory = traceReplies as Array<Record<string, unknown>>;
		const persistedKey = 'relay-startup-persisted-state';
		const previous = persistAcrossReload ? JSON.parse(sessionStorage.getItem(persistedKey) ?? '{"published":[],"closedSubscriptions":[]}') as {
			published: Array<Record<string, unknown>>;
			closedSubscriptions: Array<{ subId: string; url: string }>;
		} : { published: [], closedSubscriptions: [] };
		const realtimeHistory = [
			...(realtimeEvents ?? []) as Array<Record<string, unknown>>,
			...previous.published.filter((event) => event.kind === 7070)
		];
		const state = {
			traceDeliveries: [] as string[],
			requests: [] as Array<{ url: string; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>,
			published: [] as Array<Record<string, unknown>>,
			closedSubscriptions: [] as Array<{ subId: string; url: string }>,
			previousPublished: previous.published,
			previousClosedSubscriptions: previous.closedSubscriptions,
			realtimeHistory,
			metadataReleased: false,
			primaryEventsReleased: !deferPrimaryEvents,
			primaryReleased: false,
			traceRootsReleased: !deferTraceRoots,
			traceRepliesReleased: !deferTraceReplies,
			metadataFailuresRemaining: 0,
			realtimeEventsReleased: !deferRealtimeEvents,
			realtimeTerminal: realtimeTerminal ?? 'eose' as 'eose' | 'closed' | 'timeout',
			realtimePublishOutcome: realtimePublishOutcome ?? 'accepted' as 'accepted' | 'rejected' | 'echo' | 'no-response',
			rejectMessagePublishes: false,
			rejectPositionPublishes: false,
			deferReplyPublishes: false,
			deferPositionPublishes: false,
			echoRepliesBeforeResult: false,
			replyOutcome: 'accepted' as 'accepted' | 'rejected' | 'duplicate'
		};
		const deliver = (socket: FakeWebSocket, packet: unknown[]) => {
			if (packet[0] === 'EVENT' && (packet[2] as { kind?: number }).kind === 1111) state.traceDeliveries.push((packet[2] as { id: string }).id);
			socket.dispatch('message', { type: 'message', data: JSON.stringify(packet) });
		};
		const matchesTraceFilter = (event: Record<string, unknown>, filter: Record<string, unknown>) =>
			(!filter.kinds || (filter.kinds as number[]).includes(event.kind as number)) &&
			(filter.since === undefined || (event.created_at as number) >= (filter.since as number)) &&
			(filter.until === undefined || (event.created_at as number) <= (filter.until as number)) &&
			Object.entries(filter).filter(([key]) => /^#[A-Za-z]$/.test(key)).every(([key, values]) =>
				(event.tags as string[][]).some((tag) => tag[0] === key.slice(1) && (values as string[]).includes(tag[1])));
		const deliverTraceLive = (request: PendingRequest, event: Record<string, unknown>) => {
			if (request.filters.some((filter) => matchesTraceFilter(event, filter))) deliver(request.socket, ['EVENT', request.subId, event]);
		};
		const matchesRealtimeFilter = (event: Record<string, unknown>, filter: Record<string, unknown>) =>
			(!filter.kinds || (filter.kinds as number[]).includes(event.kind as number)) &&
			(!filter.authors || (filter.authors as string[]).includes(event.pubkey as string)) &&
			(filter.since === undefined || (event.created_at as number) >= (filter.since as number)) &&
			Object.entries(filter).filter(([key]) => /^#[A-Za-z]$/.test(key)).every(([key, values]) =>
				(event.tags as string[][]).some((tag) => tag[0] === key.slice(1) && (values as string[]).includes(tag[1])));
		const deliverRealtimeLive = (request: PendingRequest, event: Record<string, unknown>) => {
			if (request.filters.some((filter) => matchesRealtimeFilter(event, filter))) deliver(request.socket, ['EVENT', request.subId, event]);
		};
		const respondPublish = (socket: FakeWebSocket, event: Record<string, unknown>) => {
			const reject = event.kind === 42 && state.rejectMessagePublishes || event.kind === 30078 && state.rejectPositionPublishes ||
				event.kind === 1111 && state.replyOutcome !== 'accepted';
			const notice = event.kind === 1111 && state.replyOutcome === 'duplicate' ? 'duplicate: already stored' : reject ? 'blocked: test rejection' : '';
			if (event.kind === 1111 && state.replyOutcome !== 'rejected' && !traceReplyHistory.some((known) => known.id === event.id)) traceReplyHistory.push(event);
			deliver(socket, ['OK', event.id, !reject, notice]);
		};
		const respondMetadata = (request: PendingRequest) => {
			if (state.metadataFailuresRemaining > 0) {
				state.metadataFailuresRemaining -= 1;
				deliver(request.socket, ['CLOSED', request.subId, 'metadata test failure']);
				return;
			}
			if ((request.filter.kinds as number[] | undefined)?.includes(40)) {
				deliver(request.socket, ['EVENT', request.subId, channelEvent]);
			}
			deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondPrimaryEvent = (request: PendingRequest) => {
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(42))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.message]);
			}
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(30078))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.position]);
			}
			if (request.filters.some((filter) => filter.limit === 50)) {
				for (const event of timelineHistory) deliver(request.socket, ['EVENT', request.subId, event]);
			}
		};
		const respondPrimary = (request: PendingRequest) => {
			if (state.primaryEventsReleased) respondPrimaryEvent(request);
			if (state.primaryReleased) deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondTraceRoots = (request: PendingRequest) => {
			for (const event of traceRoots) deliver(request.socket, ['EVENT', request.subId, event]);
			deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondTraceReplies = (request: PendingRequest) => {
			const selected = new Map<string, Record<string, unknown>>();
			for (const filter of request.filters) {
				const matches = traceReplyHistory.filter((event) => matchesTraceFilter(event, filter))
					.sort((a, b) => (b.created_at as number) - (a.created_at as number) || String(a.id).localeCompare(String(b.id)));
				for (const event of matches.slice(0, filter.limit as number | undefined)) selected.set(event.id as string, event);
			}
			for (const event of selected.values()) deliver(request.socket, ['EVENT', request.subId, event]);
			deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondRealtime = (request: PendingRequest) => {
			queueMicrotask(() => {
				for (const event of realtimeHistory) {
					if (request.filters.some((filter) => matchesRealtimeFilter(event, filter))) deliver(request.socket, ['EVENT', request.subId, event]);
				}
				if (state.realtimeTerminal === 'eose') deliver(request.socket, ['EOSE', request.subId]);
				if (state.realtimeTerminal === 'closed') deliver(request.socket, ['CLOSED', request.subId, 'realtime unavailable']);
			});
		};
		const respondRealtimePublish = (socket: FakeWebSocket, event: Record<string, unknown>) => {
			if (state.realtimePublishOutcome === 'rejected') {
				deliver(socket, ['OK', event.id, false, 'blocked: realtime test rejection']);
				return;
			}
			if (state.realtimePublishOutcome === 'no-response') return;
			if (!realtimeHistory.some((known) => known.id === event.id)) realtimeHistory.push(event);
			if (state.realtimePublishOutcome === 'echo') {
				for (const request of activeRealtime) deliverRealtimeLive(request, event);
				return;
			}
			deliver(socket, ['OK', event.id, true, '']);
		};

		class FakeWebSocket {
			static CONNECTING = 0;
			static OPEN = 1;
			static CLOSING = 2;
			static CLOSED = 3;
			readyState = FakeWebSocket.CONNECTING;
			listeners = new Map<string, Set<Listener>>();
			constructor(readonly url: string) {
				queueMicrotask(() => {
					this.readyState = FakeWebSocket.OPEN;
					this.dispatch('open', { type: 'open' });
				});
			}
			addEventListener(type: string, listener: Listener) {
				const listeners = this.listeners.get(type) ?? new Set<Listener>();
				listeners.add(listener);
				this.listeners.set(type, listeners);
			}
			removeEventListener(type: string, listener: Listener) { this.listeners.get(type)?.delete(listener); }
			dispatch(type: string, event: { type: string; data?: string; code?: number; reason?: string }) {
				for (const listener of this.listeners.get(type) ?? []) listener(event);
			}
			send(raw: string) {
				const packet = JSON.parse(raw) as unknown[];
				if (packet[0] === 'CLOSE') {
					const subId = packet[1] as string;
					state.closedSubscriptions.push({ subId, url: this.url });
					for (const requests of [activePrimary, activeTraceReplies, activeRealtime]) {
						const index = requests.findIndex((request) => request.subId === subId && request.socket === this);
						if (index >= 0) {
							const [closed] = requests.splice(index, 1);
							if (requests === activeTraceReplies) closedTraceReplies.push(closed);
						}
					}
					return;
				}
				if (packet[0] === 'EVENT') {
					state.published.push(packet[1] as Record<string, unknown>);
					const event = packet[1] as Record<string, unknown>;
					if (event.kind === 1111 && state.echoRepliesBeforeResult) {
						for (const request of activeTraceReplies) deliverTraceLive(request, event);
					}
					if (event.kind === 7070) {
						respondRealtimePublish(this, event);
					} else if (event.kind === 1111 && state.deferReplyPublishes || event.kind === 30078 && state.deferPositionPublishes) {
						pendingPublishes.push({ socket: this, event });
					} else respondPublish(this, event);
					return;
				}
				if (packet[0] !== 'REQ') return;
				const filters = packet.slice(2) as Record<string, unknown>[];
				const request = { socket: this, subId: packet[1] as string, filter: filters[0] ?? {}, filters };
				const relayUrl = new URL(this.url).toString();
				state.requests.push({ url: relayUrl, subId: request.subId, filter: request.filter, filters });
				if (filters.some((filter) => Object.keys(filter).filter((key) => /^#[A-Za-z]$/.test(key)).length > 3)) {
					const previous = activeTraceReplies.findIndex((candidate) => candidate.socket === this && candidate.subId === request.subId);
					if (previous >= 0) activeTraceReplies.splice(previous, 1);
					deliver(this, ['CLOSED', request.subId, 'ERROR: bad req: too many tags in filter']);
					return;
				}
				const isRealtime = filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(7070));
				if (isRealtime && authoritative.has(relayUrl)) {
					const socketSubscriptions = [...activePrimary, ...activeTraceReplies, ...activeRealtime]
						.filter((candidate) => candidate.socket.url === request.socket.url).length;
					if (hiddenSubscriptionLimit !== undefined && (socketSubscriptions >= hiddenSubscriptionLimit || hiddenSubscriptionLimit <= 3)) {
						pendingRealtime.push(request);
						return;
					}
					const activeIndex = activeRealtime.findIndex((candidate) => candidate.socket === request.socket && candidate.subId === request.subId);
					if (activeIndex >= 0) activeRealtime[activeIndex] = request;
					else activeRealtime.push(request);
					if (state.realtimeEventsReleased) respondRealtime(request);
					else pendingRealtime.push(request);
					return;
				}
				if (seed.has(relayUrl)) {
					if (state.metadataReleased) respondMetadata(request);
					else pendingMetadata.push(request);
				} else if (authoritative.has(relayUrl)) {
					const isTraceRoot = request.filters.some((filter) =>
						(filter.kinds as number[] | undefined)?.includes(42) && filter.limit === 1000
					);
					const isTraceReply = request.filters.some((filter) =>
						(filter.kinds as number[] | undefined)?.includes(1111)
					);
					if (isTraceRoot) {
						if (state.traceRootsReleased) respondTraceRoots(request);
						else pendingTraceRoots.push(request);
						return;
					}
					if (isTraceReply) {
						const activeIndex = activeTraceReplies.findIndex((candidate) =>
							candidate.socket === request.socket && candidate.subId === request.subId
						);
						if (activeIndex >= 0) activeTraceReplies[activeIndex] = request;
						else activeTraceReplies.push(request);
						if (state.traceRepliesReleased) respondTraceReplies(request);
						else pendingTraceReplies.push(request);
						return;
					}
					activePrimary.push(request);
					respondPrimary(request);
					if (!state.primaryReleased) pendingPrimary.push(request);
				}
			}
			close(code = 1000) {
				this.readyState = FakeWebSocket.CLOSED;
				this.dispatch('close', { type: 'close', code, reason: '' });
			}
		}

		Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
		if (testWorldConfig) Object.assign(window, { __personaBubbleFieldTestWorldConfig: testWorldConfig });
		if (persistAcrossReload) window.addEventListener('pagehide', () => {
			sessionStorage.setItem(persistedKey, JSON.stringify({
				published: [...state.previousPublished, ...state.published],
				closedSubscriptions: [...state.previousClosedSubscriptions, ...state.closedSubscriptions]
			}));
		});
		window.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/nostr+json' } });
		Object.assign(window, {
			__relayStartupTest: {
				state,
				failMetadataDiscovery: () => {
					// Fail every request already issued for the first discovery wave.
					// There can be more than one metadata request per seed Relay.
					state.metadataFailuresRemaining = pendingMetadata.length;
					pendingMetadata.splice(0).forEach(respondMetadata);
				},
				releasePublishes: (kind: number) => {
					if (kind === 1111) state.deferReplyPublishes = false;
					if (kind === 30078) state.deferPositionPublishes = false;
					for (let index = pendingPublishes.length - 1; index >= 0; index--) {
						if (pendingPublishes[index].event.kind !== kind) continue;
						const pending = pendingPublishes.splice(index, 1)[0];
						respondPublish(pending.socket, pending.event);
					}
				},
				releaseMetadata: () => {
					state.metadataReleased = true;
					pendingMetadata.splice(0).forEach(respondMetadata);
				},
				releasePrimaryEvents: () => {
					state.primaryEventsReleased = true;
					pendingPrimary.forEach(respondPrimaryEvent);
				},
				releasePrimary: () => {
					state.primaryReleased = true;
					pendingPrimary.splice(0).forEach((request) => deliver(request.socket, ['EOSE', request.subId]));
				},
				releaseTraceRoots: () => {
					state.traceRootsReleased = true;
					pendingTraceRoots.splice(0).forEach(respondTraceRoots);
				},
					releaseTraceReplies: () => {
					state.traceRepliesReleased = true;
					pendingTraceReplies.splice(0).forEach(respondTraceReplies);
					},
					releaseRealtimeEvents: () => {
						state.realtimeEventsReleased = true;
						pendingRealtime.splice(0).forEach(respondRealtime);
					},
					deferRealtimeEvents: () => { state.realtimeEventsReleased = false; },
					setRealtimePublishOutcome: (outcome: 'accepted' | 'rejected' | 'echo' | 'no-response') => { state.realtimePublishOutcome = outcome; },
					injectRealtimeEvent: (event: object) => {
						const raw = event as Record<string, unknown>;
						if (!realtimeHistory.some((known) => known.id === raw.id)) realtimeHistory.push(raw);
						for (const request of activeRealtime) deliverRealtimeLive(request, raw);
					},
					activeRealtimeCount: () => activeRealtime.length,
				deferTraceReplies: () => { state.traceRepliesReleased = false; },
				injectTraceReply: (event: object) => {
					const raw = event as Record<string, unknown>;
					if (!traceReplyHistory.some((known) => known.id === raw.id)) traceReplyHistory.push(raw);
					for (const request of activeTraceReplies) deliverTraceLive(request, raw);
				},
				injectClosedTraceReply: (event: object) => {
					for (const request of closedTraceReplies) deliver(request.socket, ['EVENT', request.subId, event]);
				},
				activeTraceReplyCount: () => activeTraceReplies.length,
				rejectMessagePublishes: () => { state.rejectMessagePublishes = true; },
				rejectPositionPublishes: () => { state.rejectPositionPublishes = true; },
				allowPositionPublishes: () => { state.rejectPositionPublishes = false; },
				allowMessagePublishes: () => { state.rejectMessagePublishes = false; },
				injectPosition: (event: object) => {
					for (const request of activePrimary) {
						if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(30078))) {
							deliver(request.socket, ['EVENT', request.subId, event]);
						}
					}
				},
				injectMessage: (event: object) => {
					for (const request of activePrimary) {
						if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(42))) {
							deliver(request.socket, ['EVENT', request.subId, event]);
						}
					}
				}
			}
		});
	}, {
		seedRelays: SEED_RELAYS,
		authoritativeRelays: AUTHORITATIVE_RELAYS,
		channelEvent: options.channelEvent ?? CHANNEL_EVENT,
		primaryEvents: events,
		historyMessages: options.historyMessages ?? [],
		deferPrimaryEvents: options.deferPrimaryEvents ?? false,
		traceRoots: options.traceRoots ?? [],
		traceReplies: options.traceReplies ?? [],
		realtimeEvents: options.realtimeEvents ?? [],
		deferTraceRoots: options.deferTraceRoots ?? false,
		deferTraceReplies: options.deferTraceReplies ?? false,
		deferRealtimeEvents: options.deferRealtimeEvents ?? false,
		realtimeTerminal: options.realtimeTerminal ?? 'eose',
		realtimePublishOutcome: options.realtimePublishOutcome ?? 'accepted',
		persistAcrossReload: options.persistAcrossReload ?? false,
		testWorldConfig: options.testWorldConfig,
		hiddenSubscriptionLimit: options.hiddenSubscriptionLimit
	});
}

function relayState(page: Page) {
	return page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { state: { requests: Array<{ url: string; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>; published: Array<{ id: string; kind: number; content: string; tags: string[][]; pubkey?: string }>; closedSubscriptions: Array<{ subId: string; url: string }> }; failMetadataDiscovery(): void; releaseMetadata(): void; releasePrimaryEvents(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void; deferTraceReplies(): void; injectTraceReply(event: object): void; injectClosedTraceReply(event: object): void; activeTraceReplyCount(): number; rejectMessagePublishes(): void; allowMessagePublishes(): void; rejectPositionPublishes(): void; allowPositionPublishes(): void; injectPosition(event: object): void; injectMessage(event: object): void };
	}).__relayStartupTest);
}

function requestKind(request: { filter: Record<string, unknown> }): number | undefined {
	return Array.isArray(request.filter.kinds) && typeof request.filter.kinds[0] === 'number' ? request.filter.kinds[0] : undefined;
}

async function relayFieldCellCenter(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.locator('.field-grid').evaluate((grid, position) => {
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!scene) throw new Error('Expected the field scene to be rendered.');
		const rect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		return { x: rect.left + (position.x + 0.5) * cellSize, y: rect.top + (position.y + 0.5) * cellSize };
	}, cell);
}

async function selectRelayTraceCell(page: Page, position: string): Promise<void> {
	const cell = page.locator(`[data-cell-position="${position}"]`);
	const box = await cell.boundingBox();
	if (!box) throw new Error(`Expected visible logical cell ${position}.`);
	await cell.click({ position: { x: box.width - 2, y: box.height - 2 } });
}

async function clickRelayLogicalCell(page: Page, cell: { x: number; y: number }): Promise<void> {
	const point = await relayFieldCellCenter(page, cell);
	await page.mouse.click(point.x, point.y);
}

async function dragRelayJoystick(page: Page, delta: { x: number; y: number }, startCell = { x: 5, y: 4 }): Promise<void> {
	const start = await relayFieldCellCenter(page, startCell);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + delta.x, start.y + delta.y);
	await page.mouse.up();
}

async function publishedMessages(page: Page) {
	return [...new Map(
		(await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => [event.id, event])
	)].map(([, event]) => event);
}

async function waitForPublishedMessageCount(page: Page, count: number): Promise<void> {
	await expect.poll(async () => (await publishedMessages(page)).length).toBe(count);
}

async function openClockedReadyRelayWorld(page: Page): Promise<Locator> {
	await page.clock.install({ time: Date.now() });
	const editor = await openReadyRelayWorld(page);
	await pauseAtCurrentBrowserTime(page);
	return editor;
}

async function pauseAtCurrentBrowserTime(page: Page): Promise<void> {
	const now = await page.evaluate(() => Date.now());
	// Freeze Date while pausing so a running browser clock cannot overtake the target.
	await page.clock.setFixedTime(now);
	await page.clock.pauseAt(now);
	await page.clock.setSystemTime(now);
}

async function startSelectedRun(page: Page): Promise<void> {
	const start = page.getByRole('button', { name: 'Runを開始' });
	await expect(start).toBeEnabled();
	await start.click();
}

async function setPendingRootPoints(page: Page, rootPoints: number): Promise<void> {
	await page.evaluate(async (nextRootPoints) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const request = store.get('player-lifecycle');
			await new Promise<void>((resolve, reject) => {
				request.onsuccess = () => {
					const state = request.result as { rootPoints: number };
					store.put({ ...state, rootPoints: nextRootPoints }, 'player-lifecycle');
				};
				request.onerror = () => reject(request.error);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally {
			database.close();
		}
	}, rootPoints);
}

async function installVisualAnimationRafMetrics(page: Page): Promise<void> {
	await page.evaluate(() => {
		const clockRequestAnimationFrame = window.requestAnimationFrame.bind(window);
		const clockCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
		const pending = new Set<number>();
		let maxPending = 0;
		window.requestAnimationFrame = (callback) => {
			const id = clockRequestAnimationFrame((timestamp) => {
				pending.delete(id);
				callback(timestamp);
			});
			pending.add(id);
			maxPending = Math.max(maxPending, pending.size);
			return id;
		};
		window.cancelAnimationFrame = (id) => {
			pending.delete(id);
			clockCancelAnimationFrame(id);
		};
		Object.assign(window, {
			__visualAnimationRafMetrics: {
				pending: () => pending.size,
				maxPending: () => maxPending
			}
		});
	});
}

async function openReadyRelayWorld(page: Page, expectedParticipantCount = 2): Promise<Locator> {
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { deferPrimaryEvents: true });
	const secret = fixtureSecret(expectedParticipantCount === 1 ? 19 : 41);
	await seedRelayAccount(page, secret, getPublicKey(secret));
	await page.goto('/');
	await expect(page.locator('.composer-dock')).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await expect(editor).toBeVisible();
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
	await expect.poll(async () => {
		const requests = (await relayState(page)).state.requests;
		return [42, 30078].every((kind) => requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === kind
		));
	}).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant')).toHaveCount(expectedParticipantCount);
	return editor;
}

async function installPromptApiStub(page: Page, availability: 'available' | 'unavailable' = 'available'): Promise<void> {
	await page.addInitScript(({ availability }) => {
		const state = { prompts: [] as string[], published: false };
		const createClone = () => ({
			prompt: async (input: string) => {
				state.prompts.push(input);
				return JSON.stringify({ candidates: ['まずは自然な返答です。', '少しだけキャラクターらしい返答です。', 'ちょっと変化球の返答です。'] });
			},
			destroy: () => {}
		});
		Object.assign(window, {
			__promptApiState: state,
			LanguageModel: {
				availability: async () => availability,
				create: async () => ({
					clone: async () => createClone(),
					destroy: () => {}
				})
			}
		});
		}, { availability });
}

async function seedRelayAccount(page: Page, secretKey: Uint8Array, pubkey: string, lifespanExpiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000, points = 0, abilities = { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, rootPoints = 0): Promise<void> {
	const fixtureAccountIndex = fixtureAccountIndexForSecret(secretKey);
	await page.goto('/favicon.svg');
	await page.evaluate(async ({ accountPubkey, accountIndex, expiresAtMs, points, abilities, characterId, rootPoints }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account', 7);
			request.onupgradeneeded = () => {
				for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
				request.result.createObjectStore('persona-bubble-field-root-secret');
				request.result.createObjectStore('persona-bubble-field-player-state');
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, new Uint8Array(16)));
		const now = Date.now();
		const transaction = database.transaction(['persona-bubble-field-root-secret', 'persona-bubble-field-player-state'], 'readwrite');
		transaction.objectStore('persona-bubble-field-root-secret').put(wrappingKey, 'root-wrapping-key');
		transaction.objectStore('persona-bubble-field-root-secret').put({ version: 1, iv, ciphertext }, 'encrypted-root-entropy');
		transaction.objectStore('persona-bubble-field-player-state').put({
			schemaVersion: 2,
			rootPoints,
			identities: [{ generation: 1, accountIndex, pubkey: accountPubkey, characterId, identityCreatedAtMs: now,
				status: 'alive', characterProfileRevision: 2, runHistory: [] }],
			mode: { kind: 'running', activeRun: { runNumber: 1, revision: 0, startedAtMs: now,
				identity: { generation: 1, accountIndex, pubkey: accountPubkey },
				rootBuild: { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 },
				gameState: {
					version: 4, personaPubkey: accountPubkey, lifespanExpiresAtMs: expiresAtMs,
					pointProgressTicks: 0, inferenceAccelerationUsedMs: 0,
			points, abilities, mendingJob: null
				} } }
		}, 'player-lifecycle');
		await new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		database.close();
	}, { accountPubkey: pubkey, accountIndex: fixtureAccountIndex, expiresAtMs: lifespanExpiresAtMs, points, abilities, rootPoints, characterId: requireCharacterFromPubkey(pubkey).characterId });
}

async function readRelayGameState(page: Page): Promise<{
	version: number;
	personaPubkey: string;
	lifespanExpiresAtMs: number;
	points: number;
	pointProgressTicks: number;
	abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number };
	mendingJob: unknown;
}> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state');
			const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
			return await new Promise<{ version: number; personaPubkey: string; lifespanExpiresAtMs: number; points: number; pointProgressTicks: number; abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number }; mendingJob: unknown }>((resolve, reject) => {
				transaction.oncomplete = () => resolve((request.result as { mode: { activeRun: { gameState: { version: number; personaPubkey: string; lifespanExpiresAtMs: number; points: number; pointProgressTicks: number; abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number }; mendingJob: unknown } } } }).mode.activeRun.gameState);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	});
}

function realtimeInstanceIds(request: { filters: Array<Record<string, unknown>> }): string[] {
	return request.filters.flatMap((filter) => (filter['#i'] as string[] | undefined) ?? []);
}

function isRealtimeRequest(request: { filter: Record<string, unknown> }): boolean {
	return (request.filter.kinds as number[] | undefined)?.includes(7070) ?? false;
}

async function readRealtimePendingInstances(page: Page): Promise<string[]> {
	return page.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state');
			const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
			return await new Promise<string[]>((resolve, reject) => {
				transaction.oncomplete = () => resolve([...(request.result as { realtimeSettlementLedger?: { pendingInstanceIds?: string[] } } | undefined)?.realtimeSettlementLedger?.pendingInstanceIds ?? []]);
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	});
}

async function seedRealtimePendingInstance(page: Page, instanceId: string): Promise<void> {
	await page.evaluate(async (pendingInstanceId) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const request = store.get('player-lifecycle');
			await new Promise<void>((resolve, reject) => {
				request.onsuccess = () => {
					const current = request.result as { mode: { activeRun: { identity: unknown; runNumber: number } }; realtimeSettlementLedger?: { appliedOutcomeIds?: string[] } };
					const ledger = current.realtimeSettlementLedger;
					store.put({ ...current, realtimeSettlementLedger: {
						schemaVersion: 1,
						identity: current.mode.activeRun.identity,
						runNumber: current.mode.activeRun.runNumber,
						pendingInstanceIds: [pendingInstanceId],
						appliedOutcomeIds: ledger?.appliedOutcomeIds ?? []
					} }, 'player-lifecycle');
				};
				request.onerror = () => reject(request.error);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, instanceId);
}

async function overwriteRelayGameState(page: Page, gameState: Record<string, unknown>): Promise<void> {
	await page.evaluate(async (nextGameState) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const request = store.get('player-lifecycle');
			await new Promise<void>((resolve, reject) => {
				request.onsuccess = () => {
					const lifecycle = request.result as { mode: { kind: 'running'; activeRun: { gameState: Record<string, unknown> } } };
					if (nextGameState.version === 99) {
						lifecycle.mode.activeRun.gameState = nextGameState;
					} else {
						const currentGameState = lifecycle.mode.activeRun.gameState;
						const incomingAbilities = (nextGameState.abilities ?? {}) as Record<string, unknown>;
						lifecycle.mode.activeRun.gameState = {
							...currentGameState,
							...nextGameState,
							version: 4,
							pointProgressTicks: 0,
							inferenceAccelerationUsedMs: 0,
							abilities: { ...(currentGameState.abilities as Record<string, unknown>), ...incomingAbilities }
						};
					}
					store.put(lifecycle, 'player-lifecycle');
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, gameState);
}

async function overwriteRelayMendingBuild(page: Page, rootBuild: { inferenceAcceleration: number; contextCompression: number; hallucinationResistance: number }, abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number }): Promise<void> {
	await page.evaluate(async ({ rootBuild: nextRootBuild, abilities: nextAbilities }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			const transaction = database.transaction('persona-bubble-field-player-state', 'readwrite');
			const store = transaction.objectStore('persona-bubble-field-player-state');
			const request = store.get('player-lifecycle');
			await new Promise<void>((resolve, reject) => {
				request.onsuccess = () => {
					const lifecycle = request.result as { mode: { activeRun: { rootBuild: unknown; gameState: { abilities: unknown } } } };
					lifecycle.mode.activeRun.rootBuild = nextRootBuild;
					lifecycle.mode.activeRun.gameState.abilities = nextAbilities;
					store.put(lifecycle, 'player-lifecycle');
				};
				request.onerror = () => reject(request.error);
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => reject(transaction.error);
			});
		} finally { database.close(); }
	}, { rootBuild, abilities });
}

async function seedUnavailablePersona(page: Page, kind: 'missing' | 'corrupt'): Promise<void> {
	await page.goto('/favicon.svg');
	await page.evaluate((stateKind) => new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('persona-bubble-field-account', 7);
		request.onupgradeneeded = () => {
			for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
			request.result.createObjectStore('persona-bubble-field-root-secret');
			request.result.createObjectStore('persona-bubble-field-player-state');
		};
		request.onerror = () => reject(request.error);
		request.onsuccess = () => {
			const database = request.result;
			const transaction = database.transaction(['persona-bubble-field-root-secret', 'persona-bubble-field-player-state'], 'readwrite');
			if (stateKind === 'missing') transaction.objectStore('persona-bubble-field-root-secret').put(true, 'partial');
			if (stateKind === 'corrupt') transaction.objectStore('persona-bubble-field-player-state').put({ schemaVersion: 999 }, 'player-lifecycle');
			transaction.oncomplete = () => { database.close(); resolve(); };
			transaction.onerror = () => { database.close(); reject(transaction.error); };
			transaction.onabort = () => { database.close(); reject(transaction.error); };
		};
	}), kind);
}

async function installDeathTransitionFailure(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const failureKey = 'persona-lifecycle-test-fail-death-transition';
		let armed = sessionStorage.getItem(failureKey) === '1';
		let injected = 0;
		const puts: string[] = [];
		const originalPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
			puts.push(this.name);
			const nextLifecycle = value as { mode?: { kind?: string }; identities?: Array<{ status?: string }> } | null;
			const isDeathTransition = nextLifecycle?.mode?.kind === 'selecting' && nextLifecycle.identities?.some((identity) => identity.status === 'dead') === true;
			if (armed && isDeathTransition && this.name === 'persona-bubble-field-player-state' && this.transaction.mode === 'readwrite') {
				armed = false;
				injected += 1;
				sessionStorage.removeItem(failureKey);
				throw new DOMException('Injected death transition persistence failure.', 'QuotaExceededError');
			}
			return originalPut.call(this, value, key);
		};
		Object.assign(window, {
			__personaLifecycleFailureTest: {
				arm: () => { armed = true; sessionStorage.setItem(failureKey, '1'); },
				injected: () => injected,
				puts: () => puts
			}
		});
	});
}

async function armDeathTransitionFailure(page: Page): Promise<void> {
	await page.evaluate(() => (window as typeof window & {
		__personaLifecycleFailureTest: { arm(): void }
	}).__personaLifecycleFailureTest.arm());
}

async function installDeathTransitionClockRollback(page: Page, rollbackAtMs: number): Promise<void> {
	await page.addInitScript((rollbackTime) => {
		const rollbackKey = 'persona-lifecycle-test-clock-rollback';
		const originalNow = Date.now;
		let rolledBack = sessionStorage.getItem(rollbackKey) === '1';
		let armed = false;
		Date.now = () => rolledBack ? rollbackTime : originalNow();
		const originalGet = IDBObjectStore.prototype.get;
		IDBObjectStore.prototype.get = function (key: IDBValidKey | IDBKeyRange) {
			if (armed && this.name === 'persona-bubble-field-player-state' && key === 'player-lifecycle') {
				armed = false;
				rolledBack = true;
				sessionStorage.setItem(rollbackKey, '1');
			}
			return originalGet.call(this, key);
		};
		Object.assign(window, {
			__personaLifecycleClockRollback: { arm: () => { armed = true; } }
		});
	}, rollbackAtMs);
}

async function armDeathTransitionClockRollback(page: Page): Promise<void> {
	await page.evaluate(() => (window as typeof window & {
		__personaLifecycleClockRollback: { arm(): void }
	}).__personaLifecycleClockRollback.arm());
}

async function composerContextCalls(page: Page): Promise<Array<{
	reply?: string | null;
	preloadedEvents?: Record<string, { id: string; pubkey: string }>;
	preloadedProfiles?: Record<string, { displayName: string; picture: string }>;
}>> {
	return page.evaluate(() => (window as typeof window & { __ehagakiContextCalls?: Array<{
		reply?: string | null;
		preloadedEvents?: Record<string, { id: string; pubkey: string }>;
		preloadedProfiles?: Record<string, { displayName: string; picture: string }>;
	}> }).__ehagakiContextCalls ?? []);
}

async function chooseHorizontalMove(page: Page): Promise<{ key: 'ArrowLeft' | 'ArrowRight'; expected: string }> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	if (x < 15) {
		return { key: 'ArrowRight', expected: `${x + 1},${y}` };
	}
	return { key: 'ArrowLeft', expected: `${x - 1},${y}` };
}

type AvailableMove = {
	key: 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp';
	expected: string;
};

async function chooseMoveToward(page: Page, target: { x: number; y: number }): Promise<AvailableMove> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	if (x < target.x) return { key: 'ArrowRight', expected: `${x + 1},${y}` };
	if (x > target.x) return { key: 'ArrowLeft', expected: `${x - 1},${y}` };
	if (y < target.y) return { key: 'ArrowDown', expected: `${x},${y + 1}` };
	if (y > target.y) return { key: 'ArrowUp', expected: `${x},${y - 1}` };
	throw new Error('Expected the Relay participant to differ from the target.');
}

async function moveRelaySelfTo(page: Page, target: { x: number; y: number }): Promise<void> {
	for (let step = 0; step < 24; step += 1) {
		const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
		if (position === `${target.x},${target.y}`) return;
		const move = await chooseMoveToward(page, target);
		await page.clock.runFor(1_001);
		await page.keyboard.press(move.key);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', move.expected);
	}
	throw new Error(`Self did not reach ${target.x},${target.y}.`);
}

function reverseMoveKey(key: AvailableMove['key']): AvailableMove['key'] {
	switch (key) {
		case 'ArrowDown': return 'ArrowUp';
		case 'ArrowLeft': return 'ArrowRight';
		case 'ArrowRight': return 'ArrowLeft';
		case 'ArrowUp': return 'ArrowDown';
	}
}

test.describe('Relay startup', () => {
	test('accepts a creator-signed manual Rift control from a synthetic DEV channel', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualRiftInstanceId(createdAt, '0123456789abcdef0123456789abcdef');
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: RIFT_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			channelEvent: channel.event,
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control]
		});
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
	});

	test('promotes recovered manual Rift state to current after an active-game reload', async ({ page }) => {
		const channel = syntheticChannelFixture();
		const scheduled = upcomingRegistrationSchedule();
		const initialTime = scheduled.warningAtMs - 30 * 60 * 1_000;
		const createdAt = Math.floor(initialTime / 1_000);
		const manualInstanceId = buildManualRiftInstanceId(createdAt, 'fedcba9876543210fedcba9876543210');
		const manualSchedule = getRiftScheduleForInstance(manualInstanceId, initialTime);
		if (!manualSchedule) throw new Error('Expected the manual schedule fixture.');
		const secret = fixtureSecret(19);
		const control = finalizeRealtimeEvent(buildRealtimeControlEventTemplate({
			channelId: channel.event.id,
			relayHint: AUTHORITATIVE_RELAYS[0],
			instanceId: manualInstanceId,
			payload: { command: 'start', targetProtocolKey: RIFT_PROTOCOL_KEY },
			createdAt
		}), channel.secret);
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			channelEvent: channel.event,
			testWorldConfig: channel.worldConfig,
			primaryEvents: testEvents(initialTime, channel.event.id),
			realtimeEvents: [control],
			persistAcrossReload: true
		});
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(manualInstanceId))).toBe(true);
		const hole = deriveRiftHolePositions(manualInstanceId, { columns: 16, rows: 8 })[0];
		const join = signedRiftAction(secret, manualSchedule, { action: 'join', holeId: hole.id }, initialTime + 1_000, channel.event.id);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(event), join);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
		await page.evaluate(({ controlEvent, joinEvent }) => {
			const harness = (window as typeof window & { __relayStartupTest: { state: { published: object[] } } }).__relayStartupTest;
			harness.state.published.push(controlEvent, joinEvent);
		}, { controlEvent: control, joinEvent: join });
		await page.clock.setSystemTime(manualSchedule.gameAtMs + RIFT_CONSULTATION_MS + 1_000);
		await page.reload();
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 1');
		await expect(page.locator('[data-rift-choice="maintain"]')).toBeEnabled();
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([manualInstanceId]);
	});

	test('keeps primary and Trace ahead of an unknown-capacity realtime attempt', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), hiddenSubscriptionLimit: 3 });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBe(AUTHORITATIVE_RELAYS.length);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[])[0] === 1111)).toBe(true);
		const startupRequests = (await relayState(page)).state.requests;
		// Realtime may be requested before Trace finishes configuring. The
		// priority contract is the final ownership after reconfiguration, not the
		// incidental order of the first REQ packets.
		expect(startupRequests.some(isRealtimeRequest)).toBe(true);
		expect(startupRequests.some((request) => (request.filter.kinds as number[])[0] === 1111)).toBe(true);
		await page.clock.runFor(10_001);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'degraded');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number; activeTraceReplyCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeTraceReplyCount(): number } }).__relayStartupTest.activeTraceReplyCount())).toBeGreaterThan(0);
		const primaryRequests = (await relayState(page)).state.requests.filter((request) =>
			[42, 30078].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000);
		expect(primaryRequests).toHaveLength(AUTHORITATIVE_RELAYS.length * 2);
	});

	test('keeps control realtime during dormancy and switches to the scheduled instance at registration', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const initialTime = schedule.warningAtMs - 1_000;
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(schedule.registrationAtMs + 1_000) });
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBe(AUTHORITATIVE_RELAYS.length);
		const realtimeRequestsBeforeRegistration = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(realtimeRequestsBeforeRegistration).toHaveLength(AUTHORITATIVE_RELAYS.length);
		expect(realtimeInstanceIds(realtimeRequestsBeforeRegistration[0])).toEqual([]);

		await page.clock.setSystemTime(schedule.warningAtMs + 1_000);
		await page.clock.runFor(1_000);
		expect((await relayState(page)).state.requests.filter(isRealtimeRequest)).toHaveLength(AUTHORITATIVE_RELAYS.length);
		await page.clock.setSystemTime(schedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).some((request) => realtimeInstanceIds(request).includes(schedule.instanceId))).toBe(true);

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeRealtimeCount(): number }
		}).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const state = (await relayState(page)).state;
		expect(state.closedSubscriptions.some((closed) => state.requests.some((request) => request.subId === closed.subId && isRealtimeRequest(request)))).toBe(true);
	});

	test('starts realtime early only for a persisted settlement recovery instance', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const previousSchedule = getRiftSchedule(schedule.warningAtMs - 24 * 60 * 60 * 1000);
		const initialTime = schedule.warningAtMs - 1_000;
		await page.clock.install({ time: initialTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(initialTime) });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await seedRealtimePendingInstance(page, previousSchedule.instanceId);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			isRealtimeRequest(request) && realtimeInstanceIds(request).includes(previousSchedule.instanceId))).toBe(true);
		const earlyRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(earlyRealtimeRequests.every((request) => {
			const instances = realtimeInstanceIds(request);
			return instances?.length === 1 && instances[0] === previousSchedule.instanceId;
		})).toBe(true);
	});

	test('restarts realtime for the next day without recreating the world session', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const nextSchedule = getRiftSchedule(schedule.warningAtMs + 24 * 60 * 60 * 1_000);
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
		const firstRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		expect(firstRealtimeRequests.some((request) => realtimeInstanceIds(request).length === 1 && realtimeInstanceIds(request)[0] === schedule.instanceId)).toBe(true);
		const primaryRequestCount = (await relayState(page)).state.requests.filter((request) =>
			[42, 30078].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000).length;

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		const closedAfterFirstDay = (await relayState(page)).state.closedSubscriptions;
		const firstRequestIds = new Set(firstRealtimeRequests.map((request) => request.subId));
		expect(closedAfterFirstDay.some((closed) => firstRequestIds.has(closed.subId))).toBe(true);

		await page.clock.setSystemTime(nextSchedule.registrationAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(firstRealtimeRequests.length);
		const allRealtimeRequests = (await relayState(page)).state.requests.filter(isRealtimeRequest);
		const nextRealtimeRequests = allRealtimeRequests.slice(firstRealtimeRequests.length);
		expect(nextRealtimeRequests.length).toBeGreaterThan(0);
		expect(nextRealtimeRequests.some((request) => realtimeInstanceIds(request).length === 1 && realtimeInstanceIds(request)[0] === nextSchedule.instanceId)).toBe(true);
		expect((await relayState(page)).state.requests.filter((request) =>
			[42, 30078].includes((request.filter.kinds as number[])[0]) && request.filter.limit !== 1_000)).toHaveLength(primaryRequestCount);

		const nextHole = deriveRiftHolePositions(nextSchedule.instanceId, { columns: 16, rows: 8 })[0];
		const nextJoin = signedRiftAction(secret, nextSchedule, { action: 'join', holeId: nextHole.id }, nextSchedule.registrationAtMs + 1_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest.injectRealtimeEvent(event), nextJoin);
		await page.clock.setSystemTime(nextSchedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 1');
	});

	test('keeps normal world movement and conversation available when realtime is unavailable', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeTerminal: 'closed' });
		const secret = fixtureSecret(41);
		const pubkey = getPublicKey(secret);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const self = page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`);
		await expect(self).toBeVisible();
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => (request.filter.kinds as number[])[0] === 7070).length).toBeGreaterThan(0);
		await expect(page.locator('[data-realtime-panel]')).toHaveAttribute('data-realtime-status', 'degraded');

		await editor.fill('normal world survives realtime timeout');
		await editor.press('Enter');
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.content === 'normal world survives realtime timeout')).toBe(true);
		const move = await chooseHorizontalMove(page);
		await editor.fill('');
		await editor.focus();
		await page.clock.runFor(1_001);
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('does not create a settlement recovery marker for a spectator receiving another player join', async ({ page }) => {
		const schedule = upcomingRegistrationSchedule();
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const spectatorEvent = signedRiftAction(fixtureSecret(20), schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000);
		await page.clock.install({ time: schedule.registrationAtMs + 1_000 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(schedule.registrationAtMs + 1_000), realtimeEvents: [spectatorEvent] });
		const secret = fixtureSecret(19);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
	});

	test('rejects a stale Rift join confirmation after movement or registration ends', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const startTime = schedule.registrationAtMs + 1_000;
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), realtimeEvents: [], realtimePublishOutcome: 'accepted' });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('[data-realtime-hole-trigger]')).toHaveCount(1);

		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);

		const farPosition = { x: hole.position.x > 2 ? hole.position.x - 2 : hole.position.x + 2, y: hole.position.y };
		const farEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: farPosition, slot: 0, createdAt: Math.floor((startTime + 3_000) / 1000) }), selfSecret);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), farEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${farPosition.x},${farPosition.y}`);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const nearEventAgain = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 4_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEventAgain);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.setSystemTime(schedule.gameAtMs + 1_000);
		await page.clock.runFor(1_000);
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
	});

	test('completes Rift join, snapshot, commit, automatic reveal, settlement, and reload recovery', async ({ page }) => {
		let schedule = upcomingRegistrationSchedule();
		const selfPosition = { x: 3, y: 2 };
		while (true) {
			const candidateHole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
			if (Math.max(Math.abs(candidateHole.position.x - selfPosition.x), Math.abs(candidateHole.position.y - selfPosition.y)) > 1) break;
			schedule = getRiftSchedule(schedule.endedAtMs + 1);
		}
		const hole = deriveRiftHolePositions(schedule.instanceId, { columns: 16, rows: 8 })[0];
		const otherPlayers = [
			{ secret: fixtureSecret(20), choice: 'maintain' as const, nonce: '1'.repeat(64) },
			{ secret: fixtureSecret(21), choice: 'maintain' as const, nonce: '2'.repeat(64) }
		];
		const otherJoins = otherPlayers.map(({ secret }) => signedRiftAction(secret, schedule, { action: 'join', holeId: hole.id }, schedule.registrationAtMs + 1_000));
		const otherCommits = otherPlayers.map(({ secret, choice, nonce }) => {
			const pubkey = getPublicKey(secret);
			const action = buildRiftCommitAction({ instanceId: schedule.instanceId, holeId: hole.id, round: 1, authorPubkey: pubkey, choice, nonce });
			const event = signedRiftAction(secret, schedule, action, getRiftRoundSchedule(schedule, 1).selectionAtMs + 1_000);
			return { secret, pubkey, choice, nonce, event };
		});
		const otherReveals = otherCommits.map(({ secret, choice, nonce, event }) => signedRiftAction(secret, schedule,
			buildRiftRevealAction({ holeId: hole.id, round: 1, commitId: event.id, choice, nonce }), getRiftRoundSchedule(schedule, 1).resultAtMs + 1_000));
		const startTime = schedule.registrationAtMs + 1_000;
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: testEvents(startTime),
			realtimeEvents: [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals],
			persistAcrossReload: true,
			realtimePublishOutcome: 'accepted'
		});
		const selfSecret = fixtureSecret(19);
		const selfPubkey = getPublicKey(selfSecret);
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加受付');
		const panelLayout = await page.locator('[data-realtime-panel]').evaluate((panel) => {
			const rect = panel.getBoundingClientRect();
			return { centerX: rect.left + rect.width / 2, top: rect.top, right: rect.right, viewportWidth: window.innerWidth };
		});
		expect(Math.abs(panelLayout.centerX - panelLayout.viewportWidth / 2)).toBeLessThanOrEqual(1);
		expect(panelLayout.top).toBeGreaterThanOrEqual(0);
		expect(panelLayout.right).toBeLessThanOrEqual(panelLayout.viewportWidth);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${selfPubkey}"]`)).toBeVisible();

		await page.locator('[data-realtime-hole-trigger]').click();
		await page.clock.runFor(50);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		const nearPosition = hole.position.y > 0 ? { x: hole.position.x, y: hole.position.y - 1 } : { x: hole.position.x, y: hole.position.y + 1 };
		const nearEvent = finalizeEvent(buildWorldStateEventTemplate({ channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: nearPosition, slot: 0, createdAt: Math.floor((startTime + 2_000) / 1000) }), selfSecret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearEvent);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', `${nearPosition.x},${nearPosition.y}`);
		await page.locator('[data-realtime-hole-trigger]').click();
		await expect(page.getByRole('dialog')).toContainText('3〜6人 / 全3ラウンド');
		await expect(page.getByRole('dialog')).toContainText('脱出を選んだ者は死亡');
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.getByRole('button', { name: 'キャンセル' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect((await relayState(page)).state.published.filter((event) => event.kind === 7070 && event.pubkey === selfPubkey)).toHaveLength(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('rejected'));
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		}).length).toBeGreaterThan(0);
		await expect(page.locator('[data-realtime-panel]')).not.toContainText('参加済み');
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveCount(0);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { setRealtimePublishOutcome(outcome: 'accepted' | 'rejected' | 'echo' | 'no-response'): void } }).__relayStartupTest.setRealtimePublishOutcome('accepted'));
		await page.locator('[data-realtime-hole-trigger]').click();
		await page.getByRole('button', { name: '参加する' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => {
			if (event.kind !== 7070 || event.pubkey !== selfPubkey) return false;
			try { return (JSON.parse(event.content) as { action?: string }).action === 'join'; } catch { return false; }
		})).toBe(true);
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加済み');
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveCount(1);
		await expect(page.locator('[data-realtime-hole-trigger][aria-pressed="true"]')).toHaveAttribute('aria-label', '抜け穴へ参加済み（参加先）');

		const round = getRiftRoundSchedule(schedule, 1);
		await page.clock.setSystemTime(round.selectionAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect(page.locator('[data-realtime-panel]')).toContainText('秘密選択');
		await expect(page.locator('[data-realtime-panel]')).toContainText('参加者: 3');
		await page.locator('[data-rift-choice="maintain"]').click();
		await expect(page.locator('[data-rift-choice="maintain"]')).toBeDisabled();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'commit')).toBe(true);

		await page.clock.setSystemTime(round.resultAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 7070 && event.pubkey === selfPubkey && JSON.parse(event.content).action === 'reveal')).toBe(true);
		await expect(page.locator('[data-rift-selection-status]')).toContainText('自動公開済み');

		await page.clock.setSystemTime(round.resultAtMs + 2_000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('[data-realtime-panel]')).toContainText('綻びゲーム中');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => (request.filter.kinds as number[])[0] === 7070)).toBe(true);
		await page.evaluate((events) => {
			const relay = (window as typeof window & { __relayStartupTest: { injectRealtimeEvent(event: object): void } }).__relayStartupTest;
			for (const event of events) relay.injectRealtimeEvent(event);
		}, [...otherJoins, ...otherCommits.map(({ event }) => event), ...otherReveals]);
		await page.clock.runFor(100);
		await page.clock.setSystemTime(round.revealCutoffAtMs + 1_000);
		await page.clock.runFor(2_000);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(20);
		await expect(page.locator('[data-rift-round-result]')).toContainText('+20pt');

		await page.clock.setSystemTime(schedule.endedAtMs + 1_000);
		await page.clock.runFor(1_000);
		await expect.poll(async () => readRealtimePendingInstances(page)).toEqual([]);
		await expect.poll(async () => page.evaluate(() => (window as typeof window & { __relayStartupTest: { activeRealtimeCount(): number } }).__relayStartupTest.activeRealtimeCount())).toBe(AUTHORITATIVE_RELAYS.length);
		await expect(page.locator('[data-realtime-hole-trigger]')).toHaveCount(0);
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(20);
	});

	test('reloads and reconciles a valid Run after a death transition clock rollback', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installDeathTransitionClockRollback(page, startTime);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		const expiresAtMs = startTime + 60_000;
		await seedRelayAccount(page, secret, pubkey, expiresAtMs);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await armDeathTransitionClockRollback(page);
		const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
		await page.clock.setSystemTime(expiresAtMs + 1);
		await page.clock.runFor(1_000);
		await reloaded;
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		expect((await relayState(page)).state.published.some((event) => event.kind === 30078 && event.pubkey === pubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(false);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 30078 && event.pubkey === pubkey)).toBe(true);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('valid run remains publishable after rollback reconciliation');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === pubkey)).toBe(true);
	});

	test('rejects a stale Run world write after another tab commits death selection', async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		const secret = fixtureSecret(57);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.composer-dock')).toBeVisible();
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		const deathTab = await page.context().newPage();
		try {
			await installHostOwnedStub(deathTab);
			await installDelayedRelay(deathTab);
			await deathTab.goto('/');
			await overwriteRelayGameState(deathTab, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await deathTab.reload({ waitUntil: 'domcontentloaded' });
			await expect(deathTab.getByRole('dialog')).toBeVisible();
			await expect(deathTab.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);

			const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			await editor.fill('stale Run must not publish after death commit');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await reloaded;
			await expect(page.getByRole('dialog')).toBeVisible();
			await expect.poll(async () => {
				const state = (await relayState(page)).state;
				return state.published.some((event) => event.kind === 42 && event.pubkey === oldPubkey && event.content === 'stale Run must not publish after death commit');
			}).toBe(false);
		} finally {
			await deathTab.close();
		}
	});

	test('reconciles stale mending into pending selection after another tab commits death', async ({ page }) => {
		await page.clock.install({ time: Date.now() });
		const secret = fixtureSecret(57);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: '作業を開始' })).toHaveCount(0);

		const deathTab = await page.context().newPage();
		try {
			await installHostOwnedStub(deathTab);
			await installDelayedRelay(deathTab);
			await deathTab.goto('/');
			await overwriteRelayGameState(deathTab, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await deathTab.reload({ waitUntil: 'domcontentloaded' });
			await expect(deathTab.getByRole('dialog')).toBeVisible();

			await page.getByRole('dialog').getByRole('button', { name: '閉じる', exact: true }).click();
			await page.reload({ waitUntil: 'domcontentloaded' });
			await expect(page.getByRole('dialog')).toBeVisible();
			await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		} finally {
			await deathTab.close();
		}
	});

	test('falls back to a read-only world when startup death transition fails', async ({ page }) => {
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		const events = testEvents();
		await installDeathTransitionFailure(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: events });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await overwriteRelayGameState(page, {
			version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: Date.now() - 1, points: 321, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 }
		});
		await armDeathTransitionFailure(page);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
		await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		expect((await publishedMessages(page))).toHaveLength(0);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__personaLifecycleFailureTest: { injected(): number }
		}).__personaLifecycleFailureTest.injected())).toBe(1);
		const persisted = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const transaction = database.transaction('persona-bubble-field-player-state');
				const request = transaction.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<{ pubkey: string; lifespanExpiresAtMs: number }>((resolve, reject) => {
					transaction.oncomplete = () => {
						const state = request.result as { mode: { activeRun: { identity: { pubkey: string }; gameState: { lifespanExpiresAtMs: number } } } };
						resolve({ pubkey: state.mode.activeRun.identity.pubkey, lifespanExpiresAtMs: state.mode.activeRun.gameState.lifespanExpiresAtMs });
					};
					transaction.onerror = () => reject(transaction.error);
				});
			} finally { database.close(); }
		});
		expect(persisted).toEqual({ pubkey, lifespanExpiresAtMs: expect.any(Number) });
		expect(persisted.lifespanExpiresAtMs).toBeLessThan(Date.now());
	});

	test('keeps a deterministic three-choice selection pending until one Identity is chosen', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await expect.poll(() => page.locator('main > :not(.selection-backdrop)').evaluateAll((elements) => elements.every((element) => (element as HTMLElement).inert))).toBe(true);
		await expect(page.getByRole('heading', { name: 'Runを始める' })).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(candidateButtons.first()).toBeFocused();
		await page.keyboard.press('Shift+Tab');
		await expect(page.getByRole('button', { name: /Root build/ })).toBeFocused();
		expect((await relayState(page)).state.published.filter((event) => event.kind === 0)).toHaveLength(0);
		const labelsBeforeReload = await candidateButtons.allTextContents();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		const reloadedButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(reloadedButtons).toHaveCount(3);
		expect(await reloadedButtons.allTextContents()).toEqual(labelsBeforeReload);
		await page.evaluate(() => { document.documentElement.dataset.identitySelectionDocumentToken = crypto.randomUUID(); });
		const documentToken = await page.locator('html').getAttribute('data-identity-selection-document-token');
		await reloadedButtons.nth(1).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		expect(await page.locator('html').getAttribute('data-identity-selection-document-token')).toBe(documentToken);
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) =>
			request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length).toBeGreaterThan(0);
		const requestCountsAfterRelease = await (async () => {
			const requests = (await relayState(page)).state.requests;
			return {
				metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length
			};
		})();
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const requestCountsAfterSelection = await (async () => {
			const requests = (await relayState(page)).state.requests;
			return {
				metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
				primary: requests.filter((request) => request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length
			};
		})();
		expect(requestCountsAfterSelection).toEqual(requestCountsAfterRelease);
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		expect(selectedPubkey).toBeTruthy();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 30078 && event.pubkey === selectedPubkey)).toBe(true);
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 0 && event.pubkey === selectedPubkey)).toBe(true);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('selected identity remains publishable without a reload');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.pubkey === selectedPubkey && event.content === 'selected identity remains publishable without a reload')).toBe(true);
		const lifecycle = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<{ mode: string; identities: number; runNumber: number }>((resolve, reject) => {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					request.onsuccess = () => {
						const state = request.result as { identities: unknown[]; mode: { kind: string; activeRun?: { runNumber: number } } };
						resolve({ mode: state.mode.kind, identities: state.identities.length, runNumber: state.mode.activeRun?.runNumber ?? 0 });
					};
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		expect(lifecycle).toEqual({ mode: 'running', identities: 1, runNumber: 1 });
	});

	test('allocates a Root build before starting a Run', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		await page.setViewportSize({ width: 420, height: 420 });
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await setPendingRootPoints(page, 0);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		const rootToggle = page.locator('.root-build-toggle');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
		await expect(rootToggle).toContainText('使用 0 / 0 RP');
		await expect(page.locator('.rank-controls')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeEnabled();
		await setPendingRootPoints(page, 3);
		await page.reload({ waitUntil: 'domcontentloaded' });

		await expect(page.locator('.rp-summary')).toContainText('3 RP');
		const rootBuild = page.locator('.root-build');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(rootBuild.locator('.ability-row')).toHaveCount(3);
		await rootToggle.focus();
		await page.keyboard.press('Enter');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'false');
		await page.keyboard.press('Space');
		await expect(rootToggle).toHaveAttribute('aria-expanded', 'true');
		await expect(rootBuild.getByRole('button', { name: '推論加速の詳細' })).toBeVisible();
		const mobileLayout = await rootBuild.locator('.ability-row').first().evaluate((row) => {
			const main = row.querySelector('.ability-main')?.getBoundingClientRect();
			const content = row.closest('.selection-content');
			if (!main || !(content instanceof HTMLElement)) throw new Error('ability layout is incomplete');
			return { mainWidth: main.width, noHorizontalOverflow: content.scrollWidth <= content.clientWidth };
		});
		expect(mobileLayout.mainWidth).toBeGreaterThan(120);
		expect(mobileLayout.noHorizontalOverflow).toBe(true);
		await page.setViewportSize({ width: 1280, height: 800 });
		const desktopCenters = await rootBuild.locator('.ability-row').first().evaluate((row) => {
			const help = row.querySelector('.help-trigger')?.getBoundingClientRect();
			const rank = row.querySelector('.rank-controls button')?.getBoundingClientRect();
			if (!help || !rank) throw new Error('ability controls are incomplete');
			return { helpCenter: help.top + help.height / 2, rankCenter: rank.top + rank.height / 2 };
		});
		expect(Math.abs(desktopCenters.helpCenter - desktopCenters.rankCenter)).toBeLessThanOrEqual(1);
		await expect.poll(async () => rootBuild.locator('.help-trigger').evaluateAll((elements) => elements.every((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width >= 44 && rect.height >= 44;
		}))).toBe(true);
		await expect.poll(async () => rootBuild.locator('.rank-controls button').first().evaluate((element) => {
			const rect = element.getBoundingClientRect();
			return rect.width >= 44 && rect.height >= 44;
		})).toBe(true);
		const selectionContent = page.locator('.selection-content');
		await selectionContent.evaluate((element) => { element.scrollTop = element.scrollHeight - element.clientHeight; });
		const help = rootBuild.getByRole('button', { name: '推論加速の詳細' });
		await help.scrollIntoViewIfNeeded();
		const scrollBeforeHelp = await selectionContent.evaluate((element) => element.scrollTop);
		await help.click();
		await expect(page.locator('.help-content')).toBeVisible();
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('推論加速の詳細');
		await help.click();
		await expect(page.locator('.help-content')).toHaveCount(0);
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await help.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('.help-content')).toBeVisible();
		await expect.poll(async () => selectionContent.evaluate((element) => element.scrollTop)).toBe(scrollBeforeHelp);
		await expect.poll(async () => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('推論加速の詳細');
		await page.keyboard.press('Escape');
		await expect(rootBuild).not.toContainText('Rank 3: ×2.00');
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		const rankRows = page.locator('.ability-row');
		for (let index = 0; index < 3; index += 1) {
			await rankRows.nth(index).getByRole('button', { name: /を上げる$/ }).click();
		}
		await expect.poll(async () => page.locator('.rank-controls button[aria-label$="を上げる"]').evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled))).toBe(true);
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeEnabled();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
	});

	test('reuses a completed anonymous world session after Identity selection', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) =>
			request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length).toBeGreaterThan(0);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filter.limit === undefined && requestKind(request) === 30078)).toBe(true);
		const requestsBeforeSelection = await relayState(page);
		const countBootstrapRequests = (requests: typeof requestsBeforeSelection.state.requests) => ({
			metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
			primary: requests.filter((request) => request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length
		});
		const countsBeforeSelection = countBootstrapRequests(requestsBeforeSelection.state.requests);
		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		expect(countBootstrapRequests((await relayState(page)).state.requests)).toEqual(countsBeforeSelection);
	});

	test('enters a selected identity before delayed Trace promotion and settles the existing ordering afterward', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferTraceRoots: true });
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => request.filter.limit === undefined && requestKind(request) === 30078)).toBe(true);
		const beforeSelection = await relayState(page);
		const bootstrapCounts = (requests: typeof beforeSelection.state.requests) => ({
			metadata: requests.filter((request) => [40, 41].includes(requestKind(request)!)).length,
			primary: requests.filter((request) => request.filter.limit === undefined && [42, 30078].includes(requestKind(request)!)).length
		});
		const countsBeforeSelection = bootstrapCounts(beforeSelection.state.requests);

		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 30078 && event.pubkey === selectedPubkey)).toBe(true);
		expect(bootstrapCounts((await relayState(page)).state.requests)).toEqual(countsBeforeSelection);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseTraceRoots(): void } }).__relayStartupTest.releaseTraceRoots());
		await expect.poll(async () => (await relayState(page)).state.requests.filter(isRealtimeRequest).length).toBeGreaterThan(0);
	});

	test('clears an anonymous startup error before fresh signed fallback recovery', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		const metadataRequestsBeforeSelection = (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length;
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { failMetadataDiscovery(): void } }).__relayStartupTest.failMetadataDiscovery());
		await candidateButtons.nth(0).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect.poll(async () => (await relayState(page)).state.requests.filter((request) => [40, 41].includes(requestKind(request)!)).length)
			.toBeGreaterThan(metadataRequestsBeforeSelection);
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const selectedPubkey = await page.locator('.participant[data-self="true"]').getAttribute('data-participant-id');
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('fresh signed fallback remains publishable');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await relayState(page)).state.published.some((event) =>
			event.kind === 42 && event.pubkey === selectedPubkey && event.content === 'fresh signed fallback remains publishable')).toBe(true);
	});

	test('scrolls an overflowing mobile identity selection to the last candidate', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');

		const dialog = page.locator('.selection-dialog');
		const candidateButtons = page.getByRole('button', { name: /を選ぶ$/ });
		await expect(candidateButtons).toHaveCount(3);
		await page.setViewportSize({ width: 420, height: 420 });
		await page.locator('.candidate-about').nth(1).evaluate((element) => {
			element.textContent = '長いプロフィール。'.repeat(160);
		});

		const content = page.locator('.selection-content');
		const footer = page.locator('.selection-footer');
		const before = await dialog.evaluate((element) => {
			const content = element.querySelector('.selection-content');
			const footer = element.querySelector('.selection-footer');
			if (!(content instanceof HTMLElement) || !(footer instanceof HTMLElement)) throw new Error('selection layout is incomplete');
			const dialogRect = element.getBoundingClientRect();
			const footerRect = footer.getBoundingClientRect();
			return {
				dialogInsideViewport: dialogRect.top >= 0 && dialogRect.bottom <= window.innerHeight && dialogRect.left >= 0 && dialogRect.right <= window.innerWidth,
				contentScrollable: content.scrollHeight > content.clientHeight,
				contentScrollTop: content.scrollTop,
				footerBottom: footerRect.bottom,
				footerHeight: footerRect.height
			};
		});
		expect(before.dialogInsideViewport).toBe(true);
		expect(before.contentScrollable).toBe(true);
		expect(before.footerBottom).toBeLessThanOrEqual(420);
		await candidateButtons.nth(2).scrollIntoViewIfNeeded();
		await expect(candidateButtons.nth(2)).toBeVisible();
		const afterScroll = await content.evaluate((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
		expect(afterScroll.scrollTop).toBeGreaterThan(0);
		expect(afterScroll.scrollTop).toBeLessThanOrEqual(afterScroll.scrollHeight - afterScroll.clientHeight);
		await expect(footer).toBeVisible();
		await expect(page.getByRole('button', { name: 'Runを開始' })).toBeVisible();
		const footerAfterScroll = await footer.boundingBox();
		expect(footerAfterScroll).not.toBeNull();
		expect(footerAfterScroll!.y + footerAfterScroll!.height).toBeLessThanOrEqual(420);
		await candidateButtons.nth(2).click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
	});

	test('starts identity selection with the heading focused and keeps candidate keyboard selection available', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');

		const dialog = page.locator('.selection-dialog');
		const candidates = page.getByRole('button', { name: /を選ぶ$/ });
		const runButton = page.getByRole('button', { name: 'Runを開始' });
		await expect(candidates).toHaveCount(3);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('heading', { name: 'Runを始める' })).toBeFocused();
		await expect(candidates).toHaveCount(3);
		await expect(dialog.locator('.candidate.chosen')).toHaveCount(0);
		await expect(dialog.locator('.candidate-check')).toHaveCount(0);
		await expect(dialog).toContainText('選択中未選択');
		await expect(runButton).toBeDisabled();

		await page.keyboard.press('Shift+Tab');
		await expect(dialog.getByRole('button', { name: /Root build/ })).toBeFocused();
		await dialog.getByRole('heading', { name: 'Runを始める' }).focus();
		await page.keyboard.press('Tab');
		await expect(candidates.first()).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(candidates.first()).toHaveClass(/chosen/);
		await expect(dialog.locator('.candidate-check')).toHaveCount(1);
		await expect(dialog).not.toContainText('選択中未選択');
		await expect(runButton).toBeEnabled();
	});

	for (const viewport of [{ width: 1280, height: 800 }, { width: 420, height: 800 }]) {
		test(`centers the identity selection dialog at ${viewport.width}px`, async ({ page }) => {
			await installHostOwnedStub(page);
			await installDelayedRelay(page);
			await page.goto('/');
			await page.setViewportSize(viewport);
			const dialog = page.locator('.selection-dialog');
			await expect(dialog).toBeVisible();
			const metrics = await dialog.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, width: rect.width, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
			});
			expect(Math.abs(metrics.centerX - metrics.viewportWidth / 2)).toBeLessThanOrEqual(8);
			expect(metrics.centerY).toBeGreaterThan(0);
			expect(metrics.centerY).toBeLessThan(metrics.viewportHeight);
			expect(metrics.width).toBeLessThanOrEqual(metrics.viewportWidth);
			expect(metrics.centerX - metrics.width / 2).toBeGreaterThanOrEqual(0);
			expect(metrics.centerX + metrics.width / 2).toBeLessThanOrEqual(metrics.viewportWidth);
		});
	}

	test('converges two tabs selecting different candidates on one Identity', async ({ page }) => {
		const other = await page.context().newPage();
		try {
			await Promise.all([page, other].map(async (client) => {
				await installHostOwnedStub(client);
				await installDelayedRelay(client);
				await client.goto('/');
				await expect(client.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
			}));
			await page.getByRole('button', { name: /を選ぶ$/ }).nth(0).click();
			await startSelectedRun(page);
			await expect(page.getByRole('dialog')).toHaveCount(0);
			await other.getByRole('button', { name: /を選ぶ$/ }).nth(1).click();
			await startSelectedRun(other);
			await expect.poll(async () => page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					return await new Promise<{ identities: number; mode: string }>((resolve, reject) => {
						request.onsuccess = () => resolve({ identities: (request.result as { identities: unknown[] }).identities.length, mode: (request.result as { mode: { kind: string } }).mode.kind });
						request.onerror = () => reject(request.error);
					});
				} finally { database.close(); }
			})).toEqual({ identities: 1, mode: 'running' });
		} finally {
			await other.close();
		}
	});

	test('runs and collects a mending job only from the adjacent terminal cells', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const terminal = page.getByRole('button', { name: '作業端末' });
		const mendingFacility = page.locator('[data-field-facility="mending-terminal"]');
		await expect(mendingFacility.locator('img')).toHaveAttribute('src', /field\/objects\/mending-terminal\.webp$/);
		await expect(mendingFacility).not.toContainText('作業');
		await expect(page.locator('[data-field-facility="adjustment-terminal"] img')).toHaveAttribute('src', /field\/objects\/adjustment-terminal\.webp$/);
		await expect(page.locator('[data-field-facility="adjustment-terminal"]')).not.toContainText('能力強化');
		await terminal.click();
		await expect(page.getByRole('status')).toContainText('近づくと端末を使える');

		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.runFor(1_001);
		await page.keyboard.press('ArrowRight');
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await dragRelayJoystick(page, { x: 0, y: -100 }, { x: 12, y: 4 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,2');
		await expect(page.getByRole('dialog')).toHaveCount(0);

		const publishedWorldStateCount = async () => (await relayState(page)).state.published.filter((event) => event.kind === 30078 && event.pubkey === pubkey).length;
		const beforeMendingStart = await publishedWorldStateCount();
		await page.clock.runFor(1_001);
		await terminal.click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingStart);
		const started = await readRelayGameState(page);
		expect(started).toMatchObject({ version: 4, points: 0, pointProgressTicks: 0, mendingJob: expect.objectContaining({ processedDurationMs: 0, unclaimedPoints: 0 }) });
		const activeDialog = page.getByRole('dialog');
		await expect(activeDialog.getByRole('heading', { name: '作業中' })).toBeVisible();
		await expect(activeDialog.locator('.mending-startup-feedback')).toContainText('作業を開始しました');
		const startupScrollExtent = await activeDialog.evaluate((element) => ({
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight
		}));
		expect(startupScrollExtent.scrollWidth).toBeLessThanOrEqual(startupScrollExtent.clientWidth);
		await expect.poll(async () => activeDialog.locator('.mending-startup-feedback').count()).toBe(0);
		const settledScrollExtent = await activeDialog.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
		expect(settledScrollExtent.scrollWidth).toBeLessThanOrEqual(settledScrollExtent.clientWidth);
		expect(settledScrollExtent.scrollHeight - settledScrollExtent.clientHeight).toBe(startupScrollExtent.scrollHeight - startupScrollExtent.clientHeight);
		await expect(activeDialog.getByRole('button', { name: '作業を開始' })).toHaveCount(0);
		await expect(activeDialog).toContainText('作業中');
		await expect(activeDialog).toContainText('0 pt');
		await expect(activeDialog).toContainText('上限まで あと5分');
		await expect(activeDialog).not.toContainText('今受け取れる');
		await expect(activeDialog).toContainText('+0 pt');
		await expect(activeDialog.locator('[data-mending-icon="wallet"] svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="coins"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('.result-card[data-mending-icon="heart"] > svg')).toHaveCount(1);
		await expect(activeDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(activeDialog.locator('.reward-group .action-group')).toHaveCount(1);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
		await expect(activeDialog.locator('.mending-success-feedback')).toHaveCount(0);
		await expect(activeDialog.getByRole('button', { name: '成果を受け取る' })).toHaveCSS('color', 'rgb(255, 255, 255)');
		await expect(activeDialog.getByRole('button', { name: '詳細を見る' })).toHaveAttribute('aria-expanded', 'false');
		await activeDialog.getByRole('button', { name: '詳細を見る' }).click();
		await expect(activeDialog).toContainText('現在のポイント速度');
		await expect(activeDialog.getByRole('button', { name: '詳細を閉じる' })).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('.lifespan-hud')).toContainText('作業中 +0.1h/h');
		await expect(page.locator('.lifespan-hud')).toContainText('ポイント 0pt');
		await page.getByRole('button', { name: '閉じる', exact: true }).click();

		const startedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs;
		const partialAt = startedAt + 2 * 60 * 1000 + 30 * 1000;
		await page.clock.setSystemTime(partialAt);
		await pauseAtCurrentBrowserTime(page);
		await terminal.click();
		const partialDialog = page.getByRole('dialog');
		await expect(partialDialog.locator('.mending-startup-feedback')).toHaveCount(0);
		await expect(partialDialog).toContainText('上限まで あと3分');
		await expect(partialDialog).toContainText(/次の1ptまで [1-9][0-9]?秒/);
		await expect(partialDialog.locator('.next-point[data-mending-icon="clock"] > svg')).toHaveCount(1);
		await expect(partialDialog.locator('[data-mending-icon="coins"] .next-point')).toHaveCount(1);
		await expect(partialDialog).toContainText('+2 pt');
		const beforeMendingReward = await publishedWorldStateCount();
		await partialDialog.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(async () => {
			const partialState = await readRelayGameState(page);
			return partialState.points === 2 && partialState.pointProgressTicks > 0 && partialState.pointProgressTicks < 60_000_000;
		}).toBe(true);
		await expect.poll(publishedWorldStateCount).toBeGreaterThan(beforeMendingReward);
		await expect(page.locator('.mending-success-feedback')).toContainText('+2 pt');

		const secondAt = partialAt + 3 * 60 * 1000;
		await page.clock.setSystemTime(secondAt);
		await pauseAtCurrentBrowserTime(page);
		if (await page.getByRole('dialog').count() > 0) await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await terminal.click();
		await expect(page.getByRole('dialog')).toContainText('+3 pt');
		await page.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(async () => (await readRelayGameState(page)).points).toBe(5);

		if (await page.getByRole('dialog').count() > 0) await page.getByRole('button', { name: '閉じる', exact: true }).click();
		const afterSecond = await readRelayGameState(page);
		const fullAt = (afterSecond.mendingJob as { startedAtMs: number }).startedAtMs + 5 * 60 * 1000;
		await page.clock.setSystemTime(fullAt);
		await pauseAtCurrentBrowserTime(page);
		const completedAtTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 2 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), completedAtTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,2');
		await terminal.click();
		await expect(page.getByRole('dialog')).toContainText('上限に達しました');
		await expect(page.getByRole('dialog').getByRole('heading', { name: '作業停止中' })).toBeVisible();
		await expect(page.getByRole('dialog')).not.toContainText('今受け取れる');
		await expect(page.getByRole('dialog')).toContainText('+5 pt');
		await expect(page.getByRole('dialog')).not.toContainText('次の1ptまで');
		await expect(page.getByRole('dialog').locator('[data-mending-icon="coins"] .next-point')).toHaveClass(/next-point-hidden/);
		await page.getByRole('button', { name: '成果を受け取る' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object), points: 10, pointProgressTicks: 30_000_000 });
		await expect(page.getByRole('dialog')).toContainText('10 pt');
		await expect(page.getByRole('dialog')).toContainText('上限まで あと5分');
		await expect(page.getByRole('dialog')).toContainText('+0 pt');
		await expect(page.locator('.lifespan-hud')).toContainText('作業中 +0.1h/h');
		await expect(page.locator('.lifespan-hud')).toContainText('ポイント 10pt');
		const collected = await readRelayGameState(page);
		expect(collected.mendingJob).toEqual(expect.objectContaining({ startedAtMs: expect.any(Number) }));
		expect(collected.points).toBe(10);
		expect(collected.lifespanExpiresAtMs).toBeGreaterThan(started.lifespanExpiresAtMs);
		expect(collected.lifespanExpiresAtMs).toBeLessThanOrEqual(started.lifespanExpiresAtMs + 6 * 60 * 1000);
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
	});

	test('opens the adjustment terminal only nearby and persists one ability upgrade', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 10);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		const adjustment = page.getByRole('button', { name: '能力強化端末' });
		await adjustment.click();
		await expect(page.getByRole('status')).toContainText('近づくと端末を使える');

		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await adjustment.click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		await expect(dialog).toContainText('10 pt');
		await expect(dialog).not.toContainText('POINT');
		await expect(dialog).not.toContainText('ポイントを使って、より効率よく活動できるようにします。');
		await expect(dialog.locator('.ability-card')).toHaveCount(3);
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Lv1');
		await expect(dialog).toContainText('1.00');
		await expect(dialog).toContainText('1.18');
		await expect(dialog).toContainText('ポイント生成速度');
		await expect(dialog).toContainText('必要ポイント');
		await expect(dialog.getByRole('button', { name: 'Lv2へ強化' }).first()).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Lv2へ強化' }).first()).toHaveCSS('color', 'rgb(255, 255, 255)');
		const beforeAbilityUpgrade = (await relayState(page)).state.published.filter((event) => event.kind === 30078 && event.pubkey === pubkey).length;
		await page.clock.runFor(1_001);
		const upgradedCard = dialog.locator('.ability-card').first();
		const stableBefore = await upgradedCard.evaluate((card) => {
			const type = card.querySelector('.ability-type')!.getBoundingClientRect();
			const cost = card.querySelector('.cost')!.getBoundingClientRect();
			const button = card.querySelector('button')!.getBoundingClientRect();
			return { typeY: type.y, costY: cost.y, buttonY: button.y };
		});
		await expect(dialog).not.toContainText('強化後');
		await expect(dialog).not.toContainText('normal clear');
		await expect(dialog).not.toContainText('Root Point');
		await dialog.getByRole('button', { name: 'Lv2へ強化' }).first().click();
		await expect(dialog).toContainText('9 pt');
		await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 30078 && event.pubkey === pubkey).length).toBeGreaterThan(beforeAbilityUpgrade);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(1);
		const stableDuring = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			costY: card.querySelector('.cost')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableDuring).toEqual(stableBefore);
		await expect(dialog.locator('.level-up-badge')).toHaveCount(0, { timeout: 1_500 });
		const stableAfter = await upgradedCard.evaluate((card) => ({
			typeY: card.querySelector('.ability-type')!.getBoundingClientRect().y,
			costY: card.querySelector('.cost')!.getBoundingClientRect().y,
			buttonY: card.querySelector('button')!.getBoundingClientRect().y
		}));
		expect(stableAfter).toEqual(stableBefore);
		await expect(page.locator('.lifespan-hud')).toContainText('ポイント 9pt');
		await expect(dialog).toContainText('推論効率 Lv2');
		await page.reload();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 9, abilities: { inferenceEfficiency: 2, contextCapacity: 1, hallucinationSuppression: 1 } });
	});

	test('opens the self profile from the ComposerDock without adjustment-terminal proximity', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 900 });
		await openReadyRelayWorld(page);

		const profileTrigger = page.getByRole('button', { name: '自分のプロフィールを開く' });
		await expect(profileTrigger).toBeVisible();
		await expect(page.locator('.composer-controls .profile-trigger')).toHaveCount(1);
		const avatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const dock = document.querySelector<HTMLElement>('.profile-trigger-character-avatar');
			if (!field || !dock) throw new Error('Expected field and ComposerDock self avatars.');
			const fieldStyle = getComputedStyle(field);
			const dockStyle = getComputedStyle(dock);
			return { fieldBackground: fieldStyle.backgroundColor, dockBackground: dockStyle.backgroundColor, fieldBorder: fieldStyle.borderTopColor, dockBorder: dockStyle.borderTopColor };
		});
		expect(avatarColors.dockBackground).toBe(avatarColors.fieldBackground);
		expect(avatarColors.dockBorder).toBe(avatarColors.fieldBorder);
		const dockBox = await profileTrigger.boundingBox();
		expect(dockBox).not.toBeNull();
		expect(dockBox!.width).toBeCloseTo(54, 0);
		const character = requireCharacterFromPubkey(getPublicKey(fixtureSecret(41)));
		const avatarImage = profileTrigger.locator('img');
		await expect(avatarImage).toHaveCount(1);
		await expect(avatarImage).toHaveAttribute('src', `/${character.picture}`);
		await expect.poll(() => avatarImage.evaluate((image) => {
			const loadedImage = image as HTMLImageElement;
			return { complete: loadedImage.complete, naturalWidth: loadedImage.naturalWidth };
		})).toEqual({ complete: true, naturalWidth: expect.any(Number) });
		await expect.poll(() => avatarImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
		await profileTrigger.click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await expect(dialog).toContainText('Run #1');
		await expect(dialog).toContainText('残り寿命');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog).toContainText('推論効率');
		await expect(dialog).toContainText('コンテキスト容量');
		await expect(dialog).toContainText('ハルシネーション抑制');
		await expect(dialog).toContainText('Root Point');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		const escapeContent = page.locator('.escape-info-popover');
		await expect(escapeTrigger).toBeVisible();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'closed');
		await expect(escapeContent).toBeHidden();
		await escapeTrigger.click();
		await expect(escapeTrigger).toHaveAttribute('data-state', 'open');
		await expect(escapeContent).toBeVisible();
		await expect(escapeContent).toContainText('現在のRunを終了');
		await expect(escapeContent).toContainText('Root Point +1');
		await expect(escapeContent).toContainText('次の人格を選択');
		await expect(escapeContent).toContainText('秘密鍵を取得可能');
		await page.keyboard.press('Escape');
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeVisible();
		await escapeTrigger.click();
		await expect(escapeContent).toBeHidden();
		await expect(dialog).toContainText(character.about);
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(96);
		await expect(dialog).toContainText('100,000 ptで現在のRunを終了します。');
		await expect(dialog).toContainText('所持ポイント');
		await expect(dialog).toContainText('未回収の作業ポイントは含まれません。');
		await expect(dialog).not.toContainText('100,000 ptで現在のRunを終了します。未回収の作業ポイントは含まれません。');
		await expect(dialog).toContainText('100,000 pt');
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeDisabled();
		await expect(dialog.getByText('clear不可: 所持ポイントが100,000pt未満です')).toHaveCount(0);
		await expect(dialog.getByRole('button', { name: /へ強化/ })).toHaveCount(0);

		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(dialog).toBeHidden();
		await expect(profileTrigger).toBeFocused();

		const fieldTrigger = page.locator('.participant[data-self="true"] .participant-profile-trigger');
		await fieldTrigger.click();
		await expect(dialog).toBeVisible();
		await expect(dialog).toContainText('Run #1');
		await expect(dialog).toContainText('脱出');
		await expect(dialog).not.toContainText('Normal Clear');
		const headerAvatarColors = await page.evaluate(() => {
			const field = document.querySelector<HTMLElement>('.participant[data-self="true"] .avatar');
			const header = document.querySelector<HTMLElement>('.self-profile-avatar');
			if (!field || !header) throw new Error('Expected field and self profile avatars.');
			return { field: getComputedStyle(field).backgroundColor, header: getComputedStyle(header).backgroundColor };
		});
		expect(headerAvatarColors.header).toBe(headerAvatarColors.field);
		await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
		await expect(fieldTrigger).toBeFocused();
	});

	test('keeps the self profile dialog inside a short mobile viewport and scrolls its content', async ({ page }) => {
		await page.setViewportSize({ width: 420, height: 420 });
		const viewportSize = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
		await openReadyRelayWorld(page);
		await page.getByRole('button', { name: '自分のプロフィールを開く' }).click();

		const dialog = page.getByRole('dialog');
		await expect(dialog).toBeVisible();
		const scrollViewport = dialog.locator('.self-profile-viewport');
		await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBe(0);
		await expect(dialog.locator('.escape-info-trigger')).not.toBeFocused();
		await expect(dialog.locator('[data-initial-focus]')).toBeFocused();
		const dialogBox = await dialog.boundingBox();
		const viewportBox = await scrollViewport.boundingBox();
		const metrics = await scrollViewport.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		await expect(dialog.locator('.self-profile-sections > section')).toHaveCount(3);
		const headerAvatarBox = await dialog.locator('.self-profile-avatar').boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(viewportBox).not.toBeNull();
		expect(headerAvatarBox).not.toBeNull();
		expect(headerAvatarBox!.width).toBeGreaterThan(72);
		expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
		expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(420);
		expect(viewportBox!.y).toBeGreaterThanOrEqual(dialogBox!.y);
		expect(viewportBox!.y + viewportBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
		const escapeTrigger = dialog.locator('.escape-info-trigger');
		await escapeTrigger.click();
		const escapePopover = page.locator('.escape-info-popover');
		await expect(escapePopover).toBeVisible();
		const popoverBox = await escapePopover.boundingBox();
		const expandedMetrics = await dialog.locator('.self-profile-viewport').evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
		expect(popoverBox).not.toBeNull();
		expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewportSize.width);
		expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
		expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewportSize.height);
		expect(expandedMetrics).toEqual(metrics);
		await dialog.getByRole('button', { name: '脱出', exact: true }).scrollIntoViewIfNeeded();
		await expect(dialog.getByRole('button', { name: '脱出', exact: true })).toBeVisible();
	});

	test('places the ComposerDock controls below the editor on mobile', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await openReadyRelayWorld(page);

		const editor = page.locator('.composer-editor-slot');
		const controls = page.locator('.composer-controls');
		const profileTrigger = page.locator('.profile-trigger');
		const speechToggle = page.locator('.speech-type-toggle');
		const editorBox = await editor.boundingBox();
		const controlsBox = await controls.boundingBox();
		const profileBox = await profileTrigger.boundingBox();
		const speechBox = await speechToggle.boundingBox();
		expect(editorBox).not.toBeNull();
		expect(controlsBox).not.toBeNull();
		expect(profileBox).not.toBeNull();
		expect(speechBox).not.toBeNull();
		expect(editorBox!.y + editorBox!.height).toBeLessThanOrEqual(controlsBox!.y + 1);
		expect(profileBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(speechBox!.y).toBeGreaterThanOrEqual(controlsBox!.y);
		expect(Math.abs(profileBox!.y - speechBox!.y)).toBeLessThan(2);
	});

	test('shows maxed abilities as unavailable at the adjustment terminal', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const nearby = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 13, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), nearby);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '13,3');
		await page.getByRole('button', { name: '能力強化端末' }).click();
		const dialog = page.getByRole('dialog', { name: '能力強化' });
		await expect(dialog.getByRole('button', { name: '最大Lv' })).toHaveCount(3);
		for (const button of await dialog.getByRole('button', { name: '最大Lv' }).all()) await expect(button).toBeDisabled();
	});

	test('keeps an offline mending job alive across browser reopen after its stored expiry', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, startTime + 2 * 60 * 1000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);

		await page.clock.setSystemTime(startTime + 2 * 60 * 1000 + 10 * 1000);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await expect(page.locator('.lifespan-hud')).toBeVisible();
		const reopened = await readRelayGameState(page);
		expect(reopened).toMatchObject({ personaPubkey: pubkey, lifespanExpiresAtMs: started.lifespanExpiresAtMs, mendingJob: expect.any(Object) });
	});

	test('closes a stale completed mending dialog before its reward can be collected', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		const terminal = page.getByRole('button', { name: '作業端末' });
		await terminal.click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		const started = await readRelayGameState(page);
		const job = started.mendingJob as { startedAtMs: number };
		await page.getByRole('button', { name: '閉じる', exact: true }).click();
		await page.clock.setSystemTime(job.startedAtMs + 5 * 60 * 1000);
		const currentTerminalPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), currentTerminalPosition);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await terminal.click();
		await expect(page.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
		await page.clock.runFor(1_001);
		const moved = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 0, y: 0 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), moved);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const stale = await readRelayGameState(page);
		expect(stale).toMatchObject({ points: 0, mendingJob: expect.any(Object) });
	});

	test('converges two tabs on one mending start and collection', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		const other = await page.context().newPage();
		const clients = [page, other] as const;
		try {
			await Promise.all(clients.map((client) => client.clock.install({ time: startTime })));
			await Promise.all(clients.map(async (client) => {
				await installHostOwnedStub(client);
				await installDelayedRelay(client, { primaryEvents: testEvents(startTime) });
			}));
			await seedRelayAccount(page, secret, pubkey);
			await Promise.all(clients.map(async (client) => {
				await client.goto('/');
				await expect(client.locator('.composer-dock')).toBeVisible();
				await client.evaluate(() => {
					const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
					relay.releaseMetadata(); relay.releasePrimary();
				});
				await expect(client.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
			}));
			const injectTerminalPosition = async (client: Page) => {
				const event = finalizeEvent(buildWorldStateEventTemplate({
					channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
					createdAt: Math.floor(await client.evaluate(() => Date.now()) / 1000)
				}), secret);
				await client.evaluate((position) => (window as typeof window & {
					__relayStartupTest: { injectPosition(event: object): void }
				}).__relayStartupTest.injectPosition(position), event);
				await expect(client.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
			};
			await Promise.all(clients.map(injectTerminalPosition));
			await Promise.all(clients.map(async (client) => {
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('dialog')).toBeVisible();
			}));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
			const started = await readRelayGameState(page);
			expect(started.mendingJob).toEqual(expect.any(Object));

			const completedAt = (started.mendingJob as { startedAtMs: number }).startedAtMs + 5 * 60 * 1000;
			await Promise.all(clients.map((client) => client.clock.setSystemTime(completedAt)));
			await Promise.all(clients.map(injectTerminalPosition));
			for (const client of clients) {
				const close = client.getByRole('button', { name: '閉じる', exact: true });
				if (await close.isVisible()) await close.click();
				await client.getByRole('button', { name: '作業端末' }).click();
				await expect(client.getByRole('button', { name: '成果を受け取る' })).toBeVisible();
			}
			await Promise.all(clients.map((client) => client.getByRole('button', { name: '成果を受け取る' }).click()));
			await expect.poll(() => readRelayGameState(page)).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
			const collected = await readRelayGameState(page);
			expect(collected).toMatchObject({ points: 5, mendingJob: expect.any(Object) });
		} finally {
			await other.close();
		}
	});

	test('reloads an old terminal mutation after another tab selects the next identity', async ({ page }) => {
		const secret = fixtureSecret(63);
		const oldPubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { persistAcrossReload: true });
		await seedRelayAccount(page, secret, oldPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.evaluate(() => {
			let release: (() => void) | null = null;
			let started = false;
			(window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean; release: () => void; beforeMendingMutation: (operation: 'start' | 'collect') => Promise<void> } }).__personaBubbleFieldTestHooks = {
				started: () => started,
				release: () => { release?.(); release = null; },
				beforeMendingMutation: async (operation) => {
					if (operation !== 'start') return;
					started = true;
					await new Promise<void>((resolve) => { release = resolve; });
				}
			};
		});
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { started: () => boolean } }).__personaBubbleFieldTestHooks.started())).toBe(true);
		const oldPublishedCount = (await relayState(page)).state.published.length;

		const reincarnator = await page.context().newPage();
		try {
			await installHostOwnedStub(reincarnator);
			await installDelayedRelay(reincarnator);
			await reincarnator.goto('/');
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect(reincarnator.locator(`.participant[data-self="true"][data-participant-id="${oldPubkey}"]`)).toBeVisible();
			await overwriteRelayGameState(reincarnator, { version: 4, personaPubkey: oldPubkey, lifespanExpiresAtMs: Date.now() - 1, points: 0,
				abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, mendingJob: null });
			await reincarnator.reload({ waitUntil: 'domcontentloaded' });
			await expect(reincarnator.getByRole('dialog')).toBeVisible();
			await expect(reincarnator.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
			await reincarnator.getByRole('button', { name: /を選ぶ$/ }).first().click();
			await startSelectedRun(reincarnator);
			await expect(reincarnator.getByRole('dialog')).toHaveCount(0);
			await reincarnator.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect.poll(async () => (await readRelayGameState(reincarnator)).personaPubkey).not.toBe(oldPubkey);

			const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
			await page.evaluate(() => (window as typeof window & { __personaBubbleFieldTestHooks: { release: () => void } }).__personaBubbleFieldTestHooks.release());
			await reloaded;
			await page.waitForLoadState('load');
			await expect(page.locator('.composer-dock')).toBeVisible();
			await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
			await page.evaluate(() => {
				const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			const newPubkey = (await readRelayGameState(page)).personaPubkey;
			expect(newPubkey).not.toBe(oldPubkey);
			await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			await editor.fill('new persona after superseded mending');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.pubkey === newPubkey)).toBe(true);
			const observed = await page.evaluate(() => {
				const state = (window as typeof window & { __relayStartupTest: { state: { previousPublished: Array<{ kind: number; pubkey: string }>; published: Array<{ kind: number; pubkey: string }>; previousClosedSubscriptions: unknown[] } } }).__relayStartupTest.state;
				return { published: [...state.previousPublished, ...state.published], closed: state.previousClosedSubscriptions };
			});
			expect(observed.closed.length).toBeGreaterThan(0);
			const postSupersession = observed.published.slice(oldPublishedCount);
			expect(postSupersession.filter((event) => [30078, 42, 1111].includes(event.kind))).not.toContainEqual(expect.objectContaining({ pubkey: oldPubkey }));
			expect(postSupersession).toContainEqual(expect.objectContaining({ kind: 30078, pubkey: newPubkey }));
			expect(postSupersession).toContainEqual(expect.objectContaining({ kind: 42, pubkey: newPubkey }));
		} finally {
			await reincarnator.close();
		}
	});

	test('shows overflow lifespan extension status after the Context cap', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, Date.now() + 7 * 24 * 60 * 60 * 1000, 0, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, 1);
		await overwriteRelayMendingBuild(page, { inferenceAcceleration: 0, contextCompression: 1, hallucinationResistance: 0 }, { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 });
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		const atTerminal = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 11, y: 3 }, slot: 1,
			createdAt: Math.floor(await page.evaluate(() => Date.now()) / 1000)
		}), secret);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect.poll(() => readRelayGameState(page)).toMatchObject({ mendingJob: expect.any(Object) });
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event), atTerminal);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '11,3');
		await page.clock.setSystemTime(startTime + 8 * 60 * 1000);
		await pauseAtCurrentBrowserTime(page);
		await page.getByRole('button', { name: '作業端末' }).click();
		const dialog = page.getByRole('dialog');
		await expect(dialog.getByRole('heading', { name: '延命中' })).toBeVisible();
		await expect(dialog).toContainText('ポイント蓄積は上限');
		await expect(dialog).toContainText('寿命延長のみ継続中');
	});

	test('fails closed to a public read-only world when a mending mutation finds corrupt storage', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(19);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await moveRelaySelfTo(page, { x: 11, y: 3 });
		await overwriteRelayGameState(page, { version: 99 });
		const before = (await publishedMessages(page)).length;
		await page.getByRole('button', { name: '作業端末' }).click();
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('must remain read-only after corrupt mending');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
	});

	test('moves an expired persona to the next identity selection', async ({ page }) => {
		const secret = fixtureSecret(51);
		const pubkey = getPublicKey(secret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();

		await overwriteRelayGameState(page, {
			version: 4,
			personaPubkey: pubkey,
			lifespanExpiresAtMs: Date.now() - 1,
			points: 321,
			abilities: { inferenceEfficiency: 100, contextCapacity: 100, hallucinationSuppression: 100 },
			mendingJob: null
		});
		await page.reload({ waitUntil: 'domcontentloaded' });

		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		const previousCharacterId = requireCharacterFromPubkey(pubkey).characterId;
		const pendingCharacterIds = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
				return await new Promise<string[]>((resolve, reject) => {
					request.onsuccess = () => resolve((request.result as { mode: { pendingSelection: { candidates: Array<{ characterId: string }> } } }).mode.pendingSelection.candidates.map((candidate) => candidate.characterId));
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		expect(pendingCharacterIds).not.toContain(previousCharacterId);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const reset = await page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<{ pubkey: string; game: { personaPubkey: string; points: number; abilities: Record<string, number> } }>((resolve, reject) => {
					const tx = database.transaction('persona-bubble-field-player-state');
					const playerRequest = tx.objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					tx.oncomplete = () => {
						const lifecycle = playerRequest.result as { mode: { activeRun: { identity: { pubkey: string }; gameState: { personaPubkey: string; points: number; pointProgressTicks: number; abilities: Record<string, number> } } } };
						resolve({ pubkey: lifecycle.mode.activeRun.identity.pubkey, game: lifecycle.mode.activeRun.gameState });
					};
					tx.onerror = () => reject(tx.error);
				});
			} finally { database.close(); }
		});
		expect(reset.pubkey).not.toBe(pubkey);
		expect(reset.game).toMatchObject({ personaPubkey: reset.pubkey, points: 0, pointProgressTicks: 0,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${reset.pubkey}"]`)).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const before = (await publishedMessages(page)).length;
		await editor.fill('after identity transition');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, before + 1);
		const event = await page.evaluate((message) => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === message);
		}, 'after identity transition');
		expect(event?.pubkey).toBe(reset.pubkey);
	});

	for (const stateKind of ['missing', 'corrupt'] as const) {
		test(`keeps public world read available for ${stateKind} persona storage`, async ({ page }) => {
			const events = testEvents(Date.now() + 30_000);
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: events });
			await seedUnavailablePersona(page, stateKind);
			await page.goto('/');
			await expect(page.locator('.composer-dock')).toBeVisible();
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
			await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === 42)).toBe(true);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
			await expect(page.locator(`.participant[data-participant-id="${events.message.pubkey}"]`)).toBeVisible();
			await expect(page.locator(`.bubble[data-bubble-id="${events.message.id}"]`)).toBeVisible();
			await expect(page.locator('.lifespan-hud')).toHaveCount(0);
			await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);

			const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
			const before = (await publishedMessages(page)).length;
			await editor.fill('must remain read-only');
			await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
			await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
			await expect(editor).toHaveValue('must remain read-only');

			const persistedKeys = await page.evaluate(async () => {
				const database = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-account');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string[]>((resolve, reject) => {
						resolve(Array.from(database.objectStoreNames));
					});
				} finally { database.close(); }
			});
			expect(persistedKeys).toEqual(['persona-bubble-field-player-state', 'persona-bubble-field-root-secret']);
		});
	}

	test('shows and refreshes the current persona lifespan HUD', async ({ page }) => {
		const startTime = Date.now();
		const hour = 60 * 60 * 1000;
		const day = 24 * hour;
		const minute = 60 * 1000;
		const expiresAtMs = startTime + 2 * day + 18 * hour + minute;
		const secret = fixtureSecret(61);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime) });
		await seedRelayAccount(page, secret, pubkey, expiresAtMs);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		const hud = page.locator('.lifespan-hud');
		await expect(hud).toContainText('寿命 2日 18時間');

		await pauseAtCurrentBrowserTime(page);
		await page.clock.setSystemTime(expiresAtMs - 23 * hour - 59 * minute);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud).toContainText('寿命 23時間 59分');

		await page.clock.setSystemTime(expiresAtMs - 59 * minute - 59 * 1000);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await expect(hud).toContainText('寿命 59分');
	});

	test('keeps public read-only updates after runtime death transition fails', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(59);
		const pubkey = getPublicKey(secret);
		const events = testEvents();
		await page.clock.install({ time: startTime });
		await installDeathTransitionFailure(page);
		await installPromptApiStub(page);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: events });
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => {
			const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
			relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		const initialRequestCount = (await relayState(page)).state.requests.length;
		await armDeathTransitionFailure(page);
		await page.clock.runFor(31_000);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__personaLifecycleFailureTest: { injected(): number }
		}).__personaLifecycleFailureTest.injected())).toBe(1);
		await expect(page.locator('.participant[data-self="true"]')).toHaveCount(0);
		expect((await relayState(page)).state.published.some((event) => event.kind === 30078 && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))).toBe(false);
		await expect.poll(async () => (await relayState(page)).state.requests.length).toBeGreaterThan(initialRequestCount);

		const live = testEvents(startTime + 31_000);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), live.message);
		await expect(page.locator(`.bubble[data-bubble-id="${live.message.id}"]`)).toBeVisible();

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		const beforeComposer = (await publishedMessages(page)).length;
		await editor.fill('blocked after runtime death');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeComposer);
		await expect(editor).toHaveValue('blocked after runtime death');

		await editor.fill('');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeEnabled();
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		const beforeCandidate = (await publishedMessages(page)).length;
		await primary.click();
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(beforeCandidate);
		await expect(page.locator('.suggestion-panel')).toBeVisible();
	});

	test('moves an active Relay session to identity selection when its deadline is crossed', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(55);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await seedRelayAccount(page, secret, pubkey);
		await overwriteRelayGameState(page, { version: 4, personaPubkey: pubkey, lifespanExpiresAtMs: startTime + 30_000, points: 0, pointProgressTicks: 0, mendingJob: null,
			abilities: { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 } });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);

		await page.clock.runFor(31_000);
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await page.getByRole('button', { name: /を選ぶ$/ }).first().click();
		await startSelectedRun(page);
		await expect(page.getByRole('dialog')).toHaveCount(0);
		const persistedPubkey = async () => page.evaluate(async () => {
			const database = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open('persona-bubble-field-account');
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			try {
				return await new Promise<string>((resolve, reject) => {
					const request = database.transaction('persona-bubble-field-player-state').objectStore('persona-bubble-field-player-state').get('player-lifecycle');
					request.onsuccess = () => resolve((request.result as { mode: { kind: 'running'; activeRun: { identity: { pubkey: string } } } }).mode.activeRun.identity.pubkey);
					request.onerror = () => reject(request.error);
				});
			} finally { database.close(); }
		});
		await expect.poll(persistedPubkey).not.toBe(pubkey);
		const newPubkey = await persistedPubkey();
		expect(newPubkey).not.toBe(pubkey);

		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __relayStartupTest?: unknown }).__relayStartupTest))).toBe(true);
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${newPubkey}"]`)).toBeVisible();
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toHaveCount(0);

		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('runtime identity transition message');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await waitForPublishedMessageCount(page, 1);
		const event = await page.evaluate(() => {
			const published = (window as typeof window & { __relayStartupTest: { state: { published: Array<{ kind: number; content: string; pubkey?: string }> } } }).__relayStartupTest.state.published;
			return published.find((candidate) => candidate.kind === 42 && candidate.content === 'runtime identity transition message');
		});
		expect(event?.pubkey).toBe(newPubkey);
	});

	test('publishes a terminal World State exit after live runtime death commits locally', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(57);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);

		await page.clock.runFor(31_000);
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect.poll(async () => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			return [...new Map([...state.previousPublished, ...state.published]
				.filter((event) => event.kind === 30078 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')))
				.map((event) => [event.id, event])).values()];
		}, pubkey)).toHaveLength(1);
		const exit = await page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }>; published: Array<{ id: string; kind: number; pubkey?: string; content: string; tags: string[][]; created_at?: number }> } } }).__relayStartupTest.state;
			const published = [...state.previousPublished, ...state.published];
			return published.find((event) => event.kind === 30078 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey);
		expect(exit?.content).toMatch(/^\d+:\d+$/);
		expect(exit?.tags.find((tag) => tag[0] === 'e')?.[1]).toBe(CHANNEL_ID);
	});

	test('keeps local death committed when the terminal exit is rejected by Relay', async ({ page }) => {
		const startTime = Date.now();
		const secret = fixtureSecret(63);
		const pubkey = getPublicKey(secret);
		await page.clock.install({ time: startTime });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
		await seedRelayAccount(page, secret, pubkey, startTime + 30_000);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.clock.runFor(31_000);
		await expect(page.getByRole('dialog')).toBeVisible();
		await expect(page.getByRole('button', { name: /を選ぶ$/ })).toHaveCount(3);
		await expect.poll(() => page.evaluate((expectedPubkey) => {
			const state = (window as unknown as { __relayStartupTest: { state: { previousPublished: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }>; published: Array<{ id: string; kind: number; pubkey?: string; tags: string[][] }> } } }).__relayStartupTest.state;
			return [...state.previousPublished, ...state.published].some((event) => event.kind === 30078 && event.pubkey === expectedPubkey && event.tags.some((tag) => tag[0] === 'd' && tag[1]?.endsWith(':exit')));
		}, pubkey)).toBe(true);
	});

	for (const width of [700, 701]) {
		test(`keeps Chatter initialization and overlay geometry at width ${width}`, async ({ page }) => {
			await page.setViewportSize({ width, height: 900 });
			await openReadyRelayWorld(page);
			const chatter = page.locator('aside.recent-message-timeline');
			await expect(chatter).toBeVisible({ visible: width > 700 });
			const geometry = () => page.evaluate(() => ({
				rects: ['.field-viewport', '.field-area', '.field-scene', '.speech-area', '.composer-dock', '.participant']
					.map((selector) => [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect().toJSON())),
				camera: getComputedStyle(document.querySelector('.field-scene')!).transform
			}));
			const before = await geometry();
			for (const open of [width <= 700, width > 700]) {
				await page.getByRole('button', { name: open ? 'Show Chatter' : 'Hide Chatter' }).click();
				await expect(chatter).toBeVisible({ visible: open });
				expect(await geometry()).toEqual(before);
			}
			// Keep a manual choice opposite to the next viewport's reload default.
			await page.setViewportSize({ width: width === 700 ? 701 : 700, height: 900 });
			await expect(page.locator('.field-area')).toHaveCSS('width', width === 700 ? '685px' : '684px');
			await expect(chatter).toBeVisible({ visible: width > 700 });
			await page.reload();
			await expect(page.locator('.field-viewport')).toHaveClass(/initial-field-geometry-ready/);
			await expect(chatter).toBeVisible({ visible: width === 700 });
		});
	}

	test('centers the first visible field frame before Relay bootstrap and preserves it through presence', async ({ page }) => {
		await page.setViewportSize({ width: 2560, height: 1440 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await installFieldFrameSampling(page);
		const secret = fixtureSecret(41);
		await seedRelayAccount(page, secret, getPublicKey(secret));
		await page.goto('/');
		await expect.poll(async () => (await readFieldFrames(page)).filter((frame) => frame.source === 'frame' && frame.visible).length).toBeGreaterThan(0);
		const first = (await readFieldFrames(page)).find((frame) => frame.source === 'frame' && frame.visible)!;
		expect(first.scene.width).toBe(1216);
		expect(first.scene.height).toBe(608);
		expect(Math.abs(
		(first.scene.x + first.scene.width / 2) - (first.area.x + first.area.width / 2)
	)).toBeLessThan(0.5);
		expect(Math.abs(
		(first.scene.y + first.scene.height / 2) - (first.area.y + first.area.height / 2)
	)).toBeLessThan(0.5);
		expect(first.viewport).toEqual({ x: 0, y: 0, width: 2560, height: 1373 });
		expect(first.composer?.height).toBe(67);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42)).toBe(true);
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toBeVisible();
		const visible = (await sampleRenderedField(page)).filter((frame) => frame.source === 'frame' && frame.visible);
		for (const frame of visible) {
			expect(frame.scene.width).toBe(1216);
			expect(frame.scene.height).toBe(608);
			expect(frame.scene.x).toBeGreaterThanOrEqual(frame.area.x - frame.scene.width);
			expect(frame.scene.x).toBeLessThanOrEqual(frame.area.x + frame.area.width);
			expect(frame.scene.y).toBeGreaterThanOrEqual(frame.area.y - frame.scene.height);
			expect(frame.scene.y).toBeLessThanOrEqual(frame.area.y + frame.area.height);
		}
	});

	test('shows published Trace replies to a fresh client through Relay history and live delivery', async ({ page: sender, browser }) => {
		const time = Date.now();
		const trace = traceRuntimeEvents();
		const readerContext = await browser.newContext({ viewport: { width: 1100, height: 850 } });
		try {
			const reader = await readerContext.newPage();
			const readerSecret = fixtureSecret(43);
			const readerPubkey = getPublicKey(readerSecret);
			expect(readerPubkey).not.toBe(trace.selfPubkey);
			const readerPosition = finalizeEvent(buildWorldStateEventTemplate({
				channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' }, position: { x: 3, y: 2 }, slot: 0, createdAt: trace.selfPosition.created_at
			}), readerSecret);
			const openClient = async (client: Page, secret: Uint8Array, pubkey: string, position: NostrEvent, history: NostrEvent[]) => {
				await client.clock.setFixedTime(time);
				await client.emulateMedia({ reducedMotion: 'reduce' });
				await client.setViewportSize({ width: 1100, height: 850 });
				await installHostOwnedStub(client);
				await installDelayedRelay(client, { primaryEvents: { message: trace.message, position }, traceRoots: [trace.root], traceReplies: history });
				await seedRelayAccount(client, secret, pubkey);
				await client.goto('/');
				await expect(client.locator('.composer-dock')).toBeVisible();
				await client.evaluate(() => {
					const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
					relay.releaseMetadata(); relay.releasePrimary();
				});
				await expect(client.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
				await client.getByRole('button', { name: 'Hide Chatter' }).click();
				await expect(client.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
			};
			const publish = async (content: string) => {
				const openRoot = sender.locator(`[data-trace-root-id="${trace.root.id}"]`);
				if (await openRoot.isVisible()) {
					// After the first publish, the open root keeps its conversation visible while
					// its light and logical-cell trigger remain hidden. Re-select the root through
					// its visible native button to establish the next reply target.
					await openRoot.click();
				} else {
					await selectRelayTraceCell(sender, '4,2');
				}
				await expect(sender.getByLabel('Reply preview', { exact: true })).toHaveAttribute('data-reply-id', trace.root.id);
				const editor = sender.getByRole('textbox', { name: '投稿エディター' });
				await editor.fill(content);
				await editor.press('Enter');
				await expect(editor).toHaveValue('');
				// Only the signed EVENT received on the publish wire crosses clients.
				const raw = (await relayState(sender)).state.published.find((event) => event.kind === 1111 && event.content === content) as NostrEvent;
				expect(verifyEvent(raw)).toBe(true);
				return raw;
			};
			await openClient(sender, trace.selfSecret, trace.selfPubkey, trace.selfPosition, []);
			const history = await publish('cross-client history reply');
			await openClient(reader, readerSecret, readerPubkey, readerPosition, [history]);
			const cachedIds = () => reader.evaluate(async () => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open('persona-bubble-field-trace');
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				try {
					return await new Promise<string[]>((resolve, reject) => {
						const request = db.transaction('trace-replies').objectStore('trace-replies').getAll();
						request.onsuccess = () => resolve(request.result.map((record) => record.eventId));
						request.onerror = () => reject(request.error);
					});
				} finally { db.close(); }
			});
			expect(await cachedIds()).toEqual([]);
			await selectRelayTraceCell(reader, '4,2');
			await expect(reader.locator(`[data-trace-reply-id="${history.id}"]`)).toContainText(history.content);
			await expect.poll(async () => (await relayState(reader)).state.requests.some((request) =>
				request.filters.length === 3 && request.filters.filter((filter) => (filter.kinds as number[])?.includes(1111) && filter.limit === 100).length === 2
			)).toBe(true);
			const wire = (await relayState(reader)).state.requests.find((request) => request.filters.length === 3 && request.filters.filter((filter) => filter.limit === 100).length === 2)!;
			expect(wire.filters.find((filter) => Array.isArray(filter['#E']))?.['#E']).toEqual([trace.root.id]);
			expect(wire.filters.find((filter) => Array.isArray(filter['#e']))?.['#e']).toEqual([trace.root.id]);
			expect(wire.filters.find((filter) => Array.isArray(filter['#p']))).toMatchObject({ '#p': [readerPubkey] });
			expect(wire.filters.find((filter) => Array.isArray(filter['#p']))).not.toHaveProperty('#E');
			await sender.clock.setFixedTime(time + 1000);
			await sender.getByRole('textbox', { name: '投稿エディター' }).press('Escape');
			await sender.keyboard.press('ArrowUp');
			await expect(sender.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,1');
			const live = await publish('cross-client live reply');
			expect(live.id).not.toBe(history.id);
			const wrongRoot = finalizeEvent({
				kind: live.kind, created_at: live.created_at, content: 'wrong-root candidate',
				tags: live.tags.map((tag) => tag[0] === 'E' ? ['E', 'f'.repeat(64), '', trace.root.pubkey] : tag)
			}, trace.selfSecret);
			expect(parseTraceReplyCandidate(wrongRoot)).not.toBeNull();
			await reader.evaluate((event) => (window as unknown as { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), wrongRoot);
			await reader.evaluate((event) => (window as unknown as { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), live);
			await expect(reader.locator(`[data-trace-reply-id="${live.id}"]`)).toContainText(live.content);
			const received = await reader.evaluate(() => (window as unknown as { __relayStartupTest: { state: { traceDeliveries: string[] } } }).__relayStartupTest.state.traceDeliveries);
			expect(received).toEqual(expect.arrayContaining([history.id, wrongRoot.id, live.id]));
			await expect.poll(cachedIds).toEqual(expect.arrayContaining([history.id, live.id]));
			expect(await cachedIds()).not.toContain(wrongRoot.id);
			await expect(reader.locator(`[data-trace-reply-id="${wrongRoot.id}"]`)).toHaveCount(0);
			await expect(reader.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', trace.root.id);
		} finally { await readerContext.close(); }
	});

	test('persists Trace root and reply read state and keeps notification generic', async ({ page }) => {
		const now = Date.now();
		const selfSecret = fixtureSecret(23);
		const selfPubkey = getPublicKey(selfSecret);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const primary = {
			message: finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state participant', speechType: 'normal', position: { x: 3, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret),
			position: finalizeEvent(buildWorldStateEventTemplate({ channel, position: { x: 3, y: 2 }, slot: 0, createdAt: Math.floor(now / 1000) }), selfSecret)
		};
		let root = finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state root 0', speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		for (let attempt = 1; BigInt(`0x${root.id}`) % 5n !== 0n; attempt += 1) {
			root = finalizeEvent(buildWorldMessageTemplate({ channel, content: `read-state root ${attempt}`, speechType: 'normal', position: { x: 4, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		}
		const parsedRoot = parseWorldMessage(root, CHANNEL_ID);
		if (!parsedRoot) throw new Error('Read-state root fixture did not parse.');
		let unreadRoot = finalizeEvent(buildWorldMessageTemplate({ channel, content: 'read-state unread root', speechType: 'normal', position: { x: 5, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		for (let attempt = 1; BigInt(`0x${unreadRoot.id}`) % 5n !== 0n; attempt += 1) {
			unreadRoot = finalizeEvent(buildWorldMessageTemplate({ channel, content: `read-state unread root ${attempt}`, speechType: 'normal', position: { x: 5, y: 2 }, createdAt: Math.floor(now / 1000) }), selfSecret);
		}
		const reply = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply detail', speechType: 'normal', createdAt: Math.floor(now / 1000) + 1 }), fixtureSecret(31));
		const replyAfterRootRead = finalizeEvent(buildTraceReplyTemplate({ root: parsedRoot, parent: parsedRoot, content: 'private reply after root read', speechType: 'normal', createdAt: Math.floor(now / 1000) + 2 }), fixtureSecret(32));
		await page.clock.setFixedTime(now);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: primary, traceRoots: [root, unreadRoot], traceReplies: [reply] });
		await seedRelayAccount(page, selfSecret, selfPubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		const unreadMarker = page.locator('[data-trace-marker-position="5,2"]');
		await expect(unreadMarker).toBeVisible();
		await expect(unreadMarker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(unreadMarker).toHaveCSS('opacity', '1');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('color', 'rgb(207, 6, 254)');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await page.locator('.trace-unread-indicator').click();
		await expect(page.locator('.trace-unread-explanation')).toContainText('どこかにあなたへの返信の痕跡があります');
		await expect(page.locator('[data-trace-root-id]')).toHaveCount(0);
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toContainText(root.content);
		await expect(page.locator(`[data-trace-root-id="${root.id}"]`)).toHaveAttribute('data-trace-current-kind', 'root');
		await expect(page.locator(`[data-trace-ghost-root-id="${root.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${reply.id}"]`)).toContainText(reply.content);
		await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveAttribute('data-trace-root-read', 'true');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('color', 'rgb(89, 105, 127)');
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveCSS('opacity', '0.34');
		await page.reload();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toHaveAttribute('data-trace-root-read', 'true');
		await expect(page.locator('.trace-unread-indicator')).toHaveCount(0);
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectTraceReply(event: object): void } }).__relayStartupTest.injectTraceReply(event), replyAfterRootRead);
		const marker = page.locator('[data-trace-marker-position="4,2"]');
		await expect(marker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(marker).toHaveAttribute('data-trace-root-unread-reply', 'true');
		await expect(marker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(marker).toHaveCSS('color', 'rgb(207, 6, 254)');
		await expect(marker).toHaveCSS('opacity', '1');
		await expect(page.locator('.trace-unread-indicator')).toBeVisible();
		await selectRelayTraceCell(page, '4,2');
		await expect(page.locator(`[data-trace-reply-id="${replyAfterRootRead.id}"]`)).toContainText(replyAfterRootRead.content);
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		await clickRelayLogicalCell(page, { x: 0, y: 0 });
		await expect(marker).toHaveAttribute('data-trace-root-read', 'true');
		await expect(marker).not.toHaveAttribute('data-trace-root-unread-reply');
		await expect(marker).toHaveCSS('mask-image', /trace-icon\.svg/);
		await expect(marker).toHaveCSS('color', 'rgb(89, 105, 127)');
		await expect(marker).toHaveCSS('opacity', '0.34');
	});

	test('suppresses Trace presentation and investigation on fixed facility cells', async ({ page }) => {
		const mendingTrace = traceRuntimeEvents(MENDING_TERMINAL.position);
		const adjustmentTrace = traceRuntimeEvents(ADJUSTMENT_TERMINAL.position);
		const ordinaryTrace = traceRuntimeEvents();
		await page.clock.setFixedTime(Date.now());
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			primaryEvents: { message: ordinaryTrace.message, position: ordinaryTrace.selfPosition },
			traceRoots: [mendingTrace.root, adjustmentTrace.root, ordinaryTrace.root]
		});
		await seedRelayAccount(page, ordinaryTrace.selfSecret, ordinaryTrace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});

		await expect(page.locator('[data-trace-marker-position="12,3"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="14,3"]')).toHaveCount(0);
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();
		await expect(page.locator('[data-cell-position="12,3"][aria-label*="痕跡"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="14,3"][aria-label*="痕跡"]')).toHaveCount(0);
		await expect(page.locator('[data-cell-position="4,2"][aria-label*="痕跡"]')).toHaveCount(1);
		await expect(page.locator('[data-cell-position="12,3"][aria-label="作業端末"]')).toHaveCount(1);
		await expect(page.locator('[data-cell-position="14,3"][aria-label="能力強化端末"]')).toHaveCount(1);

		await page.locator('[data-cell-position="12,3"][aria-label="作業端末"]').click();
		await expect(page.locator('.trace-proximity-feedback')).toContainText('近づくと端末を使える');
		await expect(page.locator('[data-field-action-menu]')).toHaveCount(0);
	});

	test('passes target-author character profiles across root, nested reply, and clear context patches', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root], traceReplies: [trace.direct, trace.deeper] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');

		const rootCharacter = requireCharacterFromPubkey(trace.root.pubkey);
		const rootCalls = await composerContextCalls(page);
		const rootCall = [...rootCalls].reverse().find((call) => call.preloadedEvents?.[trace.root.id]);
		expect(rootCall?.preloadedEvents?.[trace.root.id]?.pubkey).toBe(trace.root.pubkey);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.displayName).toBe(rootCharacter.name);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.picture).toBe(
			new URL(`/characters/${characterPicturePath(rootCharacter.characterId).split('/').at(-1)}`, page.url()).toString()
		);
		expect(rootCall?.preloadedProfiles?.[trace.root.pubkey]?.picture).toMatch(/^https?:\/\//);

		await page.locator(`[data-trace-reply-id="${trace.direct.id}"] .trace-reply-content-button`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay direct reply');
		const replyCharacter = requireCharacterFromPubkey(trace.direct.pubkey);
		const replyCalls = await composerContextCalls(page);
		const replyCall = [...replyCalls].reverse().find((call) => call.preloadedEvents?.[trace.direct.id]);
		expect(replyCall?.preloadedEvents?.[trace.direct.id]?.pubkey).toBe(trace.direct.pubkey);
		expect(replyCall?.preloadedProfiles?.[trace.direct.pubkey]?.displayName).toBe(replyCharacter.name);
		expect(replyCall?.preloadedProfiles?.[trace.direct.pubkey]?.picture).toBe(
			new URL(`/characters/${characterPicturePath(replyCharacter.characterId).split('/').at(-1)}`, page.url()).toString()
		);
		expect(replyCall?.preloadedProfiles).not.toHaveProperty(trace.root.pubkey);

		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toHaveCount(0);
		const clearCall = (await composerContextCalls(page)).at(-1);
		expect(clearCall?.reply).toBeNull();
		expect(clearCall?.preloadedProfiles).toBeUndefined();
	});

	test('directly sends an AI candidate as a Trace reply using the selected root and target', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installPromptApiStub(page);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root], traceReplies: [trace.direct] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary(); relay.releaseTraceRoots(); relay.releaseTraceReplies();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');
		await page.locator(`[data-trace-reply-id="${trace.direct.id}"] .trace-reply-content-button`).click();
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay direct reply');
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeVisible();
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		await primary.click();
		const directReplies = async () => [...new Map(
			(await relayState(page)).state.published
				.filter((event) => event.kind === 1111 && event.content === 'まずは自然な返答です。')
				.map((event) => [event.id, event])
		)].map(([, event]) => event);
		await expect.poll(directReplies).toHaveLength(1);
		const reply = (await directReplies())[0];
		expect(reply.tags).toEqual(expect.arrayContaining([
			['E', trace.root.id, '', trace.root.pubkey], ['e', trace.direct.id, '', trace.direct.pubkey], ['k', '1111']
		]));
		expect(reply.tags.some((tag) => tag[0] === 'w')).toBe(false);
		await expect(page.getByRole('textbox', { name: '投稿エディター' })).toHaveValue('');
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('rejects mismatched structured reply output before position or message publication', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.setViewportSize({ width: 1100, height: 850 });
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root] });
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await page.locator('[data-cell-position="4,2"]').click();
		const editor = page.getByRole('textbox', { name: '投稿エディター' });
		const preview = page.getByLabel('Reply preview', { exact: true });
		await expect(preview).toContainText('Relay trace root');
		const before = (await relayState(page)).state.published.length;
		let terminals = 0;
		for (const target of ['f'.repeat(64), null]) {
			await page.evaluate((eventId) => {
				(window as unknown as { __ehagakiSubmitReplyOverride: unknown }).__ehagakiSubmitReplyOverride = eventId === null ? null : { eventId, relayHints: [], authorPubkey: null };
			}, target);
			await editor.fill('retain mismatched draft');
			await editor.press('Enter');
			await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(++terminals);
			await expect(editor).toHaveValue('retain mismatched draft');
			await expect(preview).toHaveAttribute('data-reply-id', trace.root.id);
			expect((await relayState(page)).state.published).toHaveLength(before);
		}
		await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
		await page.evaluate((eventId) => {
			(window as unknown as { __ehagakiSubmitReplyOverride: unknown }).__ehagakiSubmitReplyOverride = { eventId, relayHints: [], authorPubkey: null };
		}, trace.root.id);
		await editor.press('Enter');
		await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(++terminals);
		expect((await relayState(page)).state.published).toHaveLength(before);
		await expect(editor).toHaveValue('retain mismatched draft');
	});

	for (const outcome of ['accepted', 'duplicate', 'rejected'] as const) {
		test(`publishes a Trace reply with ${outcome} and quarantines echo before OK`, async ({ page }) => {
			const time = Date.now();
			const trace = traceRuntimeEvents();
			await page.clock.setFixedTime(time);
			await page.emulateMedia({ reducedMotion: 'reduce' });
			await page.setViewportSize({ width: 1100, height: 850 });
			await installHostOwnedStub(page);
			await installDelayedRelay(page, { primaryEvents: { message: trace.message, position: trace.selfPosition }, traceRoots: [trace.root] });
			await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
			await page.goto('/');
			await page.evaluate(() => {
				const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
				relay.releaseMetadata(); relay.releasePrimary();
			});
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
			await page.getByRole('button', { name: 'Hide Chatter' }).click();
			await page.locator('[data-cell-position="4,2"]').click();
			const preview = page.getByLabel('Reply preview', { exact: true });
			const editor = page.getByRole('textbox', { name: '投稿エディター' });
			await expect(preview).toContainText('Relay trace root');
			await expect(editor).not.toBeFocused();
			await page.clock.setFixedTime(time + 1000);
			await page.evaluate((outcome) => Object.assign((window as unknown as {
				__relayStartupTest: { state: Record<string, unknown> }
			}).__relayStartupTest.state, { deferReplyPublishes: true, echoRepliesBeforeResult: true, replyOutcome: outcome }), outcome);
			await editor.fill('own Trace shout');
			await editor.press('Control+Enter');
			await expect.poll(async () => (await relayState(page)).state.published.filter((event) => event.kind === 1111).length).toBeGreaterThan(0);
			const raw = (await relayState(page)).state.published.find((event) => event.kind === 1111)!;
			expect(raw.tags).toEqual(expect.arrayContaining([
				['E', trace.root.id, '', trace.root.pubkey], ['e', trace.root.id, '', trace.root.pubkey], ['k', '42']
			]));
			expect(raw.tags.some((tag) => tag[0] === 'w')).toBe(false);
			const bubble = page.locator(`[data-trace-reply-id="${raw.id}"]`);
			await expect(bubble).toHaveCount(0);
			await expect(editor).toHaveValue('own Trace shout');
			const positionsBefore = (await relayState(page)).state.published.filter((event) => event.kind === 30078).length;
			await editor.press('Escape');
			await page.keyboard.press('ArrowRight');
			await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
			expect((await relayState(page)).state.published.filter((event) => event.kind === 30078)).toHaveLength(positionsBefore);
			await page.evaluate(() => (window as unknown as { __relayStartupTest: { releasePublishes(kind: number): void } }).__relayStartupTest.releasePublishes(1111));
			await expect.poll(() => page.evaluate(() => (window as unknown as { __ehagakiTerminalCount: number }).__ehagakiTerminalCount)).toBe(1);
			if (outcome === 'rejected') {
				await expect(editor).toHaveValue('own Trace shout');
				await expect(bubble).toHaveCount(0);
				await expect(preview).toHaveAttribute('data-reply-id', trace.root.id);
			} else {
				await expect(editor).toHaveValue('');
				await expect(preview).toHaveCount(0);
			}
			if (outcome !== 'rejected') {
				await expect(bubble).toContainText('own Trace shout');
				await expect(bubble).toHaveAttribute('data-speech-type', 'shout');
				await expect(page.locator('[data-trace-current-id]')).toHaveAttribute('data-trace-current-id', trace.root.id);
				await expect(page.locator(`[data-trace-reply-ghost-id="${raw.id}"]`)).toHaveCount(0);
			}
			if (outcome === 'rejected') await page.getByRole('button', { name: 'Clear reply', exact: true }).click();
			await editor.fill('normal kind 42 after reply mode');
			await editor.press('Enter');
			await expect.poll(async () => (await relayState(page)).state.published.some((event) => event.kind === 42 && event.content === 'normal kind 42 after reply mode')).toBe(true);
		});
	}

	test('opens a Relay trace root and settles the explicit conversation reply subscription', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			deferPrimaryEvents: true,
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			traceRoots: [trace.root],
			deferTraceRoots: true,
			deferTraceReplies: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		await expect(page.locator('main')).toHaveAttribute('data-trace-runtime', 'relay');
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		if (await hideTimeline.isVisible()) await hideTimeline.click();

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseMetadata(): void }
		}).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, 30078].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind && request.filter.limit !== 1000
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void }
		}).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimary(): void }
		}).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');

		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[] | undefined)?.includes(42) && request.filter.limit === 1000
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceRoots(): void }
		}).__relayStartupTest.releaseTraceRoots());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();

		await page.evaluate(() => {
			(window as typeof window & { __relayStartupTest: { state: { published: unknown[] } } }).__relayStartupTest.state.published.length = 0;
		});
		const publishedPositionIds = async () => new Set(
			(await relayState(page)).state.published.filter((event) => event.kind === 30078).map((event) => event.id)
		).size;
		const positionsBefore = await publishedPositionIds();
		await dragRelayJoystick(page, { x: 24, y: -24 });
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '4,1');
		const positionsAfterMovement = await publishedPositionIds();
		expect(positionsAfterMovement).toBe(positionsBefore + 1);
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(publishedPositionIds).toBeGreaterThanOrEqual(positionsAfterMovement);
		await expect.poll(publishedPositionIds).toBeLessThanOrEqual(positionsAfterMovement + 1);

		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				(filter['#E'] as string[] | undefined)?.includes(trace.root.id)
			) && request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				!('#E' in filter) &&
				(filter['#e'] as string[] | undefined)?.includes(trace.root.id)
			)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toBeVisible();
	});

	test('presents accepted Relay direct replies and preserves cached presentation across refresh', async ({ page }) => {
		const trace = traceRuntimeEvents();
		await installHostOwnedStub(page);
		await installDelayedRelay(page, {
			deferPrimaryEvents: true,
			primaryEvents: { message: trace.message, position: trace.selfPosition },
			traceRoots: [trace.root],
			traceReplies: [trace.direct, trace.selfDirect, trace.deeper, trace.greatGrandchild, trace.invalid],
			deferTraceRoots: true,
			deferTraceReplies: true
		});
		await seedRelayAccount(page, trace.selfSecret, trace.selfPubkey);
		await page.goto('/');
		const hideTimeline = page.getByRole('button', { name: 'Hide Chatter' });
		await hideTimeline.click();

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseMetadata(): void }
		}).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, 30078].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind && request.filter.limit !== 1000
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void }
		}).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePrimary(): void }
		}).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant[data-self="true"]')).toHaveAttribute('data-position', '3,2');
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			(request.filter.kinds as number[] | undefined)?.includes(42) && request.filter.limit === 1000
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceRoots(): void }
		}).__relayStartupTest.releaseTraceRoots());
		await expect(page.locator('[data-trace-marker-position="4,2"]')).toBeVisible();

		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.getByText('Relay direct reply')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		const selfReplyBubble = page.locator(`[data-trace-reply-id="${trace.selfDirect.id}"]`);
		await expect(selfReplyBubble).toContainText('Relay own direct reply');
		await expect(page.locator(`[data-trace-reply-ghost-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-trace-tail-reply-id]`)).toHaveCount(0);
		const publishedPositionIds = async () => new Set(
			(await relayState(page)).state.published.filter((event) => event.kind === 30078).map((event) => event.id)
		).size;
		const positionsBeforeCurrentSwitch = await publishedPositionIds();
		await page.clock.install({ time: Date.now() });
		await pauseAtCurrentBrowserTime(page);
		const now = await page.evaluate(() => Date.now());
		await page.clock.setFixedTime(Math.floor(now / 1000) * 1000 + 1000);
		await page.evaluate(() => {
			(window as typeof window & {
				__relayStartupTest: { state: { deferPositionPublishes: boolean } }
			}).__relayStartupTest.state.deferPositionPublishes = true;
		});
		await selfReplyBubble.locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.selfDirect.id}"]`)).toContainText('Relay own direct reply');
		await expect(page.getByText('Relay deeper branch reply')).toHaveCount(0);
		await expect(page.getByText('Relay invalid reply')).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(publishedPositionIds).toBe(positionsBeforeCurrentSwitch + 1);
		await page.locator(`[data-trace-root-id="${trace.root.id}"]`).click();
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toHaveAttribute('data-trace-current-kind', 'root');
		await expect(page.locator(`[data-trace-current-reply-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.getByLabel('Reply preview', { exact: true })).toContainText('Relay trace root');
		await expect.poll(publishedPositionIds).toBe(positionsBeforeCurrentSwitch + 1);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releasePublishes(kind: number): void }
		}).__relayStartupTest.releasePublishes(30078));

		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectTraceReply(event: object): void }
		}).__relayStartupTest.injectTraceReply(event), trace.live);
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toContainText('Relay live direct reply');

		const replyRequestCount = async () => (await relayState(page)).state.requests.filter((request) =>
			request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(1111))
		).length;
		const requestsBeforeReopen = await replyRequestCount();
		if (await hideTimeline.isVisible()) await hideTimeline.click();
		const blankCell = await relayFieldCellCenter(page, { x: 3, y: 4 });
		await page.mouse.click(blankCell.x, blankCell.y);
		await expect(page.locator('[data-trace-reply-id]')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator('[data-cell-position="4,2"]').click();
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toContainText('Relay live direct reply');
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(replyRequestCount).toBeGreaterThan(requestsBeforeReopen);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect(page.locator(`[data-trace-reply-id="${trace.direct.id}"]`)).toBeVisible();
		const activeReplyCountBeforeCurrentSwitch = await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeTraceReplyCount(): number }
		}).__relayStartupTest.activeTraceReplyCount());
		expect(activeReplyCountBeforeCurrentSwitch).toBeGreaterThan(0);

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator(`[data-trace-reply-id="${trace.direct.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-root-id="${trace.root.id}"]`)).toContainText('Relay trace root');
		await expect(page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`)).toContainText('Relay deeper branch reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.selfDirect.id}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-trace-reply-id="${trace.live.id}"]`)).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				(filter['#E'] as string[] | undefined)?.includes(trace.root.id) &&
				!('#e' in filter)
			) && request.filters.some((filter) =>
				(filter.kinds as number[] | undefined)?.includes(1111) &&
				!('#E' in filter) &&
				(filter['#e'] as string[] | undefined)?.includes(trace.direct.id)
			)
		)).toBe(true);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { activeTraceReplyCount(): number }
		}).__relayStartupTest.activeTraceReplyCount())).toBe(activeReplyCountBeforeCurrentSwitch);

		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectClosedTraceReply(event: object): void }
		}).__relayStartupTest.injectClosedTraceReply(event), trace.staleOldGeneration);
		await expect(page.getByText('Relay stale old-generation child')).toHaveCount(0);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await page.evaluate((event) => (window as typeof window & {
			__relayStartupTest: { injectTraceReply(event: object): void }
		}).__relayStartupTest.injectTraceReply(event), trace.currentLive);
		await expect(page.locator(`[data-trace-reply-id="${trace.currentLive.id}"]`)).toContainText('Relay live current child');

		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { deferTraceReplies(): void }
		}).__relayStartupTest.deferTraceReplies());
		await page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.deeper.id}"]`)).toContainText('Relay deeper branch reply');
		await expect(page.locator(`[data-trace-parent-id="${trace.direct.id}"]`)).toContainText('Relay direct reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.greatGrandchild.id}"]`)).toContainText('Relay great-grandchild reply');
		await expect(page.locator(`[data-trace-reply-id="${trace.currentLive.id}"]`)).toHaveCount(0);
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			request.filters.some((filter) =>
				(filter['#e'] as string[] | undefined)?.includes(trace.deeper.id)
			)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & {
			__relayStartupTest: { releaseTraceReplies(): void }
		}).__relayStartupTest.releaseTraceReplies());
		await expect(page.locator('.trace-reply-status')).toHaveCount(0);
		await page.locator(`[data-trace-parent-id="${trace.direct.id}"]`).locator('.trace-reply-content-button').click();
		await expect(page.locator(`[data-trace-current-reply-id="${trace.direct.id}"]`)).toBeVisible();
		await expect(page.locator(`[data-trace-reply-id="${trace.deeper.id}"]`)).toBeVisible();
	});

	test('passes the Host-owned editor submit button option without enabling the keyboard button bar', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		await expect(page.locator('ehagaki-composer')).toBeVisible();

		const options = await page.evaluate(() => {
			const options = (window as typeof window & {
				__ehagakiHostOwnedOptions?: {
					editorSubmitButtonEnabled?: boolean;
					keyboardButtonBarEnabled?: boolean;
					enterKeyBehavior?: string;
					editorMinLines?: number;
					editorMaxLines?: number;
					submitShortcuts?: Array<{ id: string; modifiers: string[] }>;
				};
			}).__ehagakiHostOwnedOptions;
			return options && {
				editorSubmitButtonEnabled: options.editorSubmitButtonEnabled,
				keyboardButtonBarEnabled: options.keyboardButtonBarEnabled,
				enterKeyBehavior: options.enterKeyBehavior,
				editorMinLines: options.editorMinLines,
				editorMaxLines: options.editorMaxLines,
				submitShortcuts: options.submitShortcuts
			};
		});

		expect(options).toEqual({
			editorSubmitButtonEnabled: true,
			keyboardButtonBarEnabled: false,
			enterKeyBehavior: 'submit',
			editorMinLines: 1,
			editorMaxLines: 3,
			submitShortcuts: [
				{ id: SPEECH_SHORTCUT_IDS.shout, modifiers: ['ctrlOrMeta'] },
				{ id: SPEECH_SHORTCUT_IDS.monologue, modifiers: ['alt'] }
			]
		});
	});

	test('bridges the site accent to the Host-owned Composer theme', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		await page.goto('/');
		const composer = page.locator('ehagaki-composer');
		await expect(composer).toBeVisible();
		await expect(composer.getByRole('textbox', { name: '投稿エディター' })).toBeVisible();

		const colors = await composer.evaluate((element) => {
			const accentValue = getComputedStyle(element).getPropertyValue('--ehagaki-accent-color').trim();
			const probe = document.createElement('span');
			probe.style.color = 'var(--color-accent)';
			document.body.append(probe);
			const siteAccent = getComputedStyle(probe).color;
			probe.style.color = accentValue;
			const composerAccent = getComputedStyle(probe).color;
			probe.remove();
			return { accentValue, siteAccent, composerAccent };
		});

		expect(colors.accentValue).not.toBe('');
		expect(colors.composerAccent).toBe(colors.siteAccent);
	});

	test('generates on-device candidates and directly sends the primary action once', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		await page.getByRole('button', { name: /発言タイプ: 通常/ }).click();
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await expect(candidateButton).toBeVisible();
		await editor.fill('既存のdraft');
		await expect(candidateButton).toBeDisabled();
		await editor.fill('');
		await expect(candidateButton).toBeEnabled();
		const publishedBefore = (await publishedMessages(page)).length;
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		const prompt = await page.evaluate(() => (window as typeof window & {
			__promptApiState: { prompts: string[] }
		}).__promptApiState.prompts.at(-1));
		expect(prompt).toContain('名前:');
		expect(prompt).toContain('直近の会話本文');
		await primary.dblclick();
		await expect.poll(async () => (await publishedMessages(page)).filter((event) => event.content === 'まずは自然な返答です。')).toHaveLength(1);
		await expect(editor).toHaveValue('');
		const published = (await publishedMessages(page)).filter((event) => event.content === 'まずは自然な返答です。');
		expect(published).toHaveLength(1);
		expect(published[0].kind).toBe(42);
		expect(published[0].tags).toEqual(expect.arrayContaining([['l', 'speech:shout', expect.any(String)]]));
		expect((await publishedMessages(page)).length).toBe(publishedBefore + 1);
		expect((await composerContextCalls(page)).filter((call) => Object.hasOwn(call, 'content'))).toEqual([]);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('adds a candidate through Composer without publishing and preserves the draft guard', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await editor.fill('既存のdraft');
		await expect(candidateButton).toBeDisabled();
		await editor.fill('');
		await candidateButton.click();
		await expect(page.locator('.suggestion-primary').first()).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;
		await page.getByRole('button', { name: '候補1をコンポーザーに追加' }).click();
		await expect(editor).toHaveValue('まずは自然な返答です。');
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('closes the candidate panel from its explicit close button without side effects', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await candidateButton.click();
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;
		const close = page.getByRole('button', { name: '発言候補を閉じる' });
		const closeBox = await close.boundingBox();
		const closeIconBox = await close.locator('svg').boundingBox();
		expect(closeBox && closeIconBox).toBeTruthy();
		if (closeBox && closeIconBox) {
			expect(closeBox.width).toBeGreaterThanOrEqual(44);
			expect(closeBox.height).toBeGreaterThanOrEqual(44);
			expect(Math.abs((closeIconBox.x + closeIconBox.width / 2) - (closeBox.x + closeBox.width / 2))).toBeLessThan(1);
			expect(Math.abs((closeIconBox.y + closeIconBox.height / 2) - (closeBox.y + closeBox.height / 2))).toBeLessThan(1);
		}
		await expect(close.locator('svg')).toBeVisible();

		await close.click();

		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(editor).toHaveValue('');
		await expect(page.getByRole('button', { name: /発言タイプ: 通常/ })).toBeVisible();
	});

	test('keeps the candidate panel open while an outside speech-type toggle is used', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		const speechTypeToggle = page.getByRole('button', { name: /発言タイプ: 通常/ });
		await candidateButton.click();
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		const publishedBefore = (await publishedMessages(page)).length;

		await speechTypeToggle.click();

		await expect(page.locator('.suggestion-panel')).toBeVisible();
		await expect(page.getByRole('button', { name: /発言タイプ: 叫び/ })).toBeVisible();
		expect((await publishedMessages(page)).length).toBe(publishedBefore);
		await expect(editor).toHaveValue('');
	});

	test('keeps candidates open after direct publish failure and allows retry', async ({ page }) => {
		await installPromptApiStub(page);
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await openReadyRelayWorld(page, 1);
		const candidateButton = page.getByRole('button', { name: 'AI発言候補を生成' });
		await candidateButton.click();
		const primary = page.locator('.suggestion-primary').first();
		await expect(primary).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await primary.click();
		await expect(page.getByRole('status')).toContainText('候補を送信できませんでした');
		await expect(page.locator('.suggestion-panel')).toBeVisible();
		await page.evaluate(() => (window as unknown as { __relayStartupTest: { allowMessagePublishes(): void } }).__relayStartupTest.allowMessagePublishes());
		await primary.click();
		await expect.poll(async () => (await publishedMessages(page)).some((event) => event.kind === 42 && event.content === 'まずは自然な返答です。')).toBe(true);
		await expect(page.locator('.suggestion-panel')).toHaveCount(0);
	});

	test('keeps the normal Composer when Prompt API availability is unavailable', async ({ page }) => {
		await installPromptApiStub(page, 'unavailable');
		const selfSecret = fixtureSecret(19);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		const editor = await openReadyRelayWorld(page, 1);
		await expect(editor).toBeVisible();
		await expect(page.getByRole('button', { name: 'AI発言候補を生成' })).toHaveCount(0);
	});

	test('publishes normal, shout, and monologue through the editor button and Enter shortcuts', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });

		const submitAndRead = async (content: string, submit: () => Promise<void>) => {
			const before = (await publishedMessages(page)).length;
			await editor.fill(content);
			await submit();
			await waitForPublishedMessageCount(page, before + 1);
			await expect(editor).toHaveValue('');
			const event = (await publishedMessages(page))[before];
			await expect(page.locator(`[data-timeline-event-id="${event.id}"]`)).toHaveCount(1);
			return event;
		};

		const normalByButton = await submitAndRead('button normal', () => send.click());
		const normalByEnter = await submitAndRead('plain Enter', () => editor.press('Enter'));
		const shoutByControl = await submitAndRead('Control shout', () => editor.press('Control+Enter'));
		const shoutByMeta = await submitAndRead('Meta shout', () => editor.press('Meta+Enter'));
		const monologueByAlt = await submitAndRead('Alt monologue', () => editor.press('Alt+Enter'));

		for (const event of [normalByButton, normalByEnter]) {
			expect(event.content).toMatch(/normal|Enter/);
			expect(event.tags.some((tag) => tag[0] === 'l' && tag[1]?.startsWith('speech:'))).toBe(false);
		}
		for (const event of [shoutByControl, shoutByMeta]) {
			expect(event.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);
		}
		expect(monologueByAlt.tags).toContainEqual(['l', 'speech:monologue', 'io.github.lokuyow.persona-bubble-field']);
	});

	test('resolves long and short slash commands before publishing', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		for (const [command, content, label] of [
			['/shout hello', 'hello', 'speech:shout'],
			['/s short hello', 'short hello', 'speech:shout'],
			['/mono monologue hello', 'monologue hello', 'speech:monologue'],
			['/m short monologue', 'short monologue', 'speech:monologue']
		] as const) {
			const before = (await publishedMessages(page)).length;
			await editor.fill(command);
			await send.click();
			await waitForPublishedMessageCount(page, before + 1);
			const event = (await publishedMessages(page))[before];
			expect(event.content).toBe(content);
			expect(event.tags).toContainEqual(['l', label, 'io.github.lokuyow.persona-bubble-field']);
		}
	});

	test('gives keyboard shortcuts precedence while still removing recognized slash prefixes', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const before = (await publishedMessages(page)).length;

		await editor.fill('/m hello');
		await editor.press('Control+Enter');
		await waitForPublishedMessageCount(page, before + 1);
		let event = (await publishedMessages(page))[before];
		expect(event.content).toBe('hello');
		expect(event.tags).toContainEqual(['l', 'speech:shout', 'io.github.lokuyow.persona-bubble-field']);

		await editor.fill('/s hello');
		await editor.press('Alt+Enter');
		await waitForPublishedMessageCount(page, before + 2);
		event = (await publishedMessages(page))[before + 1];
		expect(event.content).toBe('hello');
		expect(event.tags).toContainEqual(['l', 'speech:monologue', 'io.github.lokuyow.persona-bubble-field']);
	});

	test('does not publish Ctrl+Meta+Enter as a ctrlOrMeta speech shortcut', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const before = (await publishedMessages(page)).length;

		await editor.fill('both modifiers');
		await editor.press('Control+Meta+Enter');
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(before);
		await expect(editor).toHaveValue('both modifiers');
	});

	test('keeps command-only content and false-positive slash text instead of publishing an empty command', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		await editor.fill('/shout');
		await send.click();
		await expect(editor).toHaveValue('/shout');
		await expect.poll(async () => (await publishedMessages(page)).length).toBe(0);

		await editor.fill('/something');
		await send.click();
		await waitForPublishedMessageCount(page, 1);
		const event = (await publishedMessages(page))[0];
		expect(event.content).toBe('/something');
		expect(event.tags.some((tag) => tag[0] === 'l' && tag[1]?.startsWith('speech:'))).toBe(false);
	});

		test('cycles the one-shot speech selector and only resets it after a successful submit', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		const selector = page.locator('.speech-type-toggle');
		const assertSpeechIcon = async (speechType: 'normal' | 'shout' | 'monologue', accessibleName: RegExp): Promise<void> => {
			await expect(selector).toHaveAttribute('data-speech-type', speechType);
			await expect(selector).toHaveAccessibleName(accessibleName);
			await expect(page.locator(`[data-speech-icon="${speechType}"]`)).toBeVisible();
			const buttonBox = await selector.boundingBox();
			const iconBox = await page.locator(`[data-speech-icon="${speechType}"]`).boundingBox();
			expect(buttonBox && iconBox).toBeTruthy();
			if (buttonBox && iconBox) {
				expect(buttonBox.width).toBeGreaterThanOrEqual(44);
				expect(buttonBox.height).toBeGreaterThanOrEqual(44);
				expect(Math.abs((iconBox.x + iconBox.width / 2) - (buttonBox.x + buttonBox.width / 2))).toBeLessThan(1);
				expect(Math.abs((iconBox.y + iconBox.height / 2) - (buttonBox.y + buttonBox.height / 2))).toBeLessThan(1);
			}
		};

		await assertSpeechIcon('normal', /発言タイプ: 通常.*叫び/);
		await selector.click();
		await assertSpeechIcon('shout', /発言タイプ: 叫び.*モノローグ/);
		await selector.click();
		await assertSpeechIcon('monologue', /発言タイプ: モノローグ.*通常/);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await editor.fill('keep monologue on failure');
		await send.click();
		await expect(editor).toHaveValue('keep monologue on failure');
		await expect(selector).toHaveAttribute('data-speech-type', 'monologue');

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowMessagePublishes(): void } }).__relayStartupTest.allowMessagePublishes());
		await editor.fill('successful monologue');
		await send.click();
		await waitForPublishedMessageCount(page, 2);
		await expect(selector).toHaveAttribute('data-speech-type', 'normal');
	});

	test('renders DEV sandbox without Composer in the initial response or after hydration', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		const consoleIssues: string[] = [];
		page.on('console', (message) => {
			if (message.type() === 'warning' || message.type() === 'error') consoleIssues.push(message.text());
		});
		page.on('pageerror', (error) => consoleIssues.push(error.message));

		const response = await page.goto('/?devWorld=1');
		expect(response).not.toBeNull();
		expect(await response!.text()).not.toContain('<div class="composer-dock');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.participant')).toHaveCount(1);
		await expect(page.locator('.composer-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		expect(hostOwned.requests()).toBe(0);
		expect(consoleIssues).toEqual([]);
	});

	test('keeps history-only messages in the timeline without restoring their presence or bubbles', async ({ page }) => {
		const historySecret = fixtureSecret(20);
		const createdAt = Math.floor(Date.now() / 1000) - 3_600;
		const historyMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'history-only message',
			speechType: 'monologue',
			position: { x: 1, y: 1 },
			createdAt
		}), historySecret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages: [historyMessage] });
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42 &&
			request.filters.length === 2 &&
			request.filters.some((filter) => typeof filter.since === 'number') &&
			request.filters.some((filter) => filter.limit === 50 && filter.since === undefined)
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());

		await expect(page.locator(`[data-timeline-event-id="${historyMessage.id}"]`)).toHaveCount(1);
		await expect(page.locator(`[data-participant-id="${historyMessage.pubkey}"]`)).toHaveCount(0);
		await expect(page.locator(`[data-bubble-id="${historyMessage.id}"]`)).toHaveCount(0);
	});

	test('continues timeline ingestion while its overlay is hidden', async ({ page }) => {
		await page.setViewportSize({ width: 1200, height: 500 });
		const liveSecret = fixtureSecret(21);
		const liveMessage = finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: 'arrived while hidden',
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000)
		}), liveSecret);
		const historyMessages = Array.from({ length: 9 }, (_, index) => finalizeEvent(buildWorldMessageTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			content: `history ${index + 1}`,
			speechType: 'normal',
			position: { x: 3, y: 3 },
			createdAt: Math.floor(Date.now() / 1000) - 3_600 - index
		}), fixtureSecret(30 + index)));
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { historyMessages });
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 42
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.locator('.participant')).toHaveCount(2);
		await expect(page.locator('aside.recent-message-timeline')).toBeVisible();
		const visibleTimeline = page.locator('.timeline-visible-entries .timeline-entry');
		const beforeHiddenIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		await page.getByRole('button', { name: 'Hide Chatter' }).click();
		await expect(page.locator('aside.recent-message-timeline')).toBeHidden();
		await page.evaluate((event) => (window as typeof window & { __relayStartupTest: { injectMessage(event: object): void } }).__relayStartupTest.injectMessage(event), liveMessage);
		await page.getByRole('button', { name: 'Show Chatter' }).click();
		await expect(page.locator(`[data-timeline-event-id="${liveMessage.id}"]`)).toHaveCount(1);
		const afterShownIds = await visibleTimeline.evaluateAll((entries) => entries.map((entry) => entry.getAttribute('data-timeline-event-id')));
		expect(afterShownIds.some((id) => !beforeHiddenIds.includes(id))).toBe(true);
	});

	for (const viewport of [
		{ name: 'desktop', width: 1200, height: 900 },
		{ name: 'mobile', width: 390, height: 844 }
	]) {
		test(`reserves the one-line Composer from the initial render on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await installHostOwnedStub(page);
			await installDelayedRelay(page);

			const response = await page.goto('/', { waitUntil: 'commit' });
			expect(response).not.toBeNull();
			expect(await response!.text()).toContain('composer-dock');

			await expect(page.locator('.composer-dock')).toBeVisible();
			await expect(page.locator('ehagaki-composer')).toBeVisible();
			const beforePreferredHeight = await page.evaluate(() => {
				const shell = document.querySelector<HTMLElement>('.app-shell')!;
				const dock = document.querySelector<HTMLElement>('.composer-dock')!;
				const field = document.querySelector<HTMLElement>('.field-viewport')!;
				return {
					dockHeight: dock.getBoundingClientRect().height,
					fieldHeight: field.getBoundingClientRect().height,
					viewportHeight: window.innerHeight,
					initialPreferredHeight: getComputedStyle(shell)
						.getPropertyValue('--composer-initial-preferred-height').trim(),
					preferredHeight: getComputedStyle(shell).getPropertyValue('--composer-preferred-height').trim()
				};
			});
			expect(beforePreferredHeight.initialPreferredHeight).toBe('50px');
			expect(beforePreferredHeight.preferredHeight).toBe('50px');
			const expectedInitialDockHeight = viewport.name === 'mobile' ? 121 : 67;
			expect(beforePreferredHeight.dockHeight).toBeCloseTo(expectedInitialDockHeight, 1);
			expect(beforePreferredHeight.fieldHeight + beforePreferredHeight.dockHeight)
				.toBeCloseTo(beforePreferredHeight.viewportHeight, 1);

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(50));
			await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.composer-dock')!.getBoundingClientRect().height))
				.toBeCloseTo(beforePreferredHeight.dockHeight, 1);

			const afterPreferredHeight = await page.evaluate(() => ({
				dockHeight: document.querySelector<HTMLElement>('.composer-dock')!.getBoundingClientRect().height,
				fieldHeight: document.querySelector<HTMLElement>('.field-viewport')!.getBoundingClientRect().height
			}));
			expect(Math.abs(afterPreferredHeight.dockHeight - beforePreferredHeight.dockHeight)).toBeLessThan(0.5);
			expect(Math.abs(afterPreferredHeight.fieldHeight - beforePreferredHeight.fieldHeight)).toBeLessThan(0.5);
		});
	}

	test('keeps Field geometry reserved while only the fixed Composer follows VirtualKeyboard geometry', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installVirtualKeyboardStub(page);
		await openReadyRelayWorld(page);
		await expect.poll(() => page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { state(): { overlaysContent: boolean } };
		}).__virtualKeyboardTest.state().overlaysContent)).toBe(true);

		const before = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.composer-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform,
				position: getComputedStyle(dock).position,
				viewportHeight: window.innerHeight
			};
		});
		expect(before.position).toBe('fixed');
		expect(before.dock.bottom).toBeCloseTo(before.viewportHeight, 1);
		expect(before.field.height + before.dock.height).toBeCloseTo(before.viewportHeight, 1);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(300));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('300px');

		const keyboardOpen = await page.evaluate(() => {
			const dock = document.querySelector<HTMLElement>('.composer-dock')!;
			const field = document.querySelector<HTMLElement>('.field-viewport')!;
			const self = document.querySelector<HTMLElement>('.participant[data-self="true"]')!;
			return {
				dock: dock.getBoundingClientRect().toJSON(),
				field: field.getBoundingClientRect().toJSON(),
				participant: self.getBoundingClientRect().toJSON(),
				cameraTransform: getComputedStyle(document.querySelector<HTMLElement>('.field-scene')!).transform
			};
		});
		expect(keyboardOpen.dock.bottom).toBeCloseTo(544, 1);
		expect(keyboardOpen.field.height).toBeCloseTo(before.field.height, 1);
		expect(keyboardOpen.participant).toEqual(before.participant);
		expect(keyboardOpen.cameraTransform).toBe(before.cameraTransform);

		await page.evaluate(() => (window as typeof window & {
			__virtualKeyboardTest: { setBottomInset(inset: number): void };
		}).__virtualKeyboardTest.setBottomInset(0));
		await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.app-shell')!)
			.getPropertyValue('--composer-keyboard-inset').trim())).toBe('0px');
		await expect(page.locator('.composer-dock')).toHaveCSS('bottom', '0px');

	});

	for (const viewport of [
		{ name: 'desktop', width: 1200, height: 900 },
		{ name: 'mobile', width: 390, height: 844 }
	]) {
		test(`keeps Field geometry stable while Host-owned Composer grows on ${viewport.name}`, async ({ page }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height });
			await openReadyRelayWorld(page);
			const participantPosition = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
			if (!participantPosition) throw new Error('Expected the Relay self participant position.');
			const [participantX, participantY] = participantPosition.split(',').map(Number);
			const bubbleEvent = finalizeEvent(buildWorldMessageTemplate({
				channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
				content: 'geometry regression bubble',
				speechType: 'normal',
				position: { x: participantX, y: participantY },
				// A same-second bootstrap position outranks a message's position evidence.
				createdAt: Math.floor(Date.now() / 1000) + 1
			}), fixtureSecret(19));
			await page.evaluate((event) => (window as typeof window & {
				__relayStartupTest: { injectMessage(event: object): void };
			}).__relayStartupTest.injectMessage(event), bubbleEvent);
			await expect(page.locator('.bubble').first()).toBeVisible();
			await expect(page.locator('.field-scene')).not.toHaveAttribute('data-camera-animation', 'active');
			await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			const readGeometry = () => page.evaluate(() => {
				const rect = (selector: string, index = 0) => {
					const element = document.querySelectorAll<HTMLElement>(selector)[index];
					return element?.getBoundingClientRect().toJSON() ?? null;
				};
				return {
					dock: rect('.composer-dock'),
					viewport: rect('.field-viewport'),
					area: rect('.field-area'),
					scene: rect('.field-scene'),
					speech: rect('.speech-area'),
					participant: rect('.participant[data-self="true"]'),
					bubble: rect('.bubble'),
					transform: getComputedStyle(document.querySelector('.field-scene')!).transform
				};
			});
			const before = await readGeometry();
			expect(before.bubble).not.toBeNull();

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(200));
			await expect.poll(async () => (await readGeometry()).dock!.height).toBeGreaterThan(before.dock!.height);
			const grown = await readGeometry();
			expect(grown.dock!.y).toBeLessThan(before.dock!.y);
			expect(grown.viewport).toEqual(before.viewport);
			expect(grown.area).toEqual(before.area);
			expect(grown.scene).toEqual(before.scene);
			expect(grown.speech).toEqual(before.speech);
			expect(grown.participant).toEqual(before.participant);
			expect(grown.bubble).toEqual(before.bubble);
			expect(grown.transform).toBe(before.transform);

			await page.evaluate(() => (window as typeof window & {
				__ehagakiSetPreferredHeight(height: number): void;
			}).__ehagakiSetPreferredHeight(50));
			await expect.poll(async () => (await readGeometry()).dock!.height).toBeCloseTo(before.dock!.height, 1);
			const restored = await readGeometry();
			expect(restored.viewport).toEqual(before.viewport);
			expect(restored.area).toEqual(before.area);
			expect(restored.scene).toEqual(before.scene);
			expect(restored.speech).toEqual(before.speech);
			expect(restored.participant).toEqual(before.participant);
			expect(restored.bubble).toEqual(before.bubble);
			expect(restored.transform).toBe(before.transform);
		});
	}

	test('decouples Composer from metadata and participant projection from final primary EOSE', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferPrimaryEvents: true });
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');

		await expect(page.locator('.composer-dock')).toBeVisible();
		await expect.poll(hostOwned.requests).toBeGreaterThan(0);
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await expect(editor).toBeVisible();
		await editor.fill('queued until Relay is ready');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(page.locator('.speech-type-toggle')).toBeDisabled();

		const beforeMetadata = await relayState(page);
		expect(beforeMetadata.state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(false);
		expect(beforeMetadata.state.published.filter((event) => event.kind === 42)).toHaveLength(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => {
			const requests = (await relayState(page)).state.requests;
			return [42, 30078].every((kind) => requests.some((request) =>
				AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
				(request.filter.kinds as number[])[0] === kind
			));
		}).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator('.bubble')).toHaveCount(0);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectPositionPublishes(): void } }).__relayStartupTest.rejectPositionPublishes());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
		await expect(page.getByRole('button', { name: 'Enter field again' })).toBeVisible();
		await expect(editor).toHaveValue('queued until Relay is ready');
		await editor.fill('reject while entry is retryable');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('reject while entry is retryable');
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { allowPositionPublishes(): void } }).__relayStartupTest.allowPositionPublishes());
		await page.getByRole('button', { name: 'Enter field again' }).click();
		await editor.fill('publish after entry recovery');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(async () => new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id)).size).toBe(1);
		const [publishedMessageId] = new Set((await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => event.id));
		await expect(editor).toHaveValue('');
		await expect(page.locator('.participant[data-position="3,2"]')).toHaveCount(1);
		await expect(page.locator(`.bubble[data-bubble-id="${publishedMessageId}"]`)).toHaveCount(1);

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { rejectMessagePublishes(): void } }).__relayStartupTest.rejectMessagePublishes());
		await editor.fill('retain after Relay rejection');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after Relay rejection');
		await page.evaluate(() => { (window as typeof window & { __ehagakiAbortNextSubmit?: boolean }).__ehagakiAbortNextSubmit = true; });
		await editor.fill('retain after abort');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect(editor).toHaveValue('retain after abort');
	});

	test('aborting a metadata-waiting submit releases it without publishing later', async ({ page }) => {
		await installHostOwnedStub(page);
		await installDelayedRelay(page);
		const selfSecret = fixtureSecret(41);
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
		await editor.fill('abort while waiting for metadata');
		await page.locator('ehagaki-composer').getByRole('button', { name: 'Send' }).click();
		await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __ehagakiSubmitStarted?: boolean }).__ehagakiSubmitStarted))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __ehagakiAbortActiveSubmit(): void }).__ehagakiAbortActiveSubmit());
		await expect(editor).toHaveValue('abort while waiting for metadata');

		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) => AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) && [42, 30078].includes((request.filter.kinds as number[])[0]))).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant')).toHaveCount(2);
		expect(new Set((await relayState(page)).state.published.filter((event) => event.kind === 42).map((event) => event.id)).size).toBe(0);
		await expect(editor).toHaveValue('abort while waiting for metadata');
	});

	test('uses an empty Host-owned Composer editor Arrow for one movement and prevents its default', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(16);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(true);
	});

	test('does not move or prevent Arrow default from another Composer control', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await page.evaluate(() => {
			(window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = false;
			window.addEventListener('keydown', (event) => {
				if (event.key.startsWith('Arrow')) (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted = event.defaultPrevented;
			});
		});
		const send = page.locator('ehagaki-composer').getByRole('button', { name: 'Send' });
		await send.focus();
		await page.keyboard.press('ArrowRight');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __keyboardDefaulted?: boolean }).__keyboardDefaulted)).toBe(false);
	});

	test('preserves Composer editing Arrow behavior while non-empty and re-enables movement after deletion', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		await editor.fill('x');
		await editor.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect.poll(() => editor.evaluate((element) => ({
			value: (element as HTMLTextAreaElement).value,
			selectionStart: (element as HTMLTextAreaElement).selectionStart
		}))).toEqual({ value: 'x', selectionStart: 0 });

		await editor.fill('');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('fails closed for Composer empty-state null and preserves modifier Arrow behavior', async ({ page }) => {
		await page.addInitScript(() => {
			(window as typeof window & { __ehagakiDeferComposerEmptyState?: boolean }).__ehagakiDeferComposerEmptyState = true;
		});
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');
		const move = await chooseHorizontalMove(page);
		await editor.focus();
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await page.evaluate(() => (window as typeof window & { __ehagakiResolveComposerEmptyState?: () => void }).__ehagakiResolveComposerEmptyState?.());
		await page.keyboard.press('Shift+' + move.key);
		await page.keyboard.press('Control+' + move.key);
		await page.keyboard.press('Alt+' + move.key);
		await page.keyboard.press('Meta+' + move.key);
		await expect(self).toHaveAttribute('data-position', before ?? '');

		await editor.fill('');
		await page.keyboard.press(move.key);
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('continues Composer-empty movement on a hold at the Relay movement cadence', async ({ page }) => {
		const editor = await openClockedReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const position = await self.getAttribute('data-position');
		if (!position) throw new Error('Expected the Relay self participant position.');
		const [x] = position.split(',').map(Number);
		const move = await chooseHorizontalMove(page);
		const key = move.key;
		await editor.focus();
		await page.keyboard.down(key);
		await page.clock.runFor(50);
		await expect(self).not.toHaveAttribute('data-position', position);
		await page.clock.runFor(750);
		await page.clock.runFor(750);
		await page.keyboard.up(key);
		const finalPosition = await self.getAttribute('data-position');
		const [finalX] = (finalPosition ?? '').split(',').map(Number);
		expect(Math.abs(finalX - x)).toBeGreaterThanOrEqual(1);
		await page.clock.runFor(1_000);
		await expect(self).toHaveAttribute('data-position', finalPosition ?? '');
	});

	test('focuses the Composer with N and blurs it with Escape before WASD movement', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const move = await chooseHorizontalMove(page);

		await page.locator('.participant').first().focus();
		await page.keyboard.press('n');
		await expect(editor).toBeFocused();

		await editor.fill('keep this content');
		await page.keyboard.press('Escape');
		await expect(editor).not.toBeFocused();
		await expect(editor).toHaveValue('keep this content');
		await page.keyboard.press(move.key === 'ArrowRight' ? 'd' : 'a');
		await expect(self).toHaveAttribute('data-position', move.expected);
	});

	test('keeps WASD and N as normal Composer input while the editor is focused', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await editor.fill('');
		await editor.focus();
		for (const key of ['w', 'a', 's', 'd', 'n', 'c']) await page.keyboard.press(key);
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).toHaveValue('wasdnc');
	});

	test('does not intercept Composer shortcuts while a profile dialog is open', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await openProfile(page);
		await page.keyboard.press('d');
		await page.keyboard.press('n');
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();
		await expect(profileDialog(page)).toBeVisible();
	});

	test('does not intercept WASD or N during composition or with modifiers in the Composer', async ({ page }) => {
		const editor = await openReadyRelayWorld(page);
		const self = page.locator('.participant[data-self="true"]');
		const before = await self.getAttribute('data-position');

		await page.locator('.participant').first().focus();
		await page.keyboard.press('Shift+d');
		await page.keyboard.press('Control+n');
		await page.keyboard.press('Alt+w');
		await page.keyboard.press('Meta+a');
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'd', code: 'KeyD', isComposing: true, bubbles: true
		})));
		await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'n', code: 'KeyN', isComposing: true, bubbles: true
		})));
		await expect(self).toHaveAttribute('data-position', before ?? '');
		await expect(editor).not.toBeFocused();

		await editor.fill('composition content');
		await editor.focus();
		await editor.evaluate((element) => element.dispatchEvent(new KeyboardEvent('keydown', {
			key: 'Escape', code: 'Escape', isComposing: true, bubbles: true, composed: true
		})));
		await expect(editor).toBeFocused();
		await expect(editor).toHaveValue('composition content');
	});

	test('permanently dismisses speech at a visual RAF crossing before canonical refresh', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.now() });
		await page.addInitScript(() => {
			const browserWindow: Window = window;
			const interval = browserWindow.setInterval.bind(browserWindow);
			const refresh = { ticks: 0, lastTick: 0 };
			browserWindow.setInterval = (handler, timeout, ...args) => {
				if (timeout !== 250 || typeof handler !== 'function') return interval(handler, timeout, ...args);
				return interval(() => {
					refresh.ticks += 1;
					refresh.lastTick = Date.now();
					handler(...args);
				}, timeout);
			};
			Object.assign(window, { __presenceRefreshClock: refresh });
		});
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		const createdAt = Math.floor(Date.now() / 1000);
		const selfSecret = fixtureSecret(23);
		const remoteSecret = fixtureSecret(19);
		const speech = finalizeEvent(buildWorldMessageTemplate({
			channel, createdAt, content: 'speech remains dismissed after the visual speaker returns',
			speechType: 'normal', position: { x: 10, y: 3 }
		}), remoteSecret);
		const selfPosition = finalizeEvent(buildWorldStateEventTemplate({
			channel, createdAt, position: { x: 7, y: 3 }, slot: 0
		}), selfSecret);
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { primaryEvents: { message: speech, position: selfPosition } });
		await seedRelayAccount(page, selfSecret, selfPosition.pubkey);
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => {
			const relay = (window as unknown as { __relayStartupTest: { releaseMetadata(): void; releasePrimary(): void } }).__relayStartupTest;
			relay.releaseMetadata(); relay.releasePrimary();
		});
		const bubble = page.locator(`[data-bubble-participant-id="${speech.pubkey}"]`);
		const speaker = page.locator(`.participant[data-participant-id="${speech.pubkey}"]`);
		await expect(bubble).toBeVisible();
		await pauseAtCurrentBrowserTime(page);
		await page.clock.runFor(500);
		const refreshClock = () => page.evaluate(() => {
			const refresh = (window as unknown as { __presenceRefreshClock: { ticks: number; lastTick: number } }).__presenceRefreshClock;
			return { ...refresh, now: Date.now() };
		});
		const clock = await refreshClock();
		expect(clock.ticks).toBeGreaterThan(0);
		// Advance exactly to a controlled refresh boundary; no wall-clock race.
		await page.clock.runFor(clock.lastTick + 250 - clock.now);
		const before = await refreshClock();
		const sampleX = () => speaker.evaluate((element) => {
			const rect = element.getBoundingClientRect();
			const area = document.querySelector('.field-area')!.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, left: area.left, right: area.right };
		});
		const initial = await sampleX();
		expect(initial.x).toBeGreaterThan(initial.left);
		expect(initial.x).toBeLessThan(initial.right);
		const injectPosition = async (x: number, slot: 0 | 1) => {
			const event = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: { x, y: 3 }, slot }), remoteSecret);
			await page.evaluate((event) => (window as unknown as {
				__relayStartupTest: { injectPosition(event: object): void };
			}).__relayStartupTest.injectPosition(event), event);
		};
		await injectPosition(15, 0);
		await expect(speaker).toHaveAttribute('data-position', '15,3');
		await page.clock.runFor(100);
		const outside = await sampleX();
		expect(outside.x).toBeGreaterThan(outside.right);
		await expect(bubble).toHaveCount(0);
		expect((await refreshClock()).ticks).toBe(before.ticks);
		// Canonical position is back inside before any refresh can dismiss it.
		await injectPosition(10, 1);
		await expect(speaker).toHaveAttribute('data-position', '10,3');
		await page.clock.runFor(500);
		const returned = await sampleX();
		expect(returned.x).toBeGreaterThan(returned.left);
		expect(returned.x).toBeLessThan(returned.right);
		expect((await refreshClock()).ticks).toBeGreaterThan(before.ticks);
		await expect(bubble).toHaveCount(0);
	});

	test('removes a remote participant immediately when a live World State exit arrives', async ({ page }) => {
		const selfSecret = fixtureSecret(19);
		const remoteSecret = fixtureSecret(20);
		const createdAt = Math.floor(Date.now() / 1000);
		const channel = { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' };
		await installHostOwnedStub(page);
		await installDelayedRelay(page, { deferPrimaryEvents: true });
		await seedRelayAccount(page, selfSecret, getPublicKey(selfSecret));
		await page.goto('/');
		await expect(page.locator('.composer-dock')).toBeVisible();
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releaseMetadata(): void } }).__relayStartupTest.releaseMetadata());
		await expect.poll(async () => (await relayState(page)).state.requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === 30078
		)).toBe(true);
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void; releasePrimary(): void } }).__relayStartupTest.releasePrimaryEvents());
		await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());

		const cell = { x: 2, y: 1 };
		const active = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: cell, slot: 0 }), remoteSecret);
		const exit = finalizeEvent(buildWorldStateEventTemplate({ channel, createdAt, position: cell, slot: 'exit' }), remoteSecret);
		const inject = (event: NostrEvent) => page.evaluate((nextEvent) => (window as typeof window & {
			__relayStartupTest: { injectPosition(event: object): void }
		}).__relayStartupTest.injectPosition(nextEvent), event);
		await inject(active);
		const remote = page.locator(`.participant[data-participant-id="${active.pubkey}"]`);
		await expect(remote).toHaveAttribute('data-position', `${cell.x},${cell.y}`);
		await inject(exit);
		await expect(remote).toHaveCount(0);
		await expect(page.locator(`.participant[data-position="${cell.x},${cell.y}"]`)).toHaveCount(0);
	});

	test('retargets active participant and camera animation when another participant updates', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.clock.install({ time: Date.now() });
		const editor = await openReadyRelayWorld(page);
		await pauseAtCurrentBrowserTime(page);
		await installVisualAnimationRafMetrics(page);
		const self = page.locator('.participant[data-self="true"]');
		const scene = page.locator('.field-scene');
		const remotePosition = finalizeEvent(buildWorldStateEventTemplate({
			channel: { channelId: CHANNEL_ID, relayHint: 'wss://nos.lol/' },
			position: { x: 4, y: 2 },
			slot: 0,
			createdAt: Math.floor(Date.now() / 1000) + 1
		}), fixtureSecret(19));

		const initialPosition = await self.getAttribute('data-position');
		if (!initialPosition) throw new Error('Expected the Relay self participant position.');
		const [initialX, initialY] = initialPosition.split(',').map(Number);
		const cameraBoundary = { x: initialX < 8 ? 15 : 0, y: initialY < 4 ? 7 : 0 };
		let move = await chooseMoveToward(page, cameraBoundary);
		let retargetMove: AvailableMove | null = null;
		for (let attempt = 0; attempt < 16; attempt += 1) {
			const transformBeforeMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			const positionBeforeMove = await self.getAttribute('data-position');
			if (!positionBeforeMove) throw new Error('Expected the Relay self participant position.');
			await editor.focus();
			await page.keyboard.press(move.key);
			await expect(self).toHaveAttribute('data-position', move.expected);
			await expect(self).toHaveAttribute('data-movement-animation', 'active');
			await page.clock.runFor(2_000);
			const transformAfterMove = await scene.evaluate((element) => getComputedStyle(element).transform);
			if (transformAfterMove !== transformBeforeMove) {
				retargetMove = {
					key: reverseMoveKey(move.key),
					expected: positionBeforeMove
				};
				break;
			}
			await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
			move = await chooseMoveToward(page, cameraBoundary);
		}
		expect(retargetMove).not.toBeNull();

		const transformBeforeRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);
		await editor.focus();
		await page.keyboard.press(retargetMove!.key);
		await expect(self).toHaveAttribute('data-position', retargetMove!.expected);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await page.evaluate((event) => {
			(window as typeof window & { __relayStartupTest: { injectPosition(event: object): void } }).__relayStartupTest.injectPosition(event);
		}, remotePosition);
		await page.clock.runFor(100);
		await expect(self).toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).toHaveAttribute('data-camera-animation', 'active');
		expect(await page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { maxPending(): number } }).__visualAnimationRafMetrics.maxPending())).toBeLessThanOrEqual(1);
		const transformDuringRetarget = await scene.evaluate((element) => getComputedStyle(element).transform);

		await page.clock.runFor(1_000);
		await expect(self).not.toHaveAttribute('data-movement-animation', 'active');
		await expect(scene).not.toHaveAttribute('data-camera-animation', 'active');
		await expect.poll(() => page.evaluate(() => (window as typeof window & { __visualAnimationRafMetrics: { pending(): number } }).__visualAnimationRafMetrics.pending())).toBe(0);
		const transformAtRest = await scene.evaluate((element) => getComputedStyle(element).transform);
		expect(transformBeforeRetarget).not.toBe(transformAtRest);
		expect(transformDuringRetarget).not.toBe(transformAtRest);
		await expect(self).toHaveAttribute('data-position', retargetMove!.expected);
		await expect(page.locator(`.participant[data-participant-id="${remotePosition.pubkey}"]`)).toHaveAttribute('data-position', '4,2');
	});

	test('never mounts or loads the Host-owned Composer in DEV World', async ({ page }) => {
		const hostOwned = await installHostOwnedStub(page);
		await page.goto('/?devWorld=1');

		await expect(page.getByLabel('DEV sandbox controls')).toBeVisible();
		await expect(page.locator('.composer-dock')).toHaveCount(0);
		await expect(page.locator('ehagaki-composer')).toHaveCount(0);
		expect(hostOwned.requests()).toBe(0);
	});
});
