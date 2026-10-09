<script lang="ts">
	import { asset } from '$app/paths';
	import { Dialog } from 'bits-ui';
	import { tick } from 'svelte';
	import ActionButton from '$lib/ActionButton.svelte';
	import TagGameEffectSymbol from '$lib/TagGameEffectSymbol.svelte';
	import ArrowLeft from '~icons/tabler/arrow-left';
	import Award from '~icons/tabler/award';
	import Brain from '~icons/tabler/brain';
	import BookmarkPlus from '~icons/tabler/bookmark-plus';
	import ChevronRight from '~icons/tabler/chevron-right';
	import DoorExit from '~icons/tabler/door-exit';
	import Heart from '~icons/tabler/heart';
	import HeartPlus from '~icons/tabler/heart-plus';
	import IconMessage from '~icons/tabler/message';
	import Key from '~icons/tabler/key';
	import Map from '~icons/tabler/map';
	import PlayerPause from '~icons/tabler/player-pause';
	import Run from '~icons/tabler/run';
	import ShieldCheck from '~icons/tabler/shield-check';
	import Stack2 from '~icons/tabler/stack-2';
	import Tool from '~icons/tabler/tool';
	import Wallet from '~icons/tabler/wallet';
	import X from '~icons/tabler/x';
	import SpeechMonologue from '~icons/hako/speech-monologue';
	import SpeechNormal from '~icons/hako/speech-normal';
	import SpeechShout from '~icons/hako/speech-shout';
	import LayoutSidebarLeftExpand from '~icons/tabler/layout-sidebar-left-expand';

	const TRACE_ICON_ASSET = asset('/trace/trace-icon.svg');
	const TRACE_DEATH_ICON_ASSET = asset('/trace/trace-death-icon.svg');

	type CategoryId = 'start' | 'living' | 'conversation' | 'traces' | 'events' | 'life' | 'nostr';
	type HelpPage = { kind: 'home' } | { kind: 'category'; id: CategoryId } | { kind: 'events' } | { kind: 'event'; id: 'cooperation' | 'tag-game' };
	type Props = Readonly<{
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onCloseAutoFocus: (event: Event) => void;
	}>;

	let { open, onOpenChange, onCloseAutoFocus }: Props = $props();
	let page = $state<HelpPage>({ kind: 'home' });
	let scrollBody = $state<HTMLElement | null>(null);
	let homeScrollTop = 0;
	let eventsScrollTop = 0;

	const categories: ReadonlyArray<{ id: CategoryId; title: string; summary: string }> = [
		{ id: 'start', title: 'はじめに', summary: '寿命・ポイント・基本的な遊び方' },
		{ id: 'living', title: '暮らす', summary: '移動・作業・能力・画面上の表示' },
		{ id: 'conversation', title: '会話する', summary: '発言・返信・Chatter' },
		{ id: 'traces', title: '痕跡', summary: '発言の痕跡・書置き・遺言' },
		{ id: 'events', title: 'イベント', summary: '協力と抜け駆け・鬼ごっこ' },
		{ id: 'life', title: '一生と脱出', summary: '死亡・転生・脱出・Root Point' },
		{ id: 'nostr', title: 'Nostr・その他', summary: 'Nostr・秘密鍵・データ・よくある質問' }
	];
	const categoryTitles: Readonly<Record<CategoryId, string>> = {
		start: 'はじめに', living: '暮らす', conversation: '会話する', traces: '痕跡', events: 'イベント', life: '一生と脱出', nostr: 'Nostr・その他'
	};
	const eventTitles = { cooperation: '協力と抜け駆け', 'tag-game': '鬼ごっこ' } as const;
	const currentTitle = $derived(page.kind === 'home' ? 'ヘルプ' : page.kind === 'category' ? categoryTitles[page.id] : page.kind === 'events' ? 'イベント' : eventTitles[page.id]);
	const isDetail = $derived(page.kind !== 'home');

	$effect(() => {
		if (open) return;
		page = { kind: 'home' };
		homeScrollTop = 0;
		eventsScrollTop = 0;
		if (scrollBody) scrollBody.scrollTop = 0;
	});

	async function show(next: HelpPage): Promise<void> {
		if (scrollBody) {
			if (page.kind === 'home') homeScrollTop = scrollBody.scrollTop;
			if (page.kind === 'events') eventsScrollTop = scrollBody.scrollTop;
		}
		page = next;
		await tick();
		if (scrollBody) scrollBody.scrollTop = next.kind === 'home' ? homeScrollTop : next.kind === 'events' ? eventsScrollTop : 0;
	}

	function back(): void {
		if (page.kind === 'category') void show({ kind: 'home' });
		else if (page.kind === 'event') void show({ kind: 'events' });
		else if (page.kind === 'events') void show({ kind: 'home' });
	}
