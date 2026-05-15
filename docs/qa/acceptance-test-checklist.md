# 実店舗導入前 受け入れテストチェックリスト

| 項目 | 内容 |
|---|---|
| テスト実施者 |  |
| 実施日 |  |
| 対象環境 URL |  |
| DB 接続先 |  |
| 結果サマリ | PASS / FAIL |

## テスト前提

このチェックリストは Cloud Run にデプロイ済みの API と Neon PostgreSQL を対象にする。実値の token、secret、DB 接続文字列はこのファイルに書かない。

共通変数の例:

```bash
export BASE_URL="https://<cloud-run-url>"
export LINE_ID_TOKEN="<LINE_ID_TOKEN>"
export ADMIN_LINE_ID="<ADMIN_LINE_ID>"
export SCHEDULER_SECRET="<SCHEDULER_SECRET>"
export TEST_DATE="<翌営業日 YYYY/MM/DD>"
export TEST_DATE_ISO="<翌営業日 YYYY-MM-DD>"
```

現行 API の予約作成 payload は `menu_id` / `start_at` ではなく、`menu` object、`date`、`time`、`practitionerId` を使う。batch 系 API は JSON body の `secret` ではなく `x-scheduler-secret` ヘッダーで認証する。

## 1. 事前準備

- [ ] `docs/runbooks/onboard-first-salon.md` の Step 8 smoke test が PASS していること。
  - 操作手順:
    ```bash
    curl -fsS "$BASE_URL/health" | jq .
    curl -fsS "$BASE_URL/api/config" | jq .
    curl -fsS "$BASE_URL/api/practitioners" | jq .
    curl -fsS "$BASE_URL/api/menus" | jq .
    ```
  - 合否判定基準: `/health` が `{"status":"ok"}` を返し、`/api/config`、`/api/practitioners`、`/api/menus` が JSON を返すこと。

- [ ] テスト用 LINE アカウントの ID token を取得済みであること。
  - 操作手順: LIFF デバッグモードまたは `liff.getIDToken()` で ID token を取得し、`LINE_ID_TOKEN` に設定する。
  - 合否判定基準: `Authorization: Bearer <LINE_ID_TOKEN>` を付けた認証必須 API で 401 にならないこと。

- [ ] テスト用 admin LINE ID が `ADMIN_LINE_ID` 環境変数に登録されていること。
  - 操作手順:
    ```bash
    curl -fsS "$BASE_URL/api/check-admin?userId=$ADMIN_LINE_ID" | jq .
    ```
  - 合否判定基準: `{"isAdmin":true}` が返ること。

- [ ] `GET /api/practitioners` で施術者が 1 名以上返ること。
  - 操作手順:
    ```bash
    export PRACTITIONER_ID=$(curl -fsS "$BASE_URL/api/practitioners" | jq -r '.[0].id')
    echo "$PRACTITIONER_ID"
    ```
  - 合否判定基準: `PRACTITIONER_ID` が `null` や空文字ではないこと。

- [ ] `GET /api/menus` でメニューが 1 件以上返ること。
  - 操作手順:
    ```bash
    export MENU_JSON=$(curl -fsS "$BASE_URL/api/menus" | jq -c '.[0]')
    export MENU_ID=$(printf '%s' "$MENU_JSON" | jq -r '.id')
    export MENU_NAME=$(printf '%s' "$MENU_JSON" | jq -r '.name')
    export MENU_MINUTES=$(printf '%s' "$MENU_JSON" | jq -r '.minutes')
    export MENU_PRICE=$(printf '%s' "$MENU_JSON" | jq -r '.price')
    ```
  - 合否判定基準: `MENU_ID`、`MENU_NAME`、`MENU_MINUTES` が取得でき、`MENU_MINUTES` が 1 以上であること。

- [ ] `GET /api/slots?date=<翌営業日>&minutes=<分数>&practitionerId=<施術者ID>` で空き枠が返ること。
  - 操作手順:
    ```bash
    curl -fsS "$BASE_URL/api/slots?date=$TEST_DATE&minutes=$MENU_MINUTES&practitionerId=$PRACTITIONER_ID" | jq .
    ```
  - 合否判定基準: JSON 配列が返り、予約テストに使う時刻が含まれていること。

