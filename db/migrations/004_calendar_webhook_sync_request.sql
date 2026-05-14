-- Track Google Calendar webhook notifications as sync requests.

BEGIN;

ALTER TABLE calendar_sync_states
  ADD COLUMN sync_requested_at timestamptz,
  ADD COLUMN last_notification_at timestamptz,
  ADD COLUMN last_notification_state text,
  ADD COLUMN last_notification_message_number text;

CREATE INDEX calendar_sync_states_sync_requested_at_idx
  ON calendar_sync_states (sync_requested_at)
  WHERE sync_requested_at IS NOT NULL;

COMMIT;
