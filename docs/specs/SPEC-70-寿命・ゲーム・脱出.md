# 寿命・ゲーム・脱出仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。ゲーム進行、寿命、ポイント、作業、リアルタイムイベント、脱出、Identity、Runは本資料を正とする。

アカウント、秘密鍵、Nostr identityそのもの、および一般Nostrへの持ち出しは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。本資料はそれらのゲーム進行上の扱いだけを定め、Nostr eventのkind、tag、schema、transport方式は定めない。

他ユーザー向けPublic Profileに表示するpoints、ability、Root Point、残り寿命はauthorが公開するpresentation projectionであり、受信側のゲーム進行、報酬、参加資格、settlement、寿命判定、脱出判定の入力にはしない。wire contractと寿命のviewer-side projectionは [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) を正とする。

## 1. 基本進行

新しいRunには、Root buildに関係なく出生時に現実時間7日の寿命を与える。Rootのハルシネーション耐性Rankにより、作業で延長できる最大寿命だけが7日、14日、21日、30日に変わる。寿命は現実時間とともに減少し、0になると死亡する。

現在人格が利用可能な通常状態では、プレイヤーはフィールド画面上で現在人格の残り寿命を常時確認できる。残り寿命の表示は、保存された寿命期限とactiveな作業を含む実効寿命期限から導出する。人格のgame stateがmissing・corrupt等で利用できずpublic worldのread-only状態へfallbackしている場合、および実persona lifecycleを持たないDEV Worldでは、残り寿命を表示しない。

フィールド画面最上部の統合HUDでは、寿命ゲージを上段、ポイントゲージを下段に表示する。寿命ゲージは現在のRunの最大寿命を全体量とし、作業中の寿命延長を含むeffective lifespanを現在量とする。ポイントゲージは所持ポイントを100,000ptを満量とする尺度で表示する。鬼ごっこ参加中は、自分に適用される開催者確定済みの未保存累積値と、現在効果・活動・ゲーム時間の境界内で算出した表示用進行分を、メインの寿命・ポイント数値とゲージへ反映する。数値とゲージは同じ表示値から導出し、未確定・確定の内訳は表示しない。通常時は実効的な数値変化の方向に応じて寿命・ポイントの値を緑または赤で点灯し、変化が止まってから約750ms後に通常色へ戻す。継続的な変化中は点灯を維持する。寿命は現実時間による通常カウントダウンも数値減少として扱い、赤で点灯する。鬼ごっこの効果が自分に発生している間は、福ならポイントを緑、鬼なら寿命を赤で約1.5秒周期（点灯約0.45秒、通常色約1.05秒）で点滅させ、通常時の点灯より優先する。数値更新は点滅周期を再開始せず、効果停止・終了・切替時には該当の点滅を解除する。効果以外の数値変化だけを点滅条件にしない。表示用進行分は永続化せず、ゲーム状態、Player lifecycle、精算、死亡判定の入力に使用しない。正式な精算とreceipt、Player lifecycleへの永続化、および未確定の寿命損失では死亡しない責務は維持する。作業によるポイント生成と寿命延長も通常どおり反映する。

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

同じtabでruntime death transitionがbrowser-local lifecycleへdurably commitされて死亡が成立した場合は、live World sessionが利用できればterminal exitのpublicationをbest-effortでattemptする。死亡演出はそのACK、publication settlement、timeoutを待たずに一度だけ開始する。演出はfull-screenの「死亡」を主表示とし、fieldを暗く低彩度にしてselfをpresentation上消失させる。prepare済みterminal exitから得られるcanonical last positionがある場合は、既存のdeath iconによるpresentation-only墓標をそのcellへ表示する。この墓標はNostr event、Trace root、presence/world state、永続化markerではない。terminal exitのpublication failureはdurableなdeathをrollbackしない。短いintroの後に遺言操作へ遷移し、短いnon-loopのdeath soundをshared volume preferenceでbest-effortに再生する。prefers-reduced-motionではmotionと待ち時間を削減する。startup時点ですでに期限切れだったRunにはこの演出を表示しない。

遺言はSPEC-50で定めるNIP-28 kind 42のexplicit Traceとしてcanonical last positionへbest-effortでpublishし、空入力またはskipではpublishしない。publish失敗でもdurableなdeathや次のIdentity selectionをrollbackせず、startup時点ですでに期限切れだったRunにはこの演出を表示しない。死亡後も遺言をrootとする返信は通常痕跡と同じ機能・制約で利用できるが、死亡したIdentityからの追加投稿や新Identityへの通知引き継ぎは行わない。遺言の表示・reply仕様はSPEC-50を正とする。

新Run #1は次から開始する。

1. 寿命を7日にする
2. ポイントを0にする
3. 能力を初期状態にする
4. `mendingJob = null` にする

### 初回Runの短い案内

常設Helpは初回Runチュートリアルとは独立したread-onlyの説明書である。Helpを開閉・navigation・閲覧してもチュートリアルの進行条件を満たさず、未完了段階や完了状態を変更しない。既存チュートリアルの順序、条件、進捗保存、presentationはそのまま維持する。Help Dialog表示中も、Helpとは独立した通常の時計進行およびRealtime Eventの時間・状態遷移は停止しない。

初回Rootで初めて選択したIdentityのRun #1を開始した直後だけ、フィールド上で「寿命」「移動」「作業」「発言」「痕跡」「能力」「書置き」の順に短く案内する。寿命の案内中は寿命HUDを視覚的に強調し、「あなたの一生が始まりました。寿命が0になると、この一生は終わります。」と表示する。ユーザーが「次へ」を操作すると移動案内へ進む。

