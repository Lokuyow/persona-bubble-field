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

export const COOPERATION_DEFECTION_EVENT_TYPE = 'cooperation-defection';
export const COOPERATION_DEFECTION_PROTOCOL_VERSION = 1;
export const COOPERATION_DEFECTION_PROTOCOL_KEY = protocolKeyFor(COOPERATION_DEFECTION_EVENT_TYPE, COOPERATION_DEFECTION_PROTOCOL_VERSION);
export const COOPERATION_DEFECTION_MIN_PARTICIPANTS = 3;
export const COOPERATION_DEFECTION_MAX_PARTICIPANTS = 6;
export const COOPERATION_DEFECTION_ROUND_COUNT = 3;
export const COOPERATION_DEFECTION_CONSULTATION_MS = 30_000;
export const COOPERATION_DEFECTION_SELECTION_MS = 30_000;
export const COOPERATION_DEFECTION_RESULT_MS = 20_000;
export const COOPERATION_DEFECTION_ROUND_MS = COOPERATION_DEFECTION_CONSULTATION_MS + COOPERATION_DEFECTION_SELECTION_MS + COOPERATION_DEFECTION_RESULT_MS;
export const COOPERATION_DEFECTION_REVEAL_GRACE_MS = 5_000;
export const COOPERATION_DEFECTION_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS = 15 * 60;
const COOPERATION_DEFECTION_MANUAL_INSTANCE_PREFIX = 'cooperation-defection:1:manual:';
const COOPERATION_DEFECTION_MANUAL_ID = /^cooperation-defection:1:manual:(\d+):([0-9a-f]{32})$/;
const RETIRED_RIFT_MANUAL_INSTANCE_ID = /^rift:1:manual:\d+:[0-9a-f]{32}$/;

export type CooperationDefectionChoice = 'cooperate' | 'defect';

export type CooperationDefectionAction =
	| Readonly<{ action: 'join'; groupId: string }>
	| Readonly<{ action: 'commit'; groupId: string; round: 1 | 2 | 3; commitment: string }>
	| Readonly<{ action: 'reveal'; groupId: string; round: 1 | 2 | 3; commitId: string; choice: CooperationDefectionChoice; nonce: string }>;

export type CooperationDefectionGroup = Readonly<{ id: string; index: number; position: GridPosition }>;

export type CooperationDefectionSchedule = Readonly<{
	dateKey: string;
	instanceId: string;
	warningAtMs: number;
	registrationAtMs: number;
	gameAtMs: number;
	endedAtMs: number;
	phase: 'dormant' | 'warning' | 'registration' | 'game' | 'ended';
}>;

export type CooperationDefectionRoundSchedule = Readonly<{
	round: 1 | 2 | 3;
	consultationAtMs: number;
	selectionAtMs: number;
	resultAtMs: number;
	revealCutoffAtMs: number;
	endedAtMs: number;
}>;

export type CooperationDefectionActionEvent = Readonly<{
	id: string;
	pubkey: string;
	createdAt: number;
	action: CooperationDefectionAction;
}>;

export type CooperationDefectionOutcome = Readonly<{
	id: string;
	pubkey: string;
	kind: 'points' | 'lifespan-loss';
	points?: number;
	lifespanLossMs?: number;
	instanceId: string;
	groupId: string;
	round: 1 | 2 | 3;
}>;

export type CooperationDefectionRoundResult = Readonly<{
	groupId: string;
	round: 1 | 2 | 3;
	kind: 'all-cooperate' | 'cooperation-success' | 'cooperation-failure' | 'insufficient';
	validParticipantPubkeys: readonly string[];
	cooperatePubkeys: readonly string[];
	defectPubkeys: readonly string[];
	requiredCooperators: number | null;
	outcomes: readonly CooperationDefectionOutcome[];
}>;

export type CooperationDefectionSessionState = Readonly<{
	instanceId: string;
	field: FieldSize;
	groups: readonly CooperationDefectionGroup[];
	actions: readonly CooperationDefectionActionEvent[];
	participantSnapshot: Readonly<Record<string, readonly string[]>> | null;
	results: readonly CooperationDefectionRoundResult[];
	closedGroupIds: readonly string[];
	cancelledGroupIds: readonly string[];
}>;

