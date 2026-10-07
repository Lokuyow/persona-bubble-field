import { describe, expect, it } from 'vitest';
import {
	buildWorldMessageTemplate,
	buildDeathTraceEventTemplate,
	buildManualTraceEventTemplate,
	finalizeWorldEvent,
	type ChannelReference
} from './nostrProtocol';
import { selectEffectiveTraceRoots } from './traceRoots';

const CHANNEL_ID = 'a'.repeat(64);
const SECRET_KEY = new Uint8Array(32).fill(30);
const channel: ChannelReference = { channelId: CHANNEL_ID, relayHint: 'wss://relay.example.com' };

function root(
	options: Partial<{
		channelId: string;
		createdAt: number;
		position: { x: number; y: number };
		speechType: 'normal' | 'shout' | 'monologue';
		nonce: string;
	}> = {}
) {
	return finalizeWorldEvent(buildWorldMessageTemplate({
		channel: { ...channel, channelId: options.channelId ?? CHANNEL_ID },
		content: options.nonce ?? 'root',
		createdAt: options.createdAt ?? 100,
		position: options.position ?? { x: 0, y: 0 },
		speechType: options.speechType ?? 'normal'
	}), SECRET_KEY);
}

function lotteryRoot(options: Parameters<typeof root>[0] = {}, wins = true) {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const event = root({ ...options, nonce: `${options.nonce ?? 'root'}-${attempt}` });
		if ((BigInt(`0x${event.id}`) % 5n === 0n) === wins) return event;
	}
	throw new Error('Could not make a deterministic lottery fixture.');
}

function deathTrace(content = 'last words', createdAt = 200, position = { x: 4, y: 2 }) {
	for (let attempt = 0; attempt < 10_000; attempt += 1) {
		const event = finalizeWorldEvent(buildDeathTraceEventTemplate({
			channel,
			content: `${content}-${attempt}`,
			createdAt,
			position
		}), SECRET_KEY);
		if (BigInt(`0x${event.id}`) % 5n !== 0n) return event;
	}
	throw new Error('Could not make a deterministic death trace fixture.');
}

function manualTrace(content: string, createdAt: number, position: { x: number; y: number }) {
	return finalizeWorldEvent(buildManualTraceEventTemplate({ channel, content, createdAt, position, speechType: 'normal' }), SECRET_KEY);
}

