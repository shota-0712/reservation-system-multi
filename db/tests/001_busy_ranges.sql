-- Smoke tests for practitioner_busy_ranges reservation consistency.
-- Run after applying db/migrations/001_initial_schema.sql.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO practitioners (
  id,
  name,
  sort_order
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  'Smoke Test Practitioner',
  1
);

INSERT INTO reservations (
  id,
  created_via,
  customer_name,
  practitioner_id,
  practitioner_name_snapshot,
  menu_name_snapshot,
  start_at,
  end_at,
  total_minutes,
  total_price
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  'staff_admin',
  'Smoke Reservation 1',
  '10000000-0000-0000-0000-000000000001',
  'Smoke Test Practitioner',
  'Smoke Menu',
  '2026-06-01 10:00:00+09',
  '2026-06-01 11:00:00+09',
  60,
  10000
);

INSERT INTO practitioner_busy_ranges (
  id,
  practitioner_id,
  source_type,
  reservation_id,
  start_at,
  end_at
) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'reservation',
  '20000000-0000-0000-0000-000000000001',
  '2026-06-01 10:00:00+09',
  '2026-06-01 11:00:00+09'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO reservations (
      id,
      created_via,
      customer_name,
      practitioner_id,
      practitioner_name_snapshot,
      menu_name_snapshot,
      start_at,
      end_at,
      total_minutes,
      total_price
    ) VALUES (
      '20000000-0000-0000-0000-000000000002',
      'staff_admin',
      'Smoke Reservation 2',
      '10000000-0000-0000-0000-000000000001',
      'Smoke Test Practitioner',
      'Smoke Menu',
      '2026-06-01 10:30:00+09',
      '2026-06-01 11:30:00+09',
      60,
      10000
    );

    INSERT INTO practitioner_busy_ranges (
      id,
      practitioner_id,
      source_type,
      reservation_id,
      start_at,
      end_at
    ) VALUES (
      '40000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000001',
      'reservation',
      '20000000-0000-0000-0000-000000000002',
      '2026-06-01 10:30:00+09',
      '2026-06-01 11:30:00+09'
    );

    RAISE EXCEPTION 'expected exclusion_violation for overlapping reservation busy range';
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE NOTICE 'ok: overlapping reservation busy range was rejected';
  END;
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO staff_blocks (
      id,
      practitioner_id,
      start_at,
      end_at,
      source,
      reason
    ) VALUES (
      '30000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      '2026-06-01 10:15:00+09',
      '2026-06-01 10:45:00+09',
      'admin',
      'overlap with existing reservation'
    );

    INSERT INTO practitioner_busy_ranges (
      id,
      practitioner_id,
      source_type,
      staff_block_id,
      start_at,
      end_at
    ) VALUES (
      '40000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000001',
      'staff_block',
      '30000000-0000-0000-0000-000000000001',
      '2026-06-01 10:15:00+09',
      '2026-06-01 10:45:00+09'
    );

    RAISE EXCEPTION 'expected exclusion_violation for staff block overlapping reservation';
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE NOTICE 'ok: staff block overlapping reservation was rejected';
  END;
END $$;

INSERT INTO staff_blocks (
  id,
  practitioner_id,
  start_at,
  end_at,
  source,
  reason
) VALUES (
  '30000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001',
  '2026-06-01 12:00:00+09',
  '2026-06-01 13:00:00+09',
  'admin',
  'active block before reservation'
);

INSERT INTO practitioner_busy_ranges (
  id,
  practitioner_id,
  source_type,
  staff_block_id,
  start_at,
  end_at
) VALUES (
  '40000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000001',
  'staff_block',
  '30000000-0000-0000-0000-000000000002',
  '2026-06-01 12:00:00+09',
  '2026-06-01 13:00:00+09'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO reservations (
      id,
      created_via,
      customer_name,
      practitioner_id,
      practitioner_name_snapshot,
      menu_name_snapshot,
      start_at,
      end_at,
      total_minutes,
      total_price
    ) VALUES (
      '20000000-0000-0000-0000-000000000003',
      'staff_admin',
      'Smoke Reservation 3',
      '10000000-0000-0000-0000-000000000001',
      'Smoke Test Practitioner',
      'Smoke Menu',
      '2026-06-01 12:30:00+09',
      '2026-06-01 13:30:00+09',
      60,
      10000
    );

    INSERT INTO practitioner_busy_ranges (
      id,
      practitioner_id,
      source_type,
      reservation_id,
      start_at,
      end_at
    ) VALUES (
      '40000000-0000-0000-0000-000000000005',
      '10000000-0000-0000-0000-000000000001',
      'reservation',
      '20000000-0000-0000-0000-000000000003',
      '2026-06-01 12:30:00+09',
      '2026-06-01 13:30:00+09'
    );

    RAISE EXCEPTION 'expected exclusion_violation for reservation overlapping staff block';
  EXCEPTION
    WHEN exclusion_violation THEN
      RAISE NOTICE 'ok: reservation overlapping staff block was rejected';
  END;
END $$;

UPDATE reservations
SET status = 'canceled',
    canceled_at = '2026-06-01 09:30:00+09',
    cancel_reason = 'smoke test cancellation'
WHERE id = '20000000-0000-0000-0000-000000000001';

UPDATE practitioner_busy_ranges
SET released_at = '2026-06-01 09:30:00+09'
WHERE reservation_id = '20000000-0000-0000-0000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM reservations r
    JOIN practitioner_busy_ranges b ON b.reservation_id = r.id
    WHERE r.id = '20000000-0000-0000-0000-000000000001'
      AND r.status = 'canceled'
      AND r.canceled_at IS NOT NULL
      AND b.released_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'expected canceled reservation and released busy range';
  END IF;
END $$;

INSERT INTO staff_blocks (
  id,
  practitioner_id,
  start_at,
  end_at,
  source,
  reason
) VALUES (
  '30000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000001',
  '2026-06-01 10:00:00+09',
  '2026-06-01 11:00:00+09',
  'admin',
  'reuse released reservation slot'
);

INSERT INTO practitioner_busy_ranges (
  id,
  practitioner_id,
  source_type,
  staff_block_id,
  start_at,
  end_at
) VALUES (
  '40000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000001',
  'staff_block',
  '30000000-0000-0000-0000-000000000003',
  '2026-06-01 10:00:00+09',
  '2026-06-01 11:00:00+09'
);

ROLLBACK;
