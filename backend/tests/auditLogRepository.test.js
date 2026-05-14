const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuditLog } = require('../repositories/auditLogs');

const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

test('createAuditLog inserts reservation cancellation audit data', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: '44444444-4444-4444-8444-444444444444',
                    actor_type: params[1],
                    actor_id: params[2],
                    action: params[3],
                    entity_type: params[4],
                    entity_id: params[5],
                    reservation_id: params[6],
                    metadata: params[10],
                }],
            };
        },
    };

    const auditLog = await createAuditLog(client, {
        actorType: 'customer',
        actorId: 'Uverified',
        action: 'reservation.canceled',
        entityType: 'reservation',
        entityId: RESERVATION_ID,
        reservationId: RESERVATION_ID,
        beforeData: { status: 'reserved' },
        afterData: { status: 'canceled' },
        metadata: { source: 'customer_liff' },
    });

    assert.equal(auditLog.action, 'reservation.canceled');
    assert.match(queries[0].text, /INSERT INTO audit_logs/);
    assert.deepEqual(queries[0].params, [
        null,
        'customer',
        'Uverified',
        'reservation.canceled',
        'reservation',
        RESERVATION_ID,
        RESERVATION_ID,
        null,
        { status: 'reserved' },
        { status: 'canceled' },
        { source: 'customer_liff' },
    ]);
});
