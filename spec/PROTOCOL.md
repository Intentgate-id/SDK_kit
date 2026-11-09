# Intentgate basic-auth プロトコル v2

工事現場の入退場などの**打刻を、作業員本人のパスキー（FIDO2）で承認する**ためのワイヤーフォーマットと、その**従量課金**の決まりです。
作業員アプリはオンライン（電波がつながること）を前提とします。現場に QR やタブレットは置きません。
すべての SDK（TypeScript / Kotlin / Swift …）はこの文書と [`test-vectors.json`](test-vectors.json) に従います。
参照実装は `packages/protocol`（TypeScript）と `packages/server` です。

> v1（オフライン打刻、現場タブレットの QR、nonce の束）は廃止しました。

## 登場するもの

| 名前 | 役割 |
| --- | --- |
| 作業員アプリ | 顧客のスマホアプリ。SDK を組み込み、位置を測って打刻を申請し、作業員のパスキー（生体認証）で署名する |
| サーバー | 打刻ごとにイベントを確定してチャレンジを発行し、署名を検証し、作業員 × 現場 × 日で課金を集計する |
| 現場 | 中心の緯度経度と半径（ジオフェンス）を持つ。元請け（テナント）が登録する |

## 1. 正規化 JSON（JCS）

[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) に従います。ただし**数値は ±(2^53−1) の整数のみ**とし、小数は拒否します。

- オブジェクトのキーは UTF-16 コード単位の順で並べる。
- 文字列は ECMAScript の `JSON.stringify` と同じ規則でエスケープする（`"` `\` と制御文字だけ。0x20 未満は `\u00xx` の小文字 16 進。対になっていないサロゲートも `\udxxx`）。
- 空白は入れない。

緯度経度は小数を使えないため、度 × 10^7 の整数（`lat_e7`、`lng_e7`。約 1 cm 単位）で表します。

## 2. 流れ

```
作業員アプリ                                   サーバー
  │ 位置を測る（緯度、経度、精度）
  │── POST /v1/devices/{id}/checkins ─────────▶│ イベントを確定（サーバー時刻、乱数 nonce、checkin_id）
  │   { type, site_id, location, attributes }   │ チャレンジ = H(イベント)、有効期限を付けて保存
  │◀── { checkin_id, event, challenge, … } ─────│
  │ イベントが申請どおりか確かめ、作業員に表示
  │ パスキーで challenge に署名（UV 必須）
  │── POST …/checkins/{checkin_id}/complete ───▶│ 署名を検証し、打刻を記録（1 回だけ）
  │◀── { status, flags, billable } ─────────────│
