function nullable(value) {
    return value === undefined ? null : value;
}

async function createAuditLog(client, input) {
    const result = await client.query(
        `
            INSERT INTO audit_logs (
                id,
                actor_type,
                actor_id,
                action,
                entity_type,
                entity_id,
                reservation_id,
                staff_block_id,
                before_data,
                after_data,
                metadata
            )
            VALUES (
                COALESCE($1::uuid, gen_random_uuid()),
                $2,
                $3,
                $4,
                $5,
                $6::uuid,
                $7::uuid,
                $8::uuid,
                $9::jsonb,
                $10::jsonb,
                COALESCE($11::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            nullable(input.id),
            nullable(input.actorType),
            nullable(input.actorId),
            input.action,
            input.entityType,
            nullable(input.entityId),
            nullable(input.reservationId),
            nullable(input.staffBlockId),
            nullable(input.beforeData),
            nullable(input.afterData),
            nullable(input.metadata),
        ]
    );

    return result.rows[0];
}

module.exports = {
    createAuditLog,
};
