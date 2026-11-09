# iOS への組み込み

作業員アプリ（iOS）に打刻を組み込む手順です。先に [クイックスタート](quickstart.md) と [仕組み](concepts.md) を読んでください。

## 必要なもの

- iOS 16 以上（パスキー）
- 作業員の端末に Face ID、Touch ID、またはパスコードが設定されていること
- 位置情報の権限（`NSLocationWhenInUseUsageDescription`）。打刻のときに一度だけ測ります
- 打刻のときに電波がつながっていること
- 自社ドメインに置く `apple-app-site-association`（下記）

## 1. 取り込む

Swift Package Manager で追加します。Xcode の「File › Add Package Dependencies…」に次の URL を入れ、バージョンを指定してください。

```
https://github.com/Intentgate-id/SDK_kit
```

`Package.swift` で使う場合:

```swift
.package(url: "https://github.com/Intentgate-id/SDK_kit", from: "0.2.0"),
// ターゲットの dependencies に
.product(name: "IntentgateBasicAuth", package: "SDK_kit"),
.product(name: "IntentgateBasicAuthPasskeys", package: "SDK_kit"),
```

ライブラリは 2 つです。

| ライブラリ | 中身 |
| --- | --- |
| `IntentgateBasicAuth` | 打刻の通信と検証（`CheckInClient`、`CheckInRequest`、イベントとチャレンジの検証）。Apple の標準ライブラリだけで動く |
| `IntentgateBasicAuthPasskeys` | AuthenticationServices でのパスキー登録と署名（`PasskeySigner`） |

## 2. ドメインとアプリを結び付ける

`https://<RP ID>/.well-known/apple-app-site-association`（`Content-Type: application/json`、リダイレクトなし）:

```json
{ "webcredentials": { "apps": ["ABCDE12345.jp.co.example.genba"] } }
```

アプリの Signing & Capabilities で **Associated Domains** を追加し、`webcredentials:<RP ID>` を入れます。開発中に Apple の CDN を通さず確かめるには `webcredentials:<RP ID>?mode=developer` を使い、端末の「設定 › デベロッパ › Associated Domains Development」をオンにします。

iOS アプリからの署名は、オリジンが `https://<RP ID>` になります。テナントのオリジンにこの値が入っているか `GET /v1/account` で確認してください。

## 3. パスキーを登録する

```swift
import IntentgateBasicAuth
import IntentgateBasicAuthPasskeys

let signer = PasskeySigner(rpId: "app.example.co.jp", anchor: view.window!)

// 自社バックエンドが POST /v1/workers/{id}/passkeys/options を呼び、options を返す
let optionsJSON: Data = try await myBackend.startPasskeyRegistration()
let registrationJSON = try await signer.register(optionsJSON: optionsJSON)   // Face ID
try await myBackend.finishPasskeyRegistration(registrationJSON)               // → POST /v1/workers/{id}/passkeys
```

登録が終わったら、自社バックエンドが端末を発行して `device_id` と `device_token` をアプリに渡します（`POST /v1/workers/{id}/devices`）。`device_token` は Keychain に保存してください。`PasskeySigner` はメインスレッドから、一度に 1 つずつ使ってください。

## 4. 打刻する

```swift
let client = CheckInClient(baseURL: URL(string: "https://checkin.intentgate.id")!,
                           deviceId: deviceId, deviceToken: deviceToken)

// 位置を測る（Core Location。CLLocationManager.requestLocation() など）
let location: CLLocation = try await currentLocation()

do {
    let request = try CheckInRequest(type: "site_entry", siteId: siteId,
                                     latitude: location.coordinate.latitude,
                                     longitude: location.coordinate.longitude,
                                     accuracyM: location.horizontalAccuracy)
    let result = try await client.checkIn(signer: signer, request: request) { issued in
        await confirm("\(siteName) に入場します")      // 生体認証の前に見せる（任意）。false で中止
    }
    guard let result else { return }                   // 作業員が中止した
    result.needsReview ? showWarning(result) : showDone()
} catch PasskeyError.cancelled {
    // Face ID をキャンセルした。打刻は記録されない
} catch let e as CheckInAPIError {
    show(message(for: e.code))                         // Android の「エラー」と同じコード
} catch is IssuedCheckInMismatch {
    show("サーバーの応答が申請と違うため、署名を中止しました")
} catch is URLError {
    show("通信できません。電波のある場所でもう一度押してください")
}
```

`checkIn` は `client.start(request)`（申請とイベントの確認）、`signer.sign(challenge:allowedCredentialIds:)`（Face ID）、`client.complete(checkinId:assertionJSON:)`（署名の送信）をまとめたものです。分けて呼ぶこともできます。

追加情報は `attributes` に入れます。署名の対象に含まれます。

```swift
try CheckInRequest(type: "site_exit", siteId: siteId, latitude: lat, longitude: lng, accuracyM: acc,
                   attributes: ["gate": "東ゲート"])
```

`location.horizontalAccuracy` が負の値（位置が取れていない）のときは打刻しないでください。`CheckInRequest` がエラーにします。

## 5. 結果とエラーの扱い

Android と同じです。[Android の「結果の扱い」](integration-android.md#5-結果の扱い) と [「エラー」](integration-android.md#6-エラー) を見てください。

## よくあるつまずき

| 症状 | 原因 |
| --- | --- |
| パスキーのシートが出ずにエラーになる | Associated Domains の設定漏れ、または AASA が取れない（リダイレクト、Content-Type の誤り） |
| 登録は通るがサーバーで `invalid_registration` | テナントのオリジンに `https://<RP ID>` がない、または RP ID が違う |
| 打刻が全部 `invalid_signature` | テスト用と本番用で RP ID が食い違っている |
| いつも `low_accuracy` になる | 「正確な位置情報」がオフ（`accuracyAuthorization == .reducedAccuracy`）。オンにするよう案内する |
| Simulator で試せない | パスキーは Simulator でも動くが、Associated Domains の検証に `?mode=developer` が必要。位置は Simulator の「Features › Location」で指定できる |
