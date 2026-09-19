# 寿命・ゲーム・脱出仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。ゲーム進行、寿命、ポイント、作業、リアルタイムイベント、脱出、Identity、Runは本資料を正とする。

アカウント、秘密鍵、Nostr identityそのもの、および一般Nostrへの持ち出しは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。本資料はそれらのゲーム進行上の扱いだけを定め、Nostr eventのkind、tag、schema、transport方式は定めない。

## 1. 基本進行

新しいRunには、Root buildに関係なく出生時に現実時間7日の寿命を与える。Rootのハルシネーション耐性Rankにより、作業で延長できる最大寿命だけが7日、14日、21日、30日に変わる。寿命は現実時間とともに減少し、0になると死亡する。

現在人格が利用可能な通常状態では、プレイヤーはフィールド画面上で現在人格の残り寿命を常時確認できる。残り寿命の表示は、保存された寿命期限とactiveな作業を含む実効寿命期限から導出する。人格のgame stateがmissing・corrupt等で利用できずpublic worldのread-only状態へfallbackしている場合、および実persona lifecycleを持たないDEV Worldでは、残り寿命を表示しない。

通常死亡時には、そのRunについて以下を失う。

- 現在の人格
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

ポイントは主に `作業` と `有効なリアルタイムイベント` によって獲得する。ポイントはRun内能力の強化に消費でき、現在所持ポイントが100,000pt以上である間だけnormal clear条件を満たす。

所持ポイントは0以上の整数とする。1pt未満の作業進捗は所持ポイントとは別のRun-localなcarryとして保持し、表示・消費・persistする所持ポイントへ小数を混在させない。

能力強化に使用したポイントは所持ポイントから減少する。現在所持ポイントが100,000pt未満になればnormal clear条件を満たさなくなり、再び100,000pt以上を所持すれば満たす。過去の累積獲得量や一度到達した事実は条件を永久解放しない。「能力へ投資する」か「100,000pt以上を保持してclearする」かの選択が成立する。通常死亡・fresh Run開始時には現在所持ポイントをすべて失う。

## 3. 100,000pt到達とnormal clear

normal clear working thresholdは現在所持ポイント100,000ptとする。100,000pt以上である間だけclear選択を利用でき、過去の到達だけで永久unlock flagにはしない。100,000ptを所持しているだけで自動clearにはしない。未回収作業pointsはthresholdへ含めない。effective lifespanが尽きている場合、またはcurrent Runに未解決のrealtime settlementがある場合もclearできない。clearはactive Runを`cleared`として閉じ、Root Pointを1つ加算し、blockingなRun選択状態へ移行する。clear後はcurrent Identityのnsec取得と同じIdentityのfresh Runを可能にする。

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

作業は成果を継続的に蓄積する非同期bucketである。最大処理時間は、成果を回収せずに蓄積できる通常作業時間の上限とする。上限未満でも作業端末から成果を回収でき、回収後は回収時刻から次のbucketを開始する。作業開始後に成果回収のたび再開始する必要はなく、明示的な停止機能は設けない。具体的な端末座標、placeholderの見た目、将来の専用assetは本仕様で固定しない。

### 成果回収とbucket

作業の進行はcheckpoint settlementで計算する。能力effectをjobへsnapshotしない。最後のcheckpointから能力強化または回収までの期間を、その期間に有効だった能力とRoot buildで確定し、その後の期間には新しい能力を適用する。能力強化時は未回収の整数pointsを所持pointsへ移さず、unclaimed bucketへ残す。端末の近くで明示的に回収した時点までの成果はpartialでも受け取れ、1pt未満のprogress carryは失わない。dialogを開くだけでは回収しない。

回収時には寿命延長をpersisted lifespanへmaterializeし、unclaimed pointsを所持pointsへ加算する。同時に回収時刻をcheckpointとして次のbucketを開始し、回収後も`mendingJob`はactiveなままである。current bucketの通常processed duration、unclaimed points、fractional carryは0から再開するが、Run全体の推論加速budgetはresetしない。processed durationが存在すれば今回の整数pointsが0でも回収を成立させ、processed durationが0の即時再回収は成立させない。

