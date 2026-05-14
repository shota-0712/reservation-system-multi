const test = require('node:test');
const assert = require('node:assert/strict');

const {
    findByChannelId,
    recordSyncRequested,
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
