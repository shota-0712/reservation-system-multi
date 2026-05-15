# Calendar 同期 E2E 検証手順

この手順書は、Google Calendar の watch channel 登録、webhook 受信、syncToken 差分同期、`staff_blocks` 取り込み、衝突記録、watch channel 更新を本番相当環境で E2E 検証するためのランブックです。

参照実装:

- `backend/routes/api.js`: `/api/webhooks/google-calendar`、`/api/batch/calendar-sync`、`/api/batch/calendar-watch/refresh`
- `backend/services/calendarSync.js`: syncToken による差分同期、`reservation_system` イベントの除外
- `backend/services/calendarWatch.js`: watch channel 登録・更新、`GOOGLE_CALENDAR_WEBHOOK_URL`
- `backend/services/calendarStaffBlockImport.js`: Google Calendar イベントから `staff_blocks` への取り込み、衝突記録
- `backend/repositories/calendarSyncStates.js`: `channel_id`、`channel_token`、`sync_token`、`watch_expires_at` 管理
- `backend/repositories/calendarSyncConflicts.js`: `calendar_sync_conflicts` への未解決衝突記録
- `db/migrations/003_calendar_sync_schema.sql`: `calendar_sync_states`、`calendar_sync_conflicts`
- `db/migrations/004_calendar_webhook_sync_request.sql`: webhook 受信後の `sync_requested_at`

前提:

- `<GCP_PROJECT_ID>`、`<SERVICE_NAME>`、`<REGION>`、`<CLOUD_RUN_URL>`、`<SCHEDULER_SECRET>`、`<DATABASE_URL>` は実環境の値に置き換える。
- `REGION` は通常 `asia-northeast1` を使う。
- `SCHEDULER_SECRET` はリポジトリやこのドキュメントに書かず、shell、Secret Manager、管理コンソール内だけで扱う。
- バッチ API は request body ではなく `x-scheduler-secret` ヘッダーで認証する。
- webhook は受信時点では同期処理を直接実行せず、`calendar_sync_states.sync_requested_at` を更新する。取り込み確認前に `/api/batch/calendar-sync` を実行する。

共通変数の例:

```bash
export GCP_PROJECT_ID=<GCP_PROJECT_ID>
export SERVICE_NAME=<SERVICE_NAME>
export REGION=asia-northeast1
export CLOUD_RUN_URL=<CLOUD_RUN_URL>
export DATABASE_URL='<DATABASE_URL>'
export SCHEDULER_SECRET='<SCHEDULER_SECRET>'
```

`CLOUD_RUN_URL` は次のコマンドでも取得できる。

```bash
export CLOUD_RUN_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)')
```

## Step 1: 前提確認

実行手順:

1. Google Calendar API が有効であることを確認する。

```bash
gcloud services list \
  --project="${GCP_PROJECT_ID}" \
  --enabled \
  --filter="name:(calendar-json.googleapis.com OR calendar.googleapis.com)"
```

2. Cloud Run が使う service account を確認する。

```bash
gcloud iam service-accounts list \
  --project="${GCP_PROJECT_ID}"

gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(spec.template.spec.serviceAccountName)'
```

3. サロンオーナーの Google アカウントで、施術者ごとの Calendar が Cloud Run service account に共有されていることを確認する。`staff_blocks` 取り込みだけの検証なら「閲覧権限」以上、予約イベント作成まで含む運用検証なら「予定の変更権限」を付与する。

4. Cloud Run の公開 URL と webhook 用環境変数を確認する。

```bash
gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(status.url)'

gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(spec.template.spec.containers[0].env)'
```

5. Cloud Run が Google の push 通知を受けられる設定か確認する。

```bash
gcloud run services get-iam-policy "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --flatten='bindings[].members' \
  --filter='bindings.members:allUsers AND bindings.role:roles/run.invoker' \
  --format='table(bindings.role, bindings.members)'
```

6. DB スキーマと watch 対象データを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT COUNT(*) FROM calendar_sync_states;
SELECT COUNT(*) FROM calendar_sync_conflicts;

SELECT p.id AS practitioner_id,
       p.name,
       p.calendar_id AS practitioner_calendar_id,
       css.id AS calendar_sync_state_id,
       css.calendar_id AS sync_calendar_id
