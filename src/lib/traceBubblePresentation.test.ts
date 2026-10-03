import { describe, expect, it } from 'vitest';
import type { Character } from './character';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationProjection } from './traceReplyPresentation';
import { createPresentationBubbleShape, bubbleSourceTailConnection, type BubbleTone } from './bubblePresentation';
import { continuationBranchGeometry } from './traceContinuationGeometry';
import { layoutTraceBubblePresentation, traceRootGhostGeometry, type TraceBubblePresentationInput } from './traceBubblePresentation';
import { characterFootprint, gridToWorld, worldToScreen, fieldLocalToViewport } from './geometry';

const character: Character = { characterId: '001', slot: 0, name: 'Test', about: 'Test character', picture: 'characters/001.webp' };
const id = (character: string) => character.repeat(64);
const root: ParsedWorldMessage = {
	id: id('a'), pubkey: id('1'), createdAt: 10, content: 'root', speechType: 'normal', position: { x: 1, y: 1 }
};
const parent: ParsedTraceReply = {
	id: id('b'), pubkey: id('2'), createdAt: 11, content: 'parent', speechType: 'normal', rootId: root.id,
	rootPubkey: root.pubkey, parentId: root.id, parentKind: 42, parentPubkey: root.pubkey
};
const current: ParsedTraceReply = {
	id: id('c'), pubkey: id('3'), createdAt: 12, content: 'current', speechType: 'normal', rootId: root.id,
	rootPubkey: root.pubkey, parentId: parent.id, parentKind: 1111, parentPubkey: parent.pubkey
};
const child: ParsedTraceReply = {
	id: id('d'), pubkey: id('4'), createdAt: 13, content: 'child', speechType: 'normal', rootId: root.id,
	rootPubkey: root.pubkey, parentId: current.id, parentKind: 1111, parentPubkey: current.pubkey
};

function layout(projection: TraceConversationProjection, bubbleSizes: Record<string, { width: number; height: number }>, footprints: Record<string, { width: number; height: number }> = {}, previousLayout?: ReturnType<typeof layoutTraceBubblePresentation>, overrides: Partial<TraceBubblePresentationInput> = {}) {
	const cellSize = overrides.cellSize ?? 100;
	const screen = fieldLocalToViewport(worldToScreen(gridToWorld(projection.root.position, cellSize), overrides.camera ?? { x: 0, y: 0 }), overrides.fieldAreaBounds ?? { x: 0, y: 0 });
		return layoutTraceBubblePresentation({
		projection,
		fixedBubbles: [],
		fixedObstacles: [],
		bubbleSizes,
		traceReplyCardFootprints: footprints,
		traceSafeBounds: { x: 0, y: 0, width: 1000, height: 700 },
		traceVisualRegion: { x: 0, y: 0, width: 1000, height: 700 },
		cellSize: 100,
		camera: { x: 0, y: 0 },
		fieldAreaBounds: { x: 0, y: 0, width: 1000, height: 700 },
		rootSourceBounds: characterFootprint(screen, cellSize),
		fieldRows: 8,
		viewportWidth: 1000,
		defaultBubbleSize: { width: 80, height: 40 },
		characterFor: () => character,
		toneFor: () => 'mint' satisfies BubbleTone,
		...overrides,
		previousLayout
	});
}