```

どちらのリクエストも端末トークン（`Authorization: Bearer igd_...`）で認証します。

## 3. 打刻の申請

`POST /v1/devices/{device_id}/checkins`

```json
{
  "type": "site_entry",
  "site_id": "site_123",
  "location": { "latitude": 35.681236, "longitude": 139.76712, "accuracy_m": 11.4 },
  "attributes": { "gate": "東ゲート" }
}
```

- `type` はカタログにある種別（`^[a-z][a-z0-9_]{0,63}$`）。
- `location` は端末の測位結果。`accuracy_m` は水平精度（メートル）。
- `attributes` は種別ごとの追加項目（任意）。署名の対象になります。

サーバーは次のイベントを確定して返します（201）。

```json
{
  "checkin_id": "chk_3q2-7wAAAAAAAAAAAAAAAA",
  "event": {
    "v": 2,
    "type": "site_entry",
    "checkin_id": "chk_3q2-7wAAAAAAAAAAAAAAAA",
    "device_id": "dev_1",
    "site_id": "site_123",
    "nonce": "<base64url 32 bytes>",
    "issued_at": "2026-11-08T22:58:12.000Z",
    "location": { "lat_e7": 356812360, "lng_e7": 1397671200, "accuracy_m": 12 },
    "attributes": { "gate": "東ゲート" }
  },
  "challenge": "<base64url 32 bytes>",
  "expires_at": "2026-11-08T23:01:12.000Z",
  "rp_id": "app.example.co.jp",
  "allow_credentials": ["<credential id>"]
}
```

- `lat_e7` / `lng_e7` は `round(度 × 10^7)`、`accuracy_m` は `ceil(精度)`。
- `issued_at` はサーバーの時刻（UTC、`Z`）。端末の時計は使いません。
- `nonce` はサーバーが打刻ごとに作る 32 バイトの乱数です。
- イベントのキーはこの 9 個ちょうど、`location` のキーは 3 個ちょうどです。
- チャレンジの有効期限は既定 180 秒です。

## 4. チャレンジ

```
challenge = SHA-256( "intentgate-basic-auth/v2" || 0x00 || UTF8(JCS(event)) )
```

作業員アプリはこの 32 バイトを WebAuthn の `challenge` としてパスキーに署名させます（`userVerification: "required"`、`allowCredentials` は応答の `allow_credentials`）。
パスキーの署名は challenge を含む clientDataJSON を覆うので、**種別、現場、端末、位置、時刻のどれを書き換えても検証に失敗します**。課金イベントを無償の種別に付け替えることもできません。

署名の前に、SDK は次を確かめます（`checkIssuedCheckIn`）。サーバーが申請と違う内容を署名させようとしたら、署名しません。

1. `event` の形式が正しく、`event.checkin_id` が応答の `checkin_id` と一致する
2. `device_id`、`type`、`site_id`、`attributes` が申請どおり
3. `lat_e7` / `lng_e7` が申請の値と ±1 以内、`accuracy_m` が `ceil(申請の精度)` と一致
4. `challenge` が `event` から計算した値と一致

## 5. 完了

`POST /v1/devices/{device_id}/checkins/{checkin_id}/complete`

```json
{ "assertion": { /* AuthenticationResponseJSON */ } }
```

サーバーは次を確認します。

1. 打刻がこの端末に発行されたもので、期限内であること
2. 端末が有効で、パスキーが有効かつ端末と同じ作業員のものであること
3. 保存したチャレンジで WebAuthn 署名を検証（RP ID、origin、UV 必須、カウンタ）

成功すると `{"status": "accepted", "flags": [...], "billable": true, "distance_m": 8}` を返します。
同じ打刻をもう一度完了しようとした場合は、記録済みの結果を `"status": "duplicate"` で返します（通信が切れたときの再送に使えます）。

拒否の理由コード: `malformed_request`、`unknown_event_type`、`unknown_device`、`unknown_site`、`site_location_missing`、`no_passkey`、`unknown_checkin`、`checkin_expired`、`unknown_credential`、`credential_device_mismatch`、`invalid_signature`。

## 6. 位置の判定（フラグ）

位置が現場から外れていても**拒否はせず、フラグを付けて記録します**（GPS の誤差で正しい打刻を落とさないため）。フラグ付きの打刻は管理画面で「要確認」になります。

| フラグ | 条件 |
| --- | --- |
| `outside_site` | 現場の中心からの距離 > 半径 + `accuracy_m` |
| `low_accuracy` | `accuracy_m` > 100 m |
| `unassigned_site` | その日、作業員がその現場に割り当てられていない |

距離は球面上の大円距離（地球半径 6,371,008.8 m）をメートル単位に丸めたものです。

## 7. 証跡

記録は `{ "event": …, "assertion": … }` の組で保存します。パスキーの公開鍵があれば、誰でも後から
「この作業員の端末で、本人確認のうえ、この時刻にこの現場のこの位置で承認された」ことを検証できます。

## 8. 課金単位

**作業員 × 現場 × 日**。日付はイベントの `issued_at`（サーバー時刻）を現場のタイムゾーンで日付にしたものです。
同じ日に同じ現場へ何度出入りしても 1 件。請求先はその現場のテナント（元請け）です。`billable: false` の種別は数えません。

## 9. 防げること、防げないこと

- 防げる: 他人の打刻の代行（パスキーは本人の生体認証）、打刻内容の書き換え、記録の使い回し（打刻ごとの nonce と 1 回限りの完了）、端末時計の改ざん。
- 防げない: 位置情報の偽装（root 化した端末や偽装アプリ）。`outside_site` などのフラグと、割り当てや勤務記録との突き合わせで補います。
