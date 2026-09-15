# 寿命・ゲーム・脱出仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。ゲーム進行、寿命、ポイント、繕い、綻び、脱出、Identity、Runは本資料を正とする。

アカウント、秘密鍵、Nostr identityそのもの、および一般Nostrへの持ち出しは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。本資料はそれらのゲーム進行上の扱いだけを定め、Nostr eventのkind、tag、schema、transport方式は定めない。

## 1. 基本進行

新しい人格には、出生時に現実時間7日の寿命を与える。寿命の上限は14日とする。寿命は現実時間とともに減少し、0になると死亡する。

現在人格が利用可能な通常状態では、プレイヤーはフィールド画面上で現在人格の残り寿命を常時確認できる。残り寿命の表示は、保存された寿命期限とactiveな繕いを含む実効寿命期限から導出する。人格のgame stateがmissing・corrupt等で利用できずpublic worldのread-only状態へfallbackしている場合、および実persona lifecycleを持たないDEV Worldでは、残り寿命を表示しない。

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

ポイントは主に `繕い` と `綻び` によって獲得する。ポイントは能力強化に消費でき、現在所持ポイントが1000pt以上である間だけ脱出条件を満たす。

能力強化に使用したポイントは所持ポイントから減少する。現在所持ポイントが1000pt未満になれば脱出条件を満たさなくなり、再び1000pt以上を所持すれば満たす。過去に一度1000ptへ到達したこと自体は、脱出条件を永久に解放するflagとして扱わない。「能力へ投資する」か「1000pt以上を所持して脱出する」かの選択が成立する。通常死亡・転生時には現在所持ポイントをすべて失う。

## 3. 1000pt到達と脱出

normal clear working thresholdは現在所持ポイント1000ptとする。1000pt以上である間だけclear選択を利用でき、過去の到達だけで永久unlock flagにはしない。1000pt以上を所持しているだけで自動clearにはしない。clear後はcurrent Identityのnsec取得を可能にする。

### 脱出前の秘密鍵保護

clear前はactive Identityのchild secretをexportしない。Root entropyの保存保護、export後の一般Nostr利用、暗号学的な完全保護を目的としないことは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

## 4. 非同期活動「繕い」

非同期活動の正式名称は `繕い` とする。繕いは、寿命を延長し、ポイントを得て、能力強化へつなげる日常的な非同期活動である。繕いそのものに操作型ミニゲームは設けず、放置ゲームとして扱う。

### 繕い端末

フィールド上に固定施設として `繕い端末` を配置する。端末は1つの論理cellを占有し、専用clientのlocal playerはそのcellへ侵入できない。端末の周囲8cellから操作できる。プレイヤーは端末の近くまで実際に移動しないと、繕いの開始・成果回収をできない。端末では次を行う。

- 繕い開始
- 現在bucketの状態確認
- 蓄積済みポイント成果の受け取り

繕い開始後はその場に居続ける必要はない。繕い中も、通常のフィールド移動、会話、綻びへの参加、ブラウザ終了を妨げない。

繕いは成果を継続的に蓄積する非同期bucketである。最大処理時間は1回のJOB完了待ち時間ではなく、成果を回収せずに蓄積できる処理時間の上限とする。上限未満でも繕い端末から成果を回収でき、回収後は回収時刻から次のbucketを開始する。繕い開始後に成果回収のたび再開始する必要はなく、明示的な停止機能は設けない。具体的な端末座標、placeholderの見た目、将来の専用assetは本仕様で固定しない。

### 成果回収とbucket

繕い開始時に、最大蓄積時間、寿命延長率、ポイント率をabilityからsnapshotする。端末の近くであれば上限未満でも、その時点までのprocessed durationに対応する寿命延長とfractional pointsを1回のatomic mutationで回収できる。dialogを開くだけでは回収せず、途中終了や途中からの再開始操作は設けない。

回収時には寿命延長をpersisted lifespanへmaterializeし、pointsを所持pointsへ加算する。同時に回収時刻を開始時刻として次のbucketを作成し、次bucketは回収時点の最新ability levelsをsnapshotする。回収後も`mendingJob`はactiveなままであり、蓄積時間と受取可能pointsは0から再開する。processed durationが0でpointsが存在しない回収は成立させない。

