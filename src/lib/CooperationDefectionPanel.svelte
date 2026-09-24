<script lang="ts">
	import { getCooperationDefectionRoundSchedule, cooperationDefectionPhaseLabel, COOPERATION_DEFECTION_MIN_PARTICIPANTS, type CooperationDefectionChoice, type CooperationDefectionRoundResult, type CooperationDefectionSchedule, type CooperationDefectionSessionState } from '$lib/cooperationDefection';

	type Props = Readonly<{
		schedule: CooperationDefectionSchedule;
		nowMs: number;
		registrationDeadline: string | null;
		registrationCountdown: string | null;
		status: 'inactive' | 'active' | 'degraded';
		session: CooperationDefectionSessionState | null;
		selfGroupId: string | null;
		cancelled: boolean;
		selfPubkey: string | null;
		participantName: (pubkey: string) => string;
		selectedChoice: CooperationDefectionChoice | null;
		commitStatus: string | null;
		canChoose: boolean;
		message: string | null;
		onChoice: (choice: CooperationDefectionChoice) => void;
	}>;

	let { schedule, nowMs, registrationDeadline, registrationCountdown, status, session, selfGroupId, cancelled, selfPubkey, participantName, selectedChoice, commitStatus, canChoose, message, onChoice }: Props = $props();
	let selfGroupCancelled = $derived(cancelled && schedule.phase === 'game');
	let cancellationNoticeKey = $derived(selfGroupCancelled && selfGroupId ? `${schedule.instanceId}:${selfGroupId}` : null);
	let dismissedCancellationKey = $state<string | null>(null);
	let cancellationNoticeVisible = $derived(Boolean(cancellationNoticeKey && dismissedCancellationKey !== cancellationNoticeKey));
	let lastRoundResult = $derived(selfGroupCancelled ? null : session?.results.filter((result) => result.groupId === selfGroupId).at(-1) ?? null);
	let hasPlayableGroups = $derived(Boolean(session?.participantSnapshot && Object.values(session.participantSnapshot).some((participants) => participants.length >= COOPERATION_DEFECTION_MIN_PARTICIPANTS)));

	$effect(() => {
		const key = cancellationNoticeKey;
		if (!key) return;
		const timeout = window.setTimeout(() => { dismissedCancellationKey = key; }, 5_000);
		return () => window.clearTimeout(timeout);
	});

	let roundInfo = $derived.by(() => {
		if (schedule.phase !== 'game' || selfGroupCancelled || !hasPlayableGroups) return null;
		for (const round of [1, 2, 3] as const) {
			const current = getCooperationDefectionRoundSchedule(schedule, round);
			if (nowMs < current.endedAtMs) return {
				round,
				phase: nowMs < current.selectionAtMs ? '相談' : nowMs < current.resultAtMs ? '選択' : '結果発表',
				remainingMs: Math.max(0, (nowMs < current.selectionAtMs ? current.selectionAtMs : nowMs < current.resultAtMs ? current.resultAtMs : current.endedAtMs) - nowMs)
			};
		}
		return { round: 3 as const, phase: '終了', remainingMs: 0 };
	});

	function formatRemaining(value: number): string {
		return `${Math.ceil(value / 1000)}秒`;
	}

	function labels(pubkeys: readonly string[]): string {
		return pubkeys.length ? pubkeys.map(participantName).join('、') : 'なし';
	}

	function outcomeSummary(result: CooperationDefectionRoundResult): string {
		if (result.kind === 'all-cooperate') return '全員協力：全員 +1,000pt';
		if (result.kind === 'cooperation-success') return '協力成功：協力者 +100pt / 抜け駆け者 +10,000pt';
		if (result.kind === 'cooperation-failure') return '協力失敗：協力者 0pt / 抜け駆け者 寿命 −3日';
		return '有効な選択が3人未満のため不成立。報酬・ペナルティはありません';
	}

	function ownOutcome(result: CooperationDefectionRoundResult): string | null {
		if (!selfPubkey || !result.validParticipantPubkeys.includes(selfPubkey) || result.kind === 'insufficient') return null;
		const outcome = result.outcomes.find((item) => item.pubkey === selfPubkey);
		if (outcome?.kind === 'points') return `あなた: +${outcome.points?.toLocaleString('ja-JP')}pt`;
		if (outcome?.kind === 'lifespan-loss') return 'あなた: 寿命 −3日';
		return result.cooperatePubkeys.includes(selfPubkey) ? 'あなた: 0pt' : null;
	}
</script>

