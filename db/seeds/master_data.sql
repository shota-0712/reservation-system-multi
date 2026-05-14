-- practitioners
INSERT INTO practitioners (name, calendar_id, title, is_active, sort_order)
VALUES ('施術者A', null, '', true, 1);

-- menus
INSERT INTO menus (category, name, minutes, price, is_active, sort_order)
VALUES ('カット', 'カット', 60, 5000, true, 1);

-- options
INSERT INTO options (name, additional_minutes, additional_price, is_active, sort_order)
VALUES ('トリートメント', 15, 1000, true, 1);

-- settings
INSERT INTO settings (key, value) VALUES
  ('startHour', '10'),
  ('endHour', '20'),
  ('regularHolidays', '[]'),
  ('holidays', '[]'),
  ('temporaryBusinessDays', '[]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
