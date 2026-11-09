# クイックスタート

テスト用の API キーを受け取ってから、最初の打刻が管理画面に表示されるまでの手順です。30 分ほどかかります。

## 0. 用意するもの

- Intentgate から届いたもの
  - テスト用 API キー（`igk_test_...`）
  - 本社管理者の招待リンク（管理画面 `https://checkin.intentgate.id/` のログイン用）
- 作業員アプリのドメイン（RP ID）。テスト用には `localhost` やステージングのドメインも使えます。Intentgate に伝えてください。

```sh
export IG_API=https://checkin.intentgate.id   # 本番とテストで同じ URL
export IG_KEY=igk_test_...
```

> API キーはサーバーでだけ使います。アプリに埋め込まないでください。

## 1. キーを確かめる

```sh
curl -s $IG_API/v1/account -H "Authorization: Bearer $IG_KEY"
```

```json
{ "account_id": "tnt_...", "tenant_id": "tnt_...", "name": "山田建設株式会社",
  "mode": "test", "livemode": false, "rp_id": "staging.example.co.jp", "origins": ["https://staging.example.co.jp"] }
```

`mode` が `test` なら、これから作るものはすべてテスト用で、課金されません。`rp_id` と `origins` がアプリと一致しているか確認してください（後で変える場合は Intentgate に依頼してください）。

## 2. スマホなしで一周させる（シミュレーター）

SDK の公開リポジトリにある `tools/simulate.mjs` は、現場タブレットと作業員アプリの役をソフトウェアで演じます。現場を作り、作業員のパスキーを登録し、端末を発行して打刻を 1 件送ります。テスト用キーでしか動きません。

```sh
git clone https://github.com/Intentgate-id/SDK_kit && cd SDK_kit
IG_API=$IG_API IG_KEY=$IG_KEY node tools/simulate.mjs     # Node.js 20 以上。依存パッケージのインストールは不要
```

```
✓ account 山田建設株式会社 (test mode), RP ID staging.example.co.jp
✓ site site_... with tablet key sim-tablet
✓ worker wrk_... with a passkey, assigned to the site
✓ device dev_..., 50 nonces until 2026-11-16T07:05:18.710Z
✓ check-in accepted (seq 0)
✓ re-sending the same record is safe: duplicate
✓ usage today: 1 unit(s) in test mode (not billed)
```

管理画面にログインし、左上の「テストモード」をオンにして「入退記録」を開くと、この打刻が表示されます。

## 3. 自社のバックエンドに組み込む

シミュレーターがしていることを、自社のサーバーで行います。どれも `Authorization: Bearer $IG_KEY` を付けて呼びます。

### 現場を作る

```sh
curl -s -X POST $IG_API/v1/sites -H "Authorization: Bearer $IG_KEY" -H "Content-Type: application/json" \
  -d '{"name": "渋谷二丁目新築工事", "time_zone": "Asia/Tokyo"}'
# → {"site": {"id": "site_...", "name": "渋谷二丁目新築工事", "time_zone": "Asia/Tokyo"}}
```

現場タブレットの公開鍵の登録は [現場タブレット](site-tablet.md) を見てください。

### 作業員を登録する

`external_ref` には自社の社員番号などを入れておくと、後で突き合わせられます。

```sh
curl -s -X POST $IG_API/v1/workers -H "Authorization: Bearer $IG_KEY" -H "Content-Type: application/json" \
  -d '{"display_name": "佐藤 一郎", "external_ref": "Y-0012"}'
# → {"worker": {"id": "wrk_...", "display_name": "佐藤 一郎", "external_ref": "Y-0012"}}
```

### パスキーを登録する（バックエンドが中継する）

作業員アプリは Intentgate に直接つながず、自社のバックエンドを通します。**この時点で本人確認を済ませてください**（ログイン済みの社員本人か、対面で確認したか）。

```
アプリ ──(自社ログイン)──▶ 自社バックエンド ──▶ POST /v1/workers/{id}/passkeys/options
アプリ ◀── options ─────── 自社バックエンド ◀── { challenge_id, options }
アプリ: PasskeySigner.register(options) で生体認証
アプリ ── response ──────▶ 自社バックエンド ──▶ POST /v1/workers/{id}/passkeys { challenge_id, response }
```

`challenge_id` は自社バックエンドに残し、アプリには `options` だけを渡します。チャレンジは 5 分で切れ、一度しか使えません。

### 端末を発行する

```sh
curl -s -X POST $IG_API/v1/workers/wrk_.../devices -H "Authorization: Bearer $IG_KEY"
# → {"device": {"id": "dev_...", "worker_id": "wrk_..."}, "device_token": "igd_..."}
```

`device_token` は一度しか返りません。自社のログイン済みのチャネルでアプリに渡し、アプリは端末の安全な保存領域（Android Keystore、iOS Keychain）に入れてください。機種変更のときは古い端末を `DELETE /v1/devices/{id}` で失効させ、新しく発行します。

### 現場に割り当てる

```sh
curl -s -X POST $IG_API/v1/sites/site_.../assignments -H "Authorization: Bearer $IG_KEY" -H "Content-Type: application/json" \
  -d '{"worker_id": "wrk_...", "starts_on": "2026-11-01"}'
```

割り当てがなくても打刻は受け付けますが、`unassigned_site` のフラグが付きます。

## 4. アプリに組み込む

- [Android](integration-android.md)
- [iOS](integration-ios.md)

アプリが Intentgate と直接やり取りするのは次の 2 つだけで、どちらも端末トークンで認証します。

| | いつ |
| --- | --- |
| `POST /v1/devices/{id}/bundle` | オンラインのとき。nonce の束を受け取る（オフラインで打刻できる回数と期限） |
| `POST /v1/devices/{id}/events` | オンラインに戻ったとき。たまった打刻を送る |

## 5. 利用量を取る

```sh
curl -s "$IG_API/v1/usage?from=2026-11-01&to=2026-11-30" -H "Authorization: Bearer $IG_KEY"
```

`billable_units` が課金単位（作業員 × 現場 × 日）の数です。テストモードでも同じように数えますが、請求はされません。CSV は `/v1/usage.csv` です。

## 6. 本番に切り替える

1. 本番用の RP ID とオリジン（Android の署名証明書ハッシュを含む）を Intentgate に伝える。
2. 管理画面の「設定」で本番用 API キー（`igk_live_...`）を作り、サーバーの環境変数を差し替える。
3. 本番の現場・作業員・端末を作り直す。テストのデータは本番に引き継がれません。

`GET /v1/account` の `livemode` が `true` になっていれば本番です。