FROM practitioners p
LEFT JOIN calendar_sync_states css
  ON css.practitioner_id = p.id
 AND css.calendar_id = p.calendar_id
WHERE p.is_active = true
  AND p.calendar_id IS NOT NULL
  AND btrim(p.calendar_id) <> ''
ORDER BY p.sort_order, p.id;
SQL
```

`calendar_sync_states` に対象行がない場合、watch 登録バッチは対象を拾えない。E2E 検証用に既存の施術者 Calendar を同期対象へ登録する場合は、次の SQL を実行する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO calendar_sync_states (practitioner_id, calendar_id)
SELECT id, calendar_id
FROM practitioners
WHERE is_active = true
  AND calendar_id IS NOT NULL
  AND btrim(calendar_id) <> ''
ON CONFLICT (practitioner_id, calendar_id) DO NOTHING;
SQL
```

成功の判断基準:

- Google Calendar API が `ENABLED` として表示される。
- Cloud Run の URL が `https://` で取得できる。
- `GOOGLE_CALENDAR_WEBHOOK_URL` が `${CLOUD_RUN_URL}/api/webhooks/google-calendar` を指している。
- Cloud Run が webhook 用に外部から到達可能である。
- `calendar_sync_states` と `calendar_sync_conflicts` が存在し、対象施術者の `calendar_sync_states` 行がある。
- service account が対象 Calendar を Calendar API で参照できる。

失敗時の判断・確認ポイント:

- API 一覧に Calendar API が出ない場合は `gcloud services enable calendar-json.googleapis.com --project="${GCP_PROJECT_ID}"` を実行する。
- `calendar_sync_states` の対象行が 0 件の場合、Step 2 の結果は `checked_count: 0` になり watch は登録されない。
- Cloud Run が未公開の場合、Google Calendar push 通知は webhook に到達しない。
- `GOOGLE_CALENDAR_WEBHOOK_URL` が未設定の場合、watch 登録は `GOOGLE_CALENDAR_WEBHOOK_URL is required` で失敗する。

## Step 2: watch channel 登録

実行手順:

1. watch channel 登録バッチを手動実行する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-watch/refresh" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

2. channel 情報が DB に保存されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       channel_id,
       channel_resource_id,
       watch_expires_at,
       sync_token,
       sync_requested_at,
       last_error,
       updated_at
FROM calendar_sync_states
ORDER BY updated_at DESC
LIMIT 5;
SQL
```

3. 初回フルシンクを完了させる。watch 登録時に `sync_token` が空の行は `sync_requested_at` が設定されるため、同期バッチを実行する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

4. `sync_token` が保存されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       channel_id,
       watch_expires_at,
       sync_token IS NOT NULL AS has_sync_token,
       last_full_sync_at,
       last_synced_at,
       sync_requested_at,
       last_error
FROM calendar_sync_states
ORDER BY updated_at DESC
LIMIT 5;
SQL
```

成功の判断基準:

- watch 登録 API が HTTP 200 を返し、JSON の `failed_count` が `0` である。
- `channel_id` が UUID 形式で入っている。
- `channel_resource_id` が空ではない。
- `watch_expires_at` が現在時刻から約 6 日後である。
- 初回同期後に `has_sync_token` が `true`、`last_full_sync_at` と `last_synced_at` が直近、`sync_requested_at` が `NULL` である。
- `last_error` が `NULL` である。

失敗時の判断・確認ポイント:

- HTTP 403 の場合は `x-scheduler-secret` ヘッダーと Cloud Run の `SCHEDULER_SECRET` を確認する。
- `failed_count` が 1 以上の場合は Cloud Run ログで `[CalendarWatch]` のエラーを確認する。
- `channel_id` が空の場合は、service account の Calendar 共有権限と `calendar_sync_states.calendar_id` を確認する。
- `sync_token` が空のままの場合は `/api/batch/calendar-sync` の結果と `[CalendarSync]` のエラーを確認する。

## Step 3: テストイベント作成と webhook 受信確認

実行手順:

1. Step 2 で watch を登録した施術者 Calendar に Google Calendar GUI からテストイベントを作成する。

```text
タイトル例: テスト休憩
時間: 30 分程度
注意: extendedProperties は手動設定しない
```

2. Cloud Run ログで webhook 受信を確認する。

```bash
gcloud run services logs read "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --limit=50
```

