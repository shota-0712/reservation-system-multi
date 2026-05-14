const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

function createDefaultCalls() {
    return {
        verify: [],
        getUserReservations: [],
        addReservation: [],
        getReservationById: [],
        cancelReservation: [],
        withTransaction: [],
        findReservationByIdForUpdate: [],
        findReservationByIdempotencyKey: [],
        findPractitionerById: [],
        createReservation: [],
        cancelReservationRecord: [],
        releaseReservationBusyRange: [],
        createOutboxEvent: [],
        createAuditLog: [],
        createEvent: [],
        checkConflict: [],
        deleteEvent: [],
        pushMessage: [],
    };
}

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const MENU_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

function createdReservationRow(input, overrides = {}) {
    return {
        id: overrides.id || RESERVATION_ID,
        line_user_id: input.lineUserId,
        idempotency_key: input.idempotencyKey,
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        practitioner_id: input.practitionerId,
        practitioner_name_snapshot: input.practitionerNameSnapshot,
        menu_name_snapshot: input.menuNameSnapshot,
        start_at: input.startAt,
        end_at: input.endAt,
        status: input.status || 'reserved',
        total_minutes: input.totalMinutes,
        total_price: input.totalPrice,
        ...overrides,
    };
}

function reservationDbRow(overrides = {}) {
    const startAt = overrides.start_at || new Date('2099-01-01T01:00:00.000Z');
    const endAt = overrides.end_at || new Date(new Date(startAt).getTime() + 60 * 60 * 1000);

    return {
        id: overrides.id || RESERVATION_ID,
        line_user_id: 'Uverified',
        idempotency_key: null,
        customer_name: 'Customer',
        customer_phone: '090-0000-0000',
        practitioner_id: PRACTITIONER_ID,
        practitioner_name_snapshot: 'Staff',
        menu_name_snapshot: 'Menu',
        start_at: startAt,
        end_at: endAt,
        status: 'reserved',
        total_minutes: 60,
        total_price: 10000,
        calendar_event_id: 'event-1',
        canceled_at: null,
        cancel_reason: null,
        ...overrides,
    };
}

