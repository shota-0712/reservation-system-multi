# 実装Issue分割案

作成日: 2026-05-13
対象設計書: `docs/single-tenant-architecture-requirements.md` Draft v0.6
GitHub Issues: https://github.com/shota-0712/reservation-system-multi/issues/1 〜 https://github.com/shota-0712/reservation-system-multi/issues/18

## 方針

- まずMVP-1に集中する。Google Calendarの双方向同期はMVP-2へ回す。
- 1 Issue = 1つの検証可能な成果物にする。
- DB制約、トランザクション、冪等性、本人性検証を先に固める。
- UIやマスタデータ移行は、予約整合性の土台ができてから進める。
- GitHub Issue化する場合は、この文書の各Issueを1つずつ起票する。

## Milestone 0: 実装準備

### Issue 1: DB providerとローカルPostgres方針を確定する

Labels: `type:decision`, `area:db`, `priority:p0`

目的:
Neonを第一候補として、ローカル開発と本番DBの接続・migration方針を確定する。

Scope:
- Neon採用可否を最終決定する。
- ローカルPostgresの起動方法を決める。
- migration実行方法を決める。
- `.env.example` にDB接続設定の方針を追記する。

Acceptance criteria:
- DB providerが明文化されている。
- ローカルDBの起動・接続方法がREADMEにある。
- migration実行コマンドが決まっている。

Out of scope:
- 実テーブル作成。
- アプリからのDB接続実装。

## Milestone 1: DB基盤

### Issue 2: 初回Postgres migrationを作成する

Labels: `type:feature`, `area:db`, `priority:p0`

目的:
MVP-1に必要なDBスキーマをmigrationとして作成する。

Scope:
- `reservations`
- `staff_blocks`
- `practitioner_busy_ranges`
- `outbox_events`
- `audit_logs`
- `customers`
- `practitioners`
- 最低限の `menus`
- `updated_at` trigger
- `btree_gist` extension

Acceptance criteria:
- migrationが空DBに適用できる。
- `practitioner_busy_ranges` に排他制約がある。
- 予約キャンセル時に枠解放できるカラムがある。
- outboxに `locked_at` / `locked_by` がある。

Out of scope:
- Google Calendar webhook用テーブル。
- master data完全移行。

Depends on:
- Issue 1

### Issue 3: 予約整合性のDBスモークテストを追加する

Labels: `type:test`, `area:db`, `priority:p0`

目的:
DB制約が期待どおり動くことをSQLレベルで検証する。

Acceptance criteria:
- 同一施術者・同一時間帯の予約が2件入らない。
- 予約とstaff blockが同じ時間帯で共存しない。
- 予約キャンセル時にbusy rangeを解放すると、その時間にblockを作れる。
- テスト手順がREADMEにある。

Depends on:
- Issue 2

## Milestone 2: API基盤

### Issue 4: DB接続層とrepository層を追加する

Labels: `type:feature`, `area:backend`, `priority:p0`

目的:
Sheets直書きからDB repositoryへ移行するための接続基盤を作る。

Scope:
- `pg` などPostgres client導入。
- DB pool作成。
- transaction helper作成。
- reservation/staff block/outbox用repositoryの雛形作成。

Acceptance criteria:
- APIからDBへ接続できる。
- transaction内で複数repository操作ができる。
- 接続情報は環境変数から読む。

Depends on:
- Issue 2

### Issue 5: LIFF ID token検証を追加する

Labels: `type:security`, `area:auth`, `priority:p0`

目的:
リクエストbodyの `line_user_id` を信用せず、LINE ID token検証結果を本人性の根拠にする。

Scope:
- フロントからID tokenを送る。
- APIでID tokenを検証する。
- 検証結果の `sub` を `line_user_id` として使う。
- 予約作成、履歴取得、顧客キャンセルに適用する。

Acceptance criteria:
- bodyの `line_user_id` を改ざんしても本人として扱われない。
- ID tokenなしの顧客APIは拒否される。
- 管理者APIとの責務が分かれている。

Out of scope:
- 管理者ログイン全面刷新。

## Milestone 3: 予約作成MVP

### Issue 6: DB正本の予約作成APIを実装する

