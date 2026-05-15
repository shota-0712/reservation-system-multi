const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    refreshCalendarWatchChannels,
    shouldRefreshWatchChannel,
} = require('../services/calendarWatch');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';
const PRACTITIONER_ID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = new Date('2026-05-14T00:00:00.000Z');
const WEBHOOK_URL = 'https://reservation.example.com/api/webhooks/google-calendar';

function makeSyncState(overrides = {}) {
    return {
        id: SYNC_STATE_ID,
        practitioner_id: PRACTITIONER_ID,
        calendar_id: 'staff-a@example.com',
        sync_token: 'sync-token',
        channel_id: null,
        channel_resource_id: null,
        channel_token: null,
        watch_expires_at: null,
        ...overrides,
    };
}

function makeHarness(syncStates, overrides = {}) {
    const calls = {
        listWatchRefreshCandidates: [],
        recordWatchChannel: [],
        recordWatchRefreshFailed: [],
        eventsWatch: [],
        channelsStop: [],
    };
    let channelIdIndex = 0;
    let channelTokenIndex = 0;
    let watchResponseIndex = 0;

    const calendarClient = {
        events: {
            async watch(params) {
                calls.eventsWatch.push(params);
                const response = overrides.watchResponses?.[watchResponseIndex++];
                if (response instanceof Error) {
                    throw response;
                }
                if (response) {
                    return response;
                }
                return {
                    data: {
                        id: params.requestBody.id,
                        resourceId: `resource-${calls.eventsWatch.length}`,
                        expiration: String(new Date('2026-05-20T00:00:00.000Z').getTime()),
                    },
                };
            },
        },
        channels: {
            async stop(params) {
                calls.channelsStop.push(params);
                if (overrides.stopError) {
                    throw overrides.stopError;
                }
                return {};
            },
        },
    };

    const repository = {
        async listWatchRefreshCandidates(client, input) {
            calls.listWatchRefreshCandidates.push(input);
            return syncStates;
        },
        async recordWatchChannel(client, input) {
            calls.recordWatchChannel.push(input);
            return { id: input.id, channel_id: input.channelId };
        },
        async recordWatchRefreshFailed(client, input) {
            calls.recordWatchRefreshFailed.push(input);
            return { id: input.id, last_error: input.error };
        },
    };

    return {
        calls,
        options: {
            db: {
                async withTransaction(callback) {
                    return callback({ tx: true });
                },
            },
            repositories: {
                calendarSyncStates: repository,
            },
            withClient: async (callback) => callback({ client: true }),
            calendarClient,
            webhookUrl: WEBHOOK_URL,
            now: () => FIXED_NOW,
            generateChannelId: () => overrides.channelIds?.[channelIdIndex++] || `channel-${++channelIdIndex}`,
            generateChannelToken: () => overrides.channelTokens?.[channelTokenIndex++] || `token-${++channelTokenIndex}`,
        },
    };
}

test('watch refresh creates a channel for a sync state without watch state', async () => {
    const harness = makeHarness([
        makeSyncState({ sync_token: null }),
    ], {
        channelIds: ['channel-new'],
        channelTokens: ['token-new'],
    });

    const result = await refreshCalendarWatchChannels(harness.options);

    assert.equal(result.checked_count, 1);
    assert.equal(result.created_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(harness.calls.eventsWatch.length, 1);
    assert.equal(harness.calls.eventsWatch[0].calendarId, 'staff-a@example.com');
    assert.deepEqual(harness.calls.eventsWatch[0].requestBody, {
        id: 'channel-new',
        type: 'web_hook',
        address: WEBHOOK_URL,
        token: 'token-new',
        expiration: String(new Date('2026-05-20T00:00:00.000Z').getTime()),
    });
    assert.deepEqual(harness.calls.recordWatchChannel[0], {
        id: SYNC_STATE_ID,
        channelId: 'channel-new',
        channelResourceId: 'resource-1',
        channelToken: 'token-new',
        watchExpiresAt: new Date('2026-05-20T00:00:00.000Z'),
        requestSync: true,
    });
    assert.equal(harness.calls.channelsStop.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /token-new/);
});

test('watch refresh refreshes a channel that expires within 24 hours and stops old channel best effort', async () => {
    const harness = makeHarness([
        makeSyncState({
            channel_id: 'old-channel',
            channel_resource_id: 'old-resource',
            channel_token: 'old-token',
            watch_expires_at: new Date('2026-05-14T12:00:00.000Z'),
        }),
    ], {
        channelIds: ['channel-new'],
        channelTokens: ['token-new'],
    });

    const result = await refreshCalendarWatchChannels(harness.options);

    assert.equal(result.refreshed_count, 1);
    assert.equal(harness.calls.eventsWatch.length, 1);
    assert.deepEqual(harness.calls.channelsStop, [{
        requestBody: {
            id: 'old-channel',
            resourceId: 'old-resource',
        },
    }]);
    assert.equal(result.results[0].old_channel_stop_attempted, true);
    assert.equal(result.results[0].old_channel_stopped, true);
});

test('watch refresh skips a channel whose expiration is far enough in the future', async () => {
    const harness = makeHarness([
        makeSyncState({
            channel_id: 'current-channel',
            channel_resource_id: 'current-resource',
            watch_expires_at: new Date('2026-05-16T00:00:01.000Z'),
        }),
    ]);

    const result = await refreshCalendarWatchChannels(harness.options);

    assert.equal(result.skipped_count, 1);
    assert.equal(result.created_count, 0);
    assert.equal(result.refreshed_count, 0);
    assert.equal(harness.calls.eventsWatch.length, 0);
    assert.equal(result.results[0].reason, 'watch_not_expiring');
});

test('watch refresh force option refreshes a channel even when expiration is far in the future', async () => {
    const harness = makeHarness([
        makeSyncState({
            channel_id: 'current-channel',
            channel_resource_id: 'current-resource',
            watch_expires_at: new Date('2026-06-01T00:00:00.000Z'),
        }),
    ], {
        channelIds: ['channel-forced'],
        channelTokens: ['token-forced'],
    });

    const result = await refreshCalendarWatchChannels({
        ...harness.options,
        force: true,
    });

    assert.equal(result.refreshed_count, 1);
    assert.equal(result.skipped_count, 0);
    assert.equal(harness.calls.eventsWatch.length, 1);
    assert.equal(harness.calls.recordWatchChannel[0].channelId, 'channel-forced');
});

test('old channel stop is best effort and does not fail the new watch', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        const harness = makeHarness([
            makeSyncState({
                channel_id: 'old-channel',
                channel_resource_id: 'old-resource',
                watch_expires_at: new Date('2026-05-14T12:00:00.000Z'),
            }),
        ], {
            stopError: new Error('stop failed'),
        });

        const result = await refreshCalendarWatchChannels(harness.options);

        assert.equal(result.refreshed_count, 1);
        assert.equal(result.failed_count, 0);
        assert.equal(harness.calls.channelsStop.length, 1);
        assert.equal(result.results[0].old_channel_stop_attempted, true);
        assert.equal(result.results[0].old_channel_stopped, false);
    } finally {
        console.warn = warn;
    }
});