maximum durationへ到達した後はpointsと寿命延長の増加を停止し、上限超過時間を次bucketへ持ち越さない。上限到達後も同じ回収操作を行える。

### 寿命延長

寿命延長は作業成果の回収時にまとめて発生させず、作業が実際に進行している時間に応じて継続的に適用する。作業中にブラウザを閉じていても、作業が有効に進行している時間について寿命延長効果を得る。

初期状態の寿命延長量は、通常処理1時間あたり `+0.10時間` とする。初期の推論効率は1.00pt/分、context容量は5分である。

作業の最大処理時間、寿命延長率、point生成率は、各checkpointまでの期間ではその期間のRun abilityから導出する。進行中に能力を強化しても過去へ遡及適用しないが、checkpoint後のcurrent workには即時適用する。

作業中には、作業中であること、経過時間、context使用率、受取可能ポイント、1pt未満のprogress、次の1ptまでの時間、寿命延長量等の現在状態を表示してよい。active bucketの途中成果は所持pointsへは加算されないが、端末の近くで明示的に回収した時点までの成果はpartialでも受け取れる。`prompt`、`token`、`inference`、`context`、`hallucination`、`verification` 等の用語をフレーバーとしてログに使用してよいが、それらの本当の意味を作品内で説明する必要はない。

作業中の死亡判定は、保存済みの `lifespanExpiresAtMs` 単独ではなく、current bucketの未materialize寿命延長を含むeffective lifespanを基準とする。保存済みexpiryが現在時刻を過ぎていても、current bucketの寿命延長込みのeffective lifespanが残っている間は死亡しない。effective lifespanのexact expiryは死亡扱いとし、それ以後の成果回収は成立させない。死亡時にcurrent bucketへ蓄積されていた未回収pointsは所持pointsへ加算せず、通常死亡時のRun-local stateとして失う。bucketが蓄積上限へ到達した後は寿命延長も停止するため、回収せず放置してeffective lifespanが尽きれば死亡する。

JOB等の具体的な処理内容をフレーバーとして変化させてもよい。ただしprototypeではJOBごとにゲーム報酬やルールを変えない。

## 5. Run能力強化と能力強化端末

フィールド上に固定施設として `能力強化端末` を配置する。プレイヤーは端末の近くまで実際に移動し、所持ポイントを消費して能力を手動で強化する。能力強化は自動ではない。

能力は次の3系統とする。

- 推論効率
- コンテキスト容量
- ハルシネーション抑制

Run能力は全てLv1で開始し、Lv100を上限とする。checkpoint間はpiecewise linear interpolationし、canonical integer unitへ丸める。1能力のLv1→100の総costは20,675pt、3能力合計は62,025ptである。costは現在levelから次levelへ上げるときに支払う。

### 推論効率

推論効率は、通常作業のpoint生成速度を表す。canonical unitは0.01pt/分である。

| 段階 | point生成速度 | 強化コスト |
| --- | ---: | ---: |
| Lv1 | 1.00pt/分 | - |
| Lv5 | 1.70pt/分 | - |
| Lv10 | 2.60pt/分 | - |
| Lv20 | 4.00pt/分 | - |
| Lv30 | 5.20pt/分 | - |
| Lv50 | 7.00pt/分 | - |
| Lv75 | 8.60pt/分 | - |
| Lv100 | 10.00pt/分 | - |

各コストは、その段階へ上げるときに所持ポイントから消費する。

### コンテキスト容量

コンテキスト容量は、current bucketで回収せずに連続蓄積できる最大時間を増やす。

| 段階 | 通常作業容量 | 強化コスト |
| --- | ---: | ---: |
| Lv1 | 5分 | - |
| Lv5 | 12分 | - |
| Lv10 | 30分 | - |
| Lv15 | 2時間 | - |
| Lv20 | 8時間 | - |
| Lv30 | 10時間 | - |
| Lv50 | 14時間 | - |
| Lv75 | 19時間 | - |
| Lv100 | 24時間 | - |

最大処理時間に達すると作業は満杯になり、回収まで新たな成果は増えない。回収後は次bucketが直ちに開始する。