Labels: `type:feature`, `area:reservation`, `priority:p0`

目的:
予約作成をDB transaction中心に置き換える。

Scope:
- `reservations` INSERT。
- `practitioner_busy_ranges` INSERT。
- `outbox_events` INSERT。
- `idempotency_key` 対応。
- 排他制約違反時の409相当レスポンス。

Acceptance criteria:
- 予約作成成功時にDBへ予約とbusy rangeが作られる。
- busy range重複時は予約もrollbackされる。
- 同じ `line_user_id + idempotency_key` の再送は既存予約として扱える。
- Google CalendarやLINE通知失敗で予約DBが壊れない。

Depends on:
- Issue 3
- Issue 4
- Issue 5

### Issue 7: 予約キャンセルとbusy range解放を実装する

Labels: `type:feature`, `area:reservation`, `priority:p0`

目的:
予約キャンセル時に予約状態と枠解放を同一トランザクションで行う。

Scope:
- `reservations.status = canceled`
- `reservations.canceled_at`
- `practitioner_busy_ranges.released_at`
- 顧客キャンセルの24時間制限
- 管理者キャンセルは制限除外
- `audit_logs` 記録

Acceptance criteria:
- 片方だけ更新される状態がない。
- 顧客は24時間前を過ぎるとキャンセルできない。
- 管理者キャンセルは理由つきで監査ログに残る。

Depends on:
- Issue 6

### Issue 8: 指名なし予約の並行実行対応を実装する

Labels: `type:feature`, `area:reservation`, `priority:p0`

目的:
複数施術者候補から、DB制約に基づいて安全に担当者を割り当てる。

Scope:
- 候補施術者の順序ランダム化または公平化。
- 候補ごとに `reservations + practitioner_busy_ranges` を同一transactionで試行。
- 排他制約違反なら次候補へ進む。

Acceptance criteria:
- 同時に複数リクエストが来ても同一施術者・同一時間帯に重複しない。
- 候補が全員埋まっている場合は満席として返る。

Depends on:
- Issue 6

## Milestone 4: Outbox

### Issue 9: outbox worker / batchを実装する

Labels: `type:feature`, `area:outbox`, `priority:p0`

目的:
Google Calendar作成・LINE通知を予約transactionから分離して処理する。

Scope:
- `POST /api/batch/outbox`
- pending/failedイベントのclaim
- `processing`, `locked_at`, `locked_by`
- 成功時 `succeeded`
- 失敗時 `failed`, `attempt_count`, `next_attempt_at`, `last_error`
- stale processingの再試行方針

Acceptance criteria:
- 外部API呼び出し中にDB lockを持ち続けない。
- workerが途中で落ちても再試行できる。
- 同じoutbox eventを二重処理しない。

Depends on:
- Issue 6

### Issue 10: Google Calendar反映をoutbox経由にする

Labels: `type:feature`, `area:calendar`, `priority:p1`

目的:
DB予約をGoogle Calendarへ片方向反映する。

Scope:
- 予約作成イベントをCalendarへ作成。
- 予約キャンセル時にCalendarイベント削除またはキャンセル反映。
- Calendar event IDを予約UUIDから決定的に生成する。
- `extendedProperties.private.source = reservation_system`
- `extendedProperties.private.reservation_id`

Acceptance criteria:
- 再試行で同じ予約のCalendarイベントが重複作成されない。
- システム作成イベントを後続のCalendar同期で識別できる。

Depends on:
- Issue 9

### Issue 11: LINE通知をoutbox経由にする

Labels: `type:feature`, `area:line`, `priority:p1`

目的:
予約完了・キャンセル・管理者通知をoutbox経由に移す。

Acceptance criteria:
- LINE API失敗で予約作成/キャンセルtransactionが失敗しない。
- 失敗通知は再試行される。
- ユーザー通知と管理者通知の冪等性キーが分かれている。

Depends on:
- Issue 9

## Milestone 5: スタッフ/管理画面

### Issue 12: スタッフ/管理画面から代理予約を作成できるようにする

Labels: `type:feature`, `area:admin`, `priority:p1`

目的:
電話予約・店頭予約をGoogle Calendarではなくシステムから登録できるようにする。

