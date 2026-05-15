function nullable(value) {
    return value === undefined ? null : value;
}

async function createOutboxEvent(client, input) {
    const result = await client.query(
        `
            INSERT INTO outbox_events (
                id,
                event_type,
                aggregate_type,
                aggregate_id,
                idempotency_key,
                payload,
                status,
                next_attempt_at
            )
            VALUES (
                COALESCE($1::uuid, gen_random_uuid()),
                $2,
                $3,
                $4::uuid,
                $5,
                COALESCE($6::jsonb, '{}'::jsonb),
                COALESCE($7::outbox_status, 'pending'::outbox_status),
                COALESCE($8::timestamptz, now())
            )
            RETURNING *
        `,
        [
            nullable(input.id),
            input.eventType,
            input.aggregateType,
            input.aggregateId,
            input.idempotencyKey,
            nullable(input.payload),
            nullable(input.status),
            nullable(input.nextAttemptAt),
        ]
    );

    return result.rows[0];
}

async function claimEvents(client, { workerId, limit = 20 }) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = 'processing',
                locked_at = now(),
                locked_by = $1,
                attempt_count = attempt_count + 1,
                updated_at = now()
            WHERE id IN (
                SELECT id FROM outbox_events
                WHERE (
                    status = 'pending'
                    OR (status = 'failed' AND attempt_count < 5)
                )
                  AND next_attempt_at <= now()
                ORDER BY created_at
                LIMIT $2
                FOR UPDATE SKIP LOCKED
            )
            RETURNING *
        `,
        [workerId, limit]
    );
    return result.rows;
}

async function getStats(client) {
    const stats = {
        pending: 0,
        processing: 0,
        succeeded: 0,
        failed: 0,
        stale_processing: 0,
    };

    const statusResult = await client.query(
        `
            SELECT
                status,
                COUNT(*) AS count
            FROM outbox_events
            GROUP BY status
        `
    );

    for (const row of statusResult.rows) {
        if (Object.prototype.hasOwnProperty.call(stats, row.status)) {
            stats[row.status] = Number(row.count);
        }
    }

    const staleResult = await client.query(
        `
            SELECT COUNT(*) AS count
            FROM outbox_events
            WHERE status = 'processing'
              AND locked_at < now() - interval '10 minutes'
        `
    );

    stats.stale_processing = Number(staleResult.rows[0]?.count || 0);
    return stats;
}

async function resetStaleProcessing(client, thresholdMinutes = 10) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = 'pending',
                locked_at = null,
                locked_by = null
            WHERE status = 'processing'
              AND locked_at < now() - ($1 * interval '1 minute')
            RETURNING id
        `,
        [thresholdMinutes]
    );
    return result.rowCount;
}

async function retryEvent(client, id) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = 'pending',
                locked_at = null,
                locked_by = null,
                next_attempt_at = now()
            WHERE id = $1
              AND (
                status = 'failed'
                OR (status = 'processing' AND locked_at < now() - interval '10 minutes')
              )
            RETURNING id
        `,
        [id]
    );
    return result.rowCount > 0;
}

async function markSucceeded(client, { id }) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = 'succeeded',
                processed_at = now(),
                locked_at = null,
                locked_by = null,
                updated_at = now()
            WHERE id = $1
            RETURNING *
        `,
        [id]
    );
    return result.rows[0];
}

async function markFailed(client, { id, error, maxAttempts = 5 }) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = CASE
                    WHEN attempt_count >= $2 THEN 'dead'::outbox_status
                    ELSE 'failed'::outbox_status
                END,
                locked_at = null,
                locked_by = null,
                last_error = $3,
                next_attempt_at = CASE
                    WHEN attempt_count >= $2 THEN next_attempt_at
                    ELSE now() + (power(2, attempt_count) * interval '1 minute')
                END,
                updated_at = now()
            WHERE id = $1
            RETURNING *
        `,
        [id, maxAttempts, error.message]
    );
    return result.rows[0];
}

async function recoverStale(client, { staleMinutes = 10 } = {}) {
    const result = await client.query(
        `
            UPDATE outbox_events
            SET status = 'failed',
                locked_at = null,
                locked_by = null,
                last_error = 'stale processing recovered',
                updated_at = now()
            WHERE status = 'processing'
              AND locked_at < now() - ($1 * interval '1 minute')
            RETURNING *
        `,
        [staleMinutes]
    );
    return result.rows;
}

module.exports = {
    createOutboxEvent,
    claimEvents,
    getStats,
    resetStaleProcessing,
    retryEvent,
    markSucceeded,
    markFailed,
    recoverStale,
};
