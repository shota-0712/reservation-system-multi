# Single-Tenant Salon Reservation System

美容サロン向けのシングルテナント予約システムです。

このリポジトリでは、1つのコードベースからサロンごとに独立したCloud RunサービスとDBを立てる前提で開発します。予約の正本はPostgreSQLへ移行し、Google CalendarとLINE通知は予約確定後の副作用として扱います。

## Architecture Docs

- [Single-tenant architecture requirements](docs/single-tenant-architecture-requirements.md)
- [Implementation issue breakdown](docs/implementation-issues.md)
- [Production settings and GitHub Actions secrets](GITHUB_SECRETS.md)
- [Tenant ledger template and operation rules](tenants/README.md)

## DB Provider Decision

本番DBは、現時点では **Neon Postgresを第一候補として採用**します。

理由:

- PostgreSQLの `tstzrange` と `EXCLUDE USING gist` を使い、予約・休憩・私用などの時間帯重複をDB制約で防げる。
- サロンごとにNeon projectを分けることで、シングルテナントのデータ分離を保てる。
- Cloud Runと同じくサーバーレス運用に寄せやすく、1件目導入前の固定費を抑えやすい。
- 将来Cloud SQLやSupabaseへ移す場合も、PostgreSQL前提の設計を維持できる。

Cloudflare D1は低コストですがSQLite系のため、今回の中核であるPostgreSQL range型・排他制約とは相性が落ちます。Supabaseは管理画面やBaaS機能が強い一方、今回はLIFF認証とCloud Run中心の構成なので、まずはNeonを優先します。

## Local Postgres

ローカル開発ではPostgreSQLを使います。DB migrationとSQL smoke testの詳細は [db/README.md](db/README.md) を参照してください。

Dockerで起動する場合:

```sh
docker run --name salon-reservation-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=reservation_dev \
  -p 5432:5432 \
  -d postgres:16
```

接続URL:

```sh
postgres://postgres:postgres@localhost:5432/reservation_dev
```

接続確認:

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/reservation_dev
psql "$DATABASE_URL" -c 'select 1;'
```

既にローカルPostgresがある場合は、同等のDBを作成して `DATABASE_URL` に接続文字列を設定します。

## Production Configuration

本番Cloud Runでは、機密値を通常の環境変数やGitHub Secretsから直接注入しません。Secret Managerに保存し、Cloud RunのSecret参照として渡します。

本番で必須のSecret Manager secret:

| Cloud Run env var | 用途 |
|---|---|
| `DATABASE_URL` | サロンごとのPostgreSQL接続URL |
| `LINE_ACCESS_TOKEN` | LINE Messaging APIチャネルアクセストークン |
| `SCHEDULER_SECRET` | Cloud Scheduler認証用secret |

非機密設定の例:

| env var | 用途 |
|---|---|
| `GCP_PROJECT_ID` | Google CloudプロジェクトID |
| `REGION` | Cloud Run / Artifact Registryリージョン |
| `SERVICE_NAME` | Cloud Runサービス名、サイトタイトル |
| `LIFF_ID` | LIFFアプリID |
| `LINE_CHANNEL_ID` | LIFF ID token検証用LINE LoginチャネルID |
| `THEME_COLOR`, `THEME_COLOR_LIGHT`, `THEME_COLOR_DARK` | サイトテーマカラー |
| `GOOGLE_SHEET_ID` | DB移行後は予約データの正本ではない。残す場合は移行元、テンプレート、補助設定など用途を明確にする。 |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | Google Calendar push notification の受信URL。例: `https://<service-url>/api/webhooks/google-calendar` |

Cloud Run runtime service account には、参照するSecretごとに `roles/secretmanager.secretAccessor` を付与します。GitHub Actions側にはdeploy認証に必要なGCP認証情報だけを置き、アプリ機密値は置きません。

詳細なGitHub Variables、Secret Manager secret名、権限付与手順は [GITHUB_SECRETS.md](GITHUB_SECRETS.md) を参照してください。

## Migration Policy

初期段階では、ORMではなく **SQL migration + `psql`** で進めます。

migration SQLは `db/migrations` に番号つきSQLファイルとして置きます。

現在のディレクトリ:

```text
db/migrations/
db/tests/
```

migration実行コマンド例:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
```

SQL smoke test実行コマンド例:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/001_busy_ranges.sql
```

方針:

- migrationは番号つきSQLファイルで管理する。
- DB制約、trigger、enum、indexはSQLに明示する。
- migration追加時は、空DBへ適用できることを最低条件にする。
- 後続でmigration数が増えた段階で、必要ならmigration runnerを導入する。

## Backend

```sh
cd backend
cp .env.example .env
npm install
npm run dev
```

現在の既存実装はGoogle Sheets / Google Calendar中心です。DB正本への移行はGitHub Issueの順番に沿って段階的に進めます。

DB接続層は `backend/services/db.js` にあり、`DATABASE_URL` からPostgreSQLへ接続します。
`query(text, params)` と `withTransaction(callback)` を提供し、repository層は
`backend/repositories/` 配下に配置します。予約・スタッフブロック作成repositoryは、
同じtransaction clientで `practitioner_busy_ranges` も作成する前提です。
