import { decode, noteEncode } from 'nostr-tools/nip19';
import type { Event as NostrEvent } from 'nostr-tools/pure';

type ContextReference = Readonly<{ eventId: string; relayHints: readonly string[]; authorPubkey: string | null }>;
export type HostOwnedComposerOutput = Readonly<{
	content: string;
	tags: readonly (readonly string[])[];
	context: Readonly<{
		reply: ContextReference | null;
		quotes: readonly ContextReference[];
		channel: Readonly<{ eventId: string; relayHints: readonly string[]; channelRelays?: readonly string[] }> | null;
	}>;
}>;
export type ComposerDesiredContext = Readonly<{
	generation: number;
	targetId: string | null;
	clearContentVersion: number;
}>;
export type ComposerSyncSnapshot = Readonly<{
	generation: number;
	appliedGeneration: number | null;
	fullySynced: boolean;
}>;
export type ComposerSubmitEnvelope = ComposerSyncSnapshot & Readonly<{ output: HostOwnedComposerOutput }>;
export type ComposerContextPatch = Readonly<{
	content?: null;
	reply: string | null;
	preloadedEvents?: Readonly<Record<string, NostrEvent>>;
}>;

export function matchesComposerSubmit(envelope: ComposerSubmitEnvelope, desired: ComposerDesiredContext): boolean {
	const reply = envelope.output.context?.reply;
	return envelope.fullySynced && envelope.generation === desired.generation &&
		envelope.appliedGeneration === desired.generation &&
		(desired.targetId === null ? reply === null : reply != null && reply.eventId === desired.targetId);
}

function replyId(value: unknown): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== 'string') return undefined;
	try {
		const decoded = decode(value);
		return decoded.type === 'note' ? decoded.data : decoded.type === 'nevent' ? decoded.data.id : undefined;
	} catch { return undefined; }
}

/** One combined context call at a time; superseded requests retain only the latest desired state. */
export function createComposerContextSync(options: Readonly<{
	setContext: (patch: ComposerContextPatch) => Promise<void>;
	loadPreview?: (targetId: string) => Promise<NostrEvent | null>;
	onPreviewClear: (generation: number) => void;
}>) {
	let desired: ComposerDesiredContext = { generation: 0, targetId: null, clearContentVersion: 0 };
	let appliedGeneration: number | null = null;
	let clearedVersion = 0;
	let observed: string | null | undefined;
	let inFlight: { request: ComposerDesiredContext; acknowledged: boolean } | null = null;
	let ready = false;
	let submitting = false;
	let disposed = false;

	function snapshot(): ComposerSyncSnapshot {
		return { generation: desired.generation, appliedGeneration, fullySynced: ready && !inFlight &&
			appliedGeneration === desired.generation && observed === desired.targetId && clearedVersion >= desired.clearContentVersion };
	}

	async function drain(): Promise<void> {
		if (disposed || !ready || submitting || inFlight || snapshot().fullySynced) return;
		const operation = { request: desired, acknowledged: false };
		inFlight = operation;
		try {
			const event = desired.targetId && options.loadPreview ? await options.loadPreview(desired.targetId) : null;
			if (disposed || submitting || operation.request !== desired) return;
			const { request } = operation;
			operation.acknowledged = false;
			await options.setContext({
				reply: request.targetId ? noteEncode(request.targetId) : null,
				...(request.clearContentVersion > clearedVersion ? { content: null } : {}),
				...(event && event.id === request.targetId ? { preloadedEvents: { [event.id]: event } } : {})
			});
			if (disposed) return;
			if (operation.acknowledged) {
				clearedVersion = Math.max(clearedVersion, request.clearContentVersion);
				if (request === desired && observed === request.targetId) appliedGeneration = request.generation;
			}
		} catch {
			// Keep the draft and remain unsynced. A later explicit request can retry.
			appliedGeneration = null;
		} finally {
			inFlight = null;
			if (!disposed && operation.request !== desired) void drain();
		}
	}

	return {
		request(next: ComposerDesiredContext): void {
			desired = next;
			void drain();
		},
		ready(): void { ready = true; void drain(); },
		contextUpdated(value: unknown): void {
			const wasSynced = snapshot().fullySynced;
			observed = replyId(value);
			if (inFlight) {
				inFlight.acknowledged = observed === inFlight.request.targetId;
				return;
			}
			if (wasSynced && observed === null && desired.targetId !== null) {
				options.onPreviewClear(desired.generation);
			} else if (observed !== desired.targetId) {
				appliedGeneration = null;
				void drain();
			}
		},
		beginSubmit(): ComposerSyncSnapshot { const current = snapshot(); submitting = true; return current; },
		finishSubmit(success: boolean): void {
			if (disposed) return;
			submitting = false;
			if (success) { observed = null; appliedGeneration = null; }
			void drain();
		},
		snapshot,
		dispose(): void { disposed = true; ready = false; }
	};
}
