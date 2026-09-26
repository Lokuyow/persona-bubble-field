<script lang="ts">
	import { Dialog } from 'bits-ui';
	import Adjustments from '~icons/tabler/adjustments';
	import Brain from '~icons/tabler/brain';
	import ShieldCheck from '~icons/tabler/shield-check';
	import SquareChevronUp from '~icons/tabler/square-chevron-up';
	import Stack2 from '~icons/tabler/stack-2';
	import Wallet from '~icons/tabler/wallet';
	import PrimaryButton from '$lib/PrimaryButton.svelte';
	import {
		getAbilityUpgrade,
		getContextCapacityMinutes,
		getHallucinationExtensionHundredths,
		getInferenceRateHundredths,
		type PersonaAbilityKey,
		type PersonaAbilityLevels
	} from '$lib/personaGameState';

	type Props = Readonly<{
		open: boolean;
		points: number;
		abilities: PersonaAbilityLevels;
		busy: boolean;
		onOpenChange: (open: boolean) => void;
		onUpgrade: (key: PersonaAbilityKey) => void;
		upgradeFeedback?: Readonly<{ id: number; key: PersonaAbilityKey; level: number }> | null;
	}>;

	let { open, points, abilities, busy, onOpenChange, onUpgrade, upgradeFeedback = null }: Props = $props();
	const abilityLabels: Readonly<Record<PersonaAbilityKey, string>> = {
		inferenceEfficiency: '推論効率',
		contextCapacity: 'コンテキスト容量',
		hallucinationSuppression: 'ハルシネーション抑制'
	};
	const abilityTypes: Readonly<Record<PersonaAbilityKey, string>> = {
		inferenceEfficiency: 'ポイント生成速度',
		contextCapacity: '最大蓄積時間',
		hallucinationSuppression: '寿命延長量 / 作業1時間'
	};
	const abilityKeys: readonly PersonaAbilityKey[] = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];

	function formatDelta(key: PersonaAbilityKey, level: number): string {
		if (key === 'inferenceEfficiency') return `+${((getInferenceRateHundredths(level + 1) - getInferenceRateHundredths(level)) / 100).toFixed(2)} pt/分`;
		if (key === 'contextCapacity') return `+${getContextCapacityMinutes(level + 1) - getContextCapacityMinutes(level)}分`;
		return `+${((getHallucinationExtensionHundredths(level + 1) - getHallucinationExtensionHundredths(level)) / 100).toFixed(2)} h/h`;
	}

	function formatEffectValue(key: PersonaAbilityKey, level: number): string {
		if (key === 'inferenceEfficiency') return (getInferenceRateHundredths(level) / 100).toFixed(2);
		if (key === 'contextCapacity') return String(getContextCapacityMinutes(level));
		return (getHallucinationExtensionHundredths(level) / 100).toFixed(2);
	}

	function effectUnit(key: PersonaAbilityKey): string {
		return key === 'inferenceEfficiency' ? 'pt/分' : key === 'contextCapacity' ? '分' : 'h/h';
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="adjustment-dialog-overlay" />
			<Dialog.Content class="adjustment-dialog-content" preventScroll={false}>
				<header class="adjustment-dialog-header">
					<Dialog.Title class="adjustment-dialog-title"><Adjustments aria-hidden="true" />能力強化</Dialog.Title>
					<Dialog.Description class="sr-only">能力を強化して作業の効果を高めます。</Dialog.Description>
					<div class="points-display" aria-label={`所持ポイント ${points} pt`}>
						<Wallet aria-hidden="true" />
						<span>{points} pt</span>
					</div>
				</header>
				<section class="ability-list" aria-label="能力">
					{#each abilityKeys as key}
						{@const upgrade = getAbilityUpgrade(key, abilities)}
						{@const canAfford = points >= upgrade.cost}
						{@const isMaxed = upgrade.nextEffect === null}
						{@const upgradeName = `${abilityLabels[key]}をLv${upgrade.level + 1}へ強化`}
						<article class:success-flash={upgradeFeedback?.key === key} class="ability-card">
							<div class="ability-card-heading">
								<h2 class="ability-name">
									{#if key === 'inferenceEfficiency'}<Brain aria-hidden="true" />{:else if key === 'contextCapacity'}<Stack2 aria-hidden="true" />{:else}<ShieldCheck aria-hidden="true" />{/if}
									<span>{abilityLabels[key]}</span>
								</h2>
								<span class:level-up-highlight={upgradeFeedback?.key === key} class="ability-level">Lv{upgrade.level}</span>
								{#if upgradeFeedback?.key === key}
									{#key upgradeFeedback.id}<span class="level-up-badge" aria-live="polite">LEVEL UP</span>{/key}
								{/if}
							</div>
							<p class="ability-type">{abilityTypes[key]}</p>
							<div class="ability-values">
								<div class="value-row current-row"><span>現在値</span><strong><span>{formatEffectValue(key, upgrade.level)}</span><span class="unit">{effectUnit(key)}</span></strong></div>
								{#if !isMaxed}<div class="value-row delta-row"><span>増加量</span><strong>{formatDelta(key, upgrade.level)}</strong></div>{/if}
							</div>
							<PrimaryButton class={busy && !isMaxed ? 'upgrade-button processing' : isMaxed || canAfford ? 'upgrade-button' : 'upgrade-button insufficient-points'} type="button" aria-label={isMaxed ? `${abilityLabels[key]}は最大Lvです` : busy ? `${upgradeName}（必要${upgrade.cost}pt、強化処理中）` : !canAfford ? `${upgradeName}（必要${upgrade.cost}pt、ポイント不足）` : `${upgradeName}（必要${upgrade.cost}pt）`} disabled={busy || !canAfford || isMaxed} onclick={() => onUpgrade(key)}>
								{#if isMaxed}<span>最大Lv</span>{:else}<span class="upgrade-requirement"><span>必要</span>{' '}<strong>{upgrade.cost}pt</strong></span><SquareChevronUp aria-hidden="true" />{/if}
							</PrimaryButton>
						</article>
					{/each}
				</section>
				<footer class="adjustment-dialog-footer">
					<Dialog.Close class="terminal-secondary-action">閉じる</Dialog.Close>
				</footer>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.adjustment-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(4, 7, 18, .72); backdrop-filter: blur(2px); }
	:global(.adjustment-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 0; width: min(1080px, calc(100vw - 24px)); max-height: calc(100svh - 28px); overflow: auto; padding: 28px; border: 1px solid rgba(122, 135, 255, .74); border-radius: 18px; background: linear-gradient(180deg, rgba(12, 18, 46, .98), rgba(8, 12, 33, .98)); box-shadow: 0 20px 80px rgba(0, 0, 0, .48), 0 0 34px rgba(90, 103, 255, .13); color: #f4f6ff; transform: translate(-50%, -50%); }
	.adjustment-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
	:global(.adjustment-dialog-title) { display: inline-flex; align-items: center; gap: 9px; margin: 0; color: #f4f6ff; font-size: 22px; line-height: 1; font-weight: 800; letter-spacing: .03em; }
	:global(.adjustment-dialog-title svg) { width: 22px; height: 22px; color: #aeb6ff; stroke-width: 2; }
	:global(.adjustment-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.points-display { display: inline-flex; align-items: center; gap: 7px; color: #f4f6ff; font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.points-display :global(svg) { width: 18px; height: 18px; color: #aeb5d7; }
	.ability-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 14px; }
	.ability-card { position: relative; display: grid; grid-template-rows: auto auto 1fr auto; gap: 9px; min-width: 0; min-height: 250px; padding: 18px; border: 1px solid rgba(122, 135, 255, .42); border-radius: 12px; background: rgba(19, 26, 61, .78); }
	.success-flash { animation: ability-card-flash 420ms ease-out; }
	.level-up-highlight { animation: level-up-pop 420ms ease-out; }
	.level-up-badge { position: absolute; top: -14px; right: 0; pointer-events: none; color: #aeb6ff; font-size: 11px; font-weight: 900; letter-spacing: .08em; animation: level-up-badge 420ms ease-out both; }
	@keyframes ability-card-flash { 0%, 100% { border-color: rgba(122, 135, 255, .42); box-shadow: none; } 35% { border-color: #aeb6ff; box-shadow: 0 0 0 2px rgba(174, 182, 255, .3), 0 0 24px rgba(90, 103, 255, .3); } }
	@keyframes level-up-pop { 0%, 100% { color: #aeb6ff; } 35% { color: #fff; transform: scale(1.08); } }
	@keyframes level-up-badge { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
	@media (prefers-reduced-motion: reduce) { .success-flash { animation-name: ability-card-highlight; } .level-up-highlight { animation-name: level-up-color; } .level-up-badge { animation-name: level-up-fade; } }
	@keyframes ability-card-highlight { 0%, 100% { border-color: rgba(122, 135, 255, .42); } 35% { border-color: #aeb6ff; } }
	@keyframes level-up-color { 0%, 100% { color: #aeb6ff; } 35% { color: #fff; } }
	@keyframes level-up-fade { from { opacity: 0; } to { opacity: 1; } }
	.ability-card-heading { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.ability-name { display: flex; align-items: center; min-width: 0; gap: 8px; margin: 0; color: #f4f6ff; font-size: 16px; font-weight: 800; }
	.ability-name :global(svg) { flex: 0 0 auto; width: 20px; height: 20px; color: #aeb6ff; stroke-width: 2; }
	.ability-name span { overflow-wrap: anywhere; }
	.ability-level { flex: 0 0 auto; color: #aeb6ff; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.ability-type { margin: 0; color: #aeb5d7; font-size: 13px; line-height: 1.4; }
	.ability-values { align-self: end; display: grid; gap: 7px; padding: 12px 0 4px; border-top: 1px solid rgba(122, 135, 255, .28); }
	.value-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: #aeb5d7; font-size: 12px; }
	.value-row strong { color: #aeb6ff; font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
	.current-row strong { display: flex; align-items: baseline; gap: 5px; color: #f4f6ff; }
	.unit { color: inherit; font-size: .82em; font-weight: 700; white-space: nowrap; }
	.delta-row strong { color: #aeb6ff; }
	:global(.upgrade-button) { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-width: 0; min-height: 50px; height: 50px; padding: 0 14px; border-radius: 10px; font-size: 18px; font-variant-numeric: tabular-nums; }
	:global(.upgrade-button svg) { width: 24px; height: 24px; stroke-width: 2; }
	.upgrade-requirement { display: inline-flex; align-items: baseline; gap: 5px; }
	.upgrade-requirement > span { font-size: 14px; font-weight: 700; }
	.upgrade-requirement > strong { font-size: 18px; font-weight: 850; }
	:global(.upgrade-button.insufficient-points) { color: var(--color-primary-disabled-foreground); }
	:global(.upgrade-button.processing:disabled) { border-color: var(--color-primary-border); background: var(--color-primary-background); box-shadow: 0 0 16px var(--color-primary-shadow); opacity: .72; }
	.adjustment-dialog-footer { margin-top: 20px; }
	:global(.terminal-secondary-action) { width: 100%; min-height: 48px; border: 1px solid rgba(150, 164, 230, .34); border-radius: 9px; background: #151b41; color: #dde1f7; font: inherit; font-weight: 800; text-align: center; cursor: pointer; }
	:global(.adjustment-dialog-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 920px) { :global(.adjustment-dialog-content) { padding: 22px; } .ability-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ability-card { min-height: 238px; } }
	@media (max-width: 560px) { :global(.adjustment-dialog-content) { padding: 18px; } .ability-list { grid-template-columns: minmax(0, 1fr); } .ability-card { min-height: 220px; } }
</style>
