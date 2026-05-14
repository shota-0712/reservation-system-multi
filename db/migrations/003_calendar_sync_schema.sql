-- Calendar sync schema for Google Calendar unavailable-block ingestion.
-- This migration only adds sync state, conflict recording, and external event
-- metadata needed by later webhook and syncToken workers.

BEGIN;

CREATE TYPE calendar_conflict_status AS ENUM (
  'open',
  'resolved',
  'ignored'
);

ALTER TABLE staff_blocks
  ADD COLUMN external_event_etag text,
  ADD COLUMN external_event_updated_at timestamptz;

CREATE TABLE calendar_sync_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  calendar_id text NOT NULL,
  sync_token text,
  channel_id text,
  channel_resource_id text,
  channel_token text,
  watch_expires_at timestamptz,
  last_synced_at timestamptz,
  last_full_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (practitioner_id, calendar_id)
);

CREATE UNIQUE INDEX calendar_sync_states_channel_id_uq
  ON calendar_sync_states (channel_id)
  WHERE channel_id IS NOT NULL;

CREATE INDEX calendar_sync_states_watch_expires_at_idx
  ON calendar_sync_states (watch_expires_at)
  WHERE watch_expires_at IS NOT NULL;

CREATE TRIGGER calendar_sync_states_set_updated_at
BEFORE UPDATE ON calendar_sync_states
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE calendar_sync_conflicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  calendar_id text,
  calendar_event_id text,
  reservation_id uuid REFERENCES reservations(id),
  staff_block_id uuid REFERENCES staff_blocks(id),
  status calendar_conflict_status NOT NULL DEFAULT 'open',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (status <> 'resolved' OR resolved_at IS NOT NULL)
);

CREATE UNIQUE INDEX calendar_sync_conflicts_open_event_uq
  ON calendar_sync_conflicts (
    practitioner_id,
    (COALESCE(calendar_id, '')),
    calendar_event_id
  )
  WHERE status = 'open'
    AND calendar_event_id IS NOT NULL;

CREATE INDEX calendar_sync_conflicts_status_created_at_idx
  ON calendar_sync_conflicts (status, created_at);

CREATE INDEX calendar_sync_conflicts_practitioner_created_at_idx
  ON calendar_sync_conflicts (practitioner_id, created_at DESC);

CREATE TRIGGER calendar_sync_conflicts_set_updated_at
BEFORE UPDATE ON calendar_sync_conflicts
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