describe('trace bubble presentation', () => {
	const rootProjection: TraceConversationProjection = { root, current: { kind: 'root', event: root }, parent: null, directReplies: [], continuationReplyIds: [] };
	it.each([undefined, 'manual', 'death'] as const)('uses the shared 40px preferred connection for root source %s', (source) => {
		const event = { ...root, ...(source ? { source } : {}) };
		const footprint = { x: 420, y: 200, width: 100, height: 100 };
		const result = layout({ ...rootProjection, root: event, current: { kind: 'root', event } }, {}, {}, undefined, { rootSourceBounds: footprint })!;
		expect(result.root.anchor).toEqual(result.rootPreferred);
		expect(footprint.y - result.root.anchor.y - result.root.size.height).toBe(40);
	});
	it('places the root centered above its source without restricting it to field bounds', () => {
		const source = { x: 420, y: 200, width: 100, height: 100 };
		const result = layout(rootProjection, {}, {}, undefined, { rootSourceBounds: source, fieldAreaBounds: { x: 0, y: 200, width: 1000, height: 500 } })!;
		expect(result.root.anchor.x + result.root.size.width / 2).toBe(source.x + source.width / 2);
		expect(result.root.anchor.y + result.root.size.height).toBeLessThan(source.y);
		expect(result.root.anchor.y).toBeLessThan(200);
	});
	it.each([41, 45])('shortens the gap to stay above when the source top is %ipx', (y) => {
		const source = { x: 420, y, width: 100, height: 100 };
		const result = layout(rootProjection, {}, {}, undefined, { rootSourceBounds: source })!;
		expect(result.root.anchor.y).toBe(0);
		expect(result.root.anchor.y + result.root.size.height).toBeLessThanOrEqual(y);
		const connection = bubbleSourceTailConnection(result.root.anchor, result.root.size, source, root.speechType, root.id);
		expect(connection.edge).toBe('bottom');
		expect(connection.tail.target.y).toBe(y);
		expect(connection.tail.target.y).toBeGreaterThan(result.root.anchor.y + result.root.size.height);
	});
	it('falls back without crossing the source when the body cannot fit above', () => {
		const source = { x: 420, y: 20, width: 100, height: 100 };
		const result = layout(rootProjection, {}, {}, undefined, { rootSourceBounds: source })!;
		expect(result.root.anchor.y + result.root.size.height > source.y).toBe(true);
		const rect = { ...result.root.anchor, ...result.root.size };
		expect(rect.x + rect.width <= source.x || rect.x >= source.x + source.width || rect.y >= source.y + source.height).toBe(true);
	});
	it.each(['ui', 'live'] as const)('falls back around the %s obstacle blocking the upper region', (kind) => {
		const obstacle = { id: 'upper', anchor: { x: 0, y: 0 }, size: { width: 1000, height: 200 } };
		const result = layout(rootProjection, {}, {}, undefined, {
			rootSourceBounds: { x: 420, y: 200, width: 100, height: 100 },
			...(kind === 'ui' ? { fixedObstacles: [{ ...obstacle, preferred: obstacle.anchor }] } : { fixedBubbles: [{ ...obstacle, speechType: 'normal', shape: null }] })
		})!;
		expect(result.root.anchor.y).toBeGreaterThanOrEqual(200);
		expect(result.root.anchor.x + result.root.size.width <= 420 || result.root.anchor.x >= 520 || result.root.anchor.y >= 300).toBe(true);
	});
	it('returns from a fixed-live fallback to the source-above preferred anchor when the live bubble disappears', () => {
		const source = { x: 420, y: 200, width: 100, height: 100 };
		const blocked = layout(rootProjection, {}, {}, undefined, {
			rootSourceBounds: source,
			fixedBubbles: [{ id: 'live-upper', anchor: { x: 0, y: 0 }, size: { width: 1000, height: 200 }, speechType: 'normal', shape: null }]
		})!;
		expect(blocked.root.anchor.y).toBeGreaterThanOrEqual(source.y);
		expect(blocked.root.anchor.x + blocked.root.size.width <= source.x || blocked.root.anchor.x >= source.x + source.width || blocked.root.anchor.y >= source.y + source.height).toBe(true);
		const cleared = layout(rootProjection, {}, {}, blocked, { rootSourceBounds: source, fixedBubbles: [] })!;
		expect(cleared.context).toBe(blocked.context);
		expect(cleared.fixedContext).not.toBe(blocked.fixedContext);
		expect(cleared.root.anchor).not.toEqual(blocked.root.anchor);
		expect(cleared.root.anchor).toEqual(cleared.rootPreferred);
		expect(cleared.root.anchor.x + cleared.root.size.width / 2).toBe(source.x + source.width / 2);
		expect(source.y - cleared.root.anchor.y - cleared.root.size.height).toBe(40);
	});
	it('shares normal and compact ghost footprints with the rendering geometry', () => {
		expect(traceRootGhostGeometry({ x: 1, y: 1 }, 100, false)).toEqual({ world: { x: 150, y: 150 }, size: { width: 100, height: 100 }, compact: false });
		expect(traceRootGhostGeometry({ x: 1, y: 1 }, 100, true)).toEqual({ world: { x: 121, y: 177 }, size: { width: 100 * 0.58, height: 100 * 0.58 }, compact: true });
	});
	it('keeps oldest-first siblings in clockwise slots when a newer sibling arrives', () => {
		const siblings = ['d', 'e', 'f', 'g'].map((letter, index) => ({
			...child,
			id: id(letter),
			createdAt: 20 + index
		}));
		const projection = (directReplies: readonly ParsedTraceReply[]): TraceConversationProjection => ({
			root,
			current: { kind: 'reply', event: current },
			parent: { kind: 'reply', event: parent },
			directReplies,
			continuationReplyIds: []
		});
		const sizes = Object.fromEntries([
			[`trace-root-${root.id}`], [`trace-reply-${parent.id}`], [`trace-reply-${current.id}`],
			...siblings.map((reply) => `trace-reply-${reply.id}`)
		].map((key) => [key, { width: 80, height: 40 }]));
		const first = layout(projection(siblings), sizes);
		const second = layout(projection([...siblings, { ...child, id: id('z'), createdAt: 99 }]), {
			...sizes, [`trace-reply-${id('z')}`]: { width: 80, height: 40 }
		});
		expect(first?.cards.filter((card) => card.role === 'child').map((card) => card.reply.id)).toEqual(siblings.map((reply) => reply.id));
		expect(first?.cards.filter((card) => card.role === 'child').map((card) => card.anchor)).toEqual(second?.cards.filter((card) => card.role === 'child').slice(0, 4).map((card) => card.anchor));
	});

	it('keeps presentation body sizes separate from card footprints while placing parent, current, and child cards', () => {
		const bubbleSizes = {
			[`trace-root-${root.id}`]: { width: 100, height: 50 },
			[`trace-reply-${parent.id}`]: { width: 80, height: 40 },
			[`trace-reply-${current.id}`]: { width: 90, height: 55 },
			[`trace-reply-${child.id}`]: { width: 70, height: 50 }
		};
		const footprints = {
			[`trace-reply-${parent.id}`]: { width: 160, height: 100 },
			[`trace-reply-${current.id}`]: { width: 180, height: 120 },
			[`trace-reply-${child.id}`]: { width: 150, height: 90 }
		};
		const result = layout({ root, current: { kind: 'reply', event: current }, parent: { kind: 'reply', event: parent }, directReplies: [child], continuationReplyIds: [child.id] }, bubbleSizes, footprints);
		expect(result?.cards.map((card) => card.role)).toEqual(['parent', 'current', 'child']);
		expect(result?.cards.map((card) => ({ size: card.size, footprint: card.footprint }))).toEqual([
			{ size: bubbleSizes[`trace-reply-${parent.id}`], footprint: footprints[`trace-reply-${parent.id}`] },
			{ size: bubbleSizes[`trace-reply-${current.id}`], footprint: footprints[`trace-reply-${current.id}`] },
			{ size: bubbleSizes[`trace-reply-${child.id}`], footprint: footprints[`trace-reply-${child.id}`] }
		]);
		expect(result?.cards.find((card) => card.reply.id === child.id)?.hasContinuation).toBe(true);
		expect(result?.cards.map((card) => card.anchor)).toEqual([
			{ x: 420, y: 300 }, { x: 590, y: 410 }, { x: 780, y: 540 }
		]);
	});

	it('uses the presentation body size, not the card footprint, to calculate special shapes', () => {
		const shout: ParsedTraceReply = { ...current, id: id('e'), speechType: 'shout', parentId: root.id, parentKind: 42, parentPubkey: root.pubkey };
		const bodySize = { width: 110, height: 54 };
		const footprint = { width: 250, height: 120 };
		const result = layout({ root, current: { kind: 'reply', event: shout }, parent: { kind: 'root', event: root }, directReplies: [], continuationReplyIds: [] }, {
			[`trace-root-${root.id}`]: { width: 100, height: 50 },
			[`trace-reply-${shout.id}`]: bodySize
		}, { [`trace-reply-${shout.id}`]: footprint });
		const card = result?.cards[0];
		expect(card?.size).toEqual(bodySize);
		expect(card?.footprint).toEqual(footprint);
		expect(card?.shape).toEqual(createPresentationBubbleShape('shout', `trace-reply-${shout.id}`, bodySize, 1000, { x: 0, y: 0, width: 1000, height: 700 }));
		expect(card?.shape).not.toEqual(createPresentationBubbleShape('shout', `trace-reply-${shout.id}`, footprint, 1000, { x: 0, y: 0, width: 1000, height: 700 }));
	});

	it('preserves visible reply anchors while changing the current speech', () => {
		const siblings = ['e', 'f', 'g', 'h'].map((letter, index) => ({
			...parent, id: id(letter), createdAt: 20 + index, content: `reply ${letter}`
		}));
		const sizes = Object.fromEntries([
			[`trace-root-${root.id}`], ...siblings.map((reply) => [`trace-reply-${reply.id}`])
		].map(([key]) => [key, { width: 80, height: 40 }]));
		const rootProjection: TraceConversationProjection = { root, current: { kind: 'root', event: root }, parent: null, directReplies: siblings, continuationReplyIds: [] };
		const first = layout(rootProjection, sizes)!;
		const selected = siblings[2];
		const child = { ...current, id: id('i'), parentId: selected.id, parentPubkey: selected.pubkey };
		const nextProjection: TraceConversationProjection = { root, current: { kind: 'reply', event: selected }, parent: { kind: 'root', event: root }, directReplies: [child], continuationReplyIds: [child.id] };
		const second = layout(nextProjection, { ...sizes, [`trace-reply-${child.id}`]: { width: 80, height: 40 } }, {}, first)!;
		const previousSelected = first.cards.find((card) => card.reply.id === selected.id)!;
		const nextSelected = second.cards.find((card) => card.reply.id === selected.id)!;
		expect(nextSelected.anchor).toEqual(previousSelected.anchor);
		expect(second.root.anchor).toEqual(first.root.anchor);
		expect(second.cards.find((card) => card.reply.id === child.id)?.anchor).toEqual({
			x: nextSelected.anchor.x + nextSelected.footprint.width + 10,
			y: nextSelected.anchor.y + nextSelected.footprint.height + 10
		});
		expect(second.cards.find((card) => card.reply.id === child.id)?.hasContinuation).toBe(true);
	});

	it('does not move existing anchors when continuation metadata changes', () => {
		const projection: TraceConversationProjection = { root, current: { kind: 'root', event: root }, parent: null, directReplies: [parent], continuationReplyIds: [] };
		const sizes = { [`trace-root-${root.id}`]: { width: 80, height: 40 }, [`trace-reply-${parent.id}`]: { width: 80, height: 40 } };
		const without = layout(projection, sizes)!;
		const withContinuation = layout({ ...projection, continuationReplyIds: [parent.id] }, sizes, {}, without)!;
		expect(withContinuation.cards[0].anchor).toEqual(without.cards[0].anchor);
		expect(withContinuation.cards[0].hasContinuation).toBe(true);
	});
	it('keeps preserved reply anchors clear when the root compacts during deep navigation', () => {
		const source = { x: 220, y: 367.046875, width: 50, height: 50 };
		const sizes = { [`trace-root-${root.id}`]: { width: 180, height: 53.09375 }, [`trace-reply-${parent.id}`]: { width: 180, height: 60 }, [`trace-reply-${current.id}`]: { width: 177.96875, height: 60 } };
		const first = layout({ root, current: { kind: 'reply', event: parent }, parent: { kind: 'root', event: root }, directReplies: [current], continuationReplyIds: [] }, sizes, {}, undefined, { rootSourceBounds: source })!;
		const previous = { ...first, root: { ...first.root, anchor: { x: 155, y: 179.765625 } }, cards: first.cards.map((card) => ({ ...card, anchor: card.reply.id === parent.id ? { x: 16, y: 111.765625 } : { x: 196.03125, y: 319.5 } })) };
		const next = layout({ root, current: { kind: 'reply', event: current }, parent: { kind: 'reply', event: parent }, directReplies: [child], continuationReplyIds: [] }, { ...sizes, [`trace-root-${root.id}`]: { width: 180, height: 35.546875 } }, {}, previous, { rootSourceBounds: source })!;
		for (const card of previous.cards) expect(next.cards.find((candidate) => candidate.reply.id === card.reply.id)?.anchor).toEqual(card.anchor);
		const keptCurrent = next.cards.find((card) => card.reply.id === current.id)!;
		expect(next.root.anchor.y + next.root.size.height).toBeLessThanOrEqual(keptCurrent.anchor.y);
	});

	it('uses an interior center-based continuation origin for normal and special surfaces', () => {
		const normal = continuationBranchGeometry({ anchor: { x: 100, y: 100 }, size: { width: 120, height: 60 }, shape: null });
		const shoutShape = createPresentationBubbleShape('shout', 'continuation-shout', { width: 120, height: 60 }, 1000, { x: 0, y: 0, width: 1000, height: 700 });
		const shout = continuationBranchGeometry({ anchor: { x: 100, y: 100 }, size: { width: 120, height: 60 }, shape: shoutShape });
		const center = { x: 160, y: 130 };
		for (const branch of [normal, shout]) {
			const offset = { x: branch.start.x - center.x, y: branch.start.y - center.y };
			expect(offset.x).toBeGreaterThan(0);
			expect(offset.y).toBeGreaterThan(0);
			expect(Math.hypot(offset.x, offset.y)).toBeLessThan(30);
			expect(branch.end.x).toBeGreaterThan(branch.start.x);
			expect(branch.end.y).toBeGreaterThan(branch.start.y);
			const bounds = branch === normal ? { x: 0, y: 0, width: 120, height: 60 } : shoutShape!.bounds;
			const surfaceDistance = Math.min((bounds.x + bounds.width + 100 - center.x) / Math.SQRT1_2, (bounds.y + bounds.height + 100 - center.y) / Math.SQRT1_2);
			expect(Math.hypot(branch.end.x - center.x, branch.end.y - center.y) - surfaceDistance).toBeGreaterThan(20);
		}
		expect(normal.start).toEqual(shout.start);
	});

	it('reuses anchors only within the same coordinate context', () => {
		const projection: TraceConversationProjection = { root, current: { kind: 'root', event: root }, parent: null, directReplies: [], continuationReplyIds: [] };
		const sizes = { [`trace-root-${root.id}`]: { width: 80, height: 40 } };
		const first = layout(projection, sizes)!;
		const unchanged = layout(projection, sizes, {}, first)!;
		const moved = layout(projection, sizes, {}, first, { camera: { x: 50, y: 0 } })!;
		const resized = layout(projection, sizes, {}, first, {
			traceSafeBounds: { x: 0, y: 80, width: 1000, height: 420 },
			traceVisualRegion: { x: 0, y: 0, width: 1000, height: 500 }
		})!;
		expect(unchanged.root.anchor).toEqual(first.root.anchor);
		expect(moved.root.anchor).not.toEqual(first.root.anchor);
		expect(moved.root.anchor.x).toBe(60);
		expect(moved.root.anchor.y).toBe(first.root.anchor.y);
		expect(resized.root.anchor).not.toEqual(first.root.anchor);
	});

	it('avoids measured panel obstacles for Trace roots and replies and recalculates when the panel moves', () => {
		const projection: TraceConversationProjection = { root, current: { kind: 'reply', event: current }, parent: { kind: 'root', event: root }, directReplies: [child], continuationReplyIds: [] };
		const sizes = {
			[`trace-root-${root.id}`]: { width: 140, height: 70 },
			[`trace-reply-${current.id}`]: { width: 140, height: 70 },
			[`trace-reply-${child.id}`]: { width: 140, height: 70 }
		};
		const panel = (x: number) => [{ id: 'panel', preferred: { x, y: 0 }, anchor: { x, y: 0 }, size: { width: 440, height: 90 } }];
		const first = layout(projection, sizes, {}, undefined, { fixedObstacles: panel(280) })!;
		const moved = layout(projection, sizes, {}, first, { fixedObstacles: panel(0) })!;
		const intersectsPanel = (anchor: { x: number; y: number }, size: { width: number; height: number }, x: number) =>
			anchor.x < x + 440 && anchor.x + size.width > x && anchor.y < 90 && anchor.y + size.height > 0;
		for (const card of [first.root, ...first.cards]) expect(intersectsPanel(card.anchor, card.footprint, 280)).toBe(false);
		for (const card of [moved.root, ...moved.cards]) expect(intersectsPanel(card.anchor, card.footprint, 0)).toBe(false);
		expect(moved.root.anchor).not.toEqual(first.root.anchor);
		expect(moved.fixedContext).not.toBe(first.fixedContext);
	});
});
