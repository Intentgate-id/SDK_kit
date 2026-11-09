# Intentgate basic-auth プロトコル v1

工事現場の入退場など、**オフラインでも行える FIDO2 打刻**と、その**従量課金**のためのワイヤーフォーマット。
すべての SDK（TypeScript / Kotlin / Swift …）はこの文書と [`test-vectors.json`](test-vectors.json) に従う。
参照実装は `packages/protocol`（TypeScript）。

## 登場するもの

| 名前 | 役割 |
| --- | --- |
| 作業員アプリ | 顧客のスマホアプリ。SDK を組み込み、作業員のパスキー（生体認証）で署名する |
| 現場タブレット | 30 秒ごとに変わる署名付き QR（サイトトークン）を表示する。オフラインで動く |
| サーバー | nonce を配り、アップロードされた署名を検証し、作業員 × 現場 × 日で課金を集計する |

## 1. 正規化 JSON（JCS）

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) に従う。ただし**数値は ±(2^53−1) の整数のみ**とし、小数は拒否する。

- オブジェクトのキーは UTF-16 コード単位の順で並べる。
- 文字列は ECMAScript の `JSON.stringify` と同じ規則でエスケープする（`"` `\` と制御文字だけ。0x20 未満は `\u00xx` の小文字 16 進。対になっていないサロゲートも `\udxxx`）。
- 空白は入れない。

## 2. nonce（サーバー → 作業員アプリ）

サーバーは nonce を保存せず、秘密鍵から導出する。

```
nonce = HMAC-SHA256(secret[kid], "intentgate-basic-auth/nonce/v1" || 0x00 || UTF8(device_id) || 0x00 || uint64be(seq))
```

`POST /v1/devices/{device_id}/bundle`（端末トークンで認証）の応答:

```json
{
  "device_id": "dev_1",
  "nonce_kid": "n1",
  "nonces": [{ "seq": 0, "nonce": "<base64url 32 bytes>" }],
  "event_types": [{ "type": "site_entry", "billable": true }],
  "lock_after": "2026-11-16T08:00:00.000Z"
}
```

- サーバーは返す前に、その端末に発行した最大の `seq + 1`（issued-until）を保存する。
- 作業員アプリは `lock_after` を過ぎたら、同期するまで打刻を止める（既定 7 日）。

## 3. サイトトークン（現場タブレット → QR）

```
IGS1.<base64url(JCS(payload))>.<base64url(Ed25519 署名)>
payload = {"kid": "...", "site_id": "...", "t": <窓の開始 unix 秒>, "v": 1}
署名対象 = ASCII 文字列 "IGS1.<payload 部>"
```

- `t` は `floor(now / 30) * 30`。QR は 30 秒ごとに変わる。
- payload は正規化済みでなければならない（検証側は再正規化して一致を確認する）。
- 署名鍵は現場ごと。サーバーは公開鍵（32 バイト raw）を `kid` で持つ。

## 4. 打刻イベントとチャレンジ

```json
{
  "v": 1,
  "type": "site_entry",
  "device_id": "dev_1",
  "seq": 1834,
  "nonce_kid": "n1",
  "site_token": "IGS1....",
  "occurred_at": "2026-11-09T07:58:12+09:00",
  "attributes": { "gate": "東ゲート" }
}
```

- キーはこの 8 個ちょうど。`type` は `^[a-z][a-z0-9_]{0,63}$`。`occurred_at` は RFC 3339（オフセット付き）。
- `attributes` は種別ごとの追加項目。署名の対象になる。新しい用途はサーバーのカタログに種別を足すだけで増やせる。

```
challenge = SHA-256( "intentgate-basic-auth/v1" || 0x00 || nonce || UTF8(JCS(event)) )
```

作業員アプリはこの 32 バイトを WebAuthn の `challenge` としてパスキーに署名させる（`userVerification: "required"`）。
パスキーの署名は challenge を含む clientDataJSON を覆うので、**種別・現場・端末・連番・時刻のどれを書き換えても検証に失敗する**。課金イベントを無償の種別に付け替えることはできない。

## 5. アップロード（作業員アプリ → サーバー）

`POST /v1/devices/{device_id}/events`

```json
{ "device_id": "dev_1", "records": [{ "event": { ... }, "assertion": { /* AuthenticationResponseJSON */ } }] }
```

サーバーは記録ごとに次を確認する。1 件の失敗は他の記録に影響しない。

1. イベントの形式、`device_id` の一致、種別がカタログにあること
2. 端末が有効で、`seq` が発行済み（issued-until 未満）であること
3. `(device_id, seq)` が未登録であること（登録済みなら `duplicate`）
4. パスキーが有効で、端末と同じ作業員のものであること
5. nonce を導出し、チャレンジを再計算して WebAuthn 署名を検証（RP ID、origin、UV 必須、カウンタ）
6. サイトトークンの Ed25519 署名を現場の公開鍵で検証
7. フラグ付け（拒否はしない）: 端末時刻とトークン時刻の差が 300 秒超 → `clock_skew`、現場に割り当てのない作業員 → `unassigned_site`

結果は `accepted` / `duplicate` / `rejected`（理由コード付き）。

## 6. 課金単位

**作業員 × 現場 × 日**。日付はサイトトークンの `t`（現場タブレットの時計）を現場のタイムゾーンで日付にしたもの。
同じ日に同じ現場へ何度出入りしても 1 件。請求先はその現場のテナント（元請け）。`billable: false` の種別は数えない。

## 7. 未報告の検知

発行済みの連番のうち、アップロードされていない番号は「未報告」として検知できる（`missingSequences`）。
打刻をキャンセルした場合、アプリは nonce を戻すので欠番にならない。
