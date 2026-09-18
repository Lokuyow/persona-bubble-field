<script lang="ts">
	import Volume from '~icons/tabler/volume';
	import Volume2 from '~icons/tabler/volume-2';
	import Volume4 from '~icons/tabler/volume-4';
	import VolumeOff from '~icons/tabler/volume-off';
	import { soundIconName } from './soundIcon';

	type Props = Readonly<{ volume: number; onOpen: () => void; onVolume: (volume: number) => void }>;
	let { volume, onOpen, onVolume }: Props = $props();
	let open = $state(false);
	let iconName = $derived(soundIconName(volume));
</script>

<div class="sound-control" data-sound-control>
	<button class="speaker-button" type="button" aria-label={volume === 0 ? 'Open sound settings (muted)' : 'Open sound settings'} aria-expanded={open} onclick={() => { onOpen(); open = !open; }}>
		<span class="speaker-icon" aria-hidden="true">
			{#if iconName === 'volume-off'}
				<VolumeOff />
			{:else if iconName === 'volume-4'}
				<Volume4 />
			{:else if iconName === 'volume-2'}
				<Volume2 />
			{:else}
				<Volume />
			{/if}
		</span>
	</button>
	{#if open}
		<div class="sound-panel" role="dialog" aria-label="Sound settings" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
			<label><span>Volume</span><input type="range" min="0" max="100" value={Math.round(volume * 100)} aria-label="Sound volume" oninput={(event) => onVolume(Number(event.currentTarget.value) / 100)} /></label>
		</div>
	{/if}
</div>

<style>
	.sound-control { position: absolute; top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); z-index: 10; }
	.speaker-button { width: 38px; height: 38px; padding: 0; border: 1px solid rgba(255,255,255,.38); border-radius: 50%; background: rgba(10,17,35,.64); color: white; cursor: pointer; box-shadow: 0 3px 12px rgba(0,0,0,.18); backdrop-filter: blur(8px); }
	.speaker-icon { display: inline-flex; width: 18px; height: 18px; align-items: center; justify-content: center; }
	.speaker-icon :global(svg) { width: 18px; height: 18px; }
	.sound-panel { position: absolute; top: 44px; right: 0; width: min(156px, calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right))); padding: 8px 10px 9px; display: grid; border: 1px solid rgba(255,255,255,.25); border-radius: 11px; background: rgba(10,17,35,.66); color: white; box-shadow: 0 5px 18px rgba(0,0,0,.2); backdrop-filter: blur(10px); }
	.sound-panel label { display: grid; gap: 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; }
	.sound-panel input { width: 100%; margin: 0; accent-color: white; }
</style>
