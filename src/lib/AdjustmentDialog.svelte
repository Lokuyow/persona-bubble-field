<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { tick } from 'svelte';
	import { createTimeline } from 'animejs/timeline';
	import type { Scope } from 'animejs/scope';
	import type { Timeline } from 'animejs/timeline';
	import Adjustments from '~icons/tabler/adjustments';
	import Brain from '~icons/tabler/brain';
	import ShieldCheck from '~icons/tabler/shield-check';
	import SquareChevronUpFilled from '~icons/tabler/square-chevron-up-filled';
	import Stack2 from '~icons/tabler/stack-2';
	import X from '~icons/tabler/x';
	import Wallet from '~icons/tabler/wallet';
	import { formatContextCapacityMinutes } from '$lib/abilityDisplay';
	import ActionButton from '$lib/ActionButton.svelte';
	import { createPresentationScope } from '$lib/presentationMotion';
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
		tutorialUpgradeRequired?: boolean;
		onOpenChange: (open: boolean) => void;
		onUpgrade: (key: PersonaAbilityKey) => void;
		upgradeFeedback?: Readonly<{ id: number; key: PersonaAbilityKey; level: number }> | null;
	}>;

	let { open, points, abilities, busy, tutorialUpgradeRequired = false, onOpenChange, onUpgrade, upgradeFeedback = null }: Props = $props();
	let dialogContent = $state<HTMLElement | null>(null);
	let presentationScope = $state.raw<Scope | null>(null);
	let activeTimeline: Timeline | null = null;
	let activeTimelineCleanup: (() => void) | null = null;
	let consumedUpgradeFeedbackId: number | null = null;
	let pendingUpgradeFeedback: Readonly<{ id: number; root: HTMLElement; scope: Scope }> | null = null;
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
		if (key === 'contextCapacity') return formatContextCapacityMinutes(getContextCapacityMinutes(level));
		return (getHallucinationExtensionHundredths(level) / 100).toFixed(2);
	}

	function effectUnit(key: PersonaAbilityKey): string {
		return key === 'inferenceEfficiency' ? 'pt/分' : key === 'contextCapacity' ? '分' : 'h/h';
	}

	function focusFirstAvailableUpgrade(event: Event): void {
		event.preventDefault();
		document.querySelector<HTMLElement>('.adjustment-dialog-content .adjustment-dialog-title')?.focus({ preventScroll: true });
	}

	function revertUpgradeTimeline(): void {
		const timeline = activeTimeline;
		const cleanup = activeTimelineCleanup;
		activeTimeline = null;
		activeTimelineCleanup = null;
		if (!timeline) return;
		timeline.revert();
		cleanup?.();
	}

	$effect(() => {
		const root = dialogContent;
		if (!root) return;

		const scope = createPresentationScope(root);
		presentationScope = scope;
		scope.add(() => () => {
			activeTimelineCleanup?.();
			activeTimelineCleanup = null;
			activeTimeline = null;
		});
		scope.add('playUpgradeFeedback', () => {
			revertUpgradeTimeline();

			const card = root.querySelector<HTMLElement>('.ability-card.success-flash');
			const level = card?.querySelector<HTMLElement>('.ability-level.level-up-highlight');
			const badge = card?.querySelector<HTMLElement>('.level-up-badge');
			const halo = card?.querySelector<SVGCircleElement>('.upgrade-burst-halo');
			const ring = card?.querySelector<SVGCircleElement>('.upgrade-burst-ring');
			const rays = card?.querySelector<SVGGElement>('.upgrade-burst-rays');
			const particles = card ? [...card.querySelectorAll<SVGCircleElement>('.upgrade-burst-particle')] : [];
			if (!card || !level || !badge || !halo || !ring || !rays || particles.length === 0) return;

			const reducedMotion = scope.matches.reducedMotion;
			let timeline: Timeline;
			timeline = createTimeline({
				autoplay: false,
				defaults: { duration: 620, ease: 'out(3)' },
				onComplete: () => {
					if (activeTimeline !== timeline) return;
					revertUpgradeTimeline();
				}
			});

			timeline.add(card, {
				keyframes: reducedMotion
					? {
							'0%': { borderColor: 'rgba(122, 135, 255, .42)' },
							'35%': { borderColor: '#d6d9ff' },
							'100%': { borderColor: 'rgba(122, 135, 255, .42)' }
						}
					: {
							'0%': { borderColor: 'rgba(122, 135, 255, .42)', boxShadow: 'none' },
							'32%': { borderColor: '#e0e2ff', boxShadow: '0 0 0 2px rgba(174, 182, 255, .34), 0 0 30px rgba(90, 103, 255, .42)' },
							'100%': { borderColor: 'rgba(122, 135, 255, .42)', boxShadow: 'none' }
						}
			}, 0);
			timeline.add(level, {
				keyframes: reducedMotion
					? {
							'0%': { color: '#aeb6ff', textShadow: '0 0 0 rgba(210, 216, 255, 0)' },
							'35%': { color: '#fff', textShadow: '0 0 12px rgba(210, 216, 255, .75)' },
							'100%': { color: '#aeb6ff', textShadow: '0 0 0 rgba(210, 216, 255, 0)' }
						}
					: {
							'0%': { color: '#aeb6ff', scale: 1, textShadow: '0 0 0 rgba(210, 216, 255, 0)' },
							'34%': { color: '#fff', scale: 1.16, textShadow: '0 0 14px rgba(210, 216, 255, .9)' },
							'62%': { color: '#fff', scale: 1.04, textShadow: '0 0 8px rgba(210, 216, 255, .58)' },
							'100%': { color: '#aeb6ff', scale: 1, textShadow: '0 0 0 rgba(210, 216, 255, 0)' }
						}
			}, 0);
			timeline.add(badge, {
				keyframes: reducedMotion
					? { '0%': { opacity: 0 }, '100%': { opacity: 1 } }
					: { '0%': { opacity: 0, translateY: '5px', scale: .88 }, '45%': { opacity: 1, translateY: '-1px', scale: 1.08 }, '100%': { opacity: 1, translateY: '0px', scale: 1 } }
			}, 0);
			timeline.add(halo, reducedMotion
				? { keyframes: { '0%': { opacity: 0 }, '30%': { opacity: .56 }, '100%': { opacity: 0 } }, duration: 520 }
				: { keyframes: { '0%': { opacity: 0, scale: .5 }, '32%': { opacity: .72, scale: 1.05 }, '100%': { opacity: 0, scale: 1.18 } }, duration: 560 }, 0);
			timeline.add(ring, reducedMotion
				? { keyframes: { '0%': { opacity: 0 }, '34%': { opacity: .62 }, '100%': { opacity: 0 } }, duration: 560 }
				: { keyframes: { '0%': { opacity: 0, scale: .42 }, '32%': { opacity: .82, scale: 1.02 }, '100%': { opacity: 0, scale: 1.32 } }, duration: 610 }, 0);
			timeline.add(rays, reducedMotion
				? { keyframes: { '0%': { opacity: 0 }, '32%': { opacity: .48 }, '100%': { opacity: 0 } }, duration: 560 }
				: { keyframes: { '0%': { opacity: 0, scale: .68, rotate: '-8deg' }, '34%': { opacity: .76, scale: 1.02, rotate: '5deg' }, '100%': { opacity: 0, scale: 1.08, rotate: '0deg' } }, duration: 610 }, 40);
			const opacityOnly = (from: number, to: number, duration: number) => ({ opacity: { from, to }, duration });
			for (const particle of particles) {
				const fadeAt = reducedMotion ? 430 : 540;
				const fadeDuration = reducedMotion ? 190 : 90;
				const motion = reducedMotion
					? opacityOnly(0, .78, 260)
					: {
						opacity: { from: 0, to: .92 },
						translateX: `${particle.dataset.dx ?? '0'}px`,
						translateY: `${particle.dataset.dy ?? '0'}px`,
						duration: 430
					};
				timeline.add(particle, motion, 110);
				timeline.add(particle, opacityOnly(reducedMotion ? .78 : .92, 0, fadeDuration), fadeAt);
			}

			const inlineStyleSnapshot = [
				{ element: card, properties: ['border-color', 'box-shadow'] },
				{ element: level, properties: ['color', 'transform', 'text-shadow'] },
				{ element: badge, properties: ['opacity', 'transform'] },
				{ element: halo, properties: ['opacity', 'transform'] },
				{ element: ring, properties: ['opacity', 'transform'] },
				{ element: rays, properties: ['opacity', 'transform'] },
				...particles.map((particle) => ({ element: particle, properties: ['opacity', 'transform'] }))
			].flatMap(({ element, properties }) => properties.map((property) => ({
				element,
				property,
				value: element.style.getPropertyValue(property),
				priority: element.style.getPropertyPriority(property)
			})));
			activeTimelineCleanup = () => {
				for (const { element, property, value, priority } of inlineStyleSnapshot) {
					if (value) element.style.setProperty(property, value, priority);
					else element.style.removeProperty(property);
				}
			};
			activeTimeline = timeline;
			timeline.play();
		});

		return () => {
			revertUpgradeTimeline();
			scope.revert();
			if (presentationScope === scope) presentationScope = null;
		};
	});

	$effect(() => {
		if (!open) {
			revertUpgradeTimeline();
			pendingUpgradeFeedback = null;
		}
	});

	$effect(() => {
		if (!upgradeFeedback) revertUpgradeTimeline();
	});

	$effect(() => {
		const feedback = upgradeFeedback;
		const scope = presentationScope;
		const root = dialogContent;
		if (!feedback || !open || !scope || !root || consumedUpgradeFeedbackId === feedback.id || pendingUpgradeFeedback?.id === feedback.id) return;

		const pending = { id: feedback.id, root, scope };
		pendingUpgradeFeedback = pending;
		void tick().then(() => {
			if (pendingUpgradeFeedback !== pending) return;
			pendingUpgradeFeedback = null;
			if (!open || dialogContent !== pending.root || presentationScope !== pending.scope || upgradeFeedback?.id !== feedback.id) return;

			consumedUpgradeFeedbackId = feedback.id;
			pending.scope.methods.playUpgradeFeedback();
		});
	});

