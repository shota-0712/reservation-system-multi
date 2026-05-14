const test = require('node:test');
const assert = require('node:assert/strict');

const {
    cancelGoogleCalendarStaffBlock,
    upsertGoogleCalendarStaffBlock,
    upsertStaffBlockBusyRange,
} = require('../repositories/staffBlocks');

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_BLOCK_ID = '44444444-4444-4444-8444-444444444444';

test('upsertGoogleCalendarStaffBlock uses calendar event unique key', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: STAFF_BLOCK_ID,
                    practitioner_id: PRACTITIONER_ID,
                    calendar_id: 'staff-a@example.com',
                    external_event_id: 'event-1',
                    inserted: true,
                }],
            };
        },
    };

    const staffBlock = await upsertGoogleCalendarStaffBlock(client, {
        practitionerId: PRACTITIONER_ID,
        startAt: '2026-06-01T01:00:00.000Z',
        endAt: '2026-06-01T02:00:00.000Z',
        reason: 'Private appointment',
        calendarId: 'staff-a@example.com',
        externalEventId: 'event-1',
        externalEventEtag: '"etag-1"',
        externalEventUpdatedAt: '2026-05-14T01:00:00.000Z',
        metadata: { google_calendar: { status: 'confirmed' } },
    });

    assert.equal(staffBlock.id, STAFF_BLOCK_ID);
    assert.match(queries[0].text, /INSERT INTO staff_blocks/);
    assert.match(queries[0].text, /ON CONFLICT \(calendar_id, external_event_id\)/);
    assert.match(queries[0].text, /status = 'active'::staff_block_status/);
    assert.deepEqual(queries[0].params.slice(0, 8), [
        PRACTITIONER_ID,
        '2026-06-01T01:00:00.000Z',
        '2026-06-01T02:00:00.000Z',
        'Private appointment',
        'staff-a@example.com',
        'event-1',
        '"etag-1"',
        '2026-05-14T01:00:00.000Z',
    ]);
});

test('upsertStaffBlockBusyRange reuses the staff block busy row', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: 'busy-range-1',
                    staff_block_id: STAFF_BLOCK_ID,
                    released_at: null,
                }],
            };
        },
    };

    const busyRange = await upsertStaffBlockBusyRange(client, {
        id: STAFF_BLOCK_ID,
        practitioner_id: PRACTITIONER_ID,
        start_at: '2026-06-01T01:00:00.000Z',
        end_at: '2026-06-01T02:00:00.000Z',
    });

    assert.equal(busyRange.staff_block_id, STAFF_BLOCK_ID);
    assert.match(queries[0].text, /INSERT INTO practitioner_busy_ranges/);
    assert.match(queries[0].text, /ON CONFLICT \(staff_block_id\)/);
    assert.match(queries[0].text, /released_at = NULL/);
    assert.deepEqual(queries[0].params, [
        PRACTITIONER_ID,
        STAFF_BLOCK_ID,
        '2026-06-01T01:00:00.000Z',
        '2026-06-01T02:00:00.000Z',
    ]);
});

test('cancelGoogleCalendarStaffBlock marks block canceled without deleting it', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: STAFF_BLOCK_ID,
                    status: 'canceled',
                    canceled_at: new Date('2026-05-14T00:00:00.000Z'),
                }],
            };
        },
    };

    const staffBlock = await cancelGoogleCalendarStaffBlock(client, {
        id: STAFF_BLOCK_ID,
        cancelReason: 'google_calendar_cancelled',
        externalEventEtag: '"etag-2"',
        externalEventUpdatedAt: '2026-05-14T02:00:00.000Z',
        metadata: { google_calendar: { status: 'cancelled' } },
    });

    assert.equal(staffBlock.status, 'canceled');
    assert.match(queries[0].text, /UPDATE staff_blocks/);
    assert.match(queries[0].text, /status = 'canceled'::staff_block_status/);
    assert.match(queries[0].text, /source = 'google_calendar'::block_source/);
    assert.deepEqual(queries[0].params.slice(0, 4), [
        STAFF_BLOCK_ID,
        'google_calendar_cancelled',
        '"etag-2"',
        '2026-05-14T02:00:00.000Z',
    ]);
});
