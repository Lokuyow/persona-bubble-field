# Nostr・アカウント仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 3. チャット方式

NIP-28 Public Chatを使用する。

NIP-29へ置き換えない。

採用判断時点ではNIP-28が `unrecommended` であり、NIP-29の利用が推奨されていることは認識したうえで、以下の設計理由から意図的にNIP-28を採用する。

- Relay側にグループ管理を依存したくない
- バックエンドなし・通常のRelayで成立させたい
- 専用Relayを必要としない構成にしたい
- 外部投稿をネットワーク上から排除することより、専用クライアント内で見える世界を切り分けることを重視する

MVPではプロジェクト用のNIP-28 channelを1つ用意する。

最初から複数ルームには分けない。

メッセージにはNIP-28 kind 42を使用する。

### NIP-28 channel metadata

プロトタイプでは、NIP-28 channel kind 40として次のイベントIDを使用する。

`3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b`

kind 40 / kind 41 metadataの発見には、次のbootstrap Relayを使用する。

- `wss://nos.lol/`
- `wss://x.kojira.io/`
- `wss://relay.nostr.wirednet.jp/`
- `wss://yabu.me/`

これらはmetadata discovery用のseedであり、authoritativeなworld read/write Relay一覧ではない。worldのread/write Relay setは、検証済みのkind 40 / kind 41 metadataにある `relays` をauthorityとして解決する。

kind 41はkind 40のcreator pubkeyによるものだけを採用候補とし、target channelを参照する有効な候補が存在する場合は、`created_at` が最大のものを現在metadataとする。同値の場合はevent IDがlexicographically lowestのものを選ぶ。候補が存在しない場合はkind 40のinitial metadataを使用する。

選択した現在metadataのJSONまたは `relays` が不正な場合、kind 40や古いkind 41へsilent fallbackしない。`relays` はcanonicalize・dedupeし、元の出現順を維持する。

Relay hintはchannel identityではない。preferred hintは `wss://nos.lol/` とするが、authoritative metadataの `relays` に含まれる場合だけ使用し、含まれない場合はcanonical authoritative Relay arrayの先頭を使用する。

session中のkind 41 live追従はMVP要件とせず、session start / reload時にmetadataをresolutionする。

専用クライアントではkind 42をTwitter風タイムラインとして時系列に蓄積表示するのではなく、現在の会話を一時的なフキダシとして表示する。

Nostr Relay上にkind 42イベントが残ることと、専用クライアント上でフキダシが一定時間後に消えることは別の概念として扱う。

通常のフキダシ表示が終了した後も、有効なtop-level kind 42の一部は決定的な自動抽選によって「発言の痕跡」の対象となり得る。

これは通常の過去ログ表示を復活させるものではなく、一部の過去発言だけを空間上の記憶として再発見可能にするものである。

---

## 4. 専用世界の識別

専用世界のチャットメッセージとして投稿するkind 42には、NIP-32 Labelingの `L` / `l` self-labelを付与する。

このラベルは、

> **公式クライアントから送信されたことの証明ではない。**

専用世界に属するチャットメッセージとして投稿者自身が公開する識別情報として扱う。

NIP-32では、kind 1985以外のイベントへ `L` / `l` を付けるself-reportingが認められており、その場合ラベルはイベント自身を対象とする。

NIP-32のnamespaceは公開された語彙であり、認証・所有権・アクセス制御として扱わない。

そのため、外部ユーザーや改造クライアントが同じラベルを付けることは可能であり、MVPでは防止しない。

### prototype namespace

プロトタイプでは、NIP-32 namespaceとして以下を使用する。

`io.github.lokuyow.persona-bubble-field`

これはプロトタイプ用の暫定namespaceであり、正式公開後も維持する恒久識別子とはしない。

公開サービス名が確定した後、正式公開前に、そのサービス名を基礎とした恒久namespaceへ置き換える。

プロトタイプnamespaceから正式namespaceへの移行では、未公開・試験用イベントとの後方互換性を維持するためのlegacy pathは設けず、clean breakとする。

正式namespaceの具体値・表記形式は、公開サービス名の確定後に決定する。

### kind 42の基本ラベル

専用世界のkind 42には、以下を必須とする。

- `L` = `io.github.lokuyow.persona-bubble-field`
- `l` = `chat`
- `l` のnamespace marker = `io.github.lokuyow.persona-bubble-field`

プロトタイプでは、概念的に以下のtagを付与する。

`["L", "io.github.lokuyow.persona-bubble-field"]`

`["l", "chat", "io.github.lokuyow.persona-bubble-field"]`

### 発言タイプのラベル

発言タイプのうち、通常発言はデフォルトとして扱い、発言タイプ専用の `l` tagを追加しない。

叫びでは以下を追加する。

`["l", "speech:shout", "io.github.lokuyow.persona-bubble-field"]`

モノローグでは以下を追加する。

`["l", "speech:monologue", "io.github.lokuyow.persona-bubble-field"]`

したがって発言タイプは以下のように解釈する。

- `speech:*` の追加ラベルなし = 通常
- `speech:shout` = 叫び
- `speech:monologue` = モノローグ

