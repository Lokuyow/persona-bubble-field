<script lang="ts">
	import { getRiftRoundSchedule, riftPhaseLabel, type RiftChoice, type RiftSchedule, type RiftSessionState } from '$lib/rift';

	type Props = Readonly<{
		schedule: RiftSchedule;
		nowMs: number;
		status: 'inactive' | 'active' | 'degraded';
		session: RiftSessionState | null;
		selfHoleId: string | null;
		selectedChoice: RiftChoice | null;
		commitStatus: string;
		canChoose: boolean;
		lastResult: string | null;
		onChoice: (choice: RiftChoice) => void;
	}>;

	let { schedule, nowMs, status, session, selfHoleId, selectedChoice, commitStatus, canChoose, lastResult, onChoice }: Props = $props();

	let roundInfo = $derived.by(() => {
		if (schedule.phase !== 'game') return null;
		for (const round of [1, 2, 3] as const) {
			const current = getRiftRoundSchedule(schedule, round);
			if (nowMs < current.endedAtMs) return {
				round,
				phase: nowMs < current.selectionAtMs ? '相談' : nowMs < current.resultAtMs ? '秘密選択' : '結果表示',
				remainingMs: Math.max(0, (nowMs < current.selectionAtMs ? current.selectionAtMs : nowMs < current.resultAtMs ? current.resultAtMs : current.endedAtMs) - nowMs)
			};
		}
		return { round: 3 as const, phase: '終了', remainingMs: 0 };
	});

	function formatRemaining(value: number): string {
		return `${Math.ceil(value / 1000)}秒`;
	}
</script>

{#if schedule.phase !== 'dormant'}
	<section class="rift-panel" data-realtime-panel data-realtime-status={status} aria-label="綻びイベント">
		<div class="rift-heading">
			<div>
				<h2>綻び <span>experimental</span></h2>
				<p>{riftPhaseLabel(schedule.phase)} · {schedule.dateKey}</p>
			</div>
			{#if roundInfo}
				<strong>Round {roundInfo.round} · {roundInfo.phase}</strong>
			{/if}
		</div>
		{#if status === 'degraded'}
			<p class="rift-note">綻びの通信が利用できません。通常の会話と移動は継続できます。</p>
		{:else if schedule.phase === 'warning'}
			<p class="rift-note">20:55 JSTから、フィールド上の抜け穴へ近づいて参加できます。</p>
		{:else if schedule.phase === 'registration'}
			<p class="rift-note">参加する抜け穴まで移動して操作してください。自動割り当てはありません。</p>
		{:else if schedule.phase === 'game' && roundInfo}
			<div class="rift-details">
				<span>参加先: {selfHoleId ?? '未参加'}</span>
				<span>参加者: {selfHoleId && session?.participantSnapshot?.[selfHoleId] ? session.participantSnapshot[selfHoleId].length : '未確定'}</span>
				<span>残り: {formatRemaining(roundInfo.remainingMs)}</span>
			</div>
			{#if roundInfo.phase === '相談'}
				<p class="rift-note">既存のworld conversationで相談できます。</p>
			{:else if roundInfo.phase === '秘密選択'}
				<div class="rift-choice-row" aria-label="秘密選択">
					<button type="button" data-rift-choice="maintain" class:selected={selectedChoice === 'maintain'} disabled={!canChoose} onclick={() => onChoice('maintain')}>抜け穴を維持する</button>
					<button type="button" data-rift-choice="escape" class:selected={selectedChoice === 'escape'} disabled={!canChoose} onclick={() => onChoice('escape')}>抜け穴からの脱出を試みる</button>
				</div>
			{:else if roundInfo.phase === '結果表示'}
				<p class="rift-note">選択を自動公開しています。</p>
			{/if}
			<p class="rift-status" data-rift-selection-status>{commitStatus}</p>
		{:else if schedule.phase === 'ended'}
			<p class="rift-note">本日の綻びは終了しました。</p>
		{/if}
		{#if lastResult}<p class="rift-result" data-rift-round-result>{lastResult}</p>{/if}
		{#if session?.closedHoleIds.length}<p class="rift-note">閉じた抜け穴: {session.closedHoleIds.length}</p>{/if}
	</section>
{/if}

<style>
	.rift-panel { position: absolute; z-index: 10; top: 12px; left: 50%; width: min(440px, calc(100vw - 32px)); padding: 12px 14px; border: 1px solid rgba(102, 28, 106, 0.25); border-radius: 14px; background: rgba(255, 250, 255, 0.93); color: #3d3144; box-shadow: 0 8px 24px rgba(75, 44, 75, 0.12); pointer-events: none; transform: translateX(-50%); }
	.rift-heading, .rift-details, .rift-choice-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	h2 { margin: 0; font-size: 16px; } h2 span { color: #7b397f; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
	p { margin: 4px 0 0; font-size: 11px; } .rift-heading strong { font-size: 11px; white-space: nowrap; }
	.rift-note { color: #665b69; } .rift-details { margin-top: 8px; font-size: 11px; }
	.rift-choice-row { margin-top: 9px; } button { flex: 1; min-height: 34px; padding: 6px 8px; border: 1px solid rgba(102, 28, 106, 0.3); border-radius: 8px; background: #fff; color: #4d3150; font: inherit; font-size: 11px; font-weight: 700; cursor: pointer; pointer-events: auto; } button.selected { background: #f0d9f3; border-color: #8d4692; } button:disabled { cursor: not-allowed; opacity: .5; }
	.rift-status { color: #69536d; } .rift-result { padding: 6px 8px; border-radius: 7px; background: rgba(211, 159, 215, .18); font-weight: 700; }
</style>
