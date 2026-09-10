<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { MendingProjection } from '$lib/mending';

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		onOpenChange: (open: boolean) => void;
		onStart: () => void;
		onCollect: () => void;
	}>;
	let { open, projection, hasJob, onOpenChange, onStart, onCollect }: Props = $props();
	let hours = $derived(((projection?.processedDurationMs ?? 0) / (60 * 60 * 1000)).toFixed(2));
	let lifespanHours = $derived(((projection?.lifespanExtensionMs ?? 0) / (60 * 60 * 1000)).toFixed(2));
	let points = $derived((projection?.points ?? 0).toFixed(2));
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content class="mending-dialog-content" preventScroll={false}>
				<Dialog.Title>繕い端末</Dialog.Title>
				<Dialog.Description>非同期処理の状態を確認します。</Dialog.Description>
				{#if !hasJob}
					<p>繕いを開始できます。</p>
					<button type="button" onclick={onStart}>繕いを開始</button>
				{:else if projection?.completed}
					<p>処理完了: 経過 {hours}時間 / 寿命延長 +{lifespanHours}時間 / 成果 {points}pt</p>
					<button type="button" onclick={onCollect}>成果を受け取る</button>
				{:else}
					<p>繕い中: 経過 {hours}時間 / 寿命延長 +{lifespanHours}時間 / 推定 {points}pt</p>
				{/if}
				<Dialog.Close>閉じる</Dialog.Close>
			</Dialog.Content>
		</Dialog.Portal>
	{/if}
</Dialog.Root>

<style>
	:global(.mending-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(35, 44, 41, 0.48); }
	:global(.mending-dialog-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 14px; width: min(calc(100vw - 32px), 360px); padding: 24px; border-radius: 20px; background: #f7f7ef; color: #374345; transform: translate(-50%, -50%); }
	:global(.mending-dialog-content button) { min-height: 42px; border: 1px solid rgba(57, 67, 64, 0.2); border-radius: 999px; background: #d9edf0; color: inherit; font: inherit; font-weight: 800; }
</style>
