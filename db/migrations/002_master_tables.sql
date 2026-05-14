-- Master data tables for DB-backed practitioners, menus, options, and settings.

BEGIN;

CREATE TABLE options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  additional_minutes integer NOT NULL DEFAULT 0 CHECK (additional_minutes >= 0),
  additional_price integer NOT NULL DEFAULT 0 CHECK (additional_price >= 0),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 1000,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX options_active_sort_idx ON options (is_active, sort_order, id);

CREATE TRIGGER options_set_updated_at
BEFORE UPDATE ON options
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE menu_options (
  menu_id uuid NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (menu_id, option_id)
);

CREATE INDEX menu_options_option_idx ON menu_options (option_id);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER settings_set_updated_at
BEFORE UPDATE ON settings
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
