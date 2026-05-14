const { Pool } = require('pg');

let pool;

function buildPoolConfig() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
        throw new Error('DATABASE_URL is required for Postgres connection');
    }

    const config = {
        connectionString,
    };

    if (process.env.NODE_ENV === 'production') {
        config.ssl = {
            rejectUnauthorized: false,
        };
    }

    return config;
}

function getPool() {
    if (!pool) {
        pool = new Pool(buildPoolConfig());
    }

    return pool;
}

async function query(text, params) {
    return getPool().query(text, params);
}

async function withTransaction(callback) {
    const client = await getPool().connect();

    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            console.error('Transaction rollback failed:', rollbackErr);
        }
        throw err;
    } finally {
        client.release();
    }
}

async function closePool() {
    if (!pool) {
        return;
    }

    await pool.end();
    pool = null;
}

module.exports = {
    getPool,
    query,
    withTransaction,
    closePool,
};
