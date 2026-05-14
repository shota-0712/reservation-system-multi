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
        createEvent: [],
        deleteEvent: [],
        pushMessage: [],
    };
}

function createDefaultServices(calls) {
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
            async checkConflict() {
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
    };
}

async function withApiServer(options, callback) {
    const calls = createDefaultCalls();
    const services = {
        ...createDefaultServices(calls),
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

    try {
        process.env.LINE_CHANNEL_ID = options.lineChannelId || '1234567890';

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
            name: 'Menu',
            minutes: 60,
            price: 10000,
        },
        phone: '090-0000-0000',
        date: '2099/01/01',
        time: '10:00',
        practitionerId: 'practitioner-1',
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

test('reservation creation uses verified LINE sub as userId', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...authHeaders(),
            },
            body: JSON.stringify(reservationPayload()),
        });

        assert.equal(response.status, 200);
        assert.equal(calls.addReservation.length, 1);
        assert.equal(calls.addReservation[0].userId, 'Uverified');
        assert.equal(calls.pushMessage[0].userId, 'Uverified');
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
    });
});

test('customer cancellation uses verified LINE sub', async () => {
    await withApiServer({ verifyResponse: { sub: 'Uverified' } }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/reservations/reservation-1`, {
            method: 'DELETE',
            headers: authHeaders(),
        });

        assert.equal(response.status, 200);
        assert.deepEqual(calls.getReservationById, [{
            reservationId: 'reservation-1',
            userId: 'Uverified',
        }]);
        assert.equal(calls.pushMessage[0].userId, 'Uverified');
    });
});