移動案内では「移動してみよう」と表示する。既存のPC・pointer移動を使い、既存World sessionのmovementが `succeeded` かつ `operation = 'movement'` となった場合だけ作業案内へ進む。初期入室、再接続、移動失敗、再試行だけでは進めない。

作業案内では作業端末を視覚的に強調し、「作業をすると、ポイントを得て寿命を延ばせます。」と表示する。既存の作業端末操作による `startMending` が `kind = 'started'` となった場合に発言案内へ進む。

発言案内では既存Composerと発言UIを視覚的に示し、「誰かに話しかけてみましょう」と表示する。通常の発言または返信の投稿が成功すると自動で痕跡案内へ進む。投稿しない場合も「次へ」で進める。手動の書置き投稿は発言案内の進行条件にしない。

痕跡案内では、他の住人の未読root（通常の痕跡、書置き、遺言）のいずれか1件を実際に開いて読み、SPEC-50に定める5ptが適用された場合に能力案内へ進む。候補は3種類すべてを揃える必要はなく、自己投稿や既読root、重複閲覧は進行・報酬対象にしない。痕跡を視覚的に強調し、案内を実際の候補の近くに表示する。候補の出現自体は保証しない。報酬の対象、既読判定および重複条件は[SPEC-50](./SPEC-50-発言の痕跡.md)を正とする。

能力案内では能力強化端末を視覚的に強調し、「強化端末へ移動して、能力をひとつ強化しよう。」と表示する。端末を使って既存の能力強化UIを開き、能力を1つ選んでdurableな強化が成功した場合に書置き案内へ進む。能力強化UI内でも選択可能な強化を視覚的に示す。書置き案内では既存ActionDockの書置き操作を視覚的に示し、「100ptを使って、その場に書置きを残せます」と表示する。投稿やポイント消費を行わなくても「次へ」で初めてチュートリアルを完了し、「あとは自由です。」を8秒間表示する。完了後は進捗記録を終了し、再読み込み後も再表示せず、通常プレイを阻害しない。案内完了を理由に既存UIを閉じず、作業ダイアログの通常のstartup feedbackとユーザーによるclose操作、および能力強化ダイアログの通常の成功feedbackとユーザーによるclose操作を維持する。

発言とComposerの挙動は[SPEC-40](./SPEC-40-会話・フキダシ.md)および[SPEC-60](./SPEC-60-eHagaki・Composer・Media.md)、痕跡閲覧報酬は[SPEC-50](./SPEC-50-発言の痕跡.md)、書置き投稿は[SPEC-50](./SPEC-50-発言の痕跡.md)および[SPEC-60](./SPEC-60-eHagaki・Composer・Media.md)、能力強化は本書の既存能力仕様を正とする。案内は各機能の仕様を変更しない。

未完了段階は初回IdentityとRun #1に結び付けて同一タブの `sessionStorage` へ保存し、再読み込み後はその段階から復元する。作業段階を復元した時点で対象Runにdurableな `mendingJob` が存在すれば、作業開始済みとして発言案内へ進み、その段階を保存する。能力段階のmarkerには段階開始時の能力levelを保存し、再読み込み時にdurableな能力強化が確認できれば書置き案内へ進み、同じ強化を再要求しない。チュートリアル用にPlayer lifecycle stateや永続化schemaを追加しない。対象を示す案内は対応するHUD・端末・Composer・ActionDock操作または未読rootの近くに表示し、対象がない間は移動や通常操作を妨げない。モバイルではComposerやActionDockの案内を操作dockの直上に横並びで表示し、対象ボタンや入力欄を覆わない。対象の緑の光と案内テキストはゆっくり明滅し、OSの動きを減らす設定では静止表示する。完了時の「あとは自由です。」は読み取りやすい大きさで8秒間表示する。案内は非モーダルとし、既存のキーボード・pointer・タッチ操作やフィールドレイアウトを妨げない。

旧Identityと新Identityの間に、Run-localの記憶・状態・自己認識の連続性を持たせない。Identity historyにはselected Identityとfinished Runのsummaryだけを残す。

24時間に1回の任意転生および任意のリセマラは廃止する。転生は原則として死亡時のみ発生する。

## 2. ポイント

ゲーム内で使用するポイントは1種類だけとする。「脱出ポイント」と「成長ポイント」には分離しない。

ポイントは主に `作業` と `有効なリアルタイムイベント` によって獲得する。ポイントはRun内能力の強化に消費でき、現在所持ポイントが100,000pt以上である間だけnormal clear条件を満たす。

所持ポイントは0以上の整数とする。1pt未満の作業進捗は所持ポイントとは別のRun-localなcarryとして保持し、表示・消費・persistする所持ポイントへ小数を混在させない。

自己投稿以外の未読痕跡rootの初回閲覧は5pt、自分宛ての有効な未読返信の実表示による既読は10pt、他者の発言への返信投稿成功は10ptを付与する。対象条件、Identity・Run単位の重複制限、二段階精算、失敗時の復旧はSPEC-50を正とする。書置きの確定所持ポイント100pt費用および既存のoutbox処理は維持する。

能力強化に使用したポイントは所持ポイントから減少する。現在所持ポイントが100,000pt未満になればnormal clear条件を満たさなくなり、再び100,000pt以上を所持すれば満たす。過去の累積獲得量や一度到達した事実は条件を永久解放しない。「能力へ投資する」か「100,000pt以上を保持してclearする」かの選択が成立する。通常死亡・fresh Run開始時には現在所持ポイントをすべて失う。

