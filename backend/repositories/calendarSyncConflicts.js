function nullable(value) {
    return value === undefined ? null : value;
}

async function findBlockingBusyRange(client, input) {
    const result = await client.query(
        `
            SELECT
                id,
                practitioner_id,
                source_type,
                reservation_id,
                staff_block_id,
                start_at,
                end_at,
                released_at
            FROM practitioner_busy_ranges
            WHERE practitioner_id = $1::uuid
              AND released_at IS NULL
              AND time_range && tstzrange($2::timestamptz, $3::timestamptz, '[)')
              AND (
                  $4::uuid IS NULL
                  OR staff_block_id IS DISTINCT FROM $4::uuid
              )
            ORDER BY
                CASE
                    WHEN source_type = 'reservation'::busy_source_type THEN 0
                    ELSE 1
                END,
                start_at,
                id
            LIMIT 1
        `,
        [
            input.practitionerId,
            input.startAt,
            input.endAt,
            nullable(input.excludeStaffBlockId),
        ]
    );

    return result.rows[0] || null;
}

async function upsertOpenConflict(client, input) {
    if (!input.calendarEventId) {
        return null;
    }

    const result = await client.query(
        `
            INSERT INTO calendar_sync_conflicts (
                practitioner_id,
                calendar_id,
                calendar_event_id,
                reservation_id,
                staff_block_id,
                status,
                detail
            )
            VALUES (
                $1::uuid,
                $2,
                $3,
                $4::uuid,
                $5::uuid,
                'open'::calendar_conflict_status,
                COALESCE($6::jsonb, '{}'::jsonb)
            )
            ON CONFLICT (
                practitioner_id,
                (COALESCE(calendar_id, '')),
                calendar_event_id
            )
            WHERE status = 'open'
              AND calendar_event_id IS NOT NULL
            DO UPDATE SET
                reservation_id = COALESCE(EXCLUDED.reservation_id, calendar_sync_conflicts.reservation_id),
                staff_block_id = COALESCE(EXCLUDED.staff_block_id, calendar_sync_conflicts.staff_block_id),
                detail = EXCLUDED.detail,
                resolved_at = NULL
            RETURNING *
        `,
        [
            input.practitionerId,
            nullable(input.calendarId),
            input.calendarEventId,
            nullable(input.reservationId),
            nullable(input.staffBlockId),
            nullable(input.detail),
        ]
    );

    return result.rows[0] || null;
}

async function resolveOpenConflictForEvent(client, input) {
    if (!input.calendarEventId) {
        return null;
    }

    const result = await client.query(
        `
            UPDATE calendar_sync_conflicts
            SET status = 'resolved'::calendar_conflict_status,
                resolved_at = COALESCE(resolved_at, now()),
                detail = detail || jsonb_build_object(
                    'resolution_reason', COALESCE($4, 'event_imported'),
                    'resolved_source', COALESCE($5, 'calendar_sync_conflicts')
                )
            WHERE practitioner_id = $1::uuid
              AND COALESCE(calendar_id, '') = COALESCE($2, '')
              AND calendar_event_id = $3
              AND status = 'open'::calendar_conflict_status
            RETURNING *
        `,
        [
            input.practitionerId,
            nullable(input.calendarId),
            input.calendarEventId,
            nullable(input.reason),
            nullable(input.source),
        ]
    );

    return result.rows[0] || null;
}

module.exports = {
    findBlockingBusyRange,
    upsertOpenConflict,
    resolveOpenConflictForEvent,
};
