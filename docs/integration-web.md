# Web（ブラウザ）への組み込み

作業員アプリを Web アプリ（スマホのブラウザで開くページ）として作る場合の手順です。先に [クイックスタート](quickstart.md) と [仕組み](concepts.md) を読んでください。打刻の流れ、署名の中身、サーバー側の検証は Android / iOS と同じです。

## 必要なもの

- パスキーに対応したブラウザ: iOS 16 以上の Safari、Android 9 以上の Chrome、最近の Chrome / Edge / Safari / Firefox
- **https** で配信されたページ（開発中だけ `http://localhost` も可）
- 位置情報の許可。打刻のときに一度だけ測ります
- 打刻のときに電波がつながっていること
- 作業員の端末に画面ロック（指紋、顔、PIN）が設定されていること。UV（本人確認）必須で署名するためです

## 1. 取り込む

npm から取り込みます。依存は Intentgate のプロトコル パッケージだけです。

```sh
npm install @intentgate/basic-auth-web
```

| パッケージ | 中身 |
| --- | --- |
| `@intentgate/basic-auth-web` | 打刻の通信と検証（`CheckInClient`）、WebAuthn でのパスキー登録と署名（`PasskeySigner`）、位置の取得（`currentPosition`） |
| `@intentgate/basic-auth-protocol` | 正規化 JSON、イベントとチャレンジの計算。上と一緒に入る |

バンドラーを使わないページでは、ES モジュールとして CDN から読み込めます。

```html
<script type="module">
  import { CheckInClient, PasskeySigner, currentPosition } from "https://cdn.jsdelivr.net/npm/@intentgate/basic-auth-web@0.3.0/+esm";
</script>
```

ソースは https://github.com/Intentgate-id/SDK_kit の `web/` にあります。

## 2. ドメインとオリジン

Web では、パスキーは**ページのドメイン**に結び付きます。ネイティブアプリのような `assetlinks.json` や Associated Domains は要りませんが、次の 2 つを守ってください。

- **RP ID は、ページのドメインかその親ドメインにする。** ページが `https://worker.example.co.jp` なら、RP ID は `worker.example.co.jp` か `example.co.jp` です。関係のないドメイン（例: `intentgate.id`）は指定できません（ブラウザが拒否します）。
- **ページのオリジンをテナントに登録する。** `https://worker.example.co.jp` のように、スキームとホスト（ポートがあればポートも）を Intentgate に伝え、テナントのオリジンに追加してもらってください。テスト環境と本番で別々に設定できます。開発中は `http://localhost:5173` のようなオリジンをテスト環境に登録します。

ネイティブアプリと同じ RP ID を使えば、同じ作業員のパスキーをアプリとブラウザの両方で使えます（iOS は Associated Domains、Android は `assetlinks.json` の設定が別に必要です）。

登録されたオリジンからのページだけが、ブラウザから打刻 API（`/v1/devices/...`）を直接呼べます（CORS）。登録されていないオリジンからの呼び出しはブラウザが止めます。API キー（`igk_...`）を使う管理用 API はブラウザから呼べません。API キーは自社バックエンドにだけ置いてください。

## 3. パスキーを登録する

```ts
import { PasskeySigner } from "@intentgate/basic-auth-web";

const signer = new PasskeySigner({ rpId: "worker.example.co.jp" });

if (!(await PasskeySigner.isAvailable())) {
  // この端末ではパスキーを使えない（画面ロックがない、古いブラウザなど）
}

// 自社バックエンドが POST /v1/workers/{id}/passkeys/options を呼び、options を返す
const options = await myBackend.startPasskeyRegistration();
const registration = await signer.register(options);           // 生体認証
await myBackend.finishPasskeyRegistration(registration);         // → POST /v1/workers/{id}/passkeys
```

登録が終わったら、自社バックエンドが端末を発行して `device_id` と `device_token` をページに渡します（`POST /v1/workers/{id}/devices`）。

**端末トークンの置き場所。** ブラウザにはアプリの Keychain や Keystore のような保護された領域がありません。`device_token` は次のどちらかにしてください。

- 作業員がログインしている間だけ、自社バックエンドからページに渡してメモリに持つ（おすすめ）
- `localStorage` などに保存する場合は、ページの XSS 対策（CSP、外部スクリプトを最小にする）を徹底する

トークンが漏れても、作業員のパスキーがなければ打刻はできません。ただし申請（`start`）はできるので、漏れた端末は管理画面か `DELETE /v1/devices/{id}` で失効させてください。

## 4. 打刻する

```ts
import {
  CheckInAPIError, CheckInClient, CheckInNetworkError, currentPosition,
  IssuedCheckInMismatch, LocationError, PasskeyError, PasskeySigner,
} from "@intentgate/basic-auth-web";

const client = new CheckInClient({
  baseUrl: "https://checkin.intentgate.id",
  deviceId,
  deviceToken,
});
const signer = new PasskeySigner({ rpId: "worker.example.co.jp" });

try {
  const position = await currentPosition();             // 初回はブラウザが許可を求める
  const result = await client.checkIn({
    signer,
    request: { type: "site_entry", siteId, ...position }, // siteId は自社バックエンドから受け取った、その日の現場
    // 生体認証の前に、何を承認するのかを作業員に見せる（任意）。false を返すと中止
    confirm: () => window.confirm(`${siteName} に入場します`),
  });
  if (result === null) return;                           // 作業員が中止した
  if (result.needsReview) showWarning(result);           // 例: "現場から 412 m 離れています"
  else showDone();
} catch (e) {
  if (e instanceof PasskeyError && e.code === "cancelled") {
    // 生体認証をキャンセルした。打刻は記録されない（もう一度押せばやり直せる）
  } else if (e instanceof LocationError) {
    showMessage(e.code === "denied" ? "位置情報の利用を許可してください" : "位置を測れませんでした");
  } else if (e instanceof CheckInAPIError) {
    showMessage(messageFor(e.code));                     // 下の「エラー」を参照
  } else if (e instanceof IssuedCheckInMismatch) {
    showMessage("サーバーの応答が申請と違うため、署名を中止しました");
  } else if (e instanceof CheckInNetworkError) {
    showMessage("通信できません。電波のある場所でもう一度押してください");
  } else throw e;
}
```

