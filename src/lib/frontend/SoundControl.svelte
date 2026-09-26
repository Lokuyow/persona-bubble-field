<script lang="ts">
	import Volume from '~icons/tabler/volume';
	import Volume2 from '~icons/tabler/volume-2';
	import Volume4 from '~icons/tabler/volume-4';
	import VolumeOff from '~icons/tabler/volume-off';
	import { Popover } from 'bits-ui';
	import { soundIconName } from './soundIcon';

	type Props = Readonly<{ volume: number; onOpen: () => void; onVolume: (volume: number) => void }>;
	let { volume, onOpen, onVolume }: Props = $props();
	let iconName = $derived(soundIconName(volume));
</script>

<div class="sound-control" data-sound-control>
	<Popover.Root>
		<Popover.Trigger class="speaker-button" aria-label={volume === 0 ? 'Open sound settings (muted)' : 'Open sound settings'} onclick={onOpen}>
			<span class="speaker-icon" data-sound-icon={iconName} aria-hidden="true">
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
		</Popover.Trigger>
		<Popover.Content class="sound-panel" side="top" align="center" sideOffset={8} role="dialog" aria-label="Sound settings" tabindex={-1} onpointerdown={(event) => event.stopPropagation()}>
			<label><input type="range" min="0" max="100" value={Math.round(volume * 100)} aria-label="Sound volume" oninput={(event) => onVolume(Number(event.currentTarget.value) / 100)} /></label>
		</Popover.Content>
	</Popover.Root>
</div>

<style>
	.sound-control { --sound-control-background: #202a40; --sound-control-background-hover: #303e5a; --sound-control-background-active: #3b4c69; --sound-control-border: #9aa9c1; --sound-control-foreground: #fff; position: relative; z-index: 10; justify-self: end; }
	:global(.speaker-button) { width: 44px; height: 44px; padding: 0; border: 1px solid var(--sound-control-border); border-radius: 50%; background: var(--sound-control-background); color: var(--sound-control-foreground); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
	:global(.speaker-button:hover) { background: var(--sound-control-background-hover); }
	:global(.speaker-button:active) { background: var(--sound-control-background-active); }
	:global(.speaker-button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 2px; }
	.speaker-icon { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; }
	.speaker-icon :global(svg) { width: 24px; height: 24px; }
	:global(.action-dock) .sound-control { --sound-control-background: var(--action-icon-background); --sound-control-background-hover: var(--action-icon-background-hover); --sound-control-background-active: var(--action-icon-background-active); --sound-control-border: var(--action-icon-border); --sound-control-foreground: var(--action-icon-foreground); }
	:global(.action-dock) .sound-control :global(.speaker-button) { box-shadow: 0 5px 12px rgba(58, 70, 61, 0.1); }
	:global(.action-dock) .sound-control :global(.speaker-button) { width: 54px; height: 44px; border-radius: 12px; }
	@media (max-width: 700px) {
		:global(.action-dock) .sound-control :global(.speaker-button) { width: 44px; height: 44px; }
	}
	:global(.sound-panel) { width: min(156px, calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right))); padding: 8px 10px 9px; display: grid; border: 1px solid rgba(255,255,255,.25); border-radius: 11px; background: rgba(10,17,35,.52); color: white; box-shadow: 0 5px 18px rgba(0,0,0,.2); backdrop-filter: blur(10px); }
	:global(.sound-panel label) { display: grid; gap: 4px; font-size: 11px; font-weight: 600; letter-spacing: .02em; }
	:global(.sound-panel input) { width: 100%; margin: 0; accent-color: white; }
</style>
