import type { Character } from './character';
import type { Event } from 'nostr-tools/pure';
import {
	parsePublicProfileEnvelope,
	parsePublicProfileState,
	parseWorldStateExitEnvelope,
	parseWorldStateEvent,
	isNewerPublicProfileEnvelope,
	type ParsedWorldStateEvent,
	type PublicProfileEnvelope,
	type PublicProfileState
} from './nostrProtocol';
import { projectPublicLifespan } from './publicProfile';
import { resolveWorldCharacterFromPubkey } from './worldCharacterAssignment';

type CanonicalProfile = Readonly<{ envelope: PublicProfileEnvelope; state: PublicProfileState | null }>;
type CanonicalExit = Readonly<{ id: string; pubkey: string; createdAt: number; parsed: ParsedWorldStateEvent | null }>;

export type PublicRankingRow = Readonly<{
	key: string;
	character: Character;
	points: number;
	remainingLifespanMs: number;
	terminalState: 'death' | 'clear' | null;
	isSelf: boolean;
}>;

export type PublicRankingProjection = Readonly<{
	points: readonly PublicRankingRow[];
	lifespan: readonly PublicRankingRow[];
}>;

function compareLexically(first: string, second: string): number {
	return first < second ? -1 : first > second ? 1 : 0;
}

/** Canonicalizes addressable candidates before strict schema and Run interpretation. */
export function projectPublicRankings(input: Readonly<{
	events: readonly Event[];
	channelId: string;
	viewerNowMs: number;
	selfPubkey?: string | null;
}>): PublicRankingProjection {
	if (!Number.isSafeInteger(input.viewerNowMs) || input.viewerNowMs < 0) throw new TypeError('Invalid ranking viewer time.');
	const profiles = new Map<string, CanonicalProfile>();
	const exits = new Map<string, CanonicalExit>();

	for (const event of input.events) {
		const profileEnvelope = parsePublicProfileEnvelope(event, input.channelId);
		if (profileEnvelope) {
			const previous = profiles.get(profileEnvelope.pubkey);
			if (!previous || isNewerPublicProfileEnvelope(profileEnvelope, previous.envelope)) {
				profiles.set(profileEnvelope.pubkey, {
					envelope: profileEnvelope,
					state: parsePublicProfileState(event, input.channelId, profileEnvelope.pubkey)
				});
			}
			continue;
		}

		const exitEnvelope = parseWorldStateExitEnvelope(event, input.channelId);
		if (!exitEnvelope) continue;
		const previous = exits.get(exitEnvelope.pubkey);
		if (!previous || exitEnvelope.createdAt > previous.createdAt ||
			exitEnvelope.createdAt === previous.createdAt && compareLexically(exitEnvelope.id, previous.id) < 0) {
			const parsed = parseWorldStateEvent(event, input.channelId);
			exits.set(exitEnvelope.pubkey, {
				id: exitEnvelope.id,
				pubkey: exitEnvelope.pubkey,
				createdAt: exitEnvelope.createdAt,
				parsed: parsed?.state === 'exit' ? parsed : null
			});
		}
	}

	const rows: PublicRankingRow[] = [];
	for (const [pubkey, candidate] of profiles) {
		const state = candidate.state;
		const character = resolveWorldCharacterFromPubkey(pubkey);
		if (!state || !character) continue;
		const expiry = projectPublicLifespan(state, input.viewerNowMs);
		const exit = exits.get(pubkey)?.parsed;
		const matchingExit = exit?.runNumber === state.runNumber ? exit : null;
		const terminalState = matchingExit?.exitReason === 'clear'
			? 'clear'
			: matchingExit?.exitReason === 'death' || expiry <= input.viewerNowMs
				? 'death'
				: null;
		rows.push({
			key: pubkey,
			character,
			points: state.points,
			remainingLifespanMs: Math.max(0, expiry - input.viewerNowMs),
			terminalState,
			isSelf: pubkey === input.selfPubkey
		});
	}

	const points = [...rows].sort((first, second) => second.points - first.points || compareLexically(first.key, second.key));
	const stateOrder = (row: PublicRankingRow) => row.terminalState === 'death' ? 0 : row.terminalState === 'clear' ? 2 : 1;
	const lifespan = [...rows].sort((first, second) => stateOrder(first) - stateOrder(second) ||
		(stateOrder(first) === 1 ? first.remainingLifespanMs - second.remainingLifespanMs : 0) ||
		compareLexically(first.key, second.key));
	return { points, lifespan };
}
