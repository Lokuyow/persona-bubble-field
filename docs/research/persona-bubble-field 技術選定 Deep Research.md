# persona-bubble-field 技術選定 Deep Research

> 調査基準時点: 2026年8月\
> 更新: 2026-08-27 Relay transport調査結果を反映

## エグゼクティブサマリー

2026年8月時点の一次資料を基に、`Lokuyow/persona-bubble-field` のフィールド描画、フキダシ配置・衝突回避、Nostrスタック、永続化、テスト基盤を検討した。

初回調査の中心結論である、**UI prototypeでは追加runtime dependencyを入れず、DOM absolute positioning + CSS transform + pure geometry + ResizeObserver + DOM bubble + inline SVG tailを採用する**方針は、実装後も維持する。

初回調査ではcollisionについて、project-owned deterministic discrete-candidate placementを第一候補としつつ、実物でcollision問題が顕在化した場合に `avoid-overlap` と比較SPIKEする方針としていた。

その後のprototypeではproject-owned方式を実装し、edge-aware candidateとbounded local repairを含むdeterministic placementで、360×740、390×844、desktopの実表示を検証した。360×740で一度確認された回避可能な重なりも、candidate設計とbounded repairのroot cause修正によって解消した。PR #6 `Add deterministic bubble collision placement` はmerge済みである。

さらにPR #7で固定fixtureからconversation lifecycleへ進み、dynamicなnormal / merged bubble、expiry、visibility変化、movementと既存collision placementを統合した。現時点で外部solverを必要とする実測上の不足は確認されていない。

この結果、**`avoid-overlap` の比較SPIKEは現時点では実施しない**。判定を `SPIKE` から **RE-EVALUATE LATER** へ変更する。再評価するのは、実利用で配置品質が不足する、bubble数増加時に現在のplacementがperformance上のbottleneckになる、またはproject-owned実装より明確に単純で高品質な外部方式が現れた場合に限る。

Nostrは責務を分離する。event / crypto primitivesには **`nostr-tools` をADOPT** し、fresh secret key generation、public key derivation、event ID/hash、Schnorr signing、signed event verificationを担当させる。kind 42、kind 30078、NIP-28/NIP-32、speech type、position、project semantic validationはproject-owned `nostrProtocol` が所有する。

Relay transportは **`rx-nostr` をCONDITIONAL ADOPT** とする。SPEC-30が要求する、Relayごとに1 WebSocketを共有したmessage / positionの長寿命Forward subscription、per-Relay raw `EOSE`、再接続後の継続REQを、RxJSをadapter内部に閉じ込めたまま扱えることをSPIKEで確認した。以前のSimplePool + thin wrapper中心方針は撤回し、`nostr-tools` のSimplePool Relay transportは **RE-EVALUATE LATER** とする。

