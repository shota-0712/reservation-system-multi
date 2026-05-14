const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

function adminReservationPayload(overrides = {}) {
    return {
        adminId: 'Uadmin',
        practitionerId: PRACTITIONER_ID,
        customerName: '山田 太郎',
        customerPhone: '090-1234-5678',
        menuName: 'カット',
        totalMinutes: 60,
        totalPrice: 5000,
        date: '2099/06/01',
        time: '10:00',
        selectedOptions: [],
        ...overrides,
    };
}

function mockReservationRow(overrides = {}) {
    return {
        id: RESERVATION_ID,
        line_user_id: null,
        idempotency_key: null,
        customer_name: '山田 太郎',
        customer_phone: '090-1234-5678',
        practitioner_id: PRACTITIONER_ID,
        practitioner_name_snapshot: 'Staff',
        menu_name_snapshot: 'カット',
        start_at: new Date('2099-06-01T01:00:00.000Z'),
        end_at: new Date('2099-06-01T02:00:00.000Z'),
        status: 'reserved',
        total_minutes: 60,
        total_price: 5000,
        calendar_event_id: null,
        canceled_at: null,
        cancel_reason: null,
        ...overrides,
    };
}

async function withAdminApiServer(options, callback) {
    const calls = {
        createReservation: [],
        createOutboxEvent: [],
        createAuditLog: [],
        withTransaction: [],
    };

    const cacheEntries = new Map();
    const previousAdminLineId = process.env.ADMIN_LINE_ID;
    const previousLineChannelId = process.env.LINE_CHANNEL_ID;

    function remember(resolvedPath) {
        if (!cacheEntries.has(resolvedPath)) {
            cacheEntries.set(resolvedPath, require.cache[resolvedPath]);
        }
    }

    function setModule(resolvedPath, exports) {
        remember(resolvedPath);
        require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
    }

    function clearModule(resolvedPath) {
        remember(resolvedPath);
        delete require.cache[resolvedPath];
    }

    const apiPath = require.resolve('../routes/api');
    const lineAuthPath = require.resolve('../services/lineAuth');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');

    try {
        process.env.ADMIN_LINE_ID = options.adminLineId !== undefined ? options.adminLineId : 'Uadmin';
        process.env.LINE_CHANNEL_ID = '1234567890';

        const mockPractitioner = Object.prototype.hasOwnProperty.call(options, 'practitioner')
            ? options.practitioner
            : { id: PRACTITIONER_ID, name: 'Staff', calendar_id: 'calendar-1' };

        setModule(require.resolve('../services/db'), {
            withTransaction: async (cb) => {
                calls.withTransaction.push('BEGIN');
                try {
                    const result = await cb({ fakeClient: true });
                    calls.withTransaction.push('COMMIT');
                    return result;
                } catch (err) {
                    calls.withTransaction.push('ROLLBACK');
                    throw err;
                }
            },
        });

        setModule(require.resolve('../repositories'), {
            practitioners: {
                async findPractitionerById() {
                    return mockPractitioner;
                },
                async findActivePractitioners() {
                    return [];
                },
            },
            reservations: {
                async createReservation(client, input) {
                    calls.createReservation.push(input);
                    if (options.createReservationError) {
                        throw options.createReservationError;
                    }
                    return options.reservationRow || mockReservationRow({ line_user_id: input.lineUserId });
                },
            },
            outboxEvents: {
                async createOutboxEvent(client, input) {
                    calls.createOutboxEvent.push(input);
                },
            },
            auditLogs: {
                async createAuditLog(client, input) {
                    calls.createAuditLog.push(input);
                    return { id: 'audit-1', ...input };
                },
            },
            menus: {},
            staffBlocks: {},
        });

        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), { async createEvent() {}, async deleteEvent() {} });
        setModule(require.resolve('../services/line'), { async pushMessage() {} });
        setModule(require.resolve('../services/storage'), {});

        clearModule(apiPath);
        clearModule(lineAuthPath);
        clearModule(requireLineUserPath);

        const router = require('../routes/api');
        const app = express();
        app.use(express.json());
        app.use('/api', router);
        app.use((err, req, res, next) => {
            res.status(500).json({ status: 'error', message: err.message });
        });

        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address();
        try {
            return await callback({ baseUrl: `http://127.0.0.1:${port}`, calls });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        if (previousAdminLineId === undefined) {
            delete process.env.ADMIN_LINE_ID;
        } else {
            process.env.ADMIN_LINE_ID = previousAdminLineId;
        }
        if (previousLineChannelId === undefined) {
            delete process.env.LINE_CHANNEL_ID;
        } else {
            process.env.LINE_CHANNEL_ID = previousLineChannelId;
        }

        for (const [resolvedPath, cacheEntry] of cacheEntries) {
            if (cacheEntry === undefined) {
                delete require.cache[resolvedPath];
            } else {
                require.cache[resolvedPath] = cacheEntry;
            }
        }
    }
}

