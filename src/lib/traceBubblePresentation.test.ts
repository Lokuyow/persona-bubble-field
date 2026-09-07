import { describe, expect, it } from 'vitest';
import type { Character } from './character';
import type { ParsedTraceReply, ParsedWorldMessage } from './nostrProtocol';
import type { TraceConversationProjection } from './traceReplyPresentation';
import { createPresentationBubbleShape, type BubbleTone } from './bubblePresentation';
import { layoutTraceBubblePresentation } from './traceBubblePresentation';

const character: Character = { characterId: '001', name: 'Test', about: 'Test character', picture: 'characters/001.webp' };
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

function layout(projection: TraceConversationProjection, bubbleSizes: Record<string, { width: number; height: number }>, footprints: Record<string, { width: number; height: number }> = {}, previousLayout?: ReturnType<typeof layoutTraceBubblePresentation>) {
	return layoutTraceBubblePresentation({
		projection,
		fixedBubbles: [],
		bubbleSizes,
		traceReplyCardFootprints: footprints,
		bubbleSafeBounds: { x: 0, y: 0, width: 1000, height: 700 },
		bubbleVisualRegion: { x: 0, y: 0, width: 1000, height: 700 },
		cellSize: 100,
		camera: { x: 0, y: 0 },
		fieldAreaBounds: { x: 0, y: 0, width: 1000, height: 700 },
		fieldRows: 8,
		viewportWidth: 1000,
		defaultBubbleSize: { width: 80, height: 40 },
		characterFor: () => character,
		toneFor: () => 'mint' satisfies BubbleTone,
		previousLayout
	});
}

describe('trace bubble presentation', () => {
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
			directReplies
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
		const result = layout({ root, current: { kind: 'reply', event: current }, parent: { kind: 'reply', event: parent }, directReplies: [child] }, bubbleSizes, footprints);
		expect(result?.cards.map((card) => card.role)).toEqual(['parent', 'current', 'child']);
		expect(result?.cards.map((card) => ({ size: card.size, footprint: card.footprint }))).toEqual([
			{ size: bubbleSizes[`trace-reply-${parent.id}`], footprint: footprints[`trace-reply-${parent.id}`] },
			{ size: bubbleSizes[`trace-reply-${current.id}`], footprint: footprints[`trace-reply-${current.id}`] },
			{ size: bubbleSizes[`trace-reply-${child.id}`], footprint: footprints[`trace-reply-${child.id}`] }
		]);
		expect(result?.cards.map((card) => card.anchor)).toEqual([
			{ x: 420, y: 300 }, { x: 590, y: 410 }, { x: 780, y: 540 }
		]);
	});

	it('uses the presentation body size, not the card footprint, to calculate special shapes', () => {
		const shout: ParsedTraceReply = { ...current, id: id('e'), speechType: 'shout', parentId: root.id, parentKind: 42, parentPubkey: root.pubkey };
		const bodySize = { width: 110, height: 54 };
		const footprint = { width: 250, height: 120 };
		const result = layout({ root, current: { kind: 'reply', event: shout }, parent: { kind: 'root', event: root }, directReplies: [] }, {
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
		const rootProjection: TraceConversationProjection = { root, current: { kind: 'root', event: root }, parent: null, directReplies: siblings };
		const first = layout(rootProjection, sizes)!;
		const selected = siblings[2];
		const child = { ...current, id: id('i'), parentId: selected.id, parentPubkey: selected.pubkey };
		const nextProjection: TraceConversationProjection = { root, current: { kind: 'reply', event: selected }, parent: { kind: 'root', event: root }, directReplies: [child] };
		const second = layout(nextProjection, { ...sizes, [`trace-reply-${child.id}`]: { width: 80, height: 40 } }, {}, first)!;
		const previousSelected = first.cards.find((card) => card.reply.id === selected.id)!;
		const nextSelected = second.cards.find((card) => card.reply.id === selected.id)!;
		expect(nextSelected.anchor).toEqual(previousSelected.anchor);
		expect(second.root.anchor).toEqual(first.root.anchor);
		expect(second.cards.find((card) => card.reply.id === child.id)?.anchor).toEqual({
			x: nextSelected.anchor.x + nextSelected.footprint.width + 10,
			y: nextSelected.anchor.y + nextSelected.footprint.height + 10
		});
	});
});
