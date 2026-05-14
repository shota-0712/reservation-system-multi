const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    claimEvents,
    markSucceeded,
    markFailed,
    recoverStale,
} = require('../repositories/outboxEvents');

const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_ID = 'test-worker-1';

function makeClient(queryFn) {
    return {
        async query(text, params) {
            return queryFn(text, params);
        },
    };
}

// ----------------------------------------------------------------
// Repository unit tests (mock client)
// ----------------------------------------------------------------

test('claimEvents sets status to processing and increments attempt_count', async () => {
    let capturedText = '';
    let capturedParams = [];

    const claimedRow = {
        id: EVENT_ID,
        event_type: 'calendar_event_create',
        status: 'processing',
        attempt_count: 1,
        locked_by: WORKER_ID,
    };

    const client = makeClient((text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rows: [claimedRow] };
    });

    const events = await claimEvents(client, { workerId: WORKER_ID, limit: 10 });

    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'processing');
    assert.equal(capturedParams[0], WORKER_ID);
    assert.equal(capturedParams[1], 10);
    assert.match(capturedText, /attempt_count = attempt_count \+ 1/);
    assert.match(capturedText, /status = 'processing'/);
});

test('claimEvents SQL uses FOR UPDATE SKIP LOCKED to prevent double-processing', async () => {
    let capturedText = '';

    const client = makeClient((text) => {
        capturedText = text;
        return { rows: [] };
    });

    await claimEvents(client, { workerId: WORKER_ID });

    assert.match(capturedText, /FOR UPDATE SKIP LOCKED/);
});

test('two concurrent workers do not receive the same event', async () => {
    // Simulates SKIP LOCKED: the first worker claims the event,
    // subsequent calls return empty (row is locked / already claimed).
    const claimedEvent = { id: EVENT_ID, status: 'processing', locked_by: 'worker-1' };
    let callCount = 0;

    const client = makeClient(() => {
        callCount++;
        return { rows: callCount === 1 ? [claimedEvent] : [] };
    });

    const events1 = await claimEvents(client, { workerId: 'worker-1' });
    const events2 = await claimEvents(client, { workerId: 'worker-2' });

    assert.equal(events1.length, 1);
    assert.equal(events2.length, 0);
});

test('markSucceeded sets status to succeeded and clears lock fields', async () => {
    let capturedText = '';

    const succeededRow = {
        id: EVENT_ID,
        status: 'succeeded',
        processed_at: new Date(),
        locked_at: null,
        locked_by: null,
    };

    const client = makeClient((text) => {
        capturedText = text;
        return { rows: [succeededRow] };
    });

    const result = await markSucceeded(client, { id: EVENT_ID });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.locked_at, null);
    assert.equal(result.locked_by, null);
    assert.match(capturedText, /status = 'succeeded'/);
    assert.match(capturedText, /processed_at = now\(\)/);
});

test('markFailed sets status to failed with exponential backoff next_attempt_at', async () => {
    let capturedText = '';
    let capturedParams = [];

    const failedRow = {
        id: EVENT_ID,
        status: 'failed',
        attempt_count: 2,
        locked_at: null,
        locked_by: null,
        last_error: 'something went wrong',
    };

    const client = makeClient((text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rows: [failedRow] };
    });

    const error = new Error('something went wrong');
    const result = await markFailed(client, { id: EVENT_ID, error, maxAttempts: 5 });

    assert.equal(result.status, 'failed');
    assert.equal(result.locked_at, null);
    assert.equal(capturedParams[0], EVENT_ID);
    assert.equal(capturedParams[1], 5);
    assert.equal(capturedParams[2], 'something went wrong');
    assert.match(capturedText, /power\(2, attempt_count\)/);
    assert.match(capturedText, /interval '1 minute'/);
});

