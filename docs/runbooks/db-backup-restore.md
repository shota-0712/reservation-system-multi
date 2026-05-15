# DB バックアップ/リストア手順

この手順書は、サロン別 Neon PostgreSQL を対象に、手動バックアップ、リストア、リストア後の整合性確認を行うためのランブックです。

前提:

- リポジトリルートで実行する。
- `DATABASE_URL` の実値は shell、Secret Manager、Neon コンソール内だけで扱い、Git 管理ファイルや作業メモに書かない。
- `tenants/example.salon.yaml` の DB 設定は `database_provider: neon`、`database_secret_name: salon-example-salon-database-url`。実サロンでは `salon-<salon_id>-database-url` 形式の Secret Manager secret を使う。
- 対象スキーマは `db/migrations/001_initial_schema.sql` から `004_calendar_webhook_sync_request.sql` までを順に適用した状態を基準にする。
- バックアップファイルには顧客・予約データが含まれる。ローカル保存、GCS アップロード、共有権限の設定は機密情報として扱う。

参照:

- [Neon Point-in-Time Recovery](https://neon.tech/docs/introduction/point-in-time-recovery)
- [Neon Backup & restore](https://neon.com/docs/guides/backup-restore)
- [Neon Restore window](https://neon.com/docs/introduction/restore-window)
- [Neon Instant restore](https://neon.com/docs/introduction/branch-restore)

## 1. Neon 自動バックアップ仕様

Neon では、従来型の nightly dump だけではなく、Write-Ahead Log (WAL) の履歴を使った Instant restore / Point-in-Time Restore (PITR) と、Backup & restore 画面の snapshots を使って復旧する。

現行 Neon docs ではプラン名が Free / Launch / Scale になっている。旧 Pro 契約または「Pro」と呼んでいる有料プランは、実際の契約プランを Neon コンソールで確認し、少なくとも Launch / Scale のどちらの restore window が適用されるかを確認する。

| プラン | PITR / restore window | snapshots / 自動バックアップ |
|---|---:|---|
| Free | 最大 6 時間。変更履歴は 1 GB まで | 手動 snapshot は 1 個。backup schedule は使わない |
| Launch（有料 / 旧 Pro 相当の確認候補） | 最大 7 日 | 手動 snapshot は 10 個。backup schedule による daily / weekly / monthly の自動 snapshot が利用可能 |
| Scale | 最大 30 日 | 手動 snapshot は 10 個。backup schedule による daily / weekly / monthly の自動 snapshot が利用可能 |

注意:

- restore window はプロジェクト単位で設定する。短くするとコストは下がるが、巻き戻せる時点も短くなる。
- PITR は root branch が対象。child branch は Instant restore の対象外。
- Instant restore は merge ではなく完全上書き。選択した時点以降の schema / data 変更は対象 branch から除外される。
- restore 実行時、Neon は復旧前の状態を `<branch_name>_old_<timestamp>` の backup branch として自動作成する。復旧後の検証が終わるまでは残す。
- restore 中は既存接続が一時的に切れるが、Instant restore では connection string は変わらない。

### PITR の手順概要

1. Neon Console で対象 Project を開く。
2. Backup & restore または Restore 画面を開く。
3. root branch（通常は `main` または `production`）を選ぶ。
4. data loss の直前など、復旧したい timestamp を選ぶ。可能なら Preview data / Time Travel Assist で読み取り確認する。
5. 復旧内容と backup branch 作成内容を確認し、Restore を実行する。
6. リストア後の整合性確認クエリを実行する。
7. 問題がなければ backup branch を一定期間保持し、不要になった時点で削除またはデータ削除してコストを抑える。

### Neon コンソールで branch を使って確認リストアする手順

本番 branch を直接上書きする前に、確認用 branch を作って復旧時点のデータを検査する。

1. Neon Console で対象 Project を開く。
2. Branches 画面から New branch を選択する。
3. 親 branch に本番 root branch を選ぶ。
4. data source に Time または LSN を選び、restore window 内の復旧時点を指定する。
5. branch 名を `restore-YYYYMMDD-HHMM` のように付け、compute endpoint を作成する。
6. 作成された branch の connection string を取得し、`RESTORE_DB_URL` として shell にだけ設定する。
7. `RESTORE_DB_URL` に対して整合性確認クエリを実行し、想定データが存在することを確認する。
8. 本番を巻き戻す場合は Instant restore を使う。新 branch に切り替える場合は、Secret Manager の `salon-<salon_id>-database-url` に新しい接続文字列の version を追加し、Cloud Run の新 revision を作成して接続先を切り替える。

## 2. 手動バックアップ取得

共通変数:

```bash
export GCP_PROJECT_ID=<GCP_PROJECT_ID>
export SALON_ID=<salon_id>
```

バックアップ前に `DATABASE_URL` を Secret Manager から安全に取得する。secret 名は tenant YAML の `database_secret_name` と一致させる。

```bash
DATABASE_URL=$(gcloud secrets versions access latest \
  --secret="salon-${SALON_ID}-database-url" \
  --project="${GCP_PROJECT_ID}")
```

履歴展開やログ出力に漏らさないため、`set -x` を有効にした shell では実行しない。値確認が必要な場合も `echo "$DATABASE_URL"` は実行しない。

### フルバックアップ（カスタム形式）

```bash
# DATABASE_URL は Secret Manager から取得済みの前提
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="backup_$(date +%Y%m%d_%H%M%S).dump"
```

### スキーマのみ（構造確認・移行用）

```bash
pg_dump "$DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-acl \
  --file="schema_$(date +%Y%m%d).sql"
```

### バックアップファイルの内容確認

```bash
pg_restore --list backup_YYYYMMDD_HHMMSS.dump | head -30
```

### GCS へのアップロード（長期保管）

```bash
BUCKET=<GCS_BUCKET_NAME>
gsutil cp backup_*.dump gs://${BUCKET}/db-backups/
```

運用メモ:

- GCS bucket は最小権限で管理し、一般公開しない。
- バックアップ専用 bucket を使う場合は Uniform bucket-level access を有効にし、復旧担当者と実行用 service account のみに読み書きを許可する。
- Object Lifecycle で 30 日経過後の自動削除を設定する。

## 3. リストア手順

本番 DB への直接リストア前に、別 Neon project または確認用 branch への dry-run を必ず行う。

```bash
# リストア先の接続文字列
RESTORE_DB_URL="postgresql://..."
```

### 別 Neon プロジェクトへのリストア（dry-run 推奨）

リストア先 DB は空の状態を使う。既存 DB に戻す場合は、対象を取り違えないよう本番接続文字列ではないことを確認してから実行する。

```bash
# スキーマのみ確認
pg_restore \
  --dbname="$RESTORE_DB_URL" \
  --schema-only \
  --no-owner \
  --no-acl \
  backup_YYYYMMDD_HHMMSS.dump
```

```bash
# フルリストア
pg_restore \
  --dbname="$RESTORE_DB_URL" \
  --no-owner \
  --no-acl \
  --exit-on-error \
  backup_YYYYMMDD_HHMMSS.dump
```

### migration-only restore（スキーマだけ再構築）

データを失った場合でも、アプリが必要とするスキーマは migration から再構築できる。

```bash
for f in db/migrations/*.sql; do
  echo "Applying $f ..."
  psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

必要に応じてマスタデータを seed する。

```bash
psql "$RESTORE_DB_URL" -v ON_ERROR_STOP=1 -f db/seeds/master_data.sql
```

### migration-only restore と full restore の使い分け

| ケース | 手順 |
|---|---|
| 誤ったデータ更新（予約を誤 UPDATE など） | full restore（バックアップまたは PITR から巻き戻し）。本番を直接上書きする前に確認用 branch / project で対象データを検査する |
| DB 接続先を新プロジェクトに切り替えたい | migration-only restore → マスタデータ seed → 予約データ個別移行 → Secret Manager の `salon-<salon_id>-database-url` に新 version を追加 |
| 本番 DB の完全破損・削除 | full restore（直近バックアップまたは Neon PITR から）。接続先を新 project にする場合は Cloud Run の新 revision で切り替える |

## 4. リストア後の整合性確認

リストア完了後は、次のクエリを必ず実行する。`practitioners` と `menus` は migration 上 `is_active` 列を使う。

```sql
-- テーブル件数確認
SELECT schemaname, tablename, n_live_tup
FROM pg_stat_user_tables
ORDER BY tablename;
```

```sql
-- reservations と practitioner_busy_ranges の件数一致確認
-- キャンセル分を除いた有効予約と、予約由来の未解放 busy range が対応しているか確認する。
SELECT
  (SELECT COUNT(*) FROM reservations WHERE status NOT IN ('canceled')) AS active_reservations,
  (
    SELECT COUNT(*)
    FROM practitioner_busy_ranges
    WHERE source_type = 'reservation'
      AND released_at IS NULL
  ) AS active_reservation_busy_ranges;
```

```sql
-- 予約ごとの busy range 欠落確認。0 行であること。
SELECT r.id, r.start_at, r.end_at, r.status
FROM reservations r
LEFT JOIN practitioner_busy_ranges pbr
  ON pbr.reservation_id = r.id
 AND pbr.source_type = 'reservation'
 AND pbr.released_at IS NULL
WHERE r.status NOT IN ('canceled')
  AND pbr.id IS NULL
ORDER BY r.start_at DESC
LIMIT 20;
```

```sql
-- outbox 未処理件数。pending / failed / dead が大量に残っている場合はリストア後に手動処理が必要。
SELECT status, COUNT(*)
FROM outbox_events
GROUP BY status
ORDER BY status;
```

```sql
-- 排他制約が有効か確認。
SELECT conname, contype
FROM pg_constraint
WHERE conrelid = 'practitioner_busy_ranges'::regclass;
-- exclusion 制約（contype = 'x'）が存在すること。
```

```sql
-- マスタデータ確認。
SELECT COUNT(*) FROM practitioners WHERE is_active = true;
SELECT COUNT(*) FROM menus WHERE is_active = true;
SELECT COUNT(*) FROM options WHERE is_active = true;
SELECT COUNT(*) FROM settings;
```

```sql
-- Google Calendar 同期状態確認。
SELECT COUNT(*) FROM calendar_sync_states;
SELECT status, COUNT(*)
FROM calendar_sync_conflicts
GROUP BY status
ORDER BY status;
```

## 5. 運用方針メモ

- RTO（目標復旧時間）の目安: 手動バックアップからのリストア作業で約 30〜60 分。Neon Instant restore のみで戻せる場合は短縮できるが、アプリ側確認と Cloud Run 切り替え時間を含めて評価する。
- RPO（目標復旧時点）の目安: Neon PITR が有効なら restore window 内の任意時点まで巻き戻し可能。実務上は障害発生直前の数分前を安全点にする。手動バックアップの場合は最後のバックアップ取得時刻まで。
- 推奨バックアップ頻度: 本番稼働後は最低 1 日 1 回。Cloud Scheduler での自動化は別 Issue とする。
- バックアップファイルの保管期間目安: 30 日間。GCS の Object Lifecycle で自動削除を設定する。
- バックアップファイルには顧客データ、予約データ、LINE user ID 等が含まれる。GCS bucket は最小権限にし、公開設定、共有 URL、ローカル端末への長期保存を避ける。
- 復旧訓練は本番接続文字列を使わず、確認用 Neon project / branch の `RESTORE_DB_URL` に対して実施する。
