# 1件目サロン導入ランブック

この手順書は、1件目のサロンをNeon PostgreSQL、GCP Cloud Run、LINE LIFF、Google Calendarで本番導入するためのランブックです。

前提:

- リポジトリルートで実行する。
- `DATABASE_URL`、`LINE_ACCESS_TOKEN`、`SCHEDULER_SECRET` の実値は、shell、Secret Manager、管理コンソール内だけで扱い、このドキュメントやGit管理ファイルに書かない。
- `<GCP_PROJECT_ID>`、`<salon_id>`、`<SERVICE_NAME>`、`<LIFF_ID>` などは実作業時に置き換える。
- `salon_id` は小文字英数字とハイフンのみを使う。例: `example-salon`

共通変数の例:

```bash
export GCP_PROJECT_ID=<GCP_PROJECT_ID>
export SALON_ID=<salon_id>
export REGION=asia-northeast1
export SERVICE_NAME=reservation-<salon_id>
export REPO=reservation-system
export IMAGE=reservation-system-api
export TAG=$(git rev-parse --short HEAD)
export IMAGE_URI="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"
```

## Step 1: Neon DB セットアップ

Neonコンソール: [https://console.neon.tech](https://console.neon.tech)

実行手順:

1. Neonアカウントを作成し、コンソールにログインする。
2. 新規Projectを作成する。サロンごとにProjectを分ける。
3. Projectの `Connection Details` からPostgreSQL接続文字列を取得する。
4. 接続文字列を作業shellの `DATABASE_URL` にだけ設定する。実値はファイルに保存しない。
5. migrationを全件適用する。

実行コマンド:

```bash
export DATABASE_URL='<NEON_DATABASE_URL>'

for f in db/migrations/*.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

確認コマンド:

```bash
psql "$DATABASE_URL" -c '\dt'

psql "$DATABASE_URL" -Atc "
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'reservations',
    'staff_blocks',
    'practitioner_busy_ranges',
    'outbox_events',
    'audit_logs',
    'customers',
    'practitioners',
    'menus',
    'options',
    'menu_options',
    'settings',
    'calendar_sync_states',
    'calendar_sync_conflicts'
  )
ORDER BY tablename;
"
```

期待テーブル:

```text
reservations
staff_blocks
practitioner_busy_ranges
outbox_events
audit_logs
customers
practitioners
menus
options
menu_options
settings
calendar_sync_states
calendar_sync_conflicts
```

成功判断:

- `psql` がエラーなく終了する。
- `\dt` と確認SQLで上記テーブルがすべて表示される。

## Step 2: GCP セットアップ

有効にするAPI:

- Cloud Run API
- Secret Manager API
- Artifact Registry API
- Cloud Scheduler API
- Google Calendar API

実行コマンド:

```bash
gcloud config set project "${GCP_PROJECT_ID}"

gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  calendar-json.googleapis.com \
  --project="${GCP_PROJECT_ID}"

gcloud iam service-accounts create reservation-system-api \
  --project="${GCP_PROJECT_ID}" \
  --display-name="Reservation System API"

gcloud projects add-iam-policy-binding "${GCP_PROJECT_ID}" \
  --member="serviceAccount:reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

Cloud SchedulerからCloud Runを認証つきで叩く場合は、Cloud Run service作成後にInvoker権限を付与する。

```bash
gcloud run services add-iam-policy-binding "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

確認コマンド:

```bash
gcloud services list \
  --project="${GCP_PROJECT_ID}" \
  --enabled \
  --filter="name:(run.googleapis.com OR secretmanager.googleapis.com OR artifactregistry.googleapis.com OR cloudscheduler.googleapis.com OR calendar-json.googleapis.com)"

gcloud iam service-accounts describe \
  "reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --project="${GCP_PROJECT_ID}"

gcloud projects get-iam-policy "${GCP_PROJECT_ID}" \
  --flatten="bindings[].members" \
  --filter="bindings.members:reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com AND bindings.role:roles/secretmanager.secretAccessor" \
  --format="table(bindings.role, bindings.members)"
