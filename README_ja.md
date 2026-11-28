# Gemihub Hybrid

**端末内で答え、街とつながる。** gemihub を拡張した #BuildHybridAI 2026 の
Web / Chrome 向け提出作品です。街案内と店舗の来店者向けAIが、Firebase AI Logic
で端末内とクラウドの推論を使い分けます。[公開サイト](https://hybrid.gemihub.net/) · [Devpost](https://devpost.com/software/gemihub-hybrid) · [デモ動画](https://youtu.be/99IUa0O0-0I)

[実装ブリーフ](specs/BUILD_HYBRID_AI.md)に対象範囲と受け入れ条件を記載しています。
来店者向けのテキスト推論はFirebase AI Logicを使い、APIキーの入力は不要です。
ライブ音声会話はGemini APIキーが必要なため無効にしています。代わりに、送信ボタン横のマイクでブラウザーの音声認識を使って入力欄に音声入力できます。Gemini Nanoの準備ができていれば、聞き取った文章を端末内だけで整えます（句読点・言いよどみ・明らかな誤認識）。整形のためにクラウドへ送ることはありません。最後に「以上」「オーバー」（英語では over）と言うと送信し、マイクを押すと送信せずに終了します。聞き取り中に手で直した文章はそのまま残し、その後に話した部分だけを追加します。
また、街案内ポータル自身も読み取り専用 MCP エンドポイント（`/api/mcp`）を公開しています。
お店の情報は schema.org の語彙（[`hybrid/schema-org.js`](hybrid/schema-org.js)）にそろえています。`query_shop_facts` は公開業種に応じた JSON-LD を返し、業種が不明な場合は `LocalBusiness` を使います。端末内モデルへのプロンプトと公開店舗のトップページも同じ語彙を使います。日付指定の営業・休業が通常の営業時間に優先し、飲食メニュー・物販商品・サービスはそれぞれの種別を保持します。公開中の価格（`Offer`）も載せるので、Gemini Nano は定価をそのまま端末内で答えられます。合計・予算・支払いの質問はクラウドで答え、予約の金額はお店の決まったコードが決めます。

[English](README.md) · [日本語](README_ja.md)

自然な言葉で AI に頼むだけで個店が独自の Web サイトを持て、さらに「街案内 AI」が全店の AI や地域資料と連携して、訪れる人に合うお店や巡り方を音声・多言語でも案内できる、画一化しない街のポータルサイト **『gemihub』** の開発リポジトリです。

> **gemihubに追加した機能:** 会話で作成できる店舗サイトを土台に、街案内と
> 来店者向けAIを拡張しました。大会期間中にハイブリッド推論を組み込み、
> 推論元を示すバッジと診断表示を追加しました。公開サイトは専用コンテナで
> 稼働しており、架空の店舗で動作を試せます。
> 継承した `infra/dev/` と `apps/shop/infra/` の配備手順は実行しないでください。

別端末から公開デモを更新するには、権限のある Google アカウントで
`gcloud auth login` を実行し、このリポジトリで `bash infra/hybrid/deploy.sh` を
実行します。必要なツールと権限は[デプロイ手順](infra/hybrid/README.md)に記載しています。

---

## 主な特徴

- **言葉と写真でつくる個店サイト（`apps/shop/`）**  
  飲食店・雑貨店・サロンなどの店舗が、自然な言葉での指示や写真をもとに独自デザインの店舗ページ・メニュー・予約導線を作成・公開できます。
- **街案内 AI × 各店舗 AI のリアルタイム連携**  
  日時・人数・避けたい食材・立ち寄り先などの複合条件に対し、街案内 AI が承諾のうえで各店舗のエージェント（読み取り専用 MCP）へ問い合わせ、空席や商品情報を比較して回遊プランを提案します。
- **音声対話・多言語案内**  
  チャットだけでなく音声会話や英語などの多言語でも、地域の案内や各店舗 AI への相談を行えます。
- **地域資料（PDF / Markdown 等）の参照**  
  地域のお知らせ・公共施設・イベント案内（例：地域イベントの開催案内 PDF）を取り込んで公開でき、お店以外の地域情報に関する質問にも資料名を添えて回答します。
- **Firebase AI Logic によるハイブリッド推論**
  来店者はAPIキーを入力せずに、端末内またはクラウドでテキストの回答を受け取れます。

運営の音声AIが有効なら、親・店舗ともAIチャット画面上部の見出し横に「音声で話す」を表示します。押すと右下に小さな音声パネルが開き、ほかの画面も操作できます。「閉じる」またはEscでマイク・音声接続を終了します。店舗の確認画面は画面上で操作し、確認後に音声モードへ戻ります。詳細は[AIと音声の設定](docs/managed-ai.md#親の音声会話)を参照してください。

---

## 主な使用技術

- **Google Gemini API**
  - ハイブリッド来店者テキスト推論：Firebase AI Logic、Gemini Nano / `gemini-3.5-flash-lite`
  - 音声対話：`gemini-3.8-live`
  - 個店テーマ・ページのHTML/CSS生成：`gemini-4-argon`
  - 画面自動レビュー・ジャンル分類補助
- **Open Agentic Web**（[agentify-website](https://github.com/cognizant-ai-labs/agentic-web) ベース）  
  親ポータルと各店舗 AI 間の分散エージェント連携基盤
- **ランタイム / フロントエンド**  
  Node.js 24+ / TypeScript / React 19 / Vite（npm workspaces モノレポ）

---

## リポジトリ構成

| パス | 役割 |
| --- | --- |
| `site/` | 街案内ポータル（公開フロントエンド・親エージェント定義） |
| `apps/shop/` | 個店サイト生成・管理・店舗 AI アプリ（詳細: [apps/shop/README_ja.md](apps/shop/README_ja.md)） |
| `admin/` | ポータル管理サーバー（登録店管理・地域資料アップロード・AI ページ編集） |
| `scripts/` | ビルド・ローカル統合デモ起動スクリプト |
| `docs/` / `specs/` | 機能仕様・設定ガイド |

---

## クイックスタート

### 前提条件
- **Node.js 24 以上**

### 1. セットアップとビルド

```sh
npm ci
cp .env.example .env   # 必要に応じて GEMINI_API_KEY 等を設定
npm run build
npm test
```

### 2. ローカル統合デモの起動

親ポータル・管理画面・店舗デモ（飲食店 3 店舗）をまとめて起動できます。

```sh
npm run dev:demo
```

起動後のアクセス先（既定ポート）：
- 街案内ポータル: **http://localhost:8090/**
- ポータル管理画面: **http://localhost:8091/**
- 店舗デモアプリ: **http://127.0.0.1:3000/**

> 環境変数 `FINDER_PORT` / `ADMIN_PORT` / `SHOP_PORT` でポート変更が可能です（`Ctrl+C` で一括停止）。

---

## 主なコマンド

| コマンド | 内容 |
| --- | --- |
| `npm run build` | 親ポータル・管理画面・店舗アプリをビルド |
| `npm run check` | 型チェック・構成チェックを実行 |
| `npm test` | 親ポータルおよび店舗アプリのテストを実行 |
| `npm start` | 親ポータルのみを起動（`http://localhost:8090/`） |
| `npm run admin` | 管理画面サーバーのみを起動（`http://127.0.0.1:8091/`） |
| `npm run start:shop` / `npm run dev:shop` | 店舗アプリ単体の起動 / 開発モード起動 |
| `npm run storybook` | 店舗・ポータル UI の Storybook を起動 |
| `npm run dev:demo` | 親ポータル・管理画面・店舗デモを一括起動 |

---

## ドキュメント

より詳しい仕様や設定方法は各ドキュメントを参照してください。

- 店舗アプリの詳しい説明: [apps/shop/README_ja.md](apps/shop/README_ja.md)
- AI モード（Managed / BYOK）と音声設定: [docs/managed-ai.md](docs/managed-ai.md)
- 認証・保存先（Google ログイン / Cloud Storage）: [docs/storage-auth.md](docs/storage-auth.md)
- モノレポ構成について: [docs/monorepo.md](docs/monorepo.md)
- 機能仕様: [店舗紹介仕様](specs/SHOP_INTRODUCTION_SPEC.md) / [飲食店予約仕様](specs/restaurant-spec.md) / [管理画面仕様](specs/ADMIN_SPEC.md)

---

## ライセンス

Gemihub Hybrid は [Apache License 2.0](LICENSE) で配布しています。
`takeshy/gemihub-agent` から引き継いだコードには、[元の MIT ライセンスと著作権表記](LICENSE-MIT) が適用されます。

親ポータルおよびエージェント連携ランタイムの一部（`site/runtime/`・`vendor/agentify-website/`）には、Cognizant AI Labs の [agentify-website](https://github.com/cognizant-ai-labs/agentic-web)（Apache License 2.0）を利用しています。
[店舗アプリのサードパーティ表記](apps/shop/THIRD_PARTY_NOTICES.md)も参照してください。
