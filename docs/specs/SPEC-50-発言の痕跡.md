# 発言の痕跡仕様

> この文書は本プロジェクトの確定仕様の一部である。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 24. 発言の痕跡

通常の発言は揮発し、Twitter型の過去ログとして時系列に蓄積表示しない。そのうえで、過去の対象kind 42の一部だけを、元の発言位置に残る**発言の痕跡**として扱う。痕跡は過去ログや履歴ビューではなく、空間に残った一部の発言の記憶である。投稿日時、経過時間、「さっき」「今日」「数日前」等の古さはroot/replyのいずれにも表示しない。

### rootの選択と上限

trace root候補は、有効なtop-level kind 42だけとする。normal / shout / monologueを同率で対象にし、merged bubbleは表示上の集約にすぎないため、抽選は元event単位で行う。

```ts
BigInt(`0x${event.id}`) % 5n === 0n
```

上の決定的20%抽選にsparse-world boost、密度補正、時間expiryは設けない。1 cellあたりのrootは最大3件、global root上限は `floor(total logical cell count / 10)` とする。上限はrootだけを数え、kind 1111 replyは数えない。上限超過時は古いrootから落とし、同時刻は既存の決定的orderingに従う。

### root cache

browserが取得したeffective rootはbrowser-localに永続保持する。latest bootstrap範囲から外れてもroot evictionまで保持し、browserごとに保持する古いtrace集合が異なってよい。root evictionでは、root、root read state、reply tree、reply read/unread state、reply notificationを完全に忘れる。

### reply cache

reply cacheは、全root合計で最大1000件のkind 1111 eventを保持するglobal hard capとする。NIP-22のinitial `limit=100` は各Relay・各filterのhistory取得上限であり、このcache上限とは別概念である。

rootごとの独立quotaは設けない。recently opened rootを優先し、古いrootのreply treeをroot単位LRU evictionする。current open rootは、他にevict可能なtreeがある間は優先保持する。

root単位LRUだけでは1000件以下にできない場合、たとえば単一rootだけで1000件を超える場合は、global hard capを優先してそのroot内の古いreplyもevictできる。これはroot別quotaを設ける意味ではない。persistent cacheにchildだけが残るorphan状態を作らず、保持するreplyはrootまでvalidation可能なtree関係を維持する。intra-root evictionの具体algorithmは実装詳細として固定しない。

reply-tree LRU evictionではrootとroot read stateを残し、そのtreeのreply cache、reply read/unread、notification metadataを忘れる。再open時はRelayからreply historyを取得し直す。

### root lightとauthor ghost

通常時、trace cellには共通の小さなlightだけを表示し、author ghostや件数は表示しない。replyは独立した通常field lightを生成しない。field上の通常lightはroot traceだけが所有する。

rootを調査するとauthor ghostを表示する。authorはpubkeyから既存の決定的character割当で導出し、character catalogのimage / name / aboutだけを使用する。kind 0の取得、raw pubkey、npubの表示は行わない。trace/reply ghostからauthorのProfile Dialogを開ける。

cellにcurrent participantがいなければghostはparticipant相当位置に置く。いる場合はcurrentを優先してghostをcell edgeへ小さく半透明で置く。ghostはpresence、collision、occupancyに影響しない。current participantがrootと同cellにいてもroot lightは隠さず、edgeまたはforegroundへ視覚的にoffsetして存在を維持する。このoffset lightは別のpixel hit targetではなく、cellのlogical selection規則を使う。

同一cellに複数rootがある場合、通常時は1つのlightだけを表示し、investigation前は件数を表示しない。最初はnewest rootを選ぶ。investigation後は `1/3` 等を表示し、dedicated prev/nextでrootを切り替える。root一覧をcontext menuに並べない。

### investigation range

root/replyのinvestigation rangeは、それぞれの実際の `w` cell自身と周囲8 cellとする。
movement rulesは[SPEC-30](./SPEC-30-フィールド・position・presence.md)を正とする。

- rootはrange内でだけ調査でき、root調査はpresence activityとする。
- replyを選択してさらに深く辿るには、そのreplyの実際の `w` のinvestigation rangeまで物理的に移動している必要がある。
- reply targetのrange外へ出るとreply modeを解除してdraftを破棄するが、conversation explorationは維持する。

## 25. trace conversation

trace conversationはroot調査からだけ入る。一度にexploreできるroot conversationは1つだけとする。通常live speechへのreply UIは持たない。

rootを調査したら、NIP-22 reply historyを待たずにroot ghostと実際のroot本文bubbleを即表示する。reply history取得中は小さいreply loading状態を表示する。

conversationはcurrent selected speechとそのdirect repliesを中心に表示する。deeper levelではparent 1件だけをcontextとして表示する。reply depthに上限は設けない。

- different-cell direct repliesは同時に表示する。
- offscreen direct replyまたはparentはviewport edge connectorとdirection arrowだけを表示し、本文、author、距離を表示しない。
- reply間の関係はspeech tailと別のdotted / segmented connectorで表現する。
- same-cell複数replyは代表1件とcountを表示する。個別replyは共通context menuから選択し、menuではbodyを見せずauthorだけを示す。同authorの複数replyはnewest-firstの番号で区別する。
- same-cellへのnew replyがlive到着しても表示中代表を自動変更しない。conversationをreopenした時だけ代表をnewestへ戻す。