```

成功判断:

- 5つのAPIが `ENABLED` で表示される。
- service accountが存在する。
- service accountに `roles/secretmanager.secretAccessor` が付与されている。
- Cloud Schedulerを使う場合は、Cloud Run serviceのIAMに `roles/run.invoker` が付与されている。

## Step 3: Secret Manager secrets 作成

secret名の命名規則:

```text
salon-<salon_id>-<種別>
```

作成するsecret:

- `salon-<salon_id>-database-url`
- `salon-<salon_id>-line-access-token`
- `salon-<salon_id>-scheduler-secret`

実行コマンド:

```bash
# DATABASE_URL（Neon接続文字列）
printf '%s' '<NEON_DATABASE_URL>' | gcloud secrets create "salon-${SALON_ID}-database-url" \
  --project="${GCP_PROJECT_ID}" \
  --data-file=-

# LINE_ACCESS_TOKEN
printf '%s' '<LINE_ACCESS_TOKEN>' | gcloud secrets create "salon-${SALON_ID}-line-access-token" \
  --project="${GCP_PROJECT_ID}" \
  --data-file=-

# SCHEDULER_SECRET（ランダム生成）
openssl rand -hex 32 | gcloud secrets create "salon-${SALON_ID}-scheduler-secret" \
  --project="${GCP_PROJECT_ID}" \
  --data-file=-
```

service accountへsecret単位のアクセス権を付与する。

```bash
for secret in database-url line-access-token scheduler-secret; do
  gcloud secrets add-iam-policy-binding "salon-${SALON_ID}-${secret}" \
    --project="${GCP_PROJECT_ID}" \
    --member="serviceAccount:reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

確認コマンド:

```bash
gcloud secrets list \
  --project="${GCP_PROJECT_ID}" \
  --filter="name:salon-${SALON_ID}"

for secret in database-url line-access-token scheduler-secret; do
  gcloud secrets get-iam-policy "salon-${SALON_ID}-${secret}" \
    --project="${GCP_PROJECT_ID}" \
    --flatten="bindings[].members" \
    --filter="bindings.members:reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com AND bindings.role:roles/secretmanager.secretAccessor" \
    --format="table(bindings.role, bindings.members)"
done
```

成功判断:

- 3つのsecretが表示される。
- 各secretに `reservation-system-api@<GCP_PROJECT_ID>.iam.gserviceaccount.com` の `roles/secretmanager.secretAccessor` が付与されている。
- secret値そのものは確認出力やドキュメントに表示しない。

## Step 4: Tenant Ledger YAML 登録

`tenants/example.salon.yaml` をコピーし、実サロン用の非機密情報だけを記入する。

実行コマンド:

```bash
cp tenants/example.salon.yaml "tenants/${SALON_ID}.salon.yaml"
```

埋めるべきフィールド:

