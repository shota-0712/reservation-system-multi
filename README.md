# Single-Tenant Salon Reservation System

美容サロン向けのシングルテナント予約システムです。

このリポジトリでは、1つのコードベースからサロンごとに独立したCloud RunサービスとDBを立てる前提で開発します。予約の正本はPostgreSQLへ移行し、Google CalendarとLINE通知は予約確定後の副作用として扱います。

## Architecture Docs

- [Single-tenant architecture requirements](docs/single-tenant-architecture-requirements.md)
- [Implementation issue breakdown](docs/implementation-issues.md)

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
