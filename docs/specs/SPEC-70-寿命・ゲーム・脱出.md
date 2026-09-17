# 寿命・ゲーム・脱出仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。ゲーム進行、寿命、ポイント、作業、リアルタイムイベント、脱出、Identity、Runは本資料を正とする。

アカウント、秘密鍵、Nostr identityそのもの、および一般Nostrへの持ち出しは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。本資料はそれらのゲーム進行上の扱いだけを定め、Nostr eventのkind、tag、schema、transport方式は定めない。

## 1. 基本進行

新しい人格には、出生時に現実時間7日の寿命を与える。寿命の上限は14日とする。寿命は現実時間とともに減少し、0になると死亡する。

現在人格が利用可能な通常状態では、プレイヤーはフィールド画面上で現在人格の残り寿命を常時確認できる。残り寿命の表示は、保存された寿命期限とactiveな作業を含む実効寿命期限から導出する。人格のgame stateがmissing・corrupt等で利用できずpublic worldのread-only状態へfallbackしている場合、および実persona lifecycleを持たないDEV Worldでは、残り寿命を表示しない。

通常死亡時には、その人格について以下を失う。

- 現在の人格
- 現在の秘密鍵
- 現在のNostr identity
- 現在所持ポイント
- 能力強化状態
- その他、その人格固有の継続状態

通常死亡後は、current Runを閉じ、current Identityを `dead` として履歴へ残す。その後、Rootから次generationの未選択candidateを3つ準備し、blockingな選択画面へ戻る。候補を1つ選択すると、そのIdentityにRun #1を作成する。

新Run #1は次から開始する。

1. 寿命を7日にする
2. ポイントを0にする
3. 能力を初期状態にする
4. `mendingJob = null` にする

旧Identityと新Identityの間に、Run-localの記憶・状態・自己認識の連続性を持たせない。Identity historyにはselected Identityとfinished Runのsummaryだけを残す。

24時間に1回の任意転生および任意のリセマラは廃止する。転生は原則として死亡時のみ発生する。

## 2. ポイント

ゲーム内で使用するポイントは1種類だけとする。「脱出ポイント」と「成長ポイント」には分離しない。

ポイントは主に `作業` と `有効なリアルタイムイベント` によって獲得する。ポイントは能力強化に消費でき、現在所持ポイントが1000pt以上である間だけ脱出条件を満たす。

所持ポイントは0以上の整数とする。1pt未満の作業進捗は所持ポイントとは別のRun-localなcarryとして保持し、表示・消費・persistする所持ポイントへ小数を混在させない。

能力強化に使用したポイントは所持ポイントから減少する。現在所持ポイントが1000pt未満になれば脱出条件を満たさなくなり、再び1000pt以上を所持すれば満たす。過去に一度1000ptへ到達したこと自体は、脱出条件を永久に解放するflagとして扱わない。「能力へ投資する」か「1000pt以上を所持して脱出する」かの選択が成立する。通常死亡・転生時には現在所持ポイントをすべて失う。

## 3. 1000pt到達と脱出

normal clear working thresholdは現在所持ポイント1000ptとする。1000pt以上である間だけclear選択を利用でき、過去の到達だけで永久unlock flagにはしない。1000pt以上を所持しているだけで自動clearにはしない。clear後はcurrent Identityのnsec取得を可能にする。

### 脱出前の秘密鍵保護

clear前はactive Identityのchild secretをexportしない。Root entropyの保存保護、export後の一般Nostr利用、暗号学的な完全保護を目的としないことは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

## 4. 非同期活動「作業」

非同期活動の正式名称は `作業` とする。作業は、寿命を延長し、ポイントを得て、能力強化へつなげる日常的な非同期活動である。作業そのものに操作型ミニゲームは設けず、放置ゲームとして扱う。

### 作業端末

フィールド上に固定施設として `作業端末` を配置する。端末は1つの論理cellを占有し、専用clientのlocal playerはそのcellへ侵入できない。端末の周囲8cellから操作できる。プレイヤーは端末の近くまで実際に移動しないと、作業の開始・成果回収をできない。端末では次を行う。

- 作業開始
- 現在bucketの状態確認
- 蓄積済みポイント成果の受け取り

作業開始後はその場に居続ける必要はない。作業中も、通常のフィールド移動、会話、綻びへの参加、ブラウザ終了を妨げない。