発言タイプの詳細な表示・フキダシ挙動は [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

### kind 42の表示条件

以下を満たす**top-level** kind 42だけを、専用世界のチャットメッセージとして扱う。

- 対象のNIP-28 channel kind 40へのroot参照だけを持つ
- 所定のNIP-32 `L` namespaceが付いている
- 同namespaceをmarkerとする `l=chat` が付いている
- 発言時positionを表す単一canonical `w` が付いている

Relayのtag filterによる取得結果だけを認証結果として扱わず、受信したevent自体のtag構造をクライアント側でも検証する。

NIP-28形式のkind 42 replyは、外部client製を含め完全に無視する。live bubble、Chatter、presence evidence、trace root候補にせず、legacy reply互換経路も設けない。

発言の痕跡の候補も、この有効なtop-level kind 42から選ぶ。

kind 42には発言時の論理フィールド座標も保持する。

座標を表す具体的なtag形式とposition/presenceとの関係は [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) および [`SPEC-40-会話・フキダシ.md`](./SPEC-40-会話・フキダシ.md) を正とする。

### kind 1111: trace conversation reply

痕跡conversationへのreplyだけにNIP-22 kind 1111を使用する。通常live speechへのreply UIは設けない。

公式clientが生成するkind 1111には、次を必須とする。

- project `L` / `l` と `l=chat`
- root kind 42を指すuppercase `E` / `K` / `P`
- immediate parentを指すlowercase `e` / `k` / `p`
- kind 1111自身のworld position tagは持たない
- 必要な場合だけspeech type label

rootは有効なtop-level kind 42なので `K=42` とする。root kind 42へのdirect replyでは、rootを `E/K/P` と `e/k/p` の双方で参照する。kind 1111へのreplyでは、`E/K/P` は同じrootを維持し、`e/k/p` はparent kind 1111とそのauthorを指す。

project labelsはtarget-channel membershipまたは公式client証明ではない。受理する1111のuppercase `E` rootは、対象kind 40 worldに属する有効なtop-level kind 42でなければならない。immediate parentはroot自身または同じroot treeの有効な1111でなければならない。`K/P` と `k/p` は実際のroot/parentのkindとauthorに照合する。

external/modified client製1111も、署名、project labels、root/parent relation、kind、authorを全て検証できる場合だけ受理する。legacy signed replyに含まれる `w` はextra tagとして無視する。NIP-22の `p` は本文mentionにも使えるため、`p=self`だけで自分へのdirect replyや通知対象と判定してはならない。

`K/k/P/p`等のsemantic correctnessは受信後に検証する。REQを過度に狭めるための `#K` filterは必須としない。trace conversationの取得意味論は [`SPEC-50-発言の痕跡.md`](./SPEC-50-発言の痕跡.md) を正とする。

### NIP-09

NIP-09 / kind 5はMVP完全非対応とする。kind 5を発行、購読、検索せず、外部clientのdeletion requestをUI/cacheへ反映しない。tombstoneやdeleted-reply placeholderは導入しない。browserがすでに取得・cacheしたroot/replyをkind 5を理由に削除しない。Relayが物理削除したeventを未取得browserが取得できないことまでは制御しない。

### kind 30078等のアプリ固有イベント

position同期等に使用するアプリ固有イベントについては、kind 42と同じNIP-32 `L` / `l` self-labelを必須とはしない。

各イベントのkind、`d` tag、channel参照等によって用途を十分に識別できる場合は、NIP-32 labelを重複して付与しない。

positionイベントの具体仕様は [`SPEC-30-フィールド・position・presence.md`](./SPEC-30-フィールド・position・presence.md) を正とする。

### kind 0

kind 0は専用世界識別用のNIP-32ラベルの対象にしない。

専用クライアント内のプロフィール表示はkind 0ではなく、pubkeyから導出したキャラクターデータを使用する。

---

## 6. アカウント作成

初回利用時に新しいNostr鍵ペアをブラウザ上で生成する。

既存のNostrアカウントは持ち込ませない。

MVPでは以下を提供しない。

- nsec import
- NIP-07による既存アカウント利用
- NIP-46による既存アカウント利用

既存Nostrユーザーも、このクライアント用に新しいNostrアカウントを作成する。

生成された鍵は通常のNostr鍵であり、本クライアントだけで使用できる独自アカウントにはしない。

新規Nostrユーザーにとっては、このアカウントが最初のNostrアカウントになり得る。

---

## 7. 秘密鍵

秘密鍵はブラウザ内に保存する。

`ソトへ出る` を選択して正式な秘密鍵exportが解放されるまでは、通常のUI、ブラウザストレージの単純な閲覧、容易なコピー操作だけで、一般ユーザーが秘密鍵を簡単に取得できない状態にする。一度1000pt以上に到達しただけでは、この保護を解除しない。`ハコに残る` を選択した場合も、二周目でこの保護を維持する。保存時には暗号化、難読化、その他のクライアント側処理を用い、平文の秘密鍵がそのまま容易に読み取れる状態を避ける。

これは強固な暗号学的・セキュリティ上の境界ではない。JavaScript実行環境からのアクセス、DevTools、ソースコード解析・改変、ブラウザストレージの詳細解析、改造クライアント、独自コードによる抽出を行う利用者から秘密鍵を完全に保護することは要件としない。具体的な方式は [`SPEC-70-寿命・ゲーム・脱出.md`](./SPEC-70-寿命・ゲーム・脱出.md) を正とし、本資料では固定しない。

一般ユーザーには開始直後から秘密鍵を意識させない。

ゲーム仕様で定める、現在所持ポイントが1000pt以上である状態での脱出選択で `ソトへ出る` を選択したときだけ、一般Nostrへ移行するための秘密鍵export UIを提供する。1000pt以上を所持しているだけで自動的に脱出させず、過去の到達を永久unlock flagとして扱わない。`ハコに残る` を選択する場合の扱いは [`SPEC-70-寿命・ゲーム・脱出.md`](./SPEC-70-寿命・ゲーム・脱出.md) を正とする。

秘密鍵の内部保存形式は製品仕様として固定しない。

サーバー側backupは存在しない。

そのため、秘密鍵をexportしていない状態でブラウザのサイトデータを失うと、そのNostrアカウントも失われる可能性がある。

この制約は、データ消失や転生など必要な場面でユーザーへ説明する。

---

## 11. kind 0

初回アカウント作成時、割り当てられたキャラクターの情報を使用して通常のkind 0を発行する。

初期kind 0には、例えば以下を反映する。

- name
- about
- picture

これにより、一般Nostr上でも最初はそのキャラクターの姿を持つ。

prototype期間中に組み込みcharacter catalogまたは公式プロフィールを破壊的に更新する場合は、明示的なcharacter profile revisionを更新し、既存browser-local accountの鍵とアカウント作成時刻を維持したまま、現在のpubkey → character導出結果でkind 0を一度だけ再同期してよい。再同期時は新しいreplaceable eventになるよう、準備時点の現在Unix秒を `created_at` に使用する。

同期済みかはpubkeyだけではなくprofile revisionを含むbrowser-local markerで判定する。authoritative Relayへのpublish成功後だけ現在revisionを記録し、同じrevisionでは通常起動のたびに自動再発行しない。過去のpubkey-only markerは旧revisionへの同期済みとして扱う。

現在revisionへの同期後、ユーザーは従来どおり外部Nostrクライアントからkind 0を自由に変更できる。次の強制同期は、明示的にprofile revisionを更新した場合だけ行う。

なりきりクライアントにはプロフィール編集UIを設けない。

ただし、kind 0そのものを暗号学的に編集不能にはしない。

秘密鍵を持ち出したユーザーは、外部Nostrクライアントから自分のkind 0を自由に変更できる。

---

## 12. なりきりクライアント内でのプロフィール表示

なりきりクライアントでは、最新kind 0をキャラクター表示の正本として使用しない。

投稿者pubkeyから毎回キャラクターを導出し、そのキャラクターデータを表示する。

そのため、ユーザーが外部Nostrクライアントでkind 0を変更しても、なりきりクライアント内ではpubkeyに割り当てられたキャラクターのまま表示される。

役割を以下のように分離する。

- `kind 0` = 外のNostrで本人が自由に変更できるプロフィール
- `pubkey → character` = 専用世界で固定される人格

初回アカウント作成時には両者を同じ内容にする。

trace conversationのauthor表示は、kind 0ではなくpubkeyから導出したcharacter catalogを使用する。具体的なghostとProfile Dialogの表示規則は [`SPEC-50-発言の痕跡.md`](./SPEC-50-発言の痕跡.md) を正とする。

---

## 13. 一般Nostrへの移行

なりきりチャットから始めた新規ユーザーが、そのアカウントを一般のNostrへ持ち出すことを正式な利用経路として想定する。

秘密鍵exportが解放されたユーザーは、例えば以下を選べる。

- キャラクターの名前・アイコンのまま一般Nostrへ出る
- 一般Nostrでkind 0を自分好みに変更する

外部でプロフィールを変更しても、なりきりチャットへ戻ればpubkeyから導出された元のキャラクターとして表示される。

---

## 14. 転生・リセマラ

キャラクターを即座に引き直す機能は設けない。

キャラクター変更は「転生」として扱う。24時間に1回の任意転生、初回アカウント作成後の24時間禁止、任意のリセマラは設けない。転生は原則として死亡時のみ発生する。

死亡時の人格、鍵、identity、ポイント、能力の扱い、および死亡後の新しい鍵ペア・新人格への転生は [`SPEC-70-寿命・ゲーム・脱出.md`](./SPEC-70-寿命・ゲーム・脱出.md) を正とする。バックアップからの復元時は同じpubkey・秘密鍵を維持する。

### アカウント切替

投稿送信、署名等のアカウント依存処理中に、使用するアカウントが途中で切り替わらないようにする。

死亡後の転生によるアカウント切替は一連の処理として扱い、どの秘密鍵で署名するかが曖昧な状態を作らない。

---
