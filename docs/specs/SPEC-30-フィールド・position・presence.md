# フィールド・position・presence仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 15. フィールド

専用クライアントでは、ユーザーがキャラクターとして存在する2次元の論理フィールドを用意する。

フィールドは全ユーザー・全端末で共通の固定座標系とする。

現時点では縦8マス×横16マス程度を想定しているが、具体的なマス数は未決定とする。

各マスにはキャラクターアイコンと小さなキャラクター名を表示する。

発言の痕跡も、元の発言が行われたフィールド座標に対応するオブジェクトとして配置する。

### キャラクタープロフィール

フィールド上の自分または他ユーザーのキャラクターアイコンは操作できる。

操作すると、そのキャラクターの画像、名前、`about` をプロフィールDialogで表示する。プロフィールは、専用クライアント内のキャラクター表示と同じcharacter catalogを正とし、プロフィールのために追加のNostr通信を行わない。

プロフィールDialogは、下端の閉じる操作、Dialog外の操作、Escape、ブラウザまたは端末のBack操作で閉じられる。Back操作では、ページを離れるより先に開いているプロフィールDialogを閉じる。

### 座標表現

フィールド上の1マスは `x` / `y` の整数座標で表す。

Nostr event上で1マスを文字列として表現する場合は、以下のcanonical形式を使用する。

`<x>:<y>`

例：

- `0:0`
- `7:3`
- `15:7`

`x` / `y` は10進の非負整数とする。

leading zero、符号、別区切り文字等を含む複数の表記を同じ座標の正規表現として許容しない。

フィールド範囲外の座標は有効なフィールドpositionとして扱わない。

具体的なフィールドサイズが確定した後、その範囲を座標validationへ反映する。

### 表示範囲

PC等ではフィールドの広い範囲を表示できる。

スマートフォン等ではフィールド全体を常に表示する必要はなく、自分を中心とした一部分のみ表示してよい。

カメラは自分を中心に追従する。

ユーザーが自分とは無関係にフィールドを自由にパンして遠方を見る機能は設けない。

論理フィールドと、その周囲まで含むvisual artworkは別の責務として扱う。visual
artworkはpresentationのために論理フィールド境界の外側へ延長してよいが、外周部分は
論理cellではない。したがって、artwork外周によってposition、movement、occupancy、
Trace、selectionの範囲を拡張しない。

カメラは端付近の表示に必要な場合、このvisual artwork範囲を含めてframingしてよい。
これは自由pan機能を追加するものではなく、既存の自分への追従cameraを維持したまま
presentation上の表示範囲だけを扱う。

### 移動

1回のmovementは、隣接する1つのcellへの移動とする。移動方向はcardinal 4方向と
diagonal 4方向の計8方向を許可する。

PCでは修飾キーなしのArrowキー（ArrowUp / ArrowDown / ArrowLeft /
ArrowRight）で移動できる。Composer editorにフォーカスしている場合は、
Editorが完全にemptyのときだけ修飾キーなしのArrowキーを移動に使用する。
non-emptyのEditor、IME composition中、または修飾キー付きのArrowキーでは、
Editorまたはブラウザ本来のカーソル・選択・OS操作を優先する。

PCでは修飾キーなしの物理W/A/S/Dキーでも移動できる。キーの対応は
`KeyboardEvent.code` を基準に、`KeyW` = 上、`KeyA` = 左、`KeyS` = 下、
`KeyD` = 右とする。W/A/S/DはComposer editorにフォーカスしていない場合だけ
移動に使用し、Editorがemptyでも本文入力を優先する。input / textarea /
select / contenteditable等の別の入力操作中、IME composition中、修飾キー付き、
またはプロフィールDialog等の既存仕様上移動を無効化する状態では、W/A/S/Dを
横取りしない。

Arrowキーは長押し中も継続して移動できる。ただしposition同期の制約により、
移動は1秒あたり最大2回とする。成立したposition変化は短いvisual animationで
表示するが、animationはRelayで確定する前のローカルposition確定を意味しない。

