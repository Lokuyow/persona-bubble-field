<script lang="ts">
	import Heart from '~icons/tabler/heart';
	import Brain from '~icons/tabler/brain';
	import Stack2 from '~icons/tabler/stack-2';
	import ShieldCheck from '~icons/tabler/shield-check';
	import Wallet from '~icons/tabler/wallet';
	import { formatRemainingLifespan } from '$lib/lifespanHud';
	import { getAbilityUpgrade, type PersonaAbilityKey, type PersonaAbilityLevels } from '$lib/personaGameState';

	let { expiresAtMs, nowMs, points, abilities }: {
		expiresAtMs: number; nowMs: number; points: number; abilities: PersonaAbilityLevels;
	} = $props();
	const abilityKeys: readonly PersonaAbilityKey[] = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];
	const abilityLabels: Readonly<Record<PersonaAbilityKey, string>> = {
		inferenceEfficiency: '推論効率', contextCapacity: 'コンテキスト容量', hallucinationSuppression: 'ハルシネーション抑制'
	};
	function abilityType(key: PersonaAbilityKey): string {
		return key === 'inferenceEfficiency' ? 'ポイント生成速度' : key === 'contextCapacity' ? '最大蓄積時間' : '寿命延長量 / 作業1時間';
	}
</script>

<div class="profile-life-stats">
	<div class="summary-grid" aria-label="現在状態">
		<div class="summary-card" data-stat-icon="heart"><span><Heart aria-hidden="true" />残り寿命</span><strong>{formatRemainingLifespan(expiresAtMs, nowMs)}</strong></div>
		<div class="summary-card" data-stat-icon="wallet"><span><Wallet aria-hidden="true" />所持ポイント</span><strong>{points} pt</strong></div>
	</div>
	<div class="ability-list">
		{#each abilityKeys as key}
			{@const upgrade = getAbilityUpgrade(key, abilities)}
			<div class="ability-row" data-ability-key={key}><div class="ability-info"><span class="ability-icon" aria-hidden="true" data-ability-icon={key === 'inferenceEfficiency' ? 'brain' : key === 'contextCapacity' ? 'stack-2' : 'shield-check'}>{#if key === 'inferenceEfficiency'}<Brain />{:else if key === 'contextCapacity'}<Stack2 />{:else}<ShieldCheck />{/if}</span><div class="ability-copy"><strong>{abilityLabels[key]}</strong><span>{abilityType(key)}</span></div></div><div class="ability-values"><strong>Lv{upgrade.level}</strong><span>{upgrade.currentEffect}</span></div></div>
		{/each}
	</div>
</div>

<style>
	.profile-life-stats { display: grid; gap: 12px; }
	.summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
	.summary-card, .ability-row { border: 1px solid rgba(57, 67, 64, .14); border-radius: 12px; background: rgba(255, 255, 255, .68); }
	.summary-card { display: grid; gap: 5px; min-width: 0; padding: 12px; }
	.summary-card > span { display: flex; align-items: center; gap: 6px; color: #75817d; font-size: 12px; font-weight: 800; }
	.summary-card > span :global(svg) { width: 15px; height: 15px; }
	.summary-card > strong { color: #3d4b47; font-size: 18px; font-weight: 900; font-variant-numeric: tabular-nums; }
	.ability-list { display: grid; gap: 8px; }
	.ability-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 11px 12px; }
	.ability-info { display: flex; align-items: center; gap: 9px; min-width: 0; }
	.ability-copy { display: grid; gap: 2px; min-width: 0; }
	.ability-icon { display: grid !important; width: 22px; height: 22px; flex: 0 0 22px; place-items: center; margin: 0 !important; color: #5663d1 !important; }
	.ability-icon :global(svg) { width: 20px; height: 20px; }
	.ability-values { display: grid; gap: 2px; text-align: right; }
	.ability-row strong { font-size: 14px; font-weight: 900; }
	.ability-row span { color: #75817d; font-size: 12px; }
	.ability-row > div:last-child strong { color: #5663d1; font-variant-numeric: tabular-nums; }
	@media (max-width: 380px) { .summary-grid { grid-template-columns: 1fr; } }
</style>
