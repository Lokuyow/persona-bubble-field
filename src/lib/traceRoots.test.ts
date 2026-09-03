import { describe, expect, it } from 'vitest';
import {
	buildWorldMessageTemplate,
	finalizeWorldEvent,
	type ChannelReference
} from './nostrProtocol';
import { selectEffectiveTraceRoots } from './traceRoots';

const CHANNEL_ID = 'a'.repeat(64);
const SECRET_KEY = new Uint8Array(32).fill(7);
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
		const winners = (['normal', 'shout', 'monologue'] as const).map((speechType) =>
			lotteryRoot({ speechType, nonce: speechType }, true)
		);
		const loser = lotteryRoot({ nonce: 'loser' }, false);

		expect(selectEffectiveTraceRoots([...winners, loser], CHANNEL_ID, { columns: 8, rows: 8 })
			.map((candidate) => candidate.id).sort()).toEqual(winners.map((event) => event.id).sort());
	});

	it('rejects out-of-bounds roots and retains roots regardless of age', () => {
		const old = lotteryRoot({ createdAt: 0, position: { x: 1, y: 0 }, nonce: 'old' });
		const outside = lotteryRoot({ position: { x: 2, y: 0 }, nonce: 'outside' });
		expect(selectEffectiveTraceRoots([old, outside], CHANNEL_ID, { columns: 2, rows: 1 }).map((root) => root.id))
			.toEqual([old.id]);
	});

	it('deduplicates by ID and is independent of input order', () => {
		const roots = [
			lotteryRoot({ createdAt: 10, position: { x: 0, y: 0 }, nonce: 'one' }),
			lotteryRoot({ createdAt: 11, position: { x: 1, y: 0 }, nonce: 'two' })
		];
		const first = selectEffectiveTraceRoots([...roots, roots[0]], CHANNEL_ID, { columns: 4, rows: 1 });
		const second = selectEffectiveTraceRoots([...roots].reverse(), CHANNEL_ID, { columns: 4, rows: 1 });
		expect(first.map((root) => root.id)).toEqual(second.map((root) => root.id));
		expect(first).toHaveLength(2);
	});

	it('keeps the newest three roots per cell with lexical ID tie-breaking', () => {
		const tied = Array.from({ length: 4 }, (_, index) =>
			lotteryRoot({ createdAt: 50, position: { x: 0, y: 0 }, nonce: `tie-${index}` })
		);
		const expected = [...tied].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
			.slice(0, 3).map((event) => event.id);
		expect(selectEffectiveTraceRoots(tied.reverse(), CHANNEL_ID, { columns: 8, rows: 1 }).map((root) => root.id))
			.toEqual(expected);
	});

	it('applies the global cap with lexical ID tie-breaking', () => {
		const tied = Array.from({ length: 4 }, (_, index) =>
			lotteryRoot({ createdAt: 50, position: { x: index, y: 0 }, nonce: `global-${index}` })
		);
		const expected = [...tied].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
			.slice(0, 2).map((event) => event.id);
		expect(selectEffectiveTraceRoots(tied, CHANNEL_ID, { columns: 4, rows: 1 }).map((root) => root.id))
			.toEqual(expected);
	});

	it('evicts an old root only when a newer root exceeds a cap', () => {
		const old = lotteryRoot({ createdAt: 1, position: { x: 0, y: 0 }, nonce: 'old' });
		const middle = lotteryRoot({ createdAt: 2, position: { x: 1, y: 0 }, nonce: 'middle' });
		const newest = lotteryRoot({ createdAt: 3, position: { x: 2, y: 0 }, nonce: 'newest' });
		expect(selectEffectiveTraceRoots([old, middle], CHANNEL_ID, { columns: 4, rows: 1 }).map((root) => root.id))
			.toEqual([middle.id, old.id]);
		expect(selectEffectiveTraceRoots([old, middle, newest], CHANNEL_ID, { columns: 4, rows: 1 }).map((root) => root.id))
			.toEqual([newest.id, middle.id]);
	});
});
