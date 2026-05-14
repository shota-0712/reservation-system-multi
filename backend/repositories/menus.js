function nullable(value) {
    return value === undefined ? null : value;
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function parseOptionIds(optionIds) {
    if (optionIds === undefined) {
        return undefined;
    }

    if (Array.isArray(optionIds)) {
        return optionIds.map(id => String(id).trim()).filter(Boolean);
    }

    if (typeof optionIds === 'string') {
        return optionIds.split(',').map(id => id.trim()).filter(Boolean);
    }

    return [];
}

async function replaceMenuOptions(client, menuId, optionIds) {
    const ids = parseOptionIds(optionIds);

    if (ids === undefined) {
        return;
    }

    await client.query('DELETE FROM menu_options WHERE menu_id = $1::uuid', [menuId]);

    for (const [index, optionId] of ids.entries()) {
        await client.query(
            `
                INSERT INTO menu_options (menu_id, option_id, sort_order)
                VALUES ($1::uuid, $2::uuid, $3)
                ON CONFLICT (menu_id, option_id)
                DO UPDATE SET sort_order = EXCLUDED.sort_order
            `,
            [menuId, optionId, index]
        );
    }
}

async function findMenus(client, activeOnly = false) {
    const result = await client.query(
        `
            SELECT
                m.*,
                COALESCE(
                    string_agg(mo.option_id::text, ',' ORDER BY mo.sort_order, mo.option_id)
                        FILTER (WHERE mo.option_id IS NOT NULL),
                    ''
                ) AS option_ids
            FROM menus m
            LEFT JOIN menu_options mo ON mo.menu_id = m.id
            WHERE ($1::boolean = false OR m.is_active = true)
            GROUP BY m.id
            ORDER BY m.sort_order, m.id
        `,
        [activeOnly]
    );

    return result.rows;
}

async function findAllMenus(client) {
    return findMenus(client, false);
}

async function findActiveMenus(client) {
    return findMenus(client, true);
}

async function findMenuById(client, id) {
    const result = await client.query(
        `
            SELECT
                m.*,
                COALESCE(
                    string_agg(mo.option_id::text, ',' ORDER BY mo.sort_order, mo.option_id)
                        FILTER (WHERE mo.option_id IS NOT NULL),
                    ''
                ) AS option_ids
            FROM menus m
            LEFT JOIN menu_options mo ON mo.menu_id = m.id
            WHERE m.id = $1::uuid
              AND m.is_active = true
            GROUP BY m.id
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function createMenu(client, input) {
    const result = await client.query(
        `
            INSERT INTO menus (
                category,
                name,
                minutes,
                price,
                description,
                image_url,
                is_active,
                sort_order,
                metadata
            )
            VALUES (
                COALESCE($1, ''),
                $2,
                $3,
                COALESCE($4, 0),
                $5,
                $6,
                COALESCE($7, true),
                COALESCE($8, 1000),
                COALESCE($9::jsonb, '{}'::jsonb)
            )
            RETURNING *
        `,
        [
            nullable(input.category),
            input.name,
            input.minutes,
            nullable(input.price),
            nullable(input.description),
            nullable(input.imageUrl),
            nullable(input.isActive),
            nullable(input.sortOrder),
            nullable(input.metadata),
        ]
    );

    const menu = result.rows[0];
    await replaceMenuOptions(client, menu.id, input.optionIds);
    return findMenuById(client, menu.id);
}

async function updateMenu(client, input) {
    const fieldMap = {
        category: 'category',
        name: 'name',
        minutes: 'minutes',
        price: 'price',
        description: 'description',
        imageUrl: 'image_url',
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

    if (sets.length > 0) {
        params.push(input.id);
        await client.query(
            `
                UPDATE menus
                SET ${sets.join(', ')}
                WHERE id = $${params.length}::uuid
                RETURNING *
            `,
            params
        );
    }

    await replaceMenuOptions(client, input.id, input.optionIds);
    return findMenuById(client, input.id);
}

async function deactivateMenu(client, id) {
    const result = await client.query(
        `
            UPDATE menus
            SET is_active = false
            WHERE id = $1::uuid
            RETURNING *
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function reorderMenus(client, orderedIds) {
    for (const [index, id] of orderedIds.entries()) {
        await client.query(
            `
                UPDATE menus
                SET sort_order = $2
                WHERE id = $1::uuid
            `,
            [id, index + 1]
        );
    }

    return { updatedCount: orderedIds.length };
}

module.exports = {
    findMenuById,
    findAllMenus,
    findActiveMenus,
    createMenu,
    updateMenu,
    deactivateMenu,
    reorderMenus,
};
