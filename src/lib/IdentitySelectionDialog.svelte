<script lang="ts">
	import { asset } from '$app/paths';
	import { getCharacterById } from '$lib/character';
	import type { ClearedIdentityCandidate, IdentityCandidate, PendingSelection, SelectionCandidate } from '$lib/rootIdentity';
	import { isRootBuildAllocatable, rootBuildCost, usableRootPoints, type RootBuild } from '$lib/rootProgression';

	let { selection, rootPoints, onSelect, onExportNsec }: {
		selection: PendingSelection | null;
		rootPoints: number;
		onSelect: (candidate: SelectionCandidate, rootBuild: RootBuild) => void;
		onExportNsec: (candidate: ClearedIdentityCandidate) => void;
	} = $props();
	let backdrop = $state<HTMLElement | null>(null);
	let chosen = $state<SelectionCandidate | null>(null);
	let rootBuild = $state<RootBuild>({ inferenceAcceleration: 0, contextCompression: 0, hallucinationResistance: 0 });
	const ROOT_EFFECTS = {
		inferenceAcceleration: ['×1.00', '×1.30', '×1.60', '×2.00'],
		contextCompression: ['×1.00 / overflow lifespan 0%', '×1.50 / overflow lifespan 20%', '×2.00 / overflow lifespan 35%', '×3.00 / overflow lifespan 50%'],
		hallucinationResistance: ['最大7日', '最大14日', '最大21日', '最大30日']
	} as const;

	function character(candidate: IdentityCandidate) {
		const value = getCharacterById(candidate.characterId);
		if (!value) throw new Error('Candidate character is unavailable.');
		return value;
	}

	function choose(candidate: SelectionCandidate): void {
		chosen = candidate;
	}

	function changeRank(key: keyof RootBuild, delta: number): void {
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
			const first = focusableElements(dialog)[0];
			if (first && !dialog.contains(document.activeElement)) first.focus();
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
			<h1 id="identity-selection-title">Runを始める</h1>
			<p id="identity-selection-description" class="selection-introduction">人格を選び、今回のRunで使うRoot buildを決めてください。Run開始後は変更できません。</p>
			<p class="root-points">Root Point: <strong>{rootPoints} RP</strong>（今回使用可能: {usableRootPoints(rootPoints)} RP）</p>
			<div class="candidate-grid">
				{#each selection.candidates as candidate}
					{@const selectedCharacter = character(candidate)}
					<button class:chosen={chosen === candidate} class="candidate" type="button" onclick={() => choose(candidate)} aria-label={`${selectedCharacter.name}を選ぶ`}>
						<img src={asset(`/${selectedCharacter.picture}`)} alt="" />
						<span class="candidate-name">{selectedCharacter.name}</span>
						<span class="candidate-about">{selectedCharacter.about}</span>
					</button>
				{/each}
			</div>
			{#if selection.reusableIdentities.length > 0}
				<h2 class="return-heading">clear済みIdentityで再開</h2>
				<div class="return-list">
					{#each selection.reusableIdentities as candidate}
						{@const selectedCharacter = character(candidate)}
						<div class="return-card" class:chosen={chosen === candidate}>
							<button class="return-choice" type="button" onclick={() => choose(candidate)}>{selectedCharacter.name}（Generation {candidate.generation}のIdentity）を使う</button>
							<button class="export-nsec" type="button" onclick={() => onExportNsec(candidate)}>nsecを取得</button>
						</div>
					{/each}
				</div>
			{/if}
			<section class="root-build" aria-label="Root build">
				<h2>Root build</h2>
				<p>合計 {rootBuildCost(rootBuild)} / {usableRootPoints(rootPoints)} RP</p>
				{#each [['inferenceAcceleration', '推論加速'], ['contextCompression', 'コンテキスト圧縮'], ['hallucinationResistance', 'ハルシネーション耐性']] as [key, label]}
					{@const effects = ROOT_EFFECTS[key as keyof RootBuild]}
					<div class="rank-row"><span>{label} Rank {rootBuild[key as keyof RootBuild]}</span><button type="button" onclick={() => changeRank(key as keyof RootBuild, -1)} disabled={rootBuild[key as keyof RootBuild] === 0}>−</button><button type="button" onclick={() => changeRank(key as keyof RootBuild, 1)} disabled={rootBuild[key as keyof RootBuild] === 3}>＋</button></div>
					<ul class="rank-effects" aria-label={`${label}の効果`}>{#each effects as effect, rank}<li>Rank {rank}: {effect}</li>{/each}</ul>
					{#if key === 'inferenceAcceleration'}<p class="rank-note">最初の有効通常作業24時間のpoint生成だけに適用</p>{/if}
					{#if key === 'hallucinationResistance'}<p class="rank-note">fresh Run開始時寿命は常に7日</p>{/if}
				{/each}
				<button class="start-run" type="button" onclick={startRun} disabled={!chosen || !isRootBuildAllocatable(rootBuild, rootPoints)}>このbuildでRun開始</button>
			</section>
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
		padding: 20px;
		background: rgb(10 10 18 / 72%);
	}

	.selection-dialog {
		position: relative;
		inset: auto;
		box-sizing: border-box;
		width: min(900px, 100%);
		max-height: calc(100vh - 40px);
		max-width: none;
		margin: 0;
		padding: 24px;
		overflow-y: auto;
		border: 1px solid rgb(255 255 255 / 24%);
		border-radius: 18px;
		background: #181827;
		color: #fff;
	}

	.selection-dialog::backdrop { background: transparent; }
	.selection-dialog h1 { margin: 0; font-size: 1.4rem; }
	.selection-introduction { margin: 8px 0 20px; color: rgb(255 255 255 / 72%); }
	.candidate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
	.candidate { display: grid; gap: 8px; padding: 12px; border: 1px solid rgb(255 255 255 / 20%); border-radius: 14px; background: #25253a; color: inherit; text-align: left; cursor: pointer; }
	.candidate:hover, .candidate:focus-visible { border-color: #b9a8ff; outline: 2px solid #b9a8ff; outline-offset: 2px; }
	.candidate.chosen, .return-card.chosen { border-color: #6fffe9; box-shadow: 0 0 0 2px rgb(111 255 233 / 30%); }
	.candidate img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 10px; background: #30304b; }
	.candidate-name { font-weight: 700; }
	.candidate-about { min-height: 3.5em; color: rgb(255 255 255 / 74%); white-space: pre-line; }
	.root-points { margin: 0 0 14px; color: rgb(255 255 255 / 78%); }
	.return-heading, .root-build h2 { margin: 20px 0 8px; font-size: 1.05rem; }
	.return-list, .root-build { display: grid; gap: 8px; }
	.return-card { display: flex; gap: 8px; padding: 8px; border: 1px solid rgb(255 255 255 / 20%); border-radius: 10px; background: #25253a; }
	.return-choice, .export-nsec, .rank-row button, .start-run { min-height: 38px; border: 1px solid rgb(255 255 255 / 24%); border-radius: 7px; background: #30304b; color: inherit; cursor: pointer; }
	.return-choice { flex: 1; text-align: left; }
	.export-nsec { padding: 0 10px; }
	.root-build { margin-top: 4px; padding: 14px; border: 1px solid rgb(111 255 233 / 35%); border-radius: 12px; background: rgb(20 48 57 / 70%); }
	.root-build p { margin: 0; color: rgb(255 255 255 / 75%); }
	.rank-row { display: grid; grid-template-columns: 1fr 42px 42px; align-items: center; gap: 7px; }
	.rank-row button { font-size: 1.2rem; }
	.rank-effects { display: grid; gap: 2px; margin: 0 0 2px; padding-left: 18px; color: rgb(255 255 255 / 72%); font-size: .86rem; }
	.rank-note { margin: -2px 0 2px; color: rgb(255 255 255 / 62%); font-size: .82rem; }
	.rank-row button:disabled, .start-run:disabled { cursor: not-allowed; opacity: .45; }
	.start-run { min-height: 46px; border-color: #72ffff; background: linear-gradient(135deg, #20cfd0, #087eaa); color: #02141e; font-weight: 800; }

	@media (max-width: 700px) {
		.selection-dialog { max-height: calc(100dvh - 40px); }
		.candidate-grid { grid-template-columns: 1fr; }
		.candidate { grid-template-columns: 80px 1fr; }
		.candidate img { grid-row: span 2; }
		.candidate-about { min-height: auto; }
	}
</style>