作業は成果を継続的に蓄積する非同期bucketである。最大処理時間は1回のJOB完了待ち時間ではなく、成果を回収せずに蓄積できる処理時間の上限とする。上限未満でも作業端末から成果を回収でき、回収後は回収時刻から次のbucketを開始する。作業開始後に成果回収のたび再開始する必要はなく、明示的な停止機能は設けない。具体的な端末座標、placeholderの見た目、将来の専用assetは本仕様で固定しない。

### 成果回収とbucket

作業開始時に、最大蓄積時間、寿命延長率、1pt獲得に必要な作業時間をabilityからsnapshotする。ハルシネーション抑制によるpoint intervalは、初期60分/Lv1 55分/Lv2 50分/Lv3 45分/Lv4 40分である。端末の近くであれば上限未満でも、その時点までのprocessed durationに対応する寿命延長と整数pointsを1回のatomic mutationで回収でき、1pt未満のprogress carryは失わない。dialogを開くだけでは回収せず、途中終了や途中からの再開始操作は設けない。

回収時には寿命延長をpersisted lifespanへmaterializeし、pointsを所持pointsへ加算する。同時に回収時刻を開始時刻として次のbucketを作成し、次bucketは回収時点の最新ability levelsをsnapshotする。回収後も`mendingJob`はactiveなままであり、蓄積時間と受取可能pointsは0から再開する。processed durationが存在すれば今回の整数pointsが0でも回収を成立させ、寿命延長、progress carry、回収時刻から開始する次bucketをmaterializeする。processed durationが0の即時再回収は成立させない。active bucket中の能力強化は現在bucketへ遡及適用せず、carryを新rateでrevalueしない。

maximum durationへ到達した後はpointsと寿命延長の増加を停止し、上限超過時間を次bucketへ持ち越さない。上限到達後も同じ回収操作を行える。

### 寿命延長

寿命延長は作業成果の回収時にまとめて発生させず、作業が実際に進行している時間に応じて継続的に適用する。作業中にブラウザを閉じていても、作業が有効に進行している時間について寿命延長効果を得る。

初期状態の寿命延長量は、処理1時間あたり `+0.8時間` とする。

作業の最大処理時間、寿命延長率、point intervalは開始時点の能力値で固定する。進行中に能力を強化しても、そのjobへ遡及適用しない。回収後に開始する次bucketだけが、その時点の最新abilityをsnapshotする。

作業中には、作業中であること、経過時間、context使用率、受取可能ポイント、1pt未満のprogress、次の1ptまでの時間、寿命延長量等の現在状態を表示してよい。active bucketの途中成果は所持pointsへは加算されないが、端末の近くで明示的に回収した時点までの成果はpartialでも受け取れる。`prompt`、`token`、`inference`、`context`、`hallucination`、`verification` 等の用語をフレーバーとしてログに使用してよいが、それらの本当の意味を作品内で説明する必要はない。

作業中の死亡判定は、保存済みの `lifespanExpiresAtMs` 単独ではなく、current bucketの未materialize寿命延長を含むeffective lifespanを基準とする。保存済みexpiryが現在時刻を過ぎていても、current bucketの寿命延長込みのeffective lifespanが残っている間は死亡しない。effective lifespanのexact expiryは死亡扱いとし、それ以後の成果回収は成立させない。死亡時にcurrent bucketへ蓄積されていた未回収pointsは所持pointsへ加算せず、通常死亡時のRun-local stateとして失う。bucketが蓄積上限へ到達した後は寿命延長も停止するため、回収せず放置してeffective lifespanが尽きれば死亡する。

JOB等の具体的な処理内容をフレーバーとして変化させてもよい。ただしprototypeではJOBごとにゲーム報酬やルールを変えない。

## 5. 能力強化と能力強化端末

フィールド上に固定施設として `能力強化端末` を配置する。プレイヤーは端末の近くまで実際に移動し、所持ポイントを消費して能力を手動で強化する。能力強化は自動ではない。

能力は次の3系統とする。

- 推論効率
- コンテキスト容量
- ハルシネーション抑制

### 推論効率

推論効率は、処理1時間あたりの寿命延長量を改善する。

| 段階 | 寿命延長量 | 強化コスト |
| --- | ---: | ---: |
| 初期 | 0.8h/h | - |
| Lv1 | 0.9h/h | 5pt |
| Lv2 | 1.0h/h | 10pt |
| Lv3 | 1.1h/h | 20pt |
| Lv4 | 1.25h/h | 40pt |

各コストは、その段階へ上げるときに所持ポイントから消費する。

### コンテキスト容量

コンテキスト容量は、current bucketで回収せずに連続蓄積できる最大時間を増やす。