maximum durationへ到達した後はpointsと寿命延長の増加を停止し、上限超過時間を次bucketへ持ち越さない。上限到達後も同じ回収操作を行える。

### 寿命延長

寿命延長は繕い成果の回収時にまとめて発生させず、繕いが実際に進行している時間に応じて継続的に適用する。繕い中にブラウザを閉じていても、繕いが有効に進行している時間について寿命延長効果を得る。

初期状態の寿命延長量は、処理1時間あたり `+0.8時間` とする。

繕いの最大処理時間、寿命延長率、ポイント率は開始時点の能力値で固定する。進行中に能力を強化しても、そのjobへ遡及適用しない。

繕い中には、繕い中であること、経過時間、context使用率、受取可能ポイント、寿命延長量等の現在状態を表示してよい。active bucketの途中成果は所持pointsへは加算されないが、端末の近くで明示的に回収した時点までの成果はpartialでも受け取れる。`prompt`、`token`、`inference`、`context`、`hallucination`、`verification` 等の用語をフレーバーとしてログに使用してよいが、それらの本当の意味を作品内で説明する必要はない。

JOB等の具体的な処理内容をフレーバーとして変化させてもよい。ただしprototypeではJOBごとにゲーム報酬やルールを変えない。

## 5. 能力強化と調整端末

フィールド上に固定施設として `調整端末` を配置する。プレイヤーは端末の近くまで実際に移動し、所持ポイントを消費して能力を手動で強化する。能力強化は自動ではない。

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

最大処理時間に達すると繕いは満杯になり、回収まで新たな成果は増えない。回収後は次bucketが直ちに開始する。

### ハルシネーション抑制

ハルシネーション抑制は、処理1時間あたりの有効ポイント獲得量を改善する。

| 段階 | ポイント獲得量 | 強化コスト |
| --- | ---: | ---: |
| 初期 | 1.0pt/h | - |
| Lv1 | 1.1pt/h | 10pt |
| Lv2 | 1.2pt/h | 20pt |
| Lv3 | 1.35pt/h | 30pt |
| Lv4 | 1.5pt/h | 40pt |

ハルシネーションによる成果減少は、ランダムな大損を発生させる仕組みにはしない。同じ能力値・同じ有効処理時間なら、基本的に決定的に同じ成果を導出できる設計を優先する。

全能力を最大化するために必要な合計コストは245ptとする。能力ポイントの振り直し可否は本仕様では定めない。

## 6. リアルタイムイベント「綻び」

リアルタイムイベントの正式名称は `綻び` とする。綻びによって、フィールド上にソトへ続く `抜け穴` が形成される。抜け穴は不安定で、今にも閉じそうなものとして表現する。

prototypeでは通常の綻びを毎日自動開催する。

時刻は日本時間（JST、Asia/Tokyo、UTC+09:00）とする。

- 20:45 JST：綻びの兆候を通知
- 20:55 JST：参加受付開始
- 21:00 JST：ゲーム開始

通常の綻びは運営が毎日手動操作して発動するものではなく、自動発生する。運営が任意に起こす臨時綻びを将来追加できる可能性は残してよいが、その具体仕様は本資料では定めない。

### 抜け穴と参加

抜け穴は固定施設ではなく、綻びごとにフィールド上の異なる位置へ出現する。参加者は実際にフィールドを移動し、参加したい抜け穴へ向かう。どの抜け穴へ参加するかはプレイヤー自身が移動によって選び、システムがランダムに振り分けない。

1つの抜け穴へ参加できる人数は最低3人、最大6人とする。参加者が多い場合は複数の抜け穴を利用するが、抜け穴の生成数等の具体的なアルゴリズムは本仕様では定めない。開始時に3人未満しか成立しない抜け穴は不成立とし、死亡もポイント変動も発生しない。

### ゲーム時間と秘密選択

1つの抜け穴につき3ラウンド制とする。各ラウンドの目安は、相談60秒、秘密選択30秒、結果表示20秒とする。参加受付を含む1回の綻び全体は、おおむね10分前後で完了する構成を想定する。