</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	<Dialog.Portal>
			<Dialog.Overlay class="adjustment-dialog-overlay" />
			<Dialog.Content bind:ref={dialogContent} class="adjustment-dialog-content dialog-mobile-layout" preventScroll={false} onOpenAutoFocus={focusFirstAvailableUpgrade}>
				<div class="dialog-mobile-scroll-content">
					<header class="adjustment-dialog-header">
						<Dialog.Title class="adjustment-dialog-title" tabindex={-1}><Adjustments aria-hidden="true" />能力強化</Dialog.Title>
						<Dialog.Description class="sr-only">能力を強化して作業の効果を高めます。</Dialog.Description>
						<div class="points-display" aria-label={`所持ポイント ${points} pt`}>
							<Wallet aria-hidden="true" />
							<span>{points} pt</span>
						</div>
						<Dialog.Close class="action-button action-button-tertiary action-button-close dialog-close-header" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
					</header>
					{#if tutorialUpgradeRequired}
						<p class="tutorial-upgrade-guidance" data-first-run-ability-guidance role="status" aria-live="polite">能力をどれか1つ強化してください。</p>
					{/if}
					<section class="ability-list" aria-label="能力">
						{#each abilityKeys as key}
							{@const upgrade = getAbilityUpgrade(key, abilities)}
							{@const canAfford = points >= upgrade.cost}
							{@const isMaxed = upgrade.nextEffect === null}
							{@const upgradeName = `${abilityLabels[key]}をLv${upgrade.level + 1}へ強化`}
							<article class:success-flash={upgradeFeedback?.key === key} class:tutorial-upgrade-choice={tutorialUpgradeRequired && canAfford && !isMaxed} class="ability-card">
								<div class="ability-card-heading">
									<h2 class="ability-name">
										{#if key === 'inferenceEfficiency'}<Brain aria-hidden="true" />{:else if key === 'contextCapacity'}<Stack2 aria-hidden="true" />{:else}<ShieldCheck aria-hidden="true" />{/if}
										<span>{abilityLabels[key]}</span>
									</h2>
									<span class:level-up-highlight={upgradeFeedback?.key === key} class="ability-level">
										{#if upgradeFeedback?.key === key}
											<svg class="upgrade-burst" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
												<circle class="upgrade-burst-halo" cx="60" cy="60" r="24" fill="#aeb6ff" />
												<circle class="upgrade-burst-ring" cx="60" cy="60" r="23" fill="none" stroke="#dce0ff" stroke-width="2" />
												<g class="upgrade-burst-rays" fill="none" stroke="#cbd0ff" stroke-linecap="round" stroke-width="2.5">
													<path d="M60 7v13 M60 100v13 M7 60h13 M100 60h13 M22.5 22.5l9 9 M88.5 88.5l9 9 M97.5 22.5l-9 9 M31.5 88.5l-9 9" />
												</g>
												<g fill="#f4f5ff" stroke="#aeb6ff" stroke-width=".8">
													<circle class="upgrade-burst-particle" data-dx="-22" data-dy="-10" cx="60" cy="60" r="2.4" />
													<circle class="upgrade-burst-particle" data-dx="-14" data-dy="-24" cx="60" cy="60" r="2" />
													<circle class="upgrade-burst-particle" data-dx="5" data-dy="-29" cx="60" cy="60" r="2.5" />
													<circle class="upgrade-burst-particle" data-dx="23" data-dy="-16" cx="60" cy="60" r="2" />
													<circle class="upgrade-burst-particle" data-dx="24" data-dy="9" cx="60" cy="60" r="2.4" />
													<circle class="upgrade-burst-particle" data-dx="-7" data-dy="27" cx="60" cy="60" r="2" />
												</g>
											</svg>
										{/if}
										<span>Lv{upgrade.level}</span>
									</span>
									{#if upgradeFeedback?.key === key}
										{#key upgradeFeedback.id}<span class="level-up-badge" aria-live="polite">LEVEL UP</span>{/key}
									{/if}
								</div>
								<p class="ability-type">{abilityTypes[key]}</p>
								<div class="ability-values">
									<div class="value-row current-row"><span>現在値</span><strong><span>{formatEffectValue(key, upgrade.level)}</span>{#if key !== 'contextCapacity'}<span class="unit">{effectUnit(key)}</span>{/if}</strong></div>
									{#if !isMaxed}<div class="value-row delta-row"><span>増加量</span><strong>{formatDelta(key, upgrade.level)}</strong></div>{/if}
								</div>
								<ActionButton variant="primary" class={busy && !isMaxed ? 'upgrade-button processing' : 'upgrade-button'} type="button" aria-label={isMaxed ? `${abilityLabels[key]}は最大Lvです` : busy ? `${upgradeName}（必要${upgrade.cost}pt、強化処理中）` : !canAfford ? `${upgradeName}（必要${upgrade.cost}pt、ポイント不足）` : `${upgradeName}（必要${upgrade.cost}pt）`} disabled={busy || !canAfford || isMaxed} onclick={() => onUpgrade(key)}>
									{#if isMaxed}<span>最大Lv</span>{:else}<span class="upgrade-requirement"><span>必要</span>{' '}<strong>{upgrade.cost}pt</strong></span><SquareChevronUpFilled aria-hidden="true" />{/if}
				</ActionButton>
							</article>
						{/each}
					</section>
					</div>
				<div class="dialog-mobile-close-footer">
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</div>
			</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.adjustment-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(4, 7, 18, .72); backdrop-filter: blur(2px); }
	:global(.adjustment-dialog-content) { --dialog-mobile-padding-top: 28px; --dialog-mobile-padding-inline: 28px; --dialog-mobile-close-footer-inset: 28px; position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 0; width: min(1080px, calc(100vw - 24px)); max-height: calc(100svh - 28px); overflow: auto; padding: 28px; border: 1px solid rgba(122, 135, 255, .74); border-radius: 18px; background: linear-gradient(180deg, rgba(12, 18, 46, .98), rgba(8, 12, 33, .98)); box-shadow: 0 20px 80px rgba(0, 0, 0, .48), 0 0 34px rgba(90, 103, 255, .13); color: #f4f6ff; transform: translate(-50%, -50%); }
	.adjustment-dialog-header { position: sticky; top: -28px; z-index: 2; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 16px; margin: -28px -28px 22px; padding: 28px; background: linear-gradient(180deg, rgba(12, 18, 46, 1), rgba(8, 12, 33, 1)); }
	:global(.adjustment-dialog-title) { display: inline-flex; align-items: center; gap: 9px; margin: 0; color: #f4f6ff; font-size: 22px; line-height: 1; font-weight: 800; letter-spacing: .03em; }
	.points-display { grid-column: 2; }
	.tutorial-upgrade-guidance { margin: 0 0 14px; padding: 10px 14px; border: 1px solid rgba(72, 221, 210, .7); border-radius: 10px; background: rgba(72, 221, 210, .1); animation: first-run-tutorial-guidance-pulse 2.6s ease-in-out infinite; color: #f4f6ff; font-weight: 750; text-align: center; }
	@keyframes first-run-tutorial-guidance-pulse {
		0%, 100% { box-shadow: 0 0 5px rgba(72, 221, 210, .16); }
		50% { box-shadow: 0 0 16px rgba(72, 221, 210, .58); }
	}
	.adjustment-dialog-header :global(.action-button-close) { grid-column: 3; }
	:global(.adjustment-dialog-title svg) { width: 22px; height: 22px; color: #aeb6ff; stroke-width: 2; }
	:global(.adjustment-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.points-display { display: inline-flex; align-items: center; gap: 7px; color: #f4f6ff; font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.points-display :global(svg) { width: 18px; height: 18px; color: #aeb5d7; }
	.ability-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: stretch; gap: 14px; }
	.ability-card { position: relative; isolation: isolate; display: grid; grid-template-rows: auto auto 1fr auto; gap: 9px; min-width: 0; min-height: 250px; padding: 18px; border: 1px solid rgba(122, 135, 255, .42); border-radius: 12px; background: rgba(19, 26, 61, .78); }
	.ability-card.success-flash { overflow: clip; overflow-clip-margin: 8px; }
	.ability-card > * { position: relative; z-index: 1; }
	.upgrade-burst { position: absolute; top: 50%; left: 50%; z-index: 0; width: 126px; height: auto; overflow: hidden; pointer-events: none; filter: drop-shadow(0 0 7px rgba(174, 182, 255, .28)); transform: translate(-50%, -50%); }
	.upgrade-burst-halo, .upgrade-burst-ring, .upgrade-burst-rays, .upgrade-burst-particle { opacity: 0; transform-box: fill-box; transform-origin: center; }
	.ability-card.tutorial-upgrade-choice { outline: 2px solid rgba(72, 221, 210, .88); outline-offset: 2px; animation: first-run-tutorial-upgrade-pulse 2.6s ease-in-out infinite; }
	@keyframes first-run-tutorial-upgrade-pulse {
		0%, 100% { box-shadow: 0 0 7px rgba(72, 221, 210, .14); }
		50% { box-shadow: 0 0 18px rgba(72, 221, 210, .52); }
	}
	@media (prefers-reduced-motion: reduce) { .tutorial-upgrade-guidance, .ability-card.tutorial-upgrade-choice { animation: none; } }
	.level-up-badge { position: absolute; z-index: 2; top: -14px; right: 0; pointer-events: none; color: #aeb6ff; font-size: 11px; font-weight: 900; letter-spacing: .08em; }
	.ability-card-heading { position: relative; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.ability-name { display: flex; align-items: center; min-width: 0; gap: 8px; margin: 0; color: #f4f6ff; font-size: 16px; font-weight: 800; }
	.ability-name :global(svg) { flex: 0 0 auto; width: 20px; height: 20px; color: #aeb6ff; stroke-width: 2; }
	.ability-name span { overflow-wrap: anywhere; }
	.ability-level { position: relative; z-index: 1; flex: 0 0 auto; color: #aeb6ff; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; white-space: nowrap; }
	.ability-level > span { position: relative; z-index: 1; }
	.ability-type { margin: 0; color: #aeb5d7; font-size: 13px; line-height: 1.4; }
	.ability-values { align-self: end; display: grid; gap: 7px; padding: 12px 0 4px; border-top: 1px solid rgba(122, 135, 255, .28); }
	.value-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: #aeb5d7; font-size: 12px; }
	.value-row strong { color: #aeb6ff; font-size: 19px; font-weight: 800; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
	.current-row strong { display: flex; align-items: baseline; gap: 5px; color: #f4f6ff; }
	.unit { color: inherit; font-size: .82em; font-weight: 700; white-space: nowrap; }
	.delta-row strong { color: #aeb6ff; }
	:global(.upgrade-button) { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-width: 0; min-height: 50px; height: 50px; padding: 0 14px; border-radius: 10px; font-size: 18px; font-variant-numeric: tabular-nums; }
	:global(.upgrade-button svg) { width: 28px; height: 28px; stroke-width: 2; }
	.upgrade-requirement { display: inline-flex; align-items: baseline; gap: 5px; }
	.upgrade-requirement > span { font-size: 14px; font-weight: 700; }
	.upgrade-requirement > strong { font-size: 18px; font-weight: 850; }
	:global(.adjustment-dialog-content button:focus-visible:not(.action-button-close)) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 920px) { :global(.adjustment-dialog-content) { --dialog-mobile-padding-top: 22px; --dialog-mobile-padding-inline: 22px; --dialog-mobile-close-footer-inset: 22px; padding: 22px; } .adjustment-dialog-header { top: -22px; margin: -22px -22px 22px; padding: 22px; } .ability-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ability-card { min-height: 238px; } }
	@media (max-width: 560px) { :global(.adjustment-dialog-content) { --dialog-mobile-padding-top: 18px; --dialog-mobile-padding-inline: 18px; --dialog-mobile-close-footer-inset: 18px; padding: 18px; } .adjustment-dialog-header { top: -18px; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; margin: -18px -18px 22px; padding: 18px; } :global(.adjustment-dialog-title) { grid-row: 1; grid-column: 1; } .points-display { grid-row: 2; grid-column: 1 / 3; } .ability-list { grid-template-columns: minmax(0, 1fr); } .ability-card { min-height: 220px; } }
</style>
