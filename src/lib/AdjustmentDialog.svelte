<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { getAbilityUpgrade, type PersonaAbilityKey, type PersonaAbilityLevels } from '$lib/personaGameState';

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
	const abilityKeys: readonly PersonaAbilityKey[] = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="adjustment-dialog-overlay" />
			<Dialog.Content class="adjustment-dialog-content" preventScroll={false}>
				<div class="terminal-dialog-header">
					<div>
						<Dialog.Title>能力強化</Dialog.Title>
						<Dialog.Description>ポイントを使って、より効率よく活動できるようにします。</Dialog.Description>
					</div>
					<div class="points-display">POINT {points} pt</div>
				</div>
				<div class="ability-list">
					{#each abilityKeys as key}
						{@const upgrade = getAbilityUpgrade(key, abilities)}
						<section class="ability-card">
							<div class="ability-card-heading"><h3 aria-label={`${abilityLabels[key]} Lv${upgrade.level}`}>{abilityLabels[key]} <span>Lv{upgrade.level}</span></h3></div>
							<p class="ability-description">
								{key === 'inferenceEfficiency' ? '作業1時間あたりの寿命延長量が増えます。' : key === 'contextCapacity' ? '成果を回収せずに蓄積できる時間が増えます。' : '1pt獲得に必要な作業時間が短くなります。'}
							</p>
							<p class="effect-row"><span>現在</span><strong>{upgrade.currentEffect}</strong></p>
							{#if upgrade.nextEffect}
								<p class="effect-row"><span>次</span><strong>{upgrade.nextEffect}</strong><span class="upgrade-cost">{upgrade.cost}pt</span></p>
								<button class="upgrade-action" type="button" disabled={busy || points < upgrade.cost} onclick={() => onUpgrade(key)}>1 level強化</button>
							{:else}
								<p class="max-level">最大level</p>
								<button class="upgrade-action" type="button" disabled>最大level</button>
							{/if}
						</section>
					{/each}
				</div>
				<Dialog.Close class="terminal-secondary-action">閉じる</Dialog.Close>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.adjustment-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(2, 5, 18, 0.74); backdrop-filter: blur(2px); }
	:global(.adjustment-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 20px; width: min(calc(100vw - 32px), 980px); max-height: calc(100svh - 32px); overflow: auto; padding: clamp(20px, 4vw, 34px); border: 1px solid rgba(122, 135, 255, 0.72); border-radius: 14px; background: linear-gradient(145deg, rgba(8, 15, 40, 0.98), rgba(10, 11, 31, 0.96)); box-shadow: 0 0 28px rgba(91, 105, 255, 0.22), inset 0 0 22px rgba(100, 108, 230, 0.08); color: #eef0ff; transform: translate(-50%, -50%); }
	:global(.adjustment-dialog-content)::before { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background-image: linear-gradient(rgba(122, 135, 255, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(122, 135, 255, 0.035) 1px, transparent 1px); background-size: 22px 22px; content: ''; pointer-events: none; }
	.terminal-dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(122, 135, 255, 0.38); }
	:global(.adjustment-dialog-content h2) { margin: 0; color: #f6f7ff; font-size: clamp(1.6rem, 4vw, 2.25rem); letter-spacing: 0.08em; }
	:global(.adjustment-dialog-content [data-slot='dialog-description']) { display: block; margin-top: 6px; color: rgba(218, 220, 255, 0.78); font-size: 0.92rem; line-height: 1.5; }
	.points-display { display: grid; gap: 2px; min-width: 135px; padding: 8px 11px; border: 1px solid rgba(122, 135, 255, 0.55); border-radius: 6px; color: #adb4ff; letter-spacing: 0.1em; text-align: right; }
	.points-display { color: #f6f7ff; font-size: 1.3rem; font-weight: 800; letter-spacing: 0; }
	.ability-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
	.ability-card { display: grid; align-content: start; gap: 11px; padding: 16px; border: 1px solid rgba(122, 135, 255, 0.48); border-radius: 9px; background: rgba(19, 26, 68, 0.62); }
	.ability-card-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
	.ability-card h3 { margin: 0; color: #f6f7ff; font-size: 1.05rem; }
	.ability-card-heading h3 { display: flex; align-items: baseline; gap: 8px; }
	.ability-card-heading h3 span { color: #adb4ff; font-weight: 800; white-space: nowrap; }
	.ability-card p { margin: 0; }
	.ability-description { min-height: 3.2em; color: rgba(218, 220, 255, 0.76); font-size: 0.87rem; line-height: 1.45; }
	.effect-row { display: flex; align-items: baseline; gap: 8px; padding-top: 9px; border-top: 1px solid rgba(122, 135, 255, 0.28); color: rgba(218, 220, 255, 0.72); }
	.effect-row strong { margin-left: auto; color: #f6f7ff; font-size: 1rem; }
	.upgrade-cost { color: #c0c5ff; font-weight: 800; }
	.max-level { color: #adb4ff; font-weight: 800; }
	.upgrade-action, :global(.terminal-secondary-action) { min-height: 46px; border-radius: 7px; font: inherit; font-weight: 800; cursor: pointer; }
	.upgrade-action { border: 1px solid #aab0ff; background: linear-gradient(135deg, #5361e8, #2936a9); box-shadow: 0 0 14px rgba(90, 103, 255, 0.24); color: #fff; }
	.upgrade-action:disabled { cursor: not-allowed; border-color: rgba(158, 166, 221, 0.3); background: rgba(59, 69, 115, 0.58); box-shadow: none; color: rgba(219, 222, 255, 0.48); }
	:global(.terminal-secondary-action) { border: 1px solid rgba(150, 164, 230, 0.42); background: rgba(25, 31, 70, 0.72); color: rgba(232, 234, 255, 0.86); text-align: center; }
	:global(.adjustment-dialog-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 700px) { .terminal-dialog-header { flex-direction: column; } .points-display { width: fit-content; text-align: left; } .ability-list { grid-template-columns: 1fr; } .ability-description { min-height: 0; } }
</style>
