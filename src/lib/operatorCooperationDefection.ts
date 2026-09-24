import { getPublicKey, type Event, type VerifiedEvent } from 'nostr-tools/pure';
import type { Filter } from 'nostr-tools/filter';
import {
	buildRealtimeControlEventTemplate,
	buildRealtimeControlFilter,
	finalizeRealtimeEvent,
	parseRealtimeControlEnvelope,
	REALTIME_CONTROL_PROTOCOL_KEY
} from './realtimeEvents';
import {
	buildManualCooperationDefectionInstanceId,
	getCooperationDefectionScheduleForInstance,
	isManualCooperationDefectionControlScheduleEligible,
	isManualCooperationDefectionInstanceScheduleEligible,
	isManualCooperationDefectionRegistrationScheduleEligible,
	COOPERATION_DEFECTION_EVENT_DEFINITION,
	COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS,
	selectCanonicalManualCooperationDefectionControl
} from './cooperationDefection';
import { assertPrototypeWorldConfig, PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from './prototypeWorldConfig';
import type {
	OperatorRelayAdapter,
	OperatorRelayPublishResult,
	OperatorRelayQueryResult
} from './operatorRelayAdapter';

export type OperatorMode = 'dry-run' | 'publish';

export type OperatorOutput = Readonly<{
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}>;

export type OperatorDependencies = Readonly<{
	relay: OperatorRelayAdapter;
	confirmPublish: () => Promise<'confirmed' | 'cancelled'>;
	readSecret: () => Promise<Uint8Array>;
	cancelSignal?: AbortSignal;
	randomBytes: (length: number) => Uint8Array;
	nowMs?: () => number;
	output: OperatorOutput;
}>;

export type OperatorCommandResult = Readonly<{
	exitCode: 0 | 1 | 130;
	mode: OperatorMode;
	world: PrototypeWorldConfig;
	controlEvent?: VerifiedEvent;
	instanceId?: string;
}>;

export class OperatorCancelled extends Error {
	readonly code = 130 as const;
}

export class OperatorFailure extends Error {
	readonly code = 1 as const;
	constructor(readonly reason: OperatorFailureReason) {
		super(reason);
	}
}

export type OperatorFailureReason =
	| 'invalid configuration'
	| 'control preflight failed'
	| 'active manual CooperationDefection already exists'
	| 'scheduled CooperationDefection conflict'
	| 'confirmation cancelled'
	| 'invalid operator secret'
	| 'operator secret is not the channel creator'
	| 'control self-validation failed'
	| 'all authoritative Relays failed to accept the event';

const SAFE_DISPLAY_MAX_LENGTH = 240;

/** Converts dynamic text to a bounded terminal-safe visible representation. */
export function sanitizeOperatorDisplayText(value: unknown, maxLength = SAFE_DISPLAY_MAX_LENGTH): string {
	const source = typeof value === 'string' ? value : '[unavailable]';
	const limit = Number.isSafeInteger(maxLength) && maxLength >= 1 ? maxLength : SAFE_DISPLAY_MAX_LENGTH;
	const units: string[] = [];
	for (const character of source) {
		const codePoint = character.codePointAt(0)!;
		const isControl = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
		const isLineSeparator = codePoint === 0x2028 || codePoint === 0x2029;
		const isBidiOrFormat = /[\p{Bidi_Control}\p{Cf}]/u.test(character);
		units.push(isControl || isLineSeparator || isBidiOrFormat
			? `\\u${codePoint.toString(16).padStart(4, '0')}`
			: character);
	}
	let result = '';
	for (const unit of units) {
		if (result.length + unit.length > limit) return result.length < limit ? `${result}…` : result;
		result += unit;
	}
	return result;
}

function outputValue(value: unknown): string {
	return sanitizeOperatorDisplayText(value);
}

function unixSeconds(nowMs: number): number {
	return Math.floor(nowMs / 1000);
}

function reportQuery(output: OperatorOutput, result: OperatorRelayQueryResult): void {
	for (const relay of result.relays) {
		const notice = relay.notice ? `: ${outputValue(relay.notice)}` : '';
		output.stdout(`Relay ${outputValue(relay.relayUrl)} read ${relay.status}${notice}`);
	}
}

async function activeManualPreflight(
	world: PrototypeWorldConfig,
	relay: OperatorRelayAdapter,
	nowMs: number,
	output: OperatorOutput,
	cancelSignal?: AbortSignal
) {
	const since = Math.max(0, unixSeconds(nowMs) - COOPERATION_DEFECTION_MANUAL_CONTROL_LOOKBACK_SECONDS);
	const result = await relay.query(
		buildRealtimeControlFilter({ channelId: world.channelId, creatorPubkey: world.creatorPubkey, since }),
		world.authoritativeRelays
	);
	reportQuery(output, result);
	// The finite-read adapter has no cancellation contract. Let an already
	// started query settle, then honor command cancellation before advancing.
	if (cancelSignal?.aborted) throw new OperatorCancelled('operator command cancelled');
	if (result.eoseCount === 0) throw new OperatorFailure('control preflight failed');
	const controls = result.events
		.map((event) => parseRealtimeControlEnvelope(event, world.channelId, world.creatorPubkey))
		.filter((control): control is NonNullable<ReturnType<typeof parseRealtimeControlEnvelope>> => control !== null);
	return selectCanonicalManualCooperationDefectionControl(controls, nowMs);
}

function assertNoActiveManual(control: ReturnType<typeof selectCanonicalManualCooperationDefectionControl>): void {
	if (control) throw new OperatorFailure('active manual CooperationDefection already exists');
}

function assertNotCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new OperatorCancelled('operator command cancelled');
}

