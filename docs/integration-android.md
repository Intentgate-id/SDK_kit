# Android への組み込み

作業員アプリ（Android）に打刻を組み込む手順です。先に [クイックスタート](quickstart.md) と [仕組み](concepts.md) を読んでください。

## 必要なもの

- Android 9（API 28）以上。パスキーは Google Play 開発者サービス経由の Credential Manager を使います。
- 位置情報の権限（`ACCESS_FINE_LOCATION`）。打刻のときに一度だけ測ります。バックグラウンドの位置情報は要りません。
- 打刻のときに電波がつながっていること
- 作業員の端末に画面ロック（指紋、顔、PIN）が設定されていること。UV（本人確認）必須で署名するためです。
- 自社ドメインに置く `assetlinks.json`（下記）

## 1. 取り込む

Maven Central から取り込みます。

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("id.intentgate:basic-auth-android:0.2.0")   // basic-auth-core も一緒に入る
}
```

| 成果物 | 中身 |
| --- | --- |
| `id.intentgate:basic-auth-core` | 打刻の通信と検証（`CheckInClient`、`CheckInRequest`、イベントとチャレンジの検証）。Android に依存しないので JVM でも使える |
| `id.intentgate:basic-auth-android` | Credential Manager でのパスキー登録と署名（`PasskeySigner`） |

ソースは https://github.com/Intentgate-id/SDK_kit にあります。

## 2. ドメインとアプリを結び付ける

パスキーは RP ID（例: `app.example.co.jp`）に結び付きます。Android アプリがその RP ID のパスキーを使うには、ドメインにアプリを登録します。

`https://<RP ID>/.well-known/assetlinks.json`:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
  "target": {
    "namespace": "android_app",
    "package_name": "jp.co.example.genba",
    "sha256_cert_fingerprints": ["AB:CD:...:EF"]
  }
}]
```

Android アプリからの署名は、オリジンが `android:apk-key-hash:<署名証明書の SHA-256 を base64url>` になります。この値を Intentgate に伝え、テナントのオリジンに追加してもらってください（テスト環境と本番で別々に設定できます）。

```sh
# 署名証明書の SHA-256 を base64url に変換する
keytool -list -v -keystore release.jks -alias release | grep SHA256: | awk '{print $2}' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='
```

デバッグ用の証明書とリリース用の証明書はハッシュが違います。テスト環境にはデバッグ用、本番にはリリース用（Play App Signing を使う場合は Play Console に表示される証明書）を登録します。

## 3. パスキーを登録する

```kotlin
val signer = PasskeySigner(activity, rpId = "app.example.co.jp")

// 自社バックエンドが POST /v1/workers/{id}/passkeys/options を呼び、options を返す
val optionsJson: String = myBackend.startPasskeyRegistration()
val registrationJson = signer.register(optionsJson)          // 生体認証
myBackend.finishPasskeyRegistration(registrationJson)          // → POST /v1/workers/{id}/passkeys
```

登録が終わったら、自社バックエンドが端末を発行して `device_id` と `device_token` をアプリに渡します（`POST /v1/workers/{id}/devices`）。アプリは `device_token` を暗号化された領域（Android Keystore で守った EncryptedSharedPreferences など）に保存してください。

## 4. 打刻する

```kotlin
val client = CheckInClient(
    baseUrl = "https://checkin.intentgate.id",
    deviceId = deviceId,
    deviceToken = deviceToken,
)

// 位置を測る（Google Play 開発者サービスの FusedLocationProviderClient）
val location = LocationServices.getFusedLocationProviderClient(activity)
    .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null).await()

