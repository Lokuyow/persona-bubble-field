<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { MendingProjection } from '$lib/mending';

	type Props = Readonly<{
		open: boolean;
		projection: MendingProjection | null;
		hasJob: boolean;
		points: number;
		onOpenChange: (open: boolean) => void;
		onStart: () => void;
		onCollect: () => void;
	}>;
	let { open, projection, hasJob, points: ownedPointsValue, onOpenChange, onStart, onCollect }: Props = $props();
	let hours = $derived(((projection?.processedDurationMs ?? 0) / (60 * 60 * 1000)).toFixed(2));
	let maximumHours = $derived(((projection ? projection.processedDurationMs + projection.remainingDurationMs : 0) / (60 * 60 * 1000)).toFixed(2));
	let remainingHours = $derived(((projection?.remainingDurationMs ?? 0) / (60 * 60 * 1000)).toFixed(2));
	let lifespanHours = $derived(((projection?.lifespanExtensionMs ?? 0) / (60 * 60 * 1000)).toFixed(2));
	let unclaimedPoints = $derived((projection?.points ?? 0).toFixed(2));
	let ownedPoints = $derived(ownedPointsValue.toFixed(2));
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	{#if open}
		<Dialog.Portal>
			<Dialog.Overlay class="mending-dialog-overlay" />
			<Dialog.Content class="mending-dialog-content" preventScroll={false}>
				<Dialog.Title>繕い端末</Dialog.Title>
				<Dialog.Description>非同期処理の状態を確認します。</Dialog.Description>
				<p>所持ポイント: {ownedPoints}pt</p>
				{#if !hasJob}
					<p>繕いを開始できます。</p>
					<button type="button" onclick={onStart}>繕いを開始</button>
				{:else}
					<p>蓄積時間: {hours} / {maximumHours}時間</p>
					{#if projection?.completed}<p>蓄積上限に達しています</p>{:else}<p>上限まで: {remainingHours}時間</p>{/if}
					<p>寿命延長: +{lifespanHours}時間（寿命に反映中）</p>
					<p>受取可能ポイント: +{unclaimedPoints}pt</p>
					<button type="button" onclick={onCollect}>成果を受け取る</button>
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
