# 開発者向けドキュメント

Intentgate の打刻 SDK を使って、作業員アプリと自社のバックエンドを作る開発者向けの資料です。

| 資料 | 内容 |
| --- | --- |
| [クイックスタート](quickstart.md) | テスト用キーを受け取ってから、最初の打刻が管理画面に表示されるまで |
| [仕組み](concepts.md) | 登場する 3 者（自社バックエンド、作業員アプリ、Intentgate）、打刻の流れ、何が証明できるか、要確認のフラグ |
| [Android への組み込み](integration-android.md) | 位置の取得、Credential Manager でのパスキー登録と打刻、Digital Asset Links |
| [iOS への組み込み](integration-ios.md) | Core Location での位置の取得、AuthenticationServices でのパスキー登録と打刻、Associated Domains |
| [API リファレンス](openapi.yaml) | OpenAPI 3.1。`/v1` のすべてのエンドポイント、エラーコード |

プロトコルの仕様は [spec/PROTOCOL.md](../spec/PROTOCOL.md)、言語間で共通のテストベクタは [spec/test-vectors.json](../spec/test-vectors.json) にあります。

## 本番とテスト

API キーは 2 種類あります。Stripe と同じ考え方です。

| | 本番 | テスト |
| --- | --- | --- |
| キー | `igk_live_...` | `igk_test_...` |
| データ | 本番の現場・作業員・打刻 | テスト専用。本番とは混ざらない |
| 課金 | 作業員 × 現場 × 日 | なし |
| RP ID・オリジン | 本番アプリのドメイン | 別に設定できる（ステージング、`localhost` など） |

開発中はテスト用キーを使ってください。どちらのキーかは `GET /v1/account` の `mode` で確認できます。管理画面では左上の「テストモード」でテストのデータに切り替わります。

## URL

| | URL |
| --- | --- |
| API | `https://checkin.intentgate.id/v1/...`（本番とテストで同じ URL。キーでモードが決まります） |
| 管理画面 | `https://checkin.intentgate.id/` |

この資料のコマンド例では API の URL を環境変数 `$IG_API` に入れて使います。

```sh
export IG_API=https://checkin.intentgate.id
```
