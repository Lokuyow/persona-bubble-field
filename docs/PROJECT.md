# persona-bubble-field プロジェクト仕様・設計

本資料は、本repository内で管理するプロジェクト固有の情報・制約と製品仕様の入口を定義する。

設計、仕様検討、調査、Plan作成、実装では、本資料と、本資料に列挙する `SPEC-*` 文書一式をプロジェクト固有の前提として使用する。

# Source of Truth

repository-trackedな本資料と、以下に列挙する `docs/specs/` 配下の `SPEC-*` 文書一式を、本プロジェクトの製品仕様・設計上のSource of Truthとして扱う。

通常の確定仕様の基準は `main` にmergeされた本資料および `docs/specs/` 配下の文書とする。仕様と実装を意図的に同時変更するPRまたは作業branchでは、そのbranch内の仕様変更を当該変更対象として扱う。

本資料は、プロジェクトの識別、製品の上位方針、確定仕様の扱い、仕様文書の索引、外部仕様・外部コンポーネントの扱い、リポジトリ・技術構成・開発環境・デプロイ環境・Git運用・ライセンス等を管理する。

個別ドメインの詳細仕様は各 `SPEC-*` 文書を正とする。同じ仕様を複数文書へ詳細に複製しない。

## 仕様文書一覧

- [`SPEC-10-Nostr・アカウント.md`](specs/SPEC-10-Nostr・アカウント.md)
  - NIP-28 / NIP-32、専用世界の識別、アカウント、秘密鍵、kind 0、一般Nostrへの移行、転生
- [`SPEC-20-キャラクター.md`](specs/SPEC-20-キャラクター.md)
  - キャラクター割当、キャラクターデータ、名前、画像、重複、公開後の固定ルール
- [`SPEC-30-フィールド・position・presence.md`](specs/SPEC-30-フィールド・position・presence.md)
  - フィールド、移動、position、presence
- [`SPEC-40-会話・フキダシ.md`](specs/SPEC-40-会話・フキダシ.md)
  - 発言表示範囲、発言領域、フキダシ、発言タイプ、合体表示、コミュニケーション機能
- [`SPEC-50-発言の痕跡.md`](specs/SPEC-50-発言の痕跡.md)
  - 発言の痕跡、痕跡化、寿命、上限、調査、既読
- [`SPEC-60-eHagaki・Composer・Media.md`](specs/SPEC-60-eHagaki・Composer・Media.md)
  - eHagakiとの責務分担、Host-owned Composer Lite版、Media
- [`SPEC-90-未決定事項.md`](specs/SPEC-90-未決定事項.md)
  - 現時点で未決定としている製品仕様

`SPEC-00` や別の仕様INDEX文書は置かない。本資料を仕様文書群への入口とする。

## 技術選定の参考資料

[`persona-bubble-field 技術選定 Deep Research`](research/persona-bubble-field%20技術選定%20Deep%20Research.md) は、ライブラリ・Web標準・レンダリング方式・Nostrクライアント基盤の技術選定を検討した参考資料として扱う。

同資料は製品仕様のSource of Truthではない。製品仕様は本資料と `SPEC-*` 文書を正とし、技術選定資料の過去の調査計画やSPIKE予定が、後続のprototype検証結果や現在の実装と食い違う場合は、現在確認済みの実装結果を優先して技術判断を更新する。

フキダシ重なり回避については、prototypeでproject-ownedのdeterministic discrete-candidate placementを実装・検証し、現在の要件を満たすことを確認したため、`avoid-overlap` との比較SPIKEは現時点では行わない。実利用で配置品質またはperformance上の不足が確認された場合にのみ再評価する。

# プロジェクト

> 仮称: なりきりパブチャ\
> 公開サイトタイトル: 未決定

Nostrを通信基盤として、現実の自分とは別のランダムな人格として会話するパブリックチャットクライアントを設計・実装する。

公開サービス名・サイトタイトルは未決定であり、確定したものとして扱わない。

# 製品上位仕様

## 0. 設計原則

