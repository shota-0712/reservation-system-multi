function settingValue(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'object') {
        return JSON.stringify(value);
    }

    return String(value);
}

async function getAllSettings(client) {
    const result = await client.query(
        `
            SELECT key, value
            FROM settings
            ORDER BY key
        `
    );

    return result.rows.reduce((settings, row) => {
        settings[row.key] = row.value;
        return settings;
    }, {});
}

async function upsertSettings(client, settingsObj) {
    for (const [key, value] of Object.entries(settingsObj || {})) {
        await client.query(
            `
                INSERT INTO settings (key, value)
                VALUES ($1, $2)
                ON CONFLICT (key)
                DO UPDATE SET value = EXCLUDED.value
            `,
            [key, settingValue(value)]
        );
    }

    return getAllSettings(client);
}

async function getSetting(client, key) {
    const result = await client.query(
        `
            SELECT value
            FROM settings
            WHERE key = $1
            LIMIT 1
        `,
        [key]
    );

    return result.rows[0]?.value ?? null;
}

module.exports = {
    getAllSettings,
    upsertSettings,
    getSetting,
};