export const COOPERATION_DEFECTION_EVENT_DEFINITION: RealtimeEventDefinition<CooperationDefectionAction> = {
	eventType: COOPERATION_DEFECTION_EVENT_TYPE,
	protocolVersion: COOPERATION_DEFECTION_PROTOCOL_VERSION,
	protocolKey: COOPERATION_DEFECTION_PROTOCOL_KEY,
	parseAction: parseCooperationDefectionAction,
	schedule: getCooperationDefectionSchedule,
	fieldTargets: (input: RealtimeFieldTargetInput) => deriveCooperationDefectionGroupPositions(input.instanceId, input.field, input.participantDemand)
};

/** The compile-time registry. Removing a definition from the enabled list disables its runtime. */
export const REALTIME_EVENT_REGISTRY: readonly RealtimeEventDefinition[] = [COOPERATION_DEFECTION_EVENT_DEFINITION];
export const ENABLED_REALTIME_EVENT_TYPES: readonly string[] = [COOPERATION_DEFECTION_EVENT_TYPE];

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

function validGroupId(value: unknown): value is string {
	return validString(value) && /:group:\d+$/.test(value);
}

function validChoice(value: unknown): value is CooperationDefectionChoice {
	return value === 'cooperate' || value === 'defect';
}

export function parseCooperationDefectionAction(value: unknown): CooperationDefectionAction | null {
	if (!isRecord(value) || typeof value.action !== 'string') return null;
	if (value.action === 'join') {
		return hasOnlyKeys(value, ['action', 'groupId']) && validGroupId(value.groupId)
			? { action: 'join', groupId: value.groupId }
			: null;
	}
	if (value.action === 'commit') {
		// A commit never carries either secret field. This is an intentional
		// protocol guard against accidentally publishing the choice in plaintext.
		return hasOnlyKeys(value, ['action', 'groupId', 'round', 'commitment']) && validGroupId(value.groupId) &&
			validRound(value.round) && validHex(value.commitment, 32)
			? { action: 'commit', groupId: value.groupId, round: value.round, commitment: value.commitment }
			: null;
	}
	if (value.action === 'reveal') {
		return hasOnlyKeys(value, ['action', 'groupId', 'round', 'commitId', 'choice', 'nonce']) && validGroupId(value.groupId) &&
			validRound(value.round) && validHex(value.commitId, 32) && validChoice(value.choice) && validHex(value.nonce, 32)
			? { action: 'reveal', groupId: value.groupId, round: value.round, commitId: value.commitId, choice: value.choice, nonce: value.nonce }
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

export function buildCooperationDefectionActionTemplate(input: Readonly<{
	channelId: string;
	relayHint: string;
	instanceId: string;
	action: CooperationDefectionAction;
	createdAt: number;
}>): RealtimeEventTemplate {
	return buildRealtimeEventTemplate({
		channelId: input.channelId,
		relayHint: input.relayHint,
		eventType: COOPERATION_DEFECTION_EVENT_TYPE,
		protocolVersion: COOPERATION_DEFECTION_PROTOCOL_VERSION,
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
export function computeCooperationDefectionCommitment(input: Readonly<{
	instanceId: string;
	groupId: string;
	round: 1 | 2 | 3;
	authorPubkey: string;
	choice: CooperationDefectionChoice;
	nonce: string;
}>): string {
	return bytesToHex(sha256(textBytes(JSON.stringify([
		COOPERATION_DEFECTION_PROTOCOL_KEY,
		input.instanceId,
		input.groupId,
		input.round,
		input.authorPubkey,
		input.choice,
		input.nonce
	]))));
}

export function createCooperationDefectionNonce(): string {
	const cryptoApi = globalThis.crypto;
	if (!cryptoApi?.getRandomValues) throw new Error('Web Crypto is unavailable for CooperationDefection selection.');
	const bytes = new Uint8Array(32);
	cryptoApi.getRandomValues(bytes);
	return bytesToHex(bytes);
}

export function buildCooperationDefectionCommitAction(input: Readonly<{
	instanceId: string;
	groupId: string;
	round: 1 | 2 | 3;
	authorPubkey: string;
	choice: CooperationDefectionChoice;
	nonce: string;
}>): Extract<CooperationDefectionAction, { action: 'commit' }> {
	return { action: 'commit', groupId: input.groupId, round: input.round, commitment: computeCooperationDefectionCommitment(input) };
}

export function buildCooperationDefectionRevealAction(input: Readonly<{
	groupId: string;
	round: 1 | 2 | 3;
	commitId: string;
	choice: CooperationDefectionChoice;
	nonce: string;
}>): Extract<CooperationDefectionAction, { action: 'reveal' }> {
	return { action: 'reveal', ...input };
}

export function validateCooperationDefectionReveal(input: Readonly<{
	instanceId: string;
	authorPubkey: string;
	commitId: string;
	commitment: string;
	groupId: string;
	round: 1 | 2 | 3;
	choice: CooperationDefectionChoice;
	nonce: string;
}>): boolean {
	return input.commitment === computeCooperationDefectionCommitment(input);
}

function jstDateParts(nowMs: number): Readonly<{ year: number; month: number; day: number; dateKey: string }> {
	if (!Number.isFinite(nowMs)) throw new TypeError('nowMs must be finite.');
	const date = new Date(nowMs + COOPERATION_DEFECTION_JST_OFFSET_MS);
	const year = date.getUTCFullYear();
	const month = date.getUTCMonth() + 1;
	const day = date.getUTCDate();
	return { year, month, day, dateKey: `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}` };
}

function timeAtJst(dateKey: string, hour: number, minute: number, second = 0): number {
	const [year, month, day] = dateKey.split('-').map(Number);
	return Date.UTC(year, month - 1, day, hour, minute, second) - COOPERATION_DEFECTION_JST_OFFSET_MS;
}

export function dailyCooperationDefectionInstanceId(dateKey: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError('CooperationDefection date key must be YYYY-MM-DD.');
	return `${COOPERATION_DEFECTION_PROTOCOL_NAMESPACE_INSTANCE_PREFIX}:${dateKey}`;
}

export function buildManualCooperationDefectionInstanceId(createdAt: number, nonce: string): string {
	if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new TypeError('Manual CooperationDefection created_at must be a non-negative Unix timestamp.');
	if (!/^[0-9a-f]{32}$/.test(nonce)) throw new TypeError('Manual CooperationDefection nonce must be lowercase 128-bit hex.');
	return `${COOPERATION_DEFECTION_MANUAL_INSTANCE_PREFIX}${createdAt}:${nonce}`;
}

export function parseManualCooperationDefectionInstanceId(instanceId: string): Readonly<{ createdAt: number; nonce: string }> | null {
	const match = COOPERATION_DEFECTION_MANUAL_ID.exec(instanceId);
	if (!match) return null;
	const createdAt = Number(match[1]);
	return Number.isSafeInteger(createdAt) ? { createdAt, nonce: match[2] } : null;
}

/** Retired local settlement references are discarded without accepting their protocol data. */
export function isRetiredRiftSettlementInstanceId(instanceId: string): boolean {
	const daily = /^io\.github\.lokuyow\.persona-bubble-field:realtime:rift:1:instance:(\d{4}-\d{2}-\d{2})$/.exec(instanceId);
	if (daily) {
		const date = new Date(`${daily[1]}T00:00:00Z`);
		if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === daily[1]) return true;
	}
	return RETIRED_RIFT_MANUAL_INSTANCE_ID.test(instanceId);
}

function nextCooperationDefectionDateKey(dateKey: string): string {
	const date = new Date(`${dateKey}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

function manualCooperationDefectionInterval(registrationAtMs: number): Readonly<{ registrationAtMs: number; endedAtMs: number }> | null {
	if (!Number.isFinite(registrationAtMs)) return null;
	return { registrationAtMs, endedAtMs: registrationAtMs + 5 * 60 * 1000 + COOPERATION_DEFECTION_ROUND_COUNT * COOPERATION_DEFECTION_ROUND_MS };
}

export function cooperationDefectionScheduleIntervalsOverlap(
	first: Readonly<{ warningAtMs: number; endedAtMs: number }>,
	second: Readonly<{ registrationAtMs: number; endedAtMs: number }>
): boolean {
	return first.warningAtMs < second.endedAtMs && second.registrationAtMs < first.endedAtMs;
}

/** Checks whether a CooperationDefection beginning at the supplied registration time conflicts with scheduled CooperationDefection windows. */
export function isManualCooperationDefectionRegistrationScheduleEligible(registrationAtMs: number): boolean {
	const manual = manualCooperationDefectionInterval(registrationAtMs);
	if (!manual) return false;
	const scheduled = getCooperationDefectionSchedule(registrationAtMs);
	const nextScheduled = getCooperationDefectionScheduleForDate(nextCooperationDefectionDateKey(scheduled.dateKey), registrationAtMs);
	return !cooperationDefectionScheduleIntervalsOverlap(scheduled, manual) && !cooperationDefectionScheduleIntervalsOverlap(nextScheduled, manual);
}

/** Pure schedule/protocol eligibility shared by browser control handling and operator tooling. */
export function isManualCooperationDefectionInstanceScheduleEligible(instanceId: string, nowMs: number): boolean {
	const manual = parseManualCooperationDefectionInstanceId(instanceId);
	if (!manual) return false;
	const manualSchedule = getCooperationDefectionScheduleForInstance(instanceId, nowMs);
	if (!manualSchedule || !['registration', 'game'].includes(manualSchedule.phase)) return false;
	return isManualCooperationDefectionRegistrationScheduleEligible(manualSchedule.registrationAtMs);
}

export function isManualCooperationDefectionControlScheduleEligible(control: RealtimeControlEnvelope, nowMs: number): boolean {
	if (control.payload.targetProtocolKey !== COOPERATION_DEFECTION_PROTOCOL_KEY) return false;
	const manual = parseManualCooperationDefectionInstanceId(control.instanceId);
	if (!manual || manual.createdAt !== control.event.created_at || control.event.created_at > Math.floor(nowMs / 1000)) return false;
	return isManualCooperationDefectionInstanceScheduleEligible(control.instanceId, nowMs);
}

export function compareManualCooperationDefectionControls(first: RealtimeControlEnvelope, second: RealtimeControlEnvelope): number {
	return first.event.created_at - second.event.created_at || first.event.id.localeCompare(second.event.id);
}

export function selectCanonicalManualCooperationDefectionControl(
	controls: readonly RealtimeControlEnvelope[],
	nowMs: number
): RealtimeControlEnvelope | null {
	return [...controls]
		.filter((control) => isManualCooperationDefectionControlScheduleEligible(control, nowMs))
		.sort(compareManualCooperationDefectionControls)[0] ?? null;
}

const COOPERATION_DEFECTION_PROTOCOL_NAMESPACE_INSTANCE_PREFIX = `${COOPERATION_DEFECTION_PROTOCOL_KEY}:instance`;

export function getCooperationDefectionSchedule(nowMs: number): CooperationDefectionSchedule {
	const { dateKey } = jstDateParts(nowMs);
	return getCooperationDefectionScheduleForDate(dateKey, nowMs);
}

export function getCooperationDefectionScheduleForDate(dateKey: string, nowMs: number): CooperationDefectionSchedule {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new TypeError('CooperationDefection date key must be YYYY-MM-DD.');
	const warningAtMs = timeAtJst(dateKey, 20, 45);
	const registrationAtMs = timeAtJst(dateKey, 20, 55);
	const gameAtMs = timeAtJst(dateKey, 21, 0);
	const endedAtMs = gameAtMs + COOPERATION_DEFECTION_ROUND_COUNT * COOPERATION_DEFECTION_ROUND_MS;
	const phase: CooperationDefectionSchedule['phase'] = nowMs < warningAtMs ? 'dormant'
		: nowMs < registrationAtMs ? 'warning'
			: nowMs < gameAtMs ? 'registration'
				: nowMs < endedAtMs ? 'game' : 'ended';
	return { dateKey, instanceId: dailyCooperationDefectionInstanceId(dateKey), warningAtMs, registrationAtMs, gameAtMs, endedAtMs, phase };
}

export function getCooperationDefectionScheduleForInstance(instanceId: string, nowMs: number): CooperationDefectionSchedule | null {
	const manual = parseManualCooperationDefectionInstanceId(instanceId);
	if (manual) {
		const registrationAtMs = manual.createdAt * 1000;
		const gameAtMs = registrationAtMs + 5 * 60 * 1000;
		const warningAtMs = registrationAtMs;
		const endedAtMs = gameAtMs + COOPERATION_DEFECTION_ROUND_COUNT * COOPERATION_DEFECTION_ROUND_MS;
		const phase: CooperationDefectionSchedule['phase'] = nowMs < registrationAtMs ? 'dormant'
			: nowMs < gameAtMs ? 'registration'
			: nowMs < endedAtMs ? 'game' : 'ended';
		return { dateKey: `manual-${manual.createdAt}`, instanceId, warningAtMs, registrationAtMs, gameAtMs, endedAtMs, phase };
	}
	const prefix = `${COOPERATION_DEFECTION_PROTOCOL_NAMESPACE_INSTANCE_PREFIX}:`;
	if (!instanceId.startsWith(prefix)) return null;
	const dateKey = instanceId.slice(prefix.length);
	return /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? getCooperationDefectionScheduleForDate(dateKey, nowMs) : null;
}

export function getCooperationDefectionRoundSchedule(scheduleOrInstance: Pick<CooperationDefectionSchedule, 'gameAtMs'>, round: 1 | 2 | 3): CooperationDefectionRoundSchedule {
	if (!validRound(round)) throw new TypeError('CooperationDefection round must be 1, 2, or 3.');
	const consultationAtMs = scheduleOrInstance.gameAtMs + (round - 1) * COOPERATION_DEFECTION_ROUND_MS;
	const selectionAtMs = consultationAtMs + COOPERATION_DEFECTION_CONSULTATION_MS;
	const resultAtMs = selectionAtMs + COOPERATION_DEFECTION_SELECTION_MS;
	return { round, consultationAtMs, selectionAtMs, resultAtMs, revealCutoffAtMs: resultAtMs + COOPERATION_DEFECTION_REVEAL_GRACE_MS, endedAtMs: consultationAtMs + COOPERATION_DEFECTION_ROUND_MS };
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

export function deriveCooperationDefectionGroupPositions(
	instanceId: string,
	field: Pick<FieldSize, 'columns' | 'rows'>,
	participantDemand = 0
): readonly CooperationDefectionGroup[] {
	if (!Number.isSafeInteger(field.columns) || !Number.isSafeInteger(field.rows) || field.columns < 1 || field.rows < 1) throw new TypeError('Invalid CooperationDefection field size.');
	if (!Number.isSafeInteger(participantDemand) || participantDemand < 0) throw new TypeError('Invalid CooperationDefection participant demand.');
	const count = Math.max(1, Math.ceil(Math.max(0, participantDemand) / COOPERATION_DEFECTION_MAX_PARTICIPANTS));
	const blocked = FIXED_FIELD_FACILITIES.map((facility) => facility.position);
	const cells: GridPosition[] = [];
	const total = field.columns * field.rows;
	const start = hash32(`${instanceId}:groups`) % total;
	for (let offset = 0; offset < total * 2 && cells.length < count; offset += 1) {
		const index = (start + offset) % total;
		const candidate = { x: index % field.columns, y: Math.floor(index / field.columns) };
		if (blocked.some((cell) => sameCell(cell, candidate)) || cells.some((cell) => sameCell(cell, candidate))) continue;
		cells.push(candidate);
	}
	if (cells.length === 0) throw new Error('No available field cell for CooperationDefection group.');
	return cells.map((position, index) => ({ id: `${instanceId}:group:${index}`, index, position }));
}

function compareActionEvents(first: CooperationDefectionActionEvent, second: CooperationDefectionActionEvent): number {
	return first.createdAt - second.createdAt || first.id.localeCompare(second.id);
}

function latestPerPubkey(events: readonly CooperationDefectionActionEvent[], predicate: (event: CooperationDefectionActionEvent) => boolean): readonly CooperationDefectionActionEvent[] {
	const latest = new Map<string, CooperationDefectionActionEvent>();
	for (const event of events) {
		if (!predicate(event)) continue;
		const previous = latest.get(event.pubkey);
		if (!previous || compareActionEvents(previous, event) < 0) latest.set(event.pubkey, event);
	}
	return [...latest.values()].sort((first, second) => first.pubkey.localeCompare(second.pubkey));
}

export function cooperationDefectionOutcomeId(instanceId: string, groupId: string, round: 1 | 2 | 3, pubkey: string): string {
	const digest = bytesToHex(sha256(textBytes(JSON.stringify([COOPERATION_DEFECTION_PROTOCOL_KEY, instanceId, groupId, round, pubkey]))));
	return `${COOPERATION_DEFECTION_EVENT_TYPE}:${COOPERATION_DEFECTION_PROTOCOL_VERSION}:outcome:${digest}`;
}

export function cooperationDefectionPublicationKey(instanceId: string, groupId: string, round: 1 | 2 | 3, pubkey: string): string {
	return bytesToHex(sha256(textBytes(JSON.stringify([COOPERATION_DEFECTION_PROTOCOL_KEY, 'kind-42', instanceId, groupId, round, pubkey]))));
}

export function createCooperationDefectionSession(input: Readonly<{ instanceId: string; field: FieldSize }>): CooperationDefectionSessionState {
	return { instanceId: input.instanceId, field: input.field, groups: deriveCooperationDefectionGroupPositions(input.instanceId, input.field), actions: [], participantSnapshot: null, results: [], closedGroupIds: [], cancelledGroupIds: [] };
}

export function applyCooperationDefectionAction(state: CooperationDefectionSessionState, event: CooperationDefectionActionEvent): CooperationDefectionSessionState {
	if (!validString(event.id, 160) || !validHex(event.pubkey, 32) || !Number.isSafeInteger(event.createdAt) || event.createdAt < 0) return state;
	if (state.actions.some((candidate) => candidate.id === event.id)) return state;
	if (!parseCooperationDefectionAction(event.action)) return state;
	const actions = [...state.actions, event];
	const demand = new Set(actions.filter((candidate) => candidate.action.action === 'join').map((candidate) => candidate.pubkey)).size;
	const groups = deriveCooperationDefectionGroupPositions(state.instanceId, state.field, demand);
	return { ...state, actions, groups };
}

function joinSnapshot(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule): Readonly<Record<string, readonly string[]>> {
	const joins = latestPerPubkey(state.actions, (event) => event.action.action === 'join' && event.createdAt >= schedule.registrationAtMs && event.createdAt < schedule.gameAtMs)
		.filter((event) => event.action.action === 'join' && state.groups.some((group) => group.id === event.action.groupId));
	const grouped = new Map<string, string[]>();
	const acceptedByGroup = new Map<string, CooperationDefectionActionEvent[]>();
	for (const event of joins) {
		if (event.action.action !== 'join') continue;
		const current = acceptedByGroup.get(event.action.groupId) ?? [];
		current.push(event);
		acceptedByGroup.set(event.action.groupId, current);
	}
	for (const [groupId, events] of acceptedByGroup) {
		const participants = events.sort((first, second) => first.id.localeCompare(second.id) || first.pubkey.localeCompare(second.pubkey)).slice(0, COOPERATION_DEFECTION_MAX_PARTICIPANTS).map((event) => event.pubkey);
		grouped.set(groupId, [...new Set(participants)].sort());
	}
	return Object.fromEntries(grouped);
}

export function getCooperationDefectionParticipantGroup(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule, pubkey: string): string | null {
	const snapshot = state.participantSnapshot ?? joinSnapshot(state, schedule);
	return Object.entries(snapshot).find(([, participants]) => participants.includes(pubkey))?.[0] ?? null;
}

export function snapshotCooperationDefectionParticipants(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule): CooperationDefectionSessionState {
	if (schedule.phase !== 'game' && schedule.phase !== 'ended') return state;
	if (state.participantSnapshot) return state;
	const participantSnapshot = joinSnapshot(state, schedule);
	const cancelledGroupIds = state.groups
		.filter((group) => (participantSnapshot[group.id]?.length ?? 0) < COOPERATION_DEFECTION_MIN_PARTICIPANTS)
		.map((group) => group.id);
	return { ...state, participantSnapshot, cancelledGroupIds };
}

/**
 * Settlement recovery is complete only after the instance can no longer
 * produce an outcome for this participant. Only use an already-committed
 * participant snapshot here: callers may ask before realtime bootstrap ends,
 * when the currently observed joins are incomplete. This intentionally knows
 * nothing about the core ledger; the event definition owns its terminal projection.
 */
export function isCooperationDefectionSettlementComplete(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule, pubkey: string): boolean {
	const snapshot = state.participantSnapshot;
	if (!snapshot) return false;
	const groupId = Object.entries(snapshot).find(([, participants]) => participants.includes(pubkey))?.[0];
	if (!groupId) return schedule.phase === 'ended';
	if (state.cancelledGroupIds.includes(groupId)) return true;
	if (schedule.phase !== 'ended') return false;
	if (state.closedGroupIds.includes(groupId)) return true;
	return state.results.some((result) => result.groupId === groupId && result.round === COOPERATION_DEFECTION_ROUND_COUNT);
}

function resultFor(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule, groupId: string, round: 1 | 2 | 3): CooperationDefectionRoundResult {
	const participants = state.participantSnapshot?.[groupId] ?? [];
	const roundSchedule = getCooperationDefectionRoundSchedule(schedule, round);
	const eligible = new Set(participants);
	const commits = latestPerPubkey(state.actions, (event) => event.action.action === 'commit' && event.action.groupId === groupId && event.action.round === round &&
		event.createdAt >= roundSchedule.selectionAtMs && event.createdAt < roundSchedule.resultAtMs && eligible.has(event.pubkey));
	const reveals = state.actions.filter((event) => event.action.action === 'reveal' && event.action.groupId === groupId && event.action.round === round &&
		event.createdAt >= roundSchedule.resultAtMs && event.createdAt <= roundSchedule.revealCutoffAtMs && eligible.has(event.pubkey));
	const valid = new Map<string, CooperationDefectionChoice>();
	for (const commit of commits) {
		if (commit.action.action !== 'commit') continue;
		const reveal = reveals.filter((candidate) => candidate.pubkey === commit.pubkey && candidate.action.action === 'reveal' && candidate.action.commitId === commit.id)
			.sort(compareActionEvents)[0];
		if (!reveal || reveal.action.action !== 'reveal') continue;
		if (validateCooperationDefectionReveal({ instanceId: state.instanceId, authorPubkey: commit.pubkey, commitId: commit.id, commitment: commit.action.commitment,
			groupId, round, choice: reveal.action.choice, nonce: reveal.action.nonce })) valid.set(commit.pubkey, reveal.action.choice);
	}
	const validParticipantPubkeys = [...valid.keys()].sort();
	const cooperatePubkeys = validParticipantPubkeys.filter((pubkey) => valid.get(pubkey) === 'cooperate');
	const defectPubkeys = validParticipantPubkeys.filter((pubkey) => valid.get(pubkey) === 'defect');
	if (validParticipantPubkeys.length < COOPERATION_DEFECTION_MIN_PARTICIPANTS) return { groupId, round, kind: 'insufficient', validParticipantPubkeys, cooperatePubkeys, defectPubkeys, requiredCooperators: null, outcomes: [] };
	const requiredCooperators = Math.ceil(validParticipantPubkeys.length * 2 / 3);
	const allCooperate = defectPubkeys.length === 0;
	const success = allCooperate || cooperatePubkeys.length >= requiredCooperators;
	const kind: CooperationDefectionRoundResult['kind'] = allCooperate ? 'all-cooperate' : success ? 'cooperation-success' : 'cooperation-failure';
	const outcomes: CooperationDefectionOutcome[] = [];
	if (allCooperate) for (const pubkey of cooperatePubkeys) outcomes.push({ id: cooperationDefectionOutcomeId(state.instanceId, groupId, round, pubkey), pubkey, kind: 'points', points: 1_000, instanceId: state.instanceId, groupId, round });
	else if (success) {
		for (const pubkey of cooperatePubkeys) outcomes.push({ id: cooperationDefectionOutcomeId(state.instanceId, groupId, round, pubkey), pubkey, kind: 'points', points: 100, instanceId: state.instanceId, groupId, round });
		for (const pubkey of defectPubkeys) outcomes.push({ id: cooperationDefectionOutcomeId(state.instanceId, groupId, round, pubkey), pubkey, kind: 'points', points: 10_000, instanceId: state.instanceId, groupId, round });
	} else for (const pubkey of defectPubkeys) outcomes.push({ id: cooperationDefectionOutcomeId(state.instanceId, groupId, round, pubkey), pubkey, kind: 'lifespan-loss', lifespanLossMs: 72 * 60 * 60 * 1000, instanceId: state.instanceId, groupId, round });
	return { groupId, round, kind, validParticipantPubkeys, cooperatePubkeys, defectPubkeys, requiredCooperators, outcomes };
}

export function settleCooperationDefectionSession(state: CooperationDefectionSessionState, schedule: CooperationDefectionSchedule, nowMs: number): CooperationDefectionSessionState {
	let next = snapshotCooperationDefectionParticipants(state, schedule);
	if (!next.participantSnapshot) return next;
	for (const group of next.groups) {
		if (next.closedGroupIds.includes(group.id) || next.cancelledGroupIds.includes(group.id)) continue;
		for (let round = 1 as 1 | 2 | 3; round <= COOPERATION_DEFECTION_ROUND_COUNT; round = (round + 1) as 1 | 2 | 3) {
			if (next.results.some((result) => result.groupId === group.id && result.round === round)) continue;
			const roundSchedule = getCooperationDefectionRoundSchedule(schedule, round);
			// The short reveal grace is inside the result-display window. Results
			// become authoritative once that cutoff passes, before the next round.
			if (nowMs < roundSchedule.revealCutoffAtMs) break;
			const result = resultFor(next, schedule, group.id, round);
			next = { ...next, results: [...next.results, result], closedGroupIds: result.kind === 'cooperation-failure' ? [...next.closedGroupIds, group.id] : next.closedGroupIds };
			if (result.kind === 'cooperation-failure') break;
		}
	}
	return next;
}

export function parseCooperationDefectionEvent(event: Event, channelId: string, registry: RealtimeEventRegistry = REALTIME_EVENT_REGISTRY): Readonly<{ instanceId: string; action: CooperationDefectionAction }> | null {
	const parsed = parseRealtimeAction(event, channelId, registry as readonly RealtimeEventDefinition<CooperationDefectionAction>[]);
	return parsed?.envelope.eventType === COOPERATION_DEFECTION_EVENT_TYPE ? { instanceId: parsed.envelope.instanceId, action: parsed.action } : null;
}

export function cooperationDefectionPhaseLabel(phase: CooperationDefectionSchedule['phase']): string {
	return phase === 'warning' ? '開催予告' : phase === 'registration' ? '参加受付' : phase === 'game' ? 'ゲーム中' : phase === 'ended' ? '本日の開催終了' : '開催待ち';
}