通常Composerからの書置き投稿は確定所持ポイントを100pt消費する。未回収作業pointsおよび未確定realtime報酬を使用しない。費用は投稿用の一度限りの予約として現在Runの所持ポイントから差し引き、clear thresholdにも反映する。投稿のRun scope確認、所持ポイント減算、署名済みkind 42 eventのoutbox永続化は同一IndexedDB transactionで成立し、Relay送信はtransaction commit後に開始する。

## 3. 100,000pt到達とnormal clear

normal clear working thresholdは現在所持ポイント100,000ptとする。100,000pt以上である間だけclear選択を利用でき、過去の到達だけで永久unlock flagにはしない。100,000ptを所持しているだけで自動clearにはしない。未回収作業pointsはthresholdへ含めない。effective lifespanが尽きている場合、またはcurrent Runに未解決のrealtime settlementがある場合もclearできない。clearはactive Runを`cleared`として閉じ、Root Pointを1つ加算し、blockingなRun選択状態へ移行する。clear後はcurrent Identityのnsec取得と同じIdentityのfresh Runを可能にする。

clearはbrowser-local lifecycleへdurably commitして成立し、commit成功後にlive World sessionがあれば旧RunのPublic World State terminal `exit`をbest-effortで通知する。短時間の投稿送信中だけ同じRunのclearを待たせる。結果不明のoutboxはpoint予約を利用可能所持pointから差し引いたまま保持するが、clearを無期限に禁止しない。送信前にdurableなoutboxと予約が成立していないeventはRelayへ送らない。Runを閉じるtransactionはterminal exitを準備できない場合も旧Runの未確定outboxをterminal化する。終了後は旧Runから再送を開始せず、予約の新Runへの移転・返金もしない。clear成立前に送信開始したNostr eventは取り消せない。Relay failureやexit publication failureはclearをrollbackしない。同じcleared Identityをfresh Runで再利用する場合は、新しいworld entryとして再参加し、exitより新しいpositive activityでpresenceへ戻る。wire上のexitとpresence timestampの詳細は [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) を正とする。

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

回収時には寿命延長をpersisted lifespanへmaterializeし、unclaimed pointsを所持pointsへ加算する。同時に回収時刻をcheckpointとして次のbucketを開始し、回収後も`mendingJob`はactiveなままである。current bucketの通常processed durationとunclaimed integer pointsは0から再開するが、1pt未満のfractional point carryは保持する。processed durationが存在すれば今回の整数pointsが0でも回収を成立させ、processed durationが0の即時再回収は成立させない。

作業端末UIでは、受取可能な整数pointsが0ptの場合は成果回収操作をdisabledとし、1pt以上の場合だけ回収できる。これはplayable UIの操作制限であり、fractional carryを含む低レベルのcheckpoint・settlement計算は変更しない。したがって、整数pointsが0でもprocessed durationが存在する場合に回収を成立させるsettlement semanticsは維持するが、通常の作業端末UIからその操作は開始しない。

成果回収が成功したときは、作業端末上で一度限りの強い報酬presentationを行い、確定した受取pointsを表示する。寿命延長がmaterializeされた場合は「作業中に反映済み」であることを示し、回収時に初めて寿命延長を得たようには表現しない。ring・ray・particle風の短い視覚強調を加えてよいが、layoutを変えず、Dialog操作や他のinteractionを妨げない。Reduced Motionではmovement、scale、rotation、radial expansionを抑え、成果取得が分かるtext・color・border・opacity表現を維持する。同じ回収結果はDialogのclose/reopen、presentation rootの再生成、古いfeedback stateから再生しない。presentationやsoundの失敗は成立済みの回収をrollbackしない。

成果回収にはMending専用の短いreward soundを使用し、その主要accentは報酬visual presentationの主要accentと同期する。soundは既存のvolume、mute、document visibility等のsound policyに従い、soundまたはvisual presentationが再生できない場合も成立した回収結果は維持する。他用途のgeneric `collect` soundはこの専用表現へ変更しない。

通常作業はmaximum durationへ到達した時点で停止する。overflow時間はRootコンテキスト圧縮Rank 0/1/2/3に応じて、通常point生成速度と通常寿命延長率の両方を0/20/35/50%だけ継続する。overflow中は推論加速倍率を適用しない。上限超過時間を次bucketへ持ち越さず、上限到達後も同じ回収操作を行える。

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

Run開始前にRoot PointをRoot buildへ配分し、active Run中は変更しない。通常作業のeffective Context capはRun-local容量にRootコンテキスト圧縮倍率（Rank 0/1/2/3 = ×1.00/2.00/3.00/4.00）を掛ける。cap到達前はpointsと通常の寿命延長が発生する。cap到達後のoverflowは、コンテキスト圧縮Rankに応じてRun-localの通常point生成速度と通常のハルシネーション抑制による寿命延長率の0/20/35/50%を継続する。overflowでは推論加速倍率を適用しない。

推論加速Rank 0/1/2/3は、active Run中の有効通常作業におけるpoint生成へ×1.00/2.00/3.00/4.00を常時適用する。overflowでは推論加速倍率を適用しない。ハルシネーション耐性Rank 0/1/2/3はmaximum lifespanを7/14/21/30日にするが、fresh Runの出生寿命は常に7日である。

