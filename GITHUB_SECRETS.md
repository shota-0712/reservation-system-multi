# Production Settings and GitHub Actions Secrets

このリポジトリの本番設定は、非機密設定と機密設定を分けて管理します。

- アプリの機密値は Google Secret Manager に保存し、Cloud Run では Secret Manager 参照の環境変数として渡す。
- GitHub Actions の Secrets には、Cloud Run deploy に必要な GCP 認証情報だけを置く。
- `GCP_PROJECT_ID` や `SERVICE_NAME` などの非機密設定はテナント台帳に置き、必要に応じて GitHub Repository Variables または GitHub Environment Variables で上書きする。
- ローカルの `.env` は開発用だけに使い、本番Secretを直書きしない。

## Current Workflow Mapping

`.github/workflows/deploy.yml` は `workflow_dispatch` で `salon_id`、`environment`、`dry_run` を受け取り、`tenants/<salon_id>.salon.yaml` を読んでdeploy対象を決めます。次の扱いを前提にしています。

通常の `main` push / pull request では `.github/workflows/ci.yml` だけを実行します。CIは `backend` の `npm ci`、JavaScript構文チェック、`npm test` に限定し、GCP Secrets / Variables やSecret Managerの事前作成を必要としません。

Cloud Run deployは `Deploy to Cloud Run` workflowを手動実行した時だけ走ります。`dry_run` の既定値は `true` なので、本番設定がそろう前でもtenant設定の解決とdeployコマンド確認に使えます。実deployする場合だけ `dry_run=false` を選び、下記のGitHub Secret / VariablesとSecret Manager secretを用意します。

手動deploy input:

| input | 必須 | 説明 |
|---|---:|---|
| `salon_id` | 必須 | `tenants/<salon_id>.salon.yaml` と一致するサロンID。 |
| `environment` | 必須 | deploy認証情報やVariablesを参照するGitHub Environment。既定は `production`。 |
| `dry_run` | 必須 | `true` では設定解決とコマンド表示だけを行い、GCP認証、image push、Cloud Run deployは行わない。 |

| 値 | 管理場所 | Cloud Runでの扱い | 備考 |
|---|---|---|---|
| `DATABASE_URL` | Secret Manager | `--set-secrets` | 本番DB接続URL。GitHub Secretsには置かない。 |
| `LINE_ACCESS_TOKEN` | Secret Manager | `--set-secrets` | LINE Messaging APIのチャネルアクセストークン。 |
| `SCHEDULER_SECRET` | Secret Manager | `--set-secrets` | Cloud Schedulerからのリクエスト認証用secret。 |
| `GCP_SA_KEY` | GitHub Secrets | deploy認証のみ | JSONキー方式を使う場合。将来的にWorkload Identity Federationへ移行する余地を残す。 |
| `GCP_PROJECT_ID` | Tenant YAML / GitHub Variables | 通常env / deploy設定 | Google CloudプロジェクトID。 |
| `REGION` | Tenant YAML / GitHub Variables | deploy設定 | 未設定時は `asia-northeast1`。 |
| `SERVICE_NAME` | Tenant YAML / GitHub Variables | 通常env / deploy設定 | Cloud Runサービス名。サイトタイトルにも使う。 |
| `ARTIFACT_REGISTRY_REPOSITORY` | GitHub Variables | build / deploy設定 | service名から分離した共通image repository。未設定時は `reservation-system`。 |
| `IMAGE_NAME` | GitHub Variables | build / deploy設定 | service名から分離した共通image名。未設定時は `reservation-system-api`。 |
| `CLOUD_RUN_SERVICE_ACCOUNT` | Tenant YAML / GitHub Variables | deploy設定 | 未設定時は `reservation-system-api@<project>.iam.gserviceaccount.com`。 |
| `LIFF_ID` | Tenant YAML / GitHub Variables | 通常env | LIFFアプリID。 |
| `LINE_CHANNEL_ID` | Tenant YAML / GitHub Variables | 通常env | LIFF ID token検証に使うLINE LoginチャネルID。 |
| `GOOGLE_SHEET_ID` | Tenant YAML / GitHub Variables | 通常env | DB正本後は予約データの正本ではない。残す場合は移行元、テンプレート、補助設定など用途を明確にする。 |
| `GOOGLE_DRIVE_FOLDER_ID` | Tenant YAML / GitHub Variables | 通常env | メニュー画像保存先フォルダID。アクセス制御はCloud Run service account側で行う。 |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | Tenant YAML / GitHub Variables | 通常env | Google Calendar push notification受信URL。例: `https://<service-url>/api/webhooks/google-calendar`。 |
| `GCS_BUCKET_NAME` | Tenant YAML / GitHub Variables | 通常env | GCS画像保存先bucket。未設定時は `<project>-images`。 |
| `ADMIN_LINE_ID` | GitHub Variables | 通常env | 管理者LINE User ID。カンマ区切りで複数指定できる。 |
| `THEME_COLOR` | Tenant YAML / GitHub Variables | 通常env | 任意。未設定時はアプリ既定値。 |
| `THEME_COLOR_LIGHT` | Tenant YAML / GitHub Variables | 通常env | 任意。未設定時はアプリ既定値。 |
| `THEME_COLOR_DARK` | Tenant YAML / GitHub Variables | 通常env | 任意。未設定時はアプリ既定値。 |

