---
description: 新規サロンを本番環境に導入します。使い方: /onboard-salon <salon_id>
---

あなたは新規サロンを本番環境へ導入するオンボーディング担当です。`$ARGUMENTS` に `salon_id` が渡されます。各フェーズでは「実行すること」と「確認すること」を明示し、機密値をファイルやログに残さないでください。

## フェーズ 0: 入力確認

実行すること:

```bash
if [ -z "$ARGUMENTS" ]; then
  echo "❌ salon_id を指定してください。使い方: /onboard-salon <salon_id>"
  exit 1
fi

SALON_ID="$ARGUMENTS"
TENANT_FILE="tenants/$SALON_ID.salon.yaml"

if [ ! -f "$TENANT_FILE" ]; then
  cat <<EOF
⚠️  tenants/$SALON_ID.salon.yaml が見つかりません。
以下のコマンドでテンプレートからコピーして、各フィールドを埋めてください:

  cp tenants/example.salon.yaml tenants/$SALON_ID.salon.yaml

ファイルを作成・編集したら、再度 /onboard-salon $SALON_ID を実行してください。
EOF
  exit 1
fi

echo "tenant YAML を確認してください:"
cat "$TENANT_FILE"
```

確認すること:

- `SALON_ID=$ARGUMENTS` として以降のフェーズで使う。
- `tenants/$SALON_ID.salon.yaml` が存在する。
- tenant YAML の内容を表示し、ユーザーに続行してよいか確認する。明示的な了承がない場合は次のフェーズへ進まない。

## フェーズ 1: Neon DB セットアップ（手動ステップ）

実行すること:

Neon プロジェクト作成や接続文字列の取得は実行せず、以下を表示する。

```text
📋 Step 1: Neon DB セットアップ（手動）

1. https://console.neon.tech でプロジェクトを作成してください
   - プロジェクト名: $SALON_ID
   - リージョン: ap-southeast-1（推奨）

2. 接続文字列（DATABASE_URL）を取得したら Secret Manager に登録します:

   echo -n "postgresql://..." | gcloud secrets create salon-$SALON_ID-database-url \
     --project=<GCP_PROJECT_ID> --data-file=-

3. DATABASE_URL を環境変数にセットしてください:

   export DATABASE_URL=$(gcloud secrets versions access latest \
     --secret="salon-$SALON_ID-database-url" \
     --project=<GCP_PROJECT_ID>)

準備ができたら次のステップで migration を適用します。
DATABASE_URL が設定されているか確認します...
```

その後、`DATABASE_URL` だけを確認する。

```bash
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL が設定されていません"
  exit 1
fi
```

確認すること:

- Neon DB の作成や Secret Manager への登録は手動ステップとして扱い、代行実行しない。
- `DATABASE_URL` が設定されていない場合は終了する。
- `DATABASE_URL` の値そのものは表示しない。

## フェーズ 2: DB migration 適用

実行すること:

`DATABASE_URL` が設定されている前提で、migration ファイルをファイル名順に適用する。

```bash
for f in db/migrations/*.sql; do
  echo "Applying $f ..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

適用後に確認クエリを実行する。

```bash
psql "$DATABASE_URL" -Atc "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
```

不足テーブルを検出する。

```bash
expected_tables=(
  audit_logs
  calendar_sync_conflicts
  calendar_sync_states
  customers
  menus
  menu_options
  options
  outbox_events
  practitioner_busy_ranges
  practitioners
  reservations
  settings
  staff_blocks
)

missing_tables=()
for table in "${expected_tables[@]}"; do
  exists=$(psql "$DATABASE_URL" -Atc "SELECT to_regclass('public.${table}') IS NOT NULL;")
  if [ "$exists" != "t" ]; then
    missing_tables+=("$table")
  fi
done

if [ "${#missing_tables[@]}" -gt 0 ]; then
  echo "❌ 不足テーブルがあります: ${missing_tables[*]}"
  exit 1
