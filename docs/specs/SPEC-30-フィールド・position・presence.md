# フィールド・position・presence仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 15. フィールド

専用クライアントでは、ユーザーがキャラクターとして存在する2次元の論理フィールドを用意する。

フィールドは全ユーザー・全端末で共通の固定座標系とする。

現時点では縦8マス×横16マス程度を想定しているが、具体的なマス数は未決定とする。

各マスにはキャラクターアイコンと小さなキャラクター名を表示する。

発言の痕跡も、元の発言が行われたフィールド座標に対応するオブジェクトとして配置する。

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

### 移動

移動は以下とする。

- 1回の操作で1マス
- 上
- 下
- 左
- 右

斜め移動は行わない。

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

MVPのposition同期にはNIP-78 `kind 30078` のaddressable eventを使用する。

独自kindは追加しない。

positionは2つのaddressable slotを使用する。

プロトタイプでは `d` tagを以下とする。

slot 0：

`io.github.lokuyow.persona-bubble-field:position:0`

slot 1：

`io.github.lokuyow.persona-bubble-field:position:1`

namespaceの扱いは [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) を正とする。

NIP-78 `kind 30078` の `content` には、そのposition eventが示す論理フィールド座標をcanonical形式で格納する。

例：

`7:3`

position eventは対象のNIP-28 channel kind 40を `e` tagで参照する。

概念的には以下の形式とする。

slot 0：

`kind = 30078`

`["d", "io.github.lokuyow.persona-bubble-field:position:0"]`

`["e", "<kind40-event-id>", "<relay-url>"]`

`content = "7:3"`

slot 1：

`kind = 30078`

`["d", "io.github.lokuyow.persona-bubble-field:position:1"]`

`["e", "<kind40-event-id>", "<relay-url>"]`

`content = "8:3"`

position eventには、kindと `d` tagおよびkind 40参照によって用途を識別できるため、NIP-32 `L` / `l` を必須としない。

position座標自体をNIP-32 `l` labelとして表現しない。

NIP-32はイベントの分類に使用し、座標値そのものとは責務を分離する。

### 2スロットの更新規則

同一pubkeyのposition更新は1秒あたり最大2回とする。

各Unix秒において、

- 1回目のposition更新はslot 0
- 2回目のposition更新はslot 1
- 3回目のposition更新は発行しない

とする。

同じ `d` の `kind 30078` を同一 `created_at` 秒内に複数回更新しない。

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

過去の対象kind 42について、その発言が行われた時点のフィールド座標を、position eventの履歴へ依存せずkind 42自身から復元できるようにする。

専用世界のkind 42には、発言時positionを表す単一文字 `w` tagを必須とする。

プロトタイプでは以下の形式とする。

`["w", "<x>:<y>"]`

例：

`["w", "7:3"]`

`w` は本プロジェクトではworld cellを表す。

kind 42の `w` は、そのeventが発行された時点の不変な発言位置を表す。

後からユーザーが移動してもkind 42の `w` は変化しない。

これにより、

- 発言時positionの復元
- 発言の痕跡を元の発言位置へ固定
- Relay上で特定セルのkind 42をREQ
- Relay上で複数セルのkind 42をREQ

できる構造とする。

単一文字tagはRelayによるtag filterの対象として利用できるため、将来の位置別取得に使用できる。

例えばセル `7:3` の発言を取得する場合は、概念的に `#w = ["7:3"]` を使用できる。

複数セルを取得する場合は、同じ `#w` filterの値として複数のcanonical cell値を列挙できる。

`w` は物理的位置やgeohashを表すものではない。

NIP上の地理的位置tagへ本プロジェクトの架空の論理フィールド座標を流用しない。

公開仕様として固定する前には、その時点の最新NIPおよび既存tag利用状況を再確認する。

