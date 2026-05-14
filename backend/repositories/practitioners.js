function nullable(value) {
    return value === undefined ? null : value;
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

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

async function findAllPractitioners(client) {
    const result = await client.query(
        `
            SELECT *
            FROM practitioners
            ORDER BY sort_order, id
        `
    );

    return result.rows;
}

async function findActivePractitioners(client, ids = null) {
    const normalizedIds = Array.isArray(ids)
        ? ids.map(id => String(id)).filter(Boolean)
        : null;

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
        [normalizedIds]
    );

    return result.rows;
}

async function createPractitioner(client, input) {
    const result = await client.query(
        `
            INSERT INTO practitioners (
                name,
                calendar_id,
                title,
                image_url,
                description,
                sns,
                experience,
                nomination_fee,
                pr_title,
                is_active,
                sort_order,
                metadata
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                COALESCE($8, 0),
                $9,
                COALESCE($10, true),
                COALESCE($11, 1000),
                COALESCE($12::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            input.name,
            nullable(input.calendarId),
            nullable(input.title),
            nullable(input.imageUrl),
            nullable(input.description),
            nullable(input.sns),
            nullable(input.experience),
            nullable(input.nominationFee),
            nullable(input.prTitle),
            nullable(input.isActive),
            nullable(input.sortOrder),
            nullable(input.metadata),
        ]
    );

    return result.rows[0];
}

async function updatePractitioner(client, input) {
    const fieldMap = {
        name: 'name',
        calendarId: 'calendar_id',
        title: 'title',
        imageUrl: 'image_url',
        description: 'description',
        sns: 'sns',
        experience: 'experience',
        nominationFee: 'nomination_fee',
        prTitle: 'pr_title',
        isActive: 'is_active',
        sortOrder: 'sort_order',
        metadata: 'metadata',
    };
    const sets = [];
    const params = [];

    for (const [field, column] of Object.entries(fieldMap)) {
        if (!hasOwn(input, field)) {
            continue;
        }

        params.push(input[field]);
        const cast = field === 'metadata' ? '::jsonb' : '';
        sets.push(`${column} = $${params.length}${cast}`);
    }

    if (sets.length === 0) {
        return findPractitionerById(client, input.id);
    }

    params.push(input.id);
    const result = await client.query(
        `
            UPDATE practitioners
            SET ${sets.join(', ')}
            WHERE id = $${params.length}::uuid
            RETURNING *
        `,
        params
    );

    return result.rows[0] || null;
}

async function deactivatePractitioner(client, id) {
    const result = await client.query(
        `
            UPDATE practitioners
            SET is_active = false
            WHERE id = $1::uuid
            RETURNING *
        `,
        [id]
    );

    return result.rows[0] || null;
}

module.exports = {
    findPractitionerById,
    findAllPractitioners,
    findActivePractitioners,
    createPractitioner,
    updatePractitioner,
    deactivatePractitioner,
};