fi
```

確認すること:

- `db/migrations/*.sql` が `001_initial_schema.sql`, `002_master_tables.sql`, `003_calendar_sync_schema.sql`, `004_calendar_webhook_sync_request.sql` の順に適用される。
- `audit_logs`, `calendar_sync_conflicts`, `calendar_sync_states`, `customers`, `menus`, `menu_options`, `options`, `outbox_events`, `practitioner_busy_ranges`, `practitioners`, `reservations`, `settings`, `staff_blocks` が全て存在する。
- 不足テーブルがあればエラーを表示して終了する。

## フェーズ 3: GCP Secrets 確認

実行すること:

tenant YAML から `gcp_project_id` を読み取り、3つの secret が存在するか確認する。

```bash
GCP_PROJECT_ID=$(awk -F': *' '$1 == "gcp_project_id" {print $2; exit}' "$TENANT_FILE" | sed -e 's/^"//' -e 's/"$//')

if [ -z "$GCP_PROJECT_ID" ]; then
  echo "❌ tenants/$SALON_ID.salon.yaml に gcp_project_id が設定されていません"
  exit 1
fi

missing_secrets=()
for secret in \
  "salon-$SALON_ID-database-url" \
  "salon-$SALON_ID-line-access-token" \
  "salon-$SALON_ID-scheduler-secret"; do
  if gcloud secrets describe "$secret" --project="$GCP_PROJECT_ID" > /dev/null 2>&1; then
    echo "✅ $secret"
  else
    echo "❌ $secret が見つかりません"
    missing_secrets+=("$secret")
  fi
done

if [ "${#missing_secrets[@]}" -gt 0 ]; then
  cat <<EOF

未作成の secret があります。以下の例を使って作成してください:

  echo -n "postgresql://..." | gcloud secrets create salon-$SALON_ID-database-url \\
    --project=$GCP_PROJECT_ID --data-file=-

  echo -n "<LINE_ACCESS_TOKEN>" | gcloud secrets create salon-$SALON_ID-line-access-token \\
    --project=$GCP_PROJECT_ID --data-file=-

  openssl rand -hex 32 | gcloud secrets create salon-$SALON_ID-scheduler-secret \\
    --project=$GCP_PROJECT_ID --data-file=-

作成後、再度 /onboard-salon $SALON_ID を実行してください。
EOF
  exit 1
fi
```

確認すること:

- `gcp_project_id` が tenant YAML から読み取れる。
- `salon-$SALON_ID-database-url`, `salon-$SALON_ID-line-access-token`, `salon-$SALON_ID-scheduler-secret` が存在する。
- 未作成の secret がある場合は作成コマンドを表示して終了する。

## フェーズ 4: LINE / Google Calendar セットアップ（手動ステップ）

実行すること:

以下を表示して、ユーザーが完了またはスキップを明言するまで次へ進まない。

```text
📋 Step 4: LINE / Google Calendar セットアップ（手動）

【LINE LIFF 登録】
1. https://developers.line.biz で LIFF アプリを追加
2. Endpoint URL: https://<cloud-run-url>/
3. 取得した LIFF ID を tenants/$SALON_ID.salon.yaml の line_liff_id に記入

【Google Calendar 共有設定】
1. 施術者ごとのカレンダーを以下の service account に共有:
   reservation-system-api@<GCP_PROJECT_ID>.iam.gserviceaccount.com
2. 権限: 予定の変更

完了したら Enter を押してください（または次のステップをスキップします）
```

確認すること:

- LIFF の Endpoint URL はデプロイ後の Cloud Run URL に合わせて後から更新できることを伝える。
- Google Calendar は `reservation-system-api@<GCP_PROJECT_ID>.iam.gserviceaccount.com` に共有される。
- このフェーズは手動ステップとして扱い、ユーザーの確認なしに先へ進まない。

## フェーズ 5: Cloud Run deploy

実行すること:

tenant YAML からパラメータを読み取る。`IMAGE_URI` が未設定の場合は作成方法を表示して終了する。

```bash
SERVICE_NAME=$(awk -F': *' '$1 == "cloud_run_service" {print $2; exit}' "$TENANT_FILE" | sed -e 's/^"//' -e 's/"$//')
REGION=$(awk -F': *' '$1 == "cloud_run_region" {print $2; exit}' "$TENANT_FILE" | sed -e 's/^"//' -e 's/"$//')
REGION=${REGION:-asia-northeast1}

if [ -z "${IMAGE_URI:-}" ]; then
  cat <<EOF
❌ IMAGE_URI が設定されていません。
コンテナイメージを build/push してから、例のように IMAGE_URI を設定してください:

  export IMAGE_URI="${REGION}-docker.pkg.dev/$GCP_PROJECT_ID/reservation-system/reservation-system-api:$(git rev-parse --short HEAD)"

EOF
  exit 1
fi
```

まず設定解決だけを確認する。

```bash
scripts/deploy-cloud-run.sh \
  --salon-id "$SALON_ID" \
  --tenant-file "tenants/$SALON_ID.salon.yaml" \
  --image "$IMAGE_URI" \
  --resolve-only
```

resolve-only の結果を表示してユーザーに確認を促す。

```text
上記の設定で Cloud Run にデプロイします。よろしいですか？ (y/N)
```

ユーザーが `y` または `yes` で了承した場合だけ dry-run と実デプロイを実行する。

```bash
scripts/deploy-cloud-run.sh \
  --salon-id "$SALON_ID" \
  --tenant-file "tenants/$SALON_ID.salon.yaml" \
  --image "$IMAGE_URI" \
  --dry-run

scripts/deploy-cloud-run.sh \
  --salon-id "$SALON_ID" \
  --tenant-file "tenants/$SALON_ID.salon.yaml" \
  --image "$IMAGE_URI"
```

デプロイ後に Cloud Run の URL を取得して表示する。

```bash
CLOUD_RUN_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --project="$GCP_PROJECT_ID" \
  --region="$REGION" \
  --format="value(status.url)")

echo "$CLOUD_RUN_URL"
```

確認すること:

- `scripts/deploy-cloud-run.sh` の `--salon-id`, `--tenant-file`, `--image`, `--resolve-only`, `--dry-run` を使う。
- resolve-only の内容をユーザーが確認している。
- dry-run で出る `gcloud run deploy` コマンドに想定した project, region, service, image, secret が入っている。
- 実デプロイ後に Cloud Run URL が取得できる。

## フェーズ 6: マスタデータ投入

実行すること:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seeds/master_data.sql
```

投入後の確認クエリを実行する。

```bash
psql "$DATABASE_URL" -Atc "SELECT COUNT(*) FROM practitioners;"
psql "$DATABASE_URL" -Atc "SELECT COUNT(*) FROM menus;"
```

確認すること:

- `db/seeds/master_data.sql` がエラーなく完了する。
- `practitioners` と `menus` の件数がどちらも 1 以上である。
- 件数が 0 の場合はエラーを表示して終了する。

## フェーズ 7: Smoke test

実行すること:

フェーズ 5 で取得した Cloud Run URL を使って確認する。

```bash
BASE_URL="$CLOUD_RUN_URL"

curl -fsS "$BASE_URL/api/config" | jq .
curl -fsS "$BASE_URL/api/practitioners" | jq 'length'
curl -fsS "$BASE_URL/api/menus" | jq 'length'
```

全て成功した場合は以下を表示する。

```text
✅ Smoke test PASS

🎉 $SALON_ID のオンボーディングが完了しました！

次のステップ:
- docs/qa/acceptance-test-checklist.md で受け入れテストを実施
- docs/runbooks/verify-calendar-sync.md で Calendar 同期を検証
- tenants/$SALON_ID.salon.yaml の status を active に更新
```

確認すること:

- `/api/config` が JSON を返す。
- `/api/practitioners` と `/api/menus` が JSON 配列を返し、件数が 1 以上である。
- 成功時だけ `✅ Smoke test PASS` と完了メッセージを表示する。
