<script lang="ts">
	type Effect = 'benefit' | 'calamity';
	type Presentation = 'field' | 'rule';
	type Props = Readonly<{ effect: Effect; presentation?: Presentation }>;
	let { effect, presentation = 'field' }: Props = $props();
</script>

<g class="tag-game-effect-symbol" data-tag-game-effect-symbol={effect}>
	{#if effect === 'benefit'}
		<g class="fuku-mallet" data-fuku-mallet transform={presentation === 'field' ? 'translate(87 65) rotate(-10)' : 'translate(-38.6 -23.7) scale(.65) translate(87 65) rotate(-10)'}>
			<rect class="fuku-mallet-handle" data-fuku-mallet-handle x="-3" y="-11" width="6" height="30" rx="1.8" fill="#ffe3ab" stroke="white" stroke-width="2" />
			<rect class="fuku-mallet-head" data-fuku-mallet-head x="-15" y="-25" width="30" height="16" rx="5.8" fill="#e23c2c" stroke="white" stroke-width="2.4" />
			<path class="fuku-mallet-endcap" d="M-9.5 -22V-12M9.5 -22V-12" stroke="#ffdc83" stroke-width="3.5" stroke-linecap="round" />
		</g>
	{:else}
		<g class="oni-horns" data-oni-horns transform={presentation === 'field' ? undefined : 'translate(-.72 13.58) scale(.44)'}>
			<ellipse class="oni-horn-root" cx="18" cy="20" rx="8" ry="5.5" />
			<ellipse class="oni-horn-root" cx="58" cy="20" rx="8" ry="5.5" />
			<path class="oni-horn" d="M10 24Q8 21 10 17L16 -10Q18 -16 22 -11L28 17Q29 22 25 24Q18 27 10 24Z" />
			<path class="oni-horn" d="M66 24Q68 21 66 17L60 -10Q58 -16 54 -11L48 17Q47 22 51 24Q58 27 66 24Z" />
			<path class="oni-horn-ridge" d="M12 16L18 -9M64 16L58 -9" />
		</g>
	{/if}
</g>

<style>
	.fuku-mallet { stroke-linecap: round; stroke-linejoin: round; }
	.oni-horn-root { fill: #110e1c; stroke: #a493bc; stroke-width: 2; }
	.oni-horn { fill: #201a2b; stroke: #b0a0c5; stroke-width: 2.8; stroke-linejoin: round; }
	.oni-horn-ridge { fill: none; stroke: #c2b5cf; stroke-width: 2; stroke-linecap: round; opacity: .9; }
</style>
