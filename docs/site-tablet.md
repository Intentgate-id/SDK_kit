# 現場タブレット

現場の入口に置くタブレット（または小型端末）に、30 秒ごとに変わる署名付き QR を表示します。作業員はこの QR を読んで打刻します。タブレットはネットワークにつながっていなくても動きます。

## しくみ

```
IGS1.<base64url(JCS({"kid": "...", "site_id": "...", "t": <30 秒の窓の開始>, "v": 1}))>.<base64url(Ed25519 署名)>
```

- 現場ごとに Ed25519 の鍵を作り、**秘密鍵はタブレットだけ**が持ちます。
- 公開鍵は `POST /v1/sites/{id}/keys` で Intentgate に登録します（`kid` で区別）。
- QR の時刻 `t` が打刻の日付を決めます。**タブレットの時計を正しく保ってください**（NTP の自動設定）。

## 1. 鍵を作る

タブレットの中で作り、秘密鍵を外に出さないのが理想です。

- Android: Android 13 以上なら Android Keystore の Ed25519、それ以前は Tink などを使います。`SiteToken.jdkSigner(seed)` は 32 バイトの seed から署名器を作ります（seed は暗号化して保存）。
- iOS / iPadOS: `Ed25519.signer(seed:)` と `Ed25519.publicKey(seed:)`。seed は Keychain に入れます。

## 2. 公開鍵を登録する

```sh
curl -s -X POST $IG_API/v1/sites/site_.../keys -H "Authorization: Bearer $IG_KEY" -H "Content-Type: application/json" \
  -d '{"kid": "tablet-1", "public_key": "<raw 32 バイトを base64url>"}'
```

管理画面の現場の画面からも登録できます（現場責任者も自分の現場なら登録できます）。

## 3. QR を表示する

```kotlin
val generator = SiteTokenGenerator(siteId = "site_...", kid = "tablet-1", signer = SiteToken.jdkSigner(seed))
// 1 秒ごとに呼び、文字列が変わったら QR を描き直す
val token = generator.current()
val secondsLeft = generator.secondsUntilRotation()
```

```swift
let generator = SiteTokenGenerator(siteId: "site_...", kid: "tablet-1", signer: try Ed25519.signer(seed: seed))
let token = try generator.current()
```

QR は誤り訂正レベル M 以上、画面の明るさは最大にしてください。屋外では画面の映り込みに注意します。

## 4. 鍵を替える・失効させる

- タブレットを紛失したら、すぐに `DELETE /v1/sites/{id}/keys/{kid}` で失効させます。以後、その鍵で署名された QR での打刻は `invalid_site_token` になります。
- 交換するときは新しい `kid` で登録してから古い鍵を失効させれば、打刻を止めずに切り替えられます。
- 1 つの現場に複数のタブレット（ゲートごとなど）を置くときは、それぞれ別の `kid` にします。

## 注意

QR の写真を現場の外へ送れば、30 秒以内なら離れた場所から読めてしまいます。詳しくは [仕組み › 証明できないこと](concepts.md#証明できないこと) を見てください。
