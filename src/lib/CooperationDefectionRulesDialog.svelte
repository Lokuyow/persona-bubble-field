<script lang="ts">
	import ActionButton from '$lib/ActionButton.svelte';
	type Props = Readonly<{
		open: boolean;
		mode: 'rules' | 'join-confirmation';
		registrationDeadline: string | null;
		registrationCountdown: string | null;
		onOpenChange: (open: boolean) => void;
		onJoin: () => void;
		onViewRules: () => void;
		onCancel: () => void;
	}>;

	let { open, mode, registrationDeadline, registrationCountdown, onOpenChange, onJoin, onViewRules, onCancel }: Props = $props();
	let isConfirmation = $derived(mode === 'join-confirmation');
</script>

	{#if open}
		<div class="cooperation-defection-rules-overlay" role="presentation">
			<div class="cooperation-defection-rules-content" role="dialog" aria-modal="true" aria-labelledby="cooperation-defection-rules-title" tabindex="-1">
				<h2 id="cooperation-defection-rules-title">{isConfirmation ? '協力と抜け駆けに参加しますか？' : '協力と抜け駆けのルール'}</h2>
				<p class="cooperation-defection-rules-description">
					{isConfirmation ? '参加する前に、次のことを確認してください。' : '1グループ3〜6人、全3ラウンドです。'}
				</p>

				{#if isConfirmation}
					{#if registrationDeadline && registrationCountdown}
						<p class="cooperation-defection-registration-deadline" data-cooperation-defection-registration-deadline>受付締切: {registrationDeadline}</p>
						<p class="cooperation-defection-registration-countdown" data-cooperation-defection-registration-countdown>残り時間: {registrationCountdown}</p>
					{/if}
					<div class="cooperation-defection-warning" role="alert">
						<strong>3〜6人 / 全3ラウンド</strong>
						<span>協力人数が不足すると、抜け駆けした参加者は寿命を3日失います。残り寿命によっては死亡します。</span>
					</div>
					<div class="cooperation-defection-dialog-actions">
						<ActionButton variant="primary" type="button" onclick={onJoin}>参加する</ActionButton>
						<ActionButton variant="secondary" type="button" onclick={onViewRules}>ルールを見る</ActionButton>
						<ActionButton variant="tertiary" intent="cancel" type="button" onclick={onCancel}>キャンセル</ActionButton>
					</div>
				{:else}
					<div class="cooperation-defection-rules-body">
						<section>
							<h3>1ラウンドの流れ</h3>
							<p>相談 30秒 → 選択 30秒 → 結果発表 20秒</p>
							<p>相談のあと、全員がどちらかを選びます。</p>
						</section>
						<section>
							<h3>選択肢</h3>
							<ul>
								<li><strong>協力する</strong></li>
								<li><strong>抜け駆けする</strong></li>
							</ul>
							<p>誰が何を選んだかは、結果発表まで分かりません。</p>
						</section>
						<section>
							<h3>必要な協力人数</h3>
							<ul>
								<li>3人 → <strong>2人</strong></li>
								<li>4人 → <strong>3人</strong></li>
								<li>5人 → <strong>4人</strong></li>
								<li>6人 → <strong>4人</strong></li>
							</ul>
						</section>
						<section data-cooperation-defection-rule-results>
							<h3>結果</h3>
							<ul>
								<li>協力成功：全員が協力 → <strong>全員 +1,000pt</strong></li>
								<li>抜け駆け発生：一部が抜け駆けし、必要な協力人数を達成 → <strong>協力 +100pt / 抜け駆け +10,000pt</strong></li>
								<li>失敗：必要な協力人数に達しない → <strong>協力 0pt / 抜け駆け 寿命 −3日</strong></li>
								<li>不成立：有効選択が3人未満</li>
							</ul>
						</section>
					</div>
					<div class="cooperation-defection-dialog-actions">
						<ActionButton variant="tertiary" type="button" onclick={() => onOpenChange(false)}>閉じる</ActionButton>
					</div>
				{/if}
			</div>
		</div>
	{/if}

<style>
	:global(.cooperation-defection-rules-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(20, 9, 24, .68); backdrop-filter: blur(2px); }
	:global(.cooperation-defection-rules-content) { position: fixed; top: 50%; left: 50%; z-index: 101; display: grid; gap: 14px; width: min(calc(100vw - 28px), 560px); max-height: calc(100svh - 28px); overflow: auto; padding: clamp(18px, 4vw, 28px); border: 1px solid rgba(141, 70, 146, .55); border-radius: 16px; background: #fffaff; color: #3d3144; box-shadow: 0 16px 45px rgba(45, 20, 48, .28); transform: translate(-50%, -50%); }
	:global(.cooperation-defection-rules-content h2) { margin: 0; font-size: clamp(1.3rem, 5vw, 1.8rem); }
	.cooperation-defection-rules-description { margin: 0; color: #665b69; line-height: 1.5; }
	.cooperation-defection-rules-body { display: grid; gap: 12px; line-height: 1.55; }
	.cooperation-defection-rules-body p, .cooperation-defection-rules-body ul { margin: 0; }
	.cooperation-defection-rules-body section { display: grid; gap: 3px; padding-top: 10px; border-top: 1px solid rgba(102, 28, 106, .15); }
	.cooperation-defection-rules-body h3 { margin: 0; font-size: 1rem; }
	.cooperation-defection-rules-body ul { padding-left: 1.2rem; }
	.cooperation-defection-warning { display: grid; gap: 8px; padding: 14px; border: 1px solid #c46b75; border-radius: 10px; background: #fff0f1; color: #6f2430; line-height: 1.5; }
	.cooperation-defection-dialog-actions { display: grid; gap: 9px; }
	.cooperation-defection-dialog-actions :global(.action-button) { width: 100%; min-height: 44px; }
	:global(.cooperation-defection-rules-content button:focus-visible) { outline: 3px solid var(--color-focus-ring); outline-offset: 3px; }
	@media (min-width: 701px) {
		:global(.cooperation-defection-rules-content) { font-size: 16px; }
		:global(.cooperation-defection-rules-content h2) { font-size: 2rem; }
		.cooperation-defection-rules-body h3 { font-size: 1.1rem; }
		:global(.cooperation-defection-dialog-actions button) { font-size: 1rem; }
	}
</style>
