<script lang="ts">
	import { tick } from 'svelte';
	import { asset } from '$app/paths';
	import { Popover } from 'bits-ui';
	import ArrowUpRight from '~icons/tabler/arrow-up-right';
	import Brain from '~icons/tabler/brain';
	import ChevronDown from '~icons/tabler/chevron-down';
	import HelpCircle from '~icons/tabler/help-circle';
	import ShieldCheck from '~icons/tabler/shield-check';
	import Stack2 from '~icons/tabler/stack-2';
	import UsersPlus from '~icons/tabler/users-plus';
	import { getCharacterById } from '$lib/character';
	import ActionButton from '$lib/ActionButton.svelte';
	import type { ClearedIdentityCandidate, IdentityCandidate, PendingSelection, SelectionCandidate } from '$lib/rootIdentity';
	import type { RunTransitionNotice } from '$lib/runTransitionNotice';
	import { isRootBuildAllocatable, rootBuildCost, rootCandidateCount, rootContextCompressionMultiplierTenths, rootInferenceAccelerationMultiplierTenths, rootMaximumLifespanMs, rootOverflowRewardPercent, usableRootPoints, type RootBuild } from '$lib/rootProgression';

	let { selection, rootPoints, transitionNotice, onConfirm, onSelect, onExportNsec }: {
		selection: PendingSelection | null;
		rootPoints: number;
		transitionNotice?: RunTransitionNotice | null;
		onConfirm: (rootBuild: RootBuild) => void;
		onSelect: (candidate: SelectionCandidate) => void;
		onExportNsec: (candidate: ClearedIdentityCandidate) => void;
	} = $props();
	let noticeCopy = $derived(transitionNotice === 'dead'
		? { heading: '一生を終えました', body: '死亡しました。転生してください。' }
		: transitionNotice === 'cleared'
			? { heading: '脱出しました', body: '一生を終え、Root Pointを1獲得しました。' }
			: null);
	let backdrop = $state<HTMLElement | null>(null);
	let initialFocusTarget = $state<HTMLElement | null>(null);
	let chosen = $state<SelectionCandidate | null>(null);
	let openingAccepted = $state(false);
	let openingContextKey: string | null = null;
	let previousSelectionStage: PendingSelection['stage'] | null = null;
	let firstSelection = $derived(Boolean(selection && selection.generation === 1 && selection.reusableIdentities.length === 0));
	let showOpening = $derived(firstSelection && !openingAccepted);
	let rootBuild = $state<RootBuild>({ inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0, candidateExpansion: 0 });
	let usablePoints = $derived(usableRootPoints(rootPoints));
	let usedPoints = $derived(rootBuildCost(rootBuild));
	let rootBuildSelection = $state<PendingSelection | null>(null);
	const ROOT_EFFECTS = {
		inferenceAcceleration: ['×1.00', '×2.00', '×3.00', '×4.00'],
		contextCompression: ['×1.00 / overflow point・lifespan 0%', '×2.00 / overflow point・lifespan 20%', '×3.00 / overflow point・lifespan 35%', '×4.00 / overflow point・lifespan 50%'],
		hallucinationResistance: ['最大7日', '最大14日', '最大21日', '最大30日'],
		candidateExpansion: ['新規候補3人', '新規候補6人', '新規候補9人', '新規候補12人']
	} as const;
	const ROOT_DETAILS = {
		inferenceAcceleration: ['Rank 0: ×1.00', 'Rank 1: ×2.00', 'Rank 2: ×3.00', 'Rank 3: ×4.00', 'Run中の有効通常作業のポイント生成に常時適用。'],
		contextCompression: ['Rank 0: ×1.00 / overflow point・lifespan 0%', 'Rank 1: ×2.00 / overflow point・lifespan 20%', 'Rank 2: ×3.00 / overflow point・lifespan 35%', 'Rank 3: ×4.00 / overflow point・lifespan 50%'],
		hallucinationResistance: ['Rank 0: 最大7日', 'Rank 1: 最大14日', 'Rank 2: 最大21日', 'Rank 3: 最大30日', '新しい一生の開始時の寿命は常に7日。'],
		candidateExpansion: ['Rank 0: 新規候補3人', 'Rank 1: 新規候補6人', 'Rank 2: 新規候補9人', 'Rank 3: 新規候補12人', 'clear済みIdentityの再利用候補数は変わりません。']
	} as const;

	$effect(() => {
		if (!selection) return;
		const stageChanged = previousSelectionStage !== null && previousSelectionStage !== selection.stage;
		previousSelectionStage = selection.stage;
		if (selection === rootBuildSelection) return;
		rootBuildSelection = selection;
		const nextOpeningContextKey = selectionOpeningContext(selection);
		if (openingContextKey !== nextOpeningContextKey) {
			openingContextKey = nextOpeningContextKey;
			openingAccepted = false;
		}
		chosen = null;
		rootBuild = { inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0, candidateExpansion: 0 };
		if (stageChanged) void tick().then(() => initialFocusTarget?.focus());
	});

	function character(candidate: IdentityCandidate) {
		const value = getCharacterById(candidate.characterId);
		if (!value) throw new Error('Candidate character is unavailable.');
		return value;
	}

	function selectionOpeningContext(selection: PendingSelection): string {
		return JSON.stringify({ generation: selection.generation, previousFinishedRun: selection.previousFinishedRun,
			reusableIdentities: selection.reusableIdentities.map(({ generation, accountIndex, pubkey }) => ({ generation, accountIndex, pubkey })) });
	}

	function choose(candidate: SelectionCandidate): void {
		chosen = candidate;
	}

	function changeRank(key: keyof RootBuild, delta: number): void {
		if (delta > 0 && usedPoints >= usablePoints) return;
		const next = Math.max(0, Math.min(3, rootBuild[key] + delta));
		rootBuild = { ...rootBuild, [key]: next };
	}

	function confirmBuild(): void {
		if (!selection || selection.stage !== 'allocating' || !isRootBuildAllocatable(rootBuild, rootPoints)) return;
		onConfirm(rootBuild);
	}

	function startRun(): void {
		if (!selection || selection.stage !== 'candidates' || !chosen) return;
		onSelect(chosen);
	}

	function rootAbilityEffect(key: keyof RootBuild, rank: number): string {
		switch (key) {
			case 'inferenceAcceleration':
				return `×${(rootInferenceAccelerationMultiplierTenths(rank) / 10).toFixed(2)}`;
			case 'contextCompression':
				return `容量 ×${(rootContextCompressionMultiplierTenths(rank) / 10).toFixed(2)} / 上限後 ${rootOverflowRewardPercent(rank)}%`;
			case 'hallucinationResistance':
				return `作業の最大寿命 ${rootMaximumLifespanMs(rank) / (24 * 60 * 60 * 1000)}日`;
			case 'candidateExpansion':
				return `新規候補 ${rootCandidateCount(rank)}人`;
		}
	}

	async function acceptOpening(): Promise<void> {
		openingAccepted = true;
		await tick();
		initialFocusTarget?.focus();
	}

	function focusableElements(dialog: HTMLElement): HTMLElement[] {
		return Array.from(dialog.querySelectorAll<HTMLElement>(
			'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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
			{#if showOpening}
				<div class="selection-content opening-content">
					<header class="selection-header">
						<div>
						<img class="opening-logo" src={asset('/brand/HakoKako_logo.svg')} alt="ハコ過去 HakoKako" />
						<h1 bind:this={initialFocusTarget} class="initial-focus-target" id="identity-selection-title" tabindex="-1">ここは、ハコ。</h1>
						<div id="identity-selection-description" class="opening-copy">
							<p>あなたは、別の誰かとしてここで生きる。</p>
							<p>寿命は7日。<br />生き延びて、ソトを目指してください。</p>
						</div>
					</div>
				</header>
				</div>
				<footer class="selection-footer opening-footer">
					<ActionButton variant="primary" type="button" onclick={() => { void acceptOpening(); }}>はじめる</ActionButton>
				</footer>
			{:else}
			<div class="selection-content">
				<header class="selection-header">
					<div>
						<h1 bind:this={initialFocusTarget} class="initial-focus-target" id="identity-selection-title" tabindex="-1">{selection.stage === 'allocating' ? 'Root buildを配分' : firstSelection ? '人格を選択' : '命を始める'}</h1>
						<p id="identity-selection-description" class="selection-introduction">{selection.stage === 'allocating' ? '配分を確定すると、新しいRunの候補を固定します。' : firstSelection ? 'あなたとして生きる人格' : '次の一生を始める人格を選びます。'}</p>
					</div>
					<div class="rp-summary"><span>Root Point</span><strong>{rootPoints} RP</strong></div>
				</header>
				{#if noticeCopy}
					<div class="transition-notice" role="status">
						<strong>{noticeCopy.heading}</strong>
						<span>{noticeCopy.body}</span>
					</div>
				{/if}

				{#if selection.stage === 'allocating'}
					<section class="root-build" aria-label="Root build配分">
						<div class="section-heading"><h2>Root build</h2><span>使用 {usedPoints} / {usablePoints} RP</span></div>
						<p class="rp-notice" role="status">{usedPoints === usablePoints ? '使用可能なRPをすべて割り当てています。確定後は変更できません。' : `あと ${usablePoints - usedPoints} RP 割り当てできます。全RPを配分して確定してください。`}</p>
						<div class="ability-list">
							{#each [['inferenceAcceleration', '推論加速', '通常作業のポイント生成'], ['contextCompression', 'コンテキスト圧縮', '最大蓄積'], ['hallucinationResistance', 'ハルシネーション耐性', '最大寿命'], ['candidateExpansion', '候補拡張', '新規Identity候補']] as [key, label, effectLabel]}
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
					</section>
					{#if selection.reusableIdentities.length > 0}
						<section class="return-section" aria-label="再利用可能なIdentityのnsec取得">
							<div class="section-heading"><h2>再利用可能なIdentity</h2><span>候補数とは別枠です</span></div>
							<div class="return-list">
								{#each selection.reusableIdentities as candidate}
									{@const selectedCharacter = character(candidate)}
									<div class="return-card"><span class="return-label">{selectedCharacter.name}（Generation {candidate.generation}）</span><button class="export-nsec" type="button" onclick={() => onExportNsec(candidate)}>nsecを取得</button></div>
								{/each}
							</div>
						</section>
					{/if}
				{:else}
					<section class="identity-section" aria-label={firstSelection ? '人格を選択' : '転生先を選択'}>
						<div class="section-heading"><h2>{firstSelection ? '人格を選択' : '転生先を選択'}</h2><span>新規候補 {selection.candidates.length}人</span></div>
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
							<div class="section-heading"><h2>再利用可能なIdentity</h2><span>新規候補とは別に選べます</span></div>
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
					<details class="rp-details">
						<summary class="rp-details-toggle"><span>脱出後の成長と今回のRP配分</span><ChevronDown aria-hidden="true" /></summary>
						<div class="rp-summary-panels" aria-label="脱出後の成長と今回のRP配分">
							<section class="progression-card" aria-label="将来の成長">
								<span class="progression-icon" aria-hidden="true"><ArrowUpRight /></span>
								<div class="progression-copy">
									<h2>脱出して、次の一生を強く</h2>
									<p>脱出すると1 RP獲得。次の一生の強化に使えます。</p>
								</div>
							</section>
							<section class="allocation-summary" aria-label="今回のRP配分">
								<div class="allocation-heading"><h2>今回のRP配分</h2><span>{rootBuildCost(selection.rootBuild) === 0 ? '0 RP' : `${rootBuildCost(selection.rootBuild)} RP 配分済み`}</span></div>
								<div class="root-ability-grid">
									{#each [{ key: 'inferenceAcceleration', label: '推論加速' }, { key: 'contextCompression', label: 'コンテキスト圧縮' }, { key: 'hallucinationResistance', label: 'ハルシネーション耐性' }, { key: 'candidateExpansion', label: '候補拡張' }] as ability}
										{@const abilityKey = ability.key as keyof RootBuild}
										{@const rank = selection.rootBuild[abilityKey]}
										<article class={['root-ability-card', { ranked: rank > 0 }]} data-rp-ability={abilityKey}>
											<div class="root-ability-heading">
												<span class="root-ability-icon" aria-hidden="true">{#if abilityKey === 'inferenceAcceleration'}<Brain />{:else if abilityKey === 'contextCompression'}<Stack2 />{:else if abilityKey === 'hallucinationResistance'}<ShieldCheck />{:else}<UsersPlus />{/if}</span>
												<strong>{ability.label}</strong>
												<span class="root-ability-rank" class:ranked={rank > 0}>Rank {rank}</span>
											</div>
											<dl class="root-ability-effects">
												<div class="root-ability-current"><dt>今回</dt><dd>{rootAbilityEffect(abilityKey, rank)}</dd></div>
												{#if rank < 3}<div class="root-ability-next"><dt>次Rank</dt><dd>{rootAbilityEffect(abilityKey, rank + 1)}</dd></div>{/if}
											</dl>
										</article>
									{/each}
								</div>
							</section>
						</div>
					</details>
				{/if}
			</div>
			<footer class="selection-footer">
				{#if selection.stage === 'allocating'}
					<div class="selection-summary"><span>Root build</span><strong>使用 {usedPoints} / {usablePoints} RP</strong></div>
					<ActionButton variant="primary" type="button" onclick={confirmBuild} disabled={!isRootBuildAllocatable(rootBuild, rootPoints)}>配分を確定して候補を表示</ActionButton>
				{:else}
					<div class="selection-summary"><span>選択中</span><strong>{chosen ? character(chosen).name : '未選択'}</strong><span class="summary-divider" aria-hidden="true"></span><span>新規候補 {selection.candidates.length}人</span></div>
					<ActionButton variant="primary" type="button" onclick={startRun} disabled={!chosen}>開始</ActionButton>
				{/if}
			</footer>
			{/if}
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
	.opening-content { display: grid; align-content: center; }
	.opening-content .selection-header { justify-content: center; text-align: center; transform: translateY(-18px); }
	.opening-logo { display: block; width: min(300px, 70vw); height: auto; margin: 0 auto 28px; }
	.opening-content h1 { font-size: clamp(28px, 5vw, 40px); }
	.opening-copy { display: grid; gap: 22px; margin-top: 20px; color: rgb(255 255 255 / 88%); font-size: 1.05rem; line-height: 1.8; }
	.opening-copy p { margin: 0; }
	.selection-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
	.transition-notice { display: grid; gap: 4px; margin: 16px 0 2px; padding: 12px 14px; border: 1px solid rgb(104 241 221 / 34%); border-radius: 12px; background: rgb(104 241 221 / 9%); color: rgb(241 255 253 / 92%); }
	.transition-notice strong { color: #fff; }
	.transition-notice span { color: rgb(241 255 253 / 78%); font-size: 0.92rem; line-height: 1.5; }
	.selection-dialog h1 { margin: 0; font-size: 24px; line-height: 1.2; }
	.selection-dialog .initial-focus-target:focus { outline: none; }
	.selection-introduction { max-width: 620px; margin: 8px 0 0; color: rgb(255 255 255 / 64%); font-size: .9rem; }
	.rp-summary { display: grid; justify-items: end; gap: 2px; color: rgb(255 255 255 / 62%); font-size: .82rem; white-space: nowrap; }
	.rp-summary strong { color: #fff; font-size: 1.05rem; }
	.identity-section, .return-section, .root-build, .rp-details { margin-top: 28px; }
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
	.return-choice, .export-nsec, .rank-controls button { min-height: 38px; border: 1px solid var(--action-tertiary-border); border-radius: 7px; background: var(--action-tertiary-background); color: var(--action-tertiary-foreground); cursor: pointer; }
	.return-choice:hover, .export-nsec:hover, .rank-controls button:hover:not(:disabled) { background: var(--action-tertiary-background-hover); }
	.return-choice:active, .export-nsec:active, .rank-controls button:active:not(:disabled) { background: var(--action-tertiary-background-active); }
	.return-choice:focus-visible, .export-nsec:focus-visible, .rank-controls button:focus-visible { outline: 3px solid var(--action-focus-ring); outline-offset: 2px; }
	.return-choice { flex: 1; text-align: left; }
	.return-label { display: flex; flex: 1; align-items: center; padding-inline: 10px; color: rgb(255 255 255 / 84%); }
	.export-nsec { padding: 0 10px; }
	.root-build { padding: 14px 14px 0; border: 1px solid rgb(104 241 221 / 23%); border-radius: 14px; background: rgb(19 24 43 / 42%); }
	.rp-notice { margin: 0 0 12px; color: rgb(255 255 255 / 62%); font-size: .82rem; }
	.rp-details { min-width: 0; }
	.rp-details-toggle { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 12px; background: rgb(255 255 255 / 3%); color: rgb(255 255 255 / 88%); cursor: pointer; font-size: 0.9375rem; font-weight: 700; list-style: none; }
	.rp-details-toggle::-webkit-details-marker { display: none; }
	.rp-details-toggle:hover { border-color: rgb(255 255 255 / 28%); background: rgb(255 255 255 / 6%); }
	.rp-details-toggle:focus-visible { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	:global(.rp-details-toggle svg) { width: 18px; height: 18px; flex: 0 0 auto; color: rgb(255 255 255 / 70%); transition: transform 160ms ease; }
	:global(.rp-details[open] .rp-details-toggle svg) { transform: rotate(180deg); }
	.rp-summary-panels { display: grid; gap: 20px; margin-top: 12px; font-size: 0.875rem; }
	.progression-card { display: flex; align-items: center; gap: 14px; min-width: 0; padding: 16px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 12px; background: linear-gradient(110deg, rgb(104 241 221 / 7%), rgb(255 255 255 / 2%)); }
	.progression-icon { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 10px; background: rgb(104 241 221 / 10%); color: var(--color-accent); }
	:global(.progression-icon svg) { width: 22px; height: 22px; }
	.progression-copy, .allocation-summary { min-width: 0; }
	.progression-card h2, .allocation-heading h2 { margin: 0; font-size: 1rem; font-weight: 750; line-height: 1.4; }
	.progression-card p { margin: 4px 0 0; color: rgb(255 255 255 / 72%); font-size: 0.875rem; line-height: 1.5; }
	.allocation-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
	.allocation-heading > span { color: rgb(255 255 255 / 64%); font-size: 0.875rem; white-space: nowrap; }
	.root-ability-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
	.root-ability-card { min-width: 0; padding: 16px; border: 1px solid rgb(255 255 255 / 12%); border-radius: 12px; background: rgb(255 255 255 / 3%); color: rgb(255 255 255 / 88%); }
	.root-ability-card.ranked { border-color: rgb(104 241 221 / 36%); background: rgb(104 241 221 / 5%); }
	.root-ability-heading { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; }
	.root-ability-heading strong { min-width: 0; font-size: 0.9375rem; line-height: 1.4; }
	.root-ability-icon { display: inline-grid; width: 32px; height: 32px; place-items: center; border-radius: 8px; background: rgb(255 255 255 / 5%); color: rgb(255 255 255 / 68%); }
	.root-ability-card.ranked .root-ability-icon { background: rgb(104 241 221 / 10%); color: var(--color-accent); }
	:global(.root-ability-icon svg) { display: block; width: 20px; height: 20px; }
	.root-ability-rank { padding: 4px 8px; border-radius: 6px; background: rgb(255 255 255 / 5%); color: rgb(255 255 255 / 68%); font-size: 0.875rem; white-space: nowrap; }
	.root-ability-rank.ranked { background: rgb(104 241 221 / 10%); color: rgb(255 255 255 / 88%); }
	.root-ability-effects { display: grid; gap: 6px; margin: 12px 0 0; padding-top: 12px; border-top: 1px solid rgb(255 255 255 / 8%); line-height: 1.5; }
	.root-ability-effects > div { display: grid; grid-template-columns: 3.4rem minmax(0, 1fr); align-items: baseline; gap: 8px; }
	.root-ability-effects dt { color: rgb(255 255 255 / 58%); font-size: 0.875rem; }
	.root-ability-effects dd { min-width: 0; margin: 0; color: rgb(255 255 255 / 92%); font-size: 0.9375rem; font-weight: 650; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
	.root-ability-next dd { color: rgb(255 255 255 / 72%); font-weight: 500; }
	.ability-list { border-top: 1px solid rgb(255 255 255 / 12%); }
	.ability-row { display: grid; grid-template-columns: minmax(0, 1fr) 44px auto; align-items: center; gap: 16px; padding: 13px 0; border-bottom: 1px solid rgb(255 255 255 / 12%); }
	.ability-main { min-width: 0; }
	.ability-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.ability-title strong { font-size: .92rem; }
	.rank-label { color: rgb(255 255 255 / 62%); font-size: .8rem; }
	:global(.help-trigger) { display: grid; width: 44px; height: 44px; flex: 0 0 44px; place-items: center; align-content: center; justify-content: center; margin-left: 0; padding: 0; border: 1px solid var(--action-tertiary-border); border-radius: 50%; background: var(--action-tertiary-background); color: var(--action-tertiary-foreground); cursor: pointer; line-height: 0; }
	:global(.help-trigger:hover) { background: var(--action-tertiary-background-hover); }
	:global(.help-trigger:active) { background: var(--action-tertiary-background-active); }
	:global(.help-trigger svg) { display: block; width: 18px; height: 18px; }
	:global(.help-trigger:focus-visible) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
	.ability-effect { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-top: 4px; color: rgb(255 255 255 / 58%); font-size: .8rem; }
	.ability-effect strong { color: #fff; font-size: .92rem; }
	.ability-effect small { color: var(--color-accent); }
	.rank-controls { display: grid; grid-template-columns: 44px 34px 44px; align-items: center; gap: 6px; text-align: center; }
	.rank-controls button { width: 44px; min-height: 44px; padding: 0; font-size: 1.2rem; line-height: 1; }
	.rank-controls button:disabled { border-color: var(--action-disabled-border); background: var(--action-disabled-background); color: var(--action-disabled-foreground); cursor: not-allowed; }
	.rank-controls span { font-weight: 750; }
	:global(.help-content) { z-index: 110; width: min(320px, calc(100vw - 32px)); padding: 13px 15px; border: 1px solid rgb(111 255 233 / 42%); border-radius: 10px; background: #20243b; color: #fff; box-shadow: 0 12px 35px rgb(0 0 0 / 32%); font-size: .8rem; }
	:global(.help-content ul) { display: grid; gap: 4px; margin: 8px 0 0; padding-left: 18px; color: rgb(255 255 255 / 78%); }
	:global(.help-content p) { margin: 8px 0 0; color: rgb(255 255 255 / 62%); }
	.selection-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 26px 20px; border-top: 1px solid rgb(255 255 255 / 18%); background: rgb(13 16 32 / 96%); }
	.selection-summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: rgb(255 255 255 / 62%); font-size: .82rem; }
	.selection-summary strong { color: #fff; }
	.summary-divider { width: 1px; height: 18px; background: rgb(255 255 255 / 20%); }
	.selection-footer :global(.action-button) { min-width: 210px; min-height: 50px; }
	.selection-dialog > .opening-footer { justify-content: center; }
	.selection-dialog > .opening-footer :global(.action-button) { width: min(320px, 100%); min-width: min(210px, 100%); min-height: 64px; font-size: 1.1rem; }

	@media (max-width: 700px) {
		.selection-dialog { height: min(760px, calc(100dvh - 40px)); max-height: calc(100dvh - 40px); }
		.selection-content { padding: 20px 16px 18px; }
		.selection-header { gap: 12px; }
		.selection-dialog h1 { font-size: 21px; }
		.rp-summary { font-size: .75rem; }
		.identity-section, .return-section, .root-build, .rp-details { margin-top: 22px; }
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
		.root-ability-grid { grid-template-columns: 1fr; }
		.progression-card, .root-ability-card { padding: 14px; }
		.selection-footer { align-items: stretch; flex-direction: column; gap: 12px; padding: 14px 16px max(16px, env(safe-area-inset-bottom)); }
		.selection-footer :global(.action-button) { width: 100%; }
		.opening-footer { align-items: center; }
	}
</style>