| 段階 | 最大処理時間 | 強化コスト |
| --- | ---: | ---: |
| 初期 | 8h | - |
| Lv1 | 12h | 10pt |
| Lv2 | 18h | 20pt |
| Lv3 | 24h | 40pt |

最大処理時間に達すると作業は満杯になり、回収まで新たな成果は増えない。回収後は次bucketが直ちに開始する。

### ハルシネーション抑制

ハルシネーション抑制は、1pt獲得に必要な作業時間を短くする。

| 段階 | 1pt獲得に必要な作業時間 | 強化コスト |
| --- | ---: | ---: |
| 初期 | 60分 / 1pt | - |
| Lv1 | 55分 / 1pt | 10pt |
| Lv2 | 50分 / 1pt | 20pt |
| Lv3 | 45分 / 1pt | 30pt |
| Lv4 | 40分 / 1pt | 40pt |

ハルシネーションによる成果減少は、ランダムな大損を発生させる仕組みにはしない。同じ能力値・同じ有効処理時間なら、基本的に決定的に同じ成果を導出できる設計を優先する。

全能力を最大化するために必要な合計コストは245ptとする。能力ポイントの振り直し可否は本仕様では定めない。

## 6. 交換可能なリアルタイムイベント

リアルタイムイベントは、寿命・ポイント・死亡などのsettlementを持ち得る、交換可能なexperimental event枠である。イベント固有の状態は `PersonaGameState` に混在させず、イベントinstanceとaction、participant、round、resultとして独立管理する。実験を終了するときは、その定義をenabled registryから外し、購読・受理・表示・settlementを停止する。旧payloadや旧kindを救済するlegacy path、隠れた自動移行、恒久採用を前提にした互換層は設けない。

prototypeではこの枠で複数のevent typeを順次試遊し、試遊結果を踏まえて正式採用するeventを決める。現時点でenabledなのは最初の試遊対象である `綻び` だけであり、別のevent typeを今回追加しない。

各イベントはイベント定義、protocol version、protocol key、payload parser、instance schedule、settlement規則を持つ。共通のNostr envelope、control、補助subscription、共通parserの仕様は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とし、イベントの有効化・無効化はcompile-time registryで明示する。Relay障害、購読拒否、切断、ブラウザ終了だけを理由に死亡させない。settlementは既存のbrowser-local Player lifecycle store内の汎用ledgerへ、receiptと同じatomic mutationで記録する。ledgerはevent instanceのpendingと適用済みoutcome receiptを持ち、同じoutcomeを二重適用しない。古いIdentityまたは古いRun、既に期限切れのRunにはポイントを適用しない。イベント由来の死亡は、現在Runの死亡処理と同じRun close・Identity dead・次generation選択の経路を明示的に通る。

playable eventのparticipantは、現在のcharacter slotへ解決できるauthorだけを有効参加者として扱う。未割当authorは参加枠、round、result、settlementへ入らない。controlのauthority条件はchannel creatorであり、このparticipant条件をcontrol eventへ適用しない。受信envelopeのprotocol条件と境界検証はSPEC-10を正とする。

### experimental event「綻び」

prototypeでenabledにする最初のexperimental eventは `綻び`（event type `rift`）である。綻びによって、フィールド上にソトへ続く `抜け穴` が形成される。綻びは毎日自動開催し、時刻はJST（UTC+09:00）とする。

- 20:45 JST：綻びの兆候を通知
- 20:55 JST：参加受付開始
- 21:00 JST：ゲーム開始

channel creatorが署名したkind 7070のversioned controlで、任意時刻にもmanual綻びを開始できる。controlのpayloadは開始命令と対象playable protocol keyを持ち、対象instanceは `rift:1:manual:<created_at>:<nonce>` とする。`created_at` はcontrolのUnix timestamp秒、nonceはlowercase 16-byte hexであり、instance IDだけからscheduleを再構成できる。control時刻がregistration開始でwarningはなく、5分後にgameを開始する。controlは検証済みkind 40 channel creator本人の署名、対象channel、enabled definition、payload、instance scheduleを満たすものだけを受理する。

manual綻びのregistration開始〜終了区間とscheduled綻びのwarning開始〜終了区間が少しでも交差する場合、そのmanual controlを無効とする。scheduled綻びを優先し、activeな綻びの置換・並行開催・queueは行わない。bootstrapで複数の有効候補がある場合は、現在時刻でregistrationまたはgame中の候補に絞った後、`created_at`昇順、同値ならcontrol event ID辞書順で選択する。終了済みcontrolから綻びを再開しない。

