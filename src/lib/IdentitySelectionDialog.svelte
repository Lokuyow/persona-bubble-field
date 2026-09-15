<script lang="ts">
	import { asset } from '$app/paths';
	import { getCharacterById } from '$lib/character';
	import type { IdentityCandidate, PendingSelection } from '$lib/rootIdentity';

	let { selection, onSelect }: {
		selection: PendingSelection | null;
		onSelect: (candidate: IdentityCandidate) => void;
	} = $props();
	let backdrop = $state<HTMLElement | null>(null);

	function character(candidate: IdentityCandidate) {
		const value = getCharacterById(candidate.characterId);
		if (!value) throw new Error('Candidate character is unavailable.');
		return value;
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
			<h1 id="identity-selection-title">ハコの中の人格を選ぶ</h1>
			<p id="identity-selection-description" class="selection-introduction">この人格でハコの時間が始まります。</p>
			<div class="candidate-grid">
				{#each selection.candidates as candidate}
					{@const selectedCharacter = character(candidate)}
					<button class="candidate" type="button" onclick={() => onSelect(candidate)} aria-label={`${selectedCharacter.name}を選ぶ`}>
						<img src={asset(`/${selectedCharacter.picture}`)} alt="" />
						<span class="candidate-name">{selectedCharacter.name}</span>
						<span class="candidate-about">{selectedCharacter.about}</span>
					</button>
				{/each}
			</div>
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
		width: min(900px, 100%);
		max-width: none;
		margin: 0;
		padding: 24px;
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
	.candidate img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 10px; background: #30304b; }
	.candidate-name { font-weight: 700; }
	.candidate-about { min-height: 3.5em; color: rgb(255 255 255 / 74%); white-space: pre-line; }

	@media (max-width: 700px) {
		.candidate-grid { grid-template-columns: 1fr; }
		.candidate { grid-template-columns: 80px 1fr; }
		.candidate img { grid-row: span 2; }
		.candidate-about { min-height: auto; }
	}
</style>
