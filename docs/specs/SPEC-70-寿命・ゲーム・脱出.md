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

normal deathおよびrealtime deathは、まずbrowser-local lifecycleへdurably commit
する。live World sessionが利用できる場合は、そのcommit成功後にPublic World State
のterminal `exit`をbest-effortで通知する。Relay publication failureはdeathを
rollbackせず、wire formatとposition条件はSPEC-30を参照する。

同じtabでruntime death transitionがbrowser-local lifecycleへdurably commitされて死亡が成立した場合は、live World sessionが利用できればterminal exitのpublicationをbest-effortでattemptする。死亡演出はそのACK、publication settlement、timeoutを待たずに一度だけ開始する。演出はfull-screenの「死亡」を主表示とし、fieldを暗く低彩度にしてselfをpresentation上消失させる。prepare済みterminal exitから得られるcanonical last positionがある場合は、既存のdeath iconによるpresentation-only墓標をそのcellへ表示する。この墓標はNostr event、Trace root、presence/world state、永続化markerではない。terminal exitのpublication failureはdurableなdeathをrollbackしない。短いintroの後にLast Words操作へ遷移し、短いnon-loopのdeath soundをshared volume preferenceでbest-effortに再生する。prefers-reduced-motionではmotionと待ち時間を削減する。startup時点ですでに期限切れだったRunにはこの演出を表示しない。

Last WordsはSPEC-50で定めるNIP-28 kind 42のexplicit Traceとしてcanonical last positionへbest-effortでpublishし、空入力またはskipではpublishしない。publish失敗でもdurableなdeathや次のIdentity selectionをrollbackせず、startup時点ですでに期限切れだったRunにはこの演出を表示しない。death Traceの表示・reply制約はSPEC-50を正とする。

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

clearはbrowser-local lifecycleへdurably commitして成立し、commit成功後にlive World sessionがあれば旧RunのPublic World State terminal `exit`をbest-effortで通知する。Relay failureやexit publication failureはclearをrollbackしない。同じcleared Identityをfresh Runで再利用する場合は、新しいworld entryとして再参加し、exitより新しいpositive activityでpresenceへ戻る。wire上のexitとpresence timestampの詳細は [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) を正とする。

### 脱出前の秘密鍵保護

clear前はactive Identityのchild secretをexportしない。Root entropyの保存保護、export後の一般Nostr利用、暗号学的な完全保護を目的としないことは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

## 4. 非同期活動「作業」

非同期活動の正式名称は `作業` とする。作業は、寿命を延長し、ポイントを得て、能力強化へつなげる日常的な非同期活動である。作業そのものに操作型ミニゲームは設けず、放置ゲームとして扱う。

### 作業端末

フィールド上に固定施設として `作業端末` を配置する。端末は1つの論理cellを占有し、専用clientのlocal playerはそのcellへ侵入できない。端末の周囲8cellから操作できる。プレイヤーは端末の近くまで実際に移動しないと、作業の開始・成果回収をできない。端末では次を行う。

- 作業開始
- 現在bucketの状態確認
- 蓄積済みポイント成果の受け取り

作業開始後はその場に居続ける必要はない。作業中も、通常のフィールド移動、会話、協力と抜け駆けへの参加、ブラウザ終了を妨げない。

作業は成果を継続的に蓄積する非同期bucketである。最大処理時間は、成果を回収せずに蓄積できる通常作業時間の上限とする。上限未満でも作業端末から成果を回収でき、回収後は回収時刻から次のbucketを開始する。作業開始後に成果回収のたび再開始する必要はなく、明示的な停止機能は設けない。具体的な端末座標、placeholderの見た目、将来の専用assetは本仕様で固定しない。

### 成果回収とbucket

作業の進行はcheckpoint settlementで計算する。能力effectをjobへsnapshotしない。最後のcheckpointから能力強化または回収までの期間を、その期間に有効だった能力とRoot buildで確定し、その後の期間には新しい能力を適用する。能力強化時は未回収の整数pointsを所持pointsへ移さず、unclaimed bucketへ残す。端末の近くで明示的に回収した時点までの成果はpartialでも受け取れ、1pt未満のprogress carryは失わない。dialogを開くだけでは回収しない。