W/A/S/Dの長押しもArrowキーと同じmovement hold driverを使用し、1秒あたり
最大2回、position publish、keyup、window blur、visibilitychange等の既存制御を
共有する。browserのrepeat eventを独立した移動requestとして扱わない。Arrowキーの
既存挙動は変更しない。特に、Composer editorが完全にemptyの場合のArrow移動は
維持する。

logical movementは8-neighborとし、up / down / left / rightのcardinal 4方向と、
up-right / down-right / down-left / up-leftのdiagonal 4方向を許可する。diagonalも
隣接diagonal cellへの1 stepを1 movementとして扱い、2つのcardinal movementへ分解しない。
したがってdiagonal 1回につきposition update、position publish、position slot消費、
presence activityはいずれも1 movement分とする。

destination cellがfield外またはoccupiedの場合はmovementを成立させない。diagonalの
occupancy判定はdestination cellだけを対象とし、orthogonal side cellによるcorner
blockingは行わない。blocked diagonalをcardinal movementへfallbackまたはslideさせない。
成立したmovementの最大レートはcardinal / diagonalで共通の1秒あたり2回とする。

pointer movementはPCとmobile/tabletで共通とし、mouse、pen、touchをWeb標準の
Pointer Eventsによる同じpointer gestureとして扱う。action-dockを除く通常のfield
viewport領域（fieldのvisual artwork・gridの外側を含む）から開始でき、fieldが所有する
selectable target（participant icon / profile trigger、Traceを調査するlogical-cell
selection target、調査中rootのauthor ghost profile trigger）では既存のtap/clickを維持しつつ、
drag確定後にmovementへtakeoverするdynamic / floating virtual joystickを使用する。
joystickはdrag確定後だけ表示し、centerはdrag開始位置とする。pointer release、pointer
cancel等のgesture終了時に消える。field外のtap/clickはlogical-cell selectionを発生させない。

pointerの移動方向は、cardinal 4方向とdiagonal 4方向の計8方向とする。joystickの
方向はequal-width 45度の8方向sectorへ量子化し、deflection magnitudeで移動速度を
変えない。pointer movementは既存の1マス移動、最大2 movement/sec、presence、position
publish、visual animationを再利用する。

tapとdragはgesture thresholdで区別するが、具体的なthresholdは実装詳細とする。
threshold未満のpointer releaseはmovementではなくlogical-cell selectionとして扱う。ただしlogical-cell selectionはfield内のtapに限る。field-owned
selectable targetでは元のtap / click actionを維持し、threshold以上でdragが確定した場合は
movementがgestureを取得して元のtarget actionを実行しない。Composer、input、textarea、select、
contenteditable、context/action menu、Dialog等、別操作を優先すべきinteractive UIでは本来の操作を維持し、
movement originにしない。具体的なthreshold値は実装詳細とし、現在の値を変更しない。
PCのArrow/WASD操作は維持し、押下中の上下成分と左右成分を合成した8方向の入力を
使用する。上下または左右の反対成分は相殺し、両成分が残る場合はdiagonalとして扱う。

field上の選択はpixel targetではなくlogical cellを基本にする。tap / clickはmovementには
使用せず、logical-cell selection専用とする。現在そのlogical cellから実行可能なselectable
actionが1件なら直接そのactionを
行い、2件以上ならPC/mobile共通context menuを開く。current characterは個別に表示し、
multiple rootsは1つの「痕跡を調べる」とする。outside tap/clickでmenuを閉じる。
movementはselectable cell actionやcontext menu itemとして提供しない。current character
周囲の4方向movement buttonやadjacent cell movementは設けない。menuを開いただけでは
conversation、reply target、draftを変更しない。

フィールド端では停止し、反対側へループしない。

他ユーザーが占有しているマスへ通常操作で移動することはできない。

相手との位置交換や、他ユーザーを押し出す処理は行わない。

発言の痕跡が存在するマスについては、痕跡そのものをユーザーによるマス占有とはみなさない。

position同期のNostr eventは1秒あたり最大2回とする。

この制約を超える実際の移動をローカルだけで成立させてRelay上のpositionと乖離させない。

同一秒内で3回目となる移動入力は、その移動をNostr上で表現可能になるまで成立させない。

この制限はアクションゲームとして高速移動させるためのものではなく、分散同期された論理フィールド上でpositionの順序を決定的に扱うための制約とする。