Profile Dialogまたはcontext menuを開閉してもconversation exploration、reply target、draftを維持する。

### NIP-22 conversation取得

この節はtrace conversation取得の製品意味論を正とする。Relay transport、subscription lifecycle、reconnectおよびdedupeの実装責務は [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) を正とする。

- root conversation open時は、`kinds=[1111]`、`#E=[root]`、project `#L/#l`、initial `limit=100`で、root-wideのrecent historyとlive replyを対象にする。
- current speechのdirect reply補完は、`kinds=[1111]`、`#e=[current]`、project `#L/#l`、initial `limit=100`とする。tag条件は3個に抑え、root/tree整合性は取得後のsemantic validationで確認する。query一致だけでcandidateを受理しない。
- notification候補は、`kinds=[1111]`、`#p=[current persona pubkey]`、project `#L/#l`を使い、可能ならcurrent effective root IDsで`#E`も絞る。
- `limit=100`は各Relay・各filterのinitial history取得上限であり、reply treeの件数上限でもreply cacheのglobal 1000件上限でもない。Relayごとの応答をevent IDでmulti-Relay dedupeし、tree/cacheのglobal capとは別に扱う。

初回history取得では、Relay arrival orderに依存してreplyを1件ずつprogressiveに表示しない。EOSE / CLOSED / timeoutまでのbounded batchを集め、batch/cache内のroot/parent relationをsemantic validationした後、accepted direct repliesをまとめて反映する。

cache済みconversationをreopenした場合はcached repliesを即表示し、同時にRelay refreshを行う。refreshで以前cache済みだったreplyがRelayから返らなかったことだけをcache削除根拠にしない。NIP-09は完全非対応であり、Relay omissionをdeletion扱いしない。

live 1111は、rootまたはimmediate parentが利用不能ならその受信ではignoreする。pending buffer、無制限parent fetch、orphan cache、root revivalは行わない。後のhistory refreshで必要なroot/parentと同じeventが得られた場合は、そのbatchで再validationして受理してよい。current browserでeffectiveでないrootへの1111は常にignoreし、notificationも生成しない。

open中の同rootへのvalid 1111は受信、cache、read/unread判定を行う。current speechへのdirect replyだけがcurrent viewへの新規表示候補になり、同rootでも別branchへのreplyはcurrent viewへ勝手に挿入しない。

### reply modeとdraft

traceを調査またはreplyを選択すると、そのeventをreply targetとするreply modeへ入る。ただしComposerへ自動focusしない。

- 別eventまたは別rootをreply targetにすると、旧draftを破棄する。
- eHagaki reply previewの`×`はreply referenceだけを解除し、draftを維持する。
- blank field tapによる明示conversation closeはconversation/reply modeを解除し、draftを維持する。
- successful reply publish後はreply modeを解除するが、current speechを投稿replyへ自動移動しない。
- replyはnormal / shout / monologueを許可し、trace styleで元speech shapeを維持する。
- own replyはselfがそのreplyの `w` にいる間だけduplicate self ghostを省略し、bubble tailをcurrent selfへ向ける。selfがcellを離れた後は通常のself ghostを表示する。

## 26. read / unread

root readおよびreply read/unreadはbrowser-local persistent stateとし、Nostr eventとして発行せず、cross-device同期しない。

root readはbrowser-person scopeで保持し、reincarnation後も維持する。reply read/unreadとnotificationはpersona/pubkey scopeで保持し、旧persona宛notificationをreincarnation後のpersonaへ引き継がない。

root readは、root ghostと実際のroot本文bubbleの**両方**が実表示された時だけ成立する。light、menu、connector、offscreen arrow、ghostだけ、conversation open開始だけではroot readにしない。reply readは、実際のreply本文bubbleが表示された時だけ成立する。menu、offscreen arrow、connector、root openだけではreadにしない。

自分がauthorであるeventへのdirect replyだけを未読候補とする。self-replyは表示できてもnotification対象外とする。

- root read/unreadはlight opacityへ反映する。同一cellに複数rootがある場合、全rootがreadなら弱いopacity、1件でもunreadなら未読opacityとする。
- reply unreadの有無はlight colorへ反映する。同一cellに複数rootがある場合、いずれかのrootにreply unreadがあればunread color、全rootにreply unreadがなければ通常colorとする。
- global unread indicatorはComposer dockに置き、Chatterとは別UIとする。操作時は「どこかにあなたへの返信の痕跡があります」のように未読存在だけを説明する。本文、author、場所、方向、距離、件数を表示せず、auto-navigationもしない。

## 27. trace bubbleの視覚的優先順位

trace root/reply bubbleは軽い半透明fill、完全opaque text、trace-specific outlineとし、normal / shout / monologueのshape/styleを維持する。live/current speechはtrace bubbleより優先して配置する。exact opacity/color、placement algorithm、connector pixel geometryは実装詳細として固定しない。