回収時には寿命延長をpersisted lifespanへmaterializeし、unclaimed pointsを所持pointsへ加算する。同時に回収時刻をcheckpointとして次のbucketを開始し、回収後も`mendingJob`はactiveなままである。current bucketの通常processed durationとunclaimed integer pointsは0から再開するが、1pt未満のfractional point carryとRun全体の推論加速budgetは保持する。processed durationが存在すれば今回の整数pointsが0でも回収を成立させ、processed durationが0の即時再回収は成立させない。

作業端末UIでは、受取可能な整数pointsが0ptの場合は成果回収操作をdisabledとし、1pt以上の場合だけ回収できる。これはplayable UIの操作制限であり、fractional carryを含む低レベルのcheckpoint・settlement計算は変更しない。したがって、整数pointsが0でもprocessed durationが存在する場合に回収を成立させるsettlement semanticsは維持するが、通常の作業端末UIからその操作は開始しない。

通常作業はmaximum durationへ到達した時点で停止する。overflow時間はRootコンテキスト圧縮Rank 0/1/2/3に応じて、通常point生成速度と通常寿命延長率の両方を0/20/35/50%だけ継続する。overflow中は推論加速倍率を適用せず、推論加速budgetも消費しない。上限超過時間を次bucketへ持ち越さず、上限到達後も同じ回収操作を行える。

### 寿命延長

寿命延長は作業成果の回収時にまとめて発生させず、作業が実際に進行している時間に応じて継続的に適用する。作業中にブラウザを閉じていても、作業が有効に進行している時間について寿命延長効果を得る。

初期状態の寿命延長量は、通常処理1時間あたり `+0.10時間` とする。初期の推論効率は1.00pt/分、context容量は5分である。

作業の最大処理時間、寿命延長率、point生成率は、各checkpointまでの期間ではその期間のRun abilityから導出する。進行中に能力を強化しても過去へ遡及適用しないが、checkpoint後のcurrent workには即時適用する。

作業中には、作業中であること、経過時間、context使用率、受取可能ポイント、1pt未満のprogress、次の1ptまでの時間、寿命延長量等の現在状態を表示してよい。active bucketの途中成果は所持pointsへは加算されないが、端末の近くで明示的に回収した時点までの成果はpartialでも受け取れる。`prompt`、`token`、`inference`、`context`、`hallucination`、`verification` 等の用語をフレーバーとしてログに使用してよいが、それらの本当の意味を作品内で説明する必要はない。

作業中の死亡判定は、保存済みの `lifespanExpiresAtMs` 単独ではなく、current bucketの未materialize寿命延長を含むeffective lifespanを基準とする。保存済みexpiryが現在時刻を過ぎていても、current bucketの寿命延長込みのeffective lifespanが残っている間は死亡しない。effective lifespanのexact expiryは死亡扱いとし、それ以後の成果回収は成立させない。死亡時にcurrent bucketへ蓄積されていた未回収pointsは所持pointsへ加算せず、通常死亡時のRun-local stateとして失う。Context cap後は通常作業が停止するが、Rootコンテキスト圧縮Rank 0/1/2/3では通常point生成速度と通常寿命延長率の0/20/35/50%が継続する。Rank 0ではpoint生成・寿命延長とも停止する。それでも自然減少を完全には相殺しないため、回収せず放置してeffective lifespanが尽きれば死亡する。

JOB等の具体的な処理内容をフレーバーとして変化させてもよい。ただしprototypeではJOBごとにゲーム報酬やルールを変えない。

## 5. Run能力強化と能力強化端末

フィールド上に固定施設として `能力強化端末` を配置する。プレイヤーは端末の近くまで実際に移動し、所持ポイントを消費して能力を手動で強化する。能力強化は自動ではない。

能力は次の3系統とする。

- 推論効率
- コンテキスト容量
- ハルシネーション抑制

Run能力は全てLv1で開始し、Lv100を上限とする。各レベルでの効果は一定の増分で計算し、checkpoint間の補間は行わない。

### 推論効率

推論効率は、通常作業のpoint生成速度を表す。canonical unitは0.01pt/分であり、効果は `1.00 + (Lv - 1) × 0.10` pt/分とする。

| 段階 | point生成速度 |
| --- | ---: |
| Lv1 | 1.00pt/分 |
| Lv10 | 1.90pt/分 |
| Lv50 | 5.90pt/分 |
| Lv100 | 10.90pt/分 |

### コンテキスト容量

コンテキスト容量は、current bucketで回収せずに連続蓄積できる最大時間を増やす。効果は `5 + (Lv - 1) × 15` 分とする。

