async function findMenuById(client, id) {
    const result = await client.query(
        `
            SELECT *
            FROM menus
            WHERE id = $1::uuid
              AND is_active = true
            LIMIT 1
        `,
        [id]
    );

    return result.rows[0] || null;
}

module.exports = {
    findMenuById,
};