Scope:
- 管理者またはスタッフ権限チェック。
- `created_via = staff_admin`
- LINE未連携顧客でも予約可能。
- busy range制約は顧客予約と同じ。

Acceptance criteria:
- スタッフ作成予約も通常予約と同じ重複防止が効く。
- Google Calendarへ片方向反映される。
- 監査ログに操作者が残る。

Depends on:
- Issue 6
- Issue 10

### Issue 13: スタッフ/管理画面から予約不可ブロックを登録できるようにする

Labels: `type:feature`, `area:admin`, `priority:p1`

目的:
MVP-1ではGoogle Calendar同期に頼らず、システム画面から休憩・私用・指名不可を登録する。

Scope:
- `staff_blocks` INSERT。
- `practitioner_busy_ranges` INSERT。
- ブロック取消。
- 予約との競合時エラー表示。

Acceptance criteria:
- 予約がある時間にblockを作れない。
- blockがある時間に予約を作れない。
- block取消時にbusy rangeが解放される。

Depends on:
- Issue 4

## Milestone 6: マスタデータDB化

### Issue 14: practitioners / menus / options / settingsをDB化する

Labels: `type:feature`, `area:data`, `priority:p1`

目的:
Sheets正本からDB正本へ段階移行する。

Scope:
- `practitioners`
- `menus`
- `options`
- `menu_options`
- `settings`
- 既存Sheetsデータのimport手順

Acceptance criteria:
- 予約作成に必要なマスタをDBから読める。
- 管理画面のCRUDがDBへ保存される。
- Sheetsは正本として使わない。

Depends on:
- Issue 4

## Milestone 7: テナント運用

### Issue 15: Secret Manager前提の本番設定に整理する

Labels: `type:infra`, `area:security`, `priority:p1`

目的:
DB URLやLINE tokenを通常envやGitHub Secrets直注入からSecret Manager参照へ寄せる。

Acceptance criteria:
- DB URL, LINE token, Scheduler secretがSecret Manager管理になる。
- Cloud Run service accountに必要最小限のsecret access権限がある。
- 非機密設定と機密設定が分離されている。

### Issue 16: テナント台帳の初期版を作る

Labels: `type:infra`, `area:tenant-ops`, `priority:p2`

目的:
新規サロン追加とデプロイ対象管理の入口を作る。

Acceptance criteria:
- サロンID、Cloud Run service、DB、Calendar、LIFF、LINE、状態を一覧できる。
- 1サロン目の設定が台帳に登録できる。

### Issue 17: サロン別Cloud Run deployの形にする

Labels: `type:infra`, `area:deploy`, `priority:p2`

目的:
1リポジトリ・複数Cloud Run serviceの運用へ移行する。

Acceptance criteria:
- 同じimageをサロン別serviceへdeployできる。
- サロンごとのenv/secretを分けられる。
- 将来的なmatrix deployへ拡張しやすい。

## Milestone 8: MVP-2

### Issue 18: Google Calendarの予約不可ブロック同期を実装する

Labels: `type:feature`, `area:calendar`, `priority:p2`

目的:
Google Calendarに直接入れた休憩・私用・指名不可をDBへ取り込む。予約はGoogle Calendarから作らない。

Scope:
- `events.watch` webhook。
- `syncToken` 差分同期。
- `channel_token` 検証。
- `source = reservation_system` イベント除外。
- `staff_blocks(calendar_id, external_event_id)` の冪等取り込み。
- 繰り返し予定は原則禁止。許可時は `singleEvents=true` で個別block化。

Acceptance criteria:
- システム作成予約イベントを `staff_blocks` として取り込まない。
- 同じCalendar eventを重複取り込みしない。
- 既存予約と衝突したblockは `calendar_sync_conflicts` に記録される。

Depends on:
- Issue 10
- Issue 13

## 推奨実装順

1. Issue 1
2. Issue 2
3. Issue 3
4. Issue 4
5. Issue 5
6. Issue 6
7. Issue 7
8. Issue 8
9. Issue 9
10. Issue 10
11. Issue 11
12. Issue 12
13. Issue 13
14. Issue 14
15. Issue 15
16. Issue 16
17. Issue 17
18. Issue 18
