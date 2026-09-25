<script lang="ts">
	import AlertTriangle from '~icons/tabler/alert-triangle';
	import CalendarClock from '~icons/tabler/calendar-clock';
	import CalendarEvent from '~icons/tabler/calendar-event';
	import CircleCheck from '~icons/tabler/circle-check';
	import Clock from '~icons/tabler/clock';
	import Coins from '~icons/tabler/coins';
	import HeartBroken from '~icons/tabler/heart-broken';
	import HelpCircle from '~icons/tabler/help-circle';
	import Hourglass from '~icons/tabler/hourglass';
	import ListDetails from '~icons/tabler/list-details';
	import PlayerPlay from '~icons/tabler/player-play';
	import Users from '~icons/tabler/users';
	import X from '~icons/tabler/x';
	import { getCooperationDefectionRoundSchedule, cooperationDefectionPhaseLabel, COOPERATION_DEFECTION_MIN_PARTICIPANTS, type CooperationDefectionChoice, type CooperationDefectionRoundResult, type CooperationDefectionSchedule, type CooperationDefectionSessionState } from '$lib/cooperationDefection';
	import type { Bounds } from '$lib/geometry';

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
		selectionFailed: boolean;
		canChoose: boolean;
		message: string | null;
		viewportElement: HTMLElement | undefined;
		onPanelBounds: (bounds: Bounds | null) => void;
		onChoice: (choice: CooperationDefectionChoice) => void;
	}>;

	let { schedule, nowMs, registrationDeadline, registrationCountdown, status, session, selfGroupId, cancelled, selfPubkey, participantName, selectedChoice, commitStatus, selectionFailed, canChoose, message, viewportElement, onPanelBounds, onChoice }: Props = $props();
	let panelElement = $state<HTMLElement>();
	let choiceReservation = $state<HTMLElement>();
	let panelBounds = $state<Bounds | null>(null);
	let choiceBounds = $state<Bounds | null>(null);
	let detailsOpen = $state(false);
	let detailsTrigger = $state<HTMLButtonElement>();
	let previousRoundKey: string | null = null;
	let selfGroupCancelled = $derived(cancelled && schedule.phase === 'game');
	let cancellationNoticeKey = $derived(selfGroupCancelled && selfGroupId ? `${schedule.instanceId}:${selfGroupId}` : null);
	let dismissedCancellationKey = $state<string | null>(null);
	let cancellationNoticeVisible = $derived(Boolean(cancellationNoticeKey && dismissedCancellationKey !== cancellationNoticeKey));
	let lastRoundResult = $derived(selfGroupCancelled || !selfGroupId ? null : session?.results.filter((result) => result.groupId === selfGroupId).at(-1) ?? null);
	let hasPlayableGroups = $derived(Boolean(session?.participantSnapshot && Object.values(session.participantSnapshot).some((participants) => participants.length >= COOPERATION_DEFECTION_MIN_PARTICIPANTS)));
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
	let latestResultConfirmsOwnChoice = $derived(Boolean(lastRoundResult && roundInfo && lastRoundResult.round === roundInfo.round && selfPubkey && lastRoundResult.validParticipantPubkeys.includes(selfPubkey)));
	let selectionPhase = $derived(roundInfo?.phase === '選択' && !selfGroupCancelled);
	let detailsPosition = $derived.by(() => {
		if (!panelBounds || !viewportElement) return null;
		const width = Math.min(420, Math.max(0, viewportElement.clientWidth - 24));
		const top = Math.max(12, Math.min(panelBounds.y + panelBounds.height + 8, viewportElement.clientHeight - 140));
		const left = Math.max(12, Math.min(panelBounds.x + panelBounds.width - width, viewportElement.clientWidth - width - 12));
		return { left, top, width, maxHeight: Math.min(480, Math.max(0, viewportElement.clientHeight - top - 12)) };
	});

	$effect(() => {
		const panel = panelElement;
		const reservation = choiceReservation;
		const viewport = viewportElement;
		if (!panel || !viewport) {
			panelBounds = null;
			choiceBounds = null;
			onPanelBounds(null);
			return;
		}
		const measure = () => {
			const view = viewport.getBoundingClientRect();
			const rect = panel.getBoundingClientRect();
			const bounds = { x: rect.left - view.left, y: rect.top - view.top, width: rect.width, height: rect.height };
			panelBounds = bounds;
			onPanelBounds(bounds);
			if (reservation && selectionPhase) {
				const choice = reservation.getBoundingClientRect();
				choiceBounds = { x: choice.left - view.left, y: choice.top - view.top, width: choice.width, height: choice.height };
			} else choiceBounds = null;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(panel);
		observer.observe(viewport);
		if (reservation) observer.observe(reservation);
		window.addEventListener('resize', measure);
		window.addEventListener('scroll', measure, true);
		return () => {
			observer.disconnect();
			window.removeEventListener('resize', measure);
			window.removeEventListener('scroll', measure, true);
		};
	});

	$effect(() => {
		const key = cancellationNoticeKey;
		if (!key) return;
		const timeout = window.setTimeout(() => { dismissedCancellationKey = key; }, 5_000);
		return () => window.clearTimeout(timeout);
	});

	$effect(() => {
		const roundKey = `${schedule.instanceId}:${roundInfo?.round ?? 'none'}`;
		if (previousRoundKey !== null && previousRoundKey !== roundKey) detailsOpen = false;
		previousRoundKey = roundKey;
	});

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape' || !detailsOpen) return;
		event.preventDefault();
		detailsOpen = false;
		requestAnimationFrame(() => detailsTrigger?.focus());
	}

	function closeDetails(): void {
		detailsOpen = false;
		requestAnimationFrame(() => detailsTrigger?.focus());
	}

	function formatRemaining(value: number): string {
		return `${Math.ceil(value / 1000)}秒`;
	}

	function labels(pubkeys: readonly string[]): string {
		return pubkeys.length ? pubkeys.map(participantName).join('、') : 'なし';
	}

	function outcomeLabel(result: CooperationDefectionRoundResult): string {
		if (result.kind === 'all-cooperate') return '全員協力';
		if (result.kind === 'cooperation-success') return '協力成功';
		if (result.kind === 'cooperation-failure') return '協力失敗';
		return '不成立';
	}

	function outcomeSummary(result: CooperationDefectionRoundResult): string {
		if (result.kind === 'all-cooperate') return '全員 +1,000pt';
		if (result.kind === 'cooperation-success') return '協力者 +100pt · 抜け駆け者 +10,000pt';
		if (result.kind === 'cooperation-failure') return '協力者 0pt · 抜け駆け者 寿命 −3日';
		return '報酬・ペナルティなし';
	}

	function ownOutcome(result: CooperationDefectionRoundResult): string | null {
		if (!selfPubkey || !result.validParticipantPubkeys.includes(selfPubkey) || result.kind === 'insufficient') return null;
		const outcome = result.outcomes.find((item) => item.pubkey === selfPubkey);
		if (outcome?.kind === 'points') return `あなた: +${outcome.points?.toLocaleString('ja-JP')}pt`;
		if (outcome?.kind === 'lifespan-loss') return 'あなた: 寿命 −3日';
		return result.cooperatePubkeys.includes(selfPubkey) ? 'あなた: 0pt' : null;
	}

	function openDetails(): void {
		detailsOpen = true;
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#if schedule.phase === 'warning' || schedule.phase === 'registration' || (schedule.phase === 'game' && (!selfGroupCancelled || cancellationNoticeVisible))}
	<section class="cooperation-defection-panel" bind:this={panelElement} data-realtime-panel data-realtime-status={status} aria-label="協力と抜け駆け">
		<div class="cooperation-defection-heading">
			<h2>協力と抜け駆け <span>experimental</span></h2>
			<div class="cooperation-defection-meta">
				<span class="hud-item hud-muted"><span class="hud-icon" aria-hidden="true"><CalendarEvent /></span>{schedule.dateKey.startsWith('manual-') ? '運営開催' : '定期開催'}</span>
			{#if roundInfo && !selfGroupCancelled}
				<strong class="hud-item phase-label" data-cooperation-defection-round-progress><span class="hud-icon" aria-hidden="true"><PlayerPlay /></span>ラウンド {roundInfo.round} · {roundInfo.phase}</strong>
			{:else}
				<strong class="hud-item phase-label">{#if schedule.phase === 'game'}<span class="hud-icon" aria-hidden="true"><Hourglass /></span>{:else}<span class="hud-icon" aria-hidden="true"><CalendarClock /></span>{/if}{cooperationDefectionPhaseLabel(schedule.phase)}</strong>
			{/if}
			</div>
		</div>
		{#if schedule.phase === 'registration' && registrationDeadline && registrationCountdown}
			<div class="registration-timing">
				<p class="cooperation-defection-registration-countdown hud-item" data-cooperation-defection-registration-countdown><span class="hud-icon" aria-hidden="true"><Clock /></span><span>残り時間: <strong>{registrationCountdown}</strong></span></p>
				<p class="cooperation-defection-registration-deadline hud-item hud-muted" data-cooperation-defection-registration-deadline><span class="hud-icon" aria-hidden="true"><CalendarClock /></span>受付締切: {registrationDeadline}</p>
			</div>
		{/if}
		{#if selfGroupCancelled}
			<p class="cooperation-defection-cancelled" data-cooperation-defection-cancelled>参加人数が足りなかったため開催されませんでした</p>
		{:else}
			{#if status === 'degraded'}
				<p class="cooperation-defection-note hud-item warning-message" data-cooperation-defection-communication-warning><span class="hud-icon" aria-hidden="true"><AlertTriangle /></span>イベント通信が利用できません。会話と移動は続けられます。</p>
			{/if}
			{#if schedule.phase === 'game' && !session?.participantSnapshot}
				<p class="cooperation-defection-note hud-item" data-cooperation-defection-participants-loading><span class="hud-icon" aria-hidden="true"><Hourglass /></span>参加情報を取得中</p>
			{:else if schedule.phase === 'warning' && status !== 'degraded'}
				<p class="cooperation-defection-note">20:55 JST 受付開始</p>
			{:else if schedule.phase === 'registration' && status !== 'degraded'}
			{#if selfGroupId}<p class="cooperation-defection-note hud-item"><span class="hud-icon" aria-hidden="true"><CircleCheck /></span><strong>参加済み</strong></p>
			{:else}<p class="cooperation-defection-note hud-item"><span class="hud-icon" aria-hidden="true"><Users /></span>参加地点へ移動</p>{/if}
			<details class="cooperation-defection-rules-disclosure">
				<summary><span class="hud-icon" aria-hidden="true"><HelpCircle /></span>ルールを見る</summary>
				<div class="cooperation-defection-rules-inline" role="dialog" aria-label="協力と抜け駆けのルール">
					<p>3〜6人 · 全3ラウンド</p><p><strong>1ラウンドの流れ</strong></p>
					<p>相談 30秒 → 選択 30秒 → 結果発表 20秒</p>
					<p>協力する / 抜け駆けする</p><p>選択は結果発表まで秘密</p>
					<p><strong>必要な協力人数</strong></p><ul><li>3人 → <strong>2人</strong></li><li>4人 → <strong>3人</strong></li><li>5人 → <strong>4人</strong></li><li>6人 → <strong>4人</strong></li></ul>
					<p><strong>結果</strong></p><ul><li>全員が協力 → <strong>全員 +1,000pt</strong></li><li>協力成功 → <strong>協力 +100pt / 抜け駆け +10,000pt</strong></li><li>協力失敗 → <strong>協力 0pt / 抜け駆け 寿命 −3日</strong></li></ul>
				</div>
			</details>
			{:else if schedule.phase === 'game' && roundInfo}
				<div class="cooperation-defection-details">
					{#if selfGroupId}<span class="hud-item"><span class="hud-icon" aria-hidden="true"><Users /></span>{#if session?.participantSnapshot?.[selfGroupId]}参加中（{session.participantSnapshot[selfGroupId].length}人）{:else}参加中{/if}</span>{/if}
					<span class="hud-item round-timer"><span class="hud-icon" aria-hidden="true"><Clock /></span><span>残り</span><strong>{formatRemaining(roundInfo.remainingMs)}</strong></span>
				</div>
			{#if roundInfo.phase === '選択'}
				<div bind:this={choiceReservation} class="choice-reservation" aria-hidden="true"></div>
			{/if}
			{#if commitStatus && (lastRoundResult?.round !== roundInfo.round || (selectionFailed && !latestResultConfirmsOwnChoice))}<p class="cooperation-defection-status" data-cooperation-defection-selection-status>{commitStatus}</p>{/if}
			{/if}
			{#if schedule.phase === 'game' && roundInfo && lastRoundResult}
				{@const isPrevious = roundInfo.round > lastRoundResult.round}
				{@const ownResult = ownOutcome(lastRoundResult)}
				{@const ownPenalty = lastRoundResult.outcomes.some((outcome) => outcome.pubkey === selfPubkey && outcome.kind === 'lifespan-loss')}
				<div class="cooperation-defection-result" data-cooperation-defection-round-result aria-label={`${isPrevious ? '前ラウンド' : 'ラウンド'}${lastRoundResult.round}の結果`}>
					<div class="result-heading hud-item"><span class="hud-icon" aria-hidden="true">{#if lastRoundResult.kind === 'cooperation-failure' || lastRoundResult.kind === 'insufficient'}<AlertTriangle />{:else}<CircleCheck />{/if}</span><strong>{outcomeLabel(lastRoundResult)}</strong>{#if isPrevious}<span class="previous-label">前ラウンド</span>{/if}</div>
					{#if ownResult}<p class="own-outcome hud-item"><span class="hud-icon" aria-hidden="true">{#if ownPenalty}<HeartBroken />{:else}<Coins />{/if}</span><strong>{ownResult}</strong></p>{/if}
					<button bind:this={detailsTrigger} type="button" class="details-trigger hud-item" aria-label="結果の詳細を見る" aria-expanded={detailsOpen} aria-controls="cooperation-defection-result-details" onclick={openDetails}><span class="hud-icon" aria-hidden="true"><ListDetails /></span>詳細を見る</button>
				</div>
			{:else if schedule.phase === 'game' && roundInfo && !lastRoundResult && message}
				<p class="cooperation-defection-result hud-item" data-cooperation-defection-round-result><span class="hud-icon" aria-hidden="true"><Hourglass /></span>{message}</p>
		{/if}
		{/if}
	</section>

	{#if selectionPhase && choiceBounds}
		<div class="cooperation-defection-choice-controls" data-cooperation-defection-choice-controls style={`left:${choiceBounds.x}px;top:${choiceBounds.y}px;width:${choiceBounds.width}px;height:${choiceBounds.height}px`} aria-label="秘密選択">
			<button type="button" data-cooperation-defection-choice="cooperate" class:selected={selectedChoice === 'cooperate'} disabled={!canChoose} onclick={() => onChoice('cooperate')}>協力する</button>
			<button type="button" data-cooperation-defection-choice="defect" class:selected={selectedChoice === 'defect'} disabled={!canChoose} onclick={() => onChoice('defect')}>抜け駆けする</button>
		</div>
	{/if}

	{#if detailsOpen && lastRoundResult && detailsPosition}
		<div class="details-layer" aria-hidden="false">
			<section class="result-details" id="cooperation-defection-result-details" aria-label={`ラウンド${lastRoundResult.round}の結果の詳細`} style={`left:${detailsPosition.left}px;top:${detailsPosition.top}px;width:${detailsPosition.width}px;max-height:${detailsPosition.maxHeight}px`}>
				<header><h3 class="hud-item"><span class="hud-icon" aria-hidden="true">{#if lastRoundResult.kind === 'cooperation-failure' || lastRoundResult.kind === 'insufficient'}<AlertTriangle />{:else}<CircleCheck />{/if}</span>ラウンド {lastRoundResult.round} · {outcomeLabel(lastRoundResult)}</h3><button type="button" class="hud-item" aria-label="結果の詳細を閉じる" onclick={closeDetails}><span class="hud-icon" aria-hidden="true"><X /></span>閉じる</button></header>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -- scrollable region remains keyboard focusable -->
				<div class="result-details-body" role="region" aria-label="結果の詳細内容" tabindex="0">
					<p><strong>有効な選択</strong></p>
					<p>協力: {labels(lastRoundResult.cooperatePubkeys)}</p>
					<p>抜け駆け: {labels(lastRoundResult.defectPubkeys)}</p>
					<p><strong>共通の報酬・ペナルティ</strong></p><p>{outcomeSummary(lastRoundResult)}</p>
					{#if ownOutcome(lastRoundResult)}<p><strong>あなたの結果</strong></p><p>{ownOutcome(lastRoundResult)}</p>{/if}
				</div>
			</section>
		</div>
	{/if}
{/if}

<style>
	.cooperation-defection-panel, .result-details { font-size: clamp(.875rem, .8rem + .34vw, 1.0625rem); line-height: 1.4; color: #39293e; }
	.cooperation-defection-panel { box-sizing: border-box; position: absolute; z-index: 2; top: 12px; left: 50%; width: min(440px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow-y: auto; min-width: 0; padding: 10px 12px; border: 1px solid rgba(102, 28, 106, .25); border-radius: 14px; background: rgba(255, 250, 255, .95); box-shadow: 0 8px 24px rgba(75, 44, 75, .12); pointer-events: none; transform: translateX(-50%); }
	.cooperation-defection-heading { display: grid; gap: 5px; min-width: 0; }
	h2 { margin: 0; font-size: 1.18em; line-height: 1.2; }
	h2 span { display: inline-block; margin-left: .3em; color: #7b397f; font-size: .58em; letter-spacing: .08em; text-transform: uppercase; vertical-align: middle; }
	.cooperation-defection-meta, .cooperation-defection-details { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 12px; min-width: 0; }
	.cooperation-defection-meta { font-size: .82em; }
	.hud-item { display: inline-flex; align-items: center; gap: .4em; min-width: 0; }
	.hud-icon { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; width: 1rem; height: 1rem; }
	.hud-icon :global(svg) { display: block; width: 100%; height: 100%; stroke-width: 2; }
	.hud-muted { color: #67576b; }
	.phase-label { color: #713878; font-weight: 750; }
	p { margin: 0; overflow-wrap: anywhere; }
	.registration-timing { display: grid; gap: 1px; margin-top: 8px; padding: 7px 9px; border-radius: 9px; background: rgba(222, 181, 226, .19); }
	.cooperation-defection-registration-countdown { font-size: .82em; }
	.cooperation-defection-registration-countdown strong { color: #6d2675; font-size: 1.6em; line-height: 1; font-variant-numeric: tabular-nums; }
	.cooperation-defection-registration-deadline { font-size: .78em; }
	.cooperation-defection-note, .cooperation-defection-cancelled, .cooperation-defection-status { margin-top: 7px; font-size: .84em; }
	.cooperation-defection-cancelled { color: #713878; font-weight: 700; }
	.warning-message { padding: 5px 7px; border-radius: 7px; background: #fff0eb; color: #803d2f; }
	.cooperation-defection-details { justify-content: flex-start; margin-top: 8px; font-size: .88em; }
	.round-timer { margin-left: auto; }
	.round-timer strong { color: #6d2675; font-size: 1.28em; font-variant-numeric: tabular-nums; }
	.choice-reservation { height: 42px; margin-top: 8px; }
	.cooperation-defection-result { display: grid; gap: 5px; margin-top: 8px; padding: 7px 9px; border: 1px solid rgba(145, 73, 151, .15); border-radius: 9px; background: rgba(211, 159, 215, .18); }
	.result-heading { color: #672e6e; }
	.result-heading strong { font-size: 1.04em; }
	.previous-label { margin-left: auto; color: #67576b; font-size: .74em; }
	.own-outcome { font-size: .94em; }
	.own-outcome strong { font-variant-numeric: tabular-nums; }
	.cooperation-defection-choice-controls { position: absolute; z-index: 5; box-sizing: border-box; display: flex; align-items: stretch; gap: 8px; padding: 0; pointer-events: none; }
	button { min-width: 0; min-height: 38px; padding: 5px 9px; border: 1px solid rgba(102, 28, 106, .3); border-radius: 8px; background: #fff; color: #4d3150; font: inherit; font-size: .9em; font-weight: 700; cursor: pointer; pointer-events: auto; }
	.cooperation-defection-choice-controls button { flex: 1; }
	button.selected { background: #f0d9f3; border-color: #8d4692; }
	button:disabled { cursor: not-allowed; opacity: .5; }
	.details-trigger { justify-self: start; min-height: 30px; padding: 2px 7px; font-size: .8em; }
	.cooperation-defection-rules-disclosure { margin-top: 7px; pointer-events: auto; }
	.cooperation-defection-rules-disclosure summary { display: flex; align-items: center; justify-content: center; gap: .4em; min-height: 30px; box-sizing: border-box; padding: 4px 8px; border: 1px solid rgba(102, 28, 106, .3); border-radius: 8px; background: #fff; color: #4d3150; font-size: .82em; font-weight: 700; cursor: pointer; list-style: none; }
	.cooperation-defection-rules-disclosure summary::-webkit-details-marker { display: none; }
	.cooperation-defection-rules-inline { display: grid; gap: 7px; max-height: min(40svh, 280px); overflow: auto; margin-top: 6px; padding: 10px; border: 1px solid rgba(102, 28, 106, .18); border-radius: 8px; background: rgba(255, 255, 255, .96); font-size: .88em; line-height: 1.5; pointer-events: auto; }
	.cooperation-defection-rules-inline p, .cooperation-defection-rules-inline ul { margin: 0; font-size: inherit; }
	.cooperation-defection-rules-inline ul { padding-left: 1.2em; }
	.cooperation-defection-status { color: #69536d; }
	.details-layer { position: absolute; z-index: 6; inset: 0; pointer-events: none; }
	.result-details { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(102, 28, 106, .3); border-radius: 12px; background: rgba(255, 250, 255, .98); box-shadow: 0 8px 24px rgba(75, 44, 75, .2); pointer-events: auto; }
	.result-details header { position: sticky; z-index: 1; top: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid rgba(102, 28, 106, .16); background: rgba(255, 250, 255, .98); }
	.result-details h3 { margin: 0; font-size: 1.04em; }
	.result-details header button { flex: 0 0 auto; }
	.result-details-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 10px; font-size: .95em; line-height: 1.45; }
	.result-details-body p { margin: 0 0 7px; font-size: inherit; }
	.result-details-body p:last-child { margin-bottom: 0; }
	@media (max-width: 700px) {
		.cooperation-defection-panel { top: calc(64px + env(safe-area-inset-top)); max-height: calc(100% - 76px - env(safe-area-inset-top)); }
	}
</style>
