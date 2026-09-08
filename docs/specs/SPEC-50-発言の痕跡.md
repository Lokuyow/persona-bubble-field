# 発言の痕跡仕様

> この文書は本プロジェクトの確定仕様の一部である。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 24. 発言の痕跡

通常の発言は揮発し、Twitter型の過去ログとして時系列に蓄積表示しない。そのうえで、過去の対象kind 42の一部だけを、元の発言位置に残る**発言の痕跡**として扱う。痕跡は過去ログや履歴ビューではなく、空間に残った一部の発言の記憶である。投稿日時、経過時間、「さっき」「今日」「数日前」等の古さはroot/replyのいずれにも表示しない。

### rootの選択と上限

trace root候補は、有効なtop-level kind 42だけとする。normal / shout / monologueを同率で対象にし、merged bubbleは表示上の集約にすぎないため、抽選は元event単位で行う。

```ts
BigInt(`0x${event.id}`) % 5n === 0n
```

上の決定的20%抽選にsparse-world boost、密度補正、時間expiryは設けない。effective rootは1 logical cellあたり最大1件とし、同一cellに複数のeligible root candidateがある場合はnewest rootだけを残す。`createdAt` が同じ場合は既存の決定的event ID orderingで1件を決める。global root上限は `floor(total logical cell count / 10)` とする。per-cell survivorを決めた後にglobal capを適用し、上限はrootだけを数え、kind 1111 replyは数えない。

### root cache

browserが取得したeffective rootはbrowser-localに永続保持する。latest bootstrap範囲から外れてもroot evictionまで保持し、browserごとに保持する古いtrace集合が異なってよい。root evictionでは、root、root read state、reply tree、reply read/unread state、reply notificationを完全に忘れる。

### reply cache

reply cacheは、全root合計で最大1000件のkind 1111 eventを保持するglobal hard capとする。NIP-22のinitial `limit=100` は各Relay・各filterのhistory取得上限であり、このcache上限とは別概念である。

rootごとの独立quotaは設けない。recently opened rootを優先し、古いrootのreply treeをroot単位LRU evictionする。current open rootは、他にevict可能なtreeがある間は優先保持する。

root単位LRUだけでは1000件以下にできない場合、たとえば単一rootだけで1000件を超える場合は、global hard capを優先してそのroot内の古いreplyもevictできる。これはroot別quotaを設ける意味ではない。persistent cacheにchildだけが残るorphan状態を作らず、保持するreplyはrootまでvalidation可能なtree関係を維持する。intra-root evictionの具体algorithmは実装詳細として固定しない。

reply-tree LRU evictionではrootとroot read stateを残し、そのtreeのreply cache、reply read/unread、notification metadataを忘れる。再open時はRelayからreply historyを取得し直す。

### root lightとauthor ghost

通常時、trace cellには共通の小さなlightだけを表示し、author ghostや件数は表示しない。replyは独立した通常field lightを生成しない。field上の通常lightはroot traceだけが所有する。

表示中のroot lightがinvestigation range内にある場合は、調査可能であることを示す小さなinteraction indicatorをlight付近に表示する。indicatorはlogical-cell selectionを補助する表示であり、独立したpixel hit targetにはしない。

rootを調査するとroot author ghostを表示する。authorはpubkeyから既存の決定的character割当で導出し、character catalogのimage / name / aboutだけを使用する。kind 0の取得、raw pubkey、npubの表示は行わない。reply authorはbubbleの兄弟native Profile buttonからProfile Dialogを開ける。

cellにcurrent participantがいなければghostはparticipant相当位置に置く。いる場合はcurrentを優先してghostをcell edgeへ小さく半透明で置く。ghostはpresence、collision、occupancyに影響しない。current participantがrootと同cellにいる場合、root lightは非表示にする。investigation range内では既存のinteraction indicatorでTraceの存在を示し、participantの有無に関係なくcell右上の固定位置へ表示する。lightとindicatorは独立したpixel hit targetではなく、cellのlogical selection規則を使う。rootを調査してそのroot conversationが開いている間は、対象rootが属するcellのroot lightを非表示にする。conversationを閉じれば再表示する。

root lightはcellごとに1つだけ表示し、件数表示は持たない。logical cellから調査できるrootも常に1件である。

### investigation range

investigation rangeはrootの実際の `w` cell自身と周囲8 cellとする。replyは独自のworld/cell positionを持たない。
movement rulesは[SPEC-30](./SPEC-30-フィールド・position・presence.md)を正とする。

- rootはrange内でだけ調査でき、root調査はpresence activityとする。
- range外のvisible root lightを操作した場合は、conversationやcontext menuを開かず、「近づくと調べられる」という一時feedbackだけを表示し、stateを変更しない。
- Characterとroot lightが同じcellにある場合、range外のrootはcontext menuのactionとして数えず、Characterが1人ならProfile Dialogを直接開く。range内ではCharacter profileとTrace調査を既存context menuから選択できる。
- replyを選択してさらに深く辿る操作もopen rootのrange内で行う。
- root range外へ出るとconversation explorationを終了する。range外へ出た時点でactiveなreply modeならreply modeを解除してdraftを破棄する。reply referenceがすでに解除されている場合は、conversationだけを終了し、Composer draftは維持する。

## 25. trace conversation

