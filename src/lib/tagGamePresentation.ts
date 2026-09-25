import { resolveCharacterFromPubkey } from './characterAssignment';
import type { TagGameState } from './tagGame';

export function tagGameCharacterName(pubkey: string, selfPubkey: string | null): string {
	if (pubkey === selfPubkey) return 'あなた';
	return resolveCharacterFromPubkey(pubkey)?.name ?? pubkey.slice(0, 8);
}

export function tagGameParticipantLabel(game: TagGameState, pubkey: string, selfPubkey: string | null): string {
	const name = tagGameCharacterName(pubkey, selfPubkey);
	if (pubkey === selfPubkey) return name;
	const sameName = game.participant.filter((member) => member.pubkey !== selfPubkey && tagGameCharacterName(member.pubkey, selfPubkey) === name);
	return sameName.length > 1 ? `${name}（同名${sameName.findIndex((member) => member.pubkey === pubkey) + 1}）` : name;
}