| field | 意味 |
|---|---|
| `schema_version` | 台帳形式のバージョン。初期値は `1`。 |
| `salon_id` | サロン識別ID。ファイル名、Secret名、deploy対象に使う。 |
| `salon_name` | サロン名。機密にならない表記にする。 |
| `status` | 導入中は `setup`、本番稼働後は `active` にする。 |
| `plan` | 契約プランまたは導入区分。例: `pilot`。 |
| `contract_start_date` | 契約開始日。未確定なら `null`。 |
| `contract_end_date` | 契約終了日。未確定なら `null`。 |
| `owner_name` | 運用担当者名。公開または社内で扱える範囲だけを書く。 |
| `owner_contact_note` | 連絡方法の非機密メモ。個人連絡先の実値は避ける。 |
| `gcp_project_id` | Cloud Run、Secret Manager、GCSを置くGCP project ID。 |
| `cloud_run_service` | サロン別Cloud Run service名。 |
| `cloud_run_region` | Cloud Run region。通常は `asia-northeast1`。 |
| `cloud_run_service_account` | Cloud Run runtime service accountのメールアドレス。 |
| `service_url` | Cloud Run URL。初回deploy前は `null` または仮のURLにする。 |
| `database_provider` | DB provider。1件目は `neon`。 |
| `database_project_or_instance` | Neon project名など、管理画面上の非機密識別子。 |
| `database_name` | DB名。接続URLは書かない。 |
| `database_secret_name` | `DATABASE_URL` を保存したSecret Manager secret名。 |
| `line_channel_id` | LINE Login channel ID。 |
| `line_liff_id` | LIFF app ID。 |
| `line_access_token_secret_name` | `LINE_ACCESS_TOKEN` を保存したSecret Manager secret名。 |
| `scheduler_secret_name` | `SCHEDULER_SECRET` を保存したSecret Manager secret名。 |
| `google_calendar_mode` | Calendar運用方針。例: `per_practitioner`。 |
| `default_calendar_id` | デフォルトCalendar ID。施術者別設定がない場合のfallback。 |
| `practitioner_calendar_policy` | 施術者別Calendar IDをどこで管理するかの方針。 |
| `google_calendar_webhook_url` | Calendar push notification受信URL。 |
| `google_drive_folder_id` | 画像保存先Drive folder ID。使わない場合は `null`。 |
| `gcs_bucket_name` | 画像保存先GCS bucket名。 |
| `google_sheet_id` | 補助的に残すGoogle Sheet ID。正本にはしない。 |
| `theme_color` | サロンのメインテーマカラー。 |
| `theme_color_light` | 明るいテーマカラー。未確定なら `null`。 |
| `theme_color_dark` | 濃いテーマカラー。未確定なら `null`。 |
| `notes` | セットアップ状況などの非機密メモ。 |

注意事項:

- `database_secret_name`、`line_access_token_secret_name`、`scheduler_secret_name` にはSecret Managerのsecret名だけを書く。
- `DATABASE_URL`、`LINE_ACCESS_TOKEN`、`SCHEDULER_SECRET` の実値は書かない。
- `status: setup` で登録し、Smoke Test完了後に `status: active` へ変更する。

確認コマンド:

```bash
test -f "tenants/${SALON_ID}.salon.yaml"

scripts/deploy-cloud-run.sh \
  --salon-id "${SALON_ID}" \
  --tenant-file "tenants/${SALON_ID}.salon.yaml" \
  --image "${IMAGE_URI}" \
  --resolve-only

grep -E 'database_secret_name|line_access_token_secret_name|scheduler_secret_name|status:' "tenants/${SALON_ID}.salon.yaml"
```

成功判断:

- `tenants/<salon_id>.salon.yaml` が存在する。
- `--resolve-only` がエラーなく終了する。
- grep結果にsecret名と `status: setup` が表示され、secret値そのものは表示されない。

## Step 5: Cloud Run 初回デプロイ

Artifact Registry repositoryが未作成の場合は先に作る。

実行コマンド:

```bash
gcloud artifacts repositories create "${REPO}" \
  --project="${GCP_PROJECT_ID}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Reservation system images"
```

コンテナイメージをビルドし、Artifact Registryへpushする。

現行リポジトリのDockerfileは `backend/Dockerfile` なので、Cloud Buildのsourceは `backend` を指定する。
Cloud Build設定でリポジトリルートからbuildできる場合の形は `gcloud builds submit . --project=<GCP_PROJECT_ID> --tag=asia-northeast1-docker.pkg.dev/<GCP_PROJECT_ID>/<REPO>/<IMAGE>:<TAG>`。

```bash
gcloud builds submit backend \
  --project="${GCP_PROJECT_ID}" \
  --tag="${IMAGE_URI}"
```

設定解決だけを確認する。

```bash
scripts/deploy-cloud-run.sh \
  --salon-id "${SALON_ID}" \
  --tenant-file "tenants/${SALON_ID}.salon.yaml" \
  --image "${IMAGE_URI}" \
  --resolve-only
```

実行される `gcloud run deploy` コマンドを確認する。

```bash
scripts/deploy-cloud-run.sh \
  --salon-id "${SALON_ID}" \
  --tenant-file "tenants/${SALON_ID}.salon.yaml" \
  --image "${IMAGE_URI}" \
  --dry-run
```

