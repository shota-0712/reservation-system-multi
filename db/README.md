# DB

PostgreSQL schema migrations and SQL smoke tests live under this directory.

## Apply Migrations

Run migrations against an empty database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
```

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
