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

export function isOwnTagGameStartTransition(previous: TagGameState | null, current: TagGameState, selfPubkey: string | null, selfRunNumber: number | null): boolean {
	if (!previous || previous.gameId !== current.gameId || previous.phase === 'running' || current.phase !== 'running' || !selfPubkey || selfRunNumber === null) return false;
	return current.participant.some((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber && member.status === 'active');
}

export function isOwnTagGameCountdown(game: TagGameState, selfPubkey: string | null, selfRunNumber: number | null): boolean {
	if (game.phase !== 'countdown' || !game.startAt || !selfPubkey || selfRunNumber === null) return false;
	return game.participant.some((member) => member.pubkey === selfPubkey && member.runNumber === selfRunNumber &&
		(member.status === 'registered' || member.status === 'active' || member.status === 'temporarily-ineligible'));
}

export function tagGameCountdownSeconds(startAt: number, nowMs: number): number | null {
	const remainingMs = startAt * 1_000 - nowMs;
	if (remainingMs <= 0 || remainingMs > 5_000) return null;
	return Math.ceil(remainingMs / 1_000);
}

export function tagGameResultParticipants(game: TagGameState, selfPubkey: string | null): TagGameState['participant'][number][] {
	const participants = [...game.participant].sort((a, b) => a.registeredAt - b.registeredAt || a.pubkey.localeCompare(b.pubkey));
	if (!selfPubkey) return participants;
	const selfIndex = participants.findIndex((member) => member.pubkey === selfPubkey);
	if (selfIndex <= 0) return participants;
	return [participants[selfIndex], ...participants.slice(0, selfIndex), ...participants.slice(selfIndex + 1)];
}

export function tagGameResultTime(valueMs: number): string {
	const tenths = Math.round(Math.max(0, valueMs) / 100);
	return formatTenths(tenths);
}

export function tagGameResultLifespan(valueMs: number): string {
	const tenthsOfHours = Math.round(Math.max(0, valueMs) / 360_000);
	if (tenthsOfHours < 240) return `${formatTenths(tenthsOfHours)}時間`;
	const days = Math.floor(tenthsOfHours / 240);
	const remainingTenthsOfHours = tenthsOfHours % 240;
	return `${days}日${remainingTenthsOfHours === 0 ? '' : `${formatTenths(remainingTenthsOfHours)}時間`}`;
}

function formatTenths(value: number): string {
	const whole = Math.floor(value / 10);
	const tenths = value % 10;
	return tenths === 0 ? `${whole}` : `${whole}.${tenths}`;
}