### 初期位置

初回入室時は、そのクライアントから見えている現在の占有状況を基に、空いているマスからランダムに初期位置を選ぶ。

決定した初期位置はposition更新としてNostrへ反映する。

### 同一マス競合

通常は1マス1ユーザーとする。

ただし、Nostr Relayを介した分散同期では、複数ユーザーが同時に同じ空きマスへ移動する競合を完全には防げない。

その場合は同一マスへの重複を許容する。

競合後に自動的にどちらかを別のマスへ移動させない。

重複したユーザーは、同じマス内でアイコンを少しずつずらして全員表示する。

### 満員時

フィールドに空きマスが存在しない場合は、新規入室者をランダムな既存マスへ重複配置する。

満員時専用の待機室や入室拒否は設けない。

---

## 16. positionとpresence

positionとpresenceは別の概念として扱う。

positionは「どこにいるか」を表す。

presenceは「最近この空間で能動的に活動しているか」を表す。

Relay上にposition情報が存在することだけを理由としてpresence状態とはみなさない。

### position

positionは、フィールド上で最後に確認されたユーザーの位置を表す。

MVPのPublic World State同期には、public application-specific dataの実験用として未登録のaddressable `kind 30079`を使用する。これはNIP-79準拠を意味しない。

`30079`以外のWorld State kindは使用せず、relayへNIP-79固有の処理やNIP-42 AUTHを要求しない。

active World Stateは2つのaddressable slotを使用する。`exit` stateはこの2-slot quotaと独立する。

プロトタイプでは `d` tagをchannel-scoped canonical形式とする。

slot 0：

`io.github.lokuyow.persona-bubble-field:world-state:1:<channel-id>:0`

slot 1：

`io.github.lokuyow.persona-bubble-field:world-state:1:<channel-id>:1`

explicit inactive World State：

`io.github.lokuyow.persona-bubble-field:world-state:1:<channel-id>:exit`

active / exitいずれも対象channelを `e` tagで1つだけ参照し、`content`には最後に有効だった
canonical grid coordinateを格納する。channel IDを `d` に含めるのは、NIP-01のaddressable
replacement identityに `e` tagが含まれないためであり、別channelのstateを置換しないためである。

`exit` participantはlast positionを保持するが、active occupancyには含めない。

live clientでnormalまたはrealtimeのdeath、またはnormal clearがbrowser-local lifecycleへ
durably commitされた場合、validなcanonical last positionを保持しているWorld sessionは、
そのIdentityの署名済みWorld State `exit`をbest-effortでpublishする。exitはactive slot
quotaを消費せず、対応するlifecycle mutationより前にはpublishしない。Relay failure、
exitをprepareできない状態、またはmutation後のpublication failureによってlocal lifecycle
mutationをrollbackしない。exitがない場合は通常どおり10分のpresence timeoutがfallback
となる。startup時点ですでにexpiredでlive canonical positionを持たない場合は、network
bootstrapを待つためにexitを要求しない。clear後に同じcleared Identityでfresh Runを開始
する場合、最初のpositive World Stateはexitよりstrictly newerなcreated_atでre-entryする。
browser close、unload、network disconnectだけではexitをpublishしない。

復元済みのactive Runでは、固定World Relayへのprimary REQを維持したまま、5 Relay中3 Relayで
messageとWorld Stateの双方がEOSEになった時点でselfの通常position・通常chatを開始できる。
3 Relayに達しない場合も、最初のprimary REQから750msが経過し、messageとWorld Stateの
双方で少なくとも1件のEOSEがあれば開始できる。この境界はbootstrap完了ではない。
残りのprimary購読、late evidence、最終的なcanonical handoffを継続し、Traceとrealtimeの
起動順序は変えない。全primaryが先に完了した場合は既存の完了境界を使用する。

