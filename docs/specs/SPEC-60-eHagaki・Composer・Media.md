# eHagaki Composer・Media仕様

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 5. eHagaki

投稿UIにはeHagaki Web Componentの**Host-owned Composer Lite版**を使用する。

iframe版ではなくWeb Component版を使用する。

eHagakiは、最終Nostrイベントを所有・送信するpublisherではなく、**Nostr向けComposer**として利用する。

MVPではテキスト入力のみを利用する。

MVPでは以下を利用しない。

- 画像
- 動画
- カスタム絵文字

これらを将来追加することは禁止しないが、現時点のMVP仕様には含めない。

### eHagakiが所有するもの

MVPでは主として以下を所有する。

- 本文編集
- 最終的な投稿本文 `content`
- 投稿操作中のComposer UI状態
- 汎用Composerとして本文編集に必要な内部状態

### 親クライアントが所有するもの

- 現在のNostrアカウント
- NIP-28 channel
- event `kind`
- NIP-28の構造的tag
- NIP-32 `L` / `l`
- 発言タイプ
- `pubkey`
- `created_at`
- 最終eventのtag統合
- event ID生成
- 署名
- Relay選択
- Relay送信
- キャラクター管理
- フィールド位置
- presence
- フキダシ表示
- 同一発言の合体表示
- 発言の痕跡
- 痕跡化判定
- 痕跡の表示・調査
- 痕跡の既読状態
- 専用クライアント固有の空間ルール

`client` tagは使用しない。

eHagakiはComposer Outputを親クライアントへ渡し、親クライアントが最終Nostr eventを構築する。

Host-owned Composer Liteの公開component APIには、親クライアントがComposer
editorへフォーカスを移すための `focusEditor()` と、editorからフォーカスを外す
ための `blurEditor()` を含める。persona-bubble-fieldは、Host-ownedの
component境界と型定義を通じてこの2つのAPIを利用し、Shadow DOM内部の
`.ProseMirror` 等のselectorへ依存しない。

PCでEditorにフォーカスしている状態のEscapeは、本文やselectionを消去せずに
`blurEditor()`を呼び出してEditorからフォーカスを外す。ただしIME composition中の
Escapeは親クライアントのshortcutとして横取りしない。Editor外で、他の
input / textarea / select / contenteditable等の入力操作中でなく、プロフィール
Dialog等が開いていない状態の修飾キーなし物理 `KeyN` は `focusEditor()` を呼び出す。
Editorが既にフォーカスされている場合、Nは通常の本文入力とする。shortcutを実際に
処理した場合だけ、必要なbrowser defaultを抑止する。

その他の具体的なWeb Component APIやデータ構造はeHagaki側の設計で決定する。

親クライアント管理で利用する場合、eHagaki自身へのNostrログインを投稿可能条件としない。

秘密鍵そのものをeHagakiの公開Web Component APIへ渡さない。

任意のNostr eventを署名できる汎用SignerをeHagakiへ渡すことを前提としない。

eHagakiになりきりクライアント固有の世界ルールを埋め込みすぎず、汎用Nostr Composerとして維持する。

---

## 26. Media

MVPでは画像・動画を投稿しない。

そのためMVPでは、

- media選択
- media編集
- media変換
- media圧縮
- media upload
- media upload認証
- `imeta`
- upload結果のComposer反映
- upload済みmedia cleanup

等のmedia投稿フローを、なりきりクライアントとの統合要件として持たない。

発言の痕跡もMVPではテキスト発言のみを対象とする。

将来media対応を追加することは禁止しない。

将来追加する場合は、

- eHagakiと親クライアントの責務分離
- upload責任
- 署名責任
- media handoff
- フキダシ内での表示方法
- 表示時間
- 発言領域への影響
- mediaを含む発言を痕跡化するか
- 痕跡化したmediaの寿命・可用性・表示方法

をその時点で改めて仕様化する。

---