dry-run出力例:

```text
Resolved Cloud Run deploy target: salon_id=example-salon, status=setup, service=reservation-example-salon, project=example-gcp-project, region=asia-northeast1
Resolved image: asia-northeast1-docker.pkg.dev/example-gcp-project/reservation-system/reservation-system-api:abc1234
Resolved Secret Manager names: DATABASE_URL=salon-example-salon-database-url, LINE_ACCESS_TOKEN=salon-example-salon-line-access-token, SCHEDULER_SECRET=salon-example-salon-scheduler-secret
Dry run: Cloud Run deploy command
gcloud run deploy reservation-example-salon --project example-gcp-project --image asia-northeast1-docker.pkg.dev/example-gcp-project/reservation-system/reservation-system-api:abc1234 --region asia-northeast1 --platform managed --allow-unauthenticated --service-account reservation-system-api@example-gcp-project.iam.gserviceaccount.com --set-env-vars '^|^GCP_PROJECT_ID=example-gcp-project|SERVICE_NAME=reservation-example-salon|SALON_ID=example-salon|TZ=Asia/Tokyo|LIFF_ID=0000000000-example|LINE_CHANNEL_ID=0000000000|GOOGLE_CALENDAR_WEBHOOK_URL=https://reservation-example-salon-example-an.a.run.app/api/webhooks/google-calendar|GCS_BUCKET_NAME=example-gcp-project-images|THEME_COLOR=#9b1c2c|THEME_COLOR_LIGHT=#b92b3d|THEME_COLOR_DARK=#7a1522' --set-secrets DATABASE_URL=salon-example-salon-database-url:latest --set-secrets LINE_ACCESS_TOKEN=salon-example-salon-line-access-token:latest --set-secrets SCHEDULER_SECRET=salon-example-salon-scheduler-secret:latest
```

実デプロイ:

```bash
scripts/deploy-cloud-run.sh \
  --salon-id "${SALON_ID}" \
  --tenant-file "tenants/${SALON_ID}.salon.yaml" \
  --image "${IMAGE_URI}"
```

確認コマンド:

```bash
gcloud artifacts docker images describe "${IMAGE_URI}" \
  --project="${GCP_PROJECT_ID}"

gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)')

curl -fsS "${SERVICE_URL}/health" | jq .
```

成功判断:

- Artifact Registryに `${IMAGE_URI}` が存在する。
- Cloud Run serviceの `Ready` conditionが `True` になっている。
- `/health` が `{"status":"ok"}` を返す。

## Step 6: LIFF / LINE 設定

LINE Developersコンソール: [https://developers.line.biz/console/](https://developers.line.biz/console/)

実行手順:

1. LINE Developersコンソールで対象Providerを開く。
2. LINE Login channelを作成または選択する。
3. `LIFF` タブでLIFFアプリを追加する。
4. Endpoint URLにCloud Runのroot URLを設定する。

Endpoint URL:

```text
https://<cloud-run-url>/
```

取得したLIFF IDとLINE Channel IDをCloud Runへ設定する。既存envを残すため `--update-env-vars` を使う。

実行コマンド:

```bash
gcloud run services update "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --update-env-vars "LIFF_ID=<LIFF_ID>,LINE_CHANNEL_ID=<LINE_CHANNEL_ID>"
```

確認コマンド:

```bash
gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format="table(spec.template.spec.containers[0].env.name, spec.template.spec.containers[0].env.value)"

SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)')

curl -fsS "${SERVICE_URL}/api/config" | jq .
```

成功判断:

- Cloud Runのenvに `LIFF_ID` と `LINE_CHANNEL_ID` が設定されている。
- `/api/config` の `liffId` が設定したLIFF IDになっている。
- LINE Developers側のLIFF Endpoint URLが `https://<cloud-run-url>/` になっている。

## Step 7: Google Calendar OAuth 設定

Google Calendar APIはStep 2で有効化済みであることを前提にする。

実行手順:

1. サロンオーナーのGoogleアカウントでGoogle Calendarを開く。
2. 施術者ごとのカレンダーを作成または選択する。
3. カレンダー設定の `Share with specific people or groups` で、service account `reservation-system-api@<GCP_PROJECT_ID>.iam.gserviceaccount.com` を追加する。
4. 権限は予定の作成、変更、削除ができる権限にする。
5. 施術者ごとの `calendar_id` をDBへ登録する。

実行コマンド:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO settings (key, value) VALUES
  ('google_calendar_id_practitioner_1', 'xxx@group.calendar.google.com')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
SQL
```

確認コマンド:

```bash
psql "$DATABASE_URL" -Atc "
SELECT key, value
FROM settings
WHERE key LIKE 'google_calendar_id_practitioner_%'
ORDER BY key;
"

ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account="reservation-system-api@${GCP_PROJECT_ID}.iam.gserviceaccount.com" \
  --scopes="https://www.googleapis.com/auth/calendar")

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://www.googleapis.com/calendar/v3/calendars/<CALENDAR_ID>" | jq .
```

成功判断:

- `settings` に `google_calendar_id_practitioner_*` が登録されている。
- Calendar APIの確認curlが対象CalendarのJSONを返す。
- 403が返る場合は、Calendar共有先のservice accountと権限を再確認する。

## Step 8: マスタデータ投入と Smoke Test

マスタデータを本番DBへ投入する。

実行コマンド:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/master_data.sql
```