3. webhook により同期要求が記録されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       last_notification_at,
       last_notification_state,
       last_notification_message_number,
       sync_requested_at,
       sync_token,
       updated_at
FROM calendar_sync_states
ORDER BY updated_at DESC
LIMIT 5;
SQL
```

4. webhook 後の差分同期を手動実行する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

5. `sync_token` と同期時刻が更新されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       sync_token,
       last_synced_at,
       sync_requested_at,
       updated_at
FROM calendar_sync_states
ORDER BY updated_at DESC
LIMIT 5;
SQL
```

成功の判断基準:

- Cloud Run ログに `POST /api/webhooks/google-calendar` が残る。
- webhook は検証済み通知なら HTTP 202、想定外の `x-goog-resource-state` を無視した場合のみ HTTP 200 になる。
- `last_notification_at` が直近、`last_notification_state` が `sync`、`exists`、`not_exists` のいずれかである。
- webhook 受信後に `sync_requested_at` が入る。
- `/api/batch/calendar-sync` 実行後、`sync_token` がイベント作成前から変わり、`last_synced_at` が直近になり、`sync_requested_at` が `NULL` になる。

失敗時の判断・確認ポイント:

- webhook ログがない場合は、Step 2 の `channel_id`、`channel_resource_id`、`watch_expires_at`、Cloud Run 公開設定を確認する。
- webhook が 400 の場合は Google から必要な `x-goog-*` ヘッダーが届いていない。
- webhook が 403 の場合は `channel_resource_id` または `channel_token` の照合に失敗している。
- webhook は来ているのに `sync_token` が変わらない場合は、`/api/batch/calendar-sync` の実行結果と `last_error` を確認する。

## Step 4: staff_blocks 取り込み確認

実行手順:

1. Step 3 で作成したイベントが `staff_blocks` に取り込まれていることを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id,
       practitioner_id,
       calendar_id,
       start_at,
       end_at,
       external_event_id,
       external_event_etag,
       external_event_updated_at,
       source,
       status,
       created_at,
       updated_at
FROM staff_blocks
WHERE source = 'google_calendar'
ORDER BY created_at DESC
LIMIT 5;
SQL
```

2. 冪等性を確認する。Step 3 のイベントを Google Calendar GUI で編集し、webhook 受信後に同期バッチを再実行する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

3. 同じ `external_event_id` が重複していないことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT calendar_id, external_event_id, COUNT(*)
FROM staff_blocks
WHERE source = 'google_calendar'
GROUP BY calendar_id, external_event_id
HAVING COUNT(*) > 1;
SQL
```

4. システム作成イベントが除外されることを確認する。まず予約に紐づく Google Calendar イベント ID を確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id, practitioner_id, calendar_event_id
FROM reservations
WHERE calendar_event_id IS NOT NULL
LIMIT 1;
SQL
```

5. 対象イベントの `extendedProperties.private.source = reservation_system` を Calendar API で確認する。

```bash
ACCESS_TOKEN=$(gcloud auth print-access-token \
  --impersonate-service-account="$(gcloud run services describe "${SERVICE_NAME}" \
    --project="${GCP_PROJECT_ID}" \
    --region="${REGION}" \
    --format='value(spec.template.spec.serviceAccountName)')" \
  --scopes='https://www.googleapis.com/auth/calendar')

curl -fsS \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://www.googleapis.com/calendar/v3/calendars/<CALENDAR_ID>/events/<CALENDAR_EVENT_ID>?fields=id,extendedProperties" | jq .
```

6. その予約イベントを Google Calendar 側で変更し、差分同期後も `staff_blocks` に取り込まれないことを確認する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id, external_event_id, source, created_at
FROM staff_blocks
WHERE source = 'google_calendar'
  AND external_event_id = '<CALENDAR_EVENT_ID>';
SQL
```

成功の判断基準:

- Step 3 のイベントが `source = 'google_calendar'`、`status = 'active'` で `staff_blocks` に存在する。
- `external_event_id` に Google Calendar のイベント ID が入っている。
- イベント編集後、同じ `(calendar_id, external_event_id)` の行が 2 行にならない。
- システム作成イベントには `extendedProperties.private.source = reservation_system` があり、そのイベント ID の `staff_blocks` 行が増えない。

失敗時の判断・確認ポイント:

