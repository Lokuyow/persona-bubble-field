# 未決定事項

> この文書は本プロジェクトの確定仕様の一部です。Source of Truthの入口は [`docs/PROJECT.md`](../PROJECT.md) とし、本資料を含む同資料記載の `SPEC-*` 文書一式と併用する。個別仕様は、その仕様を記載する文書を正とする。

## 27. 現時点で未決定

以下はまだ確定していない。

ここでは、製品仕様・UX・外部データ構造として今後判断が必要な事項を管理する。確定済みの製品上の挙動・優先順位を満たすための内部algorithmやlibrary選択だけが未確定である場合は、本一覧へ含めない。

### サービス・Nostr

- 公開サービス名 / サイトタイトル
- 正式公開時の恒久NIP-32 namespace
  - prototypeでは `io.github.lokuyow.persona-bubble-field` を使用する
  - `l=chat`、`speech:shout`、`speech:monologue` の語彙はprototype仕様として確定済み
- 正式公開時のposition用 `kind 30078` の恒久 `d` tag値
  - prototypeでは `io.github.lokuyow.persona-bubble-field:position:0` / `io.github.lokuyow.persona-bubble-field:position:1` を使用する
- kind 42の発言位置tag `w` を正式公開仕様として恒久採用するか
	- prototypeではkind 42だけが `["w", "<x>:<y>"]` を使用する。kind 1111 replyはtree-onlyであり、`w` を発行しない
  - 正式公開仕様として固定する前に、その時点の最新NIPおよび既存の単一文字tag利用状況を再確認する
- 正式公開時のmetadata discovery bootstrap Relay set
  - prototypeでは `wss://nos.lol/`、`wss://x.kojira.io/`、`wss://relay.nostr.wirednet.jp/`、`wss://yabu.me/` を使用する
- 正式公開時に使用するNIP-28 channel kind 40
  - prototypeでは `3212de4b75f0c41efa17e41affcfc3a811171ba930e5b657687b5f5148627d5b` を使用する
- モデレーション方針
- 通報・ミュート等の扱い

### キャラクター

- キャラクター総数
- キャラクターの具体的な世界観
- 各キャラクターの具体的な内容
- キャラクターカテゴリの具体的な分類
- キャラクターカテゴリごとの具体的な目標比率
- キャラクター画像の具体的な画風
- 顔中心 / バストアップ / 全身等の具体的な構成比
- 制作原画の具体的な解像度、形式、保存場所等
- その他、今回確定していない画像制作方法の細部

### フィールド・UI

- フィールドの具体的なマス数
- PCで表示するフィールド範囲
- スマートフォンで表示するフィールド範囲
- マスの具体的なサイズ
- キャラクターアイコンの具体的なサイズ

### 会話・フキダシ

- 発言領域の具体的な高さ・レイアウト
- フキダシの未確定な細部のデザイン
- 通常・叫び・モノローグの追加animation、細かな装飾、将来のtype別サイズ変更
- フキダシ表示時間の具体的な計算
- 発言文字数の具体的な上限
- 合体フキダシの具体的な巨大化・強調方法
- 発言者識別に使う色パレット

### 将来機能

- 将来の画像・動画対応
- 将来のカスタム絵文字対応

---