function createDefaultServices(calls, options = {}) {
    return {
        sheets: {
            async getUserReservations(userId) {
                calls.getUserReservations.push(userId);
                return [{ id: 'reservation-1', lineId: userId }];
            },
            async getPractitionerById(practitionerId) {
                return {
                    id: practitionerId,
                    name: 'Staff',
                    calendarId: 'calendar-1',
                };
            },
            async addReservation(data) {
                calls.addReservation.push(data);
                return { status: 'success' };
            },
            async getSettings() {
                return {};
            },
            async getReservationById(reservationId, userId) {
                calls.getReservationById.push({ reservationId, userId });
                return {
                    id: reservationId,
                    name: 'Customer',
                    menu: 'Menu',
                    date: '2099/01/01',
                    time: '10:00',
                    status: 'reserved',
                    eventId: 'event-1',
                    practitionerId: 'practitioner-1',
                    practitionerName: 'Staff',
                };
            },
            async cancelReservation(reservationId) {
                calls.cancelReservation.push(reservationId);
                return { status: 'success' };
            },
            async updateReservation() {
                return { status: 'success' };
            },
        },
        calendar: {
            async checkConflict(...args) {
                calls.checkConflict.push(args);
                return false;
            },
            async createEvent(...args) {
                calls.createEvent.push(args);
                return 'event-1';
            },
            async deleteEvent(...args) {
                calls.deleteEvent.push(args);
            },
            selectRandomPractitioner(practitioners) {
                return practitioners[0] || null;
            },
        },
        line: {
            async pushMessage(userId, text) {
                calls.pushMessage.push({ userId, text });
            },
        },
        storage: {},
        db: {
            async withTransaction(callback) {
                calls.withTransaction.push('BEGIN');
                try {
                    const result = await callback({ fakeClient: true });
                    calls.withTransaction.push('COMMIT');
                    return result;
                } catch (err) {
                    calls.withTransaction.push('ROLLBACK');
                    throw err;
                }
            },
        },
        repositories: {
            practitioners: {
                async findPractitionerById(client, practitionerId) {
                    calls.findPractitionerById.push(practitionerId);
                    if (Object.prototype.hasOwnProperty.call(options, 'practitioner')) {
                        return options.practitioner;
                    }

                    return {
                        id: practitionerId,
                        name: 'Staff',
                        calendar_id: 'calendar-1',
                    };
                },
            },
            reservations: {
                async findReservationByIdForUpdate(client, reservationId) {
                    calls.findReservationByIdForUpdate.push(reservationId);
                    if (Object.prototype.hasOwnProperty.call(options, 'reservation')) {
                        return options.reservation;
                    }

                    return reservationDbRow({ id: reservationId });
                },
                async findReservationByIdempotencyKey(client, lineUserId, idempotencyKey) {
                    calls.findReservationByIdempotencyKey.push({ lineUserId, idempotencyKey });
                    return options.existingReservation || null;
                },
                async createReservation(client, input) {
                    calls.createReservation.push(input);
                    if (options.createReservationError) {
                        throw options.createReservationError;
                    }
                    return createdReservationRow(input, options.createdReservationOverrides);
                },
                async cancelReservation(client, input) {
                    calls.cancelReservationRecord.push(input);
                    if (options.cancelReservationError) {
                        throw options.cancelReservationError;
                    }

                    const current = options.reservation || reservationDbRow({ id: input.reservationId });
                    return {
                        ...current,
                        id: input.reservationId,
                        status: 'canceled',
                        canceled_at: options.canceledAt || new Date('2099-01-01T00:00:00.000Z'),
                        cancel_reason: input.cancelReason || current.cancel_reason,
                    };
                },
                async releaseReservationBusyRange(client, reservationId) {
                    calls.releaseReservationBusyRange.push(reservationId);
                    if (Object.prototype.hasOwnProperty.call(options, 'busyRange')) {
                        return options.busyRange;
                    }

                    return {
                        id: 'busy-range-1',
                        reservation_id: reservationId,
                        released_at: new Date('2099-01-01T00:00:00.000Z'),
                    };
                },
            },
            outboxEvents: {
                async createOutboxEvent(client, input) {
                    calls.createOutboxEvent.push(input);
                    if (options.outboxError) {
                        throw options.outboxError;
                    }
                    return { id: `outbox-${calls.createOutboxEvent.length}`, ...input };
                },
            },
            auditLogs: {
                async createAuditLog(client, input) {
                    calls.createAuditLog.push(input);
                    if (options.auditLogError) {
                        throw options.auditLogError;
                    }

                    return { id: `audit-${calls.createAuditLog.length}`, ...input };
                },
            },
        },
    };
}