## 2. 顧客予約フロー

### 2-1. 予約作成（正常系）

- [ ] LINE ID token を Authorization ヘッダーに付けて `POST /api/reservations` を送信し、HTTP 201 と予約 ID が返ること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-001" \
      -d "{
        \"name\": \"受け入れテスト顧客\",
        \"phone\": \"09000000000\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"10:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE,
        \"notes\": \"受け入れテスト\"
      }"
    ```
  - 合否判定基準: HTTP 201、`status: "success"`、`id`、`reservation.id` が返ること。以後の確認用に `RESERVATION_ID` へ控えること。

- [ ] DB に `reservations` レコードが作成されていること。
  - 操作手順:
    ```sql
    SELECT id, status, practitioner_id, start_at, end_at, created_via
    FROM reservations
    ORDER BY created_at DESC
    LIMIT 1;
    ```
  - 合否判定基準: `id = '<予約ID>'`、`status = 'reserved'`、`created_via = 'customer_liff'`、`practitioner_id = '<施術者ID>'` であること。

- [ ] `practitioner_busy_ranges` に対応する予約由来のレコードが作成されていること。
  - 操作手順:
    ```sql
    SELECT practitioner_id, source_type, reservation_id, start_at, end_at, released_at
    FROM practitioner_busy_ranges
    WHERE reservation_id = '<予約ID>';
    ```
  - 合否判定基準: 1 件返り、`source_type = 'reservation'`、`released_at IS NULL` であること。

- [ ] `outbox_events` に Google Calendar 作成と LINE 通知イベントが作成されていること。
  - 操作手順:
    ```sql
    SELECT event_type, status, attempt_count
    FROM outbox_events
    WHERE aggregate_type = 'reservation'
      AND aggregate_id = '<予約ID>'
    ORDER BY created_at;
    ```
  - 合否判定基準: `reservation.calendar.create`、`reservation.line.notify_customer_created`、`reservation.line.notify_admin_created` が作成され、初期 status が `pending` であること。

### 2-2. 冪等性（同じ idempotency key の再送）

- [ ] 同じ idempotency key で同じリクエストを再送して HTTP 200 と同じ予約 ID が返ること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-001" \
      -d "{
        \"name\": \"受け入れテスト顧客\",
        \"phone\": \"09000000000\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"10:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 200、`existing: true`、初回と同じ `id` が返ること。

- [ ] DB の `reservations` 件数が増えていないこと。
  - 操作手順:
    ```sql
    SELECT COUNT(*)
    FROM reservations
    WHERE line_user_id = '<LINE user id>'
      AND idempotency_key = 'test-001';
    ```
  - 合否判定基準: 件数が 1 件であること。

### 2-3. Google Calendar 反映（outbox 経由）

- [ ] outbox batch を手動実行する。
  - 操作手順:
    ```bash
    curl -fsS -X POST "$BASE_URL/api/batch/outbox" \
      -H "Content-Type: application/json" \
      -H "x-scheduler-secret: $SCHEDULER_SECRET" \
      -d '{}' | jq .
    ```
  - 合否判定基準: `processed` が 1 以上、`failed = 0` であること。

- [ ] outbox の `reservation.calendar.create` イベントが `succeeded` になっていること。
  - 操作手順:
    ```sql
    SELECT event_type, status, processed_at, last_error
    FROM outbox_events
    WHERE aggregate_id = '<予約ID>'
      AND event_type = 'reservation.calendar.create';
    ```
  - 合否判定基準: `status = 'succeeded'`、`processed_at IS NOT NULL`、`last_error IS NULL` であること。

- [ ] 施術者の Google Calendar に予約イベントが作成されていること。
  - 操作手順: Google Calendar 上で予約日時のイベントを開く。API で確認する場合は対象 calendar の event id `r<予約IDからハイフンを除いた値>` を取得する。
  - 合否判定基準: イベントが存在し、`extendedProperties.private.source = reservation_system` と `extendedProperties.private.reservation_id = '<予約ID>'` が付いていること。

### 2-4. LINE 通知（outbox 経由）

- [ ] outbox の LINE 通知イベントが `succeeded` になっていること。
  - 操作手順:
    ```sql
    SELECT event_type, status, processed_at, last_error
    FROM outbox_events
    WHERE aggregate_id = '<予約ID>'
      AND event_type IN (
        'reservation.line.notify_customer_created',
        'reservation.line.notify_admin_created'
      )
    ORDER BY event_type;
    ```
  - 合否判定基準: 2 件とも `status = 'succeeded'`、`processed_at IS NOT NULL`、`last_error IS NULL` であること。

- [ ] テスト用 LINE アカウントと admin LINE ID に予約通知が届いていること。
  - 操作手順: LINE アプリで通知内容を確認する。
  - 合否判定基準: 顧客には予約完了通知、admin には新規予約通知が届き、日時・メニュー・担当が予約内容と一致すること。

## 3. ダブルブッキング防止

### 3-1. 同一施術者・同一時間帯の重複拒否

- [ ] セクション 2 で作成した予約と同じ `practitionerId` / `date` / `time` で別リクエストを送信し、HTTP 409 が返ること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-conflict-001" \
      -d "{
        \"name\": \"重複テスト顧客\",
        \"phone\": \"09000000001\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"10:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 409、`status: "error"`、重複を示す message が返ること。

- [ ] DB に 2 件目の `reservations` レコードが作成されていないこと。
  - 操作手順:
    ```sql
    SELECT COUNT(*)
    FROM reservations
    WHERE practitioner_id = '<施術者ID>'
      AND start_at = '<予約開始ISO8601>'::timestamptz
      AND status = 'reserved';
    ```
  - 合否判定基準: 件数が 1 件であること。

### 3-2. 指名なし予約（並行実行）

- [ ] `practitionerId` を `all` にし、候補施術者リストを渡して指名なし予約を送信すると HTTP 201 が返ること。
  - 操作手順:
    ```bash
    export AVAILABLE_PRACTITIONERS=$(curl -fsS "$BASE_URL/api/practitioners" | jq -c '[.[] | select(.isActive != false) | {id, name, calendarId}]')

    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-unrequested-001" \
      -d "{
        \"name\": \"指名なしテスト顧客\",
        \"phone\": \"09000000002\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"11:00\",
        \"practitionerId\": \"all\",
        \"availablePractitioners\": $AVAILABLE_PRACTITIONERS,
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 201、レスポンスの `reservation.practitionerId` に実際の施術者 ID が入ること。

- [ ] DB で `practitioner_id` が自動割り当てされていること。
  - 操作手順:
    ```sql
    SELECT id, practitioner_id, practitioner_name_snapshot
    FROM reservations
    WHERE id = '<指名なし予約ID>';
    ```
  - 合否判定基準: `practitioner_id IS NOT NULL`、候補施術者のいずれかであること。

- [ ] 全候補施術者が埋まっている時間帯に指名なし予約を送信して満席レスポンスが返ること。
  - 操作手順: 全候補施術者分の予約またはスタッフブロックを同一時間帯に作成したうえで、上記と同じ `date` / `time` の指名なし予約を別 idempotency key で送信する。
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-unrequested-full-001" \
      -d "{
        \"name\": \"指名なし満席テスト顧客\",
        \"phone\": \"09000000006\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"11:00\",
        \"practitionerId\": \"all\",
        \"availablePractitioners\": $AVAILABLE_PRACTITIONERS,
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 409、message が `指定された時間は満席です` または満席を示す内容であり、新規予約が作成されないこと。

## 4. キャンセルフロー

### 4-1. 顧客キャンセル（24 時間前まで）

- [ ] 翌日以降、かつ開始 24 時間以上前の予約に対して `DELETE /api/reservations/<id>` を送信し、HTTP 200 が返ること。
  - 操作手順:
    ```bash
    curl -i -X DELETE "$BASE_URL/api/reservations/<予約ID>" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"reason":"受け入れテスト顧客キャンセル"}'
    ```
  - 合否判定基準: HTTP 200、`status: "success"`、`reservation.status = "canceled"` が返ること。

- [ ] DB の `reservations.status = 'canceled'` かつ `canceled_at` が設定されていること。
  - 操作手順:
    ```sql
    SELECT id, status, canceled_at, cancel_reason
    FROM reservations
    WHERE id = '<予約ID>';
    ```
  - 合否判定基準: `status = 'canceled'`、`canceled_at IS NOT NULL`、理由が記録されていること。

- [ ] `practitioner_busy_ranges.released_at` が設定され、枠が解放されていること。
  - 操作手順:
    ```sql
    SELECT reservation_id, released_at
    FROM practitioner_busy_ranges
    WHERE reservation_id = '<予約ID>';
    ```
  - 合否判定基準: `released_at IS NOT NULL` であること。

- [ ] outbox に Google Calendar キャンセルと LINE キャンセル通知イベントが作成されていること。
  - 操作手順:
    ```sql
    SELECT event_type, status
    FROM outbox_events
    WHERE aggregate_id = '<予約ID>'
      AND event_type IN (
        'reservation.calendar.cancel',
        'reservation.line.notify_customer_canceled',
        'reservation.line.notify_admin_canceled'
      )
    ORDER BY event_type;
    ```
  - 合否判定基準: 3 件作成され、初期 status が `pending` であること。outbox batch 実行後に 3 件とも `succeeded` になること。

### 4-2. 24 時間以内のキャンセル拒否

- [ ] 24 時間以内の予約に対して `DELETE /api/reservations/<id>` を送信し、HTTP 403 が返ること。
  - 操作手順:
    ```bash
    curl -i -X DELETE "$BASE_URL/api/reservations/<24時間以内の予約ID>" \
      -H "Authorization: Bearer $LINE_ID_TOKEN"
    ```
  - 合否判定基準: HTTP 403、24 時間前を過ぎているためキャンセルできない旨の message が返ること。

- [ ] DB の `reservations` が `canceled` になっていないこと。
  - 操作手順:
    ```sql
    SELECT id, status, canceled_at
    FROM reservations
    WHERE id = '<24時間以内の予約ID>';
    ```
  - 合否判定基準: `status = 'reserved'`、`canceled_at IS NULL` であること。

### 4-3. admin キャンセル（時間制限なし）

- [ ] 24 時間以内の予約に対して `DELETE /api/admin/reservations/<id>` を admin ID と理由付きで送信し、HTTP 200 が返ること。
  - 操作手順:
    ```bash
    curl -i -X DELETE "$BASE_URL/api/admin/reservations/<24時間以内の予約ID>" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"reason\": \"テストキャンセル\"
      }"
    ```
  - 合否判定基準: HTTP 200、`status: "success"`、`reservation.status = "canceled"` が返ること。

- [ ] `audit_logs` に操作者・理由が記録されていること。
  - 操作手順:
    ```sql
    SELECT actor_type, actor_id, action, metadata->>'reason' AS reason, created_at
    FROM audit_logs
    WHERE reservation_id = '<予約ID>'
    ORDER BY created_at DESC
    LIMIT 1;
    ```
  - 合否判定基準: `actor_type = 'admin'`、`actor_id = '<ADMIN_LINE_ID>'`、`action = 'reservation.canceled'`、`reason = 'テストキャンセル'` であること。

## 5. スタッフブロック

### 5-1. ブロック登録

- [ ] `POST /api/admin/staff-blocks` でブロックを登録し、HTTP 201 が返ること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/admin/staff-blocks" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"startAt\": \"${TEST_DATE_ISO}T14:00:00+09:00\",
        \"endAt\": \"${TEST_DATE_ISO}T15:00:00+09:00\",
        \"reason\": \"テスト休憩\"
      }"
    ```
  - 合否判定基準: HTTP 201、`status: "success"`、`staffBlock.id` が返ること。以後の確認用に `STAFF_BLOCK_ID` へ控えること。

- [ ] DB の `staff_blocks` にレコードが作成されていること。
  - 操作手順:
    ```sql
    SELECT id, practitioner_id, start_at, end_at, source, status, reason
    FROM staff_blocks
    WHERE id = '<スタッフブロックID>';
    ```
  - 合否判定基準: `source = 'admin'`、`status = 'active'`、`reason = 'テスト休憩'` であること。

- [ ] DB の `practitioner_busy_ranges` に対応するスタッフブロック由来のレコードが作成されていること。
  - 操作手順:
    ```sql
    SELECT practitioner_id, source_type, staff_block_id, start_at, end_at, released_at
    FROM practitioner_busy_ranges
    WHERE staff_block_id = '<スタッフブロックID>';
    ```
  - 合否判定基準: 1 件返り、`source_type = 'staff_block'`、`released_at IS NULL` であること。

### 5-2. ブロック中の予約拒否

- [ ] ブロックと重なる時間帯に予約作成を試みて HTTP 409 が返ること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-block-conflict-001" \
      -d "{
        \"name\": \"ブロック重複テスト顧客\",
        \"phone\": \"09000000003\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": 60,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"14:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": 60,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 409、重複を示す message が返り、予約が作成されないこと。

### 5-3. ブロック取消

- [ ] `DELETE /api/admin/staff-blocks/<id>` を送信し、HTTP 200 が返ること。
  - 操作手順:
    ```bash
    curl -i -X DELETE "$BASE_URL/api/admin/staff-blocks/$STAFF_BLOCK_ID" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\"
      }"
    ```
  - 合否判定基準: HTTP 200、`status: "success"` が返ること。

- [ ] `practitioner_busy_ranges.released_at` が設定されていること。
  - 操作手順:
    ```sql
    SELECT staff_block_id, released_at
    FROM practitioner_busy_ranges
    WHERE staff_block_id = '<スタッフブロックID>';
    ```
  - 合否判定基準: `released_at IS NOT NULL` であること。

- [ ] 取消後、同時間帯に予約が作成できること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/reservations" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $LINE_ID_TOKEN" \
      -H "Idempotency-Key: test-after-block-release-001" \
      -d "{
        \"name\": \"ブロック取消後テスト顧客\",
        \"phone\": \"09000000004\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": 60,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"14:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": 60,
        \"totalPrice\": $MENU_PRICE
      }"
    ```
  - 合否判定基準: HTTP 201、予約 ID が返ること。

