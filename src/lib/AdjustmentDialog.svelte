<script lang="ts">
	import { Dialog } from 'bits-ui';
	import ArrowRight from '~icons/tabler/arrow-right';
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
	}>;

	let { open, points, abilities, busy, onOpenChange, onUpgrade }: Props = $props();
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
		if (level >= 100) return '';
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
					<Dialog.Title class="adjustment-dialog-title">能力強化</Dialog.Title>
					<Dialog.Description class="sr-only">Run能力を強化して作業の効果を高めます。</Dialog.Description>
					<div class="points-display" aria-label={`所持ポイント ${points} pt`}>
						<Wallet aria-hidden="true" />
						<span>{points} pt</span>
					</div>
				</header>
				<section class="ability-list" aria-label="Run能力">
					{#each abilityKeys as key}
						{@const upgrade = getAbilityUpgrade(key, abilities)}
						<article class="ability-card">
							<div class="ability-card-heading">
								<h2 class="ability-name">{abilityLabels[key]}</h2>
								<span class="ability-level">Lv{upgrade.level}</span>
							</div>
							<p class="ability-type">{abilityTypes[key]}</p>
							<div class="change">
								{#if upgrade.nextEffect}
									<div class="change-main">
										<span class="current">{formatEffectValue(key, upgrade.level)}</span>
										<ArrowRight class="change-arrow" aria-hidden="true" />
										<span class="next">{formatEffectValue(key, upgrade.level + 1)}</span>
										<span class="unit">{effectUnit(key)}</span>
									</div>
									<span class="delta">{formatDelta(key, upgrade.level)}</span>
								{:else}
									<div class="change-main"><span class="current">{formatEffectValue(key, upgrade.level)} {effectUnit(key)}</span></div>
								{/if}
							</div>
							<div class="cost"><span>必要ポイント</span><strong>{upgrade.nextEffect ? `${upgrade.cost} pt` : '—'}</strong></div>
							<PrimaryButton type="button" disabled={busy || points < upgrade.cost || !upgrade.nextEffect} onclick={() => onUpgrade(key)}>{upgrade.nextEffect ? `Lv${upgrade.level + 1}へ強化` : '最大Lv'}</PrimaryButton>
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
	:global(.adjustment-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 0; width: min(980px, calc(100vw - 24px)); max-height: calc(100svh - 28px); overflow: auto; padding: 34px; border: 1px solid rgba(122, 135, 255, .74); border-radius: 18px; background: linear-gradient(180deg, rgba(12, 18, 46, .98), rgba(8, 12, 33, .98)); box-shadow: 0 20px 80px rgba(0, 0, 0, .48), 0 0 34px rgba(90, 103, 255, .13); color: #f4f6ff; transform: translate(-50%, -50%); }
	.adjustment-dialog-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 34px; }
	:global(.adjustment-dialog-title) { margin: 0; color: #f4f6ff; font-size: 22px; line-height: 1; font-weight: 800; letter-spacing: .03em; }
	:global(.adjustment-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.points-display { display: inline-flex; align-items: center; gap: 7px; color: #f4f6ff; font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.points-display :global(svg) { width: 18px; height: 18px; color: #aeb5d7; }
	.ability-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
	.ability-card { display: grid; grid-template-rows: auto auto 1fr auto auto; gap: 14px; min-height: 292px; padding: 20px; border: 1px solid rgba(122, 135, 255, .42); border-radius: 12px; background: rgba(19, 26, 61, .78); }
	.ability-card-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
	.ability-name { margin: 0; color: #f4f6ff; font-size: 17px; font-weight: 800; }
	.ability-level { color: #aeb6ff; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.ability-type { margin: 0; color: #aeb5d7; font-size: 13px; line-height: 1.4; }
	.change { align-self: end; display: grid; gap: 6px; padding: 15px 0 2px; border-top: 1px solid rgba(122, 135, 255, .28); }
	.change-main { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
	.current, .next { color: #f4f6ff; font-size: 25px; font-weight: 850; line-height: 1.1; }
	:global(.change-arrow) { width: 18px; height: 18px; color: #7f8cff; flex: 0 0 auto; }
	.unit { color: #aeb5d7; font-size: 13px; font-weight: 700; }
	.delta { color: #aeb6ff; font-size: 12px; font-weight: 700; }
	.cost { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #aeb5d7; font-size: 13px; }
	.cost strong { color: #f4f6ff; font-size: 14px; font-variant-numeric: tabular-nums; }
	.adjustment-dialog-footer { margin-top: 28px; }
	:global(.terminal-secondary-action) { width: 100%; min-height: 48px; border: 1px solid rgba(150, 164, 230, .34); border-radius: 9px; background: #151b41; color: #dde1f7; font: inherit; font-weight: 800; text-align: center; cursor: pointer; }
	:global(.adjustment-dialog-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 820px) { :global(.adjustment-dialog-content) { padding: 24px; } .ability-list { grid-template-columns: 1fr; } .ability-card { min-height: 0; } }
</style>
