import { sha256 } from '@noble/hashes/sha2.js';
import type { Event } from 'nostr-tools/pure';
import type { FieldSize, GridPosition } from './geometry';
import { FIXED_FIELD_FACILITIES } from './fieldFacilities';
import {
	buildRealtimeEventTemplate,
	parseRealtimeAction,
	protocolKeyFor,
	type RealtimeEventDefinition,
	type RealtimeEventRegistry,
	type RealtimeFieldTargetInput,
	type RealtimeEventTemplate,
	type RealtimeControlEnvelope
} from './realtimeEvents';

export const RIFT_EVENT_TYPE = 'rift';
export const RIFT_PROTOCOL_VERSION = 1;
export const RIFT_PROTOCOL_KEY = protocolKeyFor(RIFT_EVENT_TYPE, RIFT_PROTOCOL_VERSION);
export const RIFT_MIN_PARTICIPANTS = 3;
export const RIFT_MAX_PARTICIPANTS = 6;
export const RIFT_ROUND_COUNT = 3;
export const RIFT_CONSULTATION_MS = 60_000;
export const RIFT_SELECTION_MS = 30_000;
export const RIFT_RESULT_MS = 20_000;
export const RIFT_ROUND_MS = RIFT_CONSULTATION_MS + RIFT_SELECTION_MS + RIFT_RESULT_MS;
export const RIFT_REVEAL_GRACE_MS = 5_000;
export const RIFT_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS = 15 * 60;
const RIFT_MANUAL_INSTANCE_PREFIX = 'rift:1:manual:';
const RIFT_MANUAL_ID = /^rift:1:manual:(\d+):([0-9a-f]{32})$/;

export type RiftChoice = 'maintain' | 'escape';

export type RiftAction =
	| Readonly<{ action: 'join'; holeId: string }>
	| Readonly<{ action: 'commit'; holeId: string; round: 1 | 2 | 3; commitment: string }>
	| Readonly<{ action: 'reveal'; holeId: string; round: 1 | 2 | 3; commitId: string; choice: RiftChoice; nonce: string }>;

export type RiftHole = Readonly<{ id: string; index: number; position: GridPosition }>;

export type RiftSchedule = Readonly<{
	dateKey: string;
	instanceId: string;
	warningAtMs: number;
	registrationAtMs: number;
	gameAtMs: number;
	endedAtMs: number;
	phase: 'dormant' | 'warning' | 'registration' | 'game' | 'ended';
}>;

export type RiftRoundSchedule = Readonly<{
	round: 1 | 2 | 3;
	consultationAtMs: number;
	selectionAtMs: number;
	resultAtMs: number;
	revealCutoffAtMs: number;
	endedAtMs: number;
}>;

export type RiftActionEvent = Readonly<{
	id: string;
	pubkey: string;
	createdAt: number;
	action: RiftAction;
}>;

export type RiftOutcome = Readonly<{
	id: string;
	pubkey: string;
	kind: 'points' | 'death';
	points?: number;
	instanceId: string;
	holeId: string;
	round: 1 | 2 | 3;
}>;

export type RiftRoundResult = Readonly<{
	holeId: string;
	round: 1 | 2 | 3;
	kind: 'all-maintain' | 'mixed-success' | 'threshold-failure' | 'insufficient';
	validParticipantPubkeys: readonly string[];
	maintainPubkeys: readonly string[];
	escapePubkeys: readonly string[];
	requiredMaintain: number | null;
	outcomes: readonly RiftOutcome[];
}>;

export type RiftSessionState = Readonly<{
	instanceId: string;
	field: FieldSize;
	holes: readonly RiftHole[];
	actions: readonly RiftActionEvent[];
	participantSnapshot: Readonly<Record<string, readonly string[]>> | null;
	results: readonly RiftRoundResult[];
	closedHoleIds: readonly string[];
}>;