## 6. admin 代理予約

- [ ] LINE 未連携顧客でも `POST /api/admin/reservations` で予約作成できること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/admin/reservations" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"name\": \"テスト顧客\",
        \"phone\": \"09000000005\",
        \"menu\": {
          \"id\": \"$MENU_ID\",
          \"name\": \"$MENU_NAME\",
          \"minutes\": $MENU_MINUTES,
          \"price\": $MENU_PRICE
        },
        \"date\": \"$TEST_DATE\",
        \"time\": \"11:00\",
        \"practitionerId\": \"$PRACTITIONER_ID\",
        \"totalMinutes\": $MENU_MINUTES,
        \"totalPrice\": $MENU_PRICE,
        \"notes\": \"admin代理予約テスト\"
      }"
    ```
  - 合否判定基準: HTTP 201、`status: "success"`、`reservation.id` が返ること。`lineUserId` を省略しても作成できること。

- [ ] DB の `reservations.created_via = 'staff_admin'` であること。
  - 操作手順:
    ```sql
    SELECT id, line_user_id, created_via, customer_name
    FROM reservations
    WHERE id = '<admin代理予約ID>';
    ```
  - 合否判定基準: `created_via = 'staff_admin'`、`customer_name = 'テスト顧客'` であること。

- [ ] `audit_logs` に操作者が記録されていること。
  - 操作手順:
    ```sql
    SELECT actor_type, actor_id, action, created_at
    FROM audit_logs
    WHERE reservation_id = '<admin代理予約ID>'
    ORDER BY created_at DESC
    LIMIT 1;
    ```
  - 合否判定基準: `actor_type = 'admin'`、`actor_id = '<ADMIN_LINE_ID>'`、`action = 'reservation.create'` であること。

- [ ] Google Calendar に反映されること。
  - 操作手順:
    ```bash
    curl -fsS -X POST "$BASE_URL/api/batch/outbox" \
      -H "Content-Type: application/json" \
      -H "x-scheduler-secret: $SCHEDULER_SECRET" \
      -d '{}' | jq .
    ```
  - 合否判定基準: admin 代理予約の `reservation.calendar.create` が `succeeded` になり、Google Calendar に予約イベントが作成されていること。`lineUserId` なしの場合、顧客向け LINE 通知イベントは作成されないこと。

## 7. outbox 監視（#28 完了後）

- [ ] `GET /api/admin/outbox/stats?adminId=<ADMIN_LINE_ID>` で各 status の件数が返ること。
  - 操作手順:
    ```bash
    curl -fsS "$BASE_URL/api/admin/outbox/stats?adminId=$ADMIN_LINE_ID" | jq .
    ```
  - 合否判定基準: `pending`、`processing`、`succeeded`、`failed`、`stale_processing` の数値フィールドが返ること。

- [ ] テスト完了後に failed イベントが 0 件であること。
  - 操作手順:
    ```sql
    SELECT id, event_type, status, attempt_count, last_error
    FROM outbox_events
    WHERE status = 'failed'
    ORDER BY updated_at DESC;
    ```
  - 合否判定基準: 0 件であること。存在する場合は原因を記録し、必要に応じて `POST /api/admin/outbox/<id>/retry` を実行すること。

- [ ] stale processing が 0 件であること。
  - 操作手順:
    ```bash
    curl -fsS "$BASE_URL/api/admin/outbox/stats?adminId=$ADMIN_LINE_ID" | jq '.stale_processing'
    ```
  - 合否判定基準: `0` が返ること。

## 8. マスタデータ CRUD

- [ ] `POST /api/practitioners` で施術者を追加し、`GET /api/practitioners` に反映されること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/practitioners" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"practitioner\": {
          \"name\": \"受け入れテスト施術者\",
          \"calendarId\": \"test-practitioner-calendar@example.com\",
          \"title\": \"テスト担当\",
          \"isActive\": true,
          \"sortOrder\": 999
        }
      }"

    curl -fsS "$BASE_URL/api/practitioners" | jq '.[] | select(.name == "受け入れテスト施術者")'
    ```
  - 合否判定基準: POST が成功し、作成された施術者が一覧に表示されること。作成 ID を `CRUD_PRACTITIONER_ID` として控えること。

