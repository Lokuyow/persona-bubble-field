<script lang="ts">
	import { Dialog, ScrollArea } from 'bits-ui';
	import type { MendingProjection } from '$lib/mending';
	import { formatRemainingLifespan } from '$lib/lifespanHud';
	import { getAbilityUpgrade, type PersonaAbilityKey } from '$lib/personaGameState';
	import type { PersonaSnapshot } from '$lib/rootIdentity';
	import CharacterAvatar from './CharacterAvatar.svelte';
	import { getCharacterById } from './character';

	type Props = Readonly<{
		open: boolean;
		persona: PersonaSnapshot | null;
		mendingProjection: MendingProjection | null;
		nowMs: number;
		clearBlockedReason: string | null;
		clearBusy: boolean;
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
		onClear: () => void;
	}>;

	let { open, persona, mendingProjection, nowMs, clearBlockedReason, clearBusy, onOpenChange, onCloseAutoFocus, onClear }: Props = $props();
	const abilityKeys: readonly PersonaAbilityKey[] = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];
	const abilityLabels: Readonly<Record<PersonaAbilityKey, string>> = {
		inferenceEfficiency: '推論効率', contextCapacity: 'コンテキスト容量', hallucinationSuppression: 'ハルシネーション抑制'
	};
	let character = $derived(persona ? getCharacterById(persona.identity.characterId) ?? null : null);
	let effectiveExpiry = $derived(mendingProjection?.effectiveExpiresAtMs ?? persona?.gameState.lifespanExpiresAtMs ?? nowMs);
	let points = $derived(persona?.gameState.points ?? 0);
	let clearProgress = $derived(Math.min(100, points / 100_000 * 100));
	let pointBlocked = $derived(points < 100_000);
	let clearBlocked = $derived(pointBlocked || clearBusy || clearBlockedReason !== null);

	function abilityType(key: PersonaAbilityKey): string {
		return key === 'inferenceEfficiency' ? 'ポイント生成速度' : key === 'contextCapacity' ? '最大蓄積時間' : '寿命延長量 / 作業1時間';
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open && persona && character}
		<Dialog.Portal>
			<Dialog.Overlay class="self-profile-overlay" />
			<Dialog.Content class="self-profile-content" preventScroll={false} {onCloseAutoFocus}>
				<header class="self-profile-head">
					<CharacterAvatar class="self-profile-avatar" {character} />
					<div class="self-profile-identity">
						<Dialog.Title>{character.name}</Dialog.Title>
						<Dialog.Description class="sr-only">自分のプロフィールと現在のRun情報</Dialog.Description>
						<span>Run #{persona.activeRun.runNumber}</span>
					</div>
				</header>
				<ScrollArea.Root class="self-profile-scroll" type="auto">
					<ScrollArea.Viewport class="self-profile-viewport">
						<section class="summary-grid" aria-label="現在状態">
							<div class="summary-card"><span>残り寿命</span><strong>{formatRemainingLifespan(effectiveExpiry, nowMs)}</strong></div>
							<div class="summary-card"><span>所持ポイント</span><strong>{points} pt</strong></div>
						</section>
						<section class="profile-section" aria-labelledby="self-profile-abilities">
							<h2 id="self-profile-abilities">Run能力</h2>
							<div class="ability-list">
								{#each abilityKeys as key}
									{@const upgrade = getAbilityUpgrade(key, persona.gameState.abilities)}
									<div class="ability-row"><div><strong>{abilityLabels[key]}</strong><span>{abilityType(key)}</span></div><div><strong>Lv{upgrade.level}</strong><span>{upgrade.currentEffect}</span></div></div>
								{/each}
							</div>
						</section>
						<section class="profile-section" aria-labelledby="self-profile-root">
							<h2 id="self-profile-root">Root</h2>
							<div class="root-row"><span>Root Point</span><strong>{persona.rootPoints} RP</strong></div>
						</section>
						<section class="clear-section" aria-labelledby="self-profile-clear">
							<div class="clear-title-row"><h2 id="self-profile-clear">Normal Clear</h2><strong>+1 RP</strong></div>
							<p>100,000 ptで現在のRunを終了します。未回収の作業ポイントは含まれません。</p>
							<div class="clear-progress-head"><span>現在所持 / 100,000 pt</span><strong>{points.toLocaleString()} / 100,000 pt</strong></div>
							<div class="clear-progress" role="progressbar" aria-label="Normal Clearに必要なポイント" aria-valuemin="0" aria-valuemax="100000" aria-valuenow={points}><span style={`width: ${clearProgress}%;`}></span></div>
							{#if clearBlockedReason && !pointBlocked}<p class="clear-reason">clear不可: {clearBlockedReason}</p>{/if}
							<button class="clear-button" type="button" disabled={clearBlocked} onclick={onClear}>Normal Clear（+1 RP）</button>
						</section>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar class="self-profile-scrollbar" orientation="vertical"><ScrollArea.Thumb class="self-profile-thumb" /></ScrollArea.Scrollbar>
				</ScrollArea.Root>
				<footer class="self-profile-footer"><Dialog.Close class="self-profile-close">閉じる</Dialog.Close></footer>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.self-profile-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(35, 44, 41, .48); backdrop-filter: blur(3px); }
	:global(.self-profile-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 22px; width: min(560px, calc(100vw - 32px)); max-height: min(760px, calc(100dvh - 28px)); padding: 24px; overflow: hidden; border: 1px solid rgba(57, 67, 64, .20); border-radius: 24px; background: #f7f7ef; box-shadow: 0 22px 60px rgba(32, 42, 38, .28); color: #374345; font-family: 'Trebuchet MS', 'Avenir Next', system-ui, sans-serif; transform: translate(-50%, -50%); }
	.self-profile-head { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 18px; align-items: center; }
	:global(.self-profile-avatar) { position: relative !important; inset: auto !important; display: grid; width: 96px; height: 96px; place-items: center; border: 2px solid rgba(255, 255, 255, .9); border-radius: 28px; background: #9bc6d5; box-shadow: 0 5px 10px rgba(58, 70, 61, .14); transform: none !important; }
	:global(.self-profile-avatar img) { width: 100%; height: 100%; object-fit: contain; }
	.self-profile-identity { display: grid; gap: 5px; }
	:global(.self-profile-identity [data-dialog-title]) { margin: 0; font-size: 24px; font-weight: 900; }
	.self-profile-identity span { color: #75817d; font-size: 13px; font-weight: 900; letter-spacing: .04em; }
	:global(.self-profile-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	:global(.self-profile-scroll) { min-height: 0; overflow: hidden; }
	:global(.self-profile-viewport) { display: grid; gap: 22px; max-height: 100%; padding-right: 8px; }
	.summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
	.summary-card, .ability-row, .root-row { border: 1px solid rgba(57, 67, 64, .14); border-radius: 12px; background: rgba(255, 255, 255, .58); }
	.summary-card { padding: 14px 15px; }
	.summary-card span { display: block; margin-bottom: 5px; color: #75817d; font-size: 12px; font-weight: 800; }
	.summary-card strong { font-size: 20px; font-weight: 900; font-variant-numeric: tabular-nums; }
	.profile-section { display: grid; gap: 10px; }
	.profile-section h2 { margin: 0; color: #56625e; font-size: 14px; font-weight: 900; letter-spacing: .04em; }
	.ability-list { display: grid; gap: 8px; }
	.ability-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 11px 12px; }
	.ability-row > div { display: grid; gap: 2px; }
	.ability-row > div:last-child { text-align: right; }
	.ability-row strong { font-size: 14px; font-weight: 900; }
	.ability-row span { color: #75817d; font-size: 12px; }
	.ability-row > div:last-child strong { color: #5663d1; font-variant-numeric: tabular-nums; }
	.root-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; font-size: 14px; }
	.root-row strong { font-variant-numeric: tabular-nums; }
	.clear-section { display: grid; gap: 12px; padding: 16px; border: 1px solid #dbc69a; border-radius: 14px; background: #fff5e4; }
	.clear-title-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
	.clear-title-row h2 { margin: 0; color: #79613c; font-size: 16px; font-weight: 900; }
	.clear-title-row strong { color: #79613c; font-size: 13px; }
	.clear-section p { margin: 0; color: #756b58; font-size: 13px; line-height: 1.45; }
	.clear-progress-head { display: flex; justify-content: space-between; gap: 12px; color: #8b806c; font-size: 12px; }
	.clear-progress-head strong { color: #5e5548; font-size: 13px; font-variant-numeric: tabular-nums; }
	.clear-progress { height: 9px; overflow: hidden; border: 1px solid #d6c39d; border-radius: 999px; background: #eadfc9; }
	.clear-progress span { display: block; min-width: 2px; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #b89656, #d1b576); }
	.clear-reason { color: #79613c !important; font-weight: 800; }
	.clear-button { min-height: 46px; border: 1px solid rgba(154, 132, 88, .3); border-radius: 9px; background: #ded3bb; color: #a1957d; font: inherit; font-weight: 900; cursor: pointer; }
	.clear-button:disabled { cursor: not-allowed; }
	.self-profile-footer { display: flex; justify-content: flex-end; }
	:global(.self-profile-close) { min-height: 42px; padding: 0 18px; border: 1px solid rgba(57, 67, 64, .20); border-radius: 999px; background: #d9edf0; color: #374345; font: inherit; font-size: 13px; font-weight: 900; }
	:global(.self-profile-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	:global(.self-profile-scrollbar) { display: flex; width: 10px; padding: 2px; border-radius: 999px; background: rgba(86, 105, 98, .12); }
	:global(.self-profile-thumb) { flex: 1; border-radius: inherit; background: #8fa8a0; }
	@media (max-width: 600px) { :global(.self-profile-content) { gap: 18px; padding: 18px; } .self-profile-head { grid-template-columns: 72px minmax(0, 1fr); } :global(.self-profile-avatar) { width: 72px; height: 72px; border-radius: 22px; } :global(.self-profile-identity [data-dialog-title]) { font-size: 20px; } .summary-grid { grid-template-columns: 1fr; } }
</style>