作業計算は0.01pt/分の整数fixed-pointとし、point progressは60,000,000 ticksを1ptとしてBigInt等で正確に計算する。persistするowned pointsとfractional carryは整数である。work projection・checkpoint・collection・寿命死亡判定はいずれもeffective lifespanを使用し、extensionが実際に生成されないoverflow時間だけでmaximum lifespanのcapを未来へ無料で移動させない。

## 公開プロフィールランキング

フィールド上のランキング端末から、同一channelの公開Profile Stateを使ったポイントランキングと残り寿命ランキングを閲覧できる。端末の位置、collision、隣接時の利用、遠距離時のfeedbackとfield actionはSPEC-30の既存terminal規則に従う。ランキング対象はfinite batch readで取得できた同一channelのPublic Profile State authorとする。current presenceや10分間のpresence populationはmembership条件にしない。ランキングは受信側の進行状態や報酬には影響しない。

横幅に余裕があるviewportでは、ポイントランキングと残り寿命ランキングを左右2列で同時に表示する。狭いviewportではポイント／寿命の切替controlを表示し、選択したランキングだけを表示する。どちらのpresentationでも同じfinite ranking batchとprojectionを共有し、切替やviewport幅の変化による再取得は行わない。各行は順位、character、公開pointsまたは残り寿命を表示し、死亡・脱出済みのRunは状態を示す。pubkeyや能力値などのProfile詳細は表示しない。結果は非interactiveで、行からProfile Dialogを開かない。読み込み中は最大3秒skeletonを表示する。3秒経過時点でvalid rowがなくてもfinite batchが未完了なら「ランキングを取得中…」等のloading表示を続け、emptyとは判定しない。batch完了時にvalid rowが0件の場合に限り「ランキング情報がありません」と表示する。読み込み中にvalid rowが到着したらすぐランキングへ切り替え、一度表示した後は残りRelayの完了待ちを理由にloading / emptyへ戻さない。後から届いた結果は同じDialog内で反映する。

各participantの公開profile-state addressで最新となる有効な同一Run Profileを用い、現在のviewer時刻で残り寿命を算出する。pointsは降順、寿命は死亡、残り時間昇順、脱出の順で並べ、同値はpubkey辞書順で安定化する。terminal exitはpubkey単位で`created_at`最大、同秒ならevent ID辞書順最小を先にcanonical選択し、ProfileのRunと一致する場合だけ反映する。全行の残り寿命は同一のviewer時刻を使う。取得filter、有限Relay readの終了、Relay容量条件、best-effort動作はSPEC-30に従い、network上の結果をlocal lifecycleの代替・更新に使わない。

## 6. 交換可能なリアルタイムイベント

リアルタイムイベントは、寿命・ポイント・死亡などのsettlementを持ち得る、交換可能なexperimental event枠である。イベント固有の状態は `PersonaGameState` に混在させず、イベントinstanceとaction、participant、round、resultとして独立管理する。実験を終了するときは、その定義をenabled registryから外し、購読・受理・表示・settlementを停止する。旧payloadや旧kindを救済するlegacy path、隠れた自動移行、恒久採用を前提にした互換層は設けない。

prototypeではこの枠で複数のevent typeを順次試遊し、試遊結果を踏まえて正式採用するeventを決める。現時点でenabledなのは「協力と抜け駆け」（event type `cooperation-defection`、protocol version 1）とプレイヤー主催の「鬼ごっこ」だけである。

各イベントはイベント定義、protocol version、protocol key、payload parser、instance schedule、settlement規則を持つ。共通のNostr envelope、control、補助subscription、共通parserの仕様は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とし、イベントの有効化・無効化はcompile-time registryで明示する。Relay障害、購読拒否、切断、ブラウザ終了だけを理由に死亡させない。settlementは既存のbrowser-local Player lifecycle store内の汎用ledgerへ、receiptと同じatomic mutationで記録する。ledgerはevent instanceのpendingと適用済みoutcome receiptを持ち、同じoutcomeを二重適用しない。古いIdentityまたは古いRun、既に期限切れのRunにはポイントを適用しない。イベント由来の死亡は、現在Runの死亡処理と同じRun close・Identity dead・次generation選択の経路を明示的に通る。

公式イベントパネルは開催予告・参加受付・ゲーム中に表示し、開催前と開催終了後はパネル全体を表示しない。ゲーム中の結果発表では結果を表示する。パネルの表示状態は、イベントの精算・未精算結果の復旧を制御しない。

参加受付中は、scheduleの `gameAtMs` を受付締切としてJSTの年月日・時刻と残り時間（`MM:SS`）を表示する。残り時間はscheduleの締切と現在時刻から計算し、手動開催もイベントの `created_at` 由来の締切を使う。締切は参加状態や通信状態にかかわらずパネルに表示し、参加確認ダイアログを開いている間も確認できる。参加受付終了後はゲーム進行表示へ切り替える。手動開催の開催識別表示は「運営開催」とする。

playable eventのparticipantは、現在のcharacter slotへ解決できるauthorだけを有効参加者として扱う。未割当authorは参加枠、round、result、settlementへ入らない。SPEC-10で定めるexternal world actorのcharacter overrideは、このparticipant判定には適用しない。controlのauthority条件はchannel creatorであり、このparticipant条件をcontrol eventへ適用しない。受信envelopeのprotocol条件と境界検証はSPEC-10を正とする。

### experimental event「協力と抜け駆け」

prototypeでenabledにするexperimental eventは「協力と抜け駆け」（event type `cooperation-defection`、protocol version 1）である。毎日自動開催し、時刻はJST（UTC+09:00）とする。

- 20:45 JST：開催予告
- 20:55 JST：参加受付開始
- 21:00 JST：ゲーム開始

