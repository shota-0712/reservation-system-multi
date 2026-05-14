# Tenant Ledger

このディレクトリは、サロンごとのCloud Run service、DB、LINE、LIFF、Google Calendar、契約状態を追うための軽量な台帳です。

1サロンにつき1つの `*.salon.yaml` を置きます。最初のサロンを登録するときは `example.salon.yaml` をコピーし、`tenants/<salon_id>.salon.yaml` として実サロン用の非機密項目だけを記入します。

## File Rules

- `salon_id` は小文字英数字とハイフンで、Cloud Run service名やSecret Manager secret名に使える値にする。
- 実サロン用ファイル名は `tenants/<salon_id>.salon.yaml` にする。
- `example.salon.yaml` はテンプレートであり、実デプロイ対象として扱わない。
- 未確定の値は実値らしいダミーではなく `null` または明示的なプレースホルダーにする。
- 契約終了後も台帳ファイルは削除せず、`status: closed` にして削除、停止、バックアップ状況を `notes` に残す。

## Status

| status | 意味 |
|---|---|
| `prospect` | 商談中。リソース作成前。 |
| `setup` | 新規導入作業中。Secret、DB、Cloud Run、LINE、LIFF、Calendarを準備している状態。 |
| `active` | 本番利用中。deploy対象にできる状態。 |
| `suspended` | 一時停止中。契約や運用上の理由で本番利用を止めている状態。 |
| `closed` | 契約終了。停止、バックアップ、削除方針を `notes` に残す。 |

## Required Fields

| field | 用途 |
|---|---|
| `schema_version` | 台帳形式のバージョン。初期版は `1`。 |
| `salon_id` | サロンを識別する安定ID。Secret名、deploy対象、ファイル名に使う。 |
| `salon_name` | サロン名。機密にならない表記にする。 |
| `status` | `prospect`, `setup`, `active`, `suspended`, `closed` のいずれか。 |
| `plan` | 契約プランや導入区分。例: `pilot`, `standard`。 |
| `contract_start_date` | 契約開始日。未確定なら `null`。 |
| `contract_end_date` | 契約終了日。未確定なら `null`。 |
| `owner_name` | 契約または運用上の担当者名。公開済みまたは社内で扱える範囲だけを書く。 |
| `owner_contact_note` | 連絡先そのものではなく、非機密の連絡メモだけを書く。 |
| `gcp_project_id` | サロンのCloud Run、Secret Manager、GCSを置くGCP project ID。 |
| `cloud_run_service` | サロン別Cloud Run service名。 |
| `cloud_run_region` | Cloud Run region。初期値は `asia-northeast1`。 |
| `cloud_run_service_account` | Cloud Run runtime service account。Secret単位の参照権限付与に使う。 |
| `service_url` | Cloud Run service URL。未作成なら `null`。 |
| `database_provider` | DB provider。現方針では `neon` を第一候補にする。 |
| `database_project_or_instance` | Neon project、Cloud SQL instanceなど、DB管理画面で識別できる非機密ID。 |
| `database_name` | DB名。接続URLそのものは書かない。 |
| `database_secret_name` | `DATABASE_URL` を格納するSecret Manager secret名。 |
| `line_channel_id` | LINE Login channel ID。非機密ID。 |
| `line_liff_id` | LIFF app ID。非機密ID。 |
| `line_access_token_secret_name` | `LINE_ACCESS_TOKEN` を格納するSecret Manager secret名。 |
| `scheduler_secret_name` | `SCHEDULER_SECRET` を格納するSecret Manager secret名。 |
| `google_calendar_mode` | Calendarの使い方。例: `single`, `per_practitioner`。 |
| `default_calendar_id` | デフォルトCalendar ID。施術者別Calendarがある場合はフォールバック用。 |
| `practitioner_calendar_policy` | 施術者別Calendar IDをどこで管理するかの方針。 |
| `google_drive_folder_id` | Google Drive画像保存先。使わない場合は `null`。 |
| `gcs_bucket_name` | GCS画像保存先bucket。使わない場合は `null`。 |
| `google_sheet_id` | 移行元、テンプレート、補助設定としてGoogle Sheetsを残す場合のID。予約データの正本にはしない。 |
| `theme_color` | サロンのメインテーマカラー。 |
| `theme_color_light` | サロンのホバー、補助UI向けテーマカラー。未確定なら `null`。 |
| `theme_color_dark` | サロンの濃色テーマカラー。未確定なら `null`。 |
| `notes` | セットアップ状況、停止、バックアップ、削除予定などの非機密メモ。 |

