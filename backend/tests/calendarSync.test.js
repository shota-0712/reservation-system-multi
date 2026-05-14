const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    syncCalendarState,
    syncCalendarStates,
} = require('../services/calendarSync');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';
const PRACTITIONER_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-05-14T00:00:00.000Z');

function makeSyncState(overrides = {}) {
    return {
        id: SYNC_STATE_ID,
        practitioner_id: PRACTITIONER_ID,
        calendar_id: 'staff-a@example.com',
        sync_token: null,
        sync_requested_at: new Date('2026-05-14T00:01:00.000Z'),
        ...overrides,
    };
}

function makeServiceHarness(responses, overrides = {}) {
    const listCalls = [];
    const calls = {
        succeeded: [],
        failed: [],
        cleared: [],
        findById: [],
        listRequested: [],
    };
    let responseIndex = 0;

    const calendarClient = {
        events: {
            async list(params) {
                listCalls.push(params);
                const response = responses[responseIndex++];
                if (response instanceof Error) {
                    throw response;
                }
                return { data: response };
            },
        },
    };

    const repository = {
        async findById(client, id) {
            calls.findById.push(id);
            return overrides.findByIdRows?.[id] || null;
        },
        async listRequested(client, input) {
            calls.listRequested.push(input);
            return overrides.requestedRows || [];
        },
        async clearSyncToken(client, input) {
            calls.cleared.push(input);
            return { id: input.id, sync_token: null };
        },
        async recordSyncSucceeded(client, input) {
            calls.succeeded.push(input);
            return { id: input.id, sync_token: input.syncToken };
        },
        async recordSyncFailed(client, input) {
            calls.failed.push(input);
            return { id: input.id, last_error: input.error };
        },
    };

    const options = {
        db: {
            async withTransaction(callback) {
                return callback({ tx: true });
            },
        },
        repositories: {
            calendarSyncStates: repository,
        },
        withClient: async (callback) => callback({ client: true }),
        getCalendarClient: async () => calendarClient,
        now: () => FIXED_NOW,
    };

    return { options, calls, listCalls };
}

test('initial full sync calls events.list and saves nextSyncToken', async () => {
    const harness = makeServiceHarness([
        {
            items: [{ id: 'event-1', status: 'confirmed' }],
            nextSyncToken: 'next-token',
        },
    ]);

    const result = await syncCalendarState(makeSyncState(), harness.options);

    assert.equal(harness.listCalls.length, 1);
    assert.equal(harness.listCalls[0].calendarId, 'staff-a@example.com');
    assert.equal(harness.listCalls[0].singleEvents, true);
    assert.equal(harness.listCalls[0].showDeleted, true);
    assert.equal(harness.listCalls[0].timeMin, '2026-05-13T00:00:00.000Z');
    assert.equal(harness.listCalls[0].timeMax, '2026-08-12T00:00:00.000Z');
    assert.equal(harness.listCalls[0].syncToken, undefined);
    assert.equal(harness.calls.succeeded[0].syncToken, 'next-token');
    assert.equal(harness.calls.succeeded[0].fullSync, true);
    assert.equal(result.mode, 'full');
    assert.equal(result.fetched_count, 1);
    assert.equal(result.next_sync_token_saved, true);
});

test('incremental sync uses existing syncToken', async () => {
    const harness = makeServiceHarness([
        {
            items: [],
            nextSyncToken: 'new-delta-token',
        },
    ]);

    const result = await syncCalendarState(makeSyncState({ sync_token: 'old-token' }), harness.options);

    assert.equal(harness.listCalls.length, 1);
    assert.equal(harness.listCalls[0].syncToken, 'old-token');
    assert.equal(harness.listCalls[0].timeMin, undefined);
    assert.equal(harness.listCalls[0].timeMax, undefined);
    assert.equal(harness.calls.succeeded[0].syncToken, 'new-delta-token');
    assert.equal(harness.calls.succeeded[0].fullSync, false);
    assert.equal(result.mode, 'incremental');
});

test('expired syncToken falls back to full sync', async () => {
    const gone = new Error('Gone');
    gone.code = 410;
    const harness = makeServiceHarness([
        gone,
        {
            items: [{ id: 'event-after-reset' }],
            nextSyncToken: 'reset-token',
        },
    ]);

    const result = await syncCalendarState(makeSyncState({ sync_token: 'expired-token' }), harness.options);

    assert.equal(harness.listCalls.length, 2);
    assert.equal(harness.listCalls[0].syncToken, 'expired-token');
    assert.equal(harness.listCalls[1].syncToken, undefined);
    assert.equal(harness.listCalls[1].timeMin, '2026-05-13T00:00:00.000Z');
    assert.deepEqual(harness.calls.cleared, [{ id: SYNC_STATE_ID }]);
    assert.equal(harness.calls.succeeded[0].syncToken, 'reset-token');
    assert.equal(harness.calls.succeeded[0].fullSync, true);
    assert.equal(result.mode, 'full');
    assert.equal(result.recovered_from_expired_sync_token, true);
});

