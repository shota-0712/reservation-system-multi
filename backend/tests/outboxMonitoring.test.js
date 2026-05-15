const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    claimEvents,
    getStats,
    resetStaleProcessing,
    retryEvent,
} = require('../repositories/outboxEvents');

const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeClient(queryFn) {
    return {
        async query(text, params) {
            return queryFn(text, params);
        },
    };
}

test('getStats returns counts for each status and stale processing events', async () => {
    const queries = [];
    const client = makeClient((text) => {
        queries.push(text);

        if (queries.length === 1) {
            return {
                rows: [
                    { status: 'pending', count: '3' },
                    { status: 'processing', count: '1' },
                    { status: 'succeeded', count: '42' },
                    { status: 'failed', count: '2' },
                    { status: 'dead', count: '9' },
                ],
            };
        }

        return { rows: [{ count: '1' }] };
    });

    const stats = await getStats(client);

    assert.deepEqual(stats, {
        pending: 3,
        processing: 1,
        succeeded: 42,
        failed: 2,
        stale_processing: 1,
    });
    assert.match(queries[0], /GROUP BY status/);
    assert.match(queries[1], /status = 'processing'/);
    assert.match(queries[1], /locked_at < now\(\) - interval '10 minutes'/);
});

test('resetStaleProcessing resets only stale processing events', async () => {
    let capturedText = '';
    let capturedParams = [];

    const client = makeClient((text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rowCount: 1, rows: [{ id: EVENT_ID }] };
    });

    const reset = await resetStaleProcessing(client, 10);

    assert.equal(reset, 1);
    assert.deepEqual(capturedParams, [10]);
    assert.match(capturedText, /SET status = 'pending'/);
    assert.match(capturedText, /locked_at = null/);
    assert.match(capturedText, /locked_by = null/);
    assert.match(capturedText, /WHERE status = 'processing'/);
    assert.match(capturedText, /locked_at < now\(\) - \(\$1 \* interval '1 minute'\)/);
    assert.match(capturedText, /RETURNING id/);
});

test('retryEvent returns failed event to pending', async () => {
    let capturedText = '';
    let capturedParams = [];

    const client = makeClient((text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rowCount: 1, rows: [{ id: EVENT_ID }] };
    });

    const queued = await retryEvent(client, EVENT_ID);

    assert.equal(queued, true);
    assert.deepEqual(capturedParams, [EVENT_ID]);
    assert.match(capturedText, /SET status = 'pending'/);
    assert.match(capturedText, /next_attempt_at = now\(\)/);
    assert.match(capturedText, /status = 'failed'/);
    assert.match(capturedText, /status = 'processing' AND locked_at < now\(\) - interval '10 minutes'/);
    assert.doesNotMatch(capturedText, /attempt_count\s*=/);
});

test('retryEvent does nothing for pending or succeeded events', async () => {
    const client = makeClient(() => ({ rowCount: 0, rows: [] }));

    assert.equal(await retryEvent(client, 'pending-event'), false);
    assert.equal(await retryEvent(client, 'succeeded-event'), false);
});

test('claimEvents excludes failed events that reached the automatic attempt limit', async () => {
    let capturedText = '';

    const client = makeClient((text) => {
        capturedText = text;
        return { rows: [] };
    });

    await claimEvents(client, { workerId: 'worker-1', limit: 20 });

    assert.match(capturedText, /status = 'pending'/);
    assert.match(capturedText, /status = 'failed' AND attempt_count < 5/);
});

async function withOutboxMonitoringServer(options, callback) {
    const calls = {
        getStats: [],
        resetStaleProcessing: [],
        retryEvent: [],
        connect: 0,
        release: 0,
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

    const apiPath = require.resolve('../routes/api');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');

    try {
        process.env.ADMIN_LINE_ID = options.adminLineId !== undefined ? options.adminLineId : 'Uadmin';
        process.env.LINE_CHANNEL_ID = '1234567890';

        const fakeClient = {
            release() {
                calls.release++;
            },
        };
        const fakePool = {
            async connect() {
                calls.connect++;
                return fakeClient;
            },
        };

        setModule(require.resolve('../services/db'), {
            getPool: () => fakePool,
            withTransaction: async (cb) => cb(fakeClient),
        });
        setModule(require.resolve('../repositories'), {
            outboxEvents: {
                async getStats(client) {
                    calls.getStats.push(client);
                    return options.stats || {
                        pending: 0,
                        processing: 0,
                        succeeded: 0,
                        failed: 0,
                        stale_processing: 0,
                    };
                },
                async resetStaleProcessing(client) {
                    calls.resetStaleProcessing.push(client);
                    return options.resetCount || 0;
                },
                async retryEvent(client, id) {
                    calls.retryEvent.push({ client, id });
                    return options.retryResult || false;
                },
            },
            reservations: {},
            practitioners: {
                async findPractitionerById() { return null; },
                async findActivePractitioners() { return []; },
            },
            menus: {},
            options: {},
            settings: {},
            staffBlocks: {},
            auditLogs: {},
            calendarSyncStates: {},
            calendarSyncConflicts: {},
        });
        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), { async createEvent() {}, async deleteEvent() {} });
        setModule(require.resolve('../services/calendarSync'), { async syncCalendarStates() { return {}; } });
        setModule(require.resolve('../services/calendarWatch'), { async refreshCalendarWatchChannels() { return {}; } });
        setModule(require.resolve('../services/line'), { async pushMessage() {} });
        setModule(require.resolve('../services/storage'), {});
        setModule(requireLineUserPath, {
            requireLineUser: (req, res, next) => next(),
            rejectMismatchedLineUser: (req, res, next) => next(),
        });

        clearModule(apiPath);

        const router = require('../routes/api');
        const app = express();
        app.use(express.json());
        app.use('/api', router);
        app.use((err, req, res, next) => {
            res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
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

test('GET /api/admin/outbox/stats returns stats object', async () => {
    const stats = {
        pending: 3,
        processing: 1,
        succeeded: 42,
        failed: 2,
        stale_processing: 1,
    };

    await withOutboxMonitoringServer({ stats }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/outbox/stats?adminId=Uadmin`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body, stats);
        assert.equal(calls.getStats.length, 1);
        assert.equal(calls.connect, 1);
        assert.equal(calls.release, 1);
    });
});

test('POST /api/admin/outbox/reset-stale returns reset count', async () => {
    await withOutboxMonitoringServer({ resetCount: 2 }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/outbox/reset-stale`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminId: 'Uadmin' }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body, { reset: 2 });
        assert.equal(calls.resetStaleProcessing.length, 1);
    });
});

test('POST /api/admin/outbox/:id/retry returns queued true for retryable event', async () => {
    await withOutboxMonitoringServer({ retryResult: true }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/outbox/${EVENT_ID}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminId: 'Uadmin' }),
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body, { queued: true });
        assert.equal(calls.retryEvent.length, 1);
        assert.equal(calls.retryEvent[0].id, EVENT_ID);
    });
});

test('POST /api/admin/outbox/:id/retry returns 409 for non-retryable event', async () => {
    await withOutboxMonitoringServer({ retryResult: false }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/admin/outbox/${EVENT_ID}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminId: 'Uadmin' }),
        });
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.deepEqual(body, { error: 'event is not retryable' });
    });
});
