const test = require('node:test');
const assert = require('node:assert/strict');

const {
    cancelReservation,
    createReservation,
    findReservationByIdForUpdate,
    releaseReservationBusyRange,
} = require('../repositories/reservations');

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

test('findReservationByIdForUpdate locks the reservation row', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{ id: RESERVATION_ID }],
            };
        },
    };

    const reservation = await findReservationByIdForUpdate(client, RESERVATION_ID);

    assert.equal(reservation.id, RESERVATION_ID);
    assert.match(queries[0].text, /FOR UPDATE/);
    assert.deepEqual(queries[0].params, [RESERVATION_ID]);
});

test('cancelReservation marks reservation canceled with cancel reason', async () => {
    const canceledAt = new Date('2099-01-01T00:00:00.000Z');
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: RESERVATION_ID,
                    status: 'canceled',
                    canceled_at: canceledAt,
                    cancel_reason: 'customer request',
                }],
            };
        },
    };

    const reservation = await cancelReservation(client, {
        reservationId: RESERVATION_ID,
        cancelReason: 'customer request',
    });

    assert.equal(reservation.status, 'canceled');
    assert.equal(reservation.cancel_reason, 'customer request');
    assert.match(queries[0].text, /UPDATE reservations/);
    assert.match(queries[0].text, /canceled_at = COALESCE\(canceled_at, now\(\)\)/);
    assert.deepEqual(queries[0].params, [RESERVATION_ID, 'customer request']);
});

test('releaseReservationBusyRange releases the reservation busy range', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: 'busy-range-1',
                    reservation_id: RESERVATION_ID,
                    released_at: new Date('2099-01-01T00:00:00.000Z'),
                }],
            };
        },
    };

    const busyRange = await releaseReservationBusyRange(client, RESERVATION_ID);

    assert.equal(busyRange.reservation_id, RESERVATION_ID);
    assert.match(queries[0].text, /UPDATE practitioner_busy_ranges/);
    assert.match(queries[0].text, /released_at = COALESCE\(released_at, now\(\)\)/);
    assert.deepEqual(queries[0].params, [RESERVATION_ID]);
});