</script>

<Dialog.Root bind:open={() => open, onOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay class="help-dialog-overlay" />
		<Dialog.Content class="help-dialog-content" preventScroll={false} onCloseAutoFocus={onCloseAutoFocus} data-help-dialog>
			<header class="help-header">
				{#if isDetail}
					<ActionButton variant="tertiary" class="help-back" type="button" aria-label="戻る" onclick={back}><ArrowLeft aria-hidden="true" /><span>戻る</span></ActionButton>
				{:else}<span class="help-back-spacer" aria-hidden="true"></span>{/if}
				<Dialog.Title class="help-title">{currentTitle}</Dialog.Title>
				<Dialog.Description class="sr-only help-description">ハコ過去の遊び方を確認できます。閲覧中もゲームの時間は進みます。</Dialog.Description>
				<Dialog.Close class="action-button action-button-tertiary action-button-close help-close" aria-label="閉じる"><X aria-hidden="true" /></Dialog.Close>
			</header>
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="help-body" bind:this={scrollBody} role="region" aria-label={currentTitle} tabindex="0" data-help-page={page.kind}>
				{#if page.kind === 'home'}
					<section class="welcome-card">
						<h2>ハコで生きる</h2>
						<p>あなたの一生は、<strong>7日の寿命</strong>から始まります。</p>
						<p>作業をして寿命を延ばしたり、ポイントを集めたり、ほかの住人と話したりできます。</p>
						<p class="warning-line"><Heart aria-hidden="true" /><strong>寿命が0になると、その一生は終わります。</strong></p>
						<p><strong>100,000pt以上</strong>を所持すると、脱出条件のひとつを満たします。</p>
						<p>何をするかは自由です。</p>
					</section>
					<section class="summary-grid" aria-label="ゲームの概要">
						<div class="summary-card"><Heart aria-hidden="true" /><strong>寿命</strong><span>時間とともに減ります。作業などで延ばせます。</span></div>
						<div class="summary-card"><Wallet aria-hidden="true" /><strong>ポイント</strong><span>作業・会話・痕跡・イベントなどで獲得します。</span></div>
						<div class="summary-card"><Tool aria-hidden="true" /><strong>作業</strong><span>ポイントを得ながら寿命を延ばせます。</span></div>
						<div class="summary-card"><Run aria-hidden="true" /><strong>イベント</strong><span>ほかの住人とリアルタイムで遊べます。</span></div>
					</section>
					<nav class="category-list" aria-label="ヘルプカテゴリ">
						{#each categories as category (category.id)}
							<button class="category-card" type="button" data-help-category={category.id} onclick={() => void show(category.id === 'events' ? { kind: 'events' } : { kind: 'category', id: category.id })}>
								<span class="category-icon" aria-hidden="true">
									{#if category.id === 'start'}<Heart />{:else if category.id === 'living'}<Map />{:else if category.id === 'conversation'}<IconMessage />{:else if category.id === 'traces'}<span class="help-trace-icon" style={`--help-trace-image: url("${TRACE_ICON_ASSET}")`}></span>{:else if category.id === 'events'}<Run />{:else if category.id === 'life'}<DoorExit />{:else}<Key />{/if}
								</span>
								<span class="category-copy"><strong>{category.title}</strong><span>{category.summary}</span></span>
								<ChevronRight class="category-chevron" aria-hidden="true" />
							</button>
						{/each}
					</nav>
				{:else if page.kind === 'category' && page.id === 'start'}
					<section class="help-section" aria-labelledby="help-start-title">
						<h2 id="help-start-title"><Heart aria-hidden="true" />ハコ過去とは</h2>
						<p>あなたは、与えられた人格のひとりとしてハコで一生を過ごします。</p>
						<p>ほかの住人と話す、作業する、痕跡を調べる、イベントに参加する。何をするかは自由です。</p>
						<p>一生には寿命があります。十分なポイントを集めると、ハコから「脱出」することもできます。</p>
						<div class="help-fact"><Heart aria-hidden="true" /><div><h3>寿命</h3><p>新しい一生は<strong>7日の寿命</strong>から始まります。寿命は現実の時間とともに減り、0になるとその一生は終わります。作業などによって延ばすことができます。</p></div></div>
						<div class="help-fact"><Wallet aria-hidden="true" /><div><h3>ポイント</h3><p>作業、会話、痕跡、イベントなどで獲得できます。能力強化などに使えますが、<strong>100,000pt以上を所持することは脱出条件のひとつ</strong>でもあります。使って強くなるか、脱出のために貯めるかは自由です。</p></div></div>
					</section>
				{:else if page.kind === 'category' && page.id === 'living'}
					<section class="help-section" aria-labelledby="help-living-title">
						<h2 id="help-living-title"><Map aria-hidden="true" />暮らす</h2>
						<div class="help-fact"><Map aria-hidden="true" /><div><h3>移動</h3><p>フィールド内を自由に移動できます。住人、端末、痕跡などへ近づくことで利用できる操作があります。</p></div></div>
						<div class="help-fact"><Tool aria-hidden="true" /><div><h3>作業</h3><p>作業端末から作業を始められます。作業すると、ポイントを獲得しながら寿命を延ばせます。一度作業を始めれば、移動したり会話したりしている間も進みます。</p><div class="icon-labels"><span><Tool aria-hidden="true" />作業中</span><span><HeartPlus aria-hidden="true" />延命中</span><span><PlayerPause aria-hidden="true" />作業停止中</span></div></div></div>
						<div class="help-fact"><Brain aria-hidden="true" /><div><h3>能力</h3><p>ポイントを使って、現在の一生の能力を強化できます。能力強化に使ったポイントは所持ポイントから減ります。</p><ul class="icon-list"><li><Brain aria-hidden="true" /><span><strong>推論効率</strong> — 作業で得るポイントに関係します。</span></li><li><Stack2 aria-hidden="true" /><span><strong>コンテキスト容量</strong> — 成果を回収せずに連続して作業できる時間の上限が増えます。</span></li><li><ShieldCheck aria-hidden="true" /><span><strong>ハルシネーション抑制</strong> — 作業による寿命延長に関係します。</span></li></ul></div></div>
						<div class="help-fact"><Heart aria-hidden="true" /><div><h3>画面上の表示</h3><p>残り寿命、所持ポイント、作業状態を確認できます。ポイントゲージは100,000ptをひとつの基準として表示します。</p></div></div>
					</section>
				{:else if page.kind === 'category' && page.id === 'conversation'}
					<section class="help-section" aria-labelledby="help-conversation-title">
						<h2 id="help-conversation-title"><SpeechNormal aria-hidden="true" />会話する</h2>
						<div class="help-fact"><SpeechNormal aria-hidden="true" /><div><h3>発言</h3><p>通常、叫び、モノローグの3種類があります。見た目は異なりますが、発言タイプによって到達範囲そのものは変わりません。</p><div class="icon-labels"><span><SpeechNormal aria-hidden="true" />通常</span><span><SpeechShout aria-hidden="true" />叫び</span><span><SpeechMonologue aria-hidden="true" />モノローグ</span></div></div></div>
						<div class="help-fact"><Wallet aria-hidden="true" /><div><h3>返信</h3><p>他者への有効な返信投稿が成功すると<strong>10pt</strong>、自分宛ての有効な未読返信を実際に読むと<strong>10pt</strong>を獲得します。</p></div></div>
						<div class="help-fact"><LayoutSidebarLeftExpand aria-hidden="true" /><div><h3>Chatter</h3><p>最近の発言を最大50件まで扱い、そのうち画面内に完全に収まる新しい発言だけを表示します。すべての発言が永久に残るSNSの投稿一覧や、完全な過去ログではありません。</p></div></div>
					</section>
				{:else if page.kind === 'category' && page.id === 'traces'}
					<section class="help-section" aria-labelledby="help-traces-title">
						<h2 id="help-traces-title"><span class="help-trace-icon" aria-hidden="true" style={`--help-trace-image: url("${TRACE_ICON_ASSET}")`}></span>痕跡</h2>
						<div class="help-fact"><span class="help-trace-icon" aria-hidden="true" style={`--help-trace-image: url("${TRACE_ICON_ASSET}")`}></span><div><h3>発言の痕跡</h3><p>通常発言の一部は、発言された場所に痕跡として残ります。過去ログではなく、その場所に残った会話の記憶です。近くまで移動すると調べられます。他者の未読の痕跡（会話の最初の発言）を初めて読むと<strong>5pt</strong>を獲得します。</p></div></div>
						<div class="help-fact"><BookmarkPlus aria-hidden="true" /><div><h3>書置き</h3><p><strong>100pt</strong>を使って現在位置へ意図的に痕跡を残せます。通常・叫び・モノローグを利用できます。</p></div></div>
						<div class="help-fact"><span class="help-trace-icon" aria-hidden="true" style={`--help-trace-image: url("${TRACE_DEATH_ICON_ASSET}")`}></span><div><h3>遺言</h3><p>一生が終わる際に任意で残せます。最後にいた場所へ痕跡として残ります。空のまま残さない選択もできます。</p></div></div>
					</section>
				{:else if page.kind === 'events'}
					<section class="help-section" aria-labelledby="help-events-title">
						<h2 id="help-events-title"><Run aria-hidden="true" />イベント</h2>
						<p>ほかの住人とリアルタイムで遊べるイベントです。カードを選ぶとルールを確認できます。</p>
						<button class="event-card" type="button" data-help-event="cooperation" onclick={() => void show({ kind: 'event', id: 'cooperation' })}><span class="event-icon" aria-hidden="true"><Award /></span><span><strong>協力と抜け駆け</strong><small>相談して協力するか、抜け駆けするかを選ぶゲーム</small></span><ChevronRight aria-hidden="true" /></button>
						<button class="event-card" type="button" data-help-event="tag-game" onclick={() => void show({ kind: 'event', id: 'tag-game' })}><span class="event-icon" aria-hidden="true"><Run /></span><span><strong>鬼ごっこ</strong><small>福を奪い、鬼を押し付けるタッチゲーム</small></span><ChevronRight aria-hidden="true" /></button>
					</section>
				{:else if page.kind === 'event' && page.id === 'cooperation'}
					<section class="help-section" aria-labelledby="help-cooperation-title">
						<h2 id="help-cooperation-title"><Award aria-hidden="true" />協力と抜け駆け</h2>
						<p class="event-lead">みんなで協力すれば安全。抜け駆けすれば大きな報酬。ただし、抜け駆けが多すぎると失敗します。</p>
						<p><strong>3〜6人・全3ラウンド</strong></p><p>1ラウンドは<strong>相談 30秒 → 選択 30秒 → 結果発表 20秒</strong>。選択は結果発表まで秘密です。</p>
						<h3>成功に必要な協力人数</h3><div class="table-scroll"><table><thead><tr><th>参加人数</th><th>必要な協力</th></tr></thead><tbody><tr><td>3人</td><td>2人</td></tr><tr><td>4人</td><td>3人</td></tr><tr><td>5人</td><td>4人</td></tr><tr><td>6人</td><td>4人</td></tr></tbody></table></div>
						<h3>結果</h3><div class="table-scroll"><table><thead><tr><th>結果</th><th>協力した人</th><th>抜け駆けした人</th></tr></thead><tbody><tr><td>全員協力</td><td>+1,000pt</td><td>—</td></tr><tr><td>抜け駆けあり・成功</td><td>+100pt</td><td>+10,000pt</td></tr><tr><td>協力不足・失敗</td><td>0pt</td><td>寿命 −3日</td></tr></tbody></table></div>
						<p>3人未満では開催されません。</p><div class="help-fact schedule-fact"><Run aria-hidden="true" /><div><h3>通常開催</h3><p><strong>20:55 JST</strong> 参加受付<br /><strong>21:00 JST</strong> 開始</p></div></div>
					</section>
				{:else if page.kind === 'event' && page.id === 'tag-game'}
					<section class="help-section" aria-labelledby="help-tag-game-title">
						<h2 id="help-tag-game-title"><Run aria-hidden="true" />鬼ごっこ</h2>
						<p><strong>2〜8人・2分</strong></p><p class="event-lead">福の間は奪い合い、鬼の間は押し付け合います。</p>
						<div class="mortality-warning" role="note"><span class="warning-mark" aria-hidden="true">!</span><div><strong>注意：鬼になった者は、毎秒1時間の寿命を失います。</strong><p>寿命が0になると、その一生は終了します。</p></div></div>
						<div class="help-fact"><svg class="tag-game-rule-symbol" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><TagGameEffectSymbol effect="benefit" presentation="rule" /></svg><div><h3>福</h3><p><strong>+50pt / 秒</strong>。福を持っていない参加者は、福を持っている参加者へタッチして福を奪えます。</p></div></div>
						<div class="help-fact"><svg class="tag-game-rule-symbol" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><TagGameEffectSymbol effect="calamity" presentation="rule" /></svg><div><h3>鬼</h3><p><strong>寿命 −1時間 / 秒</strong>。ほかの参加者へタッチして鬼を押し付けられます。</p></div></div>
						<div class="help-fact"><Map aria-hidden="true" /><div><h3>タッチと切り替え</h3><p>隣接している参加者だけにタッチできます。福と鬼はゲーム中に交互に切り替わります。</p></div></div>
					</section>
				{:else if page.kind === 'category' && page.id === 'life'}
					<section class="help-section" aria-labelledby="help-life-title">
						<h2 id="help-life-title"><DoorExit aria-hidden="true" />一生と脱出</h2>
						<div class="help-fact"><Heart aria-hidden="true" /><div><h3>一生が終わると</h3><p>寿命が0になると現在の一生は終了します。寿命が尽きたときは、現在の人格、所持ポイント、能力強化、その人格に結びついた状態を失います。その後、3人の候補から転生先を選びます。新しい一生は寿命7日、ポイント0、能力初期状態から始まります。</p></div></div>
						<div class="help-fact"><DoorExit aria-hidden="true" /><div><h3>脱出</h3><p><strong>100,000pt以上を現在所持していること</strong>は条件のひとつです。一度到達しただけでは条件を永久に満たしません。能力強化などで100,000pt未満になれば条件を満たさなくなります。リアルタイムイベントの結果確定中など、ほかの条件で一時的に脱出できない場合があります。</p></div></div>
						<div class="help-fact"><Award aria-hidden="true" /><div><h3>脱出すると</h3><p>正常な脱出1回につきRoot Pointを1RP獲得し、その人格のnsecを取り出せるようになります。脱出済みの人格は同じ人格で新しい一生を始められます。</p></div></div>
						<div class="help-fact"><Award aria-hidden="true" /><div><h3>Root PointとRoot build</h3><p>Root Pointは一生を越えて保持され、死亡しても失いません。新しい一生の開始前にRoot buildへ割り振ります。現在の一生の途中では変更できず、使用できるRoot Pointは最大9RPです。</p><ul class="icon-list"><li><Brain aria-hidden="true" /><span><strong>推論加速</strong> — 作業のポイント生成に関係します。</span></li><li><Stack2 aria-hidden="true" /><span><strong>コンテキスト圧縮</strong> — 回収せずに作業できる時間の上限を広げます。</span></li><li><ShieldCheck aria-hidden="true" /><span><strong>ハルシネーション耐性</strong> — 作業で延ばせる最大寿命に関係します。</span></li></ul></div></div>
					</section>
				{:else if page.kind === 'category' && page.id === 'nostr'}
					<section class="help-section" aria-labelledby="help-nostr-title">
						<h2 id="help-nostr-title"><Key aria-hidden="true" />Nostr・その他</h2>
						<div class="help-fact"><Key aria-hidden="true" /><div><h3>Nostrとは？</h3><p>ハコ過去は通信にNostrを利用しています。普通に遊び始めるためにNostrの専門知識は必要ありません。脱出後、その人格を一般的なNostrクライアントへ持ち出せます。</p></div></div>
						<div class="help-fact"><Key aria-hidden="true" /><div><h3>nsec</h3><p>nsecはその人格を操作するための秘密鍵です。<strong class="danger-text">他人には教えないでください。</strong>脱出前は、現在の人格のnsecを取り出す機能はありません。</p></div></div>
						<div class="help-fact"><Heart aria-hidden="true" /><div><h3>データについて</h3><p>ブラウザに保存された重要なデータを失うと、そこから作られた人格を失う可能性があります。サーバー側にバックアップはありません。</p></div></div>
						<h3 class="faq-title">よくある質問</h3>
						<div class="faq-list">
							<details><summary>100,000ptになったのに脱出できません<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>100,000ptは条件のひとつです。リアルタイムイベントの結果確定中など、ほかの条件によって一時的に脱出できない場合があります。</p></details>
							<details><summary>能力を強化したら100,000ptを下回りました<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>能力強化には現在所持ポイントを使います。再び100,000pt以上を所持すればポイント条件を満たします。</p></details>
							<details><summary>鬼ごっこで寿命が0になったら？<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>その一生は終了します。</p></details>
							<details><summary>発言が残りません<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>通常発言は一時的で、一部だけが痕跡になります。確実に残したい場合は100ptの書置きを使ってください。</p></details>
							<details><summary>痕跡を調べられません<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>調査可能な距離まで近づく必要があります。</p></details>
							<details><summary>Chatterから昔の発言を全部読めますか？<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>できません。最近の会話を把握するための補助機能で、完全な過去ログではありません。</p></details>
							<details><summary>死亡するとRoot Pointも失いますか？<ChevronRight class="faq-chevron" aria-hidden="true" /></summary><p>失いません。</p></details>
						</div>
					</section>
				{/if}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.help-dialog-overlay) { position: fixed; inset: 0; z-index: 100; background: rgba(4, 7, 18, .72); backdrop-filter: blur(2px); }
	:global(.help-dialog-content) { position: fixed; inset: 50% auto auto 50%; z-index: 101; display: grid; grid-template-rows: auto minmax(0, 1fr); width: min(780px, calc(100vw - 28px)); height: min(820px, calc(100dvh - 32px)); overflow: hidden; padding: 0; border: 1px solid rgba(122, 135, 255, .74); border-radius: 18px; background: linear-gradient(180deg, rgba(12, 18, 46, .99), rgba(8, 12, 33, .99)); box-shadow: 0 20px 80px rgba(0, 0, 0, .48), 0 0 34px rgba(90, 103, 255, .13); color: #f4f6ff; transform: translate(-50%, -50%); }
	.help-header { position: relative; z-index: 2; display: grid; grid-template-columns: minmax(64px, 1fr) minmax(0, 2fr) minmax(64px, 1fr); align-items: center; gap: 8px; min-height: 68px; padding: 10px 18px; border-bottom: 1px solid rgba(218, 224, 255, .15); background: #0c122e; }
	:global(.help-title) { grid-column: 2; grid-row: 1; margin: 0; color: #f4f6ff; font-size: 1.18rem; font-weight: 800; text-align: center; }
	:global(.help-back) { grid-column: 1; grid-row: 1; justify-self: start; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 8px; color: #e5e9ff; }
	:global(.help-back svg) { width: 20px; height: 20px; }
	.help-back-spacer { grid-column: 1; grid-row: 1; min-width: 44px; }
	:global(.help-description) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
	:global(.help-close) { grid-column: 3; grid-row: 1; justify-self: end; }
	.help-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 22px 26px 30px; scrollbar-gutter: stable; }
	.welcome-card { padding: 18px 20px; border: 1px solid rgba(122, 135, 255, .36); border-radius: 14px; background: rgba(122, 135, 255, .08); }
	.welcome-card h2 { margin: 0 0 12px; font-size: 1.35rem; }
	.welcome-card p { margin: 8px 0; line-height: 1.65; }
	.warning-line { display: flex; align-items: center; gap: 8px; color: #ffd49a; }
	.warning-line :global(svg) { flex: 0 0 20px; width: 20px; height: 20px; }
	.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 14px 0 20px; }
	.summary-card { display: grid; justify-items: start; align-content: start; gap: 7px; min-height: 112px; padding: 12px; border: 1px solid rgba(218, 224, 255, .16); border-radius: 12px; background: rgba(255,255,255,.045); }
	.summary-card :global(svg) { width: 22px; height: 22px; color: #aeb6ff; }
	.summary-card span { color: #c9cde0; font-size: .82rem; line-height: 1.45; }
	.category-list { display: grid; gap: 8px; }
	.category-card, .event-card { display: grid; grid-template-columns: 42px minmax(0, 1fr) 22px; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 9px 12px; border: 1px solid rgba(218, 224, 255, .17); border-radius: 12px; background: rgba(255,255,255,.045); color: inherit; text-align: left; cursor: pointer; }
	.category-card:hover, .event-card:hover { border-color: rgba(174, 182, 255, .62); background: rgba(122, 135, 255, .11); }
	.category-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: rgba(122, 135, 255, .13); color: #c3caff; }
	.category-icon :global(svg), .category-icon .help-trace-icon { width: 24px; height: 24px; }
	.category-copy { display: grid; gap: 3px; min-width: 0; }
	.category-copy strong { font-size: .98rem; }
	.category-copy span, .event-card small { color: #c9cde0; font-size: .83rem; line-height: 1.4; }
	:global(.category-chevron) { width: 20px; height: 20px; color: #aeb6ff; }
	.help-section { display: grid; align-content: start; gap: 14px; }
	.help-section > h2 { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 1.35rem; }
	.help-section > h2 :global(svg), .help-section > h2 .help-trace-icon { flex: 0 0 25px; width: 25px; height: 25px; color: #aeb6ff; }
	.help-section > p, .help-fact p { margin: 0; color: #e4e6f2; line-height: 1.7; }
	.help-section h3 { margin: 0 0 5px; font-size: 1rem; }
	.help-fact { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: start; gap: 12px; padding: 14px; border: 1px solid rgba(218, 224, 255, .15); border-radius: 12px; background: rgba(255,255,255,.04); }
	.help-fact > :global(svg), .help-fact > .help-trace-icon { width: 24px; height: 24px; color: #aeb6ff; }
	.help-fact > .tag-game-rule-symbol { display: block; overflow: visible; }
	.help-trace-icon { display: block; background-color: currentColor; -webkit-mask: var(--help-trace-image) center / contain no-repeat; mask: var(--help-trace-image) center / contain no-repeat; }
	.help-fact > div { min-width: 0; }
	.icon-labels { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
	.icon-labels span { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 8px; background: rgba(122, 135, 255, .1); font-size: .85rem; }
	.icon-labels :global(svg) { width: 18px; height: 18px; color: #c3caff; }
	.icon-list { display: grid; gap: 9px; margin: 12px 0 0; padding: 0; list-style: none; }
	.icon-list li { display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: start; gap: 8px; line-height: 1.55; }
	.icon-list :global(svg) { width: 20px; height: 20px; color: #aeb6ff; }
	.event-card { grid-template-columns: 42px minmax(0, 1fr) 22px; min-height: 72px; }
	.event-card > span:nth-child(2) { display: grid; gap: 4px; }
	.event-icon { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: rgba(122, 135, 255, .13); color: #c3caff; }
	.event-icon :global(svg) { width: 24px; height: 24px; }
	.event-lead { padding: 12px 14px; border-left: 3px solid #aeb6ff; border-radius: 4px; background: rgba(122, 135, 255, .1); font-weight: 700; }
	.table-scroll { overflow-x: auto; }
	table { width: 100%; border-collapse: collapse; font-size: .92rem; }
	th, td { padding: 9px 10px; border: 1px solid rgba(218, 224, 255, .2); text-align: left; }
	th { background: rgba(122, 135, 255, .12); }
	.schedule-fact { margin-top: 0; }
	.mortality-warning { display: grid; grid-template-columns: 32px minmax(0,1fr); align-items: start; gap: 10px; padding: 14px; border: 2px solid #ff9b63; border-radius: 12px; background: rgba(133, 49, 27, .38); color: #fff1e8; line-height: 1.6; }
	.mortality-warning p { margin: 6px 0 0; }
	.warning-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #ff9b63; color: #32160d; font-size: 1.2rem; font-weight: 900; }
	.danger-text { display: block; margin-top: 5px; color: #ffba9b; }
	.faq-title { margin: 6px 0 0 !important; font-size: 1.12rem !important; }
	.faq-list { display: grid; gap: 8px; }
	.faq-list details { border: 1px solid rgba(218, 224, 255, .17); border-radius: 10px; background: rgba(255,255,255,.04); }
	.faq-list summary { position: relative; min-height: 48px; padding: 13px 42px 13px 14px; font-weight: 750; line-height: 1.45; cursor: pointer; list-style: none; }
	.faq-list summary::-webkit-details-marker { display: none; }
	:global(.faq-chevron) { position: absolute; top: 50%; right: 14px; width: 18px; height: 18px; color: #aeb6ff; transform: translateY(-50%) rotate(90deg); transition: transform 140ms ease; }
	:global(.faq-list details[open] .faq-chevron) { transform: translateY(-50%) rotate(-90deg); }
	.faq-list details p { margin: 0; padding: 0 14px 14px; color: #d6d9e8; line-height: 1.6; }
	@media (max-width: 600px) {
		:global(.help-dialog-content) { inset: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right)) max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left)); width: auto; height: auto; max-height: none; border-radius: 14px; transform: none; }
		.help-header { grid-template-columns: minmax(72px, 1fr) minmax(0, 1.3fr) 44px; gap: 4px; min-height: 60px; padding: 7px 9px; }
		:global(.help-title) { font-size: 1rem; }
		:global(.help-back) { gap: 1px; padding: 0 2px; font-size: .88rem; }
		:global(.help-back svg) { width: 18px; height: 18px; }
		.help-body { padding: 14px 12px 22px; }
		.welcome-card { padding: 15px; }
		.summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
		.summary-card { min-height: 96px; padding: 10px; }
		.category-card, .event-card { grid-template-columns: 38px minmax(0, 1fr) 18px; gap: 8px; padding-inline: 9px; }
		.category-icon, .event-icon { width: 36px; height: 36px; }
		.category-copy span, .event-card small { font-size: .78rem; }
	}
	@media (prefers-reduced-motion: reduce) { :global(.faq-chevron) { transition: none; } }
</style>