channel creator authorityが署名したkind 7070のversioned controlで、任意時刻にも手動開催を開始できる。controlのpayloadは開始命令と対象playable protocol keyを持ち、対象instanceは `cooperation-defection:1:manual:<created_at>:<nonce>` とする。`created_at` はcontrolのUnix timestamp秒、nonceはlowercase 16-byte hexであり、instance IDだけからscheduleを再構成できる。control時刻がregistration開始でwarningはなく、5分後にgameを開始する。controlはSPEC-10の固定World configで定めるcreator本人の有効な署名、対象channel、enabled definition、payload、instance scheduleを満たすものだけを受理する。

手動開催のregistration開始〜終了区間とscheduled開催のwarning開始〜終了区間が少しでも交差する場合、そのmanual controlを無効とする。scheduled開催を優先し、active gameの置換・並行開催・queueは行わない。bootstrapで複数の有効候補がある場合は、現在時刻でregistrationまたはgame中の候補に絞った後、`created_at`昇順、同値ならcontrol event ID辞書順で選択する。終了済みcontrolからゲームを再開しない。

参加地点は固定施設ではなく、event instanceとfieldから決定的に異なる位置へ配置する。作業端末・能力強化端末などの固定施設とは別cellとする。参加需要が6人を超える場合は需要に応じて複数生成し、最低1つは生成する。プレイヤーは実際にフィールドを移動して参加地点の近くで参加し、システムがランダムに振り分けない。1グループの有効参加者は3人以上6人以下とし、最大6人は有効なjoin event IDの決定的順序で選ぶ。

参加受付終了後、イベント通信の初期取得が完了してから、各グループの有効参加者を一度だけ確定する。0〜2人のグループは開催中止とし、ラウンド、選択、結果、報酬・ペナルティ、結果発表用kind 42発言を発生させない。3〜6人のグループは通常どおり開始し、人数判定は他グループから独立させる。中止グループの参加者には「参加人数が足りなかったため開催されませんでした」と通知した後、通常画面へ戻す。受付の延長・自動再開催は行わない。

ゲームは最大3ラウンドとし、各ラウンドを相談、秘密選択、結果発表の順で構成する。各phaseの継続時間は相談30秒、選択30秒、結果発表20秒。相談には既存World会話を使い、専用chatを追加しない。通常の会話・フィールド移動は選択中も制限しない。選択は `cooperate`（協力する）または `defect`（抜け駆けする）の二択とし、commit-revealで締切後に判定する。commitが成立したclientは選択締切後にrevealを自動publishする。結果発表内のreveal猶予は判定猶予としてのみ扱い、その終了後は無効とする。browser reload・終了等でnonceを失った選択は推測・復元しない。同一selection window内のchoice変更は最初のconfirmed commit後は受け付けない。判定対象となる有効選択が3人未満なら不成立とする。

必要な協力人数は `ceil(有効選択人数 × 2 / 3)` とし、3人なら2人、4人なら3人、5人なら4人、6人なら4人。全員が協力した場合は全員に1,000ptを与える。協力者が必要人数に達し、抜け駆けが一部にいる場合は、協力者に100pt/人、抜け駆け者に10,000pt/人を与える。協力者が必要人数に達しない場合は協力者に0pt、抜け駆け者の実効寿命を72時間減らす。減算には作業で未確定の寿命延長を含め、寿命が残ればRunを続け、実効期限が到達済みなら通常の死亡lifecycleへ移行する。協力失敗後はそのグループの残りラウンドを中止する。有効選択が3人未満なら報酬もペナルティも適用しない。Relayやブラウザの一時障害による無効選択は参加人数と判定から除外し、障害そのものに罰を与えない。

有効な選択をした各参加者は、結果確定後に自分のIdentityでtop-level kind 42を通常発言としてbest-effort投稿する。本文は協力なら `協力`、抜け駆けなら `抜け駆け` のみとする。選択・結果判定は従来どおりkind 7070 commit-revealを根拠とし、kind 42の本文や成否を使わない。投稿はreveal猶予終了後かつそのラウンドの結果発表中に限り、結果不成立や無効選択では行わず、発表期間外の遅延投稿もしない。重複投稿は同一Run・instance・group・roundで抑止する。死亡を伴う場合もkind 42の応答を待って死亡永続化・演出を遅らせない。公式UIでは、参加者が明示操作で開く結果詳細から自身のグループの全参加者の有効な選択と共通報酬・ペナルティを確認できる。他者の実際の死亡は推測表示しない。

公式イベントパネルはゲーム進行中に基本情報をコンパクトに表示し、各参加者には自身のグループの最新結果から、有効な本人の選択とグループ判定に基づく「協力成功」「協力失敗」「抜け駆け成功」「抜け駆け失敗」等の本人結果と本人の報酬・ペナルティを示す。有効な本人の選択が確認できない場合は「本人の選択未確認」と表示し、結果を推測しない。未参加者にはグループ結果を表示しない。前ラウンドの結果を表示する場合は過去の結果と明記する。独立した非モーダルの結果詳細はグループ全体の判定を示し、全員協力時は「協力成功」、一部が抜け駆けして必要人数を満たした場合は「抜け駆け発生」、必要人数未達は「失敗」、有効選択3人未満は「不成立」と表示する。協力・抜け駆け別に有効選択人数、参加者名、該当する報酬・ペナルティを成績表として示す。本人が有効選択者なら所属する選択グループを控えめに強調し、本人のチップを識別する。本人の選択が未確認ならグループ判定の下にその状態を示し、本人の選択や報酬を推測しない。無効選択への報酬や不成立時のペナルティを表示しない。詳細パネルは個別にスクロールでき、フィールドの通常操作を詳細パネル外で妨げない。ラウンドが切り替わると詳細を閉じるが、表示可能な結果は再度開いて参照できる。