async function withApiServer(options, callback) {
    const calls = createDefaultCalls();
    const services = {
        ...createDefaultServices(calls, options),
        ...options.services,
    };
    const cacheEntries = new Map();
    const previousLineChannelId = process.env.LINE_CHANNEL_ID;

    function remember(resolvedPath) {
        if (!cacheEntries.has(resolvedPath)) {
            cacheEntries.set(resolvedPath, require.cache[resolvedPath]);
        }
    }

    function setModule(resolvedPath, exports) {
        remember(resolvedPath);
        require.cache[resolvedPath] = {
            id: resolvedPath,
            filename: resolvedPath,
            loaded: true,
            exports,
        };
    }

    function clearModule(resolvedPath) {
        remember(resolvedPath);
        delete require.cache[resolvedPath];
    }

    const axiosPath = require.resolve('axios');
    const apiPath = require.resolve('../routes/api');
    const lineAuthPath = require.resolve('../services/lineAuth');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');
    const previousAdminLineId = process.env.ADMIN_LINE_ID;

    try {
        process.env.LINE_CHANNEL_ID = options.lineChannelId || '1234567890';
        process.env.ADMIN_LINE_ID = options.adminLineIds || 'Uadmin';

        setModule(axiosPath, {
            async post(url, body, requestOptions) {
                calls.verify.push({ url, body, requestOptions });
                if (options.verifyError) {
                    throw options.verifyError;
                }
                return { data: options.verifyResponse ?? { sub: 'Uverified' } };
            },
        });
        setModule(require.resolve('../services/sheets'), services.sheets);
        setModule(require.resolve('../services/calendar'), services.calendar);
        setModule(require.resolve('../services/line'), services.line);
        setModule(require.resolve('../services/storage'), services.storage);
        setModule(require.resolve('../services/db'), services.db);
        setModule(require.resolve('../repositories'), services.repositories);
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
        if (previousLineChannelId === undefined) {
            delete process.env.LINE_CHANNEL_ID;
        } else {
            process.env.LINE_CHANNEL_ID = previousLineChannelId;
        }
        if (previousAdminLineId === undefined) {
            delete process.env.ADMIN_LINE_ID;
        } else {
            process.env.ADMIN_LINE_ID = previousAdminLineId;
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

function authHeaders(token = 'valid-id-token') {
    return { Authorization: `Bearer ${token}` };
}

function reservationPayload(overrides = {}) {
    return {
        name: 'Customer',
        menu: {
            id: MENU_ID,
            name: 'Menu',
            minutes: 60,
            price: 10000,
        },
        phone: '090-0000-0000',
        date: '2099/01/01',
        time: '10:00',
        practitionerId: PRACTITIONER_ID,
        practitionerName: 'Staff',
        selectedOptions: [],
        totalMinutes: 60,
        totalPrice: 10000,
        ...overrides,
    };
}

test('customer API returns 401 when ID token is missing', async () => {
    await withApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/history`);

        assert.equal(response.status, 401);
        assert.equal(calls.verify.length, 0);
    });
});

test('customer API returns 401 when LINE verify fails', async () => {
    const verifyError = new Error('invalid token');
    verifyError.response = { data: { error: 'invalid_id_token' } };

    await withApiServer({ verifyError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/history`, {
            headers: authHeaders('bad-token'),
        });

        assert.equal(response.status, 401);
        assert.equal(calls.verify.length, 1);
    });
});

test('customer API returns 401 when LINE verify has no sub', async () => {
    await withApiServer({ verifyResponse: { aud: '1234567890' } }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/history`, {
            headers: authHeaders(),
        });

        assert.equal(response.status, 401);
    });
});

test('history uses verified LINE sub as userId', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/history`, {
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body, [{ id: 'reservation-1', lineId: 'Uverified' }]);
        assert.deepEqual(calls.getUserReservations, ['Uverified']);
        assert.equal(calls.verify[0].url, VERIFY_URL);
        assert.equal(calls.verify[0].body, 'id_token=valid-id-token&client_id=1234567890');
    });
});