try {
    val result = client.checkIn(
        signer,
        CheckInRequest(
            type = "site_entry",
            siteId = siteId,                        // 自社バックエンドから受け取った、その日の現場
            latitude = location.latitude,
            longitude = location.longitude,
            accuracyM = location.accuracy.toDouble(),
        ),
    ) { issued ->
        // 生体認証の前に、何を承認するのかを作業員に見せる（任意）。false を返すと中止
        confirmDialog("${siteName} に入場します")
    }
    if (result == null) return                     // 作業員が中止した
    if (result.needsReview) showWarning(result)    // 例: "現場から 412 m 離れています"
    else showDone()
} catch (e: PasskeyCancelledException) {
    // 生体認証をキャンセルした。打刻は記録されない（もう一度押せばやり直せる）
} catch (e: CheckInApiException) {
    showMessage(messageFor(e.code))                // 下の「エラー」を参照
} catch (e: IssuedCheckInMismatchException) {
    showMessage("サーバーの応答が申請と違うため、署名を中止しました")
} catch (e: IOException) {
    showMessage("通信できません。電波のある場所でもう一度押してください")
}
```

`checkIn` は次の 3 つをまとめたものです。分けて呼ぶこともできます（`start` と `complete` はブロッキングなので、メインスレッド以外で呼んでください）。

1. `client.start(request)` — 申請し、サーバーが確定したイベントを確かめる。種別、現場、端末、追加情報、位置（緯度経度は 10^-7 度の丸めまで、精度は切り上げ）が申請と違うか、チャレンジがイベントのハッシュでなければ `IssuedCheckInMismatchException`
2. `signer.sign(issued.challenge, issued.allowCredentials)` — 生体認証で署名
3. `client.complete(issued.checkinId, assertionJson)` — 署名を送り、`CheckInResult` を受け取る

打刻に追加情報（ゲート名など）を付けるときは `attributes` に入れます。署名の対象に含まれるので、後から書き換えられません。小数は使えません（整数、文字列、真偽値、null、配列、オブジェクト）。

```kotlin
CheckInRequest("site_exit", siteId, lat, lng, accuracy, attributes = mapOf("gate" to "東ゲート"))
```

## 5. 結果の扱い

```json
{ "checkin_id": "chk_...", "status": "accepted", "flags": ["outside_site"], "billable": true, "distance_m": 412 }
```

- `status: accepted`: 記録しました。`flags` が空でなければ管理画面で「要確認」になります。その場で作業員に「現場から 412 m 離れています」のように見せると、位置の取り直しや報告につながります。
- `status: duplicate`: 完了済みの打刻をもう一度送りました。記録済みの結果が返ります。通信が切れて応答が届かなかったときは、同じ `checkinId` と署名で `complete` を呼び直してください。

| フラグ | 作業員への表示の例 |
| --- | --- |
| `outside_site` | 現場の範囲外で打刻しました（現場から ○ m） |
| `low_accuracy` | 位置の精度が低い状態で打刻しました |
| `unassigned_site` | 今日割り当てのない現場です |

## 6. エラー

`CheckInApiException.code` の主なもの:

| code | HTTP | 意味と対処 |
| --- | --- | --- |
| `checkin_expired` | 410 | 申請から 180 秒以内に署名が届かなかった。最初からやり直す |
| `unknown_site` | 404 | 現場が見つからない。テスト用アプリで本番の現場 ID を使ったときもこうなる |
| `site_location_missing` | 409 | 現場の位置が登録されていない。管理画面で登録する |
| `no_passkey` | 409 | 作業員にパスキーがない。登録からやり直す |
| `invalid_signature` | 400 | 署名を検証できない。RP ID やオリジンの食い違いが多い |
| `unauthorized` | 401 | 端末トークンが無効か、端末が失効している。自社バックエンドで端末を発行し直す |

一覧は [API リファレンス](openapi.yaml) の `CheckInErrorCode` にあります。

## よくあるつまずき

| 症状 | 原因 |
| --- | --- |
| パスキー登録が「RP ID が一致しない」で失敗する | `assetlinks.json` のパッケージ名か証明書が違う。Google のキャッシュに 1 日ほどかかることがある |
| 登録は通るがサーバーで `invalid_registration` | アプリのオリジン（`android:apk-key-hash:...`）がテナントに登録されていない |
| 打刻が全部 `invalid_signature` | テスト用と本番用で RP ID やオリジンが食い違っている。`GET /v1/account` で確認する |
| いつも `outside_site` になる | 現場の中心や半径が違う。管理画面の現場の詳細で「地図」を開いて確かめる |
| いつも `low_accuracy` になる | 屋内や高層ビルの谷間。`PRIORITY_HIGH_ACCURACY` で測っているか、位置情報の「正確な位置」がオンかを確かめる |
