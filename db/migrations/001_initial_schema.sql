-- Initial PostgreSQL schema for MVP-1 reservation consistency.
-- The central double-booking guard is practitioner_busy_ranges.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE reservation_status AS ENUM (
  'reserved',
  'completed',
  'canceled',
  'no_show'
);

CREATE TYPE staff_block_status AS ENUM (
  'active',
  'canceled'
);

CREATE TYPE block_source AS ENUM (
  'admin',
  'google_calendar',
  'system'
);

CREATE TYPE busy_source_type AS ENUM (
  'reservation',
  'staff_block'
);

CREATE TYPE outbox_status AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'failed',
  'dead'
);

CREATE TYPE reservation_created_via AS ENUM (
  'customer_liff',
  'staff_admin',
  'system'
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id text,
  name text,
  name_kana text,
  phone text,
  email text,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customers_line_user_id_uq
  ON customers (line_user_id)
  WHERE line_user_id IS NOT NULL;

CREATE INDEX customers_phone_idx
  ON customers (phone)
  WHERE phone IS NOT NULL;

CREATE TRIGGER customers_set_updated_at
BEFORE UPDATE ON customers
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE practitioners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  calendar_id text,
  title text,
  image_url text,
  description text,
  sns text,
  experience text,
  nomination_fee integer NOT NULL DEFAULT 0 CHECK (nomination_fee >= 0),
  pr_title text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1000,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX practitioners_calendar_id_uq
  ON practitioners (calendar_id)
  WHERE calendar_id IS NOT NULL;

CREATE INDEX practitioners_active_sort_idx
  ON practitioners (is_active, sort_order, id);

CREATE TRIGGER practitioners_set_updated_at
BEFORE UPDATE ON practitioners
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL DEFAULT '',
  name text NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  price integer NOT NULL DEFAULT 0 CHECK (price >= 0),
  description text,
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1000,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX menus_active_sort_idx
  ON menus (is_active, sort_order, id);

CREATE TRIGGER menus_set_updated_at
BEFORE UPDATE ON menus
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  line_user_id text,
  idempotency_key text,
  created_via reservation_created_via NOT NULL DEFAULT 'customer_liff',
  customer_name text NOT NULL,
  customer_phone text,
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  practitioner_name_snapshot text NOT NULL,
  menu_id uuid REFERENCES menus(id) ON DELETE SET NULL,
  menu_name_snapshot text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  time_range tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  status reservation_status NOT NULL DEFAULT 'reserved',
  total_minutes integer NOT NULL CHECK (total_minutes > 0),
  total_price integer NOT NULL DEFAULT 0 CHECK (total_price >= 0),
  calendar_event_id text,
  canceled_at timestamptz,
  cancel_reason text,
  completed_at timestamptz,
  no_show_at timestamptz,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (
    (created_via = 'customer_liff' AND line_user_id IS NOT NULL)
    OR created_via IN ('staff_admin', 'system')
  ),
  CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)
);

CREATE INDEX reservations_start_at_idx
  ON reservations (start_at);

CREATE INDEX reservations_practitioner_start_at_idx
  ON reservations (practitioner_id, start_at);

CREATE INDEX reservations_line_user_id_idx
  ON reservations (line_user_id)
  WHERE line_user_id IS NOT NULL;

CREATE UNIQUE INDEX reservations_line_user_id_idempotency_key_uq
  ON reservations (line_user_id, idempotency_key)
  WHERE line_user_id IS NOT NULL
    AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX reservations_calendar_event_id_uq
  ON reservations (calendar_event_id)
  WHERE calendar_event_id IS NOT NULL;

CREATE TRIGGER reservations_set_updated_at
BEFORE UPDATE ON reservations
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE staff_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  time_range tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  source block_source NOT NULL DEFAULT 'admin',
  status staff_block_status NOT NULL DEFAULT 'active',
  reason text,
  calendar_id text,
  external_event_id text,
  canceled_at timestamptz,
  cancel_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (status <> 'canceled' OR canceled_at IS NOT NULL)
);

CREATE INDEX staff_blocks_practitioner_time_idx
  ON staff_blocks USING gist (practitioner_id, time_range);

CREATE INDEX staff_blocks_status_start_at_idx
  ON staff_blocks (status, start_at);

CREATE UNIQUE INDEX staff_blocks_calendar_event_uq
  ON staff_blocks (calendar_id, external_event_id)
  WHERE source = 'google_calendar'
    AND calendar_id IS NOT NULL
    AND external_event_id IS NOT NULL;

CREATE TRIGGER staff_blocks_set_updated_at
BEFORE UPDATE ON staff_blocks
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE practitioner_busy_ranges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  source_type busy_source_type NOT NULL,
  reservation_id uuid REFERENCES reservations(id),
  staff_block_id uuid REFERENCES staff_blocks(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  time_range tstzrange GENERATED ALWAYS AS (tstzrange(start_at, end_at, '[)')) STORED,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  CHECK (
    (source_type = 'reservation' AND reservation_id IS NOT NULL AND staff_block_id IS NULL)
    OR
    (source_type = 'staff_block' AND staff_block_id IS NOT NULL AND reservation_id IS NULL)
  ),
  EXCLUDE USING gist (
    practitioner_id WITH =,
    time_range WITH &&
  ) WHERE (released_at IS NULL)
);

CREATE UNIQUE INDEX practitioner_busy_ranges_reservation_uq
  ON practitioner_busy_ranges (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE UNIQUE INDEX practitioner_busy_ranges_staff_block_uq
  ON practitioner_busy_ranges (staff_block_id)
  WHERE staff_block_id IS NOT NULL;

CREATE INDEX practitioner_busy_ranges_practitioner_time_idx
  ON practitioner_busy_ranges USING gist (practitioner_id, time_range)
  WHERE released_at IS NULL;

CREATE INDEX practitioner_busy_ranges_released_at_idx
  ON practitioner_busy_ranges (released_at)
  WHERE released_at IS NOT NULL;

CREATE TRIGGER practitioner_busy_ranges_set_updated_at
BEFORE UPDATE ON practitioner_busy_ranges
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, idempotency_key)
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (status, next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX outbox_events_processing_locked_idx
  ON outbox_events (locked_at, locked_by)
  WHERE status = 'processing';

CREATE INDEX outbox_events_aggregate_idx
  ON outbox_events (aggregate_type, aggregate_id);

CREATE TRIGGER outbox_events_set_updated_at
BEFORE UPDATE ON outbox_events
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text,
  actor_id text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  reservation_id uuid,
  staff_block_id uuid,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_at_idx
  ON audit_logs (created_at DESC);

CREATE INDEX audit_logs_entity_idx
  ON audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX audit_logs_actor_idx
  ON audit_logs (actor_type, actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_audit_logs_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_prevent_update
BEFORE UPDATE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_logs_mutation();

CREATE TRIGGER audit_logs_prevent_delete
BEFORE DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION prevent_audit_logs_mutation();

COMMIT;