test('markFailed sets status to dead when attempt_count reaches maxAttempts', async () => {
    const deadRow = {
        id: EVENT_ID,
        status: 'dead',
        attempt_count: 5,
        locked_at: null,
        locked_by: null,
    };

    const client = makeClient(() => ({ rows: [deadRow] }));

    const error = new Error('fatal error');
    const result = await markFailed(client, { id: EVENT_ID, error, maxAttempts: 5 });

    assert.equal(result.status, 'dead');
});

test('recoverStale resets stale processing events to failed', async () => {
    let capturedText = '';
    let capturedParams = [];

    const recoveredRow = {
        id: EVENT_ID,
        status: 'failed',
        locked_at: null,
        locked_by: null,
        last_error: 'stale processing recovered',
    };

    const client = makeClient((text, params) => {
        capturedText = text;
        capturedParams = params;
        return { rows: [recoveredRow] };
    });

    const rows = await recoverStale(client, { staleMinutes: 10 });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].locked_at, null);
    assert.equal(rows[0].last_error, 'stale processing recovered');
    assert.equal(capturedParams[0], 10);
    assert.match(capturedText, /status = 'failed'/);
    assert.match(capturedText, /stale processing recovered/);
});

// ----------------------------------------------------------------
// HTTP endpoint integration test (mocked DB + repositories)
// ----------------------------------------------------------------

async function withOutboxServer(options, callback) {
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

        const fakePool = {
            async connect() {
                return {
                    async query() { return { rows: [] }; },
                    release() {},
                };
            },
        };

        const claimedEvents = options.claimedEvents || [];
        const recoverStaleRows = options.recoverStaleRows || [];

        const mockOutboxEvents = {
            async recoverStale() {
                return recoverStaleRows;
            },
            async claimEvents() {
                return claimedEvents;
            },
            async markSucceeded(client, { id }) {
                if (options.markSucceededError) throw options.markSucceededError;
                return { id, status: 'succeeded' };
            },
            async markFailed(client, { id, error }) {
                return { id, status: 'failed', last_error: error.message };
            },
        };

        setModule(require.resolve('../services/db'), {
            getPool: () => fakePool,
            withTransaction: async (cb) => cb({ query: async () => ({ rows: [] }) }),
        });
        setModule(require.resolve('../repositories'), {
            outboxEvents: mockOutboxEvents,
            reservations: {},
            practitioners: {},
            menus: {},
            staffBlocks: {},
            auditLogs: {},
        });
        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), { selectRandomPractitioner: () => null });
        setModule(require.resolve('../services/line'), { pushMessage: async () => {} });
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

test('POST /api/batch/outbox returns { processed, failed, recovered }', async () => {
    const claimedEvents = [
        { id: 'event-1', event_type: 'calendar_event_create' },
        { id: 'event-2', event_type: 'line_notify_customer_created' },
    ];

    await withOutboxServer(
        { claimedEvents, recoverStaleRows: [{ id: 'stale-1' }] },
        async ({ baseUrl }) => {
            const response = await fetch(`${baseUrl}/api/batch/outbox`, {
                method: 'POST',
                headers: { 'x-scheduler-secret': 'test-secret' },
            });

            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.processed, 2);
            assert.equal(body.failed, 0);
            assert.equal(body.recovered, 1);
        }
    );
});

test('POST /api/batch/outbox counts failed events when handler throws', async () => {
    const claimedEvents = [
        { id: 'event-bad', event_type: 'unknown_event_type' },
        { id: 'event-ok', event_type: 'calendar_event_create' },
    ];

    await withOutboxServer({ claimedEvents }, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/batch/outbox`, {
            method: 'POST',
            headers: { 'x-scheduler-secret': 'test-secret' },
        });

        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.processed, 1);
        assert.equal(body.failed, 1);
        assert.equal(body.recovered, 0);
    });
});

test('POST /api/batch/outbox returns 403 with wrong secret', async () => {
    await withOutboxServer({}, async ({ baseUrl }) => {
        const response = await fetch(`${baseUrl}/api/batch/outbox`, {
            method: 'POST',
            headers: { 'x-scheduler-secret': 'wrong-secret' },
        });

        assert.equal(response.status, 403);
    });
});
