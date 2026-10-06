<script lang="ts">
	import { Dialog } from 'bits-ui';
	import { tick } from 'svelte';
	import { createTimeline } from 'animejs/timeline';
	import type { Scope } from 'animejs/scope';
	import type { Timeline } from 'animejs/timeline';
	import Coins from '~icons/tabler/coins';
	import Clock from '~icons/tabler/clock';
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import PlayerPause from '~icons/tabler/player-pause';
	import Tool from '~icons/tabler/tool';
	import X from '~icons/tabler/x';
	import ArrowBarToDown from '~icons/tabler/arrow-bar-to-down';
	import Wallet from '~icons/tabler/wallet';
	import ActionButton from '$lib/ActionButton.svelte';
	import type { MendingProjection } from '$lib/mending';
	import { formatElapsedDuration, formatRemainingDuration } from '$lib/lifespanHud';
	import { createPresentationScope } from '$lib/presentationMotion';

	type CollectionFeedback = Readonly<{ id: number; points: number; lifespanMs: number }>;
	const collectionCues = {
		impact: 0,
		pickup: 0.045,
		ring: 0.12,
		rays: 0.20,
		sparkle: 0.27,
		reward: 0.34,
		jackpot: 0.37,
		release: 0.44,
		end: 0.54
	} as const;
	const collectionCueAt = (cue: keyof typeof collectionCues): number => collectionCues[cue] * 1000;
	const rewardSummaryReadableHoldDuration = 1200;
	const rewardSummaryFadeDuration = 280;

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		starting?: boolean;
		points: number;
		onOpenChange: (open: boolean) => void;
		onCollect: () => void;
		collectFeedback?: CollectionFeedback | null;
		startupFeedback?: Readonly<{ id: number; phase: 'starting' | 'started' }> | null;
	}>;

	let { open, projection, hasJob, starting = false, points: ownedPointsValue, onOpenChange, onCollect, collectFeedback = null, startupFeedback = null }: Props = $props();
	let dialogContent = $state<HTMLElement | null>(null);
	let rewardLayer = $state<HTMLElement | null>(null);
	let presentationScope = $state.raw<Scope | null>(null);
	let rewardPresentation = $state.raw<CollectionFeedback | null>(null);
	let activeRewardTimeline: Timeline | null = null;
	let activeRewardCleanup: (() => void) | null = null;
	let consumedCollectFeedbackId: number | null = null;
	let pendingCollectFeedback: Readonly<{ id: number; root: HTMLElement; scope: Scope }> | null = null;
	let remainingDuration = $derived(formatRemainingDuration(projection?.remainingDurationMs ?? 0));
	let lifespanDuration = $derived(formatElapsedDuration(projection?.lifespanExtensionMs ?? 0));
	let unclaimedPoints = $derived(String(projection?.points ?? 0));
	let ownedPoints = $derived(String(ownedPointsValue));
	let nextPointSeconds = $derived(projection?.nextPointRemainingMs === null || projection?.nextPointRemainingMs === undefined
		? null
		: Math.min(60, Math.max(1, Math.ceil(projection.nextPointRemainingMs / 1000))));
	let totalDurationMs = $derived((projection?.processedDurationMs ?? 0) + (projection?.remainingDurationMs ?? 0));
	let progressPercent = $derived(Math.min(100, totalDurationMs > 0 ? (projection?.processedDurationMs ?? 0) / totalDurationMs * 100 : 0));
	let overflowPointAvailable = $derived(Boolean(projection?.completed && (projection?.pointRateHundredthsPerMinute ?? 0) > 0));
	let overflowLifespanAvailable = $derived(Boolean(projection?.completed && (projection?.lifespanExtensionRateHundredthsPerHour ?? 0) > 0));
	let overflowRewardAvailable = $derived(overflowPointAvailable || overflowLifespanAvailable);
	let workStatusTitle = $derived(!projection?.completed ? '作業中' : overflowRewardAvailable ? '延命中' : '作業停止中');

	function focusFirstAction(event: Event): void {
		const content = event.currentTarget;
		if (!(content instanceof HTMLElement)) return;
		const action = content.querySelector<HTMLButtonElement>('.collect-button:not(:disabled)');
		if (!action) return;
		event.preventDefault();
		action.focus();
	}

	function clearRewardPresentation(clearSnapshot = true): void {
		const timeline = activeRewardTimeline;
		const cleanup = activeRewardCleanup;
		activeRewardTimeline = null;
		activeRewardCleanup = null;
		if (timeline) timeline.revert();
		cleanup?.();
		if (clearSnapshot) rewardPresentation = null;
	}

	function announceCollection(feedback: CollectionFeedback): string {
		const lifespan = feedback.lifespanMs > 0
			? ` 寿命延長 +${formatElapsedDuration(feedback.lifespanMs)}は作業中に反映済みです。`
			: '';
		return `成果を受け取りました。${feedback.points}ポイント。${lifespan}`;
	}

	$effect(() => {
		const root = dialogContent;
		if (!root) return;

		const scope = createPresentationScope(root);
		presentationScope = scope;
		scope.add(() => () => clearRewardPresentation());
		scope.add('playCollectionReward', () => {
			clearRewardPresentation(false);
			const feedback = rewardPresentation;
			const layer = rewardLayer;
			const summary = layer?.querySelector<HTMLElement>('.reward-summary');
			const impactBloom = layer?.querySelector<HTMLElement>('.reward-impact-bloom');
			const jackpotBloom = layer?.querySelector<HTMLElement>('.reward-jackpot-bloom');
			const primaryRays = layer?.querySelector<SVGElement>('.reward-burst-rays-primary');
			const secondaryRays = layer?.querySelector<SVGElement>('.reward-burst-rays-secondary');
			const rings = layer ? [...layer.querySelectorAll<SVGCircleElement>('.reward-burst-ring')] : [];
			const sparkles = layer?.querySelector<SVGElement>('.reward-burst-sparkles');
			const particles = layer ? [...layer.querySelectorAll<SVGCircleElement>('.reward-particle')] : [];
			const wallet = root.querySelector<SVGElement>('[data-mending-icon="wallet"] svg');
			const pointsValue = root.querySelector<HTMLElement>('.owned-points-value');
			const pointsCard = root.querySelector<HTMLElement>('.result-card[data-mending-icon="coins"]');
			const lifespanCard = feedback?.lifespanMs ? root.querySelector<HTMLElement>('.result-card[data-mending-icon="heart"]') : null;
			const rewardPoints = layer?.querySelector<HTMLElement>('.reward-summary-points');
			if (!feedback || !open || dialogContent !== root || !layer || !summary || !impactBloom || !jackpotBloom || !primaryRays || !secondaryRays || rings.length !== 3 || !sparkles || particles.length === 0 || !wallet || !pointsValue || !pointsCard || !rewardPoints) return;

			const reducedMotion = scope.matches.reducedMotion;
			const timeline = createTimeline({
				autoplay: false,
				defaults: { duration: 120, ease: 'out(3)' },
				onComplete: () => {
					if (activeRewardTimeline !== timeline || rewardPresentation?.id !== feedback.id) return;
					clearRewardPresentation();
				}
			});
			const pointsBorder = getComputedStyle(pointsCard).borderColor;
			const lifespanBorder = lifespanCard ? getComputedStyle(lifespanCard).borderColor : null;

			const introDuration = collectionCueAt('reward') - collectionCueAt('pickup');
			const rewardDuration = collectionCueAt('release') - collectionCueAt('reward');
			const tailDuration = collectionCueAt('end') - collectionCueAt('release');
			const rewardSummaryFadeAt = collectionCueAt('reward') + rewardSummaryReadableHoldDuration;
			const opacityOnly = (from: number, to: number, duration: number) => ({ opacity: { from, to }, duration });

			// The full-screen layer stays outside layout; only its fixed decorative targets are animated.
			timeline.add(impactBloom, opacityOnly(0, 0.92, collectionCueAt('pickup') - collectionCueAt('impact')), collectionCueAt('impact'));
			timeline.add(impactBloom, opacityOnly(0.92, 0, collectionCueAt('ring') - collectionCueAt('pickup')), collectionCueAt('pickup'));
			timeline.add(summary, {
				keyframes: reducedMotion
					? { '0%': { opacity: 0 }, '100%': { opacity: 1 } }
					: {
							'0%': { opacity: 0, scale: 0.86, translateY: '8px' },
							'55%': { opacity: 1, scale: 1.04, translateY: '0px' },
							'100%': { opacity: 1, scale: 1 }
						},
				duration: introDuration
			}, collectionCueAt('pickup'));
			for (const [index, ring] of rings.entries()) {
				const cue = collectionCueAt('ring') + index * 85;
				const duration = collectionCueAt('rays') - collectionCueAt('ring');
				timeline.add(ring, reducedMotion
					? opacityOnly(0, 0.98 - index * 0.12, duration)
					: { opacity: { from: 0, to: 0.98 - index * 0.12 }, scale: { from: 0.36 + index * 0.16, to: 2.05 - index * 0.24 }, duration }, cue);
				timeline.add(ring, opacityOnly(0.86 - index * 0.12, 0, tailDuration), collectionCueAt('release'));
			}
			timeline.add(primaryRays, reducedMotion
				? opacityOnly(0, 0.98, collectionCueAt('sparkle') - collectionCueAt('rays'))
				: { opacity: { from: 0, to: 0.98 }, scale: { from: 0.55, to: 1.12 }, rotate: { from: -5, to: 5 }, duration: collectionCueAt('sparkle') - collectionCueAt('rays') }, collectionCueAt('rays'));
			timeline.add(secondaryRays, reducedMotion
				? opacityOnly(0, 0.86, collectionCueAt('sparkle') - collectionCueAt('rays'))
				: { opacity: { from: 0, to: 0.86 }, scale: { from: 0.48, to: 1.2 }, rotate: { from: 4, to: -4 }, duration: collectionCueAt('sparkle') - collectionCueAt('rays') }, collectionCueAt('rays') + 45);
			timeline.add(sparkles, reducedMotion
				? opacityOnly(0, 0.98, collectionCueAt('jackpot') - collectionCueAt('sparkle'))
				: { opacity: { from: 0, to: 1 }, scale: { from: 0.45, to: 1.34 }, duration: collectionCueAt('jackpot') - collectionCueAt('sparkle') }, collectionCueAt('sparkle'));
			timeline.add(jackpotBloom, reducedMotion
				? opacityOnly(0, 0.92, collectionCueAt('release') - collectionCueAt('jackpot'))
				: { opacity: { from: 0, to: 0.96 }, scale: { from: 0.7, to: 1 }, duration: collectionCueAt('release') - collectionCueAt('jackpot') }, collectionCueAt('jackpot'));
			for (const particle of particles) {
				const particleDuration = collectionCueAt('release') - collectionCueAt('sparkle');
				const motion = {
					opacity: { from: 0, to: 1 },
					translateX: `${particle.dataset.dx ?? '0'}px`,
					translateY: `${particle.dataset.dy ?? '0'}px`,
					rotate: `${particle.dataset.rotate ?? '0'}deg`,
					duration: particleDuration
				};
				timeline.add(particle, reducedMotion ? opacityOnly(0, 0.96, particleDuration) : motion, collectionCueAt('sparkle'));
				timeline.add(particle, opacityOnly(1, 0, tailDuration), collectionCueAt('release'));
			}
			timeline.add(wallet, reducedMotion
				? { keyframes: { '0%': { color: '#35e3e8', filter: 'drop-shadow(0 0 0 rgba(100,245,240,0))' }, '50%': { color: '#eaffff', filter: 'drop-shadow(0 0 18px rgba(100,245,240,.95))' }, '100%': { color: '#35e3e8', filter: 'drop-shadow(0 0 0 rgba(100,245,240,0))' } }, duration: rewardDuration }
				: { keyframes: { '0%': { color: '#35e3e8', scale: 1 }, '42%': { color: '#eaffff', scale: 1.48, filter: 'drop-shadow(0 0 22px rgba(100,245,240,1))' }, '100%': { color: '#35e3e8', scale: 1, filter: 'drop-shadow(0 0 0 rgba(100,245,240,0))' } }, duration: rewardDuration }, collectionCueAt('reward'));
			timeline.add(pointsValue, {
				keyframes: { '0%': { color: '#ecfbff', textShadow: '0 0 0 rgba(100,245,240,0)' }, '50%': { color: '#b9ffff', textShadow: '0 0 18px rgba(100,245,240,.95)' }, '100%': { color: '#ecfbff', textShadow: '0 0 0 rgba(100,245,240,0)' } },
				duration: rewardDuration
			}, collectionCueAt('reward'));
			timeline.add(rewardPoints, reducedMotion
				? { keyframes: { '0%': { color: '#fff', textShadow: '0 0 0 rgba(185,255,255,0)' }, '52%': { color: '#fff', textShadow: '0 0 30px rgba(185,255,255,1)' }, '100%': { color: '#fff', textShadow: '0 0 0 rgba(185,255,255,0)' } }, duration: rewardDuration }
				: { keyframes: { '0%': { color: '#fff', scale: 0.72, textShadow: '0 0 0 rgba(185,255,255,0)' }, '42%': { color: '#fff', scale: 1.34, textShadow: '0 0 34px rgba(185,255,255,1)' }, '68%': { color: '#fff', scale: 0.96, textShadow: '0 0 22px rgba(185,255,255,.9)' }, '100%': { color: '#fff', scale: 1, textShadow: '0 0 0 rgba(185,255,255,0)' } }, duration: rewardDuration }, collectionCueAt('jackpot'));
			timeline.add(pointsCard, {
				keyframes: {
					'0%': { borderColor: pointsBorder, boxShadow: 'none' },
					'45%': { borderColor: '#b9ffff', boxShadow: '0 0 0 3px rgba(53, 227, 232, .65), 0 0 38px rgba(53, 227, 232, .72), 0 0 78px rgba(53, 227, 232, .36)' },
					'100%': { borderColor: pointsBorder, boxShadow: 'none' }
				},
				duration: rewardDuration
			}, collectionCueAt('jackpot'));
			if (lifespanCard && lifespanBorder) {
				timeline.add(lifespanCard, {
					keyframes: {
						'0%': { borderColor: lifespanBorder, boxShadow: 'none' },
						'45%': { borderColor: '#b9ffff', boxShadow: '0 0 0 3px rgba(53, 227, 232, .65), 0 0 38px rgba(53, 227, 232, .72), 0 0 78px rgba(53, 227, 232, .36)' },
						'100%': { borderColor: lifespanBorder, boxShadow: 'none' }
					},
					duration: rewardDuration
				}, collectionCueAt('jackpot'));
			}
			timeline.add(primaryRays, opacityOnly(0.98, 0, tailDuration), collectionCueAt('release'));
			timeline.add(secondaryRays, opacityOnly(0.86, 0, tailDuration), collectionCueAt('release'));
			timeline.add(sparkles, { opacity: { from: 0.92, to: 0 }, duration: tailDuration, ease: 'in(2)' }, collectionCueAt('release'));
			timeline.add(jackpotBloom, opacityOnly(0.92, 0, tailDuration), collectionCueAt('release'));
			timeline.add(summary, { opacity: { from: 1, to: 0 }, duration: rewardSummaryFadeDuration, ease: 'in(2)' }, rewardSummaryFadeAt);

			const styleTargets = [
				{ element: summary, properties: ['opacity', 'transform', 'translate', 'scale'] },
				{ element: impactBloom, properties: ['opacity'] },
				{ element: jackpotBloom, properties: ['opacity', 'transform', 'scale'] },
				{ element: primaryRays, properties: ['opacity', 'transform', 'rotate', 'scale'] },
				{ element: secondaryRays, properties: ['opacity', 'transform', 'rotate', 'scale'] },
				...rings.map((element) => ({ element, properties: ['opacity', 'transform', 'scale'] })),
				{ element: sparkles, properties: ['opacity', 'transform', 'scale'] },
				...particles.map((element) => ({ element, properties: ['opacity', 'transform', 'translate', 'rotate', 'scale'] })),
				{ element: wallet, properties: ['color', 'transform', 'scale', 'filter'] },
				{ element: pointsValue, properties: ['color', 'text-shadow'] },
				{ element: rewardPoints, properties: ['color', 'text-shadow', 'transform', 'scale'] },
				{ element: pointsCard, properties: ['border-color', 'box-shadow'] },
				...(lifespanCard ? [{ element: lifespanCard, properties: ['border-color', 'box-shadow'] }] : [])
			].flatMap(({ element, properties }) => properties.map((property) => ({
				element,
				property,
				value: element.style.getPropertyValue(property),
				priority: element.style.getPropertyPriority(property)
			})));
			activeRewardCleanup = () => {
				for (const { element, property, value, priority } of styleTargets) {
					if (value) element.style.setProperty(property, value, priority);
					else element.style.removeProperty(property);
				}
			};
			activeRewardTimeline = timeline;
			timeline.play();
		});

		return () => {
			clearRewardPresentation();
			scope.revert();
			if (presentationScope === scope) presentationScope = null;
		};
	});

	$effect(() => {
		if (open) return;
		if (pendingCollectFeedback) consumedCollectFeedbackId = pendingCollectFeedback.id;
		pendingCollectFeedback = null;
		clearRewardPresentation();
	});

	$effect(() => {
		const feedback = collectFeedback;
		const root = dialogContent;
		const scope = presentationScope;
		if (!feedback || consumedCollectFeedbackId === feedback.id || pendingCollectFeedback?.id === feedback.id) return;
		if (!open || !root || !scope) {
			consumedCollectFeedbackId = feedback.id;
			return;
		}
		if (pendingCollectFeedback && pendingCollectFeedback.id !== feedback.id) {
			consumedCollectFeedbackId = pendingCollectFeedback.id;
			pendingCollectFeedback = null;
		}

		const pending = { id: feedback.id, root, scope };
		pendingCollectFeedback = pending;
		void tick().then(() => {
			if (pendingCollectFeedback !== pending) return;
			pendingCollectFeedback = null;
			consumedCollectFeedbackId = feedback.id;
			if (!open || dialogContent !== pending.root || presentationScope !== pending.scope || collectFeedback?.id !== feedback.id) return;

			clearRewardPresentation();
			rewardPresentation = Object.freeze({ ...feedback });
			const snapshot = rewardPresentation;
			void tick().then(() => {
				if (rewardPresentation !== snapshot) return;
				if (!open || dialogContent !== pending.root || presentationScope !== pending.scope) {
					clearRewardPresentation();
					return;
				}
				pending.scope.methods.playCollectionReward();
			});
		});
	});
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content bind:ref={dialogContent} class="mending-dialog-content" preventScroll={false} onOpenAutoFocus={focusFirstAction}>
				<div class="terminal-dialog-header">
					<div>
						<Dialog.Title class="mending-dialog-title">
							{#if !projection?.completed}<Tool aria-hidden="true" data-mending-icon="tool" />{:else if overflowRewardAvailable}<HeartPlus aria-hidden="true" data-mending-icon="heart-plus" />{:else}<PlayerPause aria-hidden="true" data-mending-icon="player-pause" />{/if}
							<span>{workStatusTitle}</span>
						</Dialog.Title>
						<Dialog.Description class="sr-only">時間の経過でポイントが蓄積し、寿命延長は作業の進行中に反映されます。</Dialog.Description>
					</div>
					<div class="owned-points" data-mending-icon="wallet" aria-label={`所持ポイント ${ownedPoints} pt`}>
						<Wallet aria-hidden="true" />
						<span class="owned-points-value">{ownedPoints} pt</span>
					</div>
					<Dialog.Close class="action-button action-button-tertiary action-button-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
				</div>
				<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">{rewardPresentation ? announceCollection(rewardPresentation) : ''}</div>
				{#if startupFeedback}
					{#key startupFeedback.id}
						<div class="mending-startup-feedback" aria-live="polite" aria-atomic="true">
							<span>{startupFeedback.phase === 'started' ? '作業を開始しました' : '起動中…'}</span>
						</div>
					{/key}
				{/if}
				{#if hasJob || starting}
					<section class="result-list" aria-label="作業の成果">
						<div class="result-card" data-mending-icon="coins">
							<Coins aria-hidden="true" />
							<div class="result-copy">
								<span class="result-label">未回収ポイント</span>
								<strong>+{unclaimedPoints} pt</strong>
								<span class:next-point-hidden={nextPointSeconds === null} class="next-point" data-mending-icon="clock" aria-hidden={nextPointSeconds === null}>
									{#if nextPointSeconds !== null}<Clock aria-hidden="true" />次の1ptまで {nextPointSeconds}秒{/if}
								</span>
							</div>
						</div>
						<div class="result-card" data-mending-icon="heart">
							<Heart aria-hidden="true" />
							<div class="result-copy">
								<span class="result-label">寿命延長</span>
								<strong>+{lifespanDuration}</strong>
								<span class="result-support">作業中に反映</span>
							</div>
						</div>
					</section>
					<section class="status-group" aria-label="作業の蓄積状況">
						<strong class:overflow-lifespan-status={overflowRewardAvailable} class="progress-heading">
							{#if !projection?.completed}
								<span class="progress-prefix">上限まで あと</span><span class="progress-duration">{remainingDuration}</span>
							{:else if overflowRewardAvailable}
								<span>通常作業は上限</span><span>{overflowPointAvailable && overflowLifespanAvailable ? 'ポイント・寿命延長が継続中' : overflowPointAvailable ? 'ポイント蓄積のみ継続中' : '寿命延長のみ継続中'}</span>
							{:else}
								上限に達しました
							{/if}
						</strong>
						<div class="progress-track" role="progressbar" aria-label="作業の蓄積進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progressPercent)}>
							<div class="progress-value" style={`width: ${progressPercent}%;`}></div>
						</div>
					</section>
					<section class="action-group" aria-label="成果回収">
						<ActionButton variant="primary" class="collect-button" type="button" disabled={starting || (projection?.points ?? 0) < 1} onclick={onCollect}>
							<ArrowBarToDown aria-hidden="true" />成果を受け取る
						</ActionButton>
					</section>
				{/if}
			</Dialog.Content>
			<div class="mending-reward-layer" bind:this={rewardLayer} aria-hidden="true">
				{#if rewardPresentation}
					<div class="reward-impact-bloom"></div>
					<div class="reward-jackpot-bloom"></div>
					<div class="reward-burst-anchor">
						<svg class="reward-burst" viewBox="0 0 240 240" focusable="false">
							<g class="reward-burst-rays-primary" fill="none" stroke="#9cffff" stroke-linecap="round" stroke-width="3.5">
								<path d="M120 3v39 M120 198v39 M3 120h39 M198 120h39 M37 37l28 28 M175 175l28 28 M203 37l-28 28 M65 175l-28 28" />
							</g>
							<g class="reward-burst-rays-secondary" fill="none" stroke="#42eaf3" stroke-linecap="round" stroke-width="2">
								<path d="M120 18v19 M120 203v19 M18 120h19 M203 120h19 M59 22l11 20 M170 198l11 20 M218 59l-20 11 M42 170l-20 11 M191 28l-12 19 M61 193l-12 19 M212 191l-19-12 M47 61L28 49" />
							</g>
							<g class="reward-burst-sparkles" fill="#eaffff" stroke="#64f5f0" stroke-linecap="round" stroke-width="1.6">
								<path d="M120 37l4 12 12 4-12 4-4 12-4-12-12-4 12-4z M54 82l3 9 9 3-9 3-3 9-3-9-9-3 9-3z M187 142l3 9 9 3-9 3-3 9-3-9-9-3 9-3z M169 46l2.5 7.5L179 56l-7.5 2.5L169 66l-2.5-7.5L159 56l7.5-2.5z M73 172l2.5 7.5L83 182l-7.5 2.5L73 192l-2.5-7.5L63 182l7.5-2.5z" />
								<circle cx="90" cy="30" r="2.5" /><circle cx="208" cy="93" r="2.5" /><circle cx="144" cy="205" r="2.5" /><circle cx="28" cy="145" r="2.5" />
								<path d="M35 110v16 M27 118h16 M204 168v14 M197 175h14 M111 203v13 M105 209h13 M149 22v12 M143 28h12" fill="none" />
							</g>
							<g class="reward-burst-rings" fill="none" stroke-linecap="round">
								<circle class="reward-burst-ring" cx="120" cy="120" r="61" stroke="#f5ffff" stroke-width="2.5" />
								<circle class="reward-burst-ring" cx="120" cy="120" r="78" stroke="#35e3e8" stroke-width="2" />
								<circle class="reward-burst-ring" cx="120" cy="120" r="96" stroke="#a2ffff" stroke-width="1.5" />
							</g>
							<g class="reward-burst-particles" fill="#f5ffff" stroke="#64f5f0" stroke-width="1">
								<circle class="reward-particle" data-dx="-86" data-dy="-24" data-rotate="-35" cx="120" cy="120" r="2.5" />
								<circle class="reward-particle" data-dx="-66" data-dy="-63" data-rotate="45" cx="120" cy="120" r="2" />
								<circle class="reward-particle" data-dx="-25" data-dy="-93" data-rotate="75" cx="120" cy="120" r="3" />
								<circle class="reward-particle" data-dx="25" data-dy="-87" data-rotate="-45" cx="120" cy="120" r="2" />
								<circle class="reward-particle" data-dx="70" data-dy="-56" data-rotate="55" cx="120" cy="120" r="2.5" />
								<circle class="reward-particle" data-dx="94" data-dy="-14" data-rotate="-65" cx="120" cy="120" r="2" />
								<circle class="reward-particle" data-dx="84" data-dy="32" data-rotate="35" cx="120" cy="120" r="3" />
								<circle class="reward-particle" data-dx="53" data-dy="76" data-rotate="-55" cx="120" cy="120" r="2" />
								<circle class="reward-particle" data-dx="12" data-dy="96" data-rotate="65" cx="120" cy="120" r="2.5" />
								<circle class="reward-particle" data-dx="-34" data-dy="83" data-rotate="-35" cx="120" cy="120" r="2" />
								<circle class="reward-particle" data-dx="-76" data-dy="52" data-rotate="45" cx="120" cy="120" r="3" />
								<circle class="reward-particle" data-dx="-96" data-dy="8" data-rotate="-75" cx="120" cy="120" r="2" />
							</g>
						</svg>
					</div>
					<div class="reward-summary-anchor">
						<div class="reward-summary">
							<strong class="reward-summary-title">成果を受け取りました</strong>
							<span class="reward-summary-points">+{rewardPresentation.points} pt</span>
							{#if rewardPresentation.lifespanMs > 0}
								<span class="reward-summary-lifespan">寿命延長 +{formatElapsedDuration(rewardPresentation.lifespanMs)}</span>
								<span class="reward-summary-support">作業中に反映済み</span>
							{/if}
						</div>
					</div>
				{/if}
			</div>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.mending-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(2, 8, 18, 0.72); backdrop-filter: blur(2px); }
	:global(.mending-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 0; width: min(720px, calc(100vw - 24px)); max-height: calc(100svh - 32px); overflow: auto; padding: 28px; border: 1px solid rgba(35, 220, 226, .78); border-radius: 18px; background: linear-gradient(180deg, rgba(4, 29, 43, .92), rgba(3, 20, 30, .94)); box-shadow: 0 0 0 1px rgba(53, 227, 232, .10) inset, 0 18px 60px rgba(0, 0, 0, .42), 0 0 30px rgba(26, 212, 220, .08); backdrop-filter: blur(14px); color: #ecfbff; transform: translate(-50%, -50%); }
	.mending-reward-layer { position: fixed; inset: 0; z-index: 102; overflow: hidden; pointer-events: none; }
	.reward-burst-anchor, .reward-summary-anchor { position: fixed; inset: 0; display: grid; place-items: center; }
	.reward-impact-bloom, .reward-jackpot-bloom { position: fixed; inset: 0; background: radial-gradient(ellipse at center, rgba(219, 255, 255, .52) 0%, rgba(53, 227, 232, .24) 15%, rgba(36, 181, 226, .10) 34%, transparent 62%); opacity: 0; }
	.reward-jackpot-bloom { background: radial-gradient(ellipse at center, rgba(244, 255, 255, .76) 0%, rgba(117, 255, 255, .42) 13%, rgba(53, 227, 232, .20) 32%, transparent 66%); }
	.reward-burst-anchor { z-index: 1; }
	.reward-burst { width: min(118vmin, 820px); max-height: 96svh; overflow: visible; filter: drop-shadow(0 0 20px rgba(53, 227, 232, .34)); }
	.reward-burst-rays-primary, .reward-burst-rays-secondary, .reward-burst-ring, .reward-burst-sparkles, .reward-particle { opacity: 0; transform-box: fill-box; transform-origin: center; }
	.reward-burst-rays-primary { filter: drop-shadow(0 0 8px rgba(185, 255, 255, .95)); }
	.reward-burst-rays-secondary { filter: drop-shadow(0 0 6px rgba(53, 227, 232, .85)); }
	.reward-burst-sparkles { filter: drop-shadow(0 0 7px rgba(185, 255, 255, .95)); }
	.reward-burst-rings { filter: drop-shadow(0 0 8px rgba(53, 227, 232, .95)); }
	.reward-burst-particles { filter: drop-shadow(0 0 5px rgba(185, 255, 255, .95)); }
	.reward-summary { position: relative; z-index: 2; display: grid; justify-items: center; gap: 4px; width: min(420px, calc(100vw - 40px)); padding: 18px 22px; border: 1px solid rgba(180, 255, 255, .96); border-radius: 16px; background: linear-gradient(180deg, rgba(4, 35, 47, .93), rgba(3, 24, 36, .95)); box-shadow: 0 0 0 1px rgba(53, 227, 232, .38) inset, 0 0 38px rgba(53, 227, 232, .54), 0 0 96px rgba(53, 227, 232, .25); color: #ecfbff; text-align: center; opacity: 0; }
	.reward-summary-title { color: #b9ffff; font-size: clamp(18px, 4vw, 23px); font-weight: 850; line-height: 1.2; }
	.reward-summary-points { display: inline-block; color: #fff; font-size: clamp(34px, 9vw, 54px); font-weight: 950; line-height: 1.15; font-variant-numeric: tabular-nums; text-shadow: 0 0 18px rgba(185, 255, 255, .55); transform-origin: center; }
	.reward-summary-lifespan { color: #64f5f0; font-size: 16px; font-weight: 800; }
	.reward-summary-support { color: #cfe7ee; font-size: 13px; font-weight: 650; }
	.result-card { position: relative; }
	.mending-startup-feedback { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; overflow: hidden; pointer-events: none; border: 1px solid rgba(53, 227, 232, .86); border-radius: inherit; color: #64f5f0; font-size: 16px; font-weight: 800; letter-spacing: .04em; text-shadow: 0 0 18px rgba(53, 227, 232, .7); animation: mending-startup-scan 3000ms ease-out both; box-shadow: 0 0 24px rgba(53, 227, 232, .18) inset; }
	.mending-startup-feedback::after { position: absolute; inset: 0; content: ''; background: linear-gradient(180deg, transparent 0%, rgba(53, 227, 232, .22) 48%, transparent 54%); animation: mending-startup-sweep 1000ms ease-out both; }
	@media (prefers-reduced-motion: reduce) { .mending-startup-feedback { animation-name: mending-startup-fade; } .mending-startup-feedback::after { animation: none; } }
	@keyframes mending-startup-scan { 0% { opacity: 0; } 8% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
	@keyframes mending-startup-sweep { from { opacity: 0; transform: translateY(-45%); } 45% { opacity: 1; } to { opacity: 0; transform: translateY(45%); } }
	@keyframes mending-startup-fade { 0% { opacity: 0; } 8% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }
	.terminal-dialog-header { position: sticky; top: -24px; z-index: 2; display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; margin: -24px -24px 22px; padding: 24px; background: linear-gradient(180deg, rgba(4, 29, 43, .98), rgba(3, 20, 30, .98)); }
	:global(.mending-dialog-content .mending-dialog-title) { display: inline-flex; align-items: center; min-width: 0; gap: 8px; margin: 0; color: #ecfbff; font-size: clamp(18px, 4vw, 22px); line-height: 1.15; font-weight: 800; letter-spacing: .03em; }
	:global(.mending-dialog-title svg) { flex: 0 0 auto; width: 22px; height: 22px; color: #35e3e8; }
	:global(.mending-dialog-content .sr-only) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
	.owned-points { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; color: #ecfbff; white-space: nowrap; }
	.terminal-dialog-header > :global(.action-button-close) { grid-column: 3; }
	.owned-points :global(svg) { width: 18px; height: 18px; }
	.owned-points :global(svg) { color: #9bb4bf; }
	.owned-points-value { color: #ecfbff; font-size: 16px; font-weight: 800; }
	.status-group { margin-bottom: 14px; }
	.progress-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: center; gap: 3px 6px; margin: 0 0 8px; color: #cfe7ee; font-size: clamp(16px, 3vw, 20px); font-weight: 700; line-height: 1.3; letter-spacing: .01em; font-variant-numeric: tabular-nums; text-align: center; }
	.progress-prefix { color: #9bb4bf; font-size: .8em; font-weight: 600; }
	.progress-heading.overflow-lifespan-status { display: grid; gap: 2px; }
	.progress-heading.overflow-lifespan-status span { display: block; }
	.progress-duration { color: #35e3e8; font-weight: 800; }
	.progress-track { width: 100%; height: 17px; overflow: hidden; border: 1px solid rgba(53, 227, 232, .72); border-radius: 999px; background: #06303d; box-shadow: 0 0 0 1px rgba(53, 227, 232, .03) inset; }
	.progress-value { height: 100%; min-width: 2px; background: linear-gradient(90deg, #2ee3df, #64f5f0); border-radius: inherit; }
	.result-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: stretch; gap: 12px; margin-bottom: 14px; }
	.result-card { display: flex; align-items: center; gap: 14px; min-width: 0; min-height: 106px; padding: 14px 16px; border: 1px solid rgba(35, 220, 226, .32); border-radius: 12px; background: rgba(9, 40, 52, .62); }
	.result-card > :global(svg) { flex: 0 0 auto; width: 28px; height: 28px; color: #35e3e8; }
	.result-copy { display: grid; gap: 0; min-width: 0; }
	.result-label { margin-bottom: 3px; color: #9bb4bf; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
	.result-card strong { color: #ecfbff; font-size: 24px; font-weight: 850; line-height: 1.1; letter-spacing: .01em; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
	.next-point, .result-support { display: inline-flex; align-items: center; gap: 6px; min-height: 16px; margin-top: 3px; color: #cfe7ee; font-size: 12px; line-height: 1.2; font-weight: 600; font-variant-numeric: tabular-nums; }
	.next-point-hidden { visibility: hidden; }
	.next-point :global(svg) { width: 15px; height: 15px; color: #35e3e8; }
	.action-group { display: grid; gap: 10px; margin: 4px 0 6px; }
	:global(.collect-button) { width: 100%; min-width: 0; min-height: 50px; height: 50px; padding: 0 14px; font-size: 16px; }
	:global(.collect-button svg) { flex: 0 0 auto; width: 24px; height: 24px; }
	:global(.mending-dialog-content button:focus-visible:not(.action-button-close)) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (max-width: 700px) { :global(.mending-dialog-content) { width: min(calc(100vw - 16px), 720px); padding: 24px; } .result-list { grid-template-columns: 1fr; } }
	@media (max-width: 560px) { :global(.mending-dialog-content) { padding: 22px 18px; border-radius: 14px; } .terminal-dialog-header { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin: -22px -18px 22px; padding: 22px 18px; } .owned-points { grid-row: 2; grid-column: 1 / 3; padding-top: 0; } .terminal-dialog-header > :global(.action-button-close) { grid-row: 1; grid-column: 2; } }
</style>
