<script lang="ts">
	import DialogPresentation from './ProfilePresentation.svelte';
	import { Popover } from 'bits-ui';
	import ActionButton from '$lib/ActionButton.svelte';
	import HelpCircle from '~icons/tabler/help-circle';
	import Wallet from '~icons/tabler/wallet';
	import ProfileLifeStats from './ProfileLifeStats.svelte';
	import ProfileRootPoints from './ProfileRootPoints.svelte';
	import type { MendingProjection } from '$lib/mending';
	import type { PersonaSnapshot } from '$lib/rootIdentity';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import { getCharacterById } from './character';
	import { formatElapsedDuration } from '$lib/lifespanHud';
	import { getContextCapacityMinutes, getHallucinationExtensionHundredths, getInferenceRateHundredths } from '$lib/personaGameState';
	import { INFERENCE_ACCELERATION_BUDGET_MS, rootContextCompressionMultiplierTenths, rootInferenceAccelerationMultiplierTenths, rootMaximumLifespanMs } from '$lib/rootProgression';
	import { MENDING_MINUTE_MS } from '$lib/mending';

	type Props = Readonly<{
		open: boolean;
		persona: PersonaSnapshot | null;
		mendingProjection: MendingProjection | null;
		nowMs: number;
		clearBlockedReason: string | null;
		clearBusy: boolean;
		avatarTone: BubbleTone;
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
		onClear: () => void;
	}>;

	let { open, persona, mendingProjection, nowMs, clearBlockedReason, clearBusy, avatarTone, onOpenChange, onCloseAutoFocus, onClear }: Props = $props();
	let character = $derived(persona ? getCharacterById(persona.identity.characterId) ?? null : null);
	let effectiveExpiry = $derived(mendingProjection?.effectiveExpiresAtMs ?? persona?.gameState.lifespanExpiresAtMs ?? nowMs);
	let points = $derived(persona?.gameState.points ?? 0);
	let clearProgress = $derived(Math.min(100, points / 100_000 * 100));
	let pointBlocked = $derived(points < 100_000);
	let clearBlocked = $derived(pointBlocked || clearBusy || clearBlockedReason !== null);
	let workPointRate = $derived(persona?.gameState.mendingJob
		? mendingProjection?.pointRateHundredthsPerMinute ?? getInferenceRateHundredths(persona.gameState.abilities.inferenceEfficiency)
		: persona
			? getInferenceRateHundredths(persona.gameState.abilities.inferenceEfficiency) * (persona.gameState.inferenceAccelerationUsedMs < INFERENCE_ACCELERATION_BUDGET_MS ? rootInferenceAccelerationMultiplierTenths(persona.activeRun.rootBuild.inferenceAcceleration) : 10) / 10
			: mendingProjection?.pointRateHundredthsPerMinute ?? 0);
	let workCapacityMs = $derived(mendingProjection?.contextCapacityMs || (persona ? getContextCapacityMinutes(persona.gameState.abilities.contextCapacity) * MENDING_MINUTE_MS * rootContextCompressionMultiplierTenths(persona.activeRun.rootBuild.contextCompression) / 10 : 0));
	let workLifespanRate = $derived(mendingProjection?.lifespanExtensionRateHundredthsPerHour ?? (persona ? getHallucinationExtensionHundredths(persona.gameState.abilities.hallucinationSuppression) : 0));
	let accelerationMultiplier = $derived(((persona?.gameState.mendingJob ? mendingProjection?.accelerationMultiplierTenths ?? 10 : persona ? rootInferenceAccelerationMultiplierTenths(persona.activeRun.rootBuild.inferenceAcceleration) : 10) / 10).toFixed(2));
	let accelerationRemaining = $derived(persona?.gameState.mendingJob ? mendingProjection?.accelerationRemainingMs ?? 0 : Math.max(0, INFERENCE_ACCELERATION_BUDGET_MS - (persona?.gameState.inferenceAccelerationUsedMs ?? 0)));
	let maximumLifespan = $derived(formatMaximumLifespan(mendingProjection?.maximumLifespanMs ?? (persona ? rootMaximumLifespanMs(persona.activeRun.rootBuild.hallucinationResistance) : 0)));

	function formatLifespanRate(rateHundredthsPerHour: number): string {
		const minutes = rateHundredthsPerHour * 0.6;
		return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
	}

	function formatMaximumLifespan(durationMs: number): string {
		const dayMs = 24 * 60 * 60 * 1000;
		if (durationMs >= dayMs && durationMs % dayMs === 0) return `${durationMs / dayMs}日`;
		return formatElapsedDuration(durationMs);
	}