ゲームパネルの実際の表示領域は通常・合体吹き出しおよび痕跡の配置で障害物として扱い、空間がある場合は重なりを避ける。選択フェーズは吹き出しと重なる狭い画面でも「協力する」「抜け駆けする」の操作を可能にする。選択操作が不要なフェーズでは、回避できない重なりがある場合に吹き出しを前面に表示する。吹き出し配置は発言者との空間的な対応、吹き出し同士の重なり回避、しっぽの追従を維持する。

ゲームパネルは重複する説明文を避け、開催種別、フェーズ、残り時間、参加人数、確定結果と本人の報酬・ペナルティをアイコン、数字、短いラベルで示す。意味を取り違えやすい選択操作、通信障害、参加情報の取得中、寿命ペナルティは文字でも明示する。文字サイズは一律の固定値とせず、PC・スマートフォンの両方で読みやすさと画面内の収まりを保つ。結果詳細は独立してスクロールできる。

参加受付中に自分が参加し、受付からラウンド1の相談フェーズへ移った後、同フェーズ中に初期取得が完了して確定した参加者snapshotに自分を含む3人以上のグループがある場合、短い開始効果音を同じ開催につき一度だけ再生する。人数不足の中止、未参加、reloadや再接続後にゲーム中の状態を復元した場合は再生しない。再生は既存のWeb Audio効果音、音量設定、ミュート、ブラウザの音声再生制限に従い、再生できなくてもゲーム進行を妨げない。

参加受付、相談、選択の各フェーズではゲーム内の同じルール説明を開ける。説明中も残り時間を確認でき、選択操作を妨げない。説明には、3〜6人・最大3ラウンド、phase、選択肢、人数別の必要協力人数、報酬とペナルティ、選択の秘匿を短く示す。参加確定前には、協力失敗で抜け駆け者が寿命を3日失い、残り寿命によっては即死することを明示する。説明と確認および操作ボタンはスマートフォンのviewport内でスクロールして到達できる。旧event protocolは受け入れない。切替時には旧「綻び」の未精算instance IDだけをpending ledgerから終了させ、旧outcomeを再計算・補償・適用しない。

### experimental event「鬼ごっこ」

各開催者は自由に募集し、開催回IDを `<host pubkey>:<created_at>:<random>` とする。署名済み募集状態はaddressable `kind 37070`、`d=<game ID>`、`e=<World channel>`、`t=tag-game`で発行し、募集継続中は30秒ごとに同じ開催回を更新する。発見filterは直近90秒を取得し、署名・channel・index・開催者公開鍵とIDの一致を検証し、updatedAtから90秒を過ぎた募集を無効にする。署名済みephemeral `kind 27070`はjoin、leave、提案への同意、所持者応答、能力移転要求に用いる。いずれも既存のkind 7070イベント定義・購読対象を変更しない。

募集は2〜8人。参加予約は単一参加制限として管理し、開始前の脱出・能力強化は禁止しない。開始前にRunを終了した登録者は参加資格を失い、開催者は有効なRunを再確認して開始を確定する。開催者の開始提案は、その提案IDへの開催者本人の同意を同時に記録する。その他の登録者の同意を必要とし、30秒の応答期限内に同意しなかった登録者を除外して募集へ戻す。開催者は除外後に再提案でき、新しい提案では開催者だけを自動同意とし、その他の参加者には改めて同意を求める。同意した有効参加者が2人以上なら5秒カウントダウン後に開始する。開始時に参加者のPlayer lifecycle transactionでRunと参加予約を照合して操作lockを有効化する。開始後は脱出・能力強化を同じlifecycle transaction境界で拒否し、通常作業は許可する。

ゲーム進行は開始から120秒。福と鬼が6区間で交互となり、各効果は合計60秒、各効果3区間、各区間は10〜40秒。最初の効果は従来どおりseedから決定する。確定済みseedと開始時刻から導出できる通常の区間切り替えは、開催者・参加者で同じスケジュールを用い、新しい37070の到着を待たずにタッチ判定、候補表示、フィールド表示、HUD予測へ反映する。開催者は通常の効果切り替えだけを理由とした37070を発行しない。正式な応答確認による停止、所持者変更、参加資格変更、累積精算、終了・中断は、従来どおり開催者署名済み37070を正とする。福では所持者に50pt/秒、鬼では所持者の寿命を1時間/秒失わせる。フィールド上では効果名テキストに代えて、福は朱色・白を主体にした半透明の細い光輪と交互の短い光線による後光、小さな打ち出の小槌を表示する。右上は光線を少なくし、小槌は前面に置く。鬼はアバター上部に突き出す二本の角を前面に置き、暗い青紫・紫・黒の半透明な煙状オーラを左右に表示する。オーラは背面で柔らかな曲線を主体とし、シンボルより目立たず、顔と名前を隠さない。効果停止中は動きを止め、reduced-motion環境でも象徴的な形状から効果を識別できるようにする。能力移転は隣接・有効なsigned Run・有効状態を検証し、開始時と成立した転移後の2秒間は転移禁止とする。開催者は検証済みの署名済み27070応答と通常World activityの両方から所持者の最終活動を求める。最後の有効活動から15秒で非停止の事前確認を送り、その8秒後も活動・応答がなければ効果を停止し、停止状態を37070で発行したうえで正式な応答確認を送る。正式確認への応答可能時間は、その確認要求の送信確認後から8秒とする。期限まで応答がなければ従来どおり一時対象外として再抽選する。確認応答はWorld Presenceを延命しない。参加者全員のheartbeatは発行しない。

