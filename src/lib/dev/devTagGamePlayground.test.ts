import { describe, expect, it } from 'vitest';
import { resolveCharacterFromPubkey } from '../characterAssignment';
import { TAG_GAME_BENEFIT_POINTS_PER_SECOND, TAG_GAME_GAME_MS, TAG_GAME_LIFESPAN_LOSS_MS_PER_SECOND, TAG_GAME_MAX_LIFESPAN_LOSS_MS, TAG_GAME_MAX_POINTS, TAG_GAME_TRANSFER_COOLDOWN_MS, createTagGameSchedule, isValidTagGameState, tagGameScheduledEffectAt } from '../tagGame';
import { createDevTagGamePlayground, DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_BOT_B_PUBKEY, DEV_TAG_GAME_SELF_ID, DEV_TAG_GAME_SELF_PUBKEY } from './devTagGamePlayground';

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
		expect(initial.presence.participants.map((participant) => participant.id)).toEqual([DEV_TAG_GAME_SELF_ID, DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_BOT_B_PUBKEY]);
		expect(playground.propose(10_000).message).toMatch(/2人以上/);
		playground.create(10_000);
		const lobby = playground.addBots(10_000).game!;
		expect(lobby.participant.map((participant) => participant.pubkey)).toEqual([DEV_TAG_GAME_SELF_PUBKEY, DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_BOT_B_PUBKEY]);
		expect(resolveCharacterFromPubkey(DEV_TAG_GAME_BOT_A_PUBKEY)).toBeTruthy();
		expect(resolveCharacterFromPubkey(DEV_TAG_GAME_BOT_B_PUBKEY)).toBeTruthy();
		expect(isValidTagGameState(lobby)).toBe(true);
		expect(playground.propose(10_000).game?.phase).toBe('proposed');
		expect(playground.botConsent(10_000).game?.participant.every((participant) => participant.consented)).toBe(true);
	});

	it('announces each crossed effect boundary once across movement and BOT placement at the same virtual time', () => {
		const { playground, game, nowMs } = startGame(290_321);
		const firstBoundaryMs = nowMs + createTagGameSchedule(game.seed!)[0].durationMs;
		const beforeBoundary = playground.advanceTo(firstBoundaryMs - 1);
		expect(beforeBoundary.sound?.effect).toBe('tag-game-start');

		const crossedBoundary = playground.advanceTo(firstBoundaryMs);
		expect(crossedBoundary.sound?.effect).toBe('tag-game-switch');
		const switchSequence = crossedBoundary.sound!.sequence;

		const movedSelf = playground.moveSelf('left', firstBoundaryMs - 20);
		expect(movedSelf.nowMs).toBe(firstBoundaryMs);
		expect(movedSelf.sound?.sequence).toBe(switchSequence);
		const placedBot = playground.placeBot(DEV_TAG_GAME_BOT_A_PUBKEY, { x: 12, y: 6 }, firstBoundaryMs - 10);
		expect(placedBot.nowMs).toBe(firstBoundaryMs);
		expect(placedBot.sound?.sequence).toBe(switchSequence);
		expect(playground.advanceTo(firstBoundaryMs - 1).sound?.sequence).toBe(switchSequence);

		const afterWallClockCatchUp = playground.advanceTo(firstBoundaryMs + 1);
		expect(afterWallClockCatchUp.sound?.effect).toBe('tag-game-switch');
		expect(afterWallClockCatchUp.sound?.sequence).toBe(switchSequence);
	});

	it('keeps virtual time and the settlement cursor monotonic across fast-forward, stale movement, and wall-clock catch-up', () => {
		const { playground, game, nowMs } = startGame(310_321);
		const fastForwarded = playground.advanceTo(nowMs + 55_000);
		const fastForwardedTotals = fastForwarded.game!.participant.map(({ points, lifespanLossMs, benefitMs, calamityMs }) => ({ points, lifespanLossMs, benefitMs, calamityMs }));
		const moved = playground.moveSelf('right', nowMs + 5_000);
		expect(moved.nowMs).toBe(nowMs + 55_000);
		expect(moved.game?.settledAtMs).toBe(nowMs + 55_000);
		const botMoved = playground.moveBot(DEV_TAG_GAME_BOT_A_PUBKEY, 'left', nowMs + 10_000);
		expect(botMoved.nowMs).toBe(nowMs + 55_000);
		const whileBehind = playground.advanceTo(nowMs + 20_000);
		expect(whileBehind.nowMs).toBe(nowMs + 55_000);
		expect(whileBehind.game?.settledAtMs).toBe(nowMs + 55_000);
		expect(whileBehind.game?.participant.map(({ points, lifespanLossMs, benefitMs, calamityMs }) => ({ points, lifespanLossMs, benefitMs, calamityMs }))).toEqual(fastForwardedTotals);

		const caughtUp = playground.advanceTo(nowMs + 70_000);
		const straightThrough = startGame(310_321).playground.advanceTo(nowMs + 70_000);
		expect(caughtUp.nowMs).toBe(nowMs + 70_000);
		expect(caughtUp.game?.settledAtMs).toBe(nowMs + 70_000);
		expect(caughtUp.game?.participant).toEqual(straightThrough.game?.participant);
		expect(caughtUp.game?.participant.some((member) => member.points > 0 || member.lifespanLossMs > 0)).toBe(true);
	});

	it('requires the self touch direction to point at the adjacent BOT holder during benefit', () => {
		const { playground, game, nowMs } = startGame(410_543);
		const schedule = createTagGameSchedule(game.seed!);
		let benefitOffset = 0;
		for (const interval of schedule) {
			if (interval.effect === 'benefit') break;
			benefitOffset += interval.durationMs;
		}
		const firstTouchAt = nowMs + benefitOffset + TAG_GAME_TRANSFER_COOLDOWN_MS;
		playground.advanceTo(firstTouchAt);
		const self = playground.snapshot.presence.participants.find((entry) => entry.id === DEV_TAG_GAME_SELF_ID)!.position;
		const botPosition = { x: self.x + 1, y: self.y };
		playground.placeBot(DEV_TAG_GAME_BOT_A_PUBKEY, botPosition, firstTouchAt);
		const botTouch = playground.touch(DEV_TAG_GAME_BOT_A_PUBKEY, DEV_TAG_GAME_SELF_PUBKEY, firstTouchAt, 'left');
		expect(botTouch.game?.ownerPubkey).toBe(DEV_TAG_GAME_BOT_A_PUBKEY);

		const wrongDirection = playground.touch(DEV_TAG_GAME_SELF_PUBKEY, DEV_TAG_GAME_BOT_A_PUBKEY, firstTouchAt + TAG_GAME_TRANSFER_COOLDOWN_MS, 'up');
		expect(wrongDirection.game?.ownerPubkey).toBe(DEV_TAG_GAME_BOT_A_PUBKEY);
		expect(wrongDirection.message).toMatch(/その方向/);
		const correctDirection = playground.touch(DEV_TAG_GAME_SELF_PUBKEY, DEV_TAG_GAME_BOT_A_PUBKEY, firstTouchAt + TAG_GAME_TRANSFER_COOLDOWN_MS + 1, 'right');
		expect(correctDirection.game?.ownerPubkey).toBe(DEV_TAG_GAME_SELF_PUBKEY);
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
