const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findByChannelId,
    findById,
    listRequested,
    listWatchRefreshCandidates,
    recordSyncRequested,
    clearSyncToken,
    recordSyncSucceeded,
    recordSyncFailed,
    recordWatchChannel,
    recordWatchRefreshFailed,
} = require('../repositories/calendarSyncStates');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';

test('findByChannelId looks up calendar_sync_states by channel_id', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: SYNC_STATE_ID,
                    channel_id: params[0],
                }],
            };
        },
    };

    const row = await findByChannelId(client, 'channel-1');

    assert.equal(row.id, SYNC_STATE_ID);
    assert.match(queries[0].text, /FROM calendar_sync_states/);
    assert.match(queries[0].text, /WHERE channel_id = \$1/);
    assert.deepEqual(queries[0].params, ['channel-1']);
});

test('recordSyncRequested updates sync request and notification metadata', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: params[0],
                    last_notification_state: params[1],
                    last_notification_message_number: params[2],
                }],
            };
        },
    };

    const row = await recordSyncRequested(client, {
        id: SYNC_STATE_ID,
        resourceState: 'exists',
        messageNumber: '42',
    });

    assert.equal(row.id, SYNC_STATE_ID);
    assert.equal(row.last_notification_state, 'exists');
    assert.equal(row.last_notification_message_number, '42');
    assert.match(queries[0].text, /UPDATE calendar_sync_states/);
    assert.match(queries[0].text, /sync_requested_at = now\(\)/);
    assert.match(queries[0].text, /last_notification_at = now\(\)/);
    assert.doesNotMatch(queries[0].text, /last_error/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID, 'exists', '42']);
});

test('findById looks up calendar_sync_states by id', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: params[0] }] };
        },
    };

    const row = await findById(client, SYNC_STATE_ID);

    assert.equal(row.id, SYNC_STATE_ID);
    assert.match(queries[0].text, /WHERE id = \$1::uuid/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID]);
});

test('listRequested returns sync states with sync_requested_at', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: SYNC_STATE_ID }] };
        },
    };

    const rows = await listRequested(client, { limit: 5 });

    assert.equal(rows.length, 1);
    assert.match(queries[0].text, /sync_requested_at IS NOT NULL/);
    assert.match(queries[0].text, /ORDER BY sync_requested_at ASC/);
    assert.deepEqual(queries[0].params, [5]);
});

test('listWatchRefreshCandidates returns active practitioner calendar states ordered by refresh need', async () => {
    const refreshBefore = new Date('2026-05-15T00:00:00.000Z');
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: SYNC_STATE_ID }] };
        },
    };

    const rows = await listWatchRefreshCandidates(client, {
        refreshBefore,
        force: false,
        limit: 10,
    });

    assert.equal(rows.length, 1);
    assert.match(queries[0].text, /JOIN practitioners p/);
    assert.match(queries[0].text, /p\.is_active = true/);
    assert.match(queries[0].text, /css\.watch_expires_at IS NULL/);
    assert.match(queries[0].text, /css\.watch_expires_at < \$1::timestamptz/);
    assert.match(queries[0].text, /LIMIT \$3/);
    assert.deepEqual(queries[0].params, [refreshBefore, false, 10]);
});

test('clearSyncToken clears only sync_token state', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: params[0], sync_token: null }] };
        },
    };

    const row = await clearSyncToken(client, { id: SYNC_STATE_ID });

    assert.equal(row.sync_token, null);
    assert.match(queries[0].text, /sync_token = null/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID]);
});

test('recordSyncSucceeded saves next sync token and clears sync request', async () => {
    const syncedAt = new Date('2026-05-14T01:23:45.000Z');
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: params[0],
                    sync_token: params[1],
                    last_synced_at: params[2],
                    sync_requested_at: null,
                }],
            };
        },
    };

    const row = await recordSyncSucceeded(client, {
        id: SYNC_STATE_ID,
        syncToken: 'next-token',
        syncedAt,
        fullSync: true,
    });

    assert.equal(row.sync_token, 'next-token');
    assert.equal(row.sync_requested_at, null);
    assert.match(queries[0].text, /last_synced_at = \$3::timestamptz/);
    assert.match(queries[0].text, /last_full_sync_at = CASE/);
    assert.match(queries[0].text, /last_error = null/);
    assert.match(queries[0].text, /sync_requested_at = null/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID, 'next-token', syncedAt, true]);
});

test('recordSyncFailed stores last_error without clearing sync request', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: params[0], last_error: params[1] }] };
        },
    };

    const row = await recordSyncFailed(client, {
        id: SYNC_STATE_ID,
        error: 'google api failed',
    });

    assert.equal(row.last_error, 'google api failed');
    assert.match(queries[0].text, /last_error = \$2/);
    assert.doesNotMatch(queries[0].text, /sync_requested_at = null/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID, 'google api failed']);
});

test('recordWatchChannel stores channel fields and can request initial sync', async () => {
    const expiresAt = new Date('2026-05-20T00:00:00.000Z');
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return {
                rows: [{
                    id: params[0],
                    channel_id: params[1],
                    channel_resource_id: params[2],
                    channel_token: params[3],
                    watch_expires_at: params[4],
                }],
            };
        },
    };

    const row = await recordWatchChannel(client, {
        id: SYNC_STATE_ID,
        channelId: 'channel-new',
        channelResourceId: 'resource-new',
        channelToken: 'secret-token',
        watchExpiresAt: expiresAt,
        requestSync: true,
    });

    assert.equal(row.channel_id, 'channel-new');
    assert.equal(row.channel_resource_id, 'resource-new');
    assert.equal(row.channel_token, 'secret-token');
    assert.match(queries[0].text, /channel_id = \$2/);
    assert.match(queries[0].text, /channel_resource_id = \$3/);
    assert.match(queries[0].text, /channel_token = \$4/);
    assert.match(queries[0].text, /watch_expires_at = \$5::timestamptz/);
    assert.match(queries[0].text, /last_error = null/);
    assert.match(queries[0].text, /WHEN \$6::boolean THEN now\(\)/);
    assert.deepEqual(queries[0].params, [
        SYNC_STATE_ID,
        'channel-new',
        'resource-new',
        'secret-token',
        expiresAt,
        true,
    ]);
});

test('recordWatchRefreshFailed stores last_error for watch refresh failures', async () => {
    const queries = [];
    const client = {
        async query(text, params) {
            queries.push({ text, params });
            return { rows: [{ id: params[0], last_error: params[1] }] };
        },
    };

    const row = await recordWatchRefreshFailed(client, {
        id: SYNC_STATE_ID,
        error: 'events.watch failed',
    });

    assert.equal(row.last_error, 'events.watch failed');
    assert.match(queries[0].text, /UPDATE calendar_sync_states/);
    assert.match(queries[0].text, /last_error = \$2/);
    assert.deepEqual(queries[0].params, [SYNC_STATE_ID, 'events.watch failed']);
});