この早期境界でのself writeは、browser-localのactive Runと同一Identityを確認した上で、
channel・Identity単位のdurable journalへtimestampとactive slotを先に予約する。
通常positionの発行経路は共通の予約を使い、通常chatもpositive activityとしてtimestampを
予約する。予約の失敗、古いRun、時計の逆行、または保存状態の不整合ではwriteを行わない。
初回journalがなく全bootstrapより先にentryが必要な場合は、起動秒より新しい実時刻まで
待つ。全bootstrapが先に完了して有効なself positionを復元できた場合は、この待機と
再entryを不要とする。成功したself positionはjournalへ記録し、reloadでの復元に使える。
最初の成功ACKまたは既存のechoで操作結果を確定しても、残りのauthoritative Relayへの
publicationと結果収集を継続する。後着ACKは終了済みsessionや旧Runの状態を変更しない。

terminal exitはdurableなdeath/clear lifecycle commitと同じtransactionでjournalの
timestamp fenceを確定し、その後だけbest-effortで発行する。publication failureや
process crashでもlifecycleを巻き戻さない。旧Runの予約や後着ACKは新しいRunを変更せず、
旧Runのjournal確認済み位置を新Runの位置として復元しない。同じIdentityのre-entryは
確定したexitより新しい実時刻を使用する。exitのpublicationが失敗して旧Runのactive
Relay evidenceが残っていても、新Runのpositive World Stateを発行する。

namespaceの扱いは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

`kind 30079` の `content` には、そのWorld State eventが示す論理フィールド座標をcanonical形式で格納する。

例：

`7:3`

World State eventは対象のNIP-28 channel kind 40を `e` tagで参照する。

専用clientは、構造・署名・channel参照が正しい場合でも、author pubkeyが現在のcharacter slotへ解決できないWorld State eventを有効なparticipant evidenceとして扱わない。未割当authorをpresenceまたはoccupancyへ追加しないため、presentation層だけで隠すfallbackは設けない。これはofficial-client認証ではなく、使用中slotへ対応するpubkeyを使う外部・改造clientまで防止するものではない。

概念的には以下の形式とする。

slot 0：

`kind = 30079`

`["d", "io.github.lokuyow.persona-bubble-field:world-state:1:<channel-id>:0"]`

`["e", "<kind40-event-id>", "<relay-url>"]`

`content = "7:3"`

slot 1：

`kind = 30079`

`["d", "io.github.lokuyow.persona-bubble-field:world-state:1:<channel-id>:1"]`

`["e", "<kind40-event-id>", "<relay-url>"]`

`content = "8:3"`

World State eventには、kindとchannel-scoped `d` tagおよびkind 40参照によって用途を識別できるため、NIP-32 `L` / `l` を必須としない。

position座標自体をNIP-32 `l` labelとして表現しない。

NIP-32はイベントの分類に使用し、座標値そのものとは責務を分離する。

### 2スロットの更新規則

同一pubkeyのposition更新は1秒あたり最大2回とする。

各Unix秒において、

- 1回目のposition更新はslot 0
- 2回目のposition更新はslot 1
- 3回目のposition更新は発行しない

とする。

同じ `d` の `kind 30079` を同一 `created_at` 秒内に複数回更新しない。

これにより、addressable eventで同一timestampの更新順をevent IDのtie-breakへ依存させない。

通常の高速移動時は概念的に以下となる。

- 12:00:00 1回目 → slot 0
- 12:00:00 2回目 → slot 1
- 12:00:01 1回目 → slot 0
- 12:00:01 2回目 → slot 1

独自のsequence番号やrevision番号は追加しない。

### 2スロットからのposition復元

同一pubkeyについて有効なslot 0 / slot 1を比較し、基本的に `created_at` が新しい方を採用する。

両slotの `created_at` が同一の場合はslot 1を後のpositionとして扱う。

これは公式クライアントが同一秒内で必ず、

slot 0 → slot 1

の順でposition更新を行うというプロトコル規則に基づく。

改造クライアント等がこの規則に従わないeventを発行することまで完全に防止・復元しようとしない。

### リロード時のslot選択

同一秒内に同じslotへ再度position eventを発行すると、2スロット方式の順序保証が崩れる。

そのためページ再読み込み・再接続等でローカルの「その秒に何件発行したか」という状態を失った場合は、直近のposition stateを復元してから新しいposition更新を行う。

現在のUnix秒について、

- slot 0が存在しslot 1が存在しない場合は、次のposition更新にslot 1を使用できる
- slot 0とslot 1の両方が存在する場合は、次の秒になるまで新しいposition更新を行わない

