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
                external_event_etag,
                external_event_updated_at,
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
                $10,
                $11::timestamptz,
                COALESCE($12::jsonb, '{}'::jsonb)
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
            nullable(input.externalEventEtag),
            nullable(input.externalEventUpdatedAt),
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

async function findByCalendarEventForUpdate(client, { calendarId, externalEventId }) {
    const result = await client.query(
        `
            SELECT *
            FROM staff_blocks
            WHERE source = 'google_calendar'::block_source
              AND calendar_id = $1
              AND external_event_id = $2
            LIMIT 1
            FOR UPDATE
        `,
        [calendarId, externalEventId]
    );

    return result.rows[0] || null;
}

async function upsertGoogleCalendarStaffBlock(client, input) {
    const result = await client.query(
        `
            INSERT INTO staff_blocks (
                practitioner_id,
                start_at,
                end_at,
                source,
                status,
                reason,
                calendar_id,
                external_event_id,
                external_event_etag,
                external_event_updated_at,
                canceled_at,
                cancel_reason,
                metadata
            )
            VALUES (
                $1::uuid,
                $2::timestamptz,
                $3::timestamptz,
                'google_calendar'::block_source,
                'active'::staff_block_status,
                $4,
                $5,
                $6,
                $7,
                $8::timestamptz,
                NULL,
                NULL,
                COALESCE($9::jsonb, '{}'::jsonb)
            )
            ON CONFLICT (calendar_id, external_event_id)
            WHERE source = 'google_calendar'
              AND calendar_id IS NOT NULL
              AND external_event_id IS NOT NULL
            DO UPDATE SET
                practitioner_id = EXCLUDED.practitioner_id,
                start_at = EXCLUDED.start_at,
                end_at = EXCLUDED.end_at,
                status = 'active'::staff_block_status,
                reason = EXCLUDED.reason,
                external_event_etag = EXCLUDED.external_event_etag,
                external_event_updated_at = EXCLUDED.external_event_updated_at,
                canceled_at = NULL,
                cancel_reason = NULL,
                metadata = EXCLUDED.metadata
            RETURNING *, (xmax::text = '0') AS inserted
        `,
        [
            input.practitionerId,
            input.startAt,
            input.endAt,
            input.reason,
            input.calendarId,
            input.externalEventId,
            nullable(input.externalEventEtag),
            nullable(input.externalEventUpdatedAt),
            nullable(input.metadata),
        ]
    );

    return result.rows[0];
}

async function cancelGoogleCalendarStaffBlock(client, input) {
    const result = await client.query(
        `
            UPDATE staff_blocks
            SET status = 'canceled'::staff_block_status,
                canceled_at = COALESCE(canceled_at, now()),
                cancel_reason = COALESCE($2, cancel_reason),
                external_event_etag = COALESCE($3, external_event_etag),
                external_event_updated_at = COALESCE($4::timestamptz, external_event_updated_at),
                metadata = COALESCE($5::jsonb, metadata)
            WHERE id = $1::uuid
              AND source = 'google_calendar'::block_source
            RETURNING *
        `,
        [
            input.id,
            nullable(input.cancelReason),
            nullable(input.externalEventEtag),
            nullable(input.externalEventUpdatedAt),
            nullable(input.metadata),
        ]
    );

    return result.rows[0] || null;
}

async function upsertStaffBlockBusyRange(client, staffBlock) {
    const result = await client.query(
        `
            INSERT INTO practitioner_busy_ranges (
                practitioner_id,
                source_type,
                staff_block_id,
                start_at,
                end_at,
                released_at
            )
            VALUES (
                $1::uuid,
                'staff_block'::busy_source_type,
                $2::uuid,
                $3::timestamptz,
                $4::timestamptz,
                NULL
            )
            ON CONFLICT (staff_block_id)
            WHERE staff_block_id IS NOT NULL
            DO UPDATE SET
                practitioner_id = EXCLUDED.practitioner_id,
                source_type = EXCLUDED.source_type,
                reservation_id = NULL,
                start_at = EXCLUDED.start_at,
                end_at = EXCLUDED.end_at,
                released_at = NULL
            RETURNING *
        `,
        [
            staffBlock.practitioner_id,
            staffBlock.id,
            staffBlock.start_at,
            staffBlock.end_at,
        ]
    );

    return result.rows[0];
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
    findByCalendarEventForUpdate,
    upsertGoogleCalendarStaffBlock,
    cancelGoogleCalendarStaffBlock,
    upsertStaffBlockBusyRange,
    releaseStaffBlockBusyRange,
    findById,
    findByPractitioner,
    releaseStaffBlock,
};