test('POST /api/admin/reservations returns 403 when adminId is invalid', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload({ adminId: 'Unotadmin' })),
        });
        const body = await response.json();

        assert.equal(response.status, 403);
        assert.equal(body.status, 'error');
        assert.equal(calls.createReservation.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/reservations returns 400 when practitionerId is missing', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const { practitionerId, ...payload } = adminReservationPayload();
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.createReservation.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/reservations returns 400 when customerName is missing', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const { customerName, ...payload } = adminReservationPayload();
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.createReservation.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/reservations creates reservation without lineUserId (201)', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.equal(body.status, 'success');
        assert.equal(body.existing, false);
        assert.ok(body.reservation);
        assert.equal(calls.createReservation.length, 1);
        assert.equal(calls.createReservation[0].createdVia, 'staff_admin');
        assert.equal(calls.createReservation[0].lineUserId, null);
        assert.equal(calls.createReservation[0].idempotencyKey, null);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('POST /api/admin/reservations enqueues notify_customer_created when lineUserId is provided', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload({ lineUserId: 'Ucustomer' })),
        });

        assert.equal(response.status, 201);
        const eventTypes = calls.createOutboxEvent.map(e => e.eventType);
        assert.ok(eventTypes.includes('reservation.line.notify_customer_created'));
        assert.ok(eventTypes.includes('reservation.calendar.create'));
        assert.ok(eventTypes.includes('reservation.line.notify_admin_created'));
        assert.equal(calls.createOutboxEvent.length, 3);
    });
});

test('POST /api/admin/reservations does not enqueue notify_customer_created when lineUserId is absent', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload()),
        });

        assert.equal(response.status, 201);
        const eventTypes = calls.createOutboxEvent.map(e => e.eventType);
        assert.ok(!eventTypes.includes('reservation.line.notify_customer_created'));
        assert.ok(eventTypes.includes('reservation.calendar.create'));
        assert.ok(eventTypes.includes('reservation.line.notify_admin_created'));
        assert.equal(calls.createOutboxEvent.length, 2);
    });
});

test('POST /api/admin/reservations returns 409 when busy range conflict occurs', async () => {
    const createReservationError = new Error('exclusion violation');
    createReservationError.code = '23P01';

    await withAdminApiServer({ createReservationError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.createOutboxEvent.length, 0);
        assert.equal(calls.createAuditLog.length, 0);
    });
});

test('POST /api/admin/reservations creates audit_log with admin actor on success', async () => {
    await withAdminApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(adminReservationPayload()),
        });

        assert.equal(response.status, 201);
        assert.equal(calls.createAuditLog.length, 1);
        assert.equal(calls.createAuditLog[0].actorType, 'admin');
        assert.equal(calls.createAuditLog[0].actorId, 'Uadmin');
        assert.equal(calls.createAuditLog[0].action, 'reservation.create');
        assert.equal(calls.createAuditLog[0].entityType, 'reservation');
        assert.ok(calls.createAuditLog[0].afterData);
    });
});