- [ ] `PUT /api/practitioners/<id>` で施術者名を更新できること。
  - 操作手順:
    ```bash
    curl -i -X PUT "$BASE_URL/api/practitioners/$CRUD_PRACTITIONER_ID" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"practitioner\": {
          \"name\": \"受け入れテスト施術者 更新\"
        }
      }"
    ```
  - 合否判定基準: `status: "success"` が返り、`GET /api/practitioners` で更新後の名前が確認できること。

- [ ] `DELETE /api/practitioners/<id>` で施術者を削除できること。
  - 操作手順:
    ```bash
    curl -i -X DELETE "$BASE_URL/api/practitioners/$CRUD_PRACTITIONER_ID?adminId=$ADMIN_LINE_ID"
    ```
  - 合否判定基準: `status: "success"` が返り、対象施術者の `isActive` または `active` が false になるか、通常一覧から除外されること。

- [ ] `POST /api/menus` でメニューを追加できること。
  - 操作手順:
    ```bash
    curl -i -X POST "$BASE_URL/api/menus" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"menu\": {
          \"category\": \"テスト\",
          \"name\": \"受け入れテストメニュー\",
          \"minutes\": 30,
          \"price\": 1000,
          \"description\": \"受け入れテスト用\",
          \"isActive\": true,
          \"sortOrder\": 999
        }
      }"
    ```
  - 合否判定基準: `status: "success"`、`menuId` が返り、`GET /api/menus` に表示されること。作成 ID を `CRUD_MENU_ID` として控えること。

