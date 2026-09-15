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
				<Dialog.Title>調整端末</Dialog.Title>
				<Dialog.Description>所持ポイントを使って能力を強化します。</Dialog.Description>
				<p class="points">所持ポイント: <strong>{points.toFixed(2)}pt</strong></p>
				<div class="ability-list">
					{#each abilityKeys as key}
						{@const upgrade = getAbilityUpgrade(key, abilities)}
						<section class="ability-card">
							<h3>{abilityLabels[key]} Lv{upgrade.level}</h3>
							<p>現在: {upgrade.currentEffect}</p>
							{#if upgrade.nextEffect}
								<p>次: {upgrade.nextEffect} / {upgrade.cost}pt</p>
								<button type="button" disabled={busy || points < upgrade.cost} onclick={() => onUpgrade(key)}>1 level強化</button>
							{:else}
								<p>最大level</p>
								<button type="button" disabled>最大level</button>
							{/if}
						</section>
					{/each}
				</div>
				<Dialog.Close>閉じる</Dialog.Close>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.adjustment-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(35, 44, 41, 0.48); }
	:global(.adjustment-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 14px; width: min(calc(100vw - 32px), 720px); max-height: calc(100svh - 32px); overflow: auto; padding: 24px; border-radius: 20px; background: #f7f7ef; color: #374345; transform: translate(-50%, -50%); }
	:global(.adjustment-dialog-content h3), :global(.adjustment-dialog-content p) { margin: 0; }
	.points { font-size: 1.05rem; }
	.ability-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
	.ability-card { display: grid; gap: 8px; padding: 14px; border: 1px solid rgba(57, 67, 64, 0.18); border-radius: 12px; background: rgba(255, 255, 255, 0.5); }
	.ability-card p { font-size: 0.9rem; }
	:global(.adjustment-dialog-content button) { min-height: 42px; border: 1px solid rgba(57, 67, 64, 0.2); border-radius: 999px; background: #d9edf0; color: inherit; font: inherit; font-weight: 800; }
	:global(.adjustment-dialog-content button:disabled) { cursor: not-allowed; opacity: 0.5; }
	@media (max-width: 620px) { .ability-list { grid-template-columns: 1fr; } }
</style>