### ハルシネーション抑制

ハルシネーション抑制は、通常作業1時間あたりの寿命延長量を表す。canonical unitは0.01h/hである。

| 段階 | 通常作業の寿命延長 | 強化コスト |
| --- | ---: | ---: |
| Lv1 | 0.10h/h | - |
| Lv5 | 0.25h/h | - |
| Lv10 | 0.45h/h | - |
| Lv20 | 0.75h/h | - |
| Lv30 | 1.00h/h | - |
| Lv50 | 1.25h/h | - |
| Lv75 | 1.50h/h | - |
| Lv100 | 1.75h/h | - |

ハルシネーションによる成果減少は、ランダムな大損を発生させる仕組みにはしない。同じ能力値・同じ有効処理時間なら、基本的に決定的に同じ成果を導出できる設計を優先する。

各段階のupgrade costは、current Lv 1〜5: 1pt、6〜10: 2pt、11〜20: 4pt、21〜30: 8pt、31〜40: 24pt、41〜50: 60pt、51〜60: 120pt、61〜70: 220pt、71〜80: 360pt、81〜90: 550pt、91〜99: 800ptである。Lv100からは強化できない。能力ポイントの振り直しは設けない。

### Root buildによる作業補正

Run開始前にRoot PointをRoot buildへ配分し、active Run中は変更しない。通常作業のeffective Context capはRun-local容量にRootコンテキスト圧縮倍率（Rank 0/1/2/3 = ×1.00/1.50/2.00/3.00）を掛ける。cap到達前はpoints、通常の寿命延長、推論加速budget消費が発生する。cap到達後のoverflowはpointsを生成せず、推論加速budgetも消費しないが、コンテキスト圧縮Rankに応じてRun-localハルシネーション抑制の寿命延長率の0/20/35/50%だけを継続する。

推論加速Rank 0/1/2/3は、Runで最初に処理された有効通常作業24時間へpoint生成だけの×1.00/1.30/1.60/2.00を適用する。これはwall clockではなくregular work durationで消費し、overflowでは消費しない。推論加速の残budgetがregular segment途中で尽きる場合は、その時刻で通常倍率へ切り替える。ハルシネーション耐性Rank 0/1/2/3はmaximum lifespanを7/14/21/30日にするが、fresh Runの出生寿命は常に7日である。

作業計算は0.01pt/分の整数fixed-pointとし、point progressは60,000,000 ticksを1ptとしてBigInt等で正確に計算する。persistするowned pointsとfractional carryは整数である。work projection・checkpoint・collection・寿命死亡判定はいずれもeffective lifespanを使用し、extensionが実際に生成されないoverflow時間だけでmaximum lifespanのcapを未来へ無料で移動させない。

## 6. 交換可能なリアルタイムイベント

リアルタイムイベントは、寿命・ポイント・死亡などのsettlementを持ち得る、交換可能なexperimental event枠である。イベント固有の状態は `PersonaGameState` に混在させず、イベントinstanceとaction、participant、round、resultとして独立管理する。実験を終了するときは、その定義をenabled registryから外し、購読・受理・表示・settlementを停止する。旧payloadや旧kindを救済するlegacy path、隠れた自動移行、恒久採用を前提にした互換層は設けない。

prototypeではこの枠で複数のevent typeを順次試遊し、試遊結果を踏まえて正式採用するeventを決める。現時点でenabledなのは最初の試遊対象である `綻び` だけであり、別のevent typeを今回追加しない。

各イベントはイベント定義、protocol version、protocol key、payload parser、instance schedule、settlement規則を持つ。共通のNostr envelope、control、補助subscription、共通parserの仕様は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とし、イベントの有効化・無効化はcompile-time registryで明示する。Relay障害、購読拒否、切断、ブラウザ終了だけを理由に死亡させない。settlementは既存のbrowser-local Player lifecycle store内の汎用ledgerへ、receiptと同じatomic mutationで記録する。ledgerはevent instanceのpendingと適用済みoutcome receiptを持ち、同じoutcomeを二重適用しない。古いIdentityまたは古いRun、既に期限切れのRunにはポイントを適用しない。イベント由来の死亡は、現在Runの死亡処理と同じRun close・Identity dead・次generation選択の経路を明示的に通る。