本クライアントは、**バックエンドなしで成立するシンプルなNostrクライアント**を基本とする。

- 静的Webアプリ、ブラウザ内ストレージ、既存Nostr Relayで成立する構成を優先する
- ユーザーDB、専用認証サーバー、専用Relayを安易に追加しない
- 厳密な不正防止より、シンプルなフロントエンド構成を優先する
- バックエンドなしでは完全に防げない行為については、その制約を明示し、必要に応じて通常ユーザー向けのUX上の抑止策を設ける
- 可能な限り既存NIP・標準イベントを利用し、独自kindや独自イベント形式を安易に追加しない
- 専用クライアント固有のルールはNostr全体へ強制するのではなく、主として専用クライアント内の表示・操作ルールとして実現する
- NIPに依存する詳細を実装するときは、その時点の最新仕様を確認する

MVPはバックエンドなしで実装する。

将来も原則としてこの構成を維持する。ただし、重要な機能がフロントエンドのみでは成立せず、その機能を追加する利益が複雑化を上回る場合は改めて判断する。

バックエンドを導入する場合は単なる実装判断ではなく、**確定仕様の変更として明示的に判断する**。

---

## 1. コンセプト

Nostrを通信基盤として使い、ユーザーが現実の自分とは別のランダムな人格として会話するパブリックチャットクライアントを作る。

既存Nostrユーザーだけでなく、新規Nostrユーザーにも使ってもらうことを想定する。

新規ユーザーは、なりきりチャットを入口としてNostrアカウントを作成し、後からそのアカウントを一般のNostrクライアントへ持ち出して、そのままNostr世界へ参加できるようにする。

本クライアントの中核は「匿名SNS」ではなく、

> **別の人格を与えられて、その人格としてNostr上で会話する**

ことである。

世界観の方向性は以下。

- 現実の自分を持ち込まない
- 現実のプロフィールや人間関係から離れる
- 与えられた別人格として会話する
- 「匿名になる」よりも「別の誰かになる」ことを重視する
- 異世界転生やVtuber的な要素は参考にするが、具体的な世界観・公開名称は未決定

専用クライアントの会話体験は、投稿が時系列に蓄積するSNS型タイムラインではなく、

> **キャラクターが同じ空間に存在し、その場で現在の会話を行う空間型チャット**

を中心とする。

通常の発言は揮発するが、過去の発言の一部だけを、その発言が行われた場所に残る「発言の痕跡」として扱う。

発言の痕跡は通常の過去ログやタイムラインではなく、

> **空間に残った一部の発言の記憶**

として扱う。

現在の会話状況を把握するため、フィールドviewport上に`Chatter`という有限の補助UIを
持ち、直近最大50件を内部保持する。表示領域へ収まるentryだけを表示し、50件を常に
画面へ表示するものではない。これは無制限の過去ログやSNS型feedを主画面にするものではなく、
空間型チャットを補助する有限のUIである。

---

## 2. 基本構成

MVPは以下で成立させる。

- 静的Webアプリ
- 既存Nostr Relay
- ブラウザ内ストレージ
- eHagaki Web ComponentのHost-owned Composer Lite版

MVPでは以下を持たない。

- ユーザー登録DB
- キャラクター割当DB
- 専用認証サーバー
- 専用Relay

バックエンドがないため、以下のような方法によるクライアント側ルールの回避は完全には防止しない。

- 改造クライアント
- DevTools
- サイトデータ削除
- 別ブラウザ
- private browsing
- 独自実装
- Nostrプロトコルの直接利用

これらを防ぐためだけにバックエンドを追加しない。

---

## 28. 実装時の重要原則

以下は、個別仕様を実装へ落とす際に横断して適用する。