{#if schedule.phase === 'warning' || schedule.phase === 'registration' || (schedule.phase === 'game' && (!selfGroupCancelled || cancellationNoticeVisible))}
	<section class="cooperation-defection-panel" data-realtime-panel data-realtime-status={status} aria-label="協力と抜け駆け">
		<div class="cooperation-defection-heading">
			<div>
				<h2>協力と抜け駆け <span>experimental</span></h2>
				<p>{cooperationDefectionPhaseLabel(schedule.phase)} · {schedule.dateKey.startsWith('manual-') ? '運営開催' : schedule.dateKey}</p>
			</div>
			{#if roundInfo && !selfGroupCancelled}
				<strong data-cooperation-defection-round-progress>ラウンド {roundInfo.round} · {roundInfo.phase}</strong>
			{/if}
		</div>
		{#if selfGroupCancelled}
			<p class="cooperation-defection-cancelled" data-cooperation-defection-cancelled>参加人数が足りなかったため開催されませんでした</p>
		{:else}
		{#if schedule.phase === 'registration' && registrationDeadline && registrationCountdown}
			<p class="cooperation-defection-registration-deadline" data-cooperation-defection-registration-deadline>受付締切: {registrationDeadline}</p>
			<p class="cooperation-defection-registration-countdown" data-cooperation-defection-registration-countdown>残り時間: {registrationCountdown}</p>
		{/if}
		{#if schedule.phase === 'game' && !session?.participantSnapshot}
			<p class="cooperation-defection-note" data-cooperation-defection-participants-loading>参加情報を取得中です。取得が完了するまでラウンド進行は表示されません。</p>
		{/if}
		{#if status === 'degraded'}
			<p class="cooperation-defection-note">イベント通信が利用できません。通常の会話と移動は継続できます。</p>
		{:else if schedule.phase === 'warning'}
			<p class="cooperation-defection-note">20:55 JSTから、フィールド上の参加地点へ移動して参加できます。</p>
		{:else if schedule.phase === 'registration'}
			{#if selfGroupId}
				<p class="cooperation-defection-note"><strong>参加済み</strong></p>
				<p class="cooperation-defection-note">開始まで待ってください。</p>
			{:else}
				<p class="cooperation-defection-note">参加地点まで移動して操作してください。参加先の自動割り当てはありません。</p>
			{/if}
			<details class="cooperation-defection-rules-disclosure">
				<summary>ルールを見る</summary>
				<div class="cooperation-defection-rules-inline" role="dialog" aria-label="協力と抜け駆けのルール">
					<p>1グループ3〜6人、全3ラウンドです。</p>
					<p><strong>1ラウンドの流れ</strong></p>
					<p>相談 30秒 → 選択 30秒 → 結果発表 20秒</p>
					<p>相談のあと、全員がどちらかを選びます。</p>
					<ul>
						<li><strong>協力する</strong></li>
						<li><strong>抜け駆けする</strong></li>
					</ul>
					<p>誰が何を選んだかは、結果発表まで分かりません。</p>
					<p><strong>必要な協力人数</strong></p>
					<ul>
						<li>3人 → <strong>2人</strong></li>
						<li>4人 → <strong>3人</strong></li>
						<li>5人 → <strong>4人</strong></li>
						<li>6人 → <strong>4人</strong></li>
					</ul>
					<p><strong>結果</strong></p>
					<ul>
						<li>全員が協力 → <strong>全員 +1,000pt</strong></li>
						<li>協力成功・一部が抜け駆け → <strong>協力 +100pt / 抜け駆け +10,000pt</strong></li>
						<li>協力失敗 → <strong>協力 0pt / 抜け駆け 寿命 −3日</strong></li>
					</ul>
				</div>
			</details>
		{:else if schedule.phase === 'game' && roundInfo}
			<div class="cooperation-defection-details">
				{#if selfGroupId}<span>{#if session?.participantSnapshot?.[selfGroupId]}参加中（{session.participantSnapshot[selfGroupId].length}人）{:else}参加中{/if}</span>{/if}
				<span>残り: {formatRemaining(roundInfo.remainingMs)}</span>
			</div>
			{#if roundInfo.phase === '選択'}
				<p class="cooperation-defection-note">選択内容は結果発表まで秘密です。</p>
				<div class="cooperation-defection-choice-row" aria-label="秘密選択">
					<button type="button" data-cooperation-defection-choice="cooperate" class:selected={selectedChoice === 'cooperate'} disabled={!canChoose} onclick={() => onChoice('cooperate')}>協力する</button>
					<button type="button" data-cooperation-defection-choice="defect" class:selected={selectedChoice === 'defect'} disabled={!canChoose} onclick={() => onChoice('defect')}>抜け駆けする</button>
				</div>
			{:else if roundInfo.phase === '結果発表'}
				<p class="cooperation-defection-note">公開猶予の終了後に、確定した選択をまとめて表示します。</p>
			{/if}
			{#if commitStatus}<p class="cooperation-defection-status" data-cooperation-defection-selection-status>{commitStatus}</p>{/if}
		{/if}
		{#if lastRoundResult}
			<section class="cooperation-defection-result" data-cooperation-defection-round-result aria-label={`ラウンド${lastRoundResult.round}の結果`}>
				<strong>ラウンド {lastRoundResult.round} · {lastRoundResult.kind === 'all-cooperate' ? '全員協力' : lastRoundResult.kind === 'cooperation-success' ? '協力成功' : lastRoundResult.kind === 'cooperation-failure' ? '協力失敗' : '不成立'}</strong>
				<p>協力: {labels(lastRoundResult.cooperatePubkeys)}</p>
				<p>抜け駆け: {labels(lastRoundResult.defectPubkeys)}</p>
				<p>{outcomeSummary(lastRoundResult)}</p>
				{#if ownOutcome(lastRoundResult)}<p>{ownOutcome(lastRoundResult)}</p>{/if}
			</section>
		{:else if message}<p class="cooperation-defection-result" data-cooperation-defection-round-result>{message}</p>{/if}
		{/if}
	</section>
{/if}

<style>
	.cooperation-defection-panel { box-sizing: border-box; position: absolute; z-index: 10; top: 12px; left: 50%; width: min(440px, calc(100vw - 32px)); min-width: 0; padding: 12px 14px; border: 1px solid rgba(102, 28, 106, 0.25); border-radius: 14px; background: rgba(255, 250, 255, 0.93); color: #3d3144; box-shadow: 0 8px 24px rgba(75, 44, 75, 0.12); pointer-events: none; transform: translateX(-50%); }
	.cooperation-defection-heading, .cooperation-defection-details, .cooperation-defection-choice-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
	h2 { margin: 0; font-size: 16px; } h2 span { color: #7b397f; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
	p { margin: 4px 0 0; font-size: 11px; overflow-wrap: anywhere; } .cooperation-defection-heading strong { font-size: 11px; white-space: nowrap; }
	.cooperation-defection-cancelled { font-weight: 700; }
	.cooperation-defection-note { color: #665b69; } .cooperation-defection-details { flex-wrap: wrap; justify-content: flex-start; margin-top: 8px; font-size: 11px; }
	.cooperation-defection-choice-row { margin-top: 9px; } button { flex: 1; min-width: 0; min-height: 34px; padding: 6px 8px; border: 1px solid rgba(102, 28, 106, 0.3); border-radius: 8px; background: #fff; color: #4d3150; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; pointer-events: auto; } button.selected { background: #f0d9f3; border-color: #8d4692; } button:disabled { cursor: not-allowed; opacity: .5; }
	.cooperation-defection-rules-disclosure { margin-top: 9px; pointer-events: auto; }
	.cooperation-defection-rules-disclosure summary { padding: 8px; border: 1px solid rgba(102, 28, 106, .3); border-radius: 8px; background: white; color: #4d3150; font-size: 11px; font-weight: 700; cursor: pointer; text-align: center; }
	.cooperation-defection-rules-inline { display: grid; gap: 8px; max-height: min(55svh, 360px); overflow: auto; margin-top: 8px; padding: 10px; border: 1px solid rgba(102, 28, 106, .18); border-radius: 8px; background: rgba(255, 255, 255, .78); font-size: 11px; line-height: 1.5; }
	.cooperation-defection-rules-inline p, .cooperation-defection-rules-inline ul { margin: 0; }
	.cooperation-defection-rules-inline ul { padding-left: 1.2rem; }
	.cooperation-defection-status { color: #69536d; } .cooperation-defection-result { padding: 6px 8px; border-radius: 7px; background: rgba(211, 159, 215, .18); font-weight: 700; }
	@media (min-width: 701px) {
		.cooperation-defection-panel { padding-top: 4px; padding-bottom: 4px; font-size: 16px; }
		p, .cooperation-defection-heading strong, .cooperation-defection-details, button, .cooperation-defection-rules-disclosure summary, .cooperation-defection-rules-inline { font-size: 1em; }
		h2 { font-size: 20px; }
		h2 span { font-size: 11px; }
		.cooperation-defection-panel p { line-height: 1.25; }
		.cooperation-defection-rules-disclosure { margin-top: 4px; }
		.cooperation-defection-rules-disclosure summary { padding-top: 2px; padding-bottom: 2px; }
	}
</style>
