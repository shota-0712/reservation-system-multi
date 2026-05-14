function nullable(value) {
    return value === undefined ? null : value;
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function additionalMinutesFrom(input) {
    return input.additionalMinutes ?? input.minutes;
}

function additionalPriceFrom(input) {
    return input.additionalPrice ?? input.price;
}

async function findOptions(client, activeOnly = false) {
    const result = await client.query(
        `
            SELECT *
            FROM options
            WHERE ($1::boolean = false OR is_active = true)
            ORDER BY sort_order, id
        `,
        [activeOnly]
    );

    return result.rows;
}

async function findAllOptions(client) {
    return findOptions(client, false);
}

async function findActiveOptions(client) {
    return findOptions(client, true);
}

async function findOptionsByMenuId(client, menuId) {
    const result = await client.query(
        `
            SELECT o.*
            FROM menu_options mo
            JOIN options o ON o.id = mo.option_id
            WHERE mo.menu_id = $1::uuid
              AND o.is_active = true
            ORDER BY mo.sort_order, o.sort_order, o.id
        `,
        [menuId]
    );

    return result.rows;
}

async function createOption(client, input) {
    const result = await client.query(
        `
            INSERT INTO options (
                name,
                additional_minutes,
                additional_price,
                description,
                is_active,
                sort_order,
                metadata
            )
            VALUES (
                $1,
                COALESCE($2, 0),
                COALESCE($3, 0),
                $4,
                COALESCE($5, true),
                COALESCE($6, 1000),
                COALESCE($7::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            input.name,
            nullable(additionalMinutesFrom(input)),
            nullable(additionalPriceFrom(input)),
            nullable(input.description),
            nullable(input.isActive),
            nullable(input.sortOrder),
            nullable(input.metadata),
        ]
    );

    return result.rows[0];
}

async function updateOption(client, input) {
    const fieldMap = {
        name: 'name',
        additionalMinutes: 'additional_minutes',
        minutes: 'additional_minutes',
        additionalPrice: 'additional_price',
        price: 'additional_price',
        description: 'description',
        isActive: 'is_active',
        sortOrder: 'sort_order',
        metadata: 'metadata',
    };
    const sets = [];
    const params = [];
    const seenColumns = new Set();

    for (const [field, column] of Object.entries(fieldMap)) {
        if (!hasOwn(input, field) || seenColumns.has(column)) {
            continue;
        }

        params.push(input[field]);
        const cast = field === 'metadata' ? '::jsonb' : '';
        sets.push(`${column} = $${params.length}${cast}`);
        seenColumns.add(column);
    }

    if (sets.length === 0) {
        return null;
    }

    params.push(input.id);
    const result = await client.query(
        `
            UPDATE options
            SET ${sets.join(', ')}
            WHERE id = $${params.length}::uuid
            RETURNING *
        `,
        params
    );

    return result.rows[0] || null;
}

async function deactivateOption(client, id) {
    const result = await client.query(
        `
            UPDATE options
            SET is_active = false
            WHERE id = $1::uuid
            RETURNING *
        `,
        [id]
    );

    return result.rows[0] || null;
}

module.exports = {
    findAllOptions,
    findActiveOptions,
    findOptionsByMenuId,
    createOption,
    updateOption,
    deactivateOption,
};
