# Intentgate checkin SDK

工事現場の入退場などの打刻を、**作業員本人のスマホのパスキー（生体認証）で承認し、位置と時刻をサーバーで確定して記録する**ための SDK です。現場に QR やタブレットは要りません。Intentgate の API（`https://checkin.intentgate.id`）と一緒に使います。

| 作業員アプリ | 取り込み | 手順書 |
| --- | --- | --- |
| Web（スマホのブラウザ） | npm `@intentgate/basic-auth-web` | [Web への組み込み](docs/integration-web.md) |
| iOS | Swift Package Manager | [iOS への組み込み](docs/integration-ios.md) |
| Android | Maven Central `id.intentgate:basic-auth-android` | [Android への組み込み](docs/integration-android.md) |

はじめての方は、この README の「[全体の仕組み](#全体の仕組み)」と「[Web アプリを作る](#web-アプリを作る)」を読むと、作るものが一通りわかります。iOS / Android でも、自社バックエンドの部分は同じです。

- [導入の流れ（遷移図）](https://app.notion.com/p/41d764643d3e81cebe41d54d25e76778)：アカウント作成から管理画面へのログイン、SDK 組み込み、打刻までの流れ
- [クイックスタート](docs/quickstart.md)：テスト用キーで、スマホなしに打刻を一周させる
- [仕組み](docs/concepts.md)：何が証明でき、何が証明できないか
- [API リファレンス（OpenAPI）](docs/openapi.yaml) ／ [プロトコル仕様](spec/PROTOCOL.md)

## 全体の仕組み

作るものは **自社バックエンド** と **作業員アプリ** の 2 つです。

```
 ┌──────────────────────┐   API キー（igk_...）   ┌────────────────────┐
 │ 自社バックエンド       │ ─────────────────────▶ │ Intentgate API      │
 │ 作業員・現場・端末の管理 │                        │ checkin.intentgate.id│
 └──────────────────────┘                        └────────────────────┘
        ▲ 自社のログイン                                  ▲ 端末トークン（igd_...）
        │                                               │ 打刻のときだけ直接つなぐ
 ┌──────────────────────────────────────────────────────────┐
 │ 作業員アプリ（Web / iOS / Android）＋ この SDK               │
 └──────────────────────────────────────────────────────────┘
```

| | 持つもの | すること |
| --- | --- | --- |
| 自社バックエンド | API キー（`igk_...`） | 現場の登録、作業員の登録、パスキー登録の中継、端末トークンの発行、利用量の取得 |
| 作業員アプリ | 端末トークン（`igd_...`） | パスキーの登録（生体認証）、位置の取得、打刻 |
| Intentgate | — | 打刻の内容を確定し、パスキーの署名を検証して記録。管理画面で確認できる |

**API キーはアプリやブラウザに絶対に置かないでください。** アプリに渡すのは端末トークンだけです。

打刻は次の順に進みます。SDK の `checkIn` を呼ぶだけで、2〜5 をまとめて行います。

1. 作業員が「入場」ボタンを押す。アプリが位置を測る
2. アプリが「種別・現場・位置」を Intentgate に送る
3. Intentgate が時刻と打刻 ID を確定し、その内容のハッシュ（チャレンジ）を返す
4. SDK が内容を確かめ、作業員が Face ID や指紋で署名する
5. Intentgate が署名を検証して記録し、結果（現場からの距離など）を返す

## Web アプリを作る

作業員がスマホのブラウザで開くページとして作る例です。

### 0. 準備

1. Intentgate からテスト用 API キー（`igk_test_...`）を受け取る
2. 作業員アプリのページの URL を決め、**オリジン**（例: `https://worker.example.co.jp`）を Intentgate に伝えて登録してもらう。開発中は `http://localhost:5173` のようなオリジンも登録できます
3. **RP ID**（パスキーを結び付けるドメイン）を決める。ページのドメインか、その親ドメインです（例: `worker.example.co.jp`）

登録されていないオリジンのページからは、ブラウザが打刻 API への通信を止めます。

```sh
npm install @intentgate/basic-auth-web
```

バンドラーを使わないページでは、`https://cdn.jsdelivr.net/npm/@intentgate/basic-auth-web@0.3.0/+esm` から ES モジュールとして読み込めます。

### 1. 自社バックエンド：現場と作業員を登録する

Intentgate の API は、どれも `Authorization: Bearer <API キー>` を付けて呼びます。ここでは Node.js の例を示します。

```ts
const IG = "https://checkin.intentgate.id";
const ig = (path: string, body?: unknown) =>
  fetch(IG + path, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.IG_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

// 現場（中心の緯度・経度と半径 m）
const { site } = await ig("/v1/sites", {
  name: "渋谷二丁目新築工事", time_zone: "Asia/Tokyo", latitude: 35.659518, longitude: 139.70357, radius_m: 80,
});

// 作業員と、その現場への割り当て
const { worker } = await ig("/v1/workers", { display_name: "佐藤 一郎", external_ref: "Y-0012" });
await ig(`/v1/sites/${site.id}/assignments`, { worker_id: worker.id, starts_on: "2026-11-01" });
```

現場と作業員は、管理画面（`https://checkin.intentgate.id/`）から登録することもできます。

### 2. 自社バックエンド：パスキー登録の中継と端末の発行

作業員が自社のログインを済ませたあとに、次の 3 つのエンドポイントを自社バックエンドに用意します。**パスキーを登録する前に、本人確認を必ず済ませてください。**

```ts
// ① パスキー登録の開始: options をページに返す（challenge_id はサーバー側に残す）
app.post("/passkey/options", async (req, res) => {
  const { challenge_id, options } = await ig(`/v1/workers/${req.user.workerId}/passkeys/options`);
  req.session.challengeId = challenge_id;
  res.json(options);
});

// ② パスキー登録の完了: ページから来た結果を Intentgate に渡す
app.post("/passkey", async (req, res) => {
  await ig(`/v1/workers/${req.user.workerId}/passkeys`, { challenge_id: req.session.challengeId, response: req.body });
  res.sendStatus(204);
});

// ③ 端末の発行: 端末トークンは一度しか返らないので、そのままページに渡す
app.post("/device", async (req, res) => {
  const { device, device_token } = await ig(`/v1/workers/${req.user.workerId}/devices`);
  res.json({ deviceId: device.id, deviceToken: device_token });
});
```

### 3. ページ：パスキーを登録する（最初の 1 回）

```ts
import { PasskeySigner } from "@intentgate/basic-auth-web";

const signer = new PasskeySigner({ rpId: "worker.example.co.jp" });

registerButton.onclick = async () => {
  if (!(await PasskeySigner.isAvailable())) return alert("この端末ではパスキーを使えません");
  const options = await fetch("/passkey/options", { method: "POST" }).then((r) => r.json());
  const registration = await signer.register(options);          // Face ID / 指紋
  await fetch("/passkey", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registration) });
  const device = await fetch("/device", { method: "POST" }).then((r) => r.json());
  saveDevice(device);                                             // 下の「端末トークンの置き場所」を参照
};
```

### 4. ページ：打刻する

```ts
import { CheckInClient, PasskeySigner, currentPosition, PasskeyError, CheckInAPIError } from "@intentgate/basic-auth-web";

const { deviceId, deviceToken } = loadDevice();
const client = new CheckInClient({ baseUrl: "https://checkin.intentgate.id", deviceId, deviceToken });
const signer = new PasskeySigner({ rpId: "worker.example.co.jp" });

entryButton.onclick = async () => {              // ボタンの操作から直接呼ぶ（Safari の制限のため）
  try {
    const result = await client.checkIn({
      signer,
      request: { type: "site_entry", siteId, ...(await currentPosition()) },  // 退場は "site_exit"
      confirm: () => window.confirm("渋谷二丁目新築工事に入場します"),          // 署名の前に内容を見せる（任意）
    });
    if (result === null) return;                                              // 作業員が中止した
    if (result.needsReview) alert(`記録しました（要確認: 現場から ${result.distanceM} m）`);
    else alert("入場を記録しました");
  } catch (e) {
    if (e instanceof PasskeyError && e.code === "cancelled") return;          // 生体認証をキャンセル
    if (e instanceof CheckInAPIError) alert(`打刻できませんでした（${e.code}）`);
    else throw e;
  }
};
```

結果の `flags` に `outside_site`（現場の範囲外）や `low_accuracy`（位置の精度が低い）が入っていても、打刻は記録されています。管理画面で「要確認」として表示されます。エラーコードの一覧は [Web への組み込み](docs/integration-web.md#6-エラー) にあります。

### 5. 確かめる

管理画面にログインし、左上の「テストモード」をオンにして「入退記録」を開くと、打刻が表示されます。

### 端末トークンの置き場所

ブラウザには、アプリの Keychain のような保護された保存領域がありません。端末トークンは、作業員がログインしている間だけ自社バックエンドから受け取ってメモリに持つのがおすすめです。`localStorage` に保存する場合は、ページの XSS 対策を徹底してください。トークンが漏れても作業員のパスキーがなければ打刻はできませんが、漏れた端末は管理画面か `DELETE /v1/devices/{id}` で失効させてください。

### 本番に切り替える

本番用の RP ID とオリジンを Intentgate に伝え、管理画面の「設定」で本番用 API キー（`igk_live_...`）を作って差し替えます。テストのデータは本番に引き継がれません。

## iOS / Android

自社バックエンドの部分（上の 1 と 2）は Web と同じです。アプリ側の手順は [iOS](docs/integration-ios.md) と [Android](docs/integration-android.md) の手順書にあります。

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

> **0.1.0 は使わないでください。** 現場に QR を置く旧方式で、今の API とは動きません。

## テスト用ツール

```sh
export IG_API=https://checkin.intentgate.id
curl -s $IG_API/health                           # {"ok":true} なら接続できています
IG_API=$IG_API IG_KEY=igk_test_... node tools/simulate.mjs
```

作業員アプリの役をソフトウェアで演じて、テストモードで現場の中と外から打刻します。スマホがなくても、自社バックエンドを作る前に流れを確かめられます。テスト用キーでしか動きません。

## このリポジトリについて

| ディレクトリ | 中身 |
| --- | --- |
| `web/` | Web SDK（`@intentgate/basic-auth-web`）と、言語共通のプロトコル（`@intentgate/basic-auth-protocol`） |
| `swift/` | iOS / macOS SDK |
| `kotlin/` | Android / JVM SDK |
| `docs/` | 手順書と API リファレンス |
| `spec/` | プロトコル仕様と、言語間で同じ結果になることを確かめるテストベクタ |
| `tools/` | テスト用シミュレーター |

このリポジトリは Intentgate の社内リポジトリから自動で書き出しています。不具合の報告や要望は Issue でお知らせください。プルリクエストは内容を確認したうえで社内リポジトリに取り込みます。

## ライセンス

[Apache License 2.0](LICENSE)
