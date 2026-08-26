<svelte:head>
	<title>Bootstrap placeholder</title>
	<meta
		name="description"
		content="A minimal bootstrap placeholder for an upcoming static web application."
	/>
</svelte:head>

<main>
	<p class="eyebrow">Bootstrap complete</p>
	<h1>静的Webアプリの初期構築が完了しました。</h1>
	<p>製品UIと機能は、これから実装します。</p>
</main>

<style>
	:global(*) {
		box-sizing: border-box;
	}

	:global(body) {
		margin: 0;
		min-width: 320px;
		font-family: system-ui, sans-serif;
		color: #202124;
		background: #f7f7f5;
	}

	main {
		display: grid;
		min-height: 100svh;
		place-content: center;
		gap: 0.75rem;
		padding: 2rem;
		text-align: center;
	}

	.eyebrow {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #5f6368;
	}

	h1,
	p {
		margin: 0;
	}

	h1 {
		max-width: 36rem;
		font-size: clamp(1.75rem, 5vw, 3rem);
		line-height: 1.2;
	}

	main > p:last-child {
		color: #5f6368;
	}
</style>