export const RIFT_EVENT_DEFINITION: RealtimeEventDefinition<RiftAction> = {
	eventType: RIFT_EVENT_TYPE,
	protocolVersion: RIFT_PROTOCOL_VERSION,
	protocolKey: RIFT_PROTOCOL_KEY,
	parseAction: parseRiftAction,
	schedule: getRiftSchedule,
	fieldTargets: (input: RealtimeFieldTargetInput) => deriveRiftHolePositions(input.instanceId, input.field, input.participantDemand)
};

/** The compile-time registry. Removing a definition from the enabled list disables its runtime. */
export const REALTIME_EVENT_REGISTRY: readonly RealtimeEventDefinition[] = [RIFT_EVENT_DEFINITION];
export const ENABLED_REALTIME_EVENT_TYPES: readonly string[] = [RIFT_EVENT_TYPE];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function validString(value: unknown, maximum = 160): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maximum && /^[\x20-\x7e]+$/.test(value);
}

function validHex(value: unknown, bytes: number): value is string {
	return typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
}

function validRound(value: unknown): value is 1 | 2 | 3 {
	return value === 1 || value === 2 || value === 3;
}

function validHoleId(value: unknown): value is string {
	return validString(value) && /:hole:\d+$/.test(value);
}

function validChoice(value: unknown): value is RiftChoice {
	return value === 'maintain' || value === 'escape';
}

export function parseRiftAction(value: unknown): RiftAction | null {
	if (!isRecord(value) || typeof value.action !== 'string') return null;
	if (value.action === 'join') {
		return hasOnlyKeys(value, ['action', 'holeId']) && validHoleId(value.holeId)
			? { action: 'join', holeId: value.holeId }
			: null;
	}
	if (value.action === 'commit') {
		// A commit never carries either secret field. This is an intentional
		// protocol guard against accidentally publishing the choice in plaintext.
		return hasOnlyKeys(value, ['action', 'holeId', 'round', 'commitment']) && validHoleId(value.holeId) &&
			validRound(value.round) && validHex(value.commitment, 32)
			? { action: 'commit', holeId: value.holeId, round: value.round, commitment: value.commitment }
			: null;
	}
	if (value.action === 'reveal') {
		return hasOnlyKeys(value, ['action', 'holeId', 'round', 'commitId', 'choice', 'nonce']) && validHoleId(value.holeId) &&
			validRound(value.round) && validHex(value.commitId, 32) && validChoice(value.choice) && validHex(value.nonce, 32)
			? { action: 'reveal', holeId: value.holeId, round: value.round, commitId: value.commitId, choice: value.choice, nonce: value.nonce }
			: null;
	}
	return null;
}

export function enabledRealtimeEventDefinitions(
	enabledTypes: readonly string[] = ENABLED_REALTIME_EVENT_TYPES,
	registry: RealtimeEventRegistry = REALTIME_EVENT_REGISTRY
): readonly RealtimeEventDefinition[] {
	return registry.filter((definition) => enabledTypes.includes(definition.eventType));
}

