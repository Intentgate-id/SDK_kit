# Intentgate checkin SDK

工事現場の入退場などの打刻を、**作業員本人のスマホのパスキー（生体認証）で承認し、その位置と時刻をサーバーで確定して記録する**ための SDK です。現場に QR やタブレットは要りません。Intentgate の API（`https://checkin.intentgate.id`）と一緒に使います。

- [導入の流れ（遷移図）](https://app.notion.com/p/41d764643d3e81cebe41d54d25e76778)：アカウント作成から管理画面へのログイン、SDK 組み込み、打刻までの流れ
- [クイックスタート](docs/quickstart.md)：テスト用キーで、スマホなしに打刻を一周させる
- [仕組み](docs/concepts.md)：何が証明でき、何が証明できないか
- [Android](docs/integration-android.md) ／ [iOS](docs/integration-ios.md) ／ [Web（ブラウザ）](docs/integration-web.md)
- [API リファレンス（OpenAPI）](docs/openapi.yaml) ／ [プロトコル仕様](spec/PROTOCOL.md)

## 取り込み

**iOS / macOS（Swift Package Manager）**

```swift
.package(url: "https://github.com/Intentgate-id/SDK_kit", from: "0.3.0")
```

`IntentgateBasicAuth`（打刻の申請・確認・完了）と `IntentgateBasicAuthPasskeys`（AuthenticationServices でのパスキー）の 2 つです。iOS 16 / macOS 13 以上。

**Android / JVM（Maven Central）**

```kotlin
implementation("id.intentgate:basic-auth-android:0.3.0")   // パスキー（Credential Manager）+ core
implementation("id.intentgate:basic-auth-core:0.3.0")      // JVM だけで使う場合
```

**Web（npm）**

```sh
npm install @intentgate/basic-auth-web
```

作業員アプリを Web（スマホのブラウザ）で作る場合です。ブラウザの WebAuthn でパスキーを使い、位置もブラウザで測ります。バンドラーを使わないページでは `https://cdn.jsdelivr.net/npm/@intentgate/basic-auth-web@0.3.0/+esm` から ES モジュールとして読み込めます。

```ts
import { CheckInClient, PasskeySigner, currentPosition } from "@intentgate/basic-auth-web";

const client = new CheckInClient({ baseUrl: "https://checkin.intentgate.id", deviceId, deviceToken });
const result = await client.checkIn({
  signer: new PasskeySigner({ rpId: "worker.example.co.jp" }),   // ページのドメインかその親ドメイン
  request: { type: "site_entry", siteId, ...(await currentPosition()) },
  confirm: () => window.confirm("A現場に入場します"),            // 生体認証の前に作業員に見せる（任意）
});
if (result?.needsReview) console.log(result.flags);              // 例: ["outside_site"]
```

- ページは https で配信し、そのオリジン（例: `https://worker.example.co.jp`）を Intentgate に伝えてテナントに登録してください。登録したオリジンからだけ、ブラウザから打刻 API を呼べます（CORS）。
- API キー（`igk_...`）はブラウザに置かないでください。ブラウザに渡すのは端末トークン（`igd_...`）だけです。
- 詳しくは [Web への組み込み](docs/integration-web.md)。ソースは `web/` にあります。

> **0.1.0 は使わないでください。** 現場に QR を置く旧方式で、今の API とは動きません。

## テスト用ツール

```sh
export IG_API=https://checkin.intentgate.id
curl -s $IG_API/health                           # {"ok":true} なら接続できています
IG_API=$IG_API IG_KEY=igk_test_... node tools/simulate.mjs
```

作業員アプリの役をソフトウェアで演じて、テストモードで現場の中と外から打刻します。テスト用キーでしか動きません。

## このリポジトリについて

このリポジトリは Intentgate の社内リポジトリから自動で書き出しています。不具合の報告や要望は Issue でお知らせください。プルリクエストは内容を確認したうえで社内リポジトリに取り込みます。

言語間で同じ結果になることを、[spec/test-vectors.json](spec/test-vectors.json) のテストベクタで確かめています。

## ライセンス

[Apache License 2.0](LICENSE)