各ラウンドでプレイヤーは秘密裏に次のどちらかを選ぶ。

- `抜け穴を維持する`
- `抜け穴からの脱出を試みる`

選択内容は締切まで他参加者から見えず、締切後に一斉公開してラウンド結果を判定する。commit-reveal等の具体的なNostr実装方式は本仕様では定めない。

### 維持人数と報酬

各ラウンドで必要な維持人数は、`ceil(有効参加人数 × 2 / 3)` とする。

| 有効参加人数 | 必要維持人数 |
| ---: | ---: |
| 3人 | 2人 |
| 4人 | 3人 |
| 5人 | 4人 |
| 6人 | 4人 |

全員が抜け穴を維持した場合、維持した全員が20ptを得る。

1人以上が脱出を試み、必要維持人数を満たした場合、維持した側は10pt/人、脱出を試みた側は100pt/人を得る。脱出試行成功は完全な脱出ではなく、一時的にソトへの接触・脱出試行に成功したものとしてポイントを得た後、ハコへ戻る。

必要維持人数を下回った場合、抜け穴は閉じる。維持していた側は0ptで、この失敗だけを理由には死亡しない。脱出を試みていた側は死亡する。抜け穴が閉じた時点で、その抜け穴の綻びゲームは終了する。

システムは行動を協力、裏切り、善、悪等に分類しない。同じ脱出試行について、他参加者の合意か抜け駆けか等の意味の違いを別状態として扱わず、実際の行動結果だけを扱う。

### 通信切断

Relay障害、通信切断、ブラウザ終了、一時的なネットワーク障害だけを理由に死亡させない。有効な最終選択が成立しなかった参加者は、そのラウンドのポイント報酬、維持人数、脱出人数、死亡判定の対象から外す。その結果、有効参加者が3人未満になった場合、そのラウンドは安全に不成立とする。

具体的なNostr transport、commit-reveal、チート対策、ゲーム用Nostr event kind・tag・schemaは本仕様では定めない。

## 7. IdentityとRunのライフサイクル

Player lifecycleはRoot secret storeと分離したbrowser-local aggregateとして管理する。aggregateはschema version、selected Identity history、current modeを持ち、modeは `selecting(pendingSelection)` または `running(activeRun)` のどちらかである。Rootだけ、またはPlayer stateだけのpartial stateは修復せずread-only fail-closeする。

Identityにはgeneration、account index、pubkey、characterId、`identityCreatedAtMs`、status、character profile revision、Run history summaryを持たせる。未選択candidateやskip candidateはIdentity historyへ保存せず、候補のprofile publicationも行わない。

Runにはrun number、monotonic revision、started timestamp、Identity reference、Run-local game stateを持たせる。寿命、points、abilities、`mendingJob`はRun-localであり、mending start/collectionと寿命死亡transitionはactive Runのrevisionを再確認するCASとして扱う。profile publication markerの更新はRun revisionを進めない。

正常なclear後はcurrent Identityのnsec取得、Root-level permanent progression、同じIdentityでのfresh Runまたは別Identityの選択を可能にする。cleared Identityへ戻る場合は同じkey/pubkey/characterを維持してfresh Runを開始でき、3周目以降にも上限を設けない。clear処理、True End、Root mnemonicとIdentity Manifestの受け渡しは別途実装する。

True Endでは、Hako専用Rootの12語English BIP39 mnemonicとIdentity Manifestをユーザーへ渡す。ただしTrue Endはlocal Rootの自動削除を意味せず、Root削除機能は現在scope外である。Manifestは実際にselected、born、playedとなったIdentityのderivation mapping、pubkey、character、Run・clear・death等の履歴を記録する非secretの収容記録であり、未選択candidateやcandidate生成中にskipしたcandidate、Root mnemonicやchild nsec等のsecretは含めない。dead IdentityはTrue End後もHako上ではdeadのままとし、Root mnemonicからchild keyを再導出できることとHako内でresurrectできることは別概念である。Manifestの具体的なpublic export schemaはSPEC-90の未決定事項として残す。
