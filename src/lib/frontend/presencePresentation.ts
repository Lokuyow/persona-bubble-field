import { BUBBLE_TONES, type BubbleTone } from '../bubblePresentation';
import type { Character } from '../character';
import { requireCharacterFromPubkey } from '../characterAssignment';
import { DEV_WORLD_SELF_ID, getDevWorldCharacter, getDevWorldFixtureCharacter } from '../devWorldSandbox';
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
	const characterForParticipant = (id: string): Character => {
		if (id === DEV_WORLD_SELF_ID) return getDevWorldCharacter(input.selectedCharacterId);
		try {
			return requireCharacterFromPubkey(id);
		} catch (error) {
			if (input.selfProjectionId === DEV_WORLD_SELF_ID) return getDevWorldFixtureCharacter(id, input.selectedCharacterId);
			throw error;
		}
	};
	const participants: Participant[] = input.presence.participants
		.filter((participant) => participant.status === 'active')
		.map((participant) => ({
			id: participant.id,
			character: characterForParticipant(participant.id),
			color: input.colors[participant.id] ?? BUBBLE_TONES[0]
		}));
	return projectPresence(input.presence, participants, input.geometry, input.selfProjectionId);
}
