# Dedicated Web demo

The public demo runs at `https://hybrid.gemihub.net` in its own Compose project
on `gemihub-dev` (GCP project `geminihub-486523`). Firebase AI Logic, App Check
and Remote Config use the separate project `gemihub-hybrid-2026`.

`compose.yaml` connects to the existing Caddy network but mounts no upstream
data or credentials. Its only container has a 384 MiB memory limit. The demo
uses fictional shops and in-memory reservations that reset on restart.

Build with `cloudbuild.yaml`, using a new `hybrid` image tag. Copy this
directory's deployment files to `/opt/gemihub-hybrid` on the VM, then run:

```sh
cd /opt/gemihub-hybrid
sudo python3 deploy-on-vm.py container asia-northeast1-docker.pkg.dev/geminihub-486523/gemihub-dev/hybrid:TAG
# After the DNS A records for hybrid.gemihub.net and shop.hybrid.gemihub.net resolve to the VM:
sudo python3 deploy-on-vm.py route
```

The container step records an image in `image.env` only after it passes the
health check. Before pulling and again after a healthy start, it removes local
images of the `hybrid` repository except the new image and the previous healthy
one, so repeated deploys do not fill the VM disk. Images of the existing dev
stack are in other repositories and are never removed.

The route step validates and backs up the current Caddyfile, appends only the
missing hybrid hostnames (`hybrid.gemihub.net` for the town and
`shop.hybrid.gemihub.net` for the shop builder) and reloads Caddy without
restarting existing containers. Both hostnames reach the same container. It
refuses unexpected existing hybrid configuration. An upstream startup script
can regenerate its Caddyfile, so reapply the `route` step after such a change.
Do not run inherited deployment scripts for this clone.

## 街の管理画面と店舗作成

街の管理画面は `https://hybrid.gemihub.net/judge/admin/` にあります。
運営者が「Sign in with Google」から Gmail の送信を承認すると、「Invite a shop」
から招待メールを送れます。店舗の作成と管理は `https://shop.hybrid.gemihub.net/` で行い、
街の紹介ページ（`https://hybrid.gemihub.net/`）とは分けています。店舗の公開ページ
（`/s/<slug>`）は引き続き `hybrid.gemihub.net` にあります。以前の `/?shop=...` のリンクは
店舗作成側に転送されます。飲食店・その他のお店の店主はメールのリンクを開いて
「Build your shop with AI」に進みます。サロンの店主は招待先の Google アカウントでログインします。

1. `gemihub-hybrid-2026` で Gmail API、Firestore、Cloud Storage、Vertex AI を準備します。
   店舗用には既存アプリと同じ Firestore Standard / Native mode と、非公開の店舗ファイル用バケットを使います。
   サロンでカレンダー連携も使う場合は Google Calendar API を有効にします。
   ランタイムのサービスアカウントには、このプロジェクトの店舗 DB、バケット、Vertex AI に必要な権限を
   付与します。[Firestore のデータベース作成](https://docs.cloud.google.com/firestore/native/docs/manage-databases)
2. 同じプロジェクトで OAuth のウェブアプリ用クライアントを作り、
   承認済みリダイレクト URI に次の三つを登録します。店主のログインは店舗作成側、
   予約客のログインは公開ページ側に戻ります。OAuth の公開範囲がテスト中の場合は、
   Gmail を承認する運営者と Google で入る店主をテストユーザーに追加します。
   [Google OAuth のウェブアプリ設定](https://developers.google.com/identity/protocols/oauth2/web-server)

   ```text
   https://hybrid.gemihub.net/judge/admin/auth/google/callback
   https://hybrid.gemihub.net/auth/google/callback
   https://shop.hybrid.gemihub.net/auth/google/callback
   ```

3. [town.env.example](town.env.example) を基に VM の
   `/opt/gemihub-hybrid/town.env` を作り、所有者を root、権限を 0600 にします。
   `PARENT_ADMIN_EMAILS` に普段使っている Gmail アカウントを設定し、
   `SESSION_SECRET`、`PARENT_AUTH_SECRET`、`PARENT_INTEGRATION_SECRET` にはそれぞれ別の
   32 文字以上の乱数を設定します。Vertex AI で利用可能なモデル名を `VERTEX_MODEL` に指定します。
   店舗画面のデザイン生成に別モデルを使う場合は `GEMINI_DESIGN_MODEL` も指定します。
4. VM の `/var/lib/gemihub-hybrid` を UID 1000 が読み書きできる非公開ディレクトリとして用意し、
   Hybrid 専用のサービスアカウントの認証ファイルを `google-runtime.json` として、
   UID 1000 の読み取り専用に配置します。街の店舗一覧と暗号化済み Gmail 接続は同じ
   ディレクトリに保存されます。認証ファイルや環境ファイルは Git やイメージに含めません。
5. `infra/hybrid` の上記手順で Hybrid 専用コンテナを更新し、街の管理画面に自分の
   Google アカウントでログインして Gmail の送信を承認します。

信頼できる審査員に街の運営操作を体験してもらう場合は、専用の
`HYBRID_TOWN_JUDGE_INVITE`（32 文字以上の base64url）と
`HYBRID_TOWN_JUDGE_UNTIL`（ISO 8601 の期限）を設定し、先に運営者が Gmail の送信を承認します。
`/judge#<token>` を開いた審査員は、その街の店舗一覧を編集し、運営者の Gmail から
実際に招待を送れます。招待 URL は対象の審査員だけに共有してください。

公開用の架空店舗と予約は引き続きメモリ内にあり、管理画面から作った店舗は
Hybrid 専用 Firestore に保存されます。実メール・Vertex AI・店舗の公開は、
専用設定を有効にした環境でそれぞれ確認してください。