という原則で同一 `d` / 同一timestampの重複更新を避ける。

具体的なRelay取得・再接続処理は実装時に使用ライブラリの現行APIとRelay挙動を確認して決定する。

current Unix secondにslot 1が確認できる場合は、slot 0が取得結果に存在しなくても、その秒はすでに2スロットを消費済みとして扱い、次の秒まで新しいposition updateを発行しない。これは公式クライアントが同一秒にslot 0 → slot 1の順で発行するプロトコル規則に基づき、partialなRelay viewでslot 0を再利用しないためである。

---

## 17. 発言時position

過去の対象kind 42について、そのeventが行われた時点のフィールド座標を、position eventの履歴へ依存せずevent自身から復元できるようにする。

専用世界のtop-level kind 42には、発言時positionを表す単一文字 `w` tagを必須とする。trace conversation kind 1111はtree-onlyであり `w` を発行しない。過去に署名されたkind 1111の `w` はextra tagとして無視して受理する。

プロトタイプでは以下の形式とする。

`["w", "<x>:<y>"]`

例：

`["w", "7:3"]`

`w` は本プロジェクトではworld cellを表す。

kind 42の `w` は、そのeventが発行された時点の不変な発言位置を表す。

後からユーザーが移動してもkind 42の `w` は変化しない。

これにより、発言時positionの復元と、発言の痕跡を元の発言位置へ固定できる。旧`#w`位置別on-demand REQは使用しない。

`w` は物理的位置やgeohashを表すものではない。

NIP上の地理的位置tagへ本プロジェクトの架空の論理フィールド座標を流用しない。

公開仕様として固定する前には、その時点の最新NIPおよび既存tag利用状況を再確認する。