- バックエンドなしで成立する構成を基本とし、クライアント間の表示差や位置競合を中央管理するためだけにバックエンドやロックサーバーを追加しない
- 可能な限り既存NIP・標準イベントを利用し、NIP-28 Public ChatをNIP-29へ自動的に置き換えない
- NIP-32ラベルを認証・公式クライアント証明として扱わない
- 専用世界固有のルールは主として親クライアント側で管理し、eHagakiは汎用Nostr Composerとして維持する
- eHagakiへ秘密鍵や任意eventを署名できる汎用Signerを渡さず、最終Nostr eventの構築・署名・送信は親クライアントが担う
- 合体表示や発言の痕跡のために元のkind 42を統合・改変せず、各発言を独立したNostr eventとして維持する
- 発言の痕跡のためだけに通常の過去ログ、Twitter型タイムライン、独自の「保存投稿」kindを導入しない
- 痕跡化判定と上限処理は、同じ前提条件を持つクライアントが同じ結果を導出できる決定的な方式を優先する
- position方式は現在位置の同期だけでなく、過去の対象kind 42について発言時位置を復元できることを満たす
- Nostr上の事実と専用クライアント上の表示・操作ルールを区別し、バックエンドなしでは防げない行為を防げるものとして設計しない
- 新規ユーザーへNostrの専門知識や秘密鍵管理を最初から要求せず、なりきり体験を入口として成立させる
- pubkey → characterの既存対応など公開後に変更しにくい構造は互換性を重視する
- キャラクターごとの個別レアリティを導入せず、特定キャラクターを意図的な当たり・ハズレとして扱わない
- キャラクターの名前、設定、画像等を必要以上に規格化せず、同じ世界としての最低限の統一感とキャラクターごとの幅を両立する
- キャラクター制作時のカテゴリ比率は品質管理の目安として使用し、数合わせを目的に品質を下げない
- NIP依存の詳細は実装時点の仕様を確認する
- UI試作や実利用で判断すべき寸法、時間、確率、上限数、見た目等を根拠なく早期固定しない
- 製品として必要な挙動・優先順位と、その実現に使う内部algorithmやlibrary選択を区別する。内部実装だけで完結し、製品挙動を変えない具体algorithmは `SPEC-90` の未決定事項として固定管理しない

# 確定仕様の扱い

設計、Plan、実装では、本資料と対象作業に関係する `SPEC-*` 文書との整合性を確認する。

過去の会話、古いPlan、以前の提案と現在の確定仕様が異なる場合は、現在の確定仕様を優先する。

ユーザーが明示的に変更しない限り、確定仕様を勝手に変更しない。

新しい提案が確定仕様と衝突する場合は、既存仕様との衝突点を明示し、仕様変更として扱う。

ユーザーがアイデア、検討案、候補、未確定案として提示した内容は、明示的に採用されるまで確定仕様として扱わない。

会話の途中で方針が決まった場合も、ユーザーが確定仕様として採用する意図を示した場合に確定事項として扱う。

[`SPEC-90-未決定事項.md`](specs/SPEC-90-未決定事項.md) 等で未決定としているプロダクト上の判断を、実装上必要という理由だけで推測して固定しない。

実装時に通常判断できる内部実装の細部と、プロダクトとして決める必要がある仕様を区別する。

# 外部仕様

Nostr仕様：

https://github.com/nostr-protocol/nips

NIP等の外部仕様が設計、Plan、実装へ影響する場合は、その時点の対象仕様を確認する。

確認していないNIPの挙動や、仕様に存在しない意味を推測で実装方針へ固定しない。

確定仕様で特定のNIPや方式が意図的に採用されている場合、別方式が新しい、一般的、recommended等の理由だけで自動的に置き換えない。

既存の確定仕様を変更する必要が生じた場合は、単なる実装判断ではなく仕様変更として扱う。

Nostr上で技術的に可能なことと、本専用クライアント上で許可・表示することを区別する。

# eHagaki

本プロジェクトではeHagakiを外部の汎用Nostr Composerとして利用する。

eHagakiとの具体的な責務分担やMVPで利用する機能は、本資料および対象の `SPEC-*` 文書を正とする。

eHagakiとの統合方式、Web Component API、イベント、属性、Composer Output等について実装判断が必要な場合は、現在のeHagaki実装、公開API、関連資料を確認する。

まだ存在しない、または未確定のeHagaki APIを前提として親クライアントの設計を固定しない。

