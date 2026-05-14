const test = require('node:test');
const assert = require('node:assert/strict');

function loadDbWithFakePool(createClient) {
    const pgPath = require.resolve('pg');
    const dbPath = require.resolve('../services/db');
    const originalPgCache = require.cache[pgPath];
    const originalDbCache = require.cache[dbPath];

    class FakePool {
        constructor(config) {
            this.config = config;
        }

        async connect() {
            return createClient(this.config);
        }

        async query(text, params) {
            const client = await this.connect();
            return client.query(text, params);
        }

        async end() {}
    }

    delete require.cache[dbPath];
    require.cache[pgPath] = {
        id: pgPath,
        filename: pgPath,
        loaded: true,
        exports: { Pool: FakePool },
    };

    const db = require('../services/db');

    return {
        db,
        restore() {
            delete require.cache[dbPath];

            if (originalDbCache) {
                require.cache[dbPath] = originalDbCache;
            }

            if (originalPgCache) {
                require.cache[pgPath] = originalPgCache;
            } else {
                delete require.cache[pgPath];
            }
        },
    };
}

test('withTransaction commits and releases the same client on success', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/test';

    const queries = [];
    let released = false;
    const { db, restore } = loadDbWithFakePool(() => ({
        async query(text) {
            queries.push(text);
            return { rows: [] };
        },
        release() {
            released = true;
        },
    }));

    try {
        const result = await db.withTransaction(async (client) => {
            await client.query('SELECT 1');
            return 'ok';
        });

        assert.equal(result, 'ok');
        assert.deepEqual(queries, ['BEGIN', 'SELECT 1', 'COMMIT']);
        assert.equal(released, true);
    } finally {
        restore();
        if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
        }
    }
});

test('withTransaction rolls back and releases the same client on error', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/test';

    const queries = [];
    let released = false;
    const { db, restore } = loadDbWithFakePool(() => ({
        async query(text) {
            queries.push(text);
            return { rows: [] };
        },
        release() {
            released = true;
        },
    }));

    try {
        await assert.rejects(
            db.withTransaction(async () => {
                throw new Error('boom');
            }),
            /boom/
        );

        assert.deepEqual(queries, ['BEGIN', 'ROLLBACK']);
        assert.equal(released, true);
    } finally {
        restore();
        if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
        }
    }
});

test('production pool uses ssl config', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/test';
    process.env.NODE_ENV = 'production';

    let receivedConfig;
    const { db, restore } = loadDbWithFakePool((config) => {
        receivedConfig = config;
        return {
            async query() {
                return { rows: [] };
            },
            release() {},
        };
    });

    try {
        await db.query('SELECT 1');

        assert.deepEqual(receivedConfig.ssl, { rejectUnauthorized: false });
    } finally {
        await db.closePool();
        restore();
        if (previousDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = previousDatabaseUrl;
        }

        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }
    }
});