function assertScheduledStartAllowed(nowMs: number): void {
	const registrationAtMs = unixSeconds(nowMs) * 1000;
	if (!isManualCooperationDefectionRegistrationScheduleEligible(registrationAtMs)) throw new OperatorFailure('scheduled CooperationDefection conflict');
}

function formatIso(ms: number): string {
	return new Date(ms).toISOString();
}

function writePreview(output: OperatorOutput, world: PrototypeWorldConfig, mode: OperatorMode, nowMs: number): void {
	output.stdout(`World config revision: ${world.configRevision}`);
	output.stdout(`Channel: ${outputValue(world.channelId)}`);
	output.stdout(`Creator: ${outputValue(world.creatorPubkey)}`);
	output.stdout(`Authoritative Relays: ${world.authoritativeRelays.map(outputValue).join(', ')}`);
	output.stdout(`Mode: ${mode === 'publish' ? 'PUBLISH' : 'DRY RUN'}`);
	output.stdout('Registration starts when the signed control is created; game starts 5 minutes later.');
	output.stdout(`Preview time: ${formatIso(nowMs)}`);
}

function writeControl(output: OperatorOutput, world: PrototypeWorldConfig, event: VerifiedEvent, instanceId: string): void {
	const schedule = getCooperationDefectionScheduleForInstance(instanceId, event.created_at * 1000);
	if (!schedule) throw new OperatorFailure('control self-validation failed');
	output.stdout(`Control event ID: ${outputValue(event.id)}`);
	output.stdout(`Manual instance ID: ${outputValue(instanceId)}`);
	output.stdout(`Registration: ${formatIso(schedule.registrationAtMs)}`);
	output.stdout(`Game: ${formatIso(schedule.gameAtMs)}`);
	output.stdout(`Event end: ${formatIso(schedule.endedAtMs)}`);
	output.stdout(`Channel creator: ${outputValue(world.creatorPubkey)}`);
}

function publishSucceeded(results: readonly OperatorRelayPublishResult[]): boolean {
	return results.some((result) => result.outcome === 'accepted');
}

function reportPublish(output: OperatorOutput, results: readonly OperatorRelayPublishResult[]): void {
	for (const result of results) {
		const notice = result.notice ? `: ${outputValue(result.notice)}` : '';
		output.stdout(`Relay ${outputValue(result.relayUrl)} publish ${result.outcome}${notice}`);
	}
}