eHagaki側の変更が必要な場合は、少なくとも次を区別する。

- 汎用Composerとして自然な責務か
- 他の埋め込み利用でも成立するAPIか
- 親クライアント側で持つべき専用仕様ではないか

本クライアント固有の要件だけを理由に、専用世界固有の責務をeHagakiへ安易に移さない。

# 設計判断

設計判断では本資料および現在の `SPEC-*` 文書一式を前提とする。

確定仕様で意図的に採用されているトレードオフを、一般論だけを理由に覆さない。

提案が現在の確定仕様を変更する場合は、通常の実装判断ではなく仕様変更として明示する。

確定仕様で未決定としているプロダクト上の事項を、実装上必要という理由だけで勝手に確定しない。

複数の有力案がある場合は、今回の判断に実際に関係する観点で比較し、現在の確定仕様と中心コンセプトに最も整合する案を示す。

「現実の自分を持ち込まず、別の誰かとして会話する」という中心コンセプトを、UX・機能・設計判断の基準として扱う。

# リポジトリ・技術構成・開発環境

## リポジトリ

- GitHub repository: `Lokuyow/persona-bubble-field`
- Repository URL: `https://github.com/Lokuyow/persona-bubble-field`
- Public repositoryとして運用する
- Default / base branchは `main`
- `persona-bubble-field` は仮の開発用リポジトリ名であり、公開サービス名・サイトタイトルを確定するものではない
- 正式名称の決定等に応じて、将来リポジトリ名を変更してよい

## 技術構成

- SvelteKitを使用する
- TypeScriptを使用する
- MVPは静的Webアプリとして構築する
- SvelteKitのstatic adapterを使用して静的buildする
- GitHub Pagesでホストする
- GitHub Pagesのproject siteとして動作するようbase pathを考慮する

SvelteKit、adapter、依存ライブラリ等の具体的なバージョンは、必要な互換性条件を除き本資料で固定せず、実装時点の対象環境と公式仕様を確認する。

## Node.js・開発環境

- 対応Node.js majorはNode 24とする
- 最低対応versionはNode.js `24.19.0`
- 現在の推奨versionはNode.js `24.19.0`
- `package.json` の `engines.node` は `>=24.19.0 <25`
- `.nvmrc` で推奨version `24.19.0` を示す
- Node 25以降は、別途検証・方針決定するまで対応済みとは扱わない
- WindowsでNode.js 24.13.0使用時にSvelteKit toolchainのnative crashを確認しているため、24.13.0は使用しない
- Node.js 24.19.0では、同一project・同一lockfile・日本語を含むWindows pathでも `svelte-kit sync`、check、production buildが成功することを確認済み
- Node 24.13.0から24.19.0の間のどのNode/V8変更によって問題が解消したかまでは確定していないため、特定のroot causeを断定しない

Node 22への固定、`--no-maglev`、`NODE_OPTIONS`、SvelteKit / Vite / Rolldownへの互換fallbackは採用しない。

## デプロイ環境

- GitHub Pagesを本番の静的ホスティング先として使用する
- Pages URLは `https://lokuyow.github.io/persona-bubble-field/`
- GitHub ActionsからGitHub Pagesへdeployする
- `main` へのpushをPages deployのトリガーとする
- Pages buildではNode.js `24.19.0` を使用する
- GitHub Pages project site用buildは `npm run build:pages` に統一する
- `build:pages` はrepository内のNode scriptから `BASE_PATH=/persona-bubble-field` を設定し、既存のVite / SvelteKit build経路を実行する
- Pages deploy workflowでは `npm ci` の後に `npm run build:pages` を実行し、生成したartifactをGitHub ActionsのPages deploymentで公開する
- 通常の `npm run build` の挙動はPages専用buildと分離して維持する

Pages deploy workflowは公開処理を担当し、PR検証用CIとは責務を分離する。

## PR CI

`main` 向けPull Requestでは、GitHub ActionsによるPR CIを実行する。

PR CIの基準は以下。

