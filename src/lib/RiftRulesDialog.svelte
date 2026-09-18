<script lang="ts">
	type Props = Readonly<{
		open: boolean;
		mode: 'rules' | 'join-confirmation';
		onOpenChange: (open: boolean) => void;
		onJoin: () => void;
		onViewRules: () => void;
	}>;

	let { open, mode, onOpenChange, onJoin, onViewRules }: Props = $props();
	let isConfirmation = $derived(mode === 'join-confirmation');
</script>

	{#if open}
		<div class="rift-rules-overlay" role="presentation">
			<div class="rift-rules-content" role="dialog" aria-modal="true" aria-labelledby="rift-rules-title" tabindex="-1">
				<h2 id="rift-rules-title">{isConfirmation ? '抜け穴へ参加しますか？' : '綻びのルール'}</h2>
				<p class="rift-rules-description">
					{isConfirmation ? '参加する前に、次のことを確認してください。' : 'ソトへ続く抜け穴を、参加者みんなで巡るゲームです。'}
				</p>

				{#if isConfirmation}
					<div class="rift-warning" role="alert">
						<strong>3〜6人 / 全3ラウンド</strong>
						<span>維持人数が不足すると、脱出を選んだ者は死亡します。</span>
					</div>
					<div class="rift-dialog-actions">
						<button class="rift-primary-action" type="button" onclick={onJoin}>参加する</button>
						<button class="rift-secondary-action" type="button" onclick={onViewRules}>ルールを見る</button>
					</div>
				{:else}
					<div class="rift-rules-body">
						<p>1つの抜け穴に3〜6人で参加し、全3ラウンドを進めます。</p>
						<section>
							<h3>各ラウンド</h3>
							<p>相談60秒 → 秘密選択30秒 → 結果発表20秒</p>
						</section>
						<section>
							<h3>秘密の選択</h3>
							<ul>
								<li>抜け穴を維持する</li>
								<li>脱出を試みる</li>
							</ul>
							<p>選択は結果発表まで、ほかの参加者には見えません。</p>
						</section>
						<section>
							<h3>結果</h3>
							<p>維持に必要な人数は、3人なら2人、4人なら3人、5人なら4人、6人なら4人です。</p>
							<ul>
								<li>全員が維持：維持した人に+20pt</li>
								<li>脱出する人がいて必要人数を維持：維持した人に+10pt、脱出を試みた人に+100pt</li>
								<li>維持人数が不足：維持した人は0pt、脱出を試みた人は死亡</li>
							</ul>
						</section>
						<p class="rift-rules-note">綻びで脱出に成功しても通常の1000pt clearにはならず、+100ptを得てハコへ戻ります。</p>
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
	.rift-rules-note { color: #6f326f; font-weight: 700; }
	.rift-warning { display: grid; gap: 8px; padding: 14px; border: 1px solid #c46b75; border-radius: 10px; background: #fff0f1; color: #6f2430; line-height: 1.5; }
	.rift-dialog-actions { display: grid; gap: 9px; }
	.rift-dialog-actions button { min-height: 44px; padding: 9px 12px; border-radius: 9px; font: inherit; font-weight: 800; cursor: pointer; }
	.rift-primary-action { border: 1px solid #8d4692; background: #8d4692; color: white; }
	.rift-secondary-action { border: 1px solid rgba(102, 28, 106, .3); background: white; color: #4d3150; }
	:global(.rift-rules-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
</style>
