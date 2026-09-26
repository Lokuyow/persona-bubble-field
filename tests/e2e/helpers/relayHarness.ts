import { expect, type Locator, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { finalizeEvent, getPublicKey, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import {
	buildWorldStateEventTemplate,
	WORLD_STATE_KIND,
	buildTraceReplyTemplate,
	buildWorldMessageTemplate,
	parseTraceReplyCandidate,
	parseWorldMessage,
	validateTraceReplyCandidate
} from '../../../src/lib/nostrProtocol';
import {
	buildCooperationDefectionActionTemplate,
	getCooperationDefectionRoundSchedule,
	getCooperationDefectionSchedule,
	getCooperationDefectionScheduleForDate,
	getCooperationDefectionScheduleForInstance,
	type CooperationDefectionAction
} from '../../../src/lib/cooperationDefection';
import { requireCharacterFromPubkey, resolveCharacterFromPubkey } from '../../../src/lib/characterAssignment';
import { deriveBip85NostrEntropy } from '../../../src/lib/bip85';
import { isBlockedFacilityCell } from '../../../src/lib/fieldFacilities';
import { moveOneCell, type Direction, type GridPosition } from '../../../src/lib/geometry';
import { PROTOTYPE_AUTHORITATIVE_RELAYS, PROTOTYPE_CHANNEL_ID, PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from '../../../src/lib/prototypeWorldConfig';
import { installHostOwnedStub } from './hostOwnedComposerStub';
import { installFieldFrameSampling, readFieldFrames, sampleRenderedField } from './fieldFrames';

export const CHANNEL_ID = PROTOTYPE_CHANNEL_ID;
export const AUTHORITATIVE_RELAYS = PROTOTYPE_AUTHORITATIVE_RELAYS;

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

export function fixtureSecret(value: number): Uint8Array {
	const entry = FIXTURE_CHILDREN.get(value);
	if (!entry) throw new Error(`Missing fixture signer ${value}.`);
	return entry.secret.slice();
}

export function fixtureAccountIndexForSecret(secretKey: Uint8Array): number {
	for (const { accountIndex, secret } of FIXTURE_CHILDREN.values()) {
		if (secret.length === secretKey.length && secret.every((value, index) => value === secretKey[index])) return accountIndex;
	}
	throw new Error('Fixture secret is not derived from the zero root.');
}

export function profileDialog(page: Page) {
	return page.getByRole('dialog');
}

export async function openProfile(page: Page): Promise<void> {
	const timeline = page.getByLabel('Chatter', { exact: true });
	if (await timeline.isVisible()) await page.locator('.chatter-toggle').click();
	await page.locator('[data-self="true"] .participant-profile-trigger').click();
	await expect(profileDialog(page)).toBeVisible();
}

export function testEvents(nowMs = Date.now(), channelId = CHANNEL_ID) {
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

function nextCooperationDefectionDateKey(dateKey: string): string {
	const date = new Date(`${dateKey}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

export function nextScheduledCooperationDefectionSchedule(schedule: ReturnType<typeof getCooperationDefectionSchedule>): ReturnType<typeof getCooperationDefectionSchedule> {
	const next = getCooperationDefectionScheduleForDate(nextCooperationDefectionDateKey(schedule.dateKey), schedule.endedAtMs + 1);
	if (next.instanceId === schedule.instanceId || next.dateKey === schedule.dateKey || next.phase === 'ended') {
		throw new Error(`Expected a distinct upcoming CooperationDefection schedule after ${schedule.instanceId}.`);
	}
	return next;
}

export function upcomingRegistrationSchedule(): ReturnType<typeof getCooperationDefectionSchedule> {
	const nowMs = Date.now();
	let schedule = getCooperationDefectionSchedule(nowMs);
	if (schedule.registrationAtMs <= nowMs) schedule = nextScheduledCooperationDefectionSchedule(schedule);
	return schedule;
}

export function signedCooperationDefectionAction(secretKey: Uint8Array, schedule: ReturnType<typeof getCooperationDefectionSchedule>, action: CooperationDefectionAction, createdAtMs: number, channelId = CHANNEL_ID): NostrEvent {
	return finalizeEvent(buildCooperationDefectionActionTemplate({
		channelId,
		relayHint: 'wss://nos.lol/',
		instanceId: schedule.instanceId,
		action,
		createdAt: Math.floor(createdAtMs / 1000)
	}), secretKey);
}

export function syntheticChannelFixture() {
	const secret = fixtureSecret(63);
	const event = finalizeEvent({
		kind: 40,
		created_at: 1_800_000_000,
		tags: [],
		content: JSON.stringify({ name: 'synthetic CooperationDefection test channel' })
	}, secret);
	return {
		secret,
		event,
		worldConfig: {
			...PROTOTYPE_WORLD_CONFIG,
			channelId: event.id,
			creatorPubkey: getPublicKey(secret),
			authoritativeRelays: [...AUTHORITATIVE_RELAYS]
		}
	};
}

export function isDeathTraceEvent(event: { kind?: number; tags?: readonly (readonly string[])[] }): boolean {
	return event.kind === 42 && Boolean(event.tags?.some((tag) => tag[0] === 'l' && tag[1] === 'trace' && tag[2] === 'io.github.lokuyow.persona-bubble-field')) &&
		Boolean(event.tags?.some((tag) => tag[0] === 'l' && tag[1] === 'trace:death' && tag[2] === 'io.github.lokuyow.persona-bubble-field'));
}

export function traceRuntimeEvents(rootPosition: { x: number; y: number } = { x: 4, y: 2 }) {
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

export async function installVirtualKeyboardStub(page: Page): Promise<void> {
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

export async function installDelayedRelay(page: Page, options: {
	deferPrimaryEvents?: boolean;
	historyMessages?: readonly object[];
	primaryEvents?: Readonly<{ message: object; position: object }>;
	primaryTerminal?: 'eose' | 'closed';
	realtimeEvents?: readonly object[];
	deferRealtimeEvents?: boolean;
	realtimeTerminal?: 'eose' | 'closed' | 'timeout';
	realtimePublishOutcome?: 'accepted' | 'rejected' | 'echo' | 'no-response';
	rejectTracePublishes?: boolean;
	traceRoots?: readonly object[];
	traceReplies?: readonly object[];
	deferTraceRoots?: boolean;
	deferTraceReplies?: boolean;
	persistAcrossReload?: boolean;
	testWorldConfig?: PrototypeWorldConfig;
	hiddenSubscriptionLimit?: number;
} = {}): Promise<void> {
	const events = options.primaryEvents ?? testEvents();
	await page.addInitScript(({ authoritativeRelays, primaryEvents, historyMessages, realtimeEvents, deferPrimaryEvents, deferRealtimeEvents, primaryTerminal, realtimeTerminal, realtimePublishOutcome, rejectTracePublishes, traceRoots, traceReplies, deferTraceRoots, deferTraceReplies, persistAcrossReload, testWorldConfig, hiddenSubscriptionLimit }) => {
		const WORLD_STATE_KIND = 30079;
		const TAG_GAME_KIND = 37070;
		type Listener = (event?: { type: string; data?: string; code?: number; reason?: string }) => void;
		type PendingRequest = { socket: FakeWebSocket; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] };
		const authoritative = new Set<string>(authoritativeRelays);
		const pendingPrimary: PendingRequest[] = [];
		const pendingTraceRoots: PendingRequest[] = [];
		const pendingTraceReplies: PendingRequest[] = [];
		const pendingRealtime: PendingRequest[] = [];
		const activePrimary: PendingRequest[] = [];
		const activeTraceReplies: PendingRequest[] = [];
		const activeRealtime: PendingRequest[] = [];
		const closedTraceReplies: PendingRequest[] = [];
		const pendingPublishes: Array<{ socket: FakeWebSocket; event: Record<string, unknown> }> = [];
		const pendingRealtimePublishes: Array<{ socket: FakeWebSocket; event: Record<string, unknown>; outcome: 'accepted' | 'rejected' | 'echo' }> = [];
		const timelineHistory = (historyMessages ?? []) as Array<Record<string, unknown>>;
		const traceReplyHistory = traceReplies as Array<Record<string, unknown>>;
		const persistedKey = 'relay-startup-persisted-state';
		const persistedLatePositionKey = 'relay-startup-persisted-late-position';
		const persistedLatePosition = persistAcrossReload
			? JSON.parse(sessionStorage.getItem(persistedLatePositionKey) ?? 'null') as { relayUrl: string; event: Record<string, unknown> } | null
			: null;
		const previous = persistAcrossReload ? JSON.parse(sessionStorage.getItem(persistedKey) ?? '{"published":[],"closedSubscriptions":[]}') as {
			published: Array<Record<string, unknown>>;
			closedSubscriptions: Array<{ subId: string; url: string }>;
		} : { published: [], closedSubscriptions: [] };
		const queuedBootstrapEventsKey = 'relay-startup-queued-realtime-bootstrap-events';
		const queuedBootstrapEvents = JSON.parse(sessionStorage.getItem(queuedBootstrapEventsKey) ?? '[]') as Array<Record<string, unknown>>;
		sessionStorage.removeItem(queuedBootstrapEventsKey);
		const realtimeHistory = [
			...(realtimeEvents ?? []) as Array<Record<string, unknown>>,
			...queuedBootstrapEvents,
			...previous.published.filter((event) => event.kind === 7070 || event.kind === 37070)
		];
		const state = {
			traceDeliveries: [] as string[],
			requests: [] as Array<{ url: string; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>,
			persistedPrimaryDeliveries: [] as Array<{ relayUrl: string; eventId: string }>,
			published: [] as Array<Record<string, unknown>>,
			rejectedPositionPublishIds: [] as string[],
			closedSubscriptions: [] as Array<{ subId: string; url: string }>,
			previousPublished: previous.published,
			previousClosedSubscriptions: previous.closedSubscriptions,
			realtimeHistory,
			primaryEventsReleased: !deferPrimaryEvents,
			primaryReleased: false,
			primaryTerminal: primaryTerminal ?? 'eose',
			traceRootsReleased: !deferTraceRoots,
			traceRepliesReleased: !deferTraceReplies,
			realtimeEventsReleased: !deferRealtimeEvents,
			realtimeTerminal: realtimeTerminal ?? 'eose' as 'eose' | 'closed' | 'timeout',
			realtimePublishOutcome: realtimePublishOutcome ?? 'accepted' as 'accepted' | 'rejected' | 'echo' | 'no-response',
			deferRealtimePublishes: false,
			deferPositionPublishes: false,
			rejectMessagePublishes: false,
			rejectPositionPublishes: false,
			rejectTagGameStatePublishes: false,
			rejectTracePublishes: rejectTracePublishes ?? false,
			deferReplyPublishes: false,
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
			const labels = (event.tags as string[][] | undefined) ?? [];
			const isDeathTrace = event.kind === 42 && labels.some((tag) => tag[0] === 'l' && tag[1] === 'trace' && tag[2] === 'io.github.lokuyow.persona-bubble-field');
			const isNormalMessage = event.kind === 42 && labels.some((tag) => tag[0] === 'l' && tag[1] === 'chat' && tag[2] === 'io.github.lokuyow.persona-bubble-field') && !isDeathTrace;
			const reject = isNormalMessage && state.rejectMessagePublishes || event.kind === WORLD_STATE_KIND && state.rejectPositionPublishes || event.kind === TAG_GAME_KIND && state.rejectTagGameStatePublishes || isDeathTrace && state.rejectTracePublishes ||
				event.kind === 1111 && state.replyOutcome !== 'accepted';
			if (event.kind === WORLD_STATE_KIND && reject) state.rejectedPositionPublishIds.push(String(event.id));
			const notice = event.kind === 1111 && state.replyOutcome === 'duplicate' ? 'duplicate: already stored' : reject ? 'blocked: test rejection' : '';
			if (event.kind === 1111 && state.replyOutcome !== 'rejected' && !traceReplyHistory.some((known) => known.id === event.id)) traceReplyHistory.push(event);
			deliver(socket, ['OK', event.id, !reject, notice]);
		};
		const respondPrimaryEvent = (request: PendingRequest) => {
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(42))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.message]);
			}
			if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(WORLD_STATE_KIND))) {
				deliver(request.socket, ['EVENT', request.subId, primaryEvents.position]);
				if (persistedLatePosition?.relayUrl === new URL(request.socket.url).toString()) {
					state.persistedPrimaryDeliveries.push({ relayUrl: persistedLatePosition.relayUrl, eventId: String(persistedLatePosition.event.id) });
					deliver(request.socket, ['EVENT', request.subId, persistedLatePosition.event]);
				}
			}
			if (request.filters.some((filter) => filter.limit === 50)) {
				for (const event of timelineHistory) deliver(request.socket, ['EVENT', request.subId, event]);
			}
		};
		const recordInjectedPositionReservation = (rawEvent: object) => new Promise<void>((resolve, reject) => {
			const event = rawEvent as { pubkey?: string; created_at?: number; tags?: string[][] };
			const channelId = event.tags?.find((tag) => tag[0] === 'e')?.[1];
			const key = channelId && event.pubkey ? `${channelId}\u0000${event.pubkey}` : null;
			const slotTag = event.tags?.find((tag) => tag[0] === 'd')?.[1] ?? '';
			if (!key || !Number.isSafeInteger(event.created_at) || slotTag.endsWith(':exit')) { resolve(); return; }
			const database = indexedDB.open('persona-bubble-field-account', 8);
			database.onerror = () => reject(database.error);
			database.onsuccess = () => {
				const db = database.result;
				if (!db.objectStoreNames.contains('persona-bubble-field-world-write-journal')) { db.close(); resolve(); return; }
				const tx = db.transaction(['persona-bubble-field-player-state', 'persona-bubble-field-world-write-journal'], 'readwrite');
				const store = tx.objectStore('persona-bubble-field-world-write-journal');
				const playerStore = tx.objectStore('persona-bubble-field-player-state');
				const read = store.get(key);
				const playerRead = playerStore.get('player-lifecycle');
				read.onsuccess = () => {
					const record = read.result;
					if (record?.confirmedPosition?.id === (rawEvent as { id?: string }).id) return;
					const createdAt = event.created_at!;
					const slot = slotTag.endsWith(':1') ? 1 : 0;
					const sameSecond = record?.lastReservedSecond === createdAt;
					const available = !sameSecond || slot >= record.consumedSlots;
					if (record && (!available || record.lastReservedSecond !== null && record.lastReservedSecond > createdAt)) return;
					playerRead.onsuccess = () => {
						const activeRun = playerRead.result?.mode?.activeRun;
						if (!activeRun) return;
						store.put({ version: 1, channelId, pubkey: event.pubkey, runNumber: record?.runNumber ?? activeRun.runNumber,
							...(record ?? { nextToken: 0, exitSecond: null }), nextToken: (record?.nextToken ?? 0) + 1,
							lastReservedSecond: createdAt, consumedSlots: sameSecond ? Math.max(record.consumedSlots, slot + 1) : slot + 1,
							lastPositiveSecond: Math.max(record?.lastPositiveSecond ?? -1, createdAt), confirmedPosition: rawEvent
						}, key);
					};
				};
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onerror = () => { db.close(); reject(tx.error); };
				tx.onabort = () => { db.close(); reject(tx.error); };
			};
		});
		const respondPrimary = (request: PendingRequest) => {
			if (state.primaryEventsReleased) respondPrimaryEvent(request);
			if (state.primaryReleased) deliver(request.socket, ['EOSE', request.subId]);
		};
		const respondTraceRoots = (request: PendingRequest) => {
			for (const event of [...traceRoots, ...previous.published.filter((candidate) => candidate.kind === 42 && (candidate.tags as string[][]).some((tag) => tag[0] === 'l' && tag[1] === 'trace'))]) deliver(request.socket, ['EVENT', request.subId, event]);
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
			if (state.deferRealtimePublishes && state.realtimePublishOutcome !== 'no-response') {
				pendingRealtimePublishes.push({ socket, event, outcome: state.realtimePublishOutcome });
				return;
			}
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
					} else if (event.kind === 1111 && state.deferReplyPublishes || event.kind === WORLD_STATE_KIND && state.deferPositionPublishes) {
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
				if (authoritative.has(relayUrl)) {
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
				releasePublishes: (kind: number) => {
					if (kind === 1111) state.deferReplyPublishes = false;
					if (kind === WORLD_STATE_KIND) state.deferPositionPublishes = false;
					for (let index = pendingPublishes.length - 1; index >= 0; index--) {
						if (pendingPublishes[index].event.kind !== kind) continue;
						const pending = pendingPublishes.splice(index, 1)[0];
						respondPublish(pending.socket, pending.event);
					}
				},
				releasePrimaryEvents: () => {
					state.primaryEventsReleased = true;
					pendingPrimary.forEach(respondPrimaryEvent);
				},
				releasePrimary: () => {
					state.primaryReleased = true;
					pendingPrimary.splice(0).forEach((request) => deliver(request.socket,
						state.primaryTerminal === 'closed' ? ['CLOSED', request.subId, 'primary test closure'] : ['EOSE', request.subId]));
				},
				releasePrimaryRelays: (urls: string[]) => {
					for (let index = pendingPrimary.length - 1; index >= 0; index--) {
						if (!urls.includes(new URL(pendingPrimary[index].socket.url).toString())) continue;
						const [request] = pendingPrimary.splice(index, 1);
						deliver(request.socket, ['EOSE', request.subId]);
					}
				},
				releaseTraceRoots: () => {
					state.traceRootsReleased = true;
					pendingTraceRoots.splice(0).forEach(respondTraceRoots);
				},
					releaseTraceReplies: () => {
					state.traceRepliesReleased = true;
					pendingTraceReplies.splice(0).forEach(respondTraceReplies);
					},
					deferPositionPublishes: () => { state.deferPositionPublishes = true; },
					releaseRealtimeEvents: () => {
						state.realtimeEventsReleased = true;
						pendingRealtime.splice(0).forEach(respondRealtime);
					},
					deferRealtimeEvents: () => { state.realtimeEventsReleased = false; },
					setRealtimePublishOutcome: (outcome: 'accepted' | 'rejected' | 'echo' | 'no-response') => { state.realtimePublishOutcome = outcome; },
					deferRealtimePublishes: () => { state.deferRealtimePublishes = true; },
					releaseRealtimePublishes: () => {
						state.deferRealtimePublishes = false;
						for (const pending of pendingRealtimePublishes.splice(0)) {
							if (pending.outcome === 'rejected') deliver(pending.socket, ['OK', pending.event.id, false, 'blocked: realtime test rejection']);
							else if (pending.outcome === 'echo') {
								if (!realtimeHistory.some((known) => known.id === pending.event.id)) realtimeHistory.push(pending.event);
								for (const request of activeRealtime) deliverRealtimeLive(request, pending.event);
							} else deliver(pending.socket, ['OK', pending.event.id, true, '']);
						}
					},
					injectRealtimeEvent: (event: object) => {
						const raw = event as Record<string, unknown>;
						if (!realtimeHistory.some((known) => known.id === raw.id)) realtimeHistory.push(raw);
						for (const request of activeRealtime) deliverRealtimeLive(request, raw);
					},
					queueRealtimeBootstrapEvent: (event: object) => {
						const queued = JSON.parse(sessionStorage.getItem(queuedBootstrapEventsKey) ?? '[]') as Array<Record<string, unknown>>;
						const raw = event as Record<string, unknown>;
						if (!queued.some((known) => known.id === raw.id)) queued.push(raw);
						sessionStorage.setItem(queuedBootstrapEventsKey, JSON.stringify(queued));
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
				rejectTagGameStatePublishes: () => { state.rejectTagGameStatePublishes = true; },
				allowTagGameStatePublishes: () => { state.rejectTagGameStatePublishes = false; },
				rejectTracePublishes: () => { state.rejectTracePublishes = true; },
				allowTracePublishes: () => { state.rejectTracePublishes = false; },
				allowMessagePublishes: () => { state.rejectMessagePublishes = false; },
				injectPosition: async (event: object) => {
					await recordInjectedPositionReservation(event);
					for (const request of activePrimary) {
						if (request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(WORLD_STATE_KIND))) {
							deliver(request.socket, ['EVENT', request.subId, event]);
						}
					}
				},
				injectPositionToRelay: (event: object, relayUrl: string) => {
					sessionStorage.setItem(persistedLatePositionKey, JSON.stringify({ relayUrl: new URL(relayUrl).toString(), event }));
					for (const request of activePrimary) {
						if (new URL(request.socket.url).toString() === new URL(relayUrl).toString() &&
							request.filters.some((filter) => (filter.kinds as number[] | undefined)?.includes(WORLD_STATE_KIND))) {
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
		authoritativeRelays: AUTHORITATIVE_RELAYS,
		primaryEvents: events,
		historyMessages: options.historyMessages ?? [],
		deferPrimaryEvents: options.deferPrimaryEvents ?? false,
		primaryTerminal: options.primaryTerminal ?? 'eose',
		traceRoots: options.traceRoots ?? [],
		traceReplies: options.traceReplies ?? [],
		realtimeEvents: options.realtimeEvents ?? [],
		deferTraceRoots: options.deferTraceRoots ?? false,
		deferTraceReplies: options.deferTraceReplies ?? false,
		deferRealtimeEvents: options.deferRealtimeEvents ?? false,
		realtimeTerminal: options.realtimeTerminal ?? 'eose',
		realtimePublishOutcome: options.realtimePublishOutcome ?? 'accepted',
		rejectTracePublishes: options.rejectTracePublishes ?? false,
		persistAcrossReload: options.persistAcrossReload ?? false,
		testWorldConfig: options.testWorldConfig,
		hiddenSubscriptionLimit: options.hiddenSubscriptionLimit
	});
}

export function relayState(page: Page) {
	return page.evaluate(() => (window as typeof window & {
		__relayStartupTest: { state: { requests: Array<{ url: string; subId: string; filter: Record<string, unknown>; filters: Record<string, unknown>[] }>; persistedPrimaryDeliveries: Array<{ relayUrl: string; eventId: string }>; published: Array<{ id: string; kind: number; created_at: number; content: string; tags: string[][]; pubkey?: string }>; rejectedPositionPublishIds: string[]; previousPublished: Array<{ id: string; kind: number; created_at: number; content: string; tags: string[][]; pubkey?: string }>; closedSubscriptions: Array<{ subId: string; url: string }> }; releasePublishes(kind: number): void; deferPositionPublishes(): void; releasePrimaryEvents(): void; releasePrimary(): void; releaseTraceRoots(): void; releaseTraceReplies(): void; deferTraceReplies(): void; injectTraceReply(event: object): void; injectClosedTraceReply(event: object): void; activeTraceReplyCount(): number; rejectMessagePublishes(): void; allowMessagePublishes(): void; rejectPositionPublishes(): void; allowPositionPublishes(): void; rejectTracePublishes(): void; allowTracePublishes(): void; injectPosition(event: object): void; injectPositionToRelay(event: object, relayUrl: string): void; injectMessage(event: object): void };
	}).__relayStartupTest);
}

export function requestKind(request: { filter: Record<string, unknown> }): number | undefined {
	return Array.isArray(request.filter.kinds) && typeof request.filter.kinds[0] === 'number' ? request.filter.kinds[0] : undefined;
}

export async function relayFieldCellCenter(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
	return page.locator('.field-grid').evaluate((grid, position) => {
		const scene = document.querySelector<HTMLElement>('.field-scene');
		if (!scene) throw new Error('Expected the field scene to be rendered.');
		const rect = grid.getBoundingClientRect();
		const cellSize = Number.parseFloat(getComputedStyle(scene).getPropertyValue('--cell-size'));
		return { x: rect.left + (position.x + 0.5) * cellSize, y: rect.top + (position.y + 0.5) * cellSize };
	}, cell);
}

export async function selectRelayTraceCell(page: Page, position: string): Promise<void> {
	const cell = page.locator(`[data-cell-position="${position}"]`);
	const box = await cell.boundingBox();
	if (!box) throw new Error(`Expected visible logical cell ${position}.`);
	await cell.click({ position: { x: box.width - 2, y: box.height - 2 } });
}

export async function clickRelayLogicalCell(page: Page, cell: { x: number; y: number }): Promise<void> {
	const point = await relayFieldCellCenter(page, cell);
	await page.mouse.click(point.x, point.y);
}

export async function dragRelayJoystick(page: Page, delta: { x: number; y: number }, startCell = { x: 5, y: 4 }): Promise<void> {
	const start = await relayFieldCellCenter(page, startCell);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(start.x + delta.x, start.y + delta.y);
	await page.mouse.up();
}

export async function publishedMessages(page: Page) {
	return [...new Map(
		(await relayState(page)).state.published
			.filter((event) => event.kind === 42)
			.map((event) => [event.id, event])
	)].map(([, event]) => event);
}

export async function waitForPublishedMessageCount(page: Page, count: number): Promise<void> {
	await expect.poll(async () => (await publishedMessages(page)).length).toBe(count);
}

export async function openClockedReadyRelayWorld(page: Page): Promise<Locator> {
	await page.clock.install({ time: Date.now() });
	const editor = await openReadyRelayWorld(page);
	await pauseAtCurrentBrowserTime(page);
	return editor;
}

export async function pauseAtCurrentBrowserTime(page: Page): Promise<void> {
	const now = await page.evaluate(() => Date.now());
	// Freeze Date while pausing so a running browser clock cannot overtake the target.
	await page.clock.setFixedTime(now);
	await page.clock.pauseAt(now);
	await page.clock.setSystemTime(now);
}

export async function startSelectedRun(page: Page): Promise<void> {
	const start = page.getByRole('button', { name: '開始' });
	await expect(start).toBeEnabled();
	await start.click();
}

export async function setPendingRootPoints(page: Page, rootPoints: number): Promise<void> {
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

export async function installVisualAnimationRafMetrics(page: Page): Promise<void> {
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

export async function openReadyRelayWorld(page: Page, expectedParticipantCount = 2): Promise<Locator> {
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { deferPrimaryEvents: true });
	const secret = fixtureSecret(expectedParticipantCount === 1 ? 19 : 41);
	await seedRelayAccount(page, secret, getPublicKey(secret));
	await page.goto('/');
	await expect(page.locator('.action-dock')).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await expect(editor).toBeVisible();
	await expect.poll(async () => {
		const requests = (await relayState(page)).state.requests;
		return [42, WORLD_STATE_KIND].every((kind) => requests.some((request) =>
			AUTHORITATIVE_RELAYS.includes(request.url as typeof AUTHORITATIVE_RELAYS[number]) &&
			(request.filter.kinds as number[])[0] === kind
		));
	}).toBe(true);
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimaryEvents(): void } }).__relayStartupTest.releasePrimaryEvents());
	await page.evaluate(() => (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest.releasePrimary());
	await expect(page.locator('.participant')).toHaveCount(expectedParticipantCount);
	return editor;
}

export async function waitForRelayComposerReady(page: Page): Promise<Locator> {
	await expect(page.locator('.action-dock')).toBeVisible();
	const editor = page.locator('ehagaki-composer').getByRole('textbox', { name: '投稿エディター' });
	await expect(editor).toBeVisible();
	return editor;
}

export async function readActionDockControlOrder(page: Page): Promise<string[]> {
	return page.locator('.composer-controls > *').evaluateAll((elements) => elements
		.map((element) => {
			const rect = element.getBoundingClientRect();
			const className = ['profile-trigger', 'chatter-toggle', 'trace-unread-indicator', 'speech-type-toggle', 'suggestions-anchor']
				.find((name) => element.classList.contains(name));
			return className && rect.width > 0 && rect.height > 0 ? { className, left: rect.left, top: rect.top } : null;
		})
		.filter((item): item is { className: string; left: number; top: number } => item !== null)
		.sort((left, right) => left.top - right.top || left.left - right.left)
		.map((item) => item.className));
}

export async function openClearReadyWorld(page: Page): Promise<{ secret: Uint8Array; pubkey: string }> {
	const startTime = Date.now();
	const secret = fixtureSecret(19);
	const pubkey = getPublicKey(secret);
	await installHostOwnedStub(page);
	await installDelayedRelay(page, { primaryEvents: testEvents(startTime), persistAcrossReload: true });
	await seedRelayAccount(page, secret, pubkey, startTime + 7 * 24 * 60 * 60 * 1000, 100_000);
	await page.goto('/');
	await page.evaluate(() => {
		const relay = (window as typeof window & { __relayStartupTest: { releasePrimary(): void } }).__relayStartupTest;
		relay.releasePrimary();
	});
	await expect(page.locator(`.participant[data-self="true"][data-participant-id="${pubkey}"]`)).toBeVisible();
	return { secret, pubkey };
}

export async function installPromptApiStub(page: Page, availability: 'available' | 'unavailable' = 'available'): Promise<void> {
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

export async function seedRelayAccount(page: Page, secretKey: Uint8Array, pubkey: string, lifespanExpiresAtMs = Date.now() + 7 * 24 * 60 * 60 * 1000, points = 0, abilities = { inferenceEfficiency: 1, contextCapacity: 1, hallucinationSuppression: 1 }, rootPoints = 0, rootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 }): Promise<void> {
	const fixtureAccountIndex = fixtureAccountIndexForSecret(secretKey);
	await page.goto('/favicon.svg');
	await page.evaluate(async ({ accountPubkey, accountIndex, expiresAtMs, points, abilities, characterId, rootPoints, rootBuild }) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('persona-bubble-field-account', 8);
			request.onupgradeneeded = () => {
				for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
				request.result.createObjectStore('persona-bubble-field-root-secret');
				request.result.createObjectStore('persona-bubble-field-player-state');
				request.result.createObjectStore('persona-bubble-field-world-write-journal');
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
				rootBuild,
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
	}, { accountPubkey: pubkey, accountIndex: fixtureAccountIndex, expiresAtMs: lifespanExpiresAtMs, points, abilities, rootPoints, rootBuild, characterId: requireCharacterFromPubkey(pubkey).characterId });
}

export async function readRelayGameState(page: Page): Promise<{
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

export function realtimeInstanceIds(request: { filters: Array<Record<string, unknown>> }): string[] {
	return request.filters.flatMap((filter) => (filter['#i'] as string[] | undefined) ?? []);
}

export function isRealtimeRequest(request: { filter: Record<string, unknown> }): boolean {
	return (request.filter.kinds as number[] | undefined)?.includes(7070) ?? false;
}

export async function readRealtimePendingInstances(page: Page): Promise<string[]> {
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

export async function seedRealtimePendingInstance(page: Page, instanceId: string): Promise<void> {
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

export async function overwriteRelayGameState(page: Page, gameState: Record<string, unknown>): Promise<void> {
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

export async function overwriteRelayMendingBuild(page: Page, rootBuild: { inferenceAcceleration: number; contextCompression: number; hallucinationResistance: number }, abilities: { inferenceEfficiency: number; contextCapacity: number; hallucinationSuppression: number }): Promise<void> {
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

export async function seedUnavailablePersona(page: Page, kind: 'missing' | 'corrupt'): Promise<void> {
	await page.goto('/favicon.svg');
	await page.evaluate((stateKind) => new Promise<void>((resolve, reject) => {
		const request = indexedDB.open('persona-bubble-field-account', 8);
		request.onupgradeneeded = () => {
			for (const name of Array.from(request.result.objectStoreNames)) request.result.deleteObjectStore(name);
			request.result.createObjectStore('persona-bubble-field-root-secret');
			request.result.createObjectStore('persona-bubble-field-player-state');
			request.result.createObjectStore('persona-bubble-field-world-write-journal');
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

export async function installDeathTransitionFailure(page: Page): Promise<void> {
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

export async function armDeathTransitionFailure(page: Page): Promise<void> {
	await page.evaluate(() => (window as typeof window & {
		__personaLifecycleFailureTest: { arm(): void }
	}).__personaLifecycleFailureTest.arm());
}

export async function installDeathTransitionClockRollback(page: Page, rollbackAtMs: number): Promise<void> {
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

export async function armDeathTransitionClockRollback(page: Page): Promise<void> {
	await page.evaluate(() => (window as typeof window & {
		__personaLifecycleClockRollback: { arm(): void }
	}).__personaLifecycleClockRollback.arm());
}

export async function composerContextCalls(page: Page): Promise<Array<{
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

export async function chooseHorizontalMove(page: Page): Promise<{ key: 'ArrowLeft' | 'ArrowRight'; expected: string }> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	const occupied = new Set(await page.locator('.participant').evaluateAll((participants) => participants
		.filter((participant) => participant.getAttribute('data-self') !== 'true')
		.map((participant) => participant.getAttribute('data-position'))
		.filter((candidate): candidate is string => candidate !== null)
	));
	const move = [
		{ key: 'ArrowRight' as const, x: x + 1 },
		{ key: 'ArrowLeft' as const, x: x - 1 }
	].find((candidate) => candidate.x >= 0 && candidate.x < 16 &&
		!isBlockedFacilityCell({ x: candidate.x, y }) && !occupied.has(`${candidate.x},${y}`));
	if (!move) throw new Error('Expected an unoccupied horizontal Relay movement cell.');
	return { key: move.key, expected: `${move.x},${y}` };
}

export type AvailableMove = {
	key: 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'ArrowUp';
	expected: string;
};

const RELAY_FIELD = { columns: 16, rows: 8 } as const;

const CARDINAL_RELAY_MOVES = [
	{ key: 'ArrowUp', direction: 'up' },
	{ key: 'ArrowRight', direction: 'right' },
	{ key: 'ArrowDown', direction: 'down' },
	{ key: 'ArrowLeft', direction: 'left' }
] as const satisfies readonly Readonly<{ key: AvailableMove['key']; direction: Direction }>[];

export async function chooseAvailableRelayMove(page: Page): Promise<AvailableMove> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	const occupied = await page.locator('.participant').evaluateAll((participants) => participants
		.filter((participant) => participant.getAttribute('data-self') !== 'true')
		.map((participant) => participant.getAttribute('data-position'))
		.filter((candidate): candidate is string => candidate !== null)
		.map((candidate) => {
			const [x, y] = candidate.split(',').map(Number);
			return { x, y };
		})
	);
	for (const candidate of CARDINAL_RELAY_MOVES) {
		const next = moveOneCell({ x, y }, candidate.direction, RELAY_FIELD, occupied);
		if (next && !isBlockedFacilityCell(next)) return { key: candidate.key, expected: relayPositionKey(next) };
	}
	throw new Error(`Expected an available Relay movement cell from ${position}.`);
}

function relayPositionKey(position: GridPosition): string {
	return `${position.x},${position.y}`;
}

function orderedRelayMoves(current: GridPosition, target: GridPosition): readonly (typeof CARDINAL_RELAY_MOVES)[number][] {
	const preferred: Array<(typeof CARDINAL_RELAY_MOVES)[number]> = [];
	if (current.x < target.x) preferred.push(CARDINAL_RELAY_MOVES[1]);
	if (current.x > target.x) preferred.push(CARDINAL_RELAY_MOVES[3]);
	if (current.y < target.y) preferred.push(CARDINAL_RELAY_MOVES[2]);
	if (current.y > target.y) preferred.push(CARDINAL_RELAY_MOVES[0]);
	return [...preferred, ...CARDINAL_RELAY_MOVES.filter((candidate) => !preferred.includes(candidate))];
}

type RelayKeyboardMove = Readonly<{
	key: string;
	expected: string;
}>;

export async function chooseMoveToward(page: Page, target: { x: number; y: number }): Promise<AvailableMove> {
	const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
	if (!position) throw new Error('Expected the Relay self participant position.');
	const [x, y] = position.split(',').map(Number);
	const current = { x, y };
	if (current.x === target.x && current.y === target.y) {
		throw new Error('Expected the Relay participant to differ from the target.');
	}
	const occupied = await page.locator('.participant').evaluateAll((participants) => participants
		.filter((participant) => participant.getAttribute('data-self') !== 'true')
		.map((participant) => participant.getAttribute('data-position'))
		.filter((candidate): candidate is string => candidate !== null)
		.map((candidate) => {
			const [x, y] = candidate.split(',').map(Number);
			return { x, y };
		})
	);
	const visited = new Set([relayPositionKey(current)]);
	const queue: Array<{ position: GridPosition; firstMove: AvailableMove }> = [];
	for (const candidate of orderedRelayMoves(current, target)) {
		const next = moveOneCell(current, candidate.direction, RELAY_FIELD, occupied);
		if (!next || isBlockedFacilityCell(next) || visited.has(relayPositionKey(next))) continue;
		const firstMove = { key: candidate.key, expected: relayPositionKey(next) };
		if (next.x === target.x && next.y === target.y) return firstMove;
		visited.add(relayPositionKey(next));
		queue.push({ position: next, firstMove });
	}
	for (let index = 0; index < queue.length; index += 1) {
		const currentRoute = queue[index];
		for (const candidate of orderedRelayMoves(currentRoute.position, target)) {
			const next = moveOneCell(currentRoute.position, candidate.direction, RELAY_FIELD, occupied);
			if (!next || isBlockedFacilityCell(next) || visited.has(relayPositionKey(next))) continue;
			if (next.x === target.x && next.y === target.y) return currentRoute.firstMove;
			visited.add(relayPositionKey(next));
			queue.push({ position: next, firstMove: currentRoute.firstMove });
		}
	}
	throw new Error(`Expected a reachable Relay movement route from ${relayPositionKey(current)} to ${relayPositionKey(target)}.`);
}

export async function pressRelayKeyboardMovement(
	page: Page,
	move: RelayKeyboardMove,
	options: Readonly<{ advanceToNextPositionSecond?: boolean }> = {}
): Promise<void> {
	if (options.advanceToNextPositionSecond) await page.clock.runFor(1_001);
	const self = page.locator('.participant[data-self="true"]');
	const selfPubkey = await self.getAttribute('data-participant-id');
	if (!selfPubkey) throw new Error('Expected the Relay self participant public key.');
	const publishedSelfPositionIds = async () => new Set(
		(await relayState(page)).state.published
			.filter((event) => event.kind === WORLD_STATE_KIND && event.pubkey === selfPubkey)
			.map((event) => event.id)
	).size;
	const initialPublishedPositionCount = await publishedSelfPositionIds();
	await page.keyboard.press(move.key);
	await expect.poll(publishedSelfPositionIds).toBeGreaterThan(initialPublishedPositionCount);
	await expect(self).toHaveAttribute('data-position', move.expected);
}

export async function moveRelaySelfTo(page: Page, target: { x: number; y: number }): Promise<void> {
	for (let step = 0; step < RELAY_FIELD.columns * RELAY_FIELD.rows; step += 1) {
		const position = await page.locator('.participant[data-self="true"]').getAttribute('data-position');
		if (position === `${target.x},${target.y}`) return;
		const move = await chooseMoveToward(page, target);
		await page.clock.runFor(1_001);
		await pressRelayKeyboardMovement(page, move);
	}
	throw new Error(`Self did not reach ${target.x},${target.y}.`);
}

export function reverseMoveKey(key: AvailableMove['key']): AvailableMove['key'] {
	switch (key) {
		case 'ArrowDown': return 'ArrowUp';
		case 'ArrowLeft': return 'ArrowRight';
		case 'ArrowRight': return 'ArrowLeft';
		case 'ArrowUp': return 'ArrowDown';
	}
}
