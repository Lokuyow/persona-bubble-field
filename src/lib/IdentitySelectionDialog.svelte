<script lang="ts">
	import { asset } from '$app/paths';
	import { Popover } from 'bits-ui';
	import ChevronDown from '~icons/tabler/chevron-down';
	import HelpCircle from '~icons/tabler/help-circle';
	import { getCharacterById } from '$lib/character';
	import PrimaryButton from '$lib/PrimaryButton.svelte';
	import type { ClearedIdentityCandidate, IdentityCandidate, PendingSelection, SelectionCandidate } from '$lib/rootIdentity';
	import { isRootBuildAllocatable, rootBuildCost, usableRootPoints, type RootBuild } from '$lib/rootProgression';

	let { selection, rootPoints, onSelect, onExportNsec }: {
		selection: PendingSelection | null;
		rootPoints: number;
		onSelect: (candidate: SelectionCandidate, rootBuild: RootBuild) => void;
		onExportNsec: (candidate: ClearedIdentityCandidate) => void;
	} = $props();
	let backdrop = $state<HTMLElement | null>(null);
	let initialFocusTarget = $state<HTMLElement | null>(null);
	let chosen = $state<SelectionCandidate | null>(null);
	let rootBuild = $state<RootBuild>({ inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 });
	let usablePoints = $derived(usableRootPoints(rootPoints));
	let usedPoints = $derived(rootBuildCost(rootBuild));
	let rootBuildOpen = $state(false);
	let rootBuildSelection = $state<PendingSelection | null>(null);
	const ROOT_EFFECTS = {
		inferenceAcceleration: ['×1.00', '×1.30', '×1.60', '×2.00'],
		contextCompression: ['×1.00 / overflow lifespan 0%', '×1.50 / overflow lifespan 20%', '×2.00 / overflow lifespan 35%', '×3.00 / overflow lifespan 50%'],
		hallucinationResistance: ['最大7日', '最大14日', '最大21日', '最大30日']
	} as const;
	const ROOT_DETAILS = {
		inferenceAcceleration: ['Rank 0: ×1.00', 'Rank 1: ×1.30', 'Rank 2: ×1.60', 'Rank 3: ×2.00', '最初の有効通常作業24時間のポイント生成に適用。'],
		contextCompression: ['Rank 0: ×1.00 / overflow lifespan 0%', 'Rank 1: ×1.50 / overflow lifespan 20%', 'Rank 2: ×2.00 / overflow lifespan 35%', 'Rank 3: ×3.00 / overflow lifespan 50%'],
		hallucinationResistance: ['Rank 0: 最大7日', 'Rank 1: 最大14日', 'Rank 2: 最大21日', 'Rank 3: 最大30日', 'fresh Run開始時の寿命は常に7日。']
	} as const;

	$effect(() => {
		if (!selection || selection === rootBuildSelection) return;
		rootBuildSelection = selection;
		rootBuildOpen = usableRootPoints(rootPoints) > 0;
	});

	function character(candidate: IdentityCandidate) {
		const value = getCharacterById(candidate.characterId);
		if (!value) throw new Error('Candidate character is unavailable.');
		return value;
	}

	function choose(candidate: SelectionCandidate): void {
		chosen = candidate;
	}

	function changeRank(key: keyof RootBuild, delta: number): void {
		if (delta > 0 && usedPoints >= usablePoints) return;
		const next = Math.max(0, Math.min(3, rootBuild[key] + delta));
		rootBuild = { ...rootBuild, [key]: next };
	}

	function startRun(): void {
		if (!chosen || !isRootBuildAllocatable(rootBuild, rootPoints)) return;
		onSelect(chosen, rootBuild);
	}

	function focusableElements(dialog: HTMLElement): HTMLElement[] {
		return Array.from(dialog.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		));
	}

	$effect(() => {
		if (!selection || !backdrop) return;
		const dialog = backdrop.querySelector('dialog');
		const app = backdrop.closest('main');
		if (!dialog || !app) return;
		const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const inertSiblings = Array.from(app.children).filter((child) => child !== backdrop) as HTMLElement[];
		for (const sibling of inertSiblings) sibling.inert = true;
		const focus = () => {
			if (initialFocusTarget && !dialog.contains(document.activeElement)) initialFocusTarget.focus();
		};
		const handleFocusIn = (event: FocusEvent) => {
			if (!dialog.contains(event.target as Node)) focus();
		};
		const handleKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				return;
			}
			if (event.key !== 'Tab') return;
			const elements = focusableElements(dialog);
			if (elements.length === 0) {
				event.preventDefault();
				return;
			}
			const current = document.activeElement;
			const index = elements.indexOf(current as HTMLElement);
			const next = event.shiftKey
				? elements[(index <= 0 ? elements.length : index) - 1]
				: elements[(index + 1) % elements.length];
			event.preventDefault();
			next.focus();
		};
		document.addEventListener('focusin', handleFocusIn, true);
		document.addEventListener('keydown', handleKeydown, true);
		queueMicrotask(focus);
		return () => {
			document.removeEventListener('focusin', handleFocusIn, true);
			document.removeEventListener('keydown', handleKeydown, true);
			for (const sibling of inertSiblings) sibling.inert = false;
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	});
</script>

