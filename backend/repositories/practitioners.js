async function findPractitionerById(client, id) {
    const result = await client.query(
        `
            SELECT *
            FROM practitioners
            WHERE id = $1::uuid
              AND is_active = true
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function findActivePractitioners(client, ids = null) {
    const normalizedIds = Array.isArray(ids)
        ? ids.map(id => String(id)).filter(Boolean)
        : null;
    const params = normalizedIds ? [normalizedIds] : [];

    const result = await client.query(
        `
            SELECT *
            FROM practitioners
            WHERE is_active = true
              AND (
                $1::uuid[] IS NULL
                OR id = ANY($1::uuid[])
              )
            ORDER BY sort_order, id
        `,
        normalizedIds ? params : [null]
    );

    return result.rows;
}

module.exports = {
    findPractitionerById,
    findActivePractitioners,
};
