const test = require('node:test');
const assert = require('node:assert/strict');

const { createReservation } = require('../repositories/reservations');

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

test('createReservation inserts reservation and practitioner busy range with the same client', async () => {
    const startAt = new Date('2099-01-01T01:00:00.000Z');
    const endAt = new Date('2099-01-01T02:00:00.000Z');
    const queries = [];

    const client = {
        async query(text, params) {
            queries.push({ text, params });

            if (text.includes('INSERT INTO reservations')) {
                return {
                    rows: [{
                        id: RESERVATION_ID,
                        practitioner_id: PRACTITIONER_ID,
                        start_at: startAt,
                        end_at: endAt,
                    }],
                };
            }

            if (text.includes('INSERT INTO practitioner_busy_ranges')) {
                return { rows: [] };
            }

            throw new Error(`Unexpected query: ${text}`);
        },
    };

    const reservation = await createReservation(client, {
        lineUserId: 'Uverified',
        idempotencyKey: 'reservation-key-1',
        customerName: 'Customer',
        customerPhone: '090-0000-0000',
        practitionerId: PRACTITIONER_ID,
        practitionerNameSnapshot: 'Staff',
        menuId: null,
        menuNameSnapshot: 'Menu',
        startAt,
        endAt,
        totalMinutes: 60,
        totalPrice: 10000,
        metadata: {},
    });

    assert.equal(reservation.id, RESERVATION_ID);
    assert.equal(queries.length, 2);
    assert.match(queries[0].text, /INSERT INTO reservations/);
    assert.match(queries[1].text, /INSERT INTO practitioner_busy_ranges/);
    assert.deepEqual(queries[1].params, [
        PRACTITIONER_ID,
        RESERVATION_ID,
        startAt,
        endAt,
    ]);
});