発言タイプやNIP-32 labelを含むkind 42全体の具体構造は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) および [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

---

## 18. position evidence

presence状態のユーザーについてcurrent positionを復元する際は、`kind 30079` だけでなく、通常chatとして受理したtop-level kind 42に含まれる `w` もposition evidenceとして扱う。explicit Traceであるkind 42の `w` はimmutableなTrace表示位置であり、presence/position evidenceには使用しない。kind 1111もposition evidenceに使用しない。

これはkind 42の `w` が、その発言が行われた時点での送信者のpositionを直接保持しているためである。

したがって、例えば、

- 20分前に移動した
- 1分前に同じ位置から発言した

ユーザーについては、20分前のposition eventを取得しなくても、1分前のkind 42の `w` から現在positionを復元できる。

その後に移動していれば、より新しい `kind 30079` を使用する。

これにより、presence状態の復元のために全期間のposition履歴を取得する必要をなくす。

### World State / position evidenceの同一秒優先順位

公式クライアントが生成するeventについて、同一 `created_at` 秒に複数のposition evidenceが存在する場合は、position決定上の優先順位を以下とする。

1. World State `exit`
2. World State active slot 1
3. World State active slot 0
4. 通常chat `kind 42` の `w`

まず `created_at` が新しいeventを優先し、同一 `created_at` の場合に上記優先順位を使用する。

公式クライアントでは、同一秒内に発言と移動が行われても、発言時 `w` とその時点のposition stateが矛盾しないようにする。

この規則は、event IDのtie-breakを含め、改造クライアント等が矛盾したeventを発行した場合の実際の操作順を復元するためのものではない。

同じ `created_at` と上記source priorityを持つposition evidenceが複数ある場合は、event IDがlexicographically lowestのものをdeterministicに採用する。position evidenceのsource priorityはcurrent positionの決定にのみ使用し、presenceの最終活動時刻は全valid activityの最大 `created_at` で決定する。

---

## 19. presence

presenceは、そのユーザーが最近この空間で**能動的に活動しているか**を表す。

以下をpresence活動として扱う。

- フィールド上での移動
- この専用世界でのメッセージ発言
- 発言の痕跡を明示的に調べる操作
- trace conversationへのreply投稿

同じマスに居続けて発言しているユーザーも、発言によってpresenceを維持する。

痕跡を読んでいるユーザーも、「調べる」という能動的な操作によってpresenceを更新する。

ページを開いたままにしているだけではpresenceを維持しない。

定期heartbeatによるpresence延命は行わない。

### presence evidenceの分離

presence projectionは `latestPositiveActivity` と `latestExit` を独立して保持する。

positive activityは通常chatとして受理したtop-level kind 42、World State active slot 0、World State active slot 1、
および下記の明示的な成功操作から得る。World State `exit` はpositive activityではない。
active条件は、positive activityが存在し、`positive.created_at > exit.created_at`（exitがある場合）
で、かつpositive activityが10分timeout内であることとする。同一秒はexitを優先しinactiveとする。
exitだけをbootstrapしたparticipantはlast positionを保持するが、positive lastActivityをexit時刻で
偽装せず、inactiveかつoccupancy外とする。新しいpositive activityはexit後のgeneric re-entryとして
activeへ戻せる。

### presence活動とNostr event

フィールド移動は、移動後の座標を持つ kind 30079 World State active更新として表現する。

専用世界での通常メッセージ発言は、`l=chat`を持ちTrace labelを持たず、発言位置を `w` tagに持つ有効なtop-level kind 42そのものをpresence activityとして扱う。`l=trace` kind 42のTrace rootはpositive activityではなく、death後のpresenceを再活性化しない。kind 1111 reply投稿もpresence activityとするが、reply自身は位置tagを持たない。

発言のためだけに追加の `kind 30079` を必ず発行する必要はない。

発言の痕跡を明示的に調べた場合またはreply投稿時は、必要に応じて現在座標を持つ kind 30079
World State active更新を発行し、その操作をpresence activityとして表現する。presence timeout後に
replyする場合も、reactivation後のpositionを確定してから `w` なしの1111を投稿する。

mending job開始成功、mending reward受取成功、ability upgrade成功の後にも、現在位置のWorld State
activeをbest-effortで発行する。game-state mutation成功後に発行し、World State publish失敗で成立済み
mutationをrollbackしない。dialogを開いただけ、blocked / insufficient points / max level / stale-no-op /
CAS不成立、settings等world gameplayでない操作では発行しない。

痕跡調査と同一秒内に、すでに同じユーザーによるposition更新等のpresence activityが存在する場合は、同一座標の冗長なposition eventを必ず追加する必要はなく、presence更新をcoalesceしてよい。

ただし、実際に座標が変化する移動eventをcoalesceによって失ってはならない。

### timeout

最後のpresence活動から10分間活動がなければpresence切れとする。

presence切れしたユーザーはフィールドから非表示にする。

presence切れと同時に、そのユーザーがいたマスは空きマスとして扱う。

Relay上に古いposition情報が残っていても、そのユーザーによる占有とはみなさない。

presence判定ではRelayから取得したeventの存在だけではなく、クライアント側で最後の有効なpresence activity時刻を判定する。

### リロード・再接続

presence切れ前に、

- ページを再読み込みした
- 一時的に接続が切れた
- 再接続した

場合は、同じ在室の継続として扱い、元の位置を復元する。

復元には、直近の有効な `kind 30079` と通常chatとして受理した専用世界kind 42の `w` をposition evidenceとして利用できる。Trace kind 42の `w` は利用しない。

### presence切れ後の復帰

presence切れ後にページを開いたまま再び操作した場合は再度presence状態へ復帰する。

元いたマスが空いていればそのマスへ戻す。

元いたマスが他ユーザーに使用されている場合は、空いているマスからランダムに再配置する。

空きマスが存在しない場合は、満員時のルールに従って既存マスへ重複配置する。

---

## 20. 初期同期とlive更新

Nostrからの初期同期と、その後のリアルタイム更新の間にeventを取りこぼす空白期間を作らない。

初期取得専用のsubscriptionを閉じてからlive専用subscriptionを新たに開始する方式を基本構成としない。

初期同期に使用した長寿命subscriptionをそのままlive更新へ継続利用し、Relayからのstored event受信と新規event受信を連続したstreamとして扱う。

NIP-01の `EOSE` を、各subscriptionについて保存済みeventの初期受信が一区切りしたことを示す境界として利用する。

### subscriptionの分離

MVPでは、少なくとも以下を論理的に別subscriptionとして扱う。

- 専用世界のkind 42 message
- `kind 30079` position
- trace conversation kind 1111

logical primary subscriptionは引き続きkind 42 messageとkind 30079 World Stateの2本とする。
`world-messages`は同一責務内で、recent用filterと直近タイムラインhistory用filterを2つ持つ
1つのREQとしてよい。recent用filterのbootstrap windowは従来どおりpresenceと生存bubbleの
復元に必要な範囲とし、timeline history用filterは`limit: 50`で取得する。`world-state`は
従来どおり1つのfilterを持つ。したがって、logical primaryの数を増やさずにREQ内の複数filterを
使用する構成を今回の仕様とする。

kind 1111は第3 logical subscriptionとする。第4の常時subscriptionは要求せず、notification、open root、current speechのNIP-22 filterを一つのfilter bundleとしてまとめる。個別filterの製品意味論は [`SPEC-50-発言の痕跡.md`](./SPEC-50-発言の痕跡.md) を正とする。

リアルタイムイベントのkind 7070 subscriptionは、上記の2つのlogical primary world subscriptionへfilterを混在させず、別のsupplemental subscriptionとして扱う。既知のNIP-11 `max_subscriptions` がprimary 2本と必要なリアルタイムsubscriptionを同時に許容しないRelayでは、そのRelayのリアルタイム機能だけを利用不能とし、world messageとpositionの利用可能性を変更しない。共通envelopeとevent定義は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

primary Worldの初期同期完了後、Trace初期取得とRealtime supplemental subscriptionの起動は独立して並行に進める。Realtime購読可能なRelay経路が成立すれば、Trace初期応答やTrace root cache reconciliationの完了を待たずにRealtime eventを処理する。Traceの初期・live取得、Worldのprimary同期とcanonical presence handoffは維持する。NIP-11上、同じRelayではprimary 2本に加えて必要なTrace reply 1本とRealtime 1本を超える常時subscriptionを要求しない。Trace filter bundleの再設定は既存Realtime購読を停止・再起動する理由にしない。Trace再設定中も既存Realtime streamを継続して27070/37070を処理する。

専用clientが発行するkind 30079 World Stateのpositionとexitには、任意の `r` tagでRun numberを付与できる。terminal exitでは `reason=death|clear` を付与し、reasonを付けるexitにはRun numberを必須とする。reasonのない旧形式exitから死亡・脱出理由を推定しない。参加者の署名済み鬼ごっこ登録RunとWorld StateのRunを照合し、より新しいRunのpositionが確認済みなら、以前のRunの遅延・再配信exitを現在Runの終了として扱わない。World Presenceの既存created_at/activity順序判定を維持し、新しいRunのactivityを古いexitで上書きしない。

RelayごとのWebSocket接続自体をsubscriptionごとに別接続へ分ける必要はなく、同一Relay接続上で複数subscriptionを管理してよい。

具体的なsubscription IDは製品仕様として固定しない。

### message subscription

専用世界のkind 42について、概念的に以下の条件で購読する。

- `kind = 42`
- 対象kind 40
- prototype NIP-32 namespace
- recent filter: `l = chat` または `l = trace`、初期同期に必要な `since`
- history filter: `l = chat`、`limit = 50`

recent用filterで初期取得した通常chat kind 42は、

- presence activity
- current position evidence
- 入室時点でまだ生存しているフキダシの復元

に利用できる。

timeline history用filterで取得した古い通常chat kind 42はtimeline表示には利用するが、presence activity、
current position evidence、生存bubble復元の根拠には利用しない。transportのbootstrap unionに
含まれるeventはclient側でevent ID dedupeし、`created_at >= messageSince`の境界をinitial
bootstrap後のlive/reconnect処理でも維持する。古いeventをlive callbackで受け取った場合も
presenceやbubbleを変更せず、timelineへの取り込みだけを行う。

message subscriptionの具体的なbootstrap期間は、presence timeoutとフキダシの最大表示寿命の双方を満たす範囲とする。

フキダシ表示時間の具体仕様が未決定であるため、現時点で固定秒数にはしない。

### World State subscription

kind 30079 World Stateについて、概念的に以下の条件で購読する。

- `kind = 30079`
- `#d` = channel-scoped active slot 0 / active slot 1 / exit
- 対象kind 40
- presence復元に必要な `since`

World State subscriptionでは、presence timeoutである10分より必要に応じて若干広いbootstrap範囲を取得してよい。

取得範囲にsafety marginを設ける場合でも、presenceそのものを10分より長く維持してはならない。

safety marginの具体値は製品仕様として現時点では固定しない。

### 初期presence snapshot

初期presenceとcurrent positionは、message subscriptionとWorld State subscriptionの双方から得た有効なactivityを統合して復元する。

どちらか片方の初期同期だけを見てpresence snapshot完成と判定しない。

複数Relayを使用する場合、応答しないRelayを永久に待って初期表示を停止させない。

各Relayの `EOSE`、接続失敗、初期同期timeout等を考慮したうえで利用可能な情報から初期状態を構築する。

具体的なtimeout値とライブラリ上の処理方法は実装時に決定する。

### live更新

初期同期後も同じsubscriptionを維持する。

新しい有効な `kind 30079` を受信した場合は、

- position
- last presence activity
- occupancy

等を更新する。

新しい有効な通常chat kind 42を受信した場合は、

- `w` によるposition evidence
- last presence activity
- フキダシ表示
- 合体表示等の会話state

を更新する。

ただし、`created_at < messageSince`のhistory eventはこのrecent world state更新の対象外とし、
timelineだけを更新する。timelineのhistoryとliveは同じevent ID dedupe・NIP-01 sort・最大50件の
stateへ渡す。

フキダシ側の具体的処理は [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

### 再接続

Relay接続が切れてsubscriptionを再作成する場合も、catch-up取得とlive更新の間に意図的な空白期間を作らない。

再接続時は、直前に正常処理した時点より少し前から再取得する方法、または初期bootstrap範囲を再取得する方法を使用できる。
再接続で同じ`world-messages`のrecent + `limit:50` history filter bundleを再送する場合も、
`messageSince`境界を変更せず、history-only eventをpresenceやbubble evidenceへ昇格させない。

重複して受信したeventはevent ID等によって重複排除する。

具体的なresume方法は、使用するNostrライブラリとRelayの現行挙動を確認して実装時に決定する。

---

## 21. trace root bootstrapとconversation transport

旧`#w`位置別on-demand REQを撤回する。trace root bootstrapでは、起動時に各authoritative Relayへ次の2つのworld識別用history filterを同じREQで要求する。

- `kinds=[42]`
- `#e=[対象kind40 event ID]`
- `#L=[project namespace]`
- normal candidate: `#l=["chat"]`
- explicit trace candidate: `#l=["trace"]`
- `limit=1000`

これはworld識別用Relay prefilterを維持し、旧`#w`位置filterだけを撤去する形である。他channelまたはproject外の全kind 42を取得して母集団へ含めない。

RelayのNIP-11 max limit等により1000未満になることは許容する。1000件を埋めるための追加paginationは保証しない。各RelayのEOSE / CLOSED / timeout後に結果を統合し、event IDでdedupeする。semantic validation後、normal chat candidateとexplicit trace candidateを独立してそれぞれ最大1000件へcapし、各class内およびcap後unionを`created_at`とevent IDで決定的に並べる。Trace candidateは通常chatのquotaを消費しない。

ここでrawとは上記Relay prefilterを通過したkind 42を意味する。Relay filterはcandidate narrowingでありauthorityではないため、最終的なnamespace marker、semantic class、canonical relation、署名、`w`はparserで検証する。normal chatには20%抽選を適用し、explicit Traceは抽選をbypassする。その後にcell/global root capを適用し、network受信途中にglobal capが埋まったことを理由にmulti-Relay bootstrapを早期終了しない。

第3 logical subscriptionでは、`SPEC-50`で定義するNIP-22 filter bundleをForward subscriptionとして扱う。filter bundle変更、per-Relay EOSE / CLOSED / timeout、reconnect、multi-Relay event ID dedupe、不要なhistory再取得の抑制はtransportの責務とする。cursor / since等のrx-nostr内部詳細は製品仕様として固定しない。

---