- `staff_blocks` に行がない場合は `calendar_sync_conflicts`、`calendar_sync_states.last_error`、Cloud Run ログの `[CalendarSync]` と `calendarStaffBlockImport` 周辺を確認する。
- 重複が出る場合は `staff_blocks_calendar_event_uq` が存在するか、`calendar_id` と `external_event_id` が空でないか確認する。
- システム作成イベントが取り込まれる場合は、対象イベントの `extendedProperties.private.source` が `reservation_system` か確認する。

## Step 5: 衝突記録確認

実行手順:

1. 既存予約または既存ブロックの時間帯を確認する。予約との衝突を優先して検証する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       source_type,
       reservation_id,
       staff_block_id,
       start_at,
       end_at
FROM practitioner_busy_ranges
WHERE released_at IS NULL
ORDER BY start_at
LIMIT 5;
SQL
```

2. 上記の `practitioner_id` に対応する Calendar に、取得した `start_at` から `end_at` と完全に重なる Google Calendar イベントを作成する。

3. webhook 受信後に差分同期を手動実行する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

4. `calendar_sync_conflicts` に未解決衝突が記録されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id,
       practitioner_id,
       calendar_id,
       calendar_event_id,
       reservation_id,
       staff_block_id,
       status,
       detail->>'reason' AS conflict_reason,
       detail->>'source' AS conflict_source,
       detail->>'event_start' AS event_start,
       detail->>'event_end' AS event_end,
       created_at
FROM calendar_sync_conflicts
ORDER BY created_at DESC
LIMIT 5;
SQL
```

5. 衝突したイベントが `staff_blocks` に取り込まれていないことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id, external_event_id, source, status, created_at
FROM staff_blocks
WHERE source = 'google_calendar'
  AND external_event_id = '<CONFLICT_GOOGLE_CALENDAR_EVENT_ID>';
SQL
```

成功の判断基準:

- `calendar_sync_conflicts` に `status = 'open'` の行が作成される。
- `detail->>'reason'` が `busy_range_conflict` である。
- 予約と重ねた場合は `reservation_id` が入る。
- 衝突イベントの `external_event_id` で `staff_blocks` の行が存在しない。
- `/api/batch/calendar-sync` の JSON では該当結果が `failed_count` に含まれ、`conflict: true` になる。

失敗時の判断・確認ポイント:

- `calendar_sync_conflicts` が空の場合、作成したイベントの施術者 Calendar と `practitioner_id` が一致しているか確認する。
- `staff_blocks` に入ってしまう場合、重ねた時間帯が `practitioner_busy_ranges` の `released_at IS NULL` の範囲と本当に重なっているか確認する。
- `reservation_id` が空の場合、衝突対象が予約ではなく既存 staff block の可能性がある。

## Step 6: watch channel 更新バッチ確認

実行手順:

1. 現在の channel 情報を記録する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       channel_id,
       channel_resource_id,
       watch_expires_at,
       updated_at
FROM calendar_sync_states
ORDER BY practitioner_id;
SQL
```

2. 通常は期限切れ 24 時間前の channel だけが更新対象になる。E2E では `force: true` で強制更新する。

```bash
curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-watch/refresh" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"force": true, "limit": 100}' | jq .
```

3. channel が更新されたことを確認する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       channel_id,
       channel_resource_id,
       watch_expires_at,
       last_error,
       updated_at
FROM calendar_sync_states
ORDER BY updated_at DESC;
SQL
```

成功の判断基準:

- watch 更新 API が HTTP 200 を返し、JSON の `failed_count` が `0` である。
- `channel_id` が Step 6-1 で記録した値から変わっている。
- `channel_resource_id` が空ではない。
- `watch_expires_at` が更新され、現在時刻から約 6 日後になっている。
- `last_error` が `NULL` である。

失敗時の判断・確認ポイント:

- `force: true` なしで再実行し、期限まで 24 時間以上ある場合は `skipped_count` に入る。
- `failed_count` が 1 以上の場合は Cloud Run ログで `[CalendarWatch]` のエラーを確認する。
- 古い channel の停止に失敗しても、新しい channel 登録自体が成功していれば `old_channel_stop_attempted` と `old_channel_stopped` を結果 JSON で確認する。

## トラブルシューティング

### webhook が届かない場合

確認手順:

```bash
gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='yaml(status.url,spec.template.spec.containers[0].env)'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT practitioner_id,
       calendar_id,
       channel_id,
       channel_resource_id,
       watch_expires_at,
       last_notification_at,
       last_error
