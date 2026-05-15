const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findBlockingBusyRange,
    resolveOpenConflictForEvent,
    upsertOpenConflict,
} = require('../repositories/calendarSyncConflicts');

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_BLOCK_ID = '33333333-3333-4333-8333-333333333333';

test('findBlockingBusyRange searches active overlapping busy ranges', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: 'busy-range-1',
                    source_type: 'reservation',
                    reservation_id: RESERVATION_ID,
                    staff_block_id: null,
                }],
            };
        },
    };

    const busyRange = await findBlockingBusyRange(client, {
        practitionerId: PRACTITIONER_ID,
        startAt: '2026-06-01T01:00:00.000Z',
        endAt: '2026-06-01T02:00:00.000Z',
        excludeStaffBlockId: STAFF_BLOCK_ID,
    });

    assert.equal(busyRange.reservation_id, RESERVATION_ID);
    assert.match(queries[0].text, /FROM practitioner_busy_ranges/);
    assert.match(queries[0].text, /released_at IS NULL/);
    assert.match(queries[0].text, /time_range && tstzrange/);
    assert.match(queries[0].text, /staff_block_id IS DISTINCT FROM/);
    assert.deepEqual(queries[0].params, [
        PRACTITIONER_ID,
        '2026-06-01T01:00:00.000Z',
        '2026-06-01T02:00:00.000Z',
        STAFF_BLOCK_ID,
    ]);
});

test('upsertOpenConflict uses the open event idempotency key', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: 'conflict-1',
                    practitioner_id: PRACTITIONER_ID,
                    calendar_event_id: 'event-1',
                    reservation_id: RESERVATION_ID,
                    status: 'open',
                }],
            };
        },
    };

    const conflict = await upsertOpenConflict(client, {
        practitionerId: PRACTITIONER_ID,
        calendarId: 'staff-a@example.com',
        calendarEventId: 'event-1',
        reservationId: RESERVATION_ID,
        staffBlockId: null,
        detail: { reason: 'busy_range_conflict' },
    });

    assert.equal(conflict.status, 'open');
    assert.match(queries[0].text, /INSERT INTO calendar_sync_conflicts/);
    assert.match(queries[0].text, /ON CONFLICT/);
    assert.match(queries[0].text, /COALESCE\(calendar_id, ''\)/);
    assert.match(queries[0].text, /WHERE status = 'open'/);
    assert.match(queries[0].text, /detail = EXCLUDED.detail/);
    assert.deepEqual(queries[0].params, [
        PRACTITIONER_ID,
        'staff-a@example.com',
        'event-1',
        RESERVATION_ID,
        null,
        { reason: 'busy_range_conflict' },
    ]);
});

test('upsertOpenConflict skips events without an id', async () => {
    const client = {
        async query() {
            throw new Error('query should not be called');
        },
    };

    const conflict = await upsertOpenConflict(client, {
        practitionerId: PRACTITIONER_ID,
        calendarId: 'staff-a@example.com',
        calendarEventId: null,
        detail: { reason: 'busy_range_conflict' },
    });

    assert.equal(conflict, null);
});

test('resolveOpenConflictForEvent marks the open event conflict resolved', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: 'conflict-1',
                    status: 'resolved',
                    resolved_at: new Date('2026-05-14T00:00:00.000Z'),
                }],
            };
        },
    };

    const conflict = await resolveOpenConflictForEvent(client, {
        practitionerId: PRACTITIONER_ID,
        calendarId: 'staff-a@example.com',
        calendarEventId: 'event-1',
        reason: 'event_imported',
        source: 'calendar_staff_block_import',
    });

    assert.equal(conflict.status, 'resolved');
    assert.match(queries[0].text, /UPDATE calendar_sync_conflicts/);
    assert.match(queries[0].text, /status = 'resolved'::calendar_conflict_status/);
    assert.match(queries[0].text, /resolved_at = COALESCE\(resolved_at, now\(\)\)/);
    assert.match(queries[0].text, /calendar_event_id = \$3/);
    assert.deepEqual(queries[0].params, [
        PRACTITIONER_ID,
        'staff-a@example.com',
        'event-1',
        'event_imported',
        'calendar_staff_block_import',
    ]);
});