test('watch failure records last_error and redacts channel token from result and stored error', async () => {
    const apiError = new Error('api rejected super-secret-token');
    const harness = makeHarness([
        makeSyncState(),
    ], {
        channelIds: ['channel-failed'],
        channelTokens: ['super-secret-token'],
        watchResponses: [apiError],
    });

    const result = await refreshCalendarWatchChannels(harness.options);

    assert.equal(result.failed_count, 1);
    assert.equal(harness.calls.recordWatchRefreshFailed.length, 1);
    assert.match(harness.calls.recordWatchRefreshFailed[0].error, /api rejected \[redacted\]/);
    assert.doesNotMatch(harness.calls.recordWatchRefreshFailed[0].error, /super-secret-token/);
    assert.doesNotMatch(JSON.stringify(result), /super-secret-token/);
});

test('shouldRefreshWatchChannel matches null, near expiry, far expiry, and force cases', () => {
    const refreshBefore = new Date('2026-05-15T00:00:00.000Z');

    assert.equal(shouldRefreshWatchChannel(makeSyncState({ watch_expires_at: null }), { refreshBefore }), true);
    assert.equal(shouldRefreshWatchChannel(makeSyncState({ watch_expires_at: new Date('2026-05-14T23:59:59.000Z') }), { refreshBefore }), true);
    assert.equal(shouldRefreshWatchChannel(makeSyncState({ watch_expires_at: new Date('2026-05-15T00:00:01.000Z') }), { refreshBefore }), false);
    assert.equal(shouldRefreshWatchChannel(makeSyncState({ watch_expires_at: new Date('2026-06-01T00:00:00.000Z') }), { force: true, refreshBefore }), true);
});

async function withCalendarWatchBatchServer(options, callback) {
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

        setModule(require.resolve('../services/calendarWatch'), options.calendarWatchMock);
        setModule(require.resolve('../services/calendarSync'), {
            async syncCalendarStates() {
                return { requested: 0, processed: 0, failed: 0, results: [] };
            },
        });
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
            calendarSyncConflicts: {},
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

test('POST /api/batch/calendar-watch/refresh calls watch service with scheduler auth', async () => {
    const serviceCalls = [];
    await withCalendarWatchBatchServer({
        calendarWatchMock: {
            async refreshCalendarWatchChannels(input) {
                serviceCalls.push(input);
                return {
                    checked_count: 1,
                    created_count: 1,
                    refreshed_count: 0,
                    skipped_count: 0,
                    failed_count: 0,
                    results: [{ status: 'created', sync_state_id: SYNC_STATE_ID }],
                };
            },
        },
    }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/batch/calendar-watch/refresh`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-scheduler-secret': 'test-secret',
            },
            body: JSON.stringify({ force: true, limit: 5 }),
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.checked_count, 1);
        assert.equal(body.created_count, 1);
        assert.deepEqual(serviceCalls, [{ force: true, limit: 5 }]);
    });
});

test('POST /api/batch/calendar-watch/refresh rejects wrong scheduler secret', async () => {
    const serviceCalls = [];
    await withCalendarWatchBatchServer({
        calendarWatchMock: {
            async refreshCalendarWatchChannels(input) {
                serviceCalls.push(input);
                return {};
            },
        },
    }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/batch/calendar-watch/refresh`, {
            method: 'POST',
            headers: { 'x-scheduler-secret': 'wrong-secret' },
        });

        assert.equal(response.status, 403);
        assert.equal(serviceCalls.length, 0);
    });
});