FROM calendar_sync_states
ORDER BY updated_at DESC;
SQL
```

判断ポイント:

- `GOOGLE_CALENDAR_WEBHOOK_URL` が `https://.../api/webhooks/google-calendar` を指していること。
- Google Calendar API の push 通知は HTTPS 必須で、自己署名証明書は使えない。
- `channel_id` と `channel_resource_id` が入っていること。
- `watch_expires_at` が過去ではないこと。
- Cloud Run が外部からアクセス可能であること。
- webhook のレスポンスが 403 の場合は `channel_token` または `channel_resource_id` の不一致を疑う。

### syncToken エラー（410 Gone）が出た場合

Google Calendar API が 410 を返すと `syncToken` は無効である。実装は差分同期中の 410 を検知すると `sync_token` を一度 `NULL` にしてフルシンクで復旧するが、手動リセットする場合は次を実行する。

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
UPDATE calendar_sync_states
SET sync_token = NULL,
    sync_requested_at = now()
WHERE practitioner_id = '<PRACTITIONER_ID>';
SQL

curl -fsS -X POST "${CLOUD_RUN_URL}/api/batch/calendar-sync" \
  -H "Content-Type: application/json" \
  -H "x-scheduler-secret: ${SCHEDULER_SECRET}" \
  -d '{"limit": 100}' | jq .
```

判断ポイント:

- `/api/batch/calendar-sync` 後に `sync_token` が再保存されること。
- `last_full_sync_at` が直近に更新されること。
- `last_error` が `NULL` になること。

### staff_blocks に取り込まれない場合

確認手順:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT id,
       practitioner_id,
       calendar_id,
       calendar_event_id,
       status,
       detail,
       created_at
FROM calendar_sync_conflicts
ORDER BY created_at DESC
LIMIT 10;

SELECT practitioner_id,
       calendar_id,
       sync_token IS NOT NULL AS has_sync_token,
       last_synced_at,
       sync_requested_at,
       last_error
FROM calendar_sync_states
ORDER BY updated_at DESC
LIMIT 10;
SQL
```

判断ポイント:

- `calendar_sync_conflicts` に `busy_range_conflict` がないか確認する。
- Cloud Run ログで `[CalendarSync]`、`calendarStaffBlockImport` 周辺のエラーを確認する。
- イベントに `extendedProperties.private.source = reservation_system` が設定されている場合、システム作成イベントとして意図的に除外される。
- 終日イベント、開始・終了時刻がないイベント、不正な時間範囲のイベントは取り込み対象外になる。

### watch channel 登録が失敗する場合

確認手順:

```bash
gcloud run services describe "${SERVICE_NAME}" \
  --project="${GCP_PROJECT_ID}" \
  --region="${REGION}" \
  --format='value(spec.template.spec.containers[0].env)'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT p.id AS practitioner_id,
       p.name,
       p.is_active,
       p.calendar_id AS practitioner_calendar_id,
       css.id AS calendar_sync_state_id,
       css.calendar_id AS sync_calendar_id,
       css.last_error
FROM practitioners p
LEFT JOIN calendar_sync_states css
  ON css.practitioner_id = p.id
 AND css.calendar_id = p.calendar_id
WHERE p.is_active = true
ORDER BY p.sort_order, p.id;
SQL
```

判断ポイント:

- service account に対象 Calendar の閲覧権限以上があること。
- `GOOGLE_CALENDAR_WEBHOOK_URL` が Cloud Run に設定されていること。
- `calendar_sync_states` に対象施術者と Calendar ID の行があること。
- `practitioners.is_active = true` で、`practitioners.calendar_id` が空ではないこと。
- `last_error` に Calendar API の 403/404 が残っている場合は Calendar 共有設定または Calendar ID を確認する。

## 完了条件

- `docs/runbooks/verify-calendar-sync.md` が存在する。
- Step 1 から Step 6 までの実行手順が揃っている。
- 各 Step に成功の判断基準と失敗時の判断・確認ポイントがある。
- トラブルシューティングに webhook 未着、syncToken エラー、`staff_blocks` 未取込、watch channel 登録失敗の 4 パターンがある。
- SQL とコマンドが実装のスキーマ・ルート・認証方式に合っている。