test('reservation_system events are excluded from external candidates', async () => {
    const harness = makeServiceHarness([
        {
            items: [
                {
                    id: 'system-event',
                    extendedProperties: {
                        private: {
                            source: 'reservation_system',
                        },
                    },
                },
                {
                    id: 'external-event',
                    status: 'confirmed',
                    summary: 'Private appointment',
                    start: { dateTime: '2026-05-15T10:00:00+09:00' },
                    end: { dateTime: '2026-05-15T11:00:00+09:00' },
                },
            ],
            nextSyncToken: 'next-token',
        },
    ]);

    const result = await syncCalendarState(makeSyncState(), harness.options);

    assert.equal(result.fetched_count, 2);
    assert.equal(result.ignored_system_event_count, 1);
    assert.equal(result.external_event_count, 1);
    assert.equal(result.external_events[0].google_event_id, 'external-event');
    assert.equal(result.external_events[0].calendar_sync_state_id, SYNC_STATE_ID);
});

test('Google API failure records last_error and keeps sync request retryable', async () => {
    const apiError = new Error('quota exceeded');
    const harness = makeServiceHarness([apiError]);

    await assert.rejects(
        () => syncCalendarState(makeSyncState({ sync_token: 'old-token' }), harness.options),
        /quota exceeded/
    );

    assert.equal(harness.calls.succeeded.length, 0);
    assert.equal(harness.calls.failed.length, 1);
    assert.equal(harness.calls.failed[0].id, SYNC_STATE_ID);
    assert.match(harness.calls.failed[0].error, /quota exceeded/);
});

test('syncCalendarStates loads requested sync states and returns aggregate counts', async () => {
    const syncState = makeSyncState();
    const harness = makeServiceHarness([
        {
            items: [
                { id: 'external-1' },
                {
                    id: 'system-1',
                    extendedProperties: { private: { source: 'reservation_system' } },
                },
            ],
            nextSyncToken: 'next-token',
        },
    ], {
        requestedRows: [syncState],
    });

    const result = await syncCalendarStates({
        ...harness.options,
        limit: 7,
    });

    assert.deepEqual(harness.calls.listRequested, [{ limit: 7 }]);
    assert.equal(result.requested, 1);
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.fetched_count, 2);
    assert.equal(result.ignored_system_event_count, 1);
    assert.equal(result.external_event_count, 1);
});

async function withCalendarSyncBatchServer(options, callback) {
    const cacheEntries = new Map();
    const previousSecret = process.env.SCHEDULER_SECRET;
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
    const lineAuthPath = require.resolve('../services/lineAuth');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');

    try {
        process.env.SCHEDULER_SECRET = options.secret || 'test-secret';
        process.env.LINE_CHANNEL_ID = '1234567890';

        setModule(require.resolve('../services/calendarSync'), options.calendarSyncMock);
        setModule(require.resolve('../services/db'), {
            getPool: () => ({
                async connect() {
                    return {
                        async query() { return { rows: [] }; },
                        release() {},
                    };
                },
            }),
            withTransaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
        });
        setModule(require.resolve('../repositories'), {
            reservations: {},
            practitioners: { async findActivePractitioners() { return []; } },
            menus: {},
            options: {},
            settings: {},
            staffBlocks: {},
            outboxEvents: {},
            auditLogs: {},
            calendarSyncStates: {},
        });
        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), {
            selectRandomPractitioner: () => null,
            async createEvent() {},
            async deleteEvent() {},
        });
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
            res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
        });

        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address();
        try {
            return await callback({ baseUrl: `http://127.0.0.1:${port}` });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        if (previousSecret === undefined) {
            delete process.env.SCHEDULER_SECRET;
        } else {
            process.env.SCHEDULER_SECRET = previousSecret;
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

test('POST /api/batch/calendar-sync calls sync service and returns counts', async () => {
    const serviceCalls = [];
    await withCalendarSyncBatchServer({
        calendarSyncMock: {
            async syncCalendarStates(input) {
                serviceCalls.push(input);
                return {
                    requested: 1,
                    processed: 1,
                    failed: 0,
                    not_found: 0,
                    fetched_count: 2,
                    ignored_system_event_count: 1,
                    external_event_count: 1,
                    results: [],
                };
            },
        },
    }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/batch/calendar-sync`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-scheduler-secret': 'test-secret',
            },
            body: JSON.stringify({
                calendarSyncStateId: SYNC_STATE_ID,
                limit: 5,
            }),
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.processed, 1);
        assert.equal(body.fetched_count, 2);
        assert.deepEqual(serviceCalls, [{
            stateIds: [SYNC_STATE_ID],
            limit: 5,
        }]);
    });
});
