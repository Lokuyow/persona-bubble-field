<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { MendingProjection } from '$lib/mending';
	import { formatElapsedDuration, formatRemainingDuration } from '$lib/lifespanHud';

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		points: number;
		onOpenChange: (open: boolean) => void;
		onStart: () => void;
		onCollect: () => void;
	}>;
	let { open, projection, hasJob, points: ownedPointsValue, onOpenChange, onStart, onCollect }: Props = $props();
	let elapsedDuration = $derived(formatElapsedDuration(projection?.processedDurationMs ?? 0));
	let maximumDuration = $derived(formatElapsedDuration((projection?.processedDurationMs ?? 0) + (projection?.remainingDurationMs ?? 0)));
	let remainingDuration = $derived(formatRemainingDuration(projection?.remainingDurationMs ?? 0));
	let lifespanDuration = $derived(formatElapsedDuration(projection?.lifespanExtensionMs ?? 0));
	let unclaimedPoints = $derived(String(projection?.points ?? 0));
	let ownedPoints = $derived(String(ownedPointsValue));
	let nextPointDuration = $derived(projection?.nextPointRemainingMs === null || projection?.nextPointRemainingMs === undefined ? null : formatRemainingDuration(projection.nextPointRemainingMs));
	let totalDurationMs = $derived((projection?.processedDurationMs ?? 0) + (projection?.remainingDurationMs ?? 0));
	let progressPercent = $derived(Math.min(100, totalDurationMs > 0 ? (projection?.processedDurationMs ?? 0) / totalDurationMs * 100 : 0));
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content class="mending-dialog-content" preventScroll={false}>
				<div class="terminal-dialog-header">
					<div>
						<Dialog.Title>作業</Dialog.Title>
						<Dialog.Description>時間の経過で進捗が蓄積され、寿命延長とポイントを受け取れます。</Dialog.Description>
					</div>
					<div class="terminal-status-chip">POINT {ownedPoints} pt</div>
				</div>
				{#if !hasJob}
					<section class="idle-state">
						<p>作業を開始すると、時間に応じて成果が蓄積されます。</p>
						<button class="terminal-primary-action" type="button" onclick={onStart}>作業を開始</button>
					</section>
				{:else}
					<section class="progress-section" aria-label="作業の進捗">
						<div class="progress-heading">
							<strong>{elapsedDuration} / {maximumDuration}</strong>
							<span>{Math.round(progressPercent)}%</span>
						</div>
						<div class="progress-track" role="progressbar" aria-label="作業の蓄積進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressPercent)}>
							<div class="progress-value" style={`width: ${progressPercent}%;`}></div>
						</div>
						<p class="remaining-value">{projection?.completed ? '蓄積上限に達しています' : `残り ${remainingDuration}`}</p>
						{#if nextPointDuration}<p class="remaining-value">次の1ptまで {nextPointDuration}</p>{/if}
					</section>
					<section class="result-section" aria-labelledby="mending-result-title">
						<h3 id="mending-result-title">今回受け取れる成果</h3>
						<div class="result-grid">
							<div class="result-card"><span>寿命延長</span><strong>+{lifespanDuration}</strong></div>
							<div class="result-card"><span>ポイント</span><strong>+{unclaimedPoints}pt</strong></div>
						</div>
					</section>
					<section class="details-section" aria-label="作業の現在効果">
						<p>通常作業: {projection?.regularDurationMs ? formatElapsedDuration(projection.regularDurationMs) : '0分'} / Context {formatElapsedDuration(projection?.contextCapacityMs ?? 0)}</p>
						<p>現在のポイント率: {((projection?.pointRateHundredthsPerMinute ?? 0) / 100).toFixed(2)} pt/分</p>
						<p>現在の寿命延長率: +{((projection?.lifespanExtensionRateHundredthsPerHour ?? 0) / 100).toFixed(2)} h/h</p>
						<p>最大寿命: {formatElapsedDuration(projection?.maximumLifespanMs ?? 0)} / 加速残り: {formatElapsedDuration(projection?.accelerationRemainingMs ?? 0)}</p>
					</section>
					<button class="terminal-primary-action" type="button" onclick={onCollect}>受け取る</button>
				{/if}
				<Dialog.Close class="terminal-secondary-action">閉じる</Dialog.Close>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.mending-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(2, 8, 18, 0.72); backdrop-filter: blur(2px); }
	:global(.mending-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 18px; width: min(calc(100vw - 32px), 700px); max-height: calc(100svh - 32px); overflow: auto; padding: clamp(20px, 4vw, 34px); border: 1px solid rgba(68, 222, 222, 0.7); border-radius: 14px; background: linear-gradient(145deg, rgba(4, 26, 38, 0.98), rgba(3, 14, 28, 0.96)); box-shadow: 0 0 28px rgba(26, 214, 224, 0.2), inset 0 0 22px rgba(28, 184, 202, 0.08); color: #ecfeff; transform: translate(-50%, -50%); }
	:global(.mending-dialog-content)::before { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background-image: linear-gradient(rgba(67, 214, 221, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(67, 214, 221, 0.035) 1px, transparent 1px); background-size: 22px 22px; content: ''; pointer-events: none; }
	.terminal-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(68, 222, 222, 0.36); }
	:global(.mending-dialog-content h2) { margin: 0; color: #f2ffff; font-size: clamp(1.6rem, 4vw, 2.25rem); letter-spacing: 0.08em; }
	:global(.mending-dialog-content [data-slot='dialog-description']) { display: block; margin-top: 6px; color: rgba(208, 246, 248, 0.78); font-size: 0.92rem; line-height: 1.5; }
	.terminal-status-chip { flex: 0 0 auto; padding: 7px 10px; border: 1px solid rgba(68, 222, 222, 0.52); border-radius: 6px; color: #89ffff; font-size: 0.82rem; font-weight: 800; letter-spacing: 0.08em; }
	.progress-section, .result-section { display: grid; gap: 10px; }
	.progress-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
	.progress-heading strong { font-size: clamp(1.35rem, 4vw, 2rem); }
	.progress-heading span { color: #8ffcff; font-weight: 800; }
	.progress-track { height: 13px; overflow: hidden; border: 1px solid rgba(68, 222, 222, 0.78); border-radius: 999px; background: rgba(1, 35, 47, 0.86); }
	.progress-value { height: 100%; min-width: 2px; background: linear-gradient(90deg, #27e6dd, #80ffff); box-shadow: 0 0 12px rgba(39, 230, 221, 0.7); }
	.remaining-value, .idle-state p { margin: 0; color: rgba(208, 246, 248, 0.78); }
	.result-section h3 { margin: 0; padding-top: 4px; color: #a4ffff; font-size: 1.05rem; letter-spacing: 0.08em; }
	.result-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
	.result-card { display: grid; gap: 6px; padding: 16px; border: 1px solid rgba(68, 222, 222, 0.46); border-radius: 9px; background: rgba(4, 53, 66, 0.48); }
	.result-card span { color: rgba(208, 246, 248, 0.74); font-size: 0.9rem; }
	.result-card strong { color: #f2ffff; font-size: clamp(1.25rem, 3.5vw, 1.7rem); }
	.idle-state { display: grid; gap: 14px; }
	.terminal-primary-action, :global(.terminal-secondary-action) { min-height: 46px; border-radius: 7px; font: inherit; font-weight: 800; cursor: pointer; }
	.terminal-primary-action { border: 1px solid #72ffff; background: linear-gradient(135deg, #20cfd0, #087eaa); box-shadow: 0 0 15px rgba(45, 229, 231, 0.3); color: #02141e; }
	:global(.terminal-secondary-action) { border: 1px solid rgba(141, 208, 218, 0.42); background: rgba(8, 31, 47, 0.7); color: rgba(224, 250, 252, 0.86); text-align: center; }
	:global(.mending-dialog-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 560px) { .terminal-dialog-header { flex-direction: column; } .terminal-status-chip { width: fit-content; } .result-grid { grid-template-columns: 1fr; } }
</style>