発言タイプやNIP-32 labelを含むkind 42全体の具体構造は [`SPEC-10-Nostr・アカウント.md`](./SPEC-10-Nostr・アカウント.md) および [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

---

## 18. position evidence

presence状態のユーザーについてcurrent positionを復元する際は、`kind 30078` だけでなく、専用世界のkind 42に含まれる `w` もposition evidenceとして扱う。

これはkind 42の `w` が、その発言が行われた時点での送信者のpositionを直接保持しているためである。

したがって、例えば、

- 20分前に移動した
- 1分前に同じ位置から発言した

ユーザーについては、20分前のposition eventを取得しなくても、1分前のkind 42の `w` から現在positionを復元できる。

その後に移動していれば、より新しい `kind 30078` を使用する。

これにより、presence状態の復元のために全期間のposition履歴を取得する必要をなくす。

### 同一秒のposition evidence

公式クライアントが生成するeventについて、同一 `created_at` 秒に複数のposition evidenceが存在する場合は、position決定上の優先順位を以下とする。

1. `kind 30078` slot 1
2. `kind 30078` slot 0
3. `kind 42` の `w`

まず `created_at` が新しいeventを優先し、同一 `created_at` の場合に上記優先順位を使用する。

公式クライアントでは、同一秒内に発言と移動が行われても、発言時 `w` とその時点のposition stateが矛盾しないようにする。

この規則は、改造クライアント等が矛盾したeventを発行した場合の実際の操作順を復元するためのものではない。

---

## 19. presence

presenceは、そのユーザーが最近この空間で**能動的に活動しているか**を表す。

以下をpresence活動として扱う。

- フィールド上での移動
- この専用世界でのメッセージ発言
- 発言の痕跡を明示的に調べる操作

同じマスに居続けて発言しているユーザーも、発言によってpresenceを維持する。

痕跡を読んでいるユーザーも、「調べる」という能動的な操作によってpresenceを更新する。

ページを開いたままにしているだけではpresenceを維持しない。

定期heartbeatによるpresence延命は行わない。

### presence活動とNostr event

フィールド移動は、移動後の座標を持つ `kind 30078` position更新として表現する。

専用世界でのメッセージ発言は、発言位置を `w` tagに持つkind 42そのものをpresence activityとして扱う。

発言のためだけに追加の `kind 30078` を必ず発行する必要はない。

発言の痕跡を明示的に調べた場合は、必要に応じて現在座標を持つ `kind 30078` position更新を発行し、その操作をpresence activityとして表現する。

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

復元には、直近の有効な `kind 30078` と専用世界kind 42の `w` をposition evidenceとして利用できる。

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
- `kind 30078` position

1つのREQへ複数filterを詰め込むことを前提とせず、各subscriptionは1つの主要な責務とfilterを持つ構成を基本とする。

RelayごとのWebSocket接続自体をsubscriptionごとに別接続へ分ける必要はなく、同一Relay接続上で複数subscriptionを管理してよい。

具体的なsubscription IDは製品仕様として固定しない。

### message subscription

専用世界のkind 42について、概念的に以下の条件で購読する。

- `kind = 42`
- 対象kind 40
- prototype NIP-32 namespace
- `l = chat`
- 初期同期に必要な `since`

初期取得したkind 42は、

- presence activity
- current position evidence
- 入室時点でまだ生存しているフキダシの復元

に利用できる。

message subscriptionの具体的なbootstrap期間は、presence timeoutとフキダシの最大表示寿命の双方を満たす範囲とする。

フキダシ表示時間の具体仕様が未決定であるため、現時点で固定秒数にはしない。

### position subscription

`kind 30078` positionについて、概念的に以下の条件で購読する。

- `kind = 30078`
- `#d` = slot 0 / slot 1
- 対象kind 40
- presence復元に必要な `since`

position subscriptionでは、presence timeoutである10分より必要に応じて若干広いbootstrap範囲を取得してよい。

取得範囲にsafety marginを設ける場合でも、presenceそのものを10分より長く維持してはならない。

safety marginの具体値は製品仕様として現時点では固定しない。

### 初期presence snapshot

初期presenceとcurrent positionは、message subscriptionとposition subscriptionの双方から得た有効なactivityを統合して復元する。

どちらか片方の初期同期だけを見てpresence snapshot完成と判定しない。

複数Relayを使用する場合、応答しないRelayを永久に待って初期表示を停止させない。

各Relayの `EOSE`、接続失敗、初期同期timeout等を考慮したうえで利用可能な情報から初期状態を構築する。

具体的なtimeout値とライブラリ上の処理方法は実装時に決定する。

### live更新

初期同期後も同じsubscriptionを維持する。

新しい有効な `kind 30078` を受信した場合は、

- position
- last presence activity
- occupancy

等を更新する。

新しい有効なkind 42を受信した場合は、

- `w` によるposition evidence
- last presence activity
- フキダシ表示
- 合体表示等の会話state

を更新する。

フキダシ側の具体的処理は [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

### 再接続

Relay接続が切れてsubscriptionを再作成する場合も、catch-up取得とlive更新の間に意図的な空白期間を作らない。

再接続時は、直前に正常処理した時点より少し前から再取得する方法、または初期bootstrap範囲を再取得する方法を使用できる。

重複して受信したeventはevent ID等によって重複排除する。

具体的なresume方法は、使用するNostrライブラリとRelayの現行挙動を確認して実装時に決定する。

---

## 21. 過去発言の位置別REQ

通常のlive world state取得と、過去発言を位置から探す取得は別の用途として扱う。

通常のlive world stateは主として時間範囲によって取得する。

発言の痕跡等で過去発言を位置から取得する場合は、kind 42の `w` tagを利用したon-demand REQを使用できる。

例えば特定セルまたは周辺セルについて、

- kind 42
- 対象kind 40
- prototype NIP-32 namespace
- `l = chat`
- `#w` = 対象セル群
- 痕跡の寿命等に応じた時間条件

で取得できる構造とする。

過去発言を位置別に取得するためだけに、すべてのkind 42履歴を常時live subscriptionへ流し続ける設計にはしない。

痕跡の具体的な抽選、寿命、上限、調査範囲等は [`SPEC-50-発言の痕跡.md`](./SPEC-50-発言の痕跡.md) を正とする。

---