- [ ] `PUT /api/menus/reorder` でメニューの並び順を変更できること。
  - 操作手順:
    ```bash
    export ORDERED_MENU_IDS=$(curl -fsS "$BASE_URL/api/menus" | jq -c '[.[].id] | reverse')

    curl -i -X PUT "$BASE_URL/api/menus/reorder" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"orderedIds\": $ORDERED_MENU_IDS
      }"
    ```
  - 合否判定基準: `status: "success"`、`updatedCount` が `orderedIds` の件数と一致し、`GET /api/menus` の順序に反映されること。

- [ ] `PUT /api/settings` で営業時間等を更新できること。
  - 操作手順:
    ```bash
    curl -i -X PUT "$BASE_URL/api/settings" \
      -H "Content-Type: application/json" \
      -d "{
        \"adminId\": \"$ADMIN_LINE_ID\",
        \"settings\": {
          \"businessStartHour\": \"10\",
          \"businessEndHour\": \"20\",
          \"regularHolidays\": \"[1]\",
          \"temporaryBusinessDays\": \"\",
          \"holidays\": \"\"
        }
      }"
    ```
  - 合否判定基準: `status: "success"` が返り、`GET /api/settings?adminId=<ADMIN_LINE_ID>` で更新値が確認できること。

## 合否判定基準