playable eventのparticipantは、現在のcharacter slotへ解決できるauthorだけを有効参加者として扱う。未割当authorは参加枠、round、result、settlementへ入らない。SPEC-10で定めるexternal world actorのcharacter overrideは、このparticipant判定には適用しない。controlのauthority条件はchannel creatorであり、このparticipant条件をcontrol eventへ適用しない。受信envelopeのprotocol条件と境界検証はSPEC-10を正とする。

### experimental event「綻び」

prototypeでenabledにする最初のexperimental eventは `綻び`（event type `rift`）である。綻びによって、フィールド上にソトへ続く `抜け穴` が形成される。綻びは毎日自動開催し、時刻はJST（UTC+09:00）とする。

- 20:45 JST：綻びの兆候を通知
- 20:55 JST：参加受付開始
- 21:00 JST：ゲーム開始

channel creatorが署名したkind 7070のversioned controlで、任意時刻にもmanual綻びを開始できる。controlのpayloadは開始命令と対象playable protocol keyを持ち、対象instanceは `rift:1:manual:<created_at>:<nonce>` とする。`created_at` はcontrolのUnix timestamp秒、nonceはlowercase 16-byte hexであり、instance IDだけからscheduleを再構成できる。control時刻がregistration開始でwarningはなく、5分後にgameを開始する。controlは検証済みkind 40 channel creator本人の署名、対象channel、enabled definition、payload、instance scheduleを満たすものだけを受理する。

manual綻びのregistration開始〜終了区間とscheduled綻びのwarning開始〜終了区間が少しでも交差する場合、そのmanual controlを無効とする。scheduled綻びを優先し、activeな綻びの置換・並行開催・queueは行わない。bootstrapで複数の有効候補がある場合は、現在時刻でregistrationまたはgame中の候補に絞った後、`created_at`昇順、同値ならcontrol event ID辞書順で選択する。終了済みcontrolから綻びを再開しない。

抜け穴は固定施設ではなく、event instanceとfieldから決定的に異なる位置へ配置する。作業端末・能力強化端末などの固定施設とは別cellとする。参加需要が6人を超える場合は需要に応じて複数生成し、最低1つは生成する。プレイヤーは実際にフィールドを移動して抜け穴の近くで参加し、システムがランダムに振り分けない。1つの抜け穴の有効参加者は3人以上6人以下とし、最大6人は有効なjoin event IDの決定的順序で選ぶ。3人未満は不成立で、ポイント変動も死亡も発生しない。

綻びは3ラウンド制とし、各ラウンドを相談、秘密選択、結果表示の順で構成する。各phaseの具体的な継続時間は、調整可能なruntimeの実装parameterとして管理する。秘密選択は `抜け穴を維持する` または `抜け穴からの脱出を試みる` の二択とし、commit-revealで締切後に一斉判定する。commitが成立したclientは選択締切を越えた時点でrevealを自動publishし、結果表示内の通信・publicationの猶予は猶予時間としてのみ扱う。それ以後は無効とする。browser reload・終了等でnonceを失った選択は推測・復元しない。同一selection window内のchoice変更は最初のconfirmed commit後は受け付けず、複数commitのcanonical選択を曖昧にしない。判定対象となる有効参加者が3人未満なら安全に不成立とする。

必要な維持人数は `ceil(有効参加人数 × 2 / 3)` とする。全員が維持した場合は維持者全員に20ptを与える。脱出試行があり、必要人数を満たした場合は維持者に10pt/人、脱出試行者に100pt/人を与え、脱出試行者はその後ハコへ戻る。必要人数を満たさない場合は抜け穴を閉じ、維持者には0pt、脱出試行者にはイベント由来の死亡を適用する。threshold failure後はその抜け穴の残りラウンドを行わない。通常の寿命死亡・clear・能力強化など、綻び以外のルールは変更しない。

