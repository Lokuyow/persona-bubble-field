<script lang="ts">
	import { Dialog, Popover, ScrollArea } from 'bits-ui';
	import HelpCircle from '~icons/tabler/help-circle';
	import Heart from '~icons/tabler/heart';
	import Wallet from '~icons/tabler/wallet';
	import type { MendingProjection } from '$lib/mending';
	import { formatRemainingLifespan } from '$lib/lifespanHud';
	import { getAbilityUpgrade, type PersonaAbilityKey } from '$lib/personaGameState';
	import type { PersonaSnapshot } from '$lib/rootIdentity';
	import type { BubbleTone } from '$lib/bubblePresentation';
	import CharacterAvatar from './CharacterAvatar.svelte';
	import { getCharacterById } from './character';

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
	const abilityKeys: readonly PersonaAbilityKey[] = ['inferenceEfficiency', 'contextCapacity', 'hallucinationSuppression'];
	const abilityLabels: Readonly<Record<PersonaAbilityKey, string>> = {
		inferenceEfficiency: '推論効率', contextCapacity: 'コンテキスト容量', hallucinationSuppression: 'ハルシネーション抑制'
	};
	let character = $derived(persona ? getCharacterById(persona.identity.characterId) ?? null : null);
	let initialFocusTarget = $state<HTMLElement | null>(null);
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
			<Dialog.Content class="self-profile-content" preventScroll={false} {onCloseAutoFocus} onOpenAutoFocus={(event) => { event.preventDefault(); initialFocusTarget?.focus(); }}>
				<ScrollArea.Root class="self-profile-scroll" type="auto">
					<ScrollArea.Viewport class="self-profile-viewport">
						<div class="self-profile-sections">
						<section class="profile-section" aria-labelledby="self-profile-profile">
							<h2 bind:this={initialFocusTarget} id="self-profile-profile" tabindex="-1" data-initial-focus>プロフィール</h2>
							<header class="self-profile-head">
								<CharacterAvatar class={`avatar avatar-${avatarTone} self-profile-avatar`} {character} />
								<div class="self-profile-identity">
									<Dialog.Title>{character.name}</Dialog.Title>
									<Dialog.Description class="sr-only">自分のプロフィールと現在の人生情報</Dialog.Description>
									<span>人生 #{persona.activeRun.runNumber}</span>
								</div>
							</header>
							<p class="self-profile-about">{character.about}</p>
						</section>
						<section class="profile-section" aria-labelledby="self-profile-run">
							<h2 id="self-profile-run">人生</h2>
							<div class="summary-grid" aria-label="現在状態">
								<div class="summary-card" data-stat-icon="heart"><span><Heart aria-hidden="true" />残り寿命</span><strong>{formatRemainingLifespan(effectiveExpiry, nowMs)}</strong></div>
								<div class="summary-card" data-stat-icon="wallet"><span><Wallet aria-hidden="true" />所持ポイント</span><strong>{points} pt</strong></div>
							</div>
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
							<div class="clear-section" aria-labelledby="self-profile-clear">
							<div class="clear-title-row"><div class="clear-title-group"><h3 id="self-profile-clear">脱出</h3><Popover.Root>
								<Popover.Trigger class="escape-info-trigger" aria-label="脱出するとどうなるかを見る">
									<HelpCircle aria-hidden="true" />
								</Popover.Trigger>
								<Popover.Portal>
																				<Popover.Content class="escape-info-popover" trapFocus={false} side="bottom" align="start" sideOffset={8} avoidCollisions={true} collisionPadding={16}>
										<div class="escape-info-items">
											<div><strong>現在の一生を終える</strong><span>ポイント・能力・作業状態など、この人生の状態は次の人生へ引き継がれません。</span></div>
											<div><strong>Root Point +1</strong><span>獲得したRoot Pointは、次の人生や別の人格でも残ります。</span></div>
											<div><strong>次の人格を選択</strong><span>同じ人格で新しい人生を始めることも、別の人格を選ぶこともできます。</span></div>
											<div><strong>秘密鍵を取得可能</strong><span>脱出した人格のnsecを取得できるようになります。</span></div>
										</div>
									</Popover.Content>
								</Popover.Portal>
							</Popover.Root></div><strong>+1 RP</strong></div>
							<p>100,000 ptで現在の一生を終えます。</p>
							<div class="clear-progress-head" data-stat-icon="wallet"><span><Wallet aria-hidden="true" />所持ポイント</span><strong>{points.toLocaleString()} / 100,000 pt</strong></div>
							<div class="clear-progress" role="progressbar" aria-label="脱出に必要なポイント" aria-valuemin="0" aria-valuemax="100000" aria-valuenow={points}><span style={`width: ${clearProgress}%;`}></span></div>
							<p>未回収の作業ポイントは含まれません。</p>
							{#if clearBlockedReason && !pointBlocked}<p class="clear-reason">clear不可: {clearBlockedReason}</p>{/if}
							<button class="clear-button" type="button" disabled={clearBlocked} onclick={onClear}>脱出</button>
							</div>
						</section>
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar class="self-profile-scrollbar" orientation="vertical"><ScrollArea.Thumb class="self-profile-thumb" /></ScrollArea.Scrollbar>
				</ScrollArea.Root>
				<footer class="self-profile-footer"><Dialog.Close class="action-button action-button-tertiary self-profile-close">閉じる</Dialog.Close></footer>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.self-profile-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(35, 44, 41, .48); backdrop-filter: blur(3px); }
	:global(.self-profile-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 22px; box-sizing: border-box; width: min(560px, calc(100vw - 32px)); max-height: min(760px, calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px)); padding: 24px; overflow: hidden; border: 1px solid rgba(57, 67, 64, .26); border-radius: 24px; background: #f1f5f0; box-shadow: 0 22px 60px rgba(32, 42, 38, .28); color: #374345; font-family: 'Trebuchet MS', 'Avenir Next', system-ui, sans-serif; transform: translate(-50%, -50%); }
	.self-profile-head { display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 18px; align-items: center; }
	:global(.self-profile-avatar) { position: relative !important; inset: auto !important; display: grid; width: 128px; height: 128px; place-items: center; border: 2px solid rgba(255, 255, 255, .9); border-radius: 42% 58% 48% 52%; box-shadow: 0 5px 10px rgba(58, 70, 61, .14); transform: none !important; }
	:global(.self-profile-avatar img) { width: 100%; height: 100%; object-fit: contain; }
	.self-profile-identity { display: grid; gap: 5px; }
	:global(.self-profile-identity [data-dialog-title]) { margin: 0; font-size: 24px; font-weight: 900; }
	.self-profile-identity span { color: #75817d; font-size: 13px; font-weight: 900; letter-spacing: .04em; }
	:global(.self-profile-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	:global(.self-profile-scroll) { min-height: 0; overflow: hidden; }
	:global(.self-profile-viewport) { min-height: 0; max-height: 100%; overflow-y: auto; padding-right: 8px; }
	.self-profile-sections { display: grid; gap: 32px; }
	.self-profile-about { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; color: #56625e; font-size: 14px; font-weight: 700; line-height: 1.65; }
	.summary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
	.summary-card, .ability-row, .root-row { border: 1px solid rgba(57, 67, 64, .14); border-radius: 12px; background: rgba(255, 255, 255, .68); }
	.summary-card { padding: 14px 15px; }
	.summary-card span { display: block; margin-bottom: 5px; color: #75817d; font-size: 12px; font-weight: 800; }
	.summary-card span :global(svg) { vertical-align: -3px; margin-right: 5px; }
	.summary-card span :global(svg), .clear-progress-head span :global(svg) { width: 15px; height: 15px; flex: 0 0 auto; }
	.summary-card strong { font-size: 20px; font-weight: 900; font-variant-numeric: tabular-nums; }
	.profile-section { display: grid; gap: 10px; }
	.profile-section h2 { margin: 0; color: #56625e; font-size: 14px; font-weight: 900; letter-spacing: .04em; }
	:global(.self-profile-content [data-initial-focus]:focus) { outline: none; }
	.ability-list { display: grid; gap: 8px; }
	.ability-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 11px 12px; }
	.ability-row > div { display: grid; gap: 2px; }
	.ability-row > div:last-child { text-align: right; }
	.ability-row strong { font-size: 14px; font-weight: 900; }
	.ability-row span { color: #75817d; font-size: 12px; }
	.ability-row > div:last-child strong { color: #5663d1; font-variant-numeric: tabular-nums; }
	.root-row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 14px; font-size: 14px; }
	.root-row strong { font-variant-numeric: tabular-nums; }
	.clear-section { display: grid; gap: 12px; padding: 16px; border: 1px solid #ddb9a8; border-radius: 14px; background: #fff1eb; }
	.clear-title-row { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
	.clear-title-group { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
	.clear-title-row h3 { margin: 0; color: #8c584b; font-size: 16px; font-weight: 900; }
	.clear-title-row strong { color: #8c584b; font-size: 13px; }
	.clear-section p { margin: 0; color: #765d58; font-size: 13px; line-height: 1.45; }
	:global(.escape-info-trigger) { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; padding: 0; border: 0; border-radius: 999px; background: transparent; color: #8c665d; cursor: pointer; }
	:global(.escape-info-trigger svg) { width: 18px; height: 18px; }
	:global(.escape-info-trigger:hover) { background: rgba(156, 104, 87, .1); }
	:global(.escape-info-trigger:focus-visible) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
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
	.clear-button { min-height: 46px; border: 1px solid rgba(156, 104, 87, .3); border-radius: 9px; background: #e5c7ba; color: #876e67; font: inherit; font-weight: 900; cursor: pointer; }
	.clear-button:disabled { cursor: not-allowed; }
	.self-profile-footer { display: flex; justify-content: flex-end; }
	:global(.self-profile-close) { min-height: 44px; padding: 0 18px; border-radius: 999px; font-size: 13px; font-weight: 900; }
	:global(.self-profile-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	:global(.self-profile-scrollbar) { display: flex; width: 10px; padding: 2px; border-radius: 999px; background: rgba(86, 105, 98, .12); }
	:global(.self-profile-thumb) { flex: 1; border-radius: inherit; background: #8fa8a0; }
	@media (max-width: 600px) { :global(.self-profile-content) { gap: 18px; width: min(560px, calc(100vw - 20px)); max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 16px); padding: 18px; } .self-profile-sections { gap: 24px; } .self-profile-head { grid-template-columns: 96px minmax(0, 1fr); } :global(.self-profile-avatar) { width: 96px; height: 96px; border-radius: 32% 68% 42% 58%; } :global(.self-profile-identity [data-dialog-title]) { font-size: 20px; } .summary-grid { grid-template-columns: 1fr; } }
</style>