確認コマンド:

```bash
psql "$DATABASE_URL" -Atc "
SELECT 'practitioners', count(*) FROM practitioners
UNION ALL
SELECT 'menus', count(*) FROM menus
UNION ALL
SELECT 'options', count(*) FROM options
UNION ALL
SELECT 'settings', count(*) FROM settings
ORDER BY 1;
"
```

成功判断:

- `practitioners`、`menus`、`options`、`settings` の件数が0より大きい。
- `master_data.sql` の再実行で `settings` は上書きされ、SQLエラーにならない。

Smoke testの実行コマンド:

```bash
BASE_URL=https://<cloud-run-url>

# ヘルスチェック
curl -fsS "$BASE_URL/health" | jq .
curl -fsS "$BASE_URL/api/config" | jq .

# マスタ確認
curl -fsS "$BASE_URL/api/practitioners" | jq .
curl -fsS "$BASE_URL/api/menus" | jq .

# 空き枠確認（日付は適宜変更）
curl -fsS "$BASE_URL/api/slots?date=2026-06-01" | jq .
```

期待レスポンス:

- `/health`: `{"status":"ok"}`。
- `/api/config`: `liffId` と `theme` を含むJSON。
- `/api/practitioners`: 施術者配列。初期seed適用後は1件以上。
- `/api/menus`: メニュー配列。初期seed適用後は1件以上。
- `/api/slots?date=2026-06-01`: 空き枠配列。現行APIで施術者指定が必須の場合は `{"error":"施術者を選択してください"}` が返るため、次の施術者指定つき確認を実行する。

施術者指定つき空き枠確認:

```bash
PRACTITIONER_ID=$(curl -fsS "$BASE_URL/api/practitioners" | jq -r '.[0].id')

curl -fsS "$BASE_URL/api/slots?date=2026-06-01&minutes=60&practitionerId=${PRACTITIONER_ID}" | jq .
```

成功判断:

- `PRACTITIONER_ID` が `null` や空文字ではない。
- 施術者指定つき `/api/slots` がJSON配列を返す。
- Cloud Run logsにDB接続エラー、Secret参照エラー、LINE/Calendar初期化エラーが出ていない。

追加のログ確認:

```bash
gcloud run services logs read "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --limit=100
```

## 完了条件

- `docs/runbooks/onboard-first-salon.md` が存在する。
- Step 1からStep 8までの手順が揃っている。
- 各ステップに実行コマンドと確認コマンドがある。
- `DATABASE_URL`、`LINE_ACCESS_TOKEN`、`SCHEDULER_SECRET` の実値がドキュメントに含まれていない。
- `node --check` が通る。
- 作業ブランチをpushし、Issue #27に完了コメントを残してcloseする。
