function nullable(value) {
    return value === undefined ? null : value;
}

async function createReservation(client, input) {
    const reservationResult = await client.query(
        `
            INSERT INTO reservations (
                id,
                customer_id,
                line_user_id,
                idempotency_key,
                created_via,
                customer_name,
                customer_phone,
                practitioner_id,
                practitioner_name_snapshot,
                menu_id,
                menu_name_snapshot,
                start_at,
                end_at,
                status,
                total_minutes,
                total_price,
                calendar_event_id,
                notes,
                metadata
            )
            VALUES (
                COALESCE($1::uuid, gen_random_uuid()),
                $2::uuid,
                $3,
                $4,
                COALESCE($5::reservation_created_via, 'customer_liff'::reservation_created_via),
                $6,
                $7,
                $8::uuid,
                $9,
                $10::uuid,
                $11,
                $12::timestamptz,
                $13::timestamptz,
                COALESCE($14::reservation_status, 'reserved'::reservation_status),
                $15,
                COALESCE($16, 0),
                $17,
                $18,
                COALESCE($19::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            nullable(input.id),
            nullable(input.customerId),
            nullable(input.lineUserId),
            nullable(input.idempotencyKey),
            nullable(input.createdVia),
            input.customerName,
            nullable(input.customerPhone),
            input.practitionerId,
            input.practitionerNameSnapshot,
            nullable(input.menuId),
            input.menuNameSnapshot,
            input.startAt,
            input.endAt,
            nullable(input.status),
            input.totalMinutes,
            nullable(input.totalPrice),
            nullable(input.calendarEventId),
            nullable(input.notes),
            nullable(input.metadata),
        ]
    );

    const reservation = reservationResult.rows[0];

    await client.query(
        `
            INSERT INTO practitioner_busy_ranges (
                practitioner_id,
                source_type,
                reservation_id,
                start_at,
                end_at
            )
            VALUES (
                $1::uuid,
                'reservation'::busy_source_type,
                $2::uuid,
                $3::timestamptz,
                $4::timestamptz
            )
        `,
        [
            reservation.practitioner_id,
            reservation.id,
            reservation.start_at,
            reservation.end_at,
        ]
    );

    return reservation;
}

async function findReservationById(client, id) {
    const result = await client.query(
        `
            SELECT *
            FROM reservations
            WHERE id = $1::uuid
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function findReservationByIdForUpdate(client, id) {
    const result = await client.query(
        `
            SELECT *
            FROM reservations
            WHERE id = $1::uuid
            LIMIT 1
            FOR UPDATE
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function findReservationByIdempotencyKey(client, lineUserId, idempotencyKey) {
    const result = await client.query(
        `
            SELECT *
            FROM reservations
            WHERE line_user_id = $1
              AND idempotency_key = $2
            LIMIT 1
        `,
        [lineUserId, idempotencyKey]
    );

    return result.rows[0] || null;
}

async function cancelReservation(client, input) {
    const result = await client.query(
        `
            UPDATE reservations
            SET status = 'canceled'::reservation_status,
                canceled_at = COALESCE(canceled_at, now()),
                cancel_reason = COALESCE($2, cancel_reason)
            WHERE id = $1::uuid
            RETURNING *
        `,
        [input.reservationId, nullable(input.cancelReason)]
    );

    return result.rows[0] || null;
}

async function releaseReservationBusyRange(client, reservationId) {
    const result = await client.query(
        `
            UPDATE practitioner_busy_ranges
            SET released_at = COALESCE(released_at, now())
            WHERE reservation_id = $1::uuid
            RETURNING *
        `,
        [reservationId]
    );

    return result.rows[0] || null;
}

async function updateCalendarEventId(client, { id, calendarEventId }) {
    const result = await client.query(
        `UPDATE reservations SET calendar_event_id = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [calendarEventId, id]
    );
    return result.rows[0];
}

module.exports = {
    createReservation,
    findReservationById,
    findReservationByIdForUpdate,
    findReservationByIdempotencyKey,
    cancelReservation,
    releaseReservationBusyRange,
    updateCalendarEventId,
};