| 判定 | 条件 |
|---|---|
| PASS | 全チェック項目が PASS で、failed outbox イベントが 0 件 |
| CONDITIONAL PASS | 軽微な不具合はあるが本番影響なしと判断できる場合。理由、影響範囲、暫定対応を結果サマリに記載する |
| FAIL | 予約作成、キャンセル、ダブルブッキング防止のいずれかで期待と異なる挙動がある場合 |

予約作成から Google Calendar 反映・LINE 通知までの所要時間目安:

- [ ] outbox batch 間隔が 30 秒の場合、60 秒以内に Google Calendar と LINE へ反映されること。
  - 操作手順: 予約作成時刻、outbox batch 実行時刻、Google Calendar 反映時刻、LINE 受信時刻を記録する。
  - 合否判定基準: 予約作成から 60 秒以内に反映が完了すること。手動 batch 実行時は batch 実行から 60 秒以内に完了すること。

## 完了条件

- [ ] `docs/qa/acceptance-test-checklist.md` が存在すること。
  - 操作手順:
    ```bash
    test -f docs/qa/acceptance-test-checklist.md
    ```
  - 合否判定基準: コマンドが終了コード 0 で終了すること。

- [ ] セクション 1 から 8 の全チェック項目があること。
  - 操作手順:
    ```bash
    rg -n '^## [1-8]\\.' docs/qa/acceptance-test-checklist.md
    ```
  - 合否判定基準: セクション 1 から 8 までがすべて表示されること。