- Workflow名: `Pull Request CI`
- required status checkとして使用するjob名: `Check and build`
- Node.js `24.19.0`
- checkoutではPRのbaseからheadまでの差分を検証できる履歴を取得する
- `pull_request` 時はbase SHAからhead SHAまでのPR全体に対して `git diff --check` を実行する
- clean runner上で `npm ci` を実行する
- 続けて `npm run validate` を実行する
- `npm run validate` 成功後に `npx playwright install --with-deps chromium` を実行する
- 続けて `npm run test:e2e` を実行する

`npm run validate` にはVitest、Svelte / TypeScript check、GitHub Pages用production build、working treeの `git diff --check` が含まれる。
`npm run validate` は従来どおり基礎検証であり、Playwright E2Eを含めない。

CIはdeployを行わない。

PRに追加commitがpushされた場合は、その最新状態に対してCIを実行する。

同一PRの古いCI実行は、可能な場合はconcurrencyによってcancelし、最新状態の検証を優先する。

## Git運用

通常のコード変更では `main` へ直接実装せず、次の流れを基本とする。

1. 最新の `main` をbaseとして作業branchを作成する
2. 作業branchで変更する
3. 必要な検証を実行する
4. commitする
5. branchをpushする
6. `main` 向けのDraftではない通常Pull Requestを作成する
7. PR CIを成功させる
8. Pull Request経由で `main` へmergeする

bootstrap時に行った初期commit等の直接 `main` 更新は初期構築時の例外であり、通常運用の前例とはしない。

force pushは通常運用では行わない。

PR merge後の不要なhead branchは削除する。GitHubの自動branch削除機能を利用してよい。

## `main` の保護

`main` はGitHubのbranch rulesetで保護する。

基本方針は以下。

- `main` への変更はPull Request経由とする
- Pull Requestの承認人数は、単独開発を前提として `0` でよい
- Required status checkとして `Check and build` を要求する
- Required status checkが成功しない状態ではmergeしない
- merge前にbranchが最新の `main` を基準として検証されていることを要求する
- force pushを許可しない
- `main` branchの削除を許可しない

将来CI構成や開発体制を変更する場合は、Rulesetのrequired checkや運用条件も実態に合わせて見直す。

## 検証

通常のローカル実装作業では、変更内容に応じた固有テスト・実ブラウザ確認等に加え、原則として `npm run validate` を基礎検証とする。

`npm run validate` は次を順に実行する。

1. `npm test`
2. `npm run check`
3. `npm run build:pages`
4. `git diff --check`

ブラウザの挙動に関係する変更では、上記に加えて適切なPlaywright E2Eを実行する。人間向けの通常経路は `npm run test:e2e`、coding agent向けの低出力経路は `npm run test:e2e:agent` とする。ローカルのChromium binaryが未installの場合は `npx playwright install chromium` を実行する。E2Eは実Relay、外部network、実account、secretへ依存せず、開発用のDEV World Sandboxを対象とする。

通常のローカル検証に `npm ci` を含めない。同じworktreeで `npm run dev` または `npm run dev:host` が起動中でも、`node_modules` を削除せず `npm run validate` を実行できる構成を維持する。

clean installの保証はPR CIで `npm ci` を実行して担保する。依存関係やlockfileを変更する作業では、必要に応じてdev serverを停止したうえでローカルでもclean installを確認してよいが、通常作業の一律な完了条件にはしない。

Pull Request作成後は、GitHub Actions上の `Check and build` が最新headで成功していることを確認する。

本番deployへ影響する変更では、`main` merge後のGitHub Pages workflowと実際の公開結果も必要に応じて確認する。

## ライセンス

- ソースコード: MIT License
- キャラクター画像、キャラクターの `name`、`about` 等のキャラクター素材: CC0 1.0
- CC0対象のキャラクター素材は、専用クライアントから一般Nostrへアカウントを持ち出したユーザーが、そのまま利用・改変・再利用できるものとする
- 将来のサービス名、ロゴ等のブランド資産は、明示しない限りキャラクター素材のCC0適用範囲へ自動的に含めない
