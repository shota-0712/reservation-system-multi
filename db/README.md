# DB

PostgreSQL schema migrations and SQL smoke tests live under this directory.

## Apply Migrations

Run migrations against an empty database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_master_tables.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_calendar_sync_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/004_calendar_webhook_sync_request.sql
```

## Calendar Sync Schema

`calendar_sync_states` stores the per-practitioner Google Calendar watch
channel, webhook validation token, and incremental `syncToken` state.
`calendar_sync_states.channel_token` is a webhook verification secret and
must not be logged.
Webhook notifications update `sync_requested_at` and `last_notification_at`;
later sync workers can pick rows where the requested timestamp is newer than
the last completed sync.

`calendar_sync_conflicts` stores unresolved Calendar block ingestion conflicts
so operators can inspect sync lag or reservation collisions without changing
existing reservations automatically.

Google Calendar unavailable blocks are ingested as `staff_blocks` with
`source = 'google_calendar'`. The existing partial unique index on
`staff_blocks(calendar_id, external_event_id)` is the idempotency guard for
duplicate Calendar events. Events created by this system are expected to carry
`extendedProperties.private.source = reservation_system`; later sync workers
must skip those events instead of importing them as staff blocks.

## Smoke Tests

Run the busy range smoke test after applying migrations:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/001_busy_ranges.sql
```

`db/tests/001_busy_ranges.sql` verifies that `practitioner_busy_ranges`
rejects overlapping active ranges for the same practitioner across
reservations and staff blocks, and that setting `released_at` frees the
same time range for reuse. The test wraps its data in a transaction and
rolls back at the end, so it can be rerun against the same migrated test DB.