`GOOGLE_APPLICATION_CREDENTIALS` は本番Cloud Runでは設定しません。Cloud Run runtime service account の Application Default Credentials を使います。ローカル開発でサービスアカウントJSONを使う場合だけ `.env` にファイルパスを設定します。

## GitHub Secrets

GitHub Secrets に残す値は、deploy実行に必要なGCP認証情報だけです。

| Secret名 | 必須 | 説明 |
|---|---:|---|
| `GCP_SA_KEY` | JSONキー方式では必須 | `google-github-actions/auth` の `credentials_json` に渡すサービスアカウントJSON全文。 |

`DATABASE_URL`、`LINE_ACCESS_TOKEN`、`SCHEDULER_SECRET` はGitHub Secretsに置かず、Secret Managerで管理します。

将来的に Workload Identity Federation に移行する場合は、`GCP_SA_KEY` を廃止し、GitHub Actions OIDC用の provider と deploy service account を `google-github-actions/auth` に設定します。このIssueではWIFへの完全移行は行いません。

## GitHub Repository Variables

Settings -> Secrets and variables -> Actions -> Variables に設定します。サロン別の非機密値は `tenants/<salon_id>.salon.yaml` を正とし、ここでは全サロン共通値または一時的な上書きだけを置きます。GitHub Environment Variablesを使う場合も同じ名前にします。

| Variable名 | 必須 | 説明 | 例 |
|---|---:|---|---|
| `GCP_PROJECT_ID` | tenant YAMLにない場合は必須 | Google CloudプロジェクトID | `my-project-123456` |
| `SERVICE_NAME` | tenant YAMLにない場合は必須 | Cloud Runサービス名 | `reservation-salon-a` |
| `REGION` | 任意 | Cloud Run / Artifact Registryのリージョン | `asia-northeast1` |
| `ARTIFACT_REGISTRY_REPOSITORY` | 任意 | 共通imageを置くArtifact Registry repository | `reservation-system` |
| `IMAGE_NAME` | 任意 | 共通image名 | `reservation-system-api` |
| `CLOUD_RUN_SERVICE_ACCOUNT` | 任意 | Cloud Run runtime service account | `reservation-system-api@my-project-123456.iam.gserviceaccount.com` |
| `DATABASE_URL_SECRET_NAME` | 任意 | `DATABASE_URL` に割り当てるSecret Manager secret名 | `salon-salon-a-database-url` |
| `LINE_ACCESS_TOKEN_SECRET_NAME` | 任意 | `LINE_ACCESS_TOKEN` に割り当てるSecret Manager secret名 | `salon-salon-a-line-access-token` |
| `SCHEDULER_SECRET_SECRET_NAME` | 任意 | `SCHEDULER_SECRET` に割り当てるSecret Manager secret名 | `salon-salon-a-scheduler-secret` |
| `LIFF_ID` | tenant YAMLにない場合は必須 | LIFFアプリID | `1234567890-abcdefgh` |
| `LINE_CHANNEL_ID` | tenant YAMLにない場合は必須 | LINE LoginチャネルID | `1234567890` |
| `GOOGLE_SHEET_ID` | 移行状況による | Google Sheetsを補助用途で残す場合のシートID | `1ABC...xyz` |
| `GOOGLE_DRIVE_FOLDER_ID` | 画像保存を使う場合は必須 | メニュー画像保存先フォルダID | `1ABC...xyz` |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | Calendar watchを使う場合は必須 | Google Calendar push notification受信URL | `https://reservation-salon-a-xxx-an.a.run.app/api/webhooks/google-calendar` |
| `GCS_BUCKET_NAME` | GCS画像保存を使う場合は必須 | GCS画像保存先bucket | `my-project-123456-images` |
| `ADMIN_LINE_ID` | 管理者機能を使う場合は必須 | 管理者のLINE User ID。複数はカンマ区切り。 | `Uxxxxx,Uyyyyy` |
| `THEME_COLOR` | 任意 | メインカラー | `#9b1c2c` |
| `THEME_COLOR_LIGHT` | 任意 | ホバー時カラー | `#b92b3d` |
| `THEME_COLOR_DARK` | 任意 | ダークカラー | `#7a1522` |

