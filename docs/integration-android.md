# Android への組み込み

作業員アプリ（Android）に打刻を組み込む手順です。先に [クイックスタート](quickstart.md) と [仕組み](concepts.md) を読んでください。

## 必要なもの

- Android 9（API 28）以上。パスキーは Google Play 開発者サービス経由の Credential Manager を使います。
- 作業員の端末に画面ロック（指紋、顔、PIN）が設定されていること。UV（本人確認）必須で署名するためです。
- 自社ドメインに置く `assetlinks.json`（下記）

## 1. 取り込む

Maven Central から取り込みます。

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("id.intentgate:basic-auth-android:0.1.0")   // basic-auth-core も一緒に入る
}
```

| 成果物 | 中身 |
| --- | --- |
| `id.intentgate:basic-auth-core` | オフライン打刻（`CheckInClient`）、nonce の束、サイトトークン。Android に依存しないので、JVM のサーバーや現場タブレット用のツールでも使える |
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

## 3. 保存先を用意する

SDK は保存先をインターフェースで受け取ります。どちらも**アプリを再起動しても消えない、暗号化された領域**に実装してください（Room ＋ SQLCipher、EncryptedFile など）。

```kotlin
interface BundleStore {      // nonce の束（オフラインで打刻できる回数と期限）
    fun current(): DeviceBundle?
    fun replace(bundle: DeviceBundle)
    fun takeNonce(): DeviceBundle.Nonce?     // 使っていない最小の nonce を取り出す
    fun releaseNonce(nonce: DeviceBundle.Nonce)
    fun remaining(): Int
}

interface RecordQueue {      // 署名済みで送信待ちの打刻
    fun add(record: UploadRecord)
    fun pending(): List<UploadRecord>
    fun remove(seqs: Collection<Long>)
}
```

`InMemoryBundleStore` と `InMemoryRecordQueue` は試作とテスト用です。本番では使わないでください（アプリが落ちると未送信の打刻が消えます）。

## 4. パスキーを登録する（オンライン）

```kotlin
val signer = PasskeySigner(activity, rpId = "app.example.co.jp")

// 自社バックエンドが POST /v1/workers/{id}/passkeys/options を呼び、options を返す
val optionsJson: String = myBackend.startPasskeyRegistration()
val registrationJson = signer.register(optionsJson)          // 生体認証
myBackend.finishPasskeyRegistration(registrationJson)          // → POST /v1/workers/{id}/passkeys
```

登録が終わったら、自社バックエンドが端末を発行して `device_token` をアプリに渡します（`POST /v1/workers/{id}/devices`）。

## 5. nonce の束を受け取る（オンライン）

```kotlin
val client = CheckInClient(bundles = myBundleStore, queue = myRecordQueue)

suspend fun sync() {
    // 先に、たまっている打刻を送る
    client.uploadBody()?.let { body ->
        val res = http.post("$IG_API/v1/devices/$deviceId/events", body, bearer = deviceToken)
        val seqs = res.getJSONArray("results").let { a -> (0 until a.length()).map { a.getJSONObject(it).getLong("seq") } }
        client.acknowledge(seqs)   // accepted / duplicate / rejected のどれでも、答えが来たものは消す
    }
    // 新しい束を受け取る（前の束の未使用分は無効になる）
    val bundleJson = http.post("$IG_API/v1/devices/$deviceId/bundle", "", bearer = deviceToken)
    myBundleStore.replace(DeviceBundle.parse(bundleJson))
}
```

アプリの起動時、打刻の画面を開いたとき、電波が戻ったとき（`ConnectivityManager.NetworkCallback`）に `sync()` を呼んでください。**送信してから束を受け取る**順番にしてください。送信待ちの記録は、新しい束を受け取った後に送っても受け付けられますが、先に送っておけば端末が壊れたときに失う打刻を減らせます。

## 6. 打刻する（オフラインで動く）

```kotlin
// 現場タブレットの QR を読む（ML Kit など）。中身は "IGS1." で始まる文字列
val siteToken: String = scanQr()

try {
    client.checkIn(signer, type = "site_entry", siteToken = siteToken)   // 生体認証 → 送信待ちに入る
    showDone()
} catch (e: PasskeyCancelledException) {
    // 作業員がキャンセルした。nonce は自動で戻るので連番は抜けない
} catch (e: OfflineLockedException) {
    showMessage("オフラインの期限を過ぎました。電波のある場所で同期してください")
} catch (e: NoNonceException) {
    showMessage("打刻できる回数を使い切りました。同期してください")
} catch (e: SiteToken.SiteTokenException) {
    showMessage("現場の QR ではありません")
}
```

`checkIn` は `prepare` → `PasskeySigner.sign` → `complete` をまとめたものです。打刻に追加情報（ゲート名、位置など）を付けるときは `attributes` に入れます。署名の対象に含まれるので、後から書き換えられません。

```kotlin
client.checkIn(signer, "site_exit", siteToken, attributes = mapOf("gate" to "東ゲート"))
```

## 7. 結果の扱い

アップロードの応答は記録ごとに返ります。

```json
{ "results": [
  { "seq": 12, "status": "accepted", "flags": [] },
  { "seq": 13, "status": "accepted", "flags": ["clock_skew"] },
  { "seq": 14, "status": "rejected", "reason": "invalid_signature", "flags": [] }
] }
```

- `accepted`: 確定しました。`flags` は管理画面の「要確認」に出ます。
- `duplicate`: 送信済みです。再送しても二重に数えません。
- `rejected`: 確定できません。`reason` はアプリの不具合調査に使い、作業員には「打刻を確定できませんでした。現場責任者に連絡してください」程度を出してください。

`reason` の一覧は [API リファレンス](openapi.yaml) の `RejectReason` にあります。

## よくあるつまずき

| 症状 | 原因 |
| --- | --- |
| パスキー登録が「RP ID が一致しない」で失敗する | `assetlinks.json` のパッケージ名か証明書が違う。Google のキャッシュに 1 日ほどかかることがある |
| 登録は通るがサーバーで `invalid_registration` | アプリのオリジン（`android:apk-key-hash:...`）がテナントに登録されていない |
| アップロードが全部 `invalid_signature` | テスト用と本番用で RP ID やオリジンが食い違っている。`GET /v1/account` で確認する |
| `unknown_site` | QR の現場が見つからない。テスト用アプリで本番の現場の QR を読んだときもこうなる |
| `invalid_site_token` | タブレットの鍵が登録されていないか、失効している |
| すべて `clock_skew` | 端末の時刻設定が自動になっていない |
