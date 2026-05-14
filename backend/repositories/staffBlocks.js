function nullable(value) {
    return value === undefined ? null : value;
}

async function createStaffBlock(client, input) {
    const staffBlockResult = await client.query(
        `
            INSERT INTO staff_blocks (
                id,
                practitioner_id,
                start_at,
                end_at,
                source,
                status,
                reason,
                calendar_id,
                external_event_id,
                metadata
            )
            VALUES (
                COALESCE($1::uuid, gen_random_uuid()),
                $2::uuid,
                $3::timestamptz,
                $4::timestamptz,
                COALESCE($5::block_source, 'admin'::block_source),
                COALESCE($6::staff_block_status, 'active'::staff_block_status),
                $7,
                $8,
                $9,
                COALESCE($10::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            nullable(input.id),
            input.practitionerId,
            input.startAt,
            input.endAt,
            nullable(input.source),
            nullable(input.status),
            nullable(input.reason),
            nullable(input.calendarId),
            nullable(input.externalEventId),
            nullable(input.metadata),
        ]
    );

    const staffBlock = staffBlockResult.rows[0];

    await client.query(
        `
            INSERT INTO practitioner_busy_ranges (
                practitioner_id,
                source_type,
                staff_block_id,
                start_at,
                end_at
            )
            VALUES (
                $1::uuid,
                'staff_block'::busy_source_type,
                $2::uuid,
                $3::timestamptz,
                $4::timestamptz
            )
        `,
        [
            staffBlock.practitioner_id,
            staffBlock.id,
            staffBlock.start_at,
            staffBlock.end_at,
        ]
    );

    return staffBlock;
}

async function releaseStaffBlockBusyRange(client, staffBlockId) {
    const result = await client.query(
        `
            UPDATE practitioner_busy_ranges
            SET released_at = COALESCE(released_at, now())
            WHERE staff_block_id = $1::uuid
            RETURNING *
        `,
        [staffBlockId]
    );

    return result.rows[0] || null;
}

async function findById(client, id) {
    const result = await client.query(
        `SELECT * FROM staff_blocks WHERE id = $1::uuid`,
        [id]
    );
    return result.rows[0] || null;
}

async function findByPractitioner(client, { practitionerId, from, to } = {}) {
    const conditions = [`status = 'active'`];
    const params = [];

    if (practitionerId !== undefined) {
        params.push(practitionerId);
        conditions.push(`practitioner_id = $${params.length}::uuid`);
    }
    if (from !== undefined) {
        params.push(from);
        conditions.push(`end_at > $${params.length}::timestamptz`);
    }
    if (to !== undefined) {
        params.push(to);
        conditions.push(`start_at < $${params.length}::timestamptz`);
    }

    const result = await client.query(
        `SELECT * FROM staff_blocks WHERE ${conditions.join(' AND ')} ORDER BY start_at`,
        params
    );
    return result.rows;
}

async function releaseStaffBlock(client, id) {
    const result = await client.query(
        `UPDATE staff_blocks SET status = 'released', updated_at = now() WHERE id = $1::uuid RETURNING *`,
        [id]
    );
    return result.rows[0] || null;
}

module.exports = {
    createStaffBlock,
    releaseStaffBlockBusyRange,
    findById,
    findByPractitioner,
    releaseStaffBlock,
};