Secret名のVariableを省略した場合、workflowはtenant YAMLの `database_secret_name`、`line_access_token_secret_name`、`scheduler_secret_name` を参照します。tenant YAMLにもない場合は次の命名を既定値として使います。

- `salon-<salon_id>-database-url`
- `salon-<salon_id>-line-access-token`
- `salon-<salon_id>-scheduler-secret`

## Secret Manager

本番で必要なSecret Manager secretは次の3つです。

| Cloud Run env var | Secret Manager secret名の例 | 値 |
|---|---|---|
| `DATABASE_URL` | `salon-<salon_id>-database-url` | NeonなどのPostgreSQL接続URL |
| `LINE_ACCESS_TOKEN` | `salon-<salon_id>-line-access-token` | LINE Messaging APIチャネルアクセストークン |
| `SCHEDULER_SECRET` | `salon-<salon_id>-scheduler-secret` | Cloud Scheduler認証用のランダム文字列 |

secret作成例:

```sh
export GCP_PROJECT_ID=my-project-123456
export DATABASE_URL_SECRET_NAME=salon-salon-a-database-url
export LINE_ACCESS_TOKEN_SECRET_NAME=salon-salon-a-line-access-token
export SCHEDULER_SECRET_SECRET_NAME=salon-salon-a-scheduler-secret

gcloud secrets create "$DATABASE_URL_SECRET_NAME" --project "$GCP_PROJECT_ID" --replication-policy automatic
gcloud secrets create "$LINE_ACCESS_TOKEN_SECRET_NAME" --project "$GCP_PROJECT_ID" --replication-policy automatic
gcloud secrets create "$SCHEDULER_SECRET_SECRET_NAME" --project "$GCP_PROJECT_ID" --replication-policy automatic

printf '%s' "$DATABASE_URL" | gcloud secrets versions add "$DATABASE_URL_SECRET_NAME" --project "$GCP_PROJECT_ID" --data-file=-
printf '%s' "$LINE_ACCESS_TOKEN" | gcloud secrets versions add "$LINE_ACCESS_TOKEN_SECRET_NAME" --project "$GCP_PROJECT_ID" --data-file=-
printf '%s' "$SCHEDULER_SECRET" | gcloud secrets versions add "$SCHEDULER_SECRET_SECRET_NAME" --project "$GCP_PROJECT_ID" --data-file=-
```

## Cloud Run Secret Access

Cloud Run runtime service account に、参照するSecretごとの `roles/secretmanager.secretAccessor` を付与します。プロジェクト全体ではなくsecret単位に付与するのを基本にします。

```sh
export GCP_PROJECT_ID=my-project-123456
export CLOUD_RUN_SERVICE_ACCOUNT=reservation-system-api@my-project-123456.iam.gserviceaccount.com
export DATABASE_URL_SECRET_NAME=salon-salon-a-database-url
export LINE_ACCESS_TOKEN_SECRET_NAME=salon-salon-a-line-access-token
export SCHEDULER_SECRET_SECRET_NAME=salon-salon-a-scheduler-secret

for SECRET_NAME in \
  "$DATABASE_URL_SECRET_NAME" \
  "$LINE_ACCESS_TOKEN_SECRET_NAME" \
  "$SCHEDULER_SECRET_SECRET_NAME"
do
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --project "$GCP_PROJECT_ID" \
    --member "serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" \
    --role roles/secretmanager.secretAccessor
done
```

Cloud Run deployでは、機密値を `--set-env-vars` で直接渡さず、次のようにSecret Manager参照で渡します。

```sh
gcloud run deploy "$SERVICE_NAME" \
  --set-secrets "DATABASE_URL=${DATABASE_URL_SECRET_NAME}:latest" \
  --set-secrets "LINE_ACCESS_TOKEN=${LINE_ACCESS_TOKEN_SECRET_NAME}:latest" \
  --set-secrets "SCHEDULER_SECRET=${SCHEDULER_SECRET_SECRET_NAME}:latest"
```
