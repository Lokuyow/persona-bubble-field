<script lang="ts">
	type Props = Readonly<{ volume: number; muted: boolean; onOpen: () => void; onVolume: (volume: number) => void; onMute: (muted: boolean) => void }>;
	let { volume, muted, onOpen, onVolume, onMute }: Props = $props();
	let open = $state(false);
</script>

<div class="sound-control" data-sound-control>
	<button class="speaker-button" type="button" aria-label={muted ? 'Open sound settings (muted)' : 'Open sound settings'} aria-expanded={open} onclick={() => { onOpen(); open = !open; }}>
		<span aria-hidden="true">{muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}</span>
	</button>
	{#if open}
		<div class="sound-panel" role="dialog" aria-label="Sound settings">
			<label>Volume <input type="range" min="0" max="100" value={Math.round(volume * 100)} aria-label="Sound volume" oninput={(event) => onVolume(Number(event.currentTarget.value) / 100)} /></label>
			<button type="button" aria-pressed={muted} aria-label={muted ? 'Unmute sound' : 'Mute sound'} onclick={() => onMute(!muted)}>{muted ? 'Unmute' : 'Mute'}</button>
		</div>
	{/if}
</div>

<style>
	.sound-control { position: absolute; top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); z-index: 10; }
	.speaker-button { width: 46px; height: 46px; padding: 0; border: 1px solid rgba(255,255,255,.45); border-radius: 50%; background: rgba(10,17,35,.86); color: white; font-size: 20px; cursor: pointer; }
	.sound-panel { position: absolute; top: 54px; right: 0; width: min(220px, calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right))); padding: 12px; display: grid; gap: 10px; border: 1px solid rgba(255,255,255,.3); border-radius: 10px; background: rgba(10,17,35,.95); color: white; }
	.sound-panel label { display: grid; gap: 6px; font-size: 13px; }
	.sound-panel input { width: 100%; }
	.sound-panel button { min-height: 38px; }
</style>