describe('trace root selection', () => {
	it('validates channel IDs even when no raw events are supplied', () => {
		expect(() => selectEffectiveTraceRoots([], 'A'.repeat(64), { columns: 1, rows: 1 })).toThrow(TypeError);
	});

	it.each([
		{ columns: 0, rows: 1 }, { columns: 1, rows: 0 }, { columns: 1.5, rows: 1 },
		{ columns: Number.MAX_SAFE_INTEGER, rows: 2 }
	])('rejects invalid field dimensions %#', (field) => {
		expect(() => selectEffectiveTraceRoots([], CHANNEL_ID, field)).toThrow(TypeError);
	});

	it('uses the exact event-ID modulo lottery for every speech type', () => {
		const winners = (['normal', 'shout', 'monologue'] as const).map((speechType, index) =>
			lotteryRoot({ speechType, position: { x: index, y: 0 }, nonce: speechType }, true)
		);
		const loser = lotteryRoot({ position: { x: 3, y: 0 }, nonce: 'loser' }, false);

		expect(selectEffectiveTraceRoots([...winners, loser], CHANNEL_ID, { columns: 8, rows: 8 })
			.map((candidate) => candidate.id).sort()).toEqual(winners.map((event) => event.id).sort());
	});

	it('projects a dedicated death trace into the existing clickable root projection', () => {
		const event = deathTrace();
		const roots = selectEffectiveTraceRoots([event, event], CHANNEL_ID, { columns: 20, rows: 10 });
		const [root] = roots;
		expect(root).toMatchObject({ id: event.id, content: expect.stringContaining('last words'), source: 'death', speechType: 'normal' });
		expect(roots).toHaveLength(1);
	});

	it('admits manual traces without the normal lottery and reserves five percent for each source', () => {
		const candidates = [
			...Array.from({ length: 12 }, (_, index) => lotteryRoot({ createdAt: index + 10, position: { x: index % 10, y: Math.floor(index / 10) }, nonce: `quota-normal-${index}` }, true)),
			...Array.from({ length: 12 }, (_, index) => manualTrace(`quota-manual-${index}`, index + 30, { x: (index + 12) % 10, y: Math.floor((index + 12) / 10) })),
			...Array.from({ length: 12 }, (_, index) => deathTrace(`quota-death-${index}`, index + 50, { x: (index + 24) % 10, y: Math.floor((index + 24) / 10) }))
		];
		const roots = selectEffectiveTraceRoots(candidates, CHANNEL_ID, { columns: 10, rows: 10 });
		expect(roots).toHaveLength(15);
		expect(roots.filter((root) => !root.source)).toHaveLength(5);
		expect(roots.filter((root) => root.source === 'manual')).toHaveLength(5);
		expect(roots.filter((root) => root.source === 'death')).toHaveLength(5);
	});

	it('prefers explicit roots in a cell and the newer explicit kind when manual and death compete', () => {
		const normal = lotteryRoot({ createdAt: 300, position: { x: 0, y: 0 }, nonce: 'cell-normal' }, true);
		const manual = manualTrace('cell-manual', 100, { x: 0, y: 0 });
		const death = finalizeWorldEvent(buildDeathTraceEventTemplate({ channel, content: 'cell-death', createdAt: 101, position: { x: 0, y: 0 } }), SECRET_KEY);
		expect(selectEffectiveTraceRoots([normal, manual, death], CHANNEL_ID, { columns: 10, rows: 10 }).map((root) => root.id)).toEqual([death.id]);
	});

	it('rejects out-of-bounds roots and retains roots regardless of age', () => {
		const old = lotteryRoot({ createdAt: 0, position: { x: 1, y: 0 }, nonce: 'old' });
		const outside = lotteryRoot({ position: { x: 2, y: 0 }, nonce: 'outside' });
		expect(selectEffectiveTraceRoots([old, outside], CHANNEL_ID, { columns: 2, rows: 10 }).map((root) => root.id))
			.toEqual([old.id]);
	});

	it('deduplicates by ID and is independent of input order', () => {
		const roots = [
			lotteryRoot({ createdAt: 10, position: { x: 0, y: 0 }, nonce: 'one' }),
			lotteryRoot({ createdAt: 11, position: { x: 1, y: 0 }, nonce: 'two' })
		];
		const first = selectEffectiveTraceRoots([...roots, roots[0]], CHANNEL_ID, { columns: 20, rows: 1 });
		const second = selectEffectiveTraceRoots([...roots].reverse(), CHANNEL_ID, { columns: 20, rows: 1 });
		expect(first.map((root) => root.id)).toEqual(second.map((root) => root.id));
		expect(first).toHaveLength(2);
	});

	it('keeps only the newest root per cell with lexical ID tie-breaking', () => {
		const tied = Array.from({ length: 4 }, (_, index) =>
			lotteryRoot({ createdAt: 50, position: { x: 0, y: 0 }, nonce: `tie-${index}` })
		);
		const expected = [...tied].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
			.slice(0, 1).map((event) => event.id);
		expect(selectEffectiveTraceRoots(tied.reverse(), CHANNEL_ID, { columns: 30, rows: 1 }).map((root) => root.id))
			.toEqual(expected);
	});

	it('does not let one cell affect the newest root selected from another cell', () => {
		const sameCell = [
			lotteryRoot({ createdAt: 1, position: { x: 0, y: 0 }, nonce: 'same-old' }),
			lotteryRoot({ createdAt: 2, position: { x: 0, y: 0 }, nonce: 'same-new' })
		];
		const otherCell = lotteryRoot({ createdAt: 1, position: { x: 1, y: 0 }, nonce: 'other' });
		expect(selectEffectiveTraceRoots([otherCell, sameCell[0], sameCell[1]], CHANNEL_ID, { columns: 20, rows: 1 }).map((root) => root.id))
			.toEqual([sameCell[1].id, otherCell.id]);
	});

	it('applies the global cap with lexical ID tie-breaking', () => {
		const tied = Array.from({ length: 4 }, (_, index) =>
			lotteryRoot({ createdAt: 50, position: { x: index, y: 0 }, nonce: `global-${index}` })
		);
		const expected = [...tied].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
			.slice(0, 12).map((event) => event.id);
		expect(selectEffectiveTraceRoots(tied, CHANNEL_ID, { columns: 16, rows: 8 }).map((root) => root.id))
			.toEqual(expected);
	});

	it('applies the 15 percent cap on a 16 by 8 field', () => {
		const roots = Array.from({ length: 25 }, (_, index) =>
			lotteryRoot({ createdAt: 50 + index, position: { x: index % 16, y: Math.floor(index / 16) }, nonce: `cap-${index}` })
		);
		const expected = [...roots].sort((first, second) => second.created_at - first.created_at ||
			(first.id < second.id ? -1 : first.id > second.id ? 1 : 0)).slice(0, 19).map((event) => event.id);
		expect(selectEffectiveTraceRoots(roots, CHANNEL_ID, { columns: 16, rows: 8 }).map((root) => root.id))
			.toEqual(expected);
	});

	it('evicts an old root when a newer root occupies the same cell', () => {
		const old = lotteryRoot({ createdAt: 1, position: { x: 0, y: 0 }, nonce: 'old' });
		const newest = lotteryRoot({ createdAt: 3, position: { x: 0, y: 0 }, nonce: 'newest' });
		expect(selectEffectiveTraceRoots([old, newest], CHANNEL_ID, { columns: 20, rows: 1 }).map((root) => root.id))
			.toEqual([newest.id]);
	});
});