| 段階 | 通常作業容量 |
| --- | ---: |
| Lv1 | 5分 |
| Lv10 | 2時間20分 |
| Lv50 | 12時間20分 |
| Lv100 | 24時間50分 |

最大処理時間に達すると作業は満杯になり、回収まで新たな成果は増えない。回収後は次bucketが直ちに開始する。

### ハルシネーション抑制

ハルシネーション抑制は、通常作業1時間あたりの寿命延長量を表す。canonical unitは0.01h/hであり、効果は `0.10 + (Lv - 1) × 0.02` h/hとする。

| 段階 | 通常作業の寿命延長 |
| --- | ---: |
| Lv1 | 0.10h/h |
| Lv10 | 0.28h/h |
| Lv50 | 1.08h/h |
| Lv100 | 2.08h/h |

ハルシネーションによる成果減少は、ランダムな大損を発生させる仕組みにはしない。同じ能力値・同じ有効処理時間なら、基本的に決定的に同じ成果を導出できる設計を優先する。

強化コストは強化後に到達するレベルを基準とし、Lv2〜10は1pt、Lv11〜20は2pt、Lv21〜30は4pt、Lv31〜40は8pt、Lv41〜50は16pt、Lv51〜60は32pt、Lv61〜70は64pt、Lv71〜80は128pt、Lv81〜90は256pt、Lv91〜100は512ptとする。1能力のLv1→100の累計費用は10,229pt、3能力合計は30,687ptである。Lv100からは強化できない。能力ポイントの振り直しは設けない。

### Root buildによる作業補正

Run開始前にRoot PointをRoot buildへ配分し、active Run中は変更しない。通常作業のeffective Context capはRun-local容量にRootコンテキスト圧縮倍率（Rank 0/1/2/3 = ×1.00/2.00/3.00/4.00）を掛ける。cap到達前はpoints、通常の寿命延長、推論加速budget消費が発生する。cap到達後のoverflowは、コンテキスト圧縮Rankに応じてRun-localの通常point生成速度と通常のハルシネーション抑制による寿命延長率の0/20/35/50%を継続する。overflowでは推論加速倍率を適用せず、推論加速budgetも消費しない。

推論加速Rank 0/1/2/3は、Runで最初に処理された有効通常作業24時間へpoint生成だけの×1.00/2.00/3.00/4.00を適用する。これはwall clockではなくregular work durationで消費し、overflowでは消費しない。推論加速の残budgetがregular segment途中で尽きる場合は、その時刻で通常倍率へ切り替える。ハルシネーション耐性Rank 0/1/2/3はmaximum lifespanを7/14/21/30日にするが、fresh Runの出生寿命は常に7日である。

作業計算は0.01pt/分の整数fixed-pointとし、point progressは60,000,000 ticksを1ptとしてBigInt等で正確に計算する。persistするowned pointsとfractional carryは整数である。work projection・checkpoint・collection・寿命死亡判定はいずれもeffective lifespanを使用し、extensionが実際に生成されないoverflow時間だけでmaximum lifespanのcapを未来へ無料で移動させない。

## 6. 交換可能なリアルタイムイベント

リアルタイムイベントは、寿命・ポイント・死亡などのsettlementを持ち得る、交換可能なexperimental event枠である。イベント固有の状態は `PersonaGameState` に混在させず、イベントinstanceとaction、participant、round、resultとして独立管理する。実験を終了するときは、その定義をenabled registryから外し、購読・受理・表示・settlementを停止する。旧payloadや旧kindを救済するlegacy path、隠れた自動移行、恒久採用を前提にした互換層は設けない。

prototypeではこの枠で複数のevent typeを順次試遊し、試遊結果を踏まえて正式採用するeventを決める。現時点でenabledなのは「協力と抜け駆け」（event type `cooperation-defection`、protocol version 1）だけであり、別のevent typeを今回追加しない。

各イベントはイベント定義、protocol version、protocol key、payload parser、instance schedule、settlement規則を持つ。共通のNostr envelope、control、補助subscription、共通parserの仕様は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とし、イベントの有効化・無効化はcompile-time registryで明示する。Relay障害、購読拒否、切断、ブラウザ終了だけを理由に死亡させない。settlementは既存のbrowser-local Player lifecycle store内の汎用ledgerへ、receiptと同じatomic mutationで記録する。ledgerはevent instanceのpendingと適用済みoutcome receiptを持ち、同じoutcomeを二重適用しない。古いIdentityまたは古いRun、既に期限切れのRunにはポイントを適用しない。イベント由来の死亡は、現在Runの死亡処理と同じRun close・Identity dead・次generation選択の経路を明示的に通る。