## Secret Policy

台帳にはSecret Managerのsecret名だけを書きます。値そのものは絶対に書きません。

台帳に書いてはいけない値:

- `DATABASE_URL` の実値
- LINE Messaging API access token
- Scheduler secretの実値
- Google service account JSON key
- OAuth refresh token
- 顧客情報、予約情報、LINE User ID
- 個人のメールアドレス、電話番号など公開前提ではない連絡先

Issue #15の方針に合わせ、Cloud Run deployでは次のSecret Manager secret名を参照します。

| 台帳field | Cloud Run env var | GitHub Repository Variable override |
|---|---|---|
| `database_secret_name` | `DATABASE_URL` | `DATABASE_URL_SECRET_NAME` |
| `line_access_token_secret_name` | `LINE_ACCESS_TOKEN` | `LINE_ACCESS_TOKEN_SECRET_NAME` |
| `scheduler_secret_name` | `SCHEDULER_SECRET` | `SCHEDULER_SECRET_SECRET_NAME` |

secret名は次の形式を推奨します。

```text
salon-<salon_id>-database-url
salon-<salon_id>-line-access-token
salon-<salon_id>-scheduler-secret
```

Cloud Run runtime service account には、参照するSecretごとに `roles/secretmanager.secretAccessor` を付与します。詳細は [../GITHUB_SECRETS.md](../GITHUB_SECRETS.md) を参照してください。

## New Salon Flow

1. `example.salon.yaml` を `tenants/<salon_id>.salon.yaml` にコピーする。
2. `status: setup` で非機密項目を記入する。
3. Secret Managerに `database_secret_name`, `line_access_token_secret_name`, `scheduler_secret_name` のsecretを作る。
4. Cloud Run runtime service accountへ、secret単位で `roles/secretmanager.secretAccessor` を付与する。
5. サロン別DB、Cloud Run service、LINE channel、LIFF app、Google Calendar、画像保存先を作る。
6. GitHub Actionsの `Deploy to Cloud Run` workflowを `workflow_dispatch` で起動し、`salon_id` に台帳ファイル名のIDを指定する。まずは `dry_run: true` で解決されるservice名、image名、Secret Manager secret名を確認する。
7. DB migration、予約作成、Calendar反映、LINE通知、Scheduler認証を確認する。
8. 動作確認後、`status: active` に変更する。

契約終了時は `status: closed` にし、Cloud Run停止、DB export、Secret無効化、Calendar/LINE/LIFF整理、データ保持期限を `notes` に残します。

## Deploy Use

Issue #17のサロン別Cloud Run deployでは、`.github/workflows/deploy.yml` の手動dispatchで `salon_id` を受け取り、`scripts/deploy-cloud-run.sh` が `tenants/<salon_id>.salon.yaml` を読みます。GitHub Repository VariablesまたはGitHub Environment Variablesに同名のdeploy用変数がある場合は、tenant YAMLより優先されます。

少なくとも次のfieldをdeploy入力として使えます。

- `salon_id`
- `status`
- `gcp_project_id`
- `cloud_run_service`
- `cloud_run_region`
- `cloud_run_service_account`
- `database_secret_name`
- `line_access_token_secret_name`
- `scheduler_secret_name`
- `line_channel_id`
- `line_liff_id`
- `google_drive_folder_id`
- `gcs_bucket_name`
- `google_sheet_id`
- `theme_color`
- `theme_color_light`
- `theme_color_dark`

Artifact Registryのimage pathはservice名から分離しています。既定では `${cloud_run_region}-docker.pkg.dev/${gcp_project_id}/reservation-system/reservation-system-api:${GITHUB_SHA}` を使い、`ARTIFACT_REGISTRY_REPOSITORY` と `IMAGE_NAME` で上書きできます。同じimageをbuild/pushして、`cloud_run_service` だけをサロン別に変えてdeployします。

初期運用は手動deployです。`status: active` のサロンだけを自動deploy対象にするか、`setup` も明示指定時だけdeploy対象にするか、複数サロンへのmatrix deployをいつ有効にするかは後続Issueで決めます。
