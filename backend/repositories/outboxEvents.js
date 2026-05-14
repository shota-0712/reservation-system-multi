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

module.exports = {
    createOutboxEvent,
};