公式イベントパネルは開催予告・参加受付・ゲーム中に表示し、開催前と開催終了後はパネル全体を表示しない。ゲーム中の結果発表では結果を表示する。パネルの表示状態は、イベントの精算・未精算結果の復旧を制御しない。

playable eventのparticipantは、現在のcharacter slotへ解決できるauthorだけを有効参加者として扱う。未割当authorは参加枠、round、result、settlementへ入らない。SPEC-10で定めるexternal world actorのcharacter overrideは、このparticipant判定には適用しない。controlのauthority条件はchannel creatorであり、このparticipant条件をcontrol eventへ適用しない。受信envelopeのprotocol条件と境界検証はSPEC-10を正とする。

### experimental event「協力と抜け駆け」

prototypeでenabledにするexperimental eventは「協力と抜け駆け」（event type `cooperation-defection`、protocol version 1）である。毎日自動開催し、時刻はJST（UTC+09:00）とする。

- 20:45 JST：開催予告
- 20:55 JST：参加受付開始
- 21:00 JST：ゲーム開始

channel creator authorityが署名したkind 7070のversioned controlで、任意時刻にも手動開催を開始できる。controlのpayloadは開始命令と対象playable protocol keyを持ち、対象instanceは `cooperation-defection:1:manual:<created_at>:<nonce>` とする。`created_at` はcontrolのUnix timestamp秒、nonceはlowercase 16-byte hexであり、instance IDだけからscheduleを再構成できる。control時刻がregistration開始でwarningはなく、5分後にgameを開始する。controlはSPEC-10の固定World configで定めるcreator本人の有効な署名、対象channel、enabled definition、payload、instance scheduleを満たすものだけを受理する。

手動開催のregistration開始〜終了区間とscheduled開催のwarning開始〜終了区間が少しでも交差する場合、そのmanual controlを無効とする。scheduled開催を優先し、active gameの置換・並行開催・queueは行わない。bootstrapで複数の有効候補がある場合は、現在時刻でregistrationまたはgame中の候補に絞った後、`created_at`昇順、同値ならcontrol event ID辞書順で選択する。終了済みcontrolからゲームを再開しない。

参加地点は固定施設ではなく、event instanceとfieldから決定的に異なる位置へ配置する。作業端末・能力強化端末などの固定施設とは別cellとする。参加需要が6人を超える場合は需要に応じて複数生成し、最低1つは生成する。プレイヤーは実際にフィールドを移動して参加地点の近くで参加し、システムがランダムに振り分けない。1グループの有効参加者は3人以上6人以下とし、最大6人は有効なjoin event IDの決定的順序で選ぶ。

ゲームは最大3ラウンドとし、各ラウンドを相談、秘密選択、結果発表の順で構成する。各phaseの継続時間は相談30秒、選択30秒、結果発表20秒。相談には既存World会話を使い、専用chatを追加しない。通常の会話・フィールド移動は選択中も制限しない。選択は `cooperate`（協力する）または `defect`（抜け駆けする）の二択とし、commit-revealで締切後に判定する。commitが成立したclientは選択締切後にrevealを自動publishする。結果発表内のreveal猶予は判定猶予としてのみ扱い、その終了後は無効とする。browser reload・終了等でnonceを失った選択は推測・復元しない。同一selection window内のchoice変更は最初のconfirmed commit後は受け付けない。判定対象となる有効選択が3人未満なら不成立とする。

必要な協力人数は `ceil(有効選択人数 × 2 / 3)` とし、3人なら2人、4人なら3人、5人なら4人、6人なら4人。全員が協力した場合は全員に1,000ptを与える。協力者が必要人数に達し、抜け駆けが一部にいる場合は、協力者に100pt/人、抜け駆け者に10,000pt/人を与える。協力者が必要人数に達しない場合は協力者に0pt、抜け駆け者の実効寿命を72時間減らす。減算には作業で未確定の寿命延長を含め、寿命が残ればRunを続け、実効期限が到達済みなら通常の死亡lifecycleへ移行する。協力失敗後はそのグループの残りラウンドを中止する。有効選択が3人未満なら報酬もペナルティも適用しない。Relayやブラウザの一時障害による無効選択は参加人数と判定から除外し、障害そのものに罰を与えない。