- [ ] curl コマンド例が全フローに揃っていること。
  - 操作手順:
    ```bash
    rg -n 'curl ' docs/qa/acceptance-test-checklist.md
    ```
  - 合否判定基準: 予約作成、outbox batch、キャンセル、スタッフブロック、admin 代理予約、outbox stats、マスタ CRUD の curl 例が確認できること。

- [ ] 合否判定基準があること。
  - 操作手順:
    ```bash
    rg -n '合否判定基準' docs/qa/acceptance-test-checklist.md
    ```
  - 合否判定基準: 各主要チェック項目に「合否判定基準」が記載されていること。

- [ ] テスト実施者・実施日を記録するメタ情報欄があること。
  - 操作手順:
    ```bash
    sed -n '1,12p' docs/qa/acceptance-test-checklist.md
    ```
  - 合否判定基準: `テスト実施者`、`実施日`、`対象環境 URL`、`DB 接続先`、`結果サマリ` の欄があること。

- [ ] `node --check` が PASS していること。
  - 操作手順:
    ```bash
    find backend -name '*.js' -print0 | xargs -0 -n1 node --check
    ```
  - 合否判定基準: すべての JavaScript ファイルで syntax error が出ないこと。

- [ ] `git diff --check` が PASS していること。
  - 操作手順:
    ```bash
    git diff --check --cached
    ```
  - 合否判定基準: whitespace error が出ないこと。

- [ ] commit して push し、PR を作成していること。
  - 操作手順:
    ```bash
    git status --short
    git log -1 --oneline
    gh pr view --web
    ```
  - 合否判定基準: 対象ファイルだけが commit され、`feat/issue-31-acceptance-test` が push 済みで、PR が作成されていること。

- [ ] Issue #31 に完了コメントを残して close していること。
  - 操作手順:
    ```bash
    gh issue view 31 --json state,comments
    ```
  - 合否判定基準: Issue #31 が `CLOSED` で、完了コメントに PR URL と実施チェックが記載されていること。