{#if selection}
	<div bind:this={backdrop} class="selection-backdrop" role="presentation">
		<dialog open class="selection-dialog" aria-labelledby="identity-selection-title" aria-describedby="identity-selection-description" aria-modal="true">
			<div class="selection-content">
				<header class="selection-header">
					<div>
						<h1 bind:this={initialFocusTarget} class="initial-focus-target" id="identity-selection-title" tabindex="-1">Runを始める</h1>
						<p id="identity-selection-description" class="selection-introduction">人格を選び、今回のRunで使うRoot buildを決めてください。Run開始後は変更できません。</p>
					</div>
					<div class="rp-summary"><span>Root Point</span><strong>{rootPoints} RP</strong></div>
				</header>

				<section class="identity-section" aria-label="人格を選択">
					<div class="section-heading"><h2>人格を選択</h2><span>Runの舞台となる人格</span></div>
					<div class="candidate-grid">
						{#each selection.candidates as candidate}
							{@const selectedCharacter = character(candidate)}
							<button class:chosen={chosen === candidate} class="candidate" type="button" onclick={() => choose(candidate)} aria-label={`${selectedCharacter.name}を選ぶ`}>
								<span class="candidate-image"><img src={asset(`/${selectedCharacter.picture}`)} alt="" /></span>
								<span class="candidate-copy"><span class="candidate-name">{selectedCharacter.name}</span><span class="candidate-about">{selectedCharacter.about}</span></span>
								{#if chosen === candidate}<span class="candidate-check" aria-hidden="true">✓</span>{/if}
							</button>
						{/each}
					</div>
				</section>

				{#if selection.reusableIdentities.length > 0}
					<section class="return-section" aria-label="再利用可能なIdentity">
						<div class="section-heading"><h2>再利用可能なIdentity</h2><span>過去のRunを続ける</span></div>
						<div class="return-list">
							{#each selection.reusableIdentities as candidate}
								{@const selectedCharacter = character(candidate)}
								<div class="return-card" class:chosen={chosen === candidate}>
									<button class="return-choice" type="button" onclick={() => choose(candidate)}>{selectedCharacter.name}（Generation {candidate.generation}のIdentity）を使う</button>
									<button class="export-nsec" type="button" onclick={() => onExportNsec(candidate)}>nsecを取得</button>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				<section class="root-build" aria-label="Root build">
					<button class:open={rootBuildOpen} class="root-build-toggle" type="button" aria-expanded={rootBuildOpen} aria-controls="root-build-panel" onclick={() => rootBuildOpen = !rootBuildOpen}>
						<span class="root-build-toggle-copy"><strong>Root build</strong><small>今回のRunに割り当てる能力</small></span>
						<span class="root-build-toggle-meta"><span>使用 {usedPoints} / {usablePoints} RP</span><ChevronDown aria-hidden="true" /></span>
					</button>
					{#if rootBuildOpen}
					<div id="root-build-panel" class="root-build-panel">
					<p class="rp-notice" role="status">{usablePoints === 0 ? '今回は割り当て可能なRPがありません。Rank 0で開始します。' : usedPoints === usablePoints ? '使用可能なRPをすべて割り当てています。配分はRun開始まで変更できます。' : `あと ${usablePoints - usedPoints} RP 割り当てできます。配分はRun開始まで変更できます。`}</p>
					<div class="ability-list">
						{#each [['inferenceAcceleration', '推論加速', 'ポイント生成'], ['contextCompression', 'コンテキスト圧縮', '最大蓄積'], ['hallucinationResistance', 'ハルシネーション耐性', '最大寿命']] as [key, label, effectLabel]}
							{@const rootKey = key as keyof RootBuild}
							{@const rank = rootBuild[rootKey]}
							{@const effects = ROOT_EFFECTS[rootKey]}
							{@const details = ROOT_DETAILS[rootKey]}
							<div class="ability-row">
								<div class="ability-main">
									<div class="ability-title"><strong>{label}</strong><span class="rank-label">Rank {rank}</span></div>
									<div class="ability-effect"><span>{effectLabel}</span><strong>{effects[rank]}</strong>{#if rank < 3 && usedPoints < usablePoints}<small>次: {effects[rank + 1]}</small>{/if}</div>
								</div>
								<Popover.Root>
									<Popover.Trigger class="help-trigger" aria-label={`${label}の詳細`}><HelpCircle aria-hidden="true" /></Popover.Trigger>
									<Popover.Portal><Popover.Content class="help-content" side="bottom" align="start" sideOffset={6} collisionPadding={12} trapFocus={false} onOpenAutoFocus={(event) => event.preventDefault()}><strong>{label}</strong><ul>{#each details.slice(0, 4) as detail}<li>{detail}</li>{/each}</ul>{#if details[4]}<p>{details[4]}</p>{/if}</Popover.Content></Popover.Portal>
								</Popover.Root>
								<div class="rank-controls" aria-label={`${label}のRank操作`}>
									<button type="button" aria-label={`${label}を下げる`} onclick={() => changeRank(rootKey, -1)} disabled={rank === 0}>−</button>
									<span aria-label={`${label}の現在Rank`}>{rank}</span>
									<button type="button" aria-label={`${label}を上げる`} onclick={() => changeRank(rootKey, 1)} disabled={rank === 3 || usedPoints >= usablePoints}>＋</button>
								</div>
							</div>
						{/each}
					</div>
					</div>
					{/if}
				</section>
			</div>
			<footer class="selection-footer">
				<div class="selection-summary"><span>選択中</span><strong>{chosen ? character(chosen).name : '未選択'}</strong><span class="summary-divider" aria-hidden="true"></span><span>使用 {usedPoints} / {usablePoints} RP</span></div>
				<PrimaryButton type="button" onclick={startRun} disabled={!chosen || !isRootBuildAllocatable(rootBuild, rootPoints)}>Runを開始</PrimaryButton>
			</footer>
		</dialog>
	</div>
{/if}

<style>
	.selection-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
		background: rgb(10 10 18 / 78%);
	}

	.selection-dialog {
		position: relative;
		inset: auto;
		box-sizing: border-box;
		width: min(920px, 100%);
		height: min(760px, calc(100dvh - 40px));
		max-height: calc(100dvh - 40px);
		max-width: none;
		margin: 0;
		padding: 0;
		overflow: hidden;
		border: 1px solid rgb(104 241 221 / 42%);
		border-radius: 20px;
		background: linear-gradient(150deg, rgb(24 27 48 / 98%), rgb(13 16 32 / 98%));
		color: #fff;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
	}

	.selection-dialog::backdrop { background: transparent; }
	.selection-content { min-height: 0; overflow: auto; padding: 26px 26px 24px; }
	.selection-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
	.selection-dialog h1 { margin: 0; font-size: 24px; line-height: 1.2; }
	.selection-dialog .initial-focus-target:focus { outline: none; }
	.selection-introduction { max-width: 620px; margin: 8px 0 0; color: rgb(255 255 255 / 64%); font-size: .9rem; }
	.rp-summary { display: grid; justify-items: end; gap: 2px; color: rgb(255 255 255 / 62%); font-size: .82rem; white-space: nowrap; }
	.rp-summary strong { color: #fff; font-size: 1.05rem; }
	.identity-section, .return-section, .root-build { margin-top: 28px; }
	.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
	.section-heading h2 { margin: 0; font-size: 1rem; }
	.section-heading > span { color: rgb(255 255 255 / 56%); font-size: .8rem; }
	.candidate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
	.candidate { position: relative; display: grid; gap: 10px; padding: 12px; border: 1px solid rgb(255 255 255 / 17%); border-radius: 14px; background: rgb(37 37 58 / 68%); color: inherit; text-align: left; cursor: pointer; }
	.candidate:hover, .candidate:focus-visible { border-color: var(--color-accent); outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
	.candidate.chosen, .return-card.chosen { border-color: var(--color-accent); box-shadow: 0 0 0 2px rgb(111 255 233 / 22%); }
	.candidate-image { display: block; aspect-ratio: 1; overflow: hidden; border-radius: 10px; background: #30304b; }
	.candidate img { width: 100%; height: 100%; object-fit: contain; }
	.candidate-copy { display: grid; gap: 5px; min-width: 0; }
	.candidate-name { font-weight: 750; }
	.candidate-about { min-height: 3.5em; color: rgb(255 255 255 / 68%); overflow-wrap: anywhere; white-space: pre-line; font-size: .82rem; line-height: 1.35; }
	.candidate-check { position: absolute; top: 10px; right: 10px; display: grid; width: 24px; height: 24px; place-items: center; border-radius: 50%; background: var(--color-accent); color: #08121d; font-weight: 900; }
	.return-list { display: grid; gap: 8px; }
	.return-card { display: flex; gap: 8px; padding: 8px; border: 1px solid rgb(255 255 255 / 17%); border-radius: 10px; background: rgb(37 37 58 / 56%); }
	.return-choice, .export-nsec, .rank-controls button { min-height: 38px; border: 1px solid rgb(255 255 255 / 24%); border-radius: 7px; background: #30304b; color: inherit; cursor: pointer; }
	.return-choice { flex: 1; text-align: left; }
	.export-nsec { padding: 0 10px; }
	.root-build { padding: 14px 14px 0; border: 1px solid rgb(104 241 221 / 23%); border-radius: 14px; background: rgb(19 24 43 / 42%); }
	.root-build-toggle { display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 0 14px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
	.root-build-toggle:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 4px; }
	.root-build-toggle-copy { display: grid; gap: 3px; }
	.root-build-toggle-copy strong { font-size: 1rem; }
	.root-build-toggle-copy small { color: rgb(255 255 255 / 56%); font-size: .8rem; }
	.root-build-toggle-meta { display: flex; align-items: center; gap: 10px; color: rgb(255 255 255 / 78%); font-size: .86rem; white-space: nowrap; }
	:global(.root-build-toggle-meta svg) { width: 20px; height: 20px; color: var(--color-accent); transition: transform 160ms ease; }
	:global(.root-build-toggle.open .root-build-toggle-meta svg) { transform: rotate(180deg); }
	.root-build-panel { padding-bottom: 14px; }
	.rp-notice { margin: 0 0 12px; color: rgb(255 255 255 / 62%); font-size: .82rem; }
	.ability-list { border-top: 1px solid rgb(255 255 255 / 12%); }
	.ability-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px auto; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid rgb(255 255 255 / 12%); }
	.ability-main { min-width: 0; }
	.ability-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.ability-title strong { font-size: .92rem; }
	.rank-label { color: rgb(255 255 255 / 62%); font-size: .8rem; }
	:global(.help-trigger) { display: grid; width: 44px; height: 44px; flex: 0 0 44px; place-items: center; align-content: center; justify-content: center; margin-left: 0; padding: 0; border: 1px solid rgb(255 255 255 / 25%); border-radius: 50%; background: transparent; color: rgb(255 255 255 / 70%); cursor: pointer; line-height: 0; }
	:global(.help-trigger svg) { display: block; width: 18px; height: 18px; }
	:global(.help-trigger:focus-visible) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
	.ability-effect { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-top: 4px; color: rgb(255 255 255 / 58%); font-size: .8rem; }
	.ability-effect strong { color: #fff; font-size: .92rem; }
	.ability-effect small { color: var(--color-accent); }
	.rank-controls { display: grid; grid-template-columns: 44px 34px 44px; align-items: center; gap: 6px; text-align: center; }
	.rank-controls button { width: 44px; min-height: 44px; padding: 0; font-size: 1.2rem; line-height: 1; }
	.rank-controls button:disabled { cursor: not-allowed; opacity: .35; }
	.rank-controls span { font-weight: 750; }
	:global(.help-content) { z-index: 110; width: min(320px, calc(100vw - 32px)); padding: 13px 15px; border: 1px solid rgb(111 255 233 / 42%); border-radius: 10px; background: #20243b; color: #fff; box-shadow: 0 12px 35px rgb(0 0 0 / 32%); font-size: .8rem; }
	:global(.help-content ul) { display: grid; gap: 4px; margin: 8px 0 0; padding-left: 18px; color: rgb(255 255 255 / 78%); }
	:global(.help-content p) { margin: 8px 0 0; color: rgb(255 255 255 / 62%); }
	.selection-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 26px 20px; border-top: 1px solid rgb(255 255 255 / 18%); background: rgb(13 16 32 / 96%); }
	.selection-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: rgb(255 255 255 / 62%); font-size: .82rem; }
	.selection-summary strong { color: #fff; }
	.summary-divider { width: 1px; height: 18px; background: rgb(255 255 255 / 20%); }
	.selection-footer :global(.site-primary-button) { min-width: 210px; min-height: 50px; }

	@media (max-width: 700px) {
		.selection-dialog { height: min(760px, calc(100dvh - 40px)); max-height: calc(100dvh - 40px); }
		.selection-content { padding: 20px 16px 18px; }
		.selection-header { gap: 12px; }
		.selection-dialog h1 { font-size: 21px; }
		.rp-summary { font-size: .75rem; }
		.identity-section, .return-section, .root-build { margin-top: 22px; }
		.candidate-grid { grid-template-columns: 1fr; }
		.candidate { grid-template-columns: 82px minmax(0, 1fr); align-items: center; min-height: 104px; }
		.candidate-image { grid-row: span 2; }
		.candidate-about { min-height: auto; }
		.ability-row { grid-template-columns: minmax(0, 1fr) 44px; grid-template-areas: "main help" "controls controls"; gap: 8px 10px; padding: 14px 0; }
		.ability-main { grid-area: main; min-width: 0; }
		:global(.help-trigger) { grid-area: help; justify-self: end; }
		.rank-controls { grid-area: controls; justify-self: end; }
		.ability-effect { gap: 5px; min-width: 0; }
		.ability-effect strong, .ability-effect small { overflow-wrap: anywhere; }
		.root-build { padding-inline: 12px; }
		.selection-footer { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px 16px max(16px, env(safe-area-inset-bottom)); }
		.selection-footer :global(.site-primary-button) { width: 100%; }
	}
</style>