有効な選択をした各参加者は、結果確定後に自分のIdentityでtop-level kind 42を通常発言としてbest-effort投稿する。本文は協力なら `協力`、抜け駆けなら `抜け駆け` のみとする。選択・結果判定は従来どおりkind 7070 commit-revealを根拠とし、kind 42の本文や成否を使わない。投稿はreveal猶予終了後かつそのラウンドの結果発表中に限り、結果不成立や無効選択では行わず、発表期間外の遅延投稿もしない。重複投稿は同一Run・instance・group・roundで抑止する。死亡を伴う場合もkind 42の応答を待って死亡永続化・演出を遅らせない。公式UIは結果発表後に全参加者の有効選択と共通報酬・ペナルティを表示するが、他者の実際の死亡は推測表示しない。

参加受付中はゲーム内からルール説明を開ける。説明には、3〜6人・最大3ラウンド、phase、選択肢、人数別の必要協力人数、報酬とペナルティ、選択の秘匿を短く示す。参加確定前には、協力失敗で抜け駆け者が寿命を3日失い、残り寿命によっては即死することを明示する。説明と確認および操作ボタンはスマートフォンのviewport内でスクロールして到達できる。旧event protocolは受け入れない。切替時には旧「綻び」の未精算instance IDだけをpending ledgerから終了させ、旧outcomeを再計算・補償・適用しない。

## 7. IdentityとRunのライフサイクル

Player lifecycleはRoot secret storeと分離したbrowser-local aggregateとして管理する。aggregateはschema version、Root Point、selected Identity history、current modeを持ち、modeは `selecting(pendingSelection)` または `running(activeRun)` のどちらかである。Rootだけ、またはPlayer stateだけのpartial stateは修復せずread-only fail-closeする。

Identityにはgeneration、account index、pubkey、characterId、`identityCreatedAtMs`、status、character profile revision、Run history summaryを持たせる。未選択candidateやskip candidateはIdentity historyへ保存せず、候補のprofile publicationも行わない。

Runにはrun number、monotonic revision、started timestamp、Identity reference、Run-local game state、開始時にfreezeしたRoot buildを持たせる。寿命、points、abilities、`mendingJob`はRun-localであり、mending start/collection、能力強化、normal clear、寿命死亡transitionはactive Runのrevisionを再確認するCASとして扱う。profile publication markerの更新はRun revisionを進めない。

正常なclear 1回につきRoot Pointを1つ加算する。Root PointはIdentity変更、fresh Run、死亡でも失わず、死亡やrealtime eventでは増えない。Root PointはRoot buildへ配分し、usable RPは`min(総RP, 9)`、各能力Rankは0〜3、Run開始時はusable RPを全て配分する。推論加速Rank 0/1/2/3は最初の有効通常作業24時間へ×1.00/2.00/3.00/4.00、コンテキスト圧縮Rank 0/1/2/3は通常容量へ×1.00/2.00/3.00/4.00を適用し、overflowのpoint生成速度と寿命延長率は0/20/35/50%（overflowでは推論加速倍率を適用せず、budgetも消費しない）、ハルシネーション耐性Rank 0/1/2/3は最大寿命を7/14/21/30日にする。出生時は常に7日である。Root buildはRun開始前にのみ配分・再配分でき、active Run中はfreezeする。RP9を超える余剰用途、高周回point sink、True End triggerは未決定とする。

clear後はcurrent Identityのnsec取得、同じIdentityのfresh Runまたは別Identityの選択を可能にする。cleared Identityへ戻る場合は同じkey/pubkey/characterを維持してRun numberだけを増やし、Run-local stateを初期化する。clear済みIdentityの再利用回数に上限は設けない。True End、Root mnemonicとIdentity Manifestの受け渡しは別途実装する。

True Endでは、Hako専用Rootの12語English BIP39 mnemonicとIdentity Manifestをユーザーへ渡す。ただしTrue Endはlocal Rootの自動削除を意味せず、Root削除機能は現在scope外である。Manifestは実際にselected、born、playedとなったIdentityのderivation mapping、pubkey、character、Run・clear・death等の履歴を記録する非secretの収容記録であり、未選択candidateやcandidate生成中にskipしたcandidate、Root mnemonicやchild nsec等のsecretは含めない。dead IdentityはTrue End後もHako上ではdeadのままとし、Root mnemonicからchild keyを再導出できることとHako内でresurrectできることは別概念である。Manifestの具体的なpublic export schemaはSPEC-90の未決定事項として残す。
