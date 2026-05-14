const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = 'channel-123';
const RESOURCE_ID = 'resource-456';
const CHANNEL_TOKEN = 'secret-channel-token';

function webhookHeaders(overrides = {}) {
    return {
        'x-goog-channel-id': CHANNEL_ID,
        'x-goog-resource-id': RESOURCE_ID,
        'x-goog-resource-state': 'exists',
        'x-goog-channel-token': CHANNEL_TOKEN,
        'x-goog-message-number': '7',
        ...overrides,
    };
}

async function withWebhookServer(options, callback) {
    const calls = {
        findByChannelId: [],
        recordSyncRequested: [],
        calendarCreateEvent: [],
        calendarDeleteEvent: [],
        transactions: [],
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
        require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
    }

    function clearModule(resolvedPath) {
        remember(resolvedPath);
        delete require.cache[resolvedPath];
    }

    const apiPath = require.resolve('../routes/api');
    const lineAuthPath = require.resolve('../services/lineAuth');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');

    const defaultSyncState = {
        id: SYNC_STATE_ID,
        channel_id: CHANNEL_ID,
        channel_resource_id: RESOURCE_ID,
        channel_token: CHANNEL_TOKEN,
    };

    try {
        process.env.LINE_CHANNEL_ID = '1234567890';

        setModule(require.resolve('../services/db'), {
            withTransaction: async (cb) => {
                calls.transactions.push('BEGIN');
                try {
                    const result = await cb({ fakeClient: true });
                    calls.transactions.push('COMMIT');
                    return result;
                } catch (err) {
                    calls.transactions.push('ROLLBACK');
                    throw err;
                }
            },
            getPool: () => ({
                async connect() {
                    return {
                        async query() { return { rows: [] }; },
                        release() {},
                    };
                },
            }),
        });

        setModule(require.resolve('../repositories'), {
            reservations: {},
            practitioners: {
                async findActivePractitioners() { return []; },
            },
            menus: {},
            options: {},
            settings: {},
            staffBlocks: {},
            outboxEvents: {},
            auditLogs: {},
            calendarSyncStates: {
                async findByChannelId(client, channelId) {
                    calls.findByChannelId.push(channelId);
                    return Object.prototype.hasOwnProperty.call(options, 'syncState')
                        ? options.syncState
                        : defaultSyncState;
                },
                async recordSyncRequested(client, input) {
                    calls.recordSyncRequested.push(input);
                    return { ...defaultSyncState, ...input };
                },
            },
        });

        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), {
            selectRandomPractitioner: () => null,
            async createEvent(...args) { calls.calendarCreateEvent.push(args); },
            async deleteEvent(...args) { calls.calendarDeleteEvent.push(args); },
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

test('POST /api/webhooks/google-calendar accepts valid channel headers and records sync request', async () => {
    await withWebhookServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders(),
        });

        assert.equal(response.status, 202);
        const body = await response.json();
        assert.equal(body.status, 'accepted');
        assert.deepEqual(calls.findByChannelId, [CHANNEL_ID]);
        assert.deepEqual(calls.recordSyncRequested, [{
            id: SYNC_STATE_ID,
            resourceState: 'exists',
            messageNumber: '7',
        }]);
        assert.equal(calls.calendarCreateEvent.length, 0);
        assert.equal(calls.calendarDeleteEvent.length, 0);
    });
});

test('POST /api/webhooks/google-calendar rejects unknown channel_id', async () => {
    await withWebhookServer({ syncState: null }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders(),
        });

        assert.equal(response.status, 404);
        assert.equal(calls.recordSyncRequested.length, 0);
    });
});

test('POST /api/webhooks/google-calendar rejects resource_id mismatch', async () => {
    await withWebhookServer({
        syncState: {
            id: SYNC_STATE_ID,
            channel_id: CHANNEL_ID,
            channel_resource_id: 'other-resource',
            channel_token: CHANNEL_TOKEN,
        },
    }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders(),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.recordSyncRequested.length, 0);
    });
});

test('POST /api/webhooks/google-calendar rejects channel_token mismatch', async () => {
    await withWebhookServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders({ 'x-goog-channel-token': 'wrong-token' }),
        });

        assert.equal(response.status, 403);
        assert.equal(calls.recordSyncRequested.length, 0);
    });
});

test('POST /api/webhooks/google-calendar accepts sync resource state', async () => {
    await withWebhookServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders({ 'x-goog-resource-state': 'sync' }),
        });

        assert.equal(response.status, 202);
        assert.equal(calls.recordSyncRequested[0].resourceState, 'sync');
    });
});

test('POST /api/webhooks/google-calendar accepts not_exists resource state', async () => {
    await withWebhookServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders({ 'x-goog-resource-state': 'not_exists' }),
        });

        assert.equal(response.status, 202);
        assert.equal(calls.recordSyncRequested[0].resourceState, 'not_exists');
    });
});

test('POST /api/webhooks/google-calendar returns 200 for unexpected verified resource state without queuing sync', async () => {
    await withWebhookServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/webhooks/google-calendar`, {
            method: 'POST',
            headers: webhookHeaders({ 'x-goog-resource-state': 'mystery' }),
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'ignored');
        assert.equal(calls.recordSyncRequested.length, 0);
    });
});
