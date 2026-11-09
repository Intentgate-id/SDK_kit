# iOS への組み込み

作業員アプリ（iOS）に打刻を組み込む手順です。先に [クイックスタート](quickstart.md) と [仕組み](concepts.md) を読んでください。

## 必要なもの

- iOS 16 以上（パスキー）
- 作業員の端末に Face ID、Touch ID、またはパスコードが設定されていること
- 自社ドメインに置く `apple-app-site-association`（下記）

## 1. 取り込む

Swift Package Manager で追加します。Xcode の「File › Add Package Dependencies…」に次の URL を入れ、バージョンを指定してください。

```
https://github.com/Intentgate-id/SDK_kit
```

`Package.swift` で使う場合:

```swift
.package(url: "https://github.com/Intentgate-id/SDK_kit", from: "0.1.0"),
// ターゲットの dependencies に
.product(name: "IntentgateBasicAuth", package: "SDK_kit"),
.product(name: "IntentgateBasicAuthPasskeys", package: "SDK_kit"),
```

ライブラリは 2 つです。

| ライブラリ | 中身 |
| --- | --- |
| `IntentgateBasicAuth` | オフライン打刻（`CheckInClient`）、nonce の束、サイトトークン。Apple の標準ライブラリだけで動く |
| `IntentgateBasicAuthPasskeys` | AuthenticationServices でのパスキー登録と署名（`PasskeySigner`） |

## 2. ドメインとアプリを結び付ける

`https://<RP ID>/.well-known/apple-app-site-association`（`Content-Type: application/json`、リダイレクトなし）:

```json
{ "webcredentials": { "apps": ["ABCDE12345.jp.co.example.genba"] } }
```

アプリの Signing & Capabilities で **Associated Domains** を追加し、`webcredentials:<RP ID>` を入れます。開発中に Apple の CDN を通さず確かめるには `webcredentials:<RP ID>?mode=developer` を使い、端末の「設定 › デベロッパ › Associated Domains Development」をオンにします。

iOS アプリからの署名は、オリジンが `https://<RP ID>` になります。テナントのオリジンにこの値が入っているか `GET /v1/account` で確認してください。

## 3. 保存先を用意する

```swift
public protocol BundleStore: AnyObject {    // nonce の束
    func current() -> DeviceBundle?
    func replace(_ bundle: DeviceBundle)
    func takeNonce() -> DeviceBundle.Nonce?
    func releaseNonce(_ nonce: DeviceBundle.Nonce)
    func remaining() -> Int
}

public protocol RecordQueue: AnyObject {    // 署名済みで送信待ちの打刻
    func add(_ record: UploadRecord)
    func pending() -> [UploadRecord]
    func remove(_ seqs: [Int64])
}
```

どちらも**再起動しても消えない、保護された領域**に実装してください（Data Protection を `.complete` にしたファイル、SQLite など）。`device_token` は Keychain に入れます。`InMemoryBundleStore` と `InMemoryRecordQueue` は試作とテスト用です。

## 4. パスキーを登録する（オンライン）

```swift
import IntentgateBasicAuth
import IntentgateBasicAuthPasskeys

let signer = PasskeySigner(rpId: "app.example.co.jp", anchor: view.window!)

// 自社バックエンドが POST /v1/workers/{id}/passkeys/options を呼び、options を返す
let optionsJSON: Data = try await myBackend.startPasskeyRegistration()
let registrationJSON = try await signer.register(optionsJSON: optionsJSON)   // Face ID
try await myBackend.finishPasskeyRegistration(registrationJSON)               // → POST /v1/workers/{id}/passkeys
```

`PasskeySigner` はメインスレッドから、一度に 1 つずつ使ってください。

## 5. nonce の束を受け取る（オンライン）

```swift
let client = CheckInClient(bundles: myBundleStore, queue: myRecordQueue)

func sync() async throws {
    // 先に、たまっている打刻を送る
    if let body = try client.uploadBody() {
        let res = try await post("\(igAPI)/v1/devices/\(deviceId)/events", body: body, bearer: deviceToken)
        let results = try JSONDecoder().decode(UploadResponse.self, from: res).results
        client.acknowledge(results.compactMap(\.seq))    // 答えが来たものは消す
    }
    // 新しい束を受け取る
    let bundleJSON = try await post("\(igAPI)/v1/devices/\(deviceId)/bundle", body: Data(), bearer: deviceToken)
    client.sync(bundle: try DeviceBundle.parse(bundleJSON))
}
```

アプリの起動時、打刻の画面を開いたとき、電波が戻ったとき（`NWPathMonitor`）に呼んでください。

## 6. 打刻する（オフラインで動く）

```swift
let siteToken: String = try await scanQR()      // "IGS1." で始まる文字列（VisionKit の DataScannerViewController など）

let prepared: PreparedCheckIn
do {
    prepared = try client.prepare(type: "site_entry", siteToken: siteToken)
} catch CheckInError.offlineLocked {
    return show("オフラインの期限を過ぎました。電波のある場所で同期してください")
} catch CheckInError.noNonce {
    return show("打刻できる回数を使い切りました。同期してください")
}

do {
    let assertion = try await signer.sign(challenge: prepared.challengeData)   // Face ID
    try client.complete(prepared, assertionJSON: assertion)                     // 送信待ちに入る
} catch {
    client.cancel(prepared)    // キャンセルや失敗のときは nonce を戻す。連番が抜けない
    throw error
}
```

追加情報は `attributes` に入れます。署名の対象に含まれます。

```swift
try client.prepare(type: "site_exit", siteToken: siteToken, attributes: ["gate": "東ゲート"])
```

残り回数は `client.remainingCheckIns`、期限切れは `client.isLocked` で画面に出せます。

## 7. 結果の扱い

Android と同じです。[Android の「結果の扱い」](integration-android.md#7-結果の扱い) を見てください。

## よくあるつまずき

| 症状 | 原因 |
| --- | --- |
| パスキーのシートが出ずにエラーになる | Associated Domains の設定漏れ、または AASA が取れない（リダイレクト、Content-Type の誤り） |
| 登録は通るがサーバーで `invalid_registration` | テナントのオリジンに `https://<RP ID>` がない、または RP ID が違う |
| アップロードが全部 `invalid_signature` | テスト用と本番用で RP ID が食い違っている |
| Simulator で試せない | パスキーは Simulator でも動くが、Associated Domains の検証に `?mode=developer` が必要 |
