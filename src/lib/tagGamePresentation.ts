import { resolveCharacterFromPubkey } from './characterAssignment';
import type { TagGameState } from './tagGame';

export function tagGameCharacterName(pubkey: string, selfPubkey: string | null): string {
	if (pubkey === selfPubkey) return 'あなた';
	return resolveCharacterFromPubkey(pubkey)?.name ?? '不明なキャラクター';
}

export function tagGameParticipantLabel(game: TagGameState, pubkey: string, selfPubkey: string | null): string {
	const name = tagGameCharacterName(pubkey, selfPubkey);
	if (pubkey === selfPubkey) return name;
	const sameName = game.participant.filter((member) => member.pubkey !== selfPubkey && tagGameCharacterName(member.pubkey, selfPubkey) === name);
	return sameName.length > 1 ? `${name}（同名${sameName.findIndex((member) => member.pubkey === pubkey) + 1}）` : name;
}

export function tagGameConfirmedParticipants(game: TagGameState): TagGameState['participant'][number][] {
	return game.participant.filter((member) => member.status === 'registered' || member.status === 'active' || member.status === 'temporarily-ineligible');
}

export function newlyConfirmedTagGameParticipants(previous: TagGameState | null, current: TagGameState): readonly string[] {
	if (!previous || previous.gameId !== current.gameId) return [];
	const previousPubkeys = new Set(tagGameConfirmedParticipants(previous).map((member) => member.pubkey));
	return tagGameConfirmedParticipants(current).filter((member) => !previousPubkeys.has(member.pubkey)).map((member) => member.pubkey);
}
