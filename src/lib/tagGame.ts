import { finalizeEvent, verifyEvent, type Event, type EventTemplate, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';

export const TAG_GAME_KIND = 37070;
export const TAG_GAME_ACTION_KIND = 27070;
export const TAG_GAME_INDEX = 'tag-game';
export const TAG_GAME_GAME_MS = 180_000;
export const TAG_GAME_FINAL_WAIT_MS = 30_000;
export const TAG_GAME_LOBBY_RENEW_MS = 30_000;
export const TAG_GAME_LOBBY_MAX_AGE_SECONDS = 90;
export const TAG_GAME_RESPONSE_TIMEOUT_MS = 5_000;
export const TAG_GAME_NO_ACTIVITY_MS = 10_000;
export const TAG_GAME_MAX_POINTS = 4_500;
export const TAG_GAME_MAX_LIFESPAN_LOSS_MS = 324_000_000;
export const TAG_GAME_MAX_EFFECT_MS = 90_000;
export const TAG_GAME_BENEFIT_POINTS_PER_SECOND = 50;
export const TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND = 3_600_000;

export function tagGamePredictedRemainingLifespanMinutes(effectiveRemainingMs: number | null, unAppliedLossMs: number): number {
	return Math.max(0, Math.floor(((effectiveRemainingMs ?? 0) - unAppliedLossMs) / 60_000));
}

export type TagGameParticipant = Readonly<{
	pubkey: string;
	runNumber: number;
	registeredAt: number;
	consentProposalId?: string;
	consented?: boolean;
	status: 'registered' | 'active' | 'left' | 'temporarily-ineligible' | 'dead' | 'cleared';
	points: number;
	lifespanLossMs: number;
	benefitMs: number;
	calamityMs: number;
}>;

export type TagGameState = Readonly<{
	gameId: string;
	hostPubkey: string;
	phase: 'lobby' | 'proposed' | 'countdown' | 'running' | 'settling' | 'ended' | 'interrupted';
	revision: number;
	updatedAt: number;
	proposalId?: string;
	proposalDeadline?: number;
	startAt?: number;
	startedAt?: number;
	endsAt?: number;
	seed?: string;
	ownerPubkey?: string;
	effect?: 'benefit' | 'calamity';
	transferAt?: number;
	lastHolderResponseAtMs?: number;
	holderChallengeId?: string;
	holderChallengeStartedAtMs?: number;
	participant: readonly TagGameParticipant[];
	settledAtMs: number;
	finalizedAt?: number;
	endReason?: 'normal' | 'host-exit' | 'host-unavailable' | 'conflict' | 'too-few-participants';
}>;

export type TagGameEnvelope = Readonly<{ event: VerifiedEvent; state: TagGameState }>;
export type TagGameActionEnvelope = Readonly<{ event: VerifiedEvent; action: string; runNumber: number; payload: Readonly<Record<string, unknown>> }>;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const HEX_ID = /^[0-9a-f]{64}$/;
const TAG_GAME_ID = /^([0-9a-f]{64}):([0-9]{1,12}):([0-9a-f]{32,128})$/;

export function buildTagGameFilter(channelId: string, since: number): Filter {
	if (!HEX_ID.test(channelId) || !Number.isSafeInteger(since) || since < 0) throw new TypeError('Invalid tag-game filter scope.');
	return { kinds: [TAG_GAME_KIND], '#e': [channelId], '#t': [TAG_GAME_INDEX], since };
}

export function buildTagGameActionFilter(channelId: string, since: number): Filter {
	if (!HEX_ID.test(channelId) || !Number.isSafeInteger(since) || since < 0) throw new TypeError('Invalid tag-game action filter scope.');
	return { kinds: [TAG_GAME_ACTION_KIND], '#e': [channelId], since };
}

export function buildTagGameTemplate(state: TagGameState, channelId: string, createdAt: number): EventTemplate {
	if (!HEX_ID.test(channelId) || !Number.isSafeInteger(createdAt) || createdAt < 0 || !isValidTagGameState(state)) throw new TypeError('Invalid tag-game state.');
	return {
		kind: TAG_GAME_KIND,
		created_at: createdAt,
		tags: [['d', state.gameId], ['e', channelId], ['t', TAG_GAME_INDEX]],
		content: JSON.stringify(state)
	};
}

export function finalizeTagGameState(state: TagGameState, channelId: string, createdAt: number, secretKey: Uint8Array): VerifiedEvent {
	return finalizeEvent(buildTagGameTemplate(state, channelId, createdAt), secretKey);
}

export function parseTagGameEvent(event: Event, channelId: string): TagGameEnvelope | null {
	if (!verifyEvent(event) || event.kind !== TAG_GAME_KIND || !Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	const d = event.tags.filter((tag) => tag[0] === 'd');
	const e = event.tags.filter((tag) => tag[0] === 'e');
	const t = event.tags.filter((tag) => tag[0] === 't');
	if (d.length !== 1 || e.length !== 1 || e[0][1] !== channelId || t.length !== 1 || t[0][1] !== TAG_GAME_INDEX) return null;
	try {
		const state: unknown = JSON.parse(event.content);
		if (!isValidTagGameState(state) || state.gameId !== d[0][1] || state.hostPubkey !== event.pubkey) return null;
		return { event: event as VerifiedEvent, state };
	} catch { return null; }
}

export function buildTagGameActionTemplate(input: Readonly<{ channelId: string; gameId: string; action: string; runNumber: number; nonce: string; createdAt: number; payload?: Readonly<Record<string, unknown>> }>): EventTemplate {
	if (!HEX_ID.test(input.channelId) || !TAG_GAME_ID.test(input.gameId) || !Number.isSafeInteger(input.runNumber) || input.runNumber < 1 || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0 || !/^[a-z-]{1,32}$/.test(input.action) || !/^[0-9a-f]{32}$/.test(input.nonce)) throw new TypeError('Invalid tag-game action.');
	return { kind: TAG_GAME_ACTION_KIND, created_at: input.createdAt, tags: [['e', input.channelId], ['d', input.gameId], ['r', String(input.runNumber)], ['nonce', input.nonce]], content: JSON.stringify({ action: input.action, ...(input.payload ?? {}) }) };
}

export function parseTagGameActionEvent(event: Event, channelId: string): TagGameActionEnvelope | null {
	if (!verifyEvent(event) || event.kind !== TAG_GAME_ACTION_KIND || !Number.isSafeInteger(event.created_at) || event.created_at < 0) return null;
	const channels = event.tags.filter((tag) => tag[0] === 'e');
	const games = event.tags.filter((tag) => tag[0] === 'd');
	const runs = event.tags.filter((tag) => tag[0] === 'r');
	const nonces = event.tags.filter((tag) => tag[0] === 'nonce');
	if (channels.length !== 1 || channels[0][1] !== channelId || games.length !== 1 || !games[0][1] || runs.length !== 1 || nonces.length !== 1 || !/^[0-9a-f]{32}$/.test(nonces[0][1] ?? '')) return null;
	const runNumber = Number(runs[0][1]);
	if (!Number.isSafeInteger(runNumber) || runNumber < 1) return null;
	try {
		const payload: unknown = JSON.parse(event.content);
		if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof (payload as Record<string, unknown>).action !== 'string') return null;
		const action = (payload as Record<string, unknown>).action as string;
		if (!/^[a-z-]{1,32}$/.test(action)) return null;
		return { event: event as VerifiedEvent, action, runNumber, payload: payload as Record<string, unknown> };
	} catch { return null; }
}

export function createTagGameId(hostPubkey: string, createdAt: number, randomId: string): string {
	if (!HEX_PUBKEY.test(hostPubkey) || !Number.isSafeInteger(createdAt) || createdAt < 0 || !HEX_ID.test(randomId)) throw new TypeError('Invalid tag-game identity.');
	return `${hostPubkey}:${createdAt}:${randomId}`;
}

export function isValidTagGameState(value: unknown): value is TagGameState {
	if (!value || typeof value !== 'object') return false;
	const state = value as TagGameState;
	if (typeof state.gameId !== 'string' || state.gameId.length > 160 || !TAG_GAME_ID.test(state.gameId) || !state.gameId.startsWith(`${state.hostPubkey}:`) || !HEX_PUBKEY.test(state.hostPubkey) ||
		!['lobby', 'proposed', 'countdown', 'running', 'settling', 'ended', 'interrupted'].includes(state.phase) ||
		!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0 ||
		!Array.isArray(state.participant) || state.participant.length < 1 || state.participant.length > 8 ||
		!Number.isSafeInteger(state.settledAtMs) || state.settledAtMs < 0) return false;
	const participants = new Set<string>();
	for (const player of state.participant) {
		if (!HEX_PUBKEY.test(player.pubkey) || participants.has(player.pubkey) || !Number.isSafeInteger(player.runNumber) || player.runNumber < 1 ||
			!Number.isSafeInteger(player.registeredAt) || player.registeredAt < 0 ||
			!['registered', 'active', 'left', 'temporarily-ineligible', 'dead', 'cleared'].includes(player.status) ||
			!Number.isSafeInteger(player.points) || player.points < 0 || player.points > TAG_GAME_MAX_POINTS ||
			!Number.isSafeInteger(player.lifespanLossMs) || player.lifespanLossMs < 0 || player.lifespanLossMs > TAG_GAME_MAX_LIFESPAN_LOSS_MS ||
			!Number.isSafeInteger(player.benefitMs) || player.benefitMs < 0 || player.benefitMs > TAG_GAME_MAX_EFFECT_MS ||
			!Number.isSafeInteger(player.calamityMs) || player.calamityMs < 0 || player.calamityMs > TAG_GAME_MAX_EFFECT_MS ||
			player.benefitMs + player.calamityMs > TAG_GAME_GAME_MS) return false;
		participants.add(player.pubkey);
	}
	if (state.phase === 'running' && (!Number.isSafeInteger(state.startedAt) || !Number.isSafeInteger(state.endsAt) || !state.seed || !state.ownerPubkey || !state.effect)) return false;
	if (state.finalizedAt !== undefined && (!Number.isSafeInteger(state.finalizedAt) || state.finalizedAt < 0)) return false;
	if (state.lastHolderResponseAtMs !== undefined && (!Number.isSafeInteger(state.lastHolderResponseAtMs) || state.lastHolderResponseAtMs < 0)) return false;
	if (state.holderChallengeStartedAtMs !== undefined && (!Number.isSafeInteger(state.holderChallengeStartedAtMs) || state.holderChallengeStartedAtMs < 0)) return false;
	return true;
}

export function isFreshTagGameLobby(state: TagGameState, nowSeconds: number): boolean {
	return state.phase === 'lobby' && nowSeconds - state.updatedAt <= TAG_GAME_LOBBY_MAX_AGE_SECONDS && nowSeconds >= state.updatedAt - 5;
}

export function tagGameHolderResponseState(input: Readonly<{ nowMs: number; normalActivityAtMs: number | null; acknowledgedAtMs: number | null; challengeStartedAtMs: number | null }>): 'active' | 'challenge' | 'unresponsive' {
	if (![input.nowMs, ...(input.normalActivityAtMs === null ? [] : [input.normalActivityAtMs]), ...(input.acknowledgedAtMs === null ? [] : [input.acknowledgedAtMs]), ...(input.challengeStartedAtMs === null ? [] : [input.challengeStartedAtMs])].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid tag-game activity timestamp.');
	const lastActive = Math.max(input.normalActivityAtMs ?? 0, input.acknowledgedAtMs ?? 0);
	if (input.challengeStartedAtMs !== null && lastActive >= input.challengeStartedAtMs) return 'active';
	if (input.challengeStartedAtMs !== null && input.nowMs - input.challengeStartedAtMs >= TAG_GAME_RESPONSE_TIMEOUT_MS) return 'unresponsive';
	return input.nowMs - lastActive >= TAG_GAME_NO_ACTIVITY_MS ? 'challenge' : 'active';
}

export function createTagGameSchedule(seed: string): readonly Readonly<{ durationMs: number; effect: 'benefit' | 'calamity' }>[] {
	if (!seed || seed.length > 256) throw new TypeError('Invalid tag-game seed.');
	let hash = 2166136261;
	for (const char of seed) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
	let random = hash >>> 0;
	const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 0x1_0000_0000; };
	const composeNinety = (): number[] => {
		const values: number[] = [];
		let remaining = 90;
		for (let index = 0; index < 3; index++) {
			const left = 3 - index;
			const minimum = Math.max(10, remaining - 40 * left);
			const maximum = Math.min(40, remaining - 10 * left);
			const seconds = minimum + Math.floor(next() * (maximum - minimum + 1));
			values.push(seconds);
			remaining -= seconds;
		}
		values.push(remaining);
		return values;
	};
	const benefits = composeNinety();
	const calamities = composeNinety();
	const startWithBenefit = next() < 0.5;
	return Array.from({ length: 8 }, (_, index) => ({
		durationMs: (index % 2 === 0
			? (startWithBenefit ? benefits[index / 2] : calamities[index / 2])
			: (startWithBenefit ? calamities[(index - 1) / 2] : benefits[(index - 1) / 2])) * 1000,
		effect: (index % 2 === 0 ? startWithBenefit : !startWithBenefit) ? 'benefit' : 'calamity'
	}));
}

export function cumulativeTagGameSettlement(state: TagGameState): Readonly<{ points: number; lifespanLossMs: number }> | null {
	if (!isValidTagGameState(state)) return null;
	if (state.participant.some((player) => player.points > TAG_GAME_MAX_POINTS || player.lifespanLossMs > TAG_GAME_MAX_LIFESPAN_LOSS_MS)) return null;
	const points = state.participant.reduce((sum, player) => sum + player.points, 0);
	const lifespanLossMs = state.participant.reduce((sum, player) => sum + player.lifespanLossMs, 0);
	return { points, lifespanLossMs };
}
