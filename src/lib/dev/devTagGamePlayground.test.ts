import { describe, expect, it } from 'vitest';
import { TAG_GAME_BENEFIT_POINTS_PER_SECOND, TAG_GAME_GAME_MS, TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND, TAG_GAME_MAX_LIFESPAN_LOSS_MS, TAG_GAME_MAX_POINTS, TAG_GAME_TRANSFER_COOLDOWN_MS, createTagGameSchedule, isValidTagGameState, tagGameScheduledEffectAt } from '../tagGame';
import { createDevTagGamePlayground, DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_SELF_ID, DEV_TAG_GAME_SELF_PUBKEY } from './devTagGamePlayground';

const FIELD = { columns: 16, rows: 8 };

function startGame(nowMs: number) {
	const playground = createDevTagGamePlayground(FIELD, nowMs);
	playground.create(nowMs);
	playground.addBots(nowMs);
	const proposed = playground.propose(nowMs);
	expect(proposed.game?.phase).toBe('proposed');
	const countdown = playground.botConsent(nowMs);
	expect(countdown.game?.phase).toBe('countdown');
	const startAtMs = countdown.game!.startAt! * 1_000;
	const started = playground.advanceTo(startAtMs);
	return { playground, game: started.game!, nowMs: startAtMs };
}

describe('DEV Tag Game Playground', () => {
	it('keeps a deterministic self/BOT fixture, requires participation before proposal, and uses valid TagGameState identity', () => {
		const playground = createDevTagGamePlayground(FIELD, 10_000);
		const initial = playground.snapshot;
		expect(initial.presence.participants.map((participant) => participant.id)).toEqual([DEV_TAG_GAME_SELF_ID, 'b'.repeat(64), 'c'.repeat(64)]);
		expect(playground.propose(10_000).message).toMatch(/2人以上/);
		playground.create(10_000);
		const lobby = playground.addBots(10_000).game!;
		expect(lobby.participant.map((participant) => participant.pubkey)).toEqual([DEV_TAG_GAME_SELF_PUBKEY, DEV_TAG_GAME_BOT_A_PUBKEY, 'c'.repeat(64)]);
		expect(isValidTagGameState(lobby)).toBe(true);
		expect(playground.propose(10_000).game?.phase).toBe('proposed');
		expect(playground.botConsent(10_000).game?.participant.every((participant) => participant.consented)).toBe(true);
	});

	it('accepts valid self and BOT touches, transfers the holder, and enforces the production cooldown', () => {
		const { playground, game, nowMs } = startGame(100_123);
		const self = playground.snapshot.presence.participants.find((entry) => entry.id === DEV_TAG_GAME_SELF_ID)!.position;
		const botPosition = { x: self.x + (self.x + 1 < FIELD.columns ? 1 : -1), y: self.y };
		playground.placeBot(DEV_TAG_GAME_BOT_A_PUBKEY, botPosition, nowMs);
		playground.advanceTo(nowMs + TAG_GAME_TRANSFER_COOLDOWN_MS);
		const effect = tagGameScheduledEffectAt(game, nowMs)!;
		const actor = effect === 'benefit' ? DEV_TAG_GAME_BOT_A_PUBKEY : DEV_TAG_GAME_SELF_PUBKEY;
		const target = effect === 'benefit' ? DEV_TAG_GAME_SELF_PUBKEY : DEV_TAG_GAME_BOT_A_PUBKEY;
		const touchAtMs = nowMs + TAG_GAME_TRANSFER_COOLDOWN_MS;
		const touched = playground.touch(actor, target, touchAtMs);
		expect(touched.game?.ownerPubkey).toBe(effect === 'benefit' ? actor : target);
		expect(touched.sound?.effect).toBe('tag-game-transfer');
		expect(isValidTagGameState(touched.game)).toBe(true);
		const blocked = playground.touch(target, actor, touchAtMs + TAG_GAME_TRANSFER_COOLDOWN_MS - 1);
		expect(blocked.game?.ownerPubkey).toBe(effect === 'benefit' ? actor : target);
		expect(blocked.message).toMatch(/クールダウン/);
		const transferredBack = playground.touch(target, actor, touchAtMs + TAG_GAME_TRANSFER_COOLDOWN_MS);
		expect(transferredBack.game?.ownerPubkey).toBe(DEV_TAG_GAME_SELF_PUBKEY);
	});

	it('settles every crossed effect interval during a time jump and freezes totals after the production game end', () => {
		const { playground, game } = startGame(200_500);
		const startedAtMs = game.startedAt! * 1_000;
		const schedule = createTagGameSchedule(game.seed!);
		const expectedBenefitMs = schedule.filter((interval) => interval.effect === 'benefit').reduce((total, interval) => total + interval.durationMs, 0);
		const expectedCalamityMs = schedule.filter((interval) => interval.effect === 'calamity').reduce((total, interval) => total + interval.durationMs, 0);
		const end = playground.advanceTo(startedAtMs + TAG_GAME_GAME_MS + 1);
		expect(end.game?.phase).toBe('ended');
		const self = end.game!.participant.find((member) => member.pubkey === DEV_TAG_GAME_SELF_PUBKEY)!;
		expect(self.benefitMs).toBe(expectedBenefitMs);
		expect(self.calamityMs).toBe(expectedCalamityMs);
		expect(self.points).toBe(Math.min(TAG_GAME_MAX_POINTS, Math.floor(expectedBenefitMs * TAG_GAME_BENEFIT_POINTS_PER_SECOND / 1_000)));
		expect(self.lifespanLossMs).toBe(Math.min(TAG_GAME_MAX_LIFESPAN_LOSS_MS, Math.floor(expectedCalamityMs * TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND / 1_000)));
		expect(end.sound?.effect).toBe('tag-game-end');
		const frozen = playground.advanceTo(startedAtMs + TAG_GAME_GAME_MS + 60_000);
		expect(frozen.game?.participant).toEqual(end.game?.participant);
		expect(frozen.game?.settledAtMs).toBe(end.game?.settledAtMs);
		expect(frozen.game?.phase).toBe('ended');
	});
});