ただし、rx-nostr 3.7.5および調査時点のcurrent mainには、正常な`OK`後にpublish stateを解放できない既知のcleanup bugがある。送信を含むproduction採用を完成扱いにする条件は、[upstream PR #198](https://github.com/penpenpng/rx-nostr/pull/198)相当の修正が正式releaseへ含まれ、そのreleaseでproject側検証が通ることとする。

永続化は必要になった時点で `idb-keyval` を第一候補とし、index/query等が必要になった場合のみ `idb` やDexieを再評価する。

テストはpure geometry / domainにVitestを採用する方針が実装によって確認された。responsive browser testについてはPlaywrightを採用候補として維持するが、恒久dependencyの導入は必要なUI regressionが明確になった時点で行う。

Relay transportの再調査は完了した。**新規library候補の探索は再び停止**し、upstream fix / releaseの確認後にproduction実装へ進む。現在のarchitectureを覆す重大な新事実がない限り、候補探索へは戻らない。

## 技術選定の決定表

判定は、**ADOPT = 採用方針を確定、CONDITIONAL ADOPT = 採用方針は成立しているが明示した外部条件を満たすまでproduction採用を完成扱いにしない、SPIKE = 小さな比較実装で決定、REJECT FOR NOW = 現状要件には不適、RE-EVALUATE LATER = 条件変化時のみ再評価**とする。

| 領域 | 候補 | 判定 | 主な理由 | 再評価条件 |
|---|---|---|---|---|
| Field | DOM + absolute positioning + CSS transform | **ADOPT** | grid座標、camera、avatar、bubble、tailが同じ座標系を共有でき、prototypeで成立を確認 | 実測でDOMがbottleneckになった場合 |
| Field | CSS Gridをparticipant配置の主方式にする | **REJECT FOR NOW** | bubble/tail用にpixel座標が必要で二重座標系になりやすい | cell自体が主要interactive UIになる場合 |
| Resize | `ResizeObserver` | **ADOPT** | viewport / bubble実測に十分で、wrapper dependency不要 | なし |
| Bubble anchor | Floating UI | **REJECT FOR NOW** | single floating elementのanchor/clippingには強いがbubble間collisionを解かない | portal/nested scroll/clipping ancestorが複雑化 |
| Bubble anchor | CSS Anchor Positioning | **RE-EVALUATE LATER** | single-anchor簡略化候補だがbubble間collisionは対象外 | 必要feature setのbrowser supportと製品構造が適合 |
| Collision | project-owned deterministic discrete-candidate placement | **ADOPT** | 要件を直接表現でき、deterministic・testable。prototypeでmobile/desktop実表示まで成立 | 配置品質またはperformance不足を実測 |
| Collision | `avoid-overlap` | **RE-EVALUATE LATER** | 初回調査ではSPIKE候補だったが、project-owned方式で現要件を満たしたため比較コストを追加しない | current solverで実利用上の不足が確認された場合 |
| Collision | D3 `forceCollide` | **REJECT FOR NOW** | 可変矩形＋preferred positionの優先順位と合わない | participant spriteの物理的分離が主要要件化 |
| Collision | labelgun | **REJECT FOR NOW** | hide/show中心で「可能な限り全speechを表示」と相性が悪い | 再評価不要 |
| Tail | inline SVG `<path>` | **ADOPT** | 1→1 / 1→Nを同じモデルで扱え、実装済みgeometryと座標共有できる | edgeが数百〜数千規模へ拡大 |
| Tail | LeaderLine | **REJECT FOR NOW** | 単純tailにdependency lifecycleを追加する利益がない | 再評価不要 |
| Renderer | Svelte Flow | **REJECT FOR NOW** | node editor / pan / zoom / selection等、不要な責務が多い | 製品がgraph/node editorへ変わる場合 |
| Renderer | Phaser | **RE-EVALUATE LATER** | game engineの責務が現要件を大きく超える | 大型tilemap、大量sprite、particle/effectが主要機能化 |
| Renderer | PixiJS | **RE-EVALUATE LATER** | DOM speechとの二重rendererを招く | 大量continuous animationでDOMが実測bottleneck |
| Renderer | Konva / svelte-konva | **REJECT FOR NOW** | Canvas object model、drag/hit detection等が不要 | Canvas shape editingが必要 |
| Nostr | `nostr-tools` event / crypto primitives | **ADOPT** | project-owned event semanticsを保ったまま、key generation、event ID/hash、Schnorr signing、signed event verificationを利用できる | crypto / event primitiveの要件が変わる場合 |
| Nostr | rx-nostr Relay transport | **CONDITIONAL ADOPT** | SPEC-30の長寿命Forward REQ、per-Relay raw EOSE、再接続、Relay状態、NIP-11 queueを扱える。RxJSはadapter内部に閉じ込める | [PR #198](https://github.com/penpenpng/rx-nostr/pull/198)相当のpublish cleanup修正が正式releaseに入り、project側検証が通るまで |
| Nostr | `nostr-tools` SimplePool Relay transport | **RE-EVALUATE LATER** | per-Relay raw EOSEとreconnect semanticsを満たすにはproject-owned lower-level lifecycle実装が増える | Relay lifecycle要件またはofficial APIの挙動が変わる場合 |
| Nostr | Nostrify | **RE-EVALUATE LATER** | Relay lifecycle APIは候補だが、現在のrx-nostr採用方針を覆す根拠はない | rx-nostrの採用条件を満たせない、またはarchitectureを覆す新事実が確認された場合 |
| Nostr | Applesauce | **REJECT FOR NOW** | EventStore/reactive modelがcurrent-message中心MVPには広すぎる | large local EventStoreが必要 |
| Nostr | NDK | **REJECT FOR NOW** | 高レベルNostr frameworkの責務が現要件を超える | 一般Nostr SNS機能が大幅拡張 |
| Persistence | `idb-keyval` | **ADOPT** | 単純key-value用途に一致 | index/queryが必要になるまで |
| Persistence | `idb` | **RE-EVALUATE LATER** | schema/index/range queryが必要になった場合の自然な昇格先 | 複数store/index/range queryが発生 |
| Persistence | Dexie | **RE-EVALUATE LATER** | 成熟しているが現MVPには大きい | large local cache/query/live queryが必要 |
| Test | Vitest | **ADOPT** | geometry / conversation domainで実績あり | なし |
| Test | Playwright | **ADOPT** | viewport / keyboard / touch / browser interaction regression向き | 恒久dependency導入は実際のregression需要に合わせる |
| Test | Svelte Testing Library中心のcomponent unit test | **REJECT FOR NOW** | pure logicはVitest、browser behaviorは実ブラウザ/Playwrightで分けられる | component単位の複雑interactionが増加 |

## Field / rendering architecture

現在の推奨構成は次のとおり。

```text
Svelte 5 / SvelteKit
│
├── project state
│   ├── participants
│   └── conversation lifecycle
│
├── pure geometry
│   ├── cell → world
│   ├── world → screen
│   ├── camera clamp
│   ├── movement validation
│   ├── bubble preferred anchors
│   └── deterministic collision placement
│
├── ResizeObserver
│
├── DOM
│   ├── field
│   ├── character avatars + names
│   └── speech bubbles
│
└── SVG overlay
    └── bubble → participant tails
```

Field自体は論理gridだが、participantの主配置はworld座標をpixelへ変換してabsolute positioning / transformで描画する。

これにより、同じworld→screen変換をavatar、camera、bubble preferred anchor、merged member center、tail終端へ共通利用できる。

Canvas / WebGLへ先回りして移行しない。現在の規模は、128セル前後、visible participant数人〜数十人、visible bubble数個〜数十個程度を想定しており、movementも基本的に離散イベント駆動である。DOM text / accessibility / Composerとの統合を維持したままGPU rendererを追加する利益は現時点ではない。

再評価は人数の固定閾値ではなく、実機Performance profileを根拠に行う。大量のcontinuous animation、tail数百本、またはstyle/layout/paintが継続的にframe budgetを超える場合にCanvas / PixiJS等を比較する。

## Bubble placement / collision

### 製品上の目的

collision solverの目的は完全packingではない。

優先順位は、

1. speakerとの空間的対応を維持する
2. bubble同士のoverlapを減らす
3. 完全非重複

である。

したがって、solverの内部実装はこの製品上の契約へ従う。特定algorithm自体を製品仕様として固定しない。

### Prototypeで確認したこと

初回prototype後、project-owned deterministic placementを実装した。

最初の単純greedy candidateでは360×740相当の3-bubble構成に回避可能なoverlapが残った。これは「狭いので不可避」ではなく、candidateが自己サイズ基準の固定offsetに偏り、既配置bubbleのedgeを利用できず、一方向のgreedy placementだけだったことがroot causeだった。

その後、

- bounds edgeと既配置bubble edgeを使うedge-aware candidates
- 現在bubbleと少数の関連bubbleだけを対象にしたbounded local repair
- deterministic ordering / tie-break
- candidate explosionを避けるbounded candidate generation

へ修正し、360×740相当fixtureで8px gapを含む非重複配置を確認した。

実ブラウザでも360×740、390×844、desktopでcollision、movement、camera、resize、SVG tailを確認した。

このため、現在の判定は次で確定する。

```text
project-owned deterministic placement
        ↓
      ADOPT
        ↓
通常実装を継続
        ↓
実測で不足が出た場合だけ
        ↓
avoid-overlap / 他solverを再評価
```

### `avoid-overlap`

`avoid-overlap` は候補位置、priority、seed、fixed element等の概念が今回の問題と近く、外部候補としての評価自体は変わらない。

ただし、prototypeでproject-owned方式が現在の品質要求を満たした以上、比較するためだけにdependency、annealing、adapter、performance測定経路を追加する利益はない。

よって「今後必ずSPIKEする候補」ではなく、**current solverの不足が確認された場合の再評価候補**とする。

### Floating UI / force / label系

Floating UIはsingle anchor、clipping、shift、size等には有力だが、bubble-to-bubble collision、merged bubbleの複数speaker、global placement stabilityはproject側に残るため現時点では採用しない。

D3 forceは可変矩形とspeaker preferred positionの維持という優先順位に合わない。labelgun等のhide/show型label engineも、現在の「可能な限りspeechを残す」要件と合わない。

## Tail

inline SVGを維持する。

通常bubbleは1本、merged bubbleは現在画面内にいるmember数だけpathを描画する。同じscreen geometryをbubble placementとavatar endpointで共有する。

外部line/graph libraryは導入しない。

## Nostr client stack

暗号・eventとRelay transportを分離し、どちらもproject固有の意味を所有しないlibraryに委譲しすぎない。

`nostr-tools` は **ADOPT** とする。fresh secret key generation、public key derivation、event ID/hash、Schnorr signing、signed event verificationを担当する。project-owned `nostrProtocol` はkind 42、kind 30078、NIP-28、NIP-32、speech type、positionとproject semantic validationを所有する。現行実装の`nostrProtocol`も、event template構築、`finalizeEvent()`、`verifyEvent()`、受信eventのsemantic parserをこの境界で分けている。

Relay transportは `rx-nostr` を **CONDITIONAL ADOPT** とする。Relayごとに1 WebSocketを共有し、multi-Relay communication、long-lived Forward REQ、そのlifecycle、reconnect、ongoing Forward REQの自動再送、raw `EOSE`、`CLOSED`、`OK`、connection state、NIP-11 subscription queueを扱う。RxJSはtransport adapter内部だけで使い、Svelteおよびdomain APIへ漏らさない。

### SPIKEで確認したRelay lifecycle

SPEC-30では、Relayごとに論理的に別の長寿命subscriptionを少なくとも2本必要とする。

- `world-messages`: `kinds:[42]`、target channel `#e`、project `#L`、`#l:["chat"]`
- `world-positions`: `kinds:[30078]`、target channel `#e`、project position slot `#d`

いずれもstored bootstrapから`EOSE`、その後のlive `EVENT`までを同じsubscriptionで継続する。rx-nostr 3.7.5のForward Strategyとmock Relay SPIKEで、この挙動を確認した。

public APIからRelay `from`、actual NIP-01 `subId`、`type: "EOSE"`を観測できる。これはRelayの`["EOSE", subId]`から生成されたraw packetであり、project側のtimeoutとは区別できる。`EOSE`後もForward subscriptionは`CLOSE`されず、同じsubscriptionで後続`EVENT`を受信する。

異常切断後、ongoing Forward REQは自動再送される。fixed numeric `since`を使用したSPIKEでは、初回・再接続後とも`since = N`のまま送信された。SimplePoolで問題となる`lastEmitted + 1`への自動変更はなく、再取得されるduplicate `EVENT`はevent IDによるsession-scoped dedupeで吸収できる。

### actual subIdとproject subscriptionの対応

rx-nostrのactual outgoing REQはpublic `createOutgoingMessageObservable()`から観測できるが、packet自体にlogical RxReq identity metadataはない。adapterは、outgoing REQの**project-owned filter semantics**で分類して、`(Relay, actual subId) → logical subscription` mappingを構築する。

classifierはsubIdの文字列形式、`:0`等の内部生成規則、RxReq internal field、REQ送信順、JSON key order、`since`の具体値へ依存しない。unknown / malformed / ambiguousなREQは推測せずfail-closeする。mock Relay A/B × 2 logical subscriptionsの4 lifecycleで、任意順のREQ / EOSEとreconnect後のREQを正しく分類できることを確認した。将来subscription種類を追加する時点で候補集合を明示的に再評価し、まだ存在しない種類のためのgeneric abstractionは先に追加しない。

project canonical Relay URLは末尾`/`ありのまま維持する。rx-nostr内部ではslashlessへnormalizeされるが、public APIからconfigured Relayへ対応付けてcanonical URLへ戻せることを確認した。library内部表現へproject canonical URLを合わせない。

### signing / verification boundary

受信と送信の責務は次のとおりとする。

```text
receive: rx-nostr → nostr-tools verifyEvent() → project semantic parser

send: project event builder → nostr-tools finalizeEvent() → complete signed event
      → rx-nostr noopSigner() → Relay
```

secret keyはRelay transportへ渡さない。`skipExpirationCheck: true`を使用し、NIP-40等のproduct外semantic filteringをtransport libraryへ委譲しない。

`@rx-nostr/crypto` は追加しない。`seckeySigner`、public key derivation、hashing/signature primitives、verifierを提供するが、現在の責務分割で`nostr-tools`を置き換える利益がない。確認したverifierはsignature検証時に再計算hashを使用する一方、`nostr-tools` `verifyEvent()`のような`event.id === recomputed hash`の明示確認は行わない。fresh secret-key generationも`nostr-tools`から外す理由がない。この判断は同package一般の安全性評価ではなく、本projectの要件に対するものとする。

### NIP-11とproduction採用条件

rx-nostrはNIP-11 `limitation.max_subscriptions`をREQ queue capacityとして使用する。Relayが`max_subscriptions: 1`を広告する場合、必要な2本のlong-lived subscriptionの一方がqueueに残り続ける可能性がある。これはRelay capabilityとproject requirementsのcompatibility問題であり、実Relay検証で確認する。NIP-11の無視、2 filterの統合、fallback Relayの自動追加は今回決定しない。

調査時点で、rx-nostr 3.7.5 / current mainにはpublish cleanup bugがある。正常なterminal `OK`後、`PublishProxy.confirmOK()`の条件反転によりregistered publish state / logical connection countが解放されず、lazy Relay connectionがidle / dormantへ戻れないことを再現した。[Issue #197](https://github.com/penpenpng/rx-nostr/issues/197)と[PR #198](https://github.com/penpenpng/rx-nostr/pull/198)は調査時点でopenであり、PRはroot causeの1行修正とpublic-behavior regression testを含む。

したがって、送信を含むrx-nostrのproduction採用を完成扱いにする条件は、**PR #198相当の修正がupstreamの正式releaseへ含まれ、そのreleaseでproject側検証が通ること**である。project側でrx-nostrをpatchする、private APIを使う、publishごとにRxNostr instanceを作り直す、publishだけSimplePoolへ分離するworkaroundは採用しない。

SimplePoolは一般に不適切なlibraryという結論ではない。ただし本projectでは、`SimplePool.subscribeMap()`等のaggregate EOSEではper-Relay raw EOSE semanticsを直接扱いにくく、lower-level subscriptionのEOSE timeoutと実Relay EOSEの区別、reconnect時のfilter `since`、project-owned reconnect lifecycleが問題になる。これらを満たすにはAbstractRelay / direct subscription等の独自実装が増えるため、Relay transportとしては **RE-EVALUATE LATER** とする。

NIP-28がunrecommendedであることを理由にNIP-29へ自動変更しない。NIP-28を採用する製品判断は仕様側で意図的に確定している。外部NIPやlibraryへevent semanticを委譲しすぎず、kind 42 template / tagsはproject fixture testで固定する。

### 一次資料

- [rx-nostr v3: Subscribe event / Forward Strategy](https://penpenpng.github.io/rx-nostr/en/v3/subscribe-event.html)
- [rx-nostr v3: Reconnection](https://penpenpng.github.io/rx-nostr/en/v3/reconnection.html)
- [rx-nostr v3: Other observables](https://penpenpng.github.io/rx-nostr/en/v3/other-observables.html)
- [rx-nostr v3: NIP-11 Registry](https://penpenpng.github.io/rx-nostr/en/v3/nip11-registry.html)
- [rx-nostr 3.7.5 source](https://github.com/penpenpng/rx-nostr/tree/rx-nostr%403.7.5) / [current source](https://github.com/penpenpng/rx-nostr)
- [Issue #197: Publish state is not released after receiving OK](https://github.com/penpenpng/rx-nostr/issues/197)
- [PR #198: Fix publish state cleanup after OK](https://github.com/penpenpng/rx-nostr/pull/198)

## 永続化

field / bubble prototypeとは分離し、accountやlocal stateを実装する段階で追加する。

第一候補は `idb-keyval`。

想定用途は、

- active secret
- reincarnation timestamp
- small settings
- trace read state

等のkey-value中心である。

複数object store、index、range query等が必要になった場合だけ `idb` を再評価し、大規模local EventStoreやreactive queryが必要になった場合にDexieを比較する。

将来を想定したgeneric storage adapterを先に作らない。

## Testing

役割を次のように分ける。

| 種類 | 方針 |
|---|---|
| pure geometry / deterministic domain | **Vitest** |
| conversation lifecycle | **Vitest** |
| viewport / keyboard / touch / responsive behavior | **実ブラウザ確認、必要に応じてPlaywright** |
| 未確定UI値の探索 | **人間による実ブラウザ確認** |
| 固定後のbrowser regression | **Playwrightを導入する価値がある箇所のみ** |

prototype実装ではVitestがgeometryとconversation domainを保護できている。

Playwrightは採用技術として維持するが、単にbrowser testを増やすためだけに恒久dependencyを導入しない。実ブラウザでしか防げない重要なregressionが明確になった時点で追加する。

## Dependency budget

### 現在のUI / conversation prototype

Runtime dependencyは追加しない。

Dev dependencyとしてVitestを使用する。

collision用の外部runtime dependencyは追加しない。

### Nostr実装開始時

```text
nostr-tools (event / crypto primitives)
rx-nostr (Relay transport; upstream publish cleanup fixの正式release後)
```

導入PR時点で、PR #198相当の修正を含む正式releaseとofficial package guidanceを確認する。`@rx-nostr/crypto`は追加しない。

### Browser persistence実装時

```text
idb-keyval
```

### Browser regressionを恒久化する時点

```text
@playwright/test
```

必要性が確認された場合のみ追加する。

## 最終判断と停止条件

現在の最終技術選定は次のとおり。

| 分類 | 最終技術選定 |
|---|---|
| **採用済み / 継続** | DOM absolute positioning、CSS transform、pure geometry、ResizeObserver、DOM bubbles、SVG tails、project-owned deterministic collision placement、Vitest |
| **Nostr event / cryptoで採用** | `nostr-tools`。project-owned `nostrProtocol` がevent semanticsを所有 |
| **Nostr Relay transportで条件付き採用** | `rx-nostr`。PR #198相当のpublish cleanup修正を含む正式releaseとproject側検証が条件 |
| **Persistence段階で採用** | `idb-keyval` |
| **必要なbrowser regressionが明確になった時点で導入** | Playwright |
| **今は入れない** | `avoid-overlap`、Floating UI、Svelte Flow、D3 force、labelgun、LeaderLine、Konva、`@rx-nostr/crypto`、Applesauce、NDK |
| **条件変化時のみ再評価** | `avoid-overlap`、CSS Anchor Positioning、Phaser、PixiJS、`nostr-tools` SimplePool Relay transport、Nostrify、`idb`、Dexie |

初回調査時の「prototype後に `avoid-overlap` と比較SPIKEする」という予定は、prototype検証によって完了扱いに変更する。

今後は次のいずれかが確認された場合だけcollision技術選定へ戻る。

- 現実的な会話密度で解消可能なoverlapが継続して残る
- speakerとの位置対応を維持できないほどbubbleが不自然に移動する
- movement / resize / conversation updateでlayoutが実用上不安定になる
- actual device profileでcollision計算が明確なperformance bottleneckになる
- 外部solver導入によって現在よりコード・責務・品質が明確に改善すると証明できる

それ以外では、新しいcollision libraryを探索し続けない。

Relay transport再調査は完了している。新規library候補の探索は停止し、PR #198相当の修正を含む正式releaseを確認した後にproduction実装へ進む。現在のarchitectureを覆す新事実がない限り、候補探索へは戻らない。