export function buildRiftActionTemplate(input: Readonly<{
	channelId: string;
	relayHint: string;
	instanceId: string;
	action: RiftAction;
	createdAt: number;
}>): RealtimeEventTemplate {
	return buildRealtimeEventTemplate({
		channelId: input.channelId,
		relayHint: input.relayHint,
		eventType: RIFT_EVENT_TYPE,
		protocolVersion: RIFT_PROTOCOL_VERSION,
		instanceId: input.instanceId,
		payload: input.action,
		createdAt: input.createdAt
	});
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function textBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

/** Deterministic commitment binding every public context field and both secrets. */
export function computeRiftCommitment(input: Readonly<{
	instanceId: string;
	holeId: string;
	round: 1 | 2 | 3;
	authorPubkey: string;
	choice: RiftChoice;
	nonce: string;
}>): string {
	return bytesToHex(sha256(textBytes(JSON.stringify([
		RIFT_PROTOCOL_KEY,
		input.instanceId,
		input.holeId,
		input.round,
		input.authorPubkey,
		input.choice,
		input.nonce
	]))));
}

export function createRiftNonce(): string {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) throw new Error('Web Crypto is unavailable for Rift selection.');
	const bytes = new Uint8Array(32);
	cryptoApi.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export function buildRiftCommitAction(input: Readonly<{
	instanceId: string;
	holeId: string;
	round: 1 | 2 | 3;
	authorPubkey: string;
	choice: RiftChoice;
	nonce: string;
}>): Extract<RiftAction, { action: 'commit' }> {
	return { action: 'commit', holeId: input.holeId, round: input.round, commitment: computeRiftCommitment(input) };
}

export function buildRiftRevealAction(input: Readonly<{
	holeId: string;
	round: 1 | 2 | 3;
	commitId: string;
	choice: RiftChoice;
	nonce: string;
}>): Extract<RiftAction, { action: 'reveal' }> {
	return { action: 'reveal', ...input };
}

export function validateRiftReveal(input: Readonly<{
	instanceId: string;
	authorPubkey: string;
	commitId: string;
	commitment: string;
	holeId: string;
	round: 1 | 2 | 3;
	choice: RiftChoice;
	nonce: string;
}>): boolean {
	return input.commitment === computeRiftCommitment(input);
}

function jstDateParts(nowMs: number): Readonly<{ year: number; month: number; day: number; dateKey: string }> {
	if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite.');
	const date = new Date(nowMs + RIFT_JST_OFFSET_MS);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	return { year, month, day, dateKey: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}` };
}

function timeAtJst(dateKey: string, hour: number, minute: number, second = 0): number {
	const [year, month, day] = dateKey.split('-').map(Number);
	return Date.UTC(year, month - 1, day, hour, minute, second) - RIFT_JST_OFFSET_MS;
}

export function dailyRiftInstanceId(dateKey: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError('Rift date key must be YYYY-MM-DD.');
	return `${RIFT_PROTOCOL_NAMESPACE_INSTANCE_PREFIX}:${dateKey}`;
}

export function buildManualRiftInstanceId(createdAt: number, nonce: string): string {
	if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Manual Rift created_at must be a non-negative Unix timestamp.');
	if (!/^[0-9a-f]{32}$/.test(nonce)) throw new TypeError('Manual Rift nonce must be lowercase 128-bit hex.');
	return `${RIFT_MANUAL_INSTANCE_PREFIX}${createdAt}:${nonce}`;
}

export function parseManualRiftInstanceId(instanceId: string): Readonly<{ createdAt: number; nonce: string }> | null {
	const match = RIFT_MANUAL_ID.exec(instanceId);
	if (!match) return null;
	const createdAt = Number(match[1]);
	return Number.isSafeInteger(createdAt) ? { createdAt, nonce: match[2] } : null;
}

function nextRiftDateKey(dateKey: string): string {
	const date = new Date(`${dateKey}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

function manualRiftInterval(registrationAtMs: number): Readonly<{ registrationAtMs: number; endedAtMs: number }> | null {
	if (!Number.isFinite(registrationAtMs)) return null;
	return { registrationAtMs, endedAtMs: registrationAtMs + 5 * 60 * 1000 + RIFT_ROUND_COUNT * RIFT_ROUND_MS };
}

export function riftScheduleIntervalsOverlap(
	first: Readonly<{ warningAtMs: number; endedAtMs: number }>,
	second: Readonly<{ registrationAtMs: number; endedAtMs: number }>
): boolean {
	return first.warningAtMs < second.endedAtMs && second.registrationAtMs < first.endedAtMs;
}

/** Checks whether a Rift beginning at the supplied registration time conflicts with scheduled Rift windows. */
export function isManualRiftRegistrationScheduleEligible(registrationAtMs: number): boolean {
	const manual = manualRiftInterval(registrationAtMs);
	if (!manual) return false;
	const scheduled = getRiftSchedule(registrationAtMs);
	const nextScheduled = getRiftScheduleForDate(nextRiftDateKey(scheduled.dateKey), registrationAtMs);
	return !riftScheduleIntervalsOverlap(scheduled, manual) && !riftScheduleIntervalsOverlap(nextScheduled, manual);
}

/** Pure schedule/protocol eligibility shared by browser control handling and operator tooling. */
export function isManualRiftInstanceScheduleEligible(instanceId: string, nowMs: number): boolean {
	const manual = parseManualRiftInstanceId(instanceId);
	if (!manual) return false;
	const manualSchedule = getRiftScheduleForInstance(instanceId, nowMs);
	if (!manualSchedule || !['registration', 'game'].includes(manualSchedule.phase)) return false;
	return isManualRiftRegistrationScheduleEligible(manualSchedule.registrationAtMs);
}

export function isManualRiftControlScheduleEligible(control: RealtimeControlEnvelope, nowMs: number): boolean {
	if (control.payload.targetProtocolKey !== RIFT_PROTOCOL_KEY) return false;
	const manual = parseManualRiftInstanceId(control.instanceId);
	if (!manual || manual.createdAt !== control.event.created_at || control.event.created_at > Math.floor(nowMs / 1000)) return false;
	return isManualRiftInstanceScheduleEligible(control.instanceId, nowMs);
}

export function compareManualRiftControls(first: RealtimeControlEnvelope, second: RealtimeControlEnvelope): number {
	return first.event.created_at - second.event.created_at || first.event.id.localeCompare(second.event.id);
}

export function selectCanonicalManualRiftControl(
	controls: readonly RealtimeControlEnvelope[],
	nowMs: number
): RealtimeControlEnvelope | null {
	return [...controls]
		.filter((control) => isManualRiftControlScheduleEligible(control, nowMs))
		.sort(compareManualRiftControls)[0] ?? null;
}

const RIFT_PROTOCOL_NAMESPACE_INSTANCE_PREFIX = `${RIFT_PROTOCOL_KEY}:instance`;

export function getRiftSchedule(nowMs: number): RiftSchedule {
	const { dateKey } = jstDateParts(nowMs);
	return getRiftScheduleForDate(dateKey, nowMs);
}

export function getRiftScheduleForDate(dateKey: string, nowMs: number): RiftSchedule {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError('Rift date key must be YYYY-MM-DD.');
	const warningAtMs = timeAtJst(dateKey, 20, 45);
	const registrationAtMs = timeAtJst(dateKey, 20, 55);
	const gameAtMs = timeAtJst(dateKey, 21, 0);
	const endedAtMs = gameAtMs + RIFT_ROUND_COUNT * RIFT_ROUND_MS;
	const phase: RiftSchedule['phase'] = nowMs < warningAtMs ? 'dormant'
		: nowMs < registrationAtMs ? 'warning'
			: nowMs < gameAtMs ? 'registration'
				: nowMs < endedAtMs ? 'game' : 'ended';
	return { dateKey, instanceId: dailyRiftInstanceId(dateKey), warningAtMs, registrationAtMs, gameAtMs, endedAtMs, phase };
}

export function getRiftScheduleForInstance(instanceId: string, nowMs: number): RiftSchedule | null {
	const manual = parseManualRiftInstanceId(instanceId);
	if (manual) {
		const registrationAtMs = manual.createdAt * 1000;
		const gameAtMs = registrationAtMs + 5 * 60 * 1000;
		const warningAtMs = registrationAtMs;
		const endedAtMs = gameAtMs + RIFT_ROUND_COUNT * RIFT_ROUND_MS;
		const phase: RiftSchedule['phase'] = nowMs < registrationAtMs ? 'dormant'
			: nowMs < gameAtMs ? 'registration'
			: nowMs < endedAtMs ? 'game' : 'ended';
		return { dateKey: `manual-${manual.createdAt}`, instanceId, warningAtMs, registrationAtMs, gameAtMs, endedAtMs, phase };
	}
	const prefix = `${RIFT_PROTOCOL_NAMESPACE_INSTANCE_PREFIX}:`;
	if (!instanceId.startsWith(prefix)) return null;
	const dateKey = instanceId.slice(prefix.length);
	return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? getRiftScheduleForDate(dateKey, nowMs) : null;
}

export function getRiftRoundSchedule(scheduleOrInstance: Pick<RiftSchedule, 'gameAtMs'>, round: 1 | 2 | 3): RiftRoundSchedule {
	if (!validRound(round)) throw new TypeError('Rift round must be 1, 2, or 3.');
	const consultationAtMs = scheduleOrInstance.gameAtMs + (round - 1) * RIFT_ROUND_MS;
	const selectionAtMs = consultationAtMs + RIFT_CONSULTATION_MS;
	const resultAtMs = selectionAtMs + RIFT_SELECTION_MS;
	return { round, consultationAtMs, selectionAtMs, resultAtMs, revealCutoffAtMs: resultAtMs + RIFT_REVEAL_GRACE_MS, endedAtMs: consultationAtMs + RIFT_ROUND_MS };
}

function hash32(value: string): number {
	let hash = 2166136261;
	for (const byte of textBytes(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function sameCell(first: GridPosition, second: GridPosition): boolean {
	return first.x === second.x && first.y === second.y;
}

export function deriveRiftHolePositions(
	instanceId: string,
	field: Pick<FieldSize, 'columns' | 'rows'>,
	participantDemand = 0
): readonly RiftHole[] {
	if (!Number.isSafeInteger(field.columns) || !Number.isSafeInteger(field.rows) || field.columns < 1 || field.rows < 1) throw new TypeError('Invalid Rift field size.');
	if (!Number.isSafeInteger(participantDemand) || participantDemand < 0) throw new TypeError('Invalid Rift participant demand.');
	const count = Math.max(1, Math.ceil(Math.max(0, participantDemand) / RIFT_MAX_PARTICIPANTS));
	const blocked = FIXED_FIELD_FACILITIES.map((facility) => facility.position);
	const cells: GridPosition[] = [];
	const total = field.columns * field.rows;
	const start = hash32(`${instanceId}:holes`) % total;
	for (let offset = 0; offset < total * 2 && cells.length < count; offset += 1) {
		const index = (start + offset) % total;
		const candidate = { x: index % field.columns, y: Math.floor(index / field.columns) };
		if (blocked.some((cell) => sameCell(cell, candidate)) || cells.some((cell) => sameCell(cell, candidate))) continue;
		cells.push(candidate);
	}
	if (cells.length === 0) throw new Error('No available field cell for Rift hole.');
	return cells.map((position, index) => ({ id: `${instanceId}:hole:${index}`, index, position }));
}

function compareActionEvents(first: RiftActionEvent, second: RiftActionEvent): number {
	return first.createdAt - second.createdAt || first.id.localeCompare(second.id);
}

function latestPerPubkey(events: readonly RiftActionEvent[], predicate: (event: RiftActionEvent) => boolean): readonly RiftActionEvent[] {
	const latest = new Map<string, RiftActionEvent>();
	for (const event of events) {
		if (!predicate(event)) continue;
		const previous = latest.get(event.pubkey);
		if (!previous || compareActionEvents(previous, event) < 0) latest.set(event.pubkey, event);
	}
	return [...latest.values()].sort((first, second) => first.pubkey.localeCompare(second.pubkey));
}

export function createRiftSession(input: Readonly<{ instanceId: string; field: FieldSize }>): RiftSessionState {
	return { instanceId: input.instanceId, field: input.field, holes: deriveRiftHolePositions(input.instanceId, input.field), actions: [], participantSnapshot: null, results: [], closedHoleIds: [] };
}

export function applyRiftAction(state: RiftSessionState, event: RiftActionEvent): RiftSessionState {
	if (!validString(event.id, 160) || !validHex(event.pubkey, 32) || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0) return state;
	if (state.actions.some((candidate) => candidate.id === event.id)) return state;
	if (!parseRiftAction(event.action)) return state;
	const actions = [...state.actions, event];
	const demand = new Set(actions.filter((candidate) => candidate.action.action === 'join').map((candidate) => candidate.pubkey)).size;
	const holes = deriveRiftHolePositions(state.instanceId, state.field, demand);
	return { ...state, actions, holes };
}

function joinSnapshot(state: RiftSessionState, schedule: RiftSchedule): Readonly<Record<string, readonly string[]>> {
	const joins = latestPerPubkey(state.actions, (event) => event.action.action === 'join' && event.createdAt >= schedule.registrationAtMs && event.createdAt < schedule.gameAtMs)
		.filter((event) => event.action.action === 'join' && state.holes.some((hole) => hole.id === event.action.holeId));
	const grouped = new Map<string, string[]>();
	const acceptedByHole = new Map<string, RiftActionEvent[]>();
	for (const event of joins) {
		if (event.action.action !== 'join') continue;
		const current = acceptedByHole.get(event.action.holeId) ?? [];
		current.push(event);
		acceptedByHole.set(event.action.holeId, current);
	}
	for (const [holeId, events] of acceptedByHole) {
		const participants = events.sort((first, second) => first.id.localeCompare(second.id) || first.pubkey.localeCompare(second.pubkey)).slice(0, RIFT_MAX_PARTICIPANTS).map((event) => event.pubkey);
		grouped.set(holeId, [...new Set(participants)].sort());
	}
	return Object.fromEntries(grouped);
}

export function getRiftParticipantHole(state: RiftSessionState, schedule: RiftSchedule, pubkey: string): string | null {
	const snapshot = state.participantSnapshot ?? joinSnapshot(state, schedule);
	return Object.entries(snapshot).find(([, participants]) => participants.includes(pubkey))?.[0] ?? null;
}

export function snapshotRiftParticipants(state: RiftSessionState, schedule: RiftSchedule): RiftSessionState {
	if (schedule.phase !== 'game' && schedule.phase !== 'ended') return state;
	return state.participantSnapshot ? state : { ...state, participantSnapshot: joinSnapshot(state, schedule) };
}

/**
 * Settlement recovery is complete only after the instance can no longer
 * produce an outcome for this participant. This intentionally knows nothing
 * about the core ledger; the event definition owns its terminal projection.
 */
export function isRiftSettlementComplete(state: RiftSessionState, schedule: RiftSchedule, pubkey: string): boolean {
	if (schedule.phase !== 'ended') return false;
	const snapshot = snapshotRiftParticipants(state, schedule).participantSnapshot;
	if (!snapshot) return false;
	const holeId = Object.entries(snapshot).find(([, participants]) => participants.includes(pubkey))?.[0];
	if (!holeId) return true;
	if (state.closedHoleIds.includes(holeId)) return true;
	return state.results.some((result) => result.holeId === holeId && result.round === RIFT_ROUND_COUNT);
}

function resultFor(state: RiftSessionState, schedule: RiftSchedule, holeId: string, round: 1 | 2 | 3): RiftRoundResult {
	const participants = state.participantSnapshot?.[holeId] ?? [];
	const roundSchedule = getRiftRoundSchedule(schedule, round);
	const eligible = new Set(participants);
	const commits = latestPerPubkey(state.actions, (event) => event.action.action === 'commit' && event.action.holeId === holeId && event.action.round === round &&
		event.createdAt >= roundSchedule.selectionAtMs && event.createdAt < roundSchedule.resultAtMs && eligible.has(event.pubkey));
	const reveals = state.actions.filter((event) => event.action.action === 'reveal' && event.action.holeId === holeId && event.action.round === round &&
		event.createdAt >= roundSchedule.resultAtMs && event.createdAt <= roundSchedule.revealCutoffAtMs && eligible.has(event.pubkey));
	const valid = new Map<string, RiftChoice>();
	for (const commit of commits) {
		if (commit.action.action !== 'commit') continue;
		const reveal = reveals.filter((candidate) => candidate.pubkey === commit.pubkey && candidate.action.action === 'reveal' && candidate.action.commitId === commit.id)
			.sort(compareActionEvents)[0];
		if (!reveal || reveal.action.action !== 'reveal') continue;
		if (validateRiftReveal({ instanceId: state.instanceId, authorPubkey: commit.pubkey, commitId: commit.id, commitment: commit.action.commitment,
			holeId, round, choice: reveal.action.choice, nonce: reveal.action.nonce })) valid.set(commit.pubkey, reveal.action.choice);
	}
	const validParticipantPubkeys = [...valid.keys()].sort();
	const maintainPubkeys = validParticipantPubkeys.filter((pubkey) => valid.get(pubkey) === 'maintain');
	const escapePubkeys = validParticipantPubkeys.filter((pubkey) => valid.get(pubkey) === 'escape');
	if (validParticipantPubkeys.length < RIFT_MIN_PARTICIPANTS) return { holeId, round, kind: 'insufficient', validParticipantPubkeys, maintainPubkeys, escapePubkeys, requiredMaintain: null, outcomes: [] };
	const requiredMaintain = Math.ceil(validParticipantPubkeys.length * 2 / 3);
	const allMaintain = escapePubkeys.length === 0;
	const success = allMaintain || maintainPubkeys.length >= requiredMaintain;
	const kind: RiftRoundResult['kind'] = allMaintain ? 'all-maintain' : success ? 'mixed-success' : 'threshold-failure';
	const outcomes: RiftOutcome[] = [];
	if (allMaintain) for (const pubkey of maintainPubkeys) outcomes.push({ id: `${state.instanceId}:${holeId}:r${round}:${pubkey}:points:20`, pubkey, kind: 'points', points: 20, instanceId: state.instanceId, holeId, round });
	else if (success) {
		for (const pubkey of maintainPubkeys) outcomes.push({ id: `${state.instanceId}:${holeId}:r${round}:${pubkey}:points:10`, pubkey, kind: 'points', points: 10, instanceId: state.instanceId, holeId, round });
		for (const pubkey of escapePubkeys) outcomes.push({ id: `${state.instanceId}:${holeId}:r${round}:${pubkey}:points:100`, pubkey, kind: 'points', points: 100, instanceId: state.instanceId, holeId, round });
	} else for (const pubkey of escapePubkeys) outcomes.push({ id: `${state.instanceId}:${holeId}:r${round}:${pubkey}:death`, pubkey, kind: 'death', instanceId: state.instanceId, holeId, round });
	return { holeId, round, kind, validParticipantPubkeys, maintainPubkeys, escapePubkeys, requiredMaintain, outcomes };
}

export function settleRiftSession(state: RiftSessionState, schedule: RiftSchedule, nowMs: number): RiftSessionState {
	let next = snapshotRiftParticipants(state, schedule);
	if (!next.participantSnapshot) return next;
	for (const hole of next.holes) {
		if (next.closedHoleIds.includes(hole.id)) continue;
		for (let round = 1 as 1 | 2 | 3; round <= RIFT_ROUND_COUNT; round = (round + 1) as 1 | 2 | 3) {
			if (next.results.some((result) => result.holeId === hole.id && result.round === round)) continue;
			const roundSchedule = getRiftRoundSchedule(schedule, round);
			// The short reveal grace is inside the result-display window. Results
			// become authoritative once that cutoff passes, before the next round.
			if (nowMs < roundSchedule.revealCutoffAtMs) break;
			const result = resultFor(next, schedule, hole.id, round);
			next = { ...next, results: [...next.results, result], closedHoleIds: result.kind === 'threshold-failure' ? [...next.closedHoleIds, hole.id] : next.closedHoleIds };
			if (result.kind === 'threshold-failure') break;
		}
	}
	return next;
}

export function parseRiftEvent(event: Event, channelId: string, registry: RealtimeEventRegistry = REALTIME_EVENT_REGISTRY): Readonly<{ instanceId: string; action: RiftAction }> | null {
	const parsed = parseRealtimeAction(event, channelId, registry as readonly RealtimeEventDefinition<RiftAction>[]);
	return parsed?.envelope.eventType === RIFT_EVENT_TYPE ? { instanceId: parsed.envelope.instanceId, action: parsed.action } : null;
}

export function riftPhaseLabel(phase: RiftSchedule['phase']): string {
	return phase === 'warning' ? '綻びの兆候' : phase === 'registration' ? '参加受付' : phase === 'game' ? '綻びゲーム中' : phase === 'ended' ? '綻び終了' : '綻び待機';
}