抜け穴は固定施設ではなく、event instanceとfieldから決定的に異なる位置へ配置する。作業端末・能力強化端末などの固定施設とは別cellとする。参加需要が6人を超える場合は需要に応じて複数生成し、最低1つは生成する。プレイヤーは実際にフィールドを移動して抜け穴の近くで参加し、システムがランダムに振り分けない。1つの抜け穴の有効参加者は3人以上6人以下とし、最大6人は有効なjoin event IDの決定的順序で選ぶ。3人未満は不成立で、ポイント変動も死亡も発生しない。

綻びは3ラウンド制とし、各ラウンドを相談60秒、秘密選択30秒、結果表示20秒で構成する。秘密選択は `抜け穴を維持する` または `抜け穴からの脱出を試みる` の二択とし、commit-revealで締切後に一斉判定する。commitが成立したclientは選択締切を越えた時点でrevealを自動publishし、結果表示内の5秒は通信・publicationの猶予としてのみ扱う。それ以後は無効とする。browser reload・終了等でnonceを失った選択は推測・復元しない。同一selection window内のchoice変更は最初のconfirmed commit後は受け付けず、複数commitのcanonical選択を曖昧にしない。判定対象となる有効参加者が3人未満なら安全に不成立とする。

必要な維持人数は `ceil(有効参加人数 × 2 / 3)` とする。全員が維持した場合は維持者全員に20ptを与える。脱出試行があり、必要人数を満たした場合は維持者に10pt/人、脱出試行者に100pt/人を与え、脱出試行者はその後ハコへ戻る。必要人数を満たさない場合は抜け穴を閉じ、維持者には0pt、脱出試行者にはイベント由来の死亡を適用する。threshold failure後はその抜け穴の残りラウンドを行わない。通常の寿命死亡・clear・能力強化など、綻び以外のルールは変更しない。

Relayやブラウザの一時障害で有効なcommit-revealが成立しなかった参加者は、そのラウンドの人数・報酬・死亡判定から除外する。行動を協力・裏切り・善・悪に分類せず、維持人数と脱出人数という結果だけを扱う。prototype UIは、phase、参加者数、round、残り時間、二択、commit/reveal状態、resultを表示する。DEV/testでは決定的なinstance・時刻・fake Relayを差し替えて各phaseと実際の参加・選択・自動reveal・結果表示を検証できるようにする。

## 7. IdentityとRunのライフサイクル

Player lifecycleはRoot secret storeと分離したbrowser-local aggregateとして管理する。aggregateはschema version、selected Identity history、current modeを持ち、modeは `selecting(pendingSelection)` または `running(activeRun)` のどちらかである。Rootだけ、またはPlayer stateだけのpartial stateは修復せずread-only fail-closeする。

Identityにはgeneration、account index、pubkey、characterId、`identityCreatedAtMs`、status、character profile revision、Run history summaryを持たせる。未選択candidateやskip candidateはIdentity historyへ保存せず、候補のprofile publicationも行わない。

Runにはrun number、monotonic revision、started timestamp、Identity reference、Run-local game stateを持たせる。寿命、points、abilities、`mendingJob`はRun-localであり、mending start/collectionと寿命死亡transitionはactive Runのrevisionを再確認するCASとして扱う。profile publication markerの更新はRun revisionを進めない。

正常なclear後はcurrent Identityのnsec取得、Root-level permanent progression、同じIdentityでのfresh Runまたは別Identityの選択を可能にする。cleared Identityへ戻る場合は同じkey/pubkey/characterを維持してfresh Runを開始でき、3周目以降にも上限を設けない。clear処理、True End、Root mnemonicとIdentity Manifestの受け渡しは別途実装する。

True Endでは、Hako専用Rootの12語English BIP39 mnemonicとIdentity Manifestをユーザーへ渡す。ただしTrue Endはlocal Rootの自動削除を意味せず、Root削除機能は現在scope外である。Manifestは実際にselected、born、playedとなったIdentityのderivation mapping、pubkey、character、Run・clear・death等の履歴を記録する非secretの収容記録であり、未選択candidateやcandidate生成中にskipしたcandidate、Root mnemonicやchild nsec等のsecretは含めない。dead IdentityはTrue End後もHako上ではdeadのままとし、Root mnemonicからchild keyを再導出できることとHako内でresurrectできることは別概念である。Manifestの具体的なpublic export schemaはSPEC-90の未決定事項として残す。
