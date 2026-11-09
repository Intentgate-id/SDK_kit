# Intentgate checkin SDK

工事現場の入退場などの打刻を、**作業員本人のスマホのパスキー（生体認証）で承認し、その位置と時刻をサーバーで確定して記録する**ための SDK です。現場に QR やタブレットは要りません。Intentgate の API（`https://checkin.intentgate.id`）と一緒に使います。

- [クイックスタート](docs/quickstart.md)：テスト用キーで、スマホなしに打刻を一周させる
- [仕組み](docs/concepts.md)：何が証明でき、何が証明できないか
- [Android](docs/integration-android.md) ／ [iOS](docs/integration-ios.md)
- [API リファレンス（OpenAPI）](docs/openapi.yaml) ／ [プロトコル仕様](spec/PROTOCOL.md)

## 取り込み

**iOS / macOS（Swift Package Manager）**

```swift
.package(url: "https://github.com/Intentgate-id/SDK_kit", from: "0.2.0")
```

`IntentgateBasicAuth`（打刻の申請・確認・完了）と `IntentgateBasicAuthPasskeys`（AuthenticationServices でのパスキー）の 2 つです。iOS 16 / macOS 13 以上。

**Android / JVM（Maven Central）**

```kotlin
implementation("id.intentgate:basic-auth-android:0.2.0")   // パスキー（Credential Manager）+ core
implementation("id.intentgate:basic-auth-core:0.2.0")      // JVM だけで使う場合
```

## テスト用ツール

```sh
IG_API=https://checkin.intentgate.id IG_KEY=igk_test_... node tools/simulate.mjs
```

作業員アプリの役をソフトウェアで演じて、テストモードで現場の中と外から打刻します。テスト用キーでしか動きません。

## このリポジトリについて

このリポジトリは Intentgate の社内リポジトリから自動で書き出しています。不具合の報告や要望は Issue でお知らせください。プルリクエストは内容を確認したうえで社内リポジトリに取り込みます。

言語間で同じ結果になることを、[spec/test-vectors.json](spec/test-vectors.json) のテストベクタで確かめています。

## ライセンス

[Apache License 2.0](LICENSE)
