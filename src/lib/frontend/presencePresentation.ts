import { BUBBLE_TONES, type BubbleTone } from '../bubblePresentation';
import { CHARACTER_CATALOG, type Character } from '../character';
import { deriveCharacterFromPubkey } from '../characterAssignment';
import { DEV_WORLD_SELF_ID, getDevWorldCharacter } from '../devWorldSandbox';
import type { PresenceState } from '../presence';
import { projectPresence, type PresenceProjectionOptions } from '../presenceProjection';

export type Participant = {
	id: string;
	character: Character;
	color: BubbleTone;
};

export function allocateParticipantColors(
	previousColors: Readonly<Record<string, BubbleTone>>,
	participantIds: readonly string[]
): Record<string, BubbleTone> {
	const activeIds = [...participantIds].sort();
	const nextColors: Record<string, BubbleTone> = {};
	const used = new Set<BubbleTone>();
	for (const id of activeIds) {
		const retained = previousColors[id];
		if (retained) {
			nextColors[id] = retained;
			used.add(retained);
		}
	}
	for (const id of activeIds) {
		if (nextColors[id]) continue;
		const color = BUBBLE_TONES.find((candidate) => !used.has(candidate)) ?? BUBBLE_TONES[activeIds.indexOf(id) % BUBBLE_TONES.length];
		nextColors[id] = color;
		used.add(color);
	}
	return nextColors;
}

export function projectFrontendPresence(input: Readonly<{
	presence: PresenceState;
	selectedCharacterId: string;
	selfProjectionId: string;
	geometry: PresenceProjectionOptions;
	colors: Readonly<Record<string, BubbleTone>>;
}>) {
	const participants: Participant[] = input.presence.participants
		.filter((participant) => participant.status === 'active')
		.map((participant) => ({
			id: participant.id,
			character: participant.id === DEV_WORLD_SELF_ID
				? getDevWorldCharacter(input.selectedCharacterId)
				: deriveCharacterFromPubkey(participant.id, CHARACTER_CATALOG),
			color: input.colors[participant.id] ?? BUBBLE_TONES[0]
		}));
	return projectPresence(input.presence, participants, input.geometry, input.selfProjectionId);
}