function createSignedControl(
	world: PrototypeWorldConfig,
	dependencies: OperatorDependencies,
	secret: Uint8Array,
	nowMs: number
): Readonly<{ event: VerifiedEvent; instanceId: string }> {
	const createdAt = unixSeconds(nowMs);
	const random = dependencies.randomBytes(16);
	try {
		if (random.length !== 16) throw new OperatorFailure('control self-validation failed');
		const instanceId = buildManualCooperationDefectionInstanceId(createdAt, hex(random));
		if (!isManualCooperationDefectionInstanceScheduleEligible(instanceId, nowMs)) throw new OperatorFailure('scheduled CooperationDefection conflict');
		const template = buildRealtimeControlEventTemplate({
			channelId: world.channelId,
			relayHint: world.preferredRelayHint,
			instanceId,
			payload: { command: 'start', targetProtocolKey: COOPERATION_DEFECTION_EVENT_DEFINITION.protocolKey },
			createdAt
		});
		const event = finalizeRealtimeEvent(template, secret);
		const parsed = parseRealtimeControlEnvelope(event, world.channelId, world.creatorPubkey);
		if (!parsed || !isManualCooperationDefectionControlScheduleEligible(parsed, nowMs)) {
			throw new OperatorFailure('control self-validation failed');
		}
		return { event, instanceId };
	} finally {
		random.fill(0);
	}
}

async function createAndValidateControl(
	world: PrototypeWorldConfig,
	dependencies: OperatorDependencies,
	secret: Uint8Array,
	nowMs: number
): Promise<Readonly<{ event: VerifiedEvent; instanceId: string }>> {
	let creatorPubkey: string;
	try {
		creatorPubkey = getPublicKey(secret);
	} catch {
		throw new OperatorFailure('invalid operator secret');
	}
	if (creatorPubkey !== world.creatorPubkey) throw new OperatorFailure('operator secret is not the channel creator');
	return createSignedControl(world, dependencies, secret, nowMs);
}

export async function runManualCooperationDefectionOperator(
	mode: OperatorMode,
	dependencies: OperatorDependencies,
	world: PrototypeWorldConfig = PROTOTYPE_WORLD_CONFIG
): Promise<OperatorCommandResult> {
	const now = dependencies.nowMs ?? (() => Date.now());
	try {
		try {
			assertPrototypeWorldConfig(world);
		} catch {
			throw new OperatorFailure('invalid configuration');
		}
		const currentTime = now();
		assertNoActiveManual(await activeManualPreflight(world, dependencies.relay, currentTime, dependencies.output, dependencies.cancelSignal));
		assertScheduledStartAllowed(currentTime);
		writePreview(dependencies.output, world, mode, currentTime);

		if (mode === 'publish') {
			if ((await dependencies.confirmPublish()) !== 'confirmed') throw new OperatorCancelled('confirmation cancelled');
			const confirmedAt = now();
			assertNoActiveManual(await activeManualPreflight(world, dependencies.relay, confirmedAt, dependencies.output, dependencies.cancelSignal));
			assertScheduledStartAllowed(confirmedAt);
		}

		assertNotCancelled(dependencies.cancelSignal);
		const secret = await dependencies.readSecret();
		try {
			const control = await createAndValidateControl(world, dependencies, secret, now());
			assertNotCancelled(dependencies.cancelSignal);
			writeControl(dependencies.output, world, control.event, control.instanceId);
			if (mode === 'dry-run') {
				dependencies.output.stdout('DRY RUN: EVENT was not published.');
				return { exitCode: 0, mode, world, controlEvent: control.event, instanceId: control.instanceId };
			}
			assertNotCancelled(dependencies.cancelSignal);
			dependencies.output.stdout('Publication started; waiting for Relay results.');
			// publish() is the irreversible side-effect boundary. It has no abort
			// contract, so Ctrl+C is consumed by the input session and results are
			// always awaited and classified.
			const results = await dependencies.relay.publish(control.event, world.authoritativeRelays);
			reportPublish(dependencies.output, results);
			if (!publishSucceeded(results)) throw new OperatorFailure('all authoritative Relays failed to accept the event');
			dependencies.output.stdout('Manual CooperationDefection control published.');
			return { exitCode: 0, mode, world, controlEvent: control.event, instanceId: control.instanceId };
		} finally {
			secret.fill(0);
		}
	} finally {
		dependencies.relay.close();
	}
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