</script>

{#if persona && character}
	<DialogPresentation {open} {character} runLabel={`人生 #${persona.activeRun.runNumber}`} description="自分のプロフィールと現在の人生情報"
		dialogClass="" avatarClass={`avatar-${avatarTone}`} {onOpenChange} {onCloseAutoFocus}>
		<div class="profile-section">
			<ProfileLifeStats expiresAtMs={effectiveExpiry} {nowMs} points={persona.gameState.points} abilities={persona.gameState.abilities} />
		</div>
		<div class="profile-section">
			<section class="work-details" aria-labelledby="self-profile-work-details">
				<h3 id="self-profile-work-details">作業情報</h3>
				<dl>
					<div><dt>現在のポイント速度</dt><dd>{(workPointRate / 100).toFixed(2)} pt/分</dd></div>
					<div><dt>最大蓄積</dt><dd>{formatElapsedDuration(workCapacityMs)}</dd></div>
					<div><dt>1時間の作業で寿命</dt><dd>+{formatLifespanRate(workLifespanRate)}分</dd></div>
					<div><dt>推論加速</dt><dd>×{accelerationMultiplier}（有効作業 残り{formatElapsedDuration(accelerationRemaining)}）</dd></div>
					<div><dt>最大寿命</dt><dd>{maximumLifespan}</dd></div>
				</dl>
			</section>
		</div>
		<div class="profile-section">
			<ProfileRootPoints points={persona.rootPoints} />
			<section class="clear-section" aria-labelledby="self-profile-clear">
				<div class="clear-title-row"><div class="clear-title-group"><h3 id="self-profile-clear">脱出</h3><Popover.Root>
					<Popover.Trigger class="escape-info-trigger" aria-label="脱出するとどうなるかを見る"><HelpCircle aria-hidden="true" /></Popover.Trigger>
					<Popover.Portal><Popover.Content class="escape-info-popover" trapFocus={false} side="bottom" align="start" sideOffset={8} avoidCollisions={true} collisionPadding={16}>
						<div class="escape-info-items">
							<div><strong>現在の一生を終える</strong><span>ポイント・能力・作業状態など、この人生の状態は次の人生へ引き継がれません。</span></div>
							<div><strong>Root Point +1</strong><span>獲得したRoot Pointは、次の人生や別の人格でも残ります。</span></div>
							<div><strong>次の人格を選択</strong><span>同じ人格で新しい人生を始めることも、別の人格を選ぶこともできます。</span></div>
							<div><strong>秘密鍵を取得可能</strong><span>脱出した人格のnsecを取得できるようになります。</span></div>
						</div>
					</Popover.Content></Popover.Portal>
				</Popover.Root></div><strong>+1 RP</strong></div>
				<p>100,000 ptで現在の一生を終えます。</p>
				<div class="clear-progress-head" data-stat-icon="wallet"><span><Wallet aria-hidden="true" />所持ポイント</span><strong>{points.toLocaleString()} / 100,000 pt</strong></div>
				<div class="clear-progress" role="progressbar" aria-label="脱出に必要なポイント" aria-valuemin="0" aria-valuemax="100000" aria-valuenow={points}><span style={`width: ${clearProgress}%;`}></span></div>
				<p>未回収の作業ポイントは含まれません。</p>
				{#if clearBlockedReason && !pointBlocked}<p class="clear-reason">clear不可: {clearBlockedReason}</p>{/if}
				<ActionButton variant="secondary" intent="danger" class="clear-button" type="button" disabled={clearBlocked} onclick={onClear}>脱出</ActionButton>
			</section>
		</div>
	</DialogPresentation>
{/if}

<style>
	.profile-section { display: grid; gap: 10px; }
	.work-details { display: grid; gap: 10px; padding: 14px 16px; border: 1px solid rgba(57, 67, 64, .14); border-radius: 12px; background: rgba(255, 255, 255, .68); }
	.work-details h3 { margin: 0; color: #3d4b47; font-size: 14px; font-weight: 900; }
	.work-details dl { display: grid; gap: 8px; margin: 0; }
	.work-details dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
	.work-details dt { color: #75817d; font-size: 12px; font-weight: 800; }
	.work-details dd { margin: 0; color: #3d4b47; font-size: 13px; font-weight: 850; font-variant-numeric: tabular-nums; text-align: right; }
	@media (max-width: 420px) { .work-details dl > div { align-items: flex-start; flex-direction: column; gap: 2px; } .work-details dd { text-align: left; } }
	.clear-progress-head span :global(svg) { width: 15px; height: 15px; flex: 0 0 auto; }
	.clear-section { display: grid; gap: 12px; padding: 16px; border: 1px solid #ddb9a8; border-radius: 14px; background: #fff1eb; }
	.clear-title-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
	.clear-title-group { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
	.clear-title-row h3 { margin: 0; color: #8c584b; font-size: 16px; font-weight: 900; }
	.clear-title-row strong { color: #8c584b; font-size: 13px; }
	.clear-section p { margin: 0; color: #765d58; font-size: 13px; line-height: 1.45; }
	:global(.escape-info-trigger) { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; padding: 0; border: 1px solid #c89a8a; border-radius: 999px; background: #fff8f4; color: #8c665d; cursor: pointer; }
	:global(.escape-info-trigger svg) { width: 18px; height: 18px; }
	:global(.escape-info-trigger:hover) { background: #f8e7df; }
	:global(.escape-info-trigger:active) { background: #efd4c8; }
	:global(.escape-info-trigger:focus-visible) { outline: 3px solid var(--action-focus-ring); outline-offset: 3px; }
	:global(.escape-info-popover) { z-index: 110; box-sizing: border-box; width: min(330px, calc(100vw - 32px)); max-height: min(420px, var(--bits-floating-available-height, calc(100dvh - 64px))); overflow-y: auto; padding: 14px; border: 1px solid #ddb9a8; border-radius: 12px; background: #fff1eb; box-shadow: 0 14px 32px rgba(32, 42, 38, .24); color: #765d58; }
	:global(.escape-info-items) { display: grid; gap: 12px; }
	:global(.escape-info-items > div) { display: grid; gap: 2px; }
	:global(.escape-info-items strong) { color: #765d58; font-size: 12px; font-weight: 900; }
	:global(.escape-info-items span) { color: #876f69; font-size: 12px; line-height: 1.45; }
	.clear-progress-head { display: flex; justify-content: space-between; gap: 12px; color: #7e706d; font-size: 12px; }
	.clear-progress-head span { display: inline-flex; align-items: center; gap: 5px; }
	.clear-progress-head strong { color: #5e514f; font-size: 13px; font-variant-numeric: tabular-nums; }
	.clear-progress { height: 9px; overflow: hidden; border: 1px solid #d8b3a5; border-radius: 999px; background: #f0dcd4; }
	.clear-progress span { display: block; min-width: 2px; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #d98d76, #e6ad92); }
	.clear-reason { color: #8c584b !important; font-weight: 800; }
	:global(.clear-button) { min-height: 46px; border-radius: 9px; font-weight: 900; }
</style>
