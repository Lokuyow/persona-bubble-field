import {
	clampCamera,
	fieldLocalToViewport,
	getActualFieldTop,
	getSameCellVisualOffset,
	gridToWorld,
	worldToScreen,
	type Bounds,
	type FieldSize,
	type GridPosition,
	type Size,
	type WorldPoint
} from './geometry';
import { getParticipant, type PresenceParticipant, type PresenceState } from './presence';

export type ProjectionParticipant = {
	id: string;
};

export type ProjectedParticipant<T extends ProjectionParticipant> = T & PresenceParticipant & {
	position: GridPosition;
	world: WorldPoint;
	screen: WorldPoint;
};

export type PresenceProjectionOptions = {
	cellSize: number;
	fieldAreaBounds: Bounds;
	fieldWorldSize: Size;
};

export type PresenceProjection<T extends ProjectionParticipant> = {
	camera: WorldPoint;
	actualFieldTop: number;
	participants: ProjectedParticipant<T>[];
	visibleParticipantIds: Set<string>;
};

function isInsideFieldArea(point: WorldPoint, fieldAreaBounds: Bounds, actualFieldTop: number): boolean {
	return (
		point.x >= fieldAreaBounds.x &&
		point.x <= fieldAreaBounds.x + fieldAreaBounds.width &&
		point.y >= actualFieldTop &&
		point.y <= fieldAreaBounds.y + fieldAreaBounds.height
	);
}

export function projectPresence<T extends ProjectionParticipant>(
	state: PresenceState,
	participants: readonly T[],
	options: PresenceProjectionOptions,
	selfId = 'you'
): PresenceProjection<T> {
	const self = getParticipant(state, selfId);
	const fallbackSelfPosition = self?.position ?? { x: 0, y: 0 };
	const camera = clampCamera(
		gridToWorld(fallbackSelfPosition, options.cellSize),
		{ width: options.fieldAreaBounds.width, height: options.fieldAreaBounds.height },
		options.fieldWorldSize
	);
	const actualFieldTop = getActualFieldTop(options.fieldAreaBounds, camera);
	const activeParticipants = participants
		.map((participant) => ({ participant, presence: getParticipant(state, participant.id) }))
		.filter((entry): entry is { participant: T; presence: PresenceParticipant } =>
			Boolean(entry.presence && entry.presence.status === 'active')
		);
	const projected = activeParticipants.map(({ participant, presence }) => {
		const sameCellIds = activeParticipants
			.filter((entry) =>
				entry.presence.position.x === presence.position.x &&
				entry.presence.position.y === presence.position.y
			)
			.map((entry) => entry.participant.id);
		const visualOffset = getSameCellVisualOffset(participant.id, sameCellIds, options.cellSize);
		const worldPoint = gridToWorld(presence.position, options.cellSize);
		const world = { x: worldPoint.x + visualOffset.x, y: worldPoint.y + visualOffset.y };
		const screen = fieldLocalToViewport(worldToScreen(world, camera), options.fieldAreaBounds);
		return { ...participant, ...presence, position: presence.position, world, screen };
	});

	return {
		camera,
		actualFieldTop,
		participants: projected,
		visibleParticipantIds: new Set(
			projected
				.filter((participant) => isInsideFieldArea(participant.screen, options.fieldAreaBounds, actualFieldTop))
				.map((participant) => participant.id)
		)
	};
}