送信確認が得られない場合も、開催者内部の効果計算は最後の有効活動から最大23秒で停止する。開催者の更新キューが遅延しても、効果計算の精算境界は最後の有効活動+23秒で固定し、後からキューを処理した時刻まで損失を延長しない。停止37070を発行できない間はローカルで停止境界を保持し、タッチを受理しない。停止中に有効な活動またはRunと確認IDが一致する応答を確認した場合は、その復帰時刻から効果計算を再開し、停止境界から復帰までの時間はポイント・寿命損失へ加算しない。復帰状態のsettled cursorは停止境界から復帰時刻へ進め、両境界を署名済み状態に保存する。遅延した状態更新もこの境界を越えて停止期間を精算してはならない。再読込後に署名済み状態から停止時刻または精算cursorを信頼して復元できない場合、停止期間の未確認分を追加確定せず、最後に確認済みの累積値で安全に中断・精算する。

累積精算は参加者1人あたり最大3,000pt、寿命損失216,000,000msを上限とする。ゲーム時間は開始から120秒で停止し、通常終了時だけ通信可能な参加者は終了後最大30秒、開始から150秒まで開催者の最終37070を待つ。最終結果が届けばその確定済み累積値を、届かなければ最後に確認済みの累積値を、settlement receiptと同じPlayer lifecycle transactionで一度だけ適用する。開始から120秒以降は追加報酬・寿命損失を生成しない。未確定寿命損失では死亡させない。永続化完了後に参加lockを解除し、再読込・通信断時も開始から150秒で有限に確定して解除する。確定後に届いたイベントは追加精算へ使用しない。

判定者のdeath/clear exitまたは継続不能な通信競合は正常な120秒終了と区別し、最後に確認済みの累積値で精算を打ち切る。解決待ちの参加記録を終了させ、参加予約と操作lockを解除し、終了後のイベントは適用しない。同一秒の37070競合で状態選択ができない場合は新しい一意時刻の状態で解消を試み、30秒以内に解消できなければ最後に確認済みの状態を使い中断・精算する。terminalとなったworldReadSessionから終了通知を発行できる前提を置かない。30079 exitは対象の署名済みRun numberとreasonを照合し、遅延した旧Run exitを現在のRunへ適用しない。

ゲーム開始前は募集画面の脱出・能力強化を許可し、同一Runの参加予約だけを重複拒否する。ゲーム中の操作禁止はUIだけに依存せずPlayer lifecycle更新transactionで検証する。複数タブ・開始とRun closeの競合で古いRunが開始対象にならないよう、開始確定時に保存済みRunを再検証する。ゲーム結果を保存してlockを解除する更新は原子的に行い、重複イベント・再読込で累積値を二重適用しない。

鬼ごっこは既存のWeb Audio効果音設定を使い、福・鬼の点滅、所持者変更、スケジュール上の福・鬼切替、開催者署名済み状態で確定した開始、正常終了または開始後の中断を短い合成音で知らせる。福のポイント加算音は、HUDのCSS点滅の開始・反復に同期する短い、明るく上昇するベル風の和音とする。点滅音は自分に効果が発生している間だけHUDのCSSアニメーション開始・反復へ同期し、数値更新や独立タイマーで周期をリセットしない。効果停止・切替・終了、非表示タブ、reduced-motionでは周期音を止める。単発音は署名済み状態遷移または確定済みスケジュールを根拠とし、初期取得・再読込・再接続・重複状態から過去の音を再生しない。開始前の取消と観戦者・退出者は終了通知の対象外とし、開始から最大150秒の最終精算待ちはゲーム時間120秒を超えて延長しない。開始・終了、所持者変更、効果切替、点滅の順に重なりを抑制し、ミュート・音声再生許可・共通音量を尊重する。音声出力の失敗はゲーム進行に影響しない。

プレイヤー向け効果名はprotocol識別子 `benefit` を「福」、`calamity` を「鬼」と表示し、ゲーム名「鬼ごっこ」は維持する。端末、進行HUD、結果、フィールドエフェクトのアクセシブル名でこの表示名を使う。内部識別子、精算、スケジュール、効果音のタイミングは変更しない。

鬼ごっこ端末ではヘッダー直下に「2〜8人 · 2分」と「福を奪い、鬼を押し付ける。」を表示する。死亡リスク「鬼になった者は、毎秒1時間の寿命を失います。寿命が尽きれば死亡します。」は常時表示し、既定で閉じたネイティブ `details` のインラインルール説明の外に置く。ルール説明には、福「+50pt / 秒」「福を持たない者は、所持者にタッチして福を奪えます。」、鬼「寿命 −1時間 / 秒」「鬼は他の参加者にタッチして、鬼を押し付けられます。」、切り替え「福と鬼は交互に切り替わります。」、タッチ「隣接した相手にのみタッチできます。」を示す。福・鬼は縦積みカードとし、説明の開閉はゲーム状態やフォーカスを変更しない。既存Dialogの幅、高さ、背景、スクロール、sticky header、閉じる操作および開催・募集UIの優先順位を維持し、ルール部分へ独立スクロールを追加しない。参加者の登録検知時は通知バナーを表示せず、参加者枠の既存ハイライトのみを一時表示する。