trace conversationはroot調査からだけ入る。一度にexploreできるroot conversationは1つだけとする。通常live speechへのreply UIは持たない。

rootを調査したら、NIP-22 reply historyを待たずにroot ghostと実際のroot本文bubbleを即表示する。reply history取得中はloading indicatorを表示しない。

表示対象はroot、current、immediate parent、currentの全direct repliesだけである。rootは常にfield position由来で表示し、rootがcurrentまたはimmediate parentでない深いcurrentでは1行ellipsisのcompact contextとする。reply depthに上限は設けない。

- current=rootまたはimmediate parent=rootではroot bubbleをtree anchorとする。
- 深いcurrentではhidden ancestorのUI node、仮想slot、connectorを生成せず、immediate parentを`bubbleSafeBounds`中央へreply card footprintで中央揃えしたvisible local cluster anchorとする。currentとdirect childrenは親のplaced cardから既定slotへ配置する。
- direct child slotはcreatedAt昇順、event ID昇順で右下、左下、右上、左上、以後同順の外側ringとする。slot、clamp、collisionはauthor icon/nameを含むreply card footprintを使用し、同一anchorへ潰れる場合はranked slot/edge fallbackを選ぶ。
- currentの変更やdirect replyの追加で再配置が必要になっても、同じpresentation coordinate contextで、表示中のTrace nodeのサイズとfootprintが変わらず、safe bounds内で維持できる場合は、そのnodeのanchorを維持する。rootのcontinuity contextにはroot ID/position、camera、cellSize、field area、safe/visual bounds、fieldRows、viewportWidthを含め、これらが変わった場合は古いroot anchorを固定せず、現在のfield positionから導出したplacementを優先する。fixed live bubbleの出現・消失やcollision contextの変更、新規node、サイズ変更、safe bounds外となるnodeは既存のslot/clamp/collision規則で再配置する。
- compact rootとdeep immediate parentの間にはconnectorを描かない。connectorは表示中の実在する親子関係だけをcontinuous tapered relationとそのhaloで描く。root tailとrelationは、visible Trace surfaceの内側へ描画しない。
- speech bodyはnative button、author icon/nameはsiblingのnative Profile buttonとする。Profile操作はselection、target、draftを変更しない。overflow / ellipsis / special shape用のpresentation measurementとplacement用のwrapper footprintは責務およびstate/reporting pathとして分離する。exact DOM measurement targetは実装詳細とし、現行presentationでは挙動、special surface geometry、tree placementを維持するため、両経路が同じreply card root矩形を使用してよい。

Trace conversationでrootとreplyなど複数の選択可能なspeechが表示されている場合、conversationのcurrent speechを他のvisible Trace speechと視覚的に区別できる。rootしか表示されずcurrentが自明な場合は、current強調を必須としない。強調はComposerの一時的なreply targetではなくconversationのcurrentに基づき、reply referenceの解除やsuccessful reply publish後にreply modeだけが解除されても、conversation currentが変わらない限り維持する。normal / shout / monologueの各speech shape本来の外形を使ったselection presentationとし、exact color、stroke width、dash pattern等のpixel表現は実装詳細とする。

replyのspeech selection領域はauthor Profile領域と分離したまま、content columnの利用可能な領域を使用する。短文でもcontent側の利用可能な縦方向領域を選択できる。author Profile操作はspeech selection、conversation exploration、reply target、draftを変更しない。

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
- root bubbleはfield上のroot author ghostへ既存のtailを維持する。reply bubbleはfield ghostまたはselfへ向かうtailを持たない。Profile操作はconversation、target、draftを変更しない。

## 26. read / unread

root readおよびreply read/unreadはbrowser-local persistent stateとし、Nostr eventとして発行せず、cross-device同期しない。

root readはbrowser-person scopeで保持し、reincarnation後も維持する。reply read/unreadとnotificationはpersona/pubkey scopeで保持し、旧persona宛notificationをreincarnation後のpersonaへ引き継がない。

root readは、root ghostと実際のroot本文bubbleの**両方**が実表示された時だけ成立する。light、menu、connector、offscreen arrow、ghostだけ、conversation open開始だけではroot readにしない。reply readは、実際のreply本文bubbleが表示された時だけ成立する。menu、offscreen arrow、connector、root openだけではreadにしない。

自分がauthorであるeventへのdirect replyだけを未読候補とする。self-replyは表示できてもnotification対象外とする。

- root read/unreadはlight opacityへ反映する。reply unreadの有無はlight colorへ反映する。
- reply unreadの有無はroot lightのcolorへ反映し、reply unreadが存在する場合はroot readによるlightのopacity低下よりpresentation上優先する。
- global unread indicatorはComposer dockに置き、Chatterとは別UIとする。操作時は「どこかにあなたへの返信の痕跡があります」のように未読存在だけを説明する。本文、author、場所、方向、距離、件数を表示せず、auto-navigationもしない。

## 27. trace bubbleの視覚的優先順位

trace root/reply bubbleは軽い半透明fill、完全opaque text、trace-specific outlineとし、normal / shout / monologueのshape/styleを維持する。rootのtailとnormal root bubbleのtail接続部は、そのbubble本体と同じ半透明surfaceを使用する。live/current speechはtrace bubbleより優先して配置する。exact opacity/color、placement algorithm、connector pixel geometryは実装詳細として固定しない。