`checkIn` は、作業員のボタン操作から直接呼んでください。Safari はユーザー操作のないパスキーの呼び出しを止めることがあります。

`checkIn` は次の 3 つをまとめたものです。分けて呼ぶこともできます。

1. `client.start(request)` — 申請し、サーバーが確定したイベントを確かめる。種別、現場、端末、追加情報、位置（緯度経度は 10^-7 度の丸めまで、精度は切り上げ）が申請と違うか、チャレンジがイベントのハッシュでなければ `IssuedCheckInMismatch`
2. `signer.sign(issued.challengeBytes, { allowCredentials: issued.allowCredentials })` — 生体認証で署名
3. `client.complete(issued.checkinId, assertion)` — 署名を送り、結果を受け取る

打刻に追加情報（ゲート名など）を付けるときは `attributes` に入れます。署名の対象に含まれるので、後から書き換えられません。小数は使えません（整数、文字列、真偽値、null、配列、オブジェクト）。

```ts
{ type: "site_exit", siteId, ...position, attributes: { gate: "東ゲート" } }
```

## 5. 結果の扱い

`checkIn` と `complete` は次の形で返します。

```ts
{ checkinId: "chk_...", status: "accepted", flags: ["outside_site"], billable: true, distanceM: 412, needsReview: true }
```

- `status: "accepted"`: 記録しました。`flags` が空でなければ管理画面で「要確認」になります。その場で作業員に「現場から 412 m 離れています」のように見せると、位置の取り直しや報告につながります。
- `status: "duplicate"`: 完了済みの打刻をもう一度送りました。記録済みの結果が返ります。通信が切れて応答が届かなかったときは、同じ `checkinId` と署名で `complete` を呼び直してください。

| フラグ | 作業員への表示の例 |
| --- | --- |
| `outside_site` | 現場の範囲外で打刻しました（現場から ○ m） |
| `low_accuracy` | 位置の精度が低い状態で打刻しました |
| `unassigned_site` | 今日割り当てのない現場です |

## 6. エラー

| 例外 | 意味 |
| --- | --- |
| `CheckInAPIError` | Intentgate がエラーを返した。`code` と `status`、レート制限なら `retryAfter`（秒） |
| `CheckInNetworkError` | 通信できない（圏外、タイムアウト、CORS で止められた） |
| `IssuedCheckInMismatch` | サーバーの応答が申請と違うので署名しなかった |
| `PasskeyError` | パスキーの失敗。`code` は `cancelled`（キャンセルまたはタイムアウト）、`rp_id_mismatch`（ページのドメインと RP ID が合わない）、`unsupported`、`already_registered`（登録時）、`invalid_options`、`failed` |
| `LocationError` | 位置を測れない。`code` は `denied`、`unavailable`、`timeout`、`unsupported` |
| `CheckInValidationError` | 申請の値がおかしい（緯度の範囲外、小数の追加情報など）。サーバーには送っていない |

`CheckInAPIError.code` の主なもの:

| code | HTTP | 意味と対処 |
| --- | --- | --- |
| `checkin_expired` | 410 | 申請から 180 秒以内に署名が届かなかった。最初からやり直す |
| `unknown_site` | 404 | 現場が見つからない。テスト用の端末で本番の現場 ID を使ったとき、また他社の現場で、作業員がその日に割り当てられていないときもこうなる |
| `site_location_missing` | 409 | 現場の位置が登録されていない。管理画面で登録する |
| `no_passkey` | 409 | 作業員にパスキーがない。登録からやり直す |
| `invalid_signature` | 400 | 署名を検証できない。RP ID やオリジンの食い違いが多い |
| `unauthorized` | 401 | 端末トークンが無効か、端末が失効している。自社バックエンドで端末を発行し直す |

一覧は [API リファレンス](openapi.yaml) の `CheckInErrorCode` にあります。

## よくあるつまずき

| 症状 | 原因 |
| --- | --- |
| 打刻を押すと `CheckInNetworkError` になり、ブラウザのコンソールに CORS のエラーが出る | ページのオリジンがテナントに登録されていない。`https://` と `http://`、ポート番号の違いにも注意 |
| `PasskeyError` の `rp_id_mismatch` | RP ID がページのドメインでもその親ドメインでもない |
| `PasskeyError` の `unsupported` | `http://` で開いている（`localhost` 以外）、またはパスキー非対応のブラウザ |
| 登録は通るがサーバーで `invalid_registration` | ページのオリジンがテナントに登録されていない |
| 打刻が全部 `invalid_signature` | テスト用と本番用で RP ID やオリジンが食い違っている。`GET /v1/account` で確認する |
| `LocationError` の `denied` が続く | 一度拒否すると、ブラウザの設定（サイトの権限）から許可し直すまで聞かれない。iOS は「設定 › プライバシー › 位置情報サービス › Safari の Web サイト」も確認する |
| いつも `low_accuracy` になる | パソコンのブラウザは Wi-Fi から推定するため精度が低い。作業員にはスマホで開いてもらう |
