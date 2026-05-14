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

module.exports = {
    findByChannelId,
    recordSyncRequested,
};
