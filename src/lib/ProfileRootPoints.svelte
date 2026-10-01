<script lang="ts">
	let { points }: { points: number } = $props();
</script>

<div class="profile-root-points"><span>Root Point</span><strong>{points} RP</strong></div>

<style>
	.profile-root-points { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border: 1px solid rgba(57, 67, 64, .14); border-radius: 12px; background: rgba(255, 255, 255, .68); color: #596762; font-size: 13px; font-weight: 800; }
	.profile-root-points strong { color: #49565f; font-size: 17px; font-weight: 900; font-variant-numeric: tabular-nums; }
</style>