鬼ごっこ端末では、募集中・開始確認中・開始準備中・開催中・最終精算中を「現在のゲーム」にまとめ、過去の鬼ごっこと分けて表示する。募集中は現在のゲーム内でも識別しやすくする。過去の鬼ごっこは開始後に終了・中断した開催回だけを件数付きの折りたたみ一覧に表示し、各行から結果を明示的に開ける。開始前に取り消された開催回は履歴へ含めない。結果表示は終了時の自動表示と履歴からの手動表示で同じダイアログを使い、通常終了を「鬼ごっこ終了」、中断を「鬼ごっこ中断」とする。最大8人の参加者を登録順に表示し、自分が参加している場合は自分を先頭に移して控えめに識別する。参加者ごとにキャラクターアイコン・名前、福の保持時間とポイント、鬼の保持時間と寿命損失を示し、自分専用の順位・勝者表示は設けない。確定済みの死亡・退出等は名前の近くに示す。表示値は開催回状態の累積値を用いる。福・鬼の保持時間は秒単位で小数第1位まで四捨五入し、整数なら小数部を省略する。寿命損失は24時間未満を時間、24時間以上を日数と残り時間で示し、時間部分は小数第1位まで四捨五入する。丸めによる日数への繰り上がりを反映し、残り時間が0なら日数だけを表示する。内部値のミリ秒精度は維持する。

自分が参加した開催回では、ゲーム全体の終了後に自分の最終精算がPlayer lifecycleへ確定したときだけ結果を自動表示する。120秒のゲーム時間経過だけでは表示せず、通常終了時は開催者の最終状態を待つ既存の最大30秒の期限を維持する。期限内に最終状態を受信できなかった場合、自分は最後に確認済みの累積値で一度だけ精算し、その制約を結果に示す。参加者全員の表示は取得できた開催回状態を使用し、開催者確定状態と通信障害時の最後の確認状態を混同しない。途中退出者の個人精算は開催回終了として扱わず、観戦者・未参加者には自動表示しない。死亡演出を優先し、その後に結果を表示する。再読込・初期取得・再接続・重複・遅延イベントでは同じ開催回を再自動表示せず、閉じた結果を再表示しない。結果表示用スナップショットはセッション内に限り保持し、ゲーム状態・精算の正式な状態管理とは分離する。永続履歴、追加Nostr event/subscription、サーバー、IndexedDB履歴は導入しない。

## 7. IdentityとRunのライフサイクル

Player lifecycleはRoot secret storeと分離したbrowser-local aggregateとして管理する。aggregateはschema version、Root Point、selected Identity history、current modeを持ち、modeは `selecting(pendingSelection)` または `running(activeRun)` のどちらかである。Rootだけ、またはPlayer stateだけのpartial stateは修復せずread-only fail-closeする。

Identityにはgeneration、account index、pubkey、characterId、`identityCreatedAtMs`、status、character profile revision、Run history summaryを持たせる。未選択candidateやskip candidateはIdentity historyへ保存せず、候補のprofile publicationも行わない。

Runにはrun number、monotonic revision、started timestamp、Identity reference、Run-local game state、開始時にfreezeしたRoot buildを持たせる。寿命、points、abilities、`mendingJob`はRun-localであり、mending start/collection、能力強化、normal clear、寿命死亡transitionはactive Runのrevisionを再確認するCASとして扱う。profile publication markerの更新はRun revisionを進めない。

正常なclear 1回につきRoot Pointを1つ加算する。Root PointはIdentity変更、fresh Run、死亡でも失わず、死亡やrealtime eventでは増えない。Root PointはRoot buildへ配分し、usable RPは`min(総RP, 9)`、各能力Rankは0〜3、Run開始時はusable RPを全て配分する。推論加速Rank 0/1/2/3はactive Run中の有効通常作業におけるpoint生成へ×1.00/2.00/3.00/4.00を常時適用し、overflowでは適用しない。コンテキスト圧縮Rank 0/1/2/3は通常容量へ×1.00/2.00/3.00/4.00を適用し、overflowのpoint生成速度と寿命延長率は0/20/35/50%とする。ハルシネーション耐性Rank 0/1/2/3は最大寿命を7/14/21/30日にする。出生時は常に7日である。Root buildはRun開始前にのみ配分・再配分でき、active Run中はfreezeする。RP9を超える余剰用途、高周回point sink、True End triggerは未決定とする。

clear後はcurrent Identityのnsec取得、同じIdentityのfresh Runまたは別Identityの選択を可能にする。cleared Identityへ戻る場合は同じkey/pubkey/characterを維持してRun numberだけを増やし、Run-local stateを初期化する。clear済みIdentityの再利用回数に上限は設けない。True End、Root mnemonicとIdentity Manifestの受け渡しは別途実装する。

True Endでは、Hako専用Rootの12語English BIP39 mnemonicとIdentity Manifestをユーザーへ渡す。ただしTrue Endはlocal Rootの自動削除を意味せず、Root削除機能は現在scope外である。Manifestは実際にselected、born、playedとなったIdentityのderivation mapping、pubkey、character、Run・clear・death等の履歴を記録する非secretの収容記録であり、未選択candidateやcandidate生成中にskipしたcandidate、Root mnemonicやchild nsec等のsecretは含めない。dead IdentityはTrue End後もHako上ではdeadのままとし、Root mnemonicからchild keyを再導出できることとHako内でresurrectできることは別概念である。Manifestの具体的なpublic export schemaはSPEC-90の未決定事項として残す。