test('customer API rejects a query userId that differs from verified sub', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/history?userId=Uattacker`, {
            headers: authHeaders(),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.getUserReservations.length, 0);
    });
});

test('reservation creation stores DB records and outbox events without direct side effects', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
                'Idempotency-Key': 'reservation-key-1',
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.equal(body.status, 'success');
        assert.equal(body.existing, false);
        assert.equal(body.reservation.lineUserId, 'Uverified');
        assert.equal(calls.createReservation.length, 1);
        assert.equal(calls.createReservation[0].lineUserId, 'Uverified');
        assert.equal(calls.createReservation[0].idempotencyKey, 'reservation-key-1');
        assert.equal(calls.createReservation[0].practitionerId, PRACTITIONER_ID);
        assert.deepEqual(calls.findPractitionerById, [PRACTITIONER_ID]);
        assert.deepEqual(
            calls.createOutboxEvent.map(event => event.eventType),
            [
                'reservation.calendar.create',
                'reservation.line.notify_customer_created',
                'reservation.line.notify_admin_created',
            ]
        );
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT', 'BEGIN', 'COMMIT']);
        assert.equal(calls.addReservation.length, 0);
        assert.equal(calls.checkConflict.length, 0);
        assert.equal(calls.createEvent.length, 0);
        assert.equal(calls.pushMessage.length, 0);
    });
});

test('reservation creation rolls back and returns 409 when busy range conflicts', async () => {
    const createReservationError = new Error('exclusion violation');
    createReservationError.code = '23P01';

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, createReservationError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.createReservation.length, 1);
        assert.equal(calls.createOutboxEvent.length, 0);
    });
});

test('reservation creation returns existing reservation for same line user and idempotency key', async () => {
    const existingReservation = createdReservationRow(
        {
            lineUserId: 'Uverified',
            idempotencyKey: 'reservation-key-1',
            customerName: 'Customer',
            customerPhone: '090-0000-0000',
            practitionerId: PRACTITIONER_ID,
            practitionerNameSnapshot: 'Staff',
            menuNameSnapshot: 'Menu',
            startAt: new Date('2099-01-01T01:00:00.000Z'),
            endAt: new Date('2099-01-01T02:00:00.000Z'),
            status: 'reserved',
            totalMinutes: 60,
            totalPrice: 10000,
        }
    );

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, existingReservation }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
                'Idempotency-Key': 'reservation-key-1',
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.equal(body.existing, true);
        assert.equal(body.reservation.idempotencyKey, 'reservation-key-1');
        assert.deepEqual(calls.findReservationByIdempotencyKey, [{
            lineUserId: 'Uverified',
            idempotencyKey: 'reservation-key-1',
        }]);
        assert.equal(calls.findPractitionerById.length, 0);
        assert.equal(calls.createReservation.length, 0);
        assert.equal(calls.createOutboxEvent.length, 0);
    });
});

test('reservation creation returns 400 when practitioner is not in DB', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' }, practitioner: null }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.createReservation.length, 0);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
    });
});

test('reservation creation retries idempotency lookup after unique violation', async () => {
    const createReservationError = new Error('duplicate idempotency key');
    createReservationError.code = '23505';
    createReservationError.constraint = 'reservations_line_user_id_idempotency_key_uq';

    let lookupCount = 0;
    const existingReservation = createdReservationRow(
        {
            lineUserId: 'Uverified',
            idempotencyKey: 'reservation-key-1',
            customerName: 'Customer',
            customerPhone: '090-0000-0000',
            practitionerId: PRACTITIONER_ID,
            practitionerNameSnapshot: 'Staff',
            menuNameSnapshot: 'Menu',
            startAt: new Date('2099-01-01T01:00:00.000Z'),
            endAt: new Date('2099-01-01T02:00:00.000Z'),
            status: 'reserved',
            totalMinutes: 60,
            totalPrice: 10000,
        }
    );

    const repositories = createDefaultServices(createDefaultCalls()).repositories;
    repositories.reservations.findReservationByIdempotencyKey = async (client, lineUserId, idempotencyKey) => {
        lookupCount += 1;
        return lookupCount < 3 ? null : existingReservation;
    };
    repositories.reservations.createReservation = async () => {
        throw createReservationError;
    };

    await withApiServer({
        verifyResponse: { sub: 'Uverified' },
        services: { repositories },
    }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
                'Idempotency-Key': 'reservation-key-1',
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.existing, true);
        assert.equal(lookupCount, 3);
    });
});

test('reservation creation rolls back when outbox insert fails', async () => {
    const outboxError = new Error('outbox unavailable');

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, outboxError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 500);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.createReservation.length, 1);
        assert.equal(calls.createOutboxEvent.length, 1);
    });
});

test('customer API rejects a request body userId that differs from verified sub', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload({ userId: 'Uattacker' })),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.addReservation.length, 0);
        assert.equal(calls.createReservation.length, 0);
    });
});

test('customer API rejects a request body line_user_id that differs from verified sub', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload({ line_user_id: 'Uattacker' })),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.createReservation.length, 0);
    });
});

test('customer cancellation uses verified LINE sub and records DB cancellation transaction', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.equal(body.alreadyCanceled, false);
        assert.equal(body.reservation.id, RESERVATION_ID);
        assert.deepEqual(calls.findReservationByIdForUpdate, [RESERVATION_ID]);
        assert.deepEqual(calls.cancelReservationRecord, [{
            reservationId: RESERVATION_ID,
            cancelReason: null,
        }]);
        assert.deepEqual(calls.releaseReservationBusyRange, [RESERVATION_ID]);
        assert.deepEqual(
            calls.createOutboxEvent.map(event => event.eventType),
            [
                'reservation.calendar.cancel',
                'reservation.line.notify_customer_canceled',
                'reservation.line.notify_admin_canceled',
            ]
        );
        assert.deepEqual(
            calls.createOutboxEvent.map(event => event.idempotencyKey),
            [
                `calendar:cancel:${RESERVATION_ID}`,
                `line:customer_canceled:${RESERVATION_ID}`,
                `line:admin_canceled:${RESERVATION_ID}`,
            ]
        );
        assert.equal(calls.createAuditLog.length, 1);
        assert.equal(calls.createAuditLog[0].actorType, 'customer');
        assert.equal(calls.createAuditLog[0].actorId, 'Uverified');
        assert.equal(calls.createAuditLog[0].action, 'reservation.canceled');
        assert.equal(calls.createAuditLog[0].metadata.source, 'customer_liff');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
        assert.equal(calls.cancelReservation.length, 0);
        assert.equal(calls.deleteEvent.length, 0);
        assert.equal(calls.pushMessage.length, 0);
    });
});

test('customer cancellation rejects reservations less than 24 hours away', async () => {
    const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const reservation = reservationDbRow({
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 60 * 60 * 1000),
    });

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, reservation }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 403);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.cancelReservationRecord.length, 0);
        assert.equal(calls.releaseReservationBusyRange.length, 0);
        assert.equal(calls.createOutboxEvent.length, 0);
        assert.equal(calls.createAuditLog.length, 0);
    });
});

test('customer cancellation rejects another customer reservation', async () => {
    const reservation = reservationDbRow({ line_user_id: 'Uother' });

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, reservation }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.cancelReservationRecord.length, 0);
        assert.equal(calls.releaseReservationBusyRange.length, 0);
    });
});

test('customer cancellation treats an already canceled reservation as success', async () => {
    const canceledAt = new Date('2099-01-01T00:00:00.000Z');
    const reservation = reservationDbRow({
        status: 'canceled',
        canceled_at: canceledAt,
        cancel_reason: 'already canceled',
    });

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, reservation }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.equal(body.alreadyCanceled, true);
        assert.equal(body.reservation.status, 'canceled');
        assert.deepEqual(calls.releaseReservationBusyRange, [RESERVATION_ID]);
        assert.equal(calls.cancelReservationRecord.length, 0);
        assert.equal(calls.createOutboxEvent.length, 0);
        assert.equal(calls.createAuditLog.length, 0);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('customer cancellation rejects completed reservations', async () => {
    const reservation = reservationDbRow({ status: 'completed' });

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, reservation }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.equal(body.status, 'error');
        assert.equal(calls.cancelReservationRecord.length, 0);
        assert.equal(calls.releaseReservationBusyRange.length, 0);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
    });
});

test('customer cancellation rolls back when outbox insert fails', async () => {
    const outboxError = new Error('outbox unavailable');

    await withApiServer({ verifyResponse: { sub: 'Uverified' }, outboxError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: authHeaders(),
        });
        const body = await response.json();

        assert.equal(response.status, 500);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.cancelReservationRecord.length, 1);
        assert.equal(calls.releaseReservationBusyRange.length, 1);
        assert.equal(calls.createOutboxEvent.length, 1);
        assert.equal(calls.createAuditLog.length, 0);
    });
});

test('customer cancellation rejects mismatched request body identity fields', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/${RESERVATION_ID}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify({ line_user_id: 'Uattacker' }),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.findReservationByIdForUpdate.length, 0);
    });
});

test('admin cancellation records reason without requiring LIFF customer auth', async () => {
    await withApiServer({ adminLineIds: 'Uadmin' }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations/${RESERVATION_ID}?adminId=Uadmin`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'schedule adjustment' }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.equal(calls.verify.length, 0);
        assert.deepEqual(calls.cancelReservationRecord, [{
            reservationId: RESERVATION_ID,
            cancelReason: 'schedule adjustment',
        }]);
        assert.equal(calls.createAuditLog.length, 1);
        assert.equal(calls.createAuditLog[0].actorType, 'admin');
        assert.equal(calls.createAuditLog[0].actorId, 'Uadmin');
        assert.equal(calls.createAuditLog[0].metadata.reason, 'schedule adjustment');
        assert.equal(calls.createAuditLog[0].metadata.source, 'admin_api');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('admin cancellation requires a reason', async () => {
    await withApiServer({ adminLineIds: 'Uadmin' }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/reservations/${RESERVATION_ID}?adminId=Uadmin`, {
            method: 'DELETE',
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.verify.length, 0);
        assert.deepEqual(calls.withTransaction, []);
    });
});
