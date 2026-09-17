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
	buildManualRiftInstanceId,
	getRiftScheduleForInstance,
	isManualRiftControlScheduleEligible,
	isManualRiftInstanceScheduleEligible,
	RIFT_EVENT_DEFINITION,
	RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS,
	selectCanonicalManualRiftControl
} from './rift';
import {
	CHANNEL_CREATE_KIND,
	CHANNEL_METADATA_KIND,
	resolveChannelMetadata,
	type ResolvedChannelMetadata
} from './nostrChannelMetadata';
import { PROTOTYPE_WORLD_CONFIG, type PrototypeWorldConfig } from './prototypeWorldConfig';
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
	randomBytes: (length: number) => Uint8Array;
	nowMs?: () => number;
	output: OperatorOutput;
}>;

export type OperatorCommandResult = Readonly<{
	exitCode: 0 | 1 | 130;
	mode: OperatorMode;
	metadata: ResolvedChannelMetadata;
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
	| 'metadata discovery failed'
	| 'control preflight failed'
	| 'active manual Rift already exists'
	| 'scheduled Rift conflict'
	| 'confirmation cancelled'
	| 'invalid operator secret'
	| 'operator secret is not the channel creator'
	| 'control self-validation failed'
	| 'all authoritative Relays rejected the event';

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

function eventUnion(results: readonly OperatorRelayQueryResult[]): readonly Event[] {
	const events = new Map<string, Event>();
	for (const result of results) {
		for (const event of result.events) events.set(event.id, event);
	}
	return [...events.values()];
}

function reportQuery(output: OperatorOutput, result: OperatorRelayQueryResult): void {
	for (const relay of result.relays) {
		const notice = relay.notice ? `: ${outputValue(relay.notice)}` : '';
		output.stdout(`Relay ${outputValue(relay.relayUrl)} read ${relay.status}${notice}`);
	}
}

async function discoverMetadata(
	world: PrototypeWorldConfig,
	relay: OperatorRelayAdapter,
	output: OperatorOutput
): Promise<ResolvedChannelMetadata> {
	const kind40 = await relay.query({ ids: [world.channelId], kinds: [CHANNEL_CREATE_KIND] }, world.metadataDiscoveryRelays);
	const kind41 = await relay.query(
		{ kinds: [CHANNEL_METADATA_KIND], '#e': [world.channelId] } as Filter,
		world.metadataDiscoveryRelays
	);
	reportQuery(output, kind40);
	reportQuery(output, kind41);
	if (kind40.eoseCount === 0 || kind41.eoseCount === 0) throw new OperatorFailure('metadata discovery failed');
	const metadata = resolveChannelMetadata([...eventUnion([kind40, kind41])], world.channelId, world.preferredRelayHint);
	if (!metadata) throw new OperatorFailure('metadata discovery failed');
	return metadata;
}

async function activeManualPreflight(
	metadata: ResolvedChannelMetadata,
	relay: OperatorRelayAdapter,
	nowMs: number,
	output: OperatorOutput
) {
	const since = Math.max(0, unixSeconds(nowMs) - RIFT_MANUAL_CONTROL_LOOKBACK_SECONDS);
	const result = await relay.query(
		buildRealtimeControlFilter({ channelId: metadata.channelId, creatorPubkey: metadata.creatorPubkey, since }),
		metadata.relays
	);
	reportQuery(output, result);
	if (result.eoseCount === 0) throw new OperatorFailure('control preflight failed');
	const controls = result.events
		.map((event) => parseRealtimeControlEnvelope(event, metadata.channelId, metadata.creatorPubkey))
		.filter((control): control is NonNullable<ReturnType<typeof parseRealtimeControlEnvelope>> => control !== null);
	return selectCanonicalManualRiftControl(controls, nowMs);
}

function assertNoActiveManual(control: ReturnType<typeof selectCanonicalManualRiftControl>): void {
	if (control) throw new OperatorFailure('active manual Rift already exists');
}

function formatIso(ms: number): string {
	return new Date(ms).toISOString();
}

function writePreview(output: OperatorOutput, metadata: ResolvedChannelMetadata, mode: OperatorMode, nowMs: number): void {
	output.stdout(`Channel: ${outputValue(metadata.channelId)}`);
	output.stdout(`Creator: ${outputValue(metadata.creatorPubkey)}`);
	output.stdout(`Authoritative Relays: ${metadata.relays.map(outputValue).join(', ')}`);
	output.stdout(`Mode: ${mode === 'publish' ? 'PUBLISH' : 'DRY RUN'}`);
	output.stdout('Registration starts when the signed control is created; game starts 5 minutes later.');
	output.stdout(`Preview time: ${formatIso(nowMs)}`);
}

function writeControl(output: OperatorOutput, metadata: ResolvedChannelMetadata, event: VerifiedEvent, instanceId: string): void {
	const schedule = getRiftScheduleForInstance(instanceId, event.created_at * 1000);
	if (!schedule) throw new OperatorFailure('control self-validation failed');
	output.stdout(`Control event ID: ${outputValue(event.id)}`);
	output.stdout(`Manual instance ID: ${outputValue(instanceId)}`);
	output.stdout(`Registration: ${formatIso(schedule.registrationAtMs)}`);
	output.stdout(`Game: ${formatIso(schedule.gameAtMs)}`);
	output.stdout(`Event end: ${formatIso(schedule.endedAtMs)}`);
	output.stdout(`Channel creator: ${outputValue(metadata.creatorPubkey)}`);
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
	metadata: ResolvedChannelMetadata,
	dependencies: OperatorDependencies,
	secret: Uint8Array,
	nowMs: number
): Readonly<{ event: VerifiedEvent; instanceId: string }> {
	const createdAt = unixSeconds(nowMs);
	const random = dependencies.randomBytes(16);
	try {
		if (random.length !== 16) throw new OperatorFailure('control self-validation failed');
		const instanceId = buildManualRiftInstanceId(createdAt, hex(random));
		if (!isManualRiftInstanceScheduleEligible(instanceId, nowMs)) throw new OperatorFailure('scheduled Rift conflict');
		const template = buildRealtimeControlEventTemplate({
			channelId: metadata.channelId,
			relayHint: metadata.channel.relayHint,
			instanceId,
			payload: { command: 'start', targetProtocolKey: RIFT_EVENT_DEFINITION.protocolKey },
			createdAt
		});
		const event = finalizeRealtimeEvent(template, secret);
		const parsed = parseRealtimeControlEnvelope(event, metadata.channelId, metadata.creatorPubkey);
		if (!parsed || !isManualRiftControlScheduleEligible(parsed, nowMs)) {
			throw new OperatorFailure('control self-validation failed');
		}
		return { event, instanceId };
	} finally {
		random.fill(0);
	}
}

async function createAndValidateControl(
	metadata: ResolvedChannelMetadata,
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
	if (creatorPubkey !== metadata.creatorPubkey) throw new OperatorFailure('operator secret is not the channel creator');
	return createSignedControl(metadata, dependencies, secret, nowMs);
}

export async function runManualRiftOperator(
	mode: OperatorMode,
	dependencies: OperatorDependencies,
	world: PrototypeWorldConfig = PROTOTYPE_WORLD_CONFIG
): Promise<OperatorCommandResult> {
	const now = dependencies.nowMs ?? (() => Date.now());
	try {
		const metadata = await discoverMetadata(world, dependencies.relay, dependencies.output);
		const currentTime = now();
		assertNoActiveManual(await activeManualPreflight(metadata, dependencies.relay, currentTime, dependencies.output));
		writePreview(dependencies.output, metadata, mode, currentTime);

		if (mode === 'publish') {
			if ((await dependencies.confirmPublish()) !== 'confirmed') throw new OperatorCancelled('confirmation cancelled');
			assertNoActiveManual(await activeManualPreflight(metadata, dependencies.relay, now(), dependencies.output));
		}

		const secret = await dependencies.readSecret();
		try {
			const control = await createAndValidateControl(metadata, dependencies, secret, now());
			writeControl(dependencies.output, metadata, control.event, control.instanceId);
			if (mode === 'dry-run') {
				dependencies.output.stdout('DRY RUN: EVENT was not published.');
				return { exitCode: 0, mode, metadata, controlEvent: control.event, instanceId: control.instanceId };
			}
			const results = await dependencies.relay.publish(control.event, metadata.relays);
			reportPublish(dependencies.output, results);
			if (!publishSucceeded(results)) throw new OperatorFailure('all authoritative Relays rejected the event');
			dependencies.output.stdout('Manual Rift control published.');
			return { exitCode: 0, mode, metadata, controlEvent: control.event, instanceId: control.instanceId };
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
