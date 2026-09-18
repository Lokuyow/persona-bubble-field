<script lang="ts">
	type Props = Readonly<{
		open: boolean;
		mode: 'rules' | 'join-confirmation';
		onOpenChange: (open: boolean) => void;
		onJoin: () => void;
		onViewRules: () => void;
		onCancel: () => void;
	}>;

	let { open, mode, onOpenChange, onJoin, onViewRules, onCancel }: Props = $props();
	let isConfirmation = $derived(mode === 'join-confirmation');
</script>

	{#if open}
		<div class="rift-rules-overlay" role="presentation">
			<div class="rift-rules-content" role="dialog" aria-modal="true" aria-labelledby="rift-rules-title" tabindex="-1">
				<h2 id="rift-rules-title">{isConfirmation ? '抜け穴へ参加しますか？' : '綻びのルール'}</h2>
				<p class="rift-rules-description">
					{isConfirmation ? '参加する前に、次のことを確認してください。' : 'ひとつの抜け穴には3〜6人が参加します。綻びは全3ラウンドです。'}
				</p>

				{#if isConfirmation}
					<div class="rift-warning" role="alert">
						<strong>3〜6人 / 全3ラウンド</strong>
						<span>維持人数が不足すると、脱出を選んだ者は死亡します。</span>
					</div>
					<div class="rift-dialog-actions">
						<button class="rift-primary-action" type="button" onclick={onJoin}>参加する</button>
						<button class="rift-secondary-action" type="button" onclick={onViewRules}>ルールを見る</button>
						<button class="rift-secondary-action" type="button" onclick={onCancel}>キャンセル</button>
					</div>
				{:else}
					<div class="rift-rules-body">
						<section>
							<h3>1ラウンドの流れ</h3>
							<p>相談 30秒 → 選択 30秒 → 結果発表 20秒</p>
							<p>相談のあと、全員がどちらかを選びます。</p>
						</section>
						<section>
							<h3>選択肢</h3>
							<ul>
								<li><strong>抜け穴を維持する</strong></li>
								<li><strong>脱出を試みる</strong></li>
							</ul>
							<p>誰が何を選んだかは、結果発表まで分かりません。</p>
						</section>
						<section>
							<h3>維持に必要な人数</h3>
							<ul>
								<li>3人 → <strong>2人</strong></li>
								<li>4人 → <strong>3人</strong></li>
								<li>5人 → <strong>4人</strong></li>
								<li>6人 → <strong>4人</strong></li>
							</ul>
						</section>
						<section>
							<h3>結果</h3>
							<ul>
								<li>全員が維持 → <strong>全員 +20pt</strong></li>
								<li>必要人数を維持し、一部が脱出 → <strong>維持 +10pt / 脱出 +100pt</strong></li>
								<li>維持する人数が足りない → <strong>維持 0pt / 脱出を選んだ人は死亡</strong></li>
							</ul>
						</section>
					</div>
					<div class="rift-dialog-actions">
						<button class="rift-primary-action" type="button" onclick={() => onOpenChange(false)}>閉じる</button>
					</div>
				{/if}
			</div>
		</div>
	{/if}

<style>
	:global(.rift-rules-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(20, 9, 24, .68); backdrop-filter: blur(2px); }
	:global(.rift-rules-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 14px; width: min(calc(100vw - 28px), 560px); max-height: calc(100svh - 28px); overflow: auto; padding: clamp(18px, 4vw, 28px); border: 1px solid rgba(141, 70, 146, .55); border-radius: 16px; background: #fffaff; color: #3d3144; box-shadow: 0 16px 45px rgba(45, 20, 48, .28); transform: translate(-50%, -50%); }
	:global(.rift-rules-content h2) { margin: 0; font-size: clamp(1.3rem, 5vw, 1.8rem); }
	.rift-rules-description { margin: 0; color: #665b69; line-height: 1.5; }
	.rift-rules-body { display: grid; gap: 12px; line-height: 1.55; }
	.rift-rules-body p, .rift-rules-body ul { margin: 0; }
	.rift-rules-body section { display: grid; gap: 3px; padding-top: 10px; border-top: 1px solid rgba(102, 28, 106, .15); }
	.rift-rules-body h3 { margin: 0; font-size: 1rem; }
	.rift-rules-body ul { padding-left: 1.2rem; }
	.rift-warning { display: grid; gap: 8px; padding: 14px; border: 1px solid #c46b75; border-radius: 10px; background: #fff0f1; color: #6f2430; line-height: 1.5; }
	.rift-dialog-actions { display: grid; gap: 9px; }
	.rift-dialog-actions button { min-height: 44px; padding: 9px 12px; border-radius: 9px; font: inherit; font-weight: 800; cursor: pointer; }
	.rift-primary-action { border: 1px solid #8d4692; background: #8d4692; color: white; }
	.rift-secondary-action { border: 1px solid rgba(102, 28, 106, .3); background: white; color: #4d3150; }
	:global(.rift-rules-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (min-width: 701px) {
		:global(.rift-rules-content) { font-size: 16px; }
		:global(.rift-rules-content h2) { font-size: 2rem; }
		.rift-rules-body h3 { font-size: 1.1rem; }
		.rift-dialog-actions button { font-size: 1rem; }
	}
</style>