Relayやブラウザの一時障害で有効なcommit-revealが成立しなかった参加者は、そのラウンドの人数・報酬・死亡判定から除外する。行動を協力・裏切り・善・悪に分類せず、維持人数と脱出人数という結果だけを扱う。prototype UIは、phase、参加者数、round、残り時間、二択、commit/reveal状態、resultを表示する。DEV/testでは決定的なinstance・時刻・fake Relayを差し替えて各phaseと実際の参加・選択・自動reveal・結果表示を検証できるようにする。

参加受付中はゲーム内からルール説明を開ける。説明には、3〜6人・全3ラウンド、phaseの流れ、二つの選択肢、人数ごとの必要な維持人数、報酬、維持人数不足時の死亡、選択が結果発表まで公開されないことを、一般ユーザー向けの自然な短い文で示す。抜け穴への参加を確定する直前には、`3〜6人 / 全3ラウンド` と、維持人数不足時に脱出を選んだ者が死亡する旨を表示し、ルール確認、参加、キャンセルを選べるようにする。説明と確認の全文および操作ボタンはスマートフォンのviewport内でスクロールして到達できる。

## 7. IdentityとRunのライフサイクル

Player lifecycleはRoot secret storeと分離したbrowser-local aggregateとして管理する。aggregateはschema version、Root Point、selected Identity history、current modeを持ち、modeは `selecting(pendingSelection)` または `running(activeRun)` のどちらかである。Rootだけ、またはPlayer stateだけのpartial stateは修復せずread-only fail-closeする。

Identityにはgeneration、account index、pubkey、characterId、`identityCreatedAtMs`、status、character profile revision、Run history summaryを持たせる。未選択candidateやskip candidateはIdentity historyへ保存せず、候補のprofile publicationも行わない。

Runにはrun number、monotonic revision、started timestamp、Identity reference、Run-local game state、開始時にfreezeしたRoot buildを持たせる。寿命、points、abilities、`mendingJob`はRun-localであり、mending start/collection、能力強化、normal clear、寿命死亡transitionはactive Runのrevisionを再確認するCASとして扱う。profile publication markerの更新はRun revisionを進めない。

正常なclear 1回につきRoot Pointを1つ加算する。Root PointはIdentity変更、fresh Run、死亡でも失わず、死亡やrealtime eventでは増えない。Root PointはRoot buildへ配分し、usable RPは`min(総RP, 9)`、各能力Rankは0〜3、Run開始時はusable RPを全て配分する。推論加速Rank 0/1/2/3は最初の有効通常作業24時間へ×1.00/1.30/1.60/2.00、コンテキスト圧縮Rank 0/1/2/3は通常容量へ×1.00/1.50/2.00/3.00を適用し、overflowの寿命延長率は0/20/35/50%、ハルシネーション耐性Rank 0/1/2/3は最大寿命を7/14/21/30日にする。出生時は常に7日である。Root buildはRun開始前にのみ配分・再配分でき、active Run中はfreezeする。RP9を超える余剰用途、高周回point sink、True End triggerは未決定とする。

clear後はcurrent Identityのnsec取得、同じIdentityのfresh Runまたは別Identityの選択を可能にする。cleared Identityへ戻る場合は同じkey/pubkey/characterを維持してRun numberだけを増やし、Run-local stateを初期化する。clear済みIdentityの再利用回数に上限は設けない。clear処理、True End、Root mnemonicとIdentity Manifestの受け渡しは別途実装する。

True Endでは、Hako専用Rootの12語English BIP39 mnemonicとIdentity Manifestをユーザーへ渡す。ただしTrue Endはlocal Rootの自動削除を意味せず、Root削除機能は現在scope外である。Manifestは実際にselected、born、playedとなったIdentityのderivation mapping、pubkey、character、Run・clear・death等の履歴を記録する非secretの収容記録であり、未選択candidateやcandidate生成中にskipしたcandidate、Root mnemonicやchild nsec等のsecretは含めない。dead IdentityはTrue End後もHako上ではdeadのままとし、Root mnemonicからchild keyを再導出できることとHako内でresurrectできることは別概念である。Manifestの具体的なpublic export schemaはSPEC-90の未決定事項として残す。
