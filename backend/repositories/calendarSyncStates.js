function nullable(value) {
    return value === undefined ? null : value;
}

async function findByChannelId(client, channelId) {
    const result = await client.query(
        `
            SELECT *
            FROM calendar_sync_states
            WHERE channel_id = $1
            LIMIT 1
        `,
        [channelId]
    );

    return result.rows[0] || null;
}

async function findById(client, id) {
    const result = await client.query(
        `
            SELECT *
            FROM calendar_sync_states
            WHERE id = $1::uuid
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function listRequested(client, { limit = 20 } = {}) {
    const result = await client.query(
        `
            SELECT *
            FROM calendar_sync_states
            WHERE sync_requested_at IS NOT NULL
            ORDER BY sync_requested_at ASC, updated_at ASC
            LIMIT $1
        `,
        [limit]
    );

    return result.rows;
}

async function recordSyncRequested(client, input) {
    const result = await client.query(
        `
            UPDATE calendar_sync_states
            SET sync_requested_at = now(),
                last_notification_at = now(),
                last_notification_state = $2,
                last_notification_message_number = $3,
                updated_at = now()
            WHERE id = $1::uuid
            RETURNING *
        `,
        [
            input.id,
            input.resourceState,
            nullable(input.messageNumber),
        ]
    );

    return result.rows[0] || null;
}

async function clearSyncToken(client, { id }) {
    const result = await client.query(
        `
            UPDATE calendar_sync_states
            SET sync_token = null,
                updated_at = now()
            WHERE id = $1::uuid
            RETURNING *
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function recordSyncSucceeded(client, input) {
    const result = await client.query(
        `
            UPDATE calendar_sync_states
            SET sync_token = $2,
                last_synced_at = $3::timestamptz,
                last_full_sync_at = CASE
                    WHEN $4::boolean THEN $3::timestamptz
                    ELSE last_full_sync_at
                END,
                last_error = null,
                sync_requested_at = null,
                updated_at = now()
            WHERE id = $1::uuid
            RETURNING *
        `,
        [
            input.id,
            input.syncToken,
            input.syncedAt,
            Boolean(input.fullSync),
        ]
    );

    return result.rows[0] || null;
}

async function recordSyncFailed(client, input) {
    const result = await client.query(
        `
            UPDATE calendar_sync_states
            SET last_error = $2,
                updated_at = now()
            WHERE id = $1::uuid
            RETURNING *
        `,
        [
            input.id,
            input.error,
        ]
    );

    return result.rows[0] || null;
}

module.exports = {
    findByChannelId,
    findById,
    listRequested,
    recordSyncRequested,
    clearSyncToken,
    recordSyncSucceeded,
    recordSyncFailed,
};
