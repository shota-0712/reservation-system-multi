const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const PRACTITIONER_ID = '11111111-1111-4111-8111-111111111111';
const STAFF_BLOCK_ID = '44444444-4444-4444-8444-444444444444';

function staffBlockPayload(overrides = {}) {
    return {
        adminId: 'Uadmin',
        practitionerId: PRACTITIONER_ID,
        startAt: '2026-06-01T10:00:00+09:00',
        endAt: '2026-06-01T11:00:00+09:00',
        reason: '休憩',
        source: 'admin',
        ...overrides,
    };
}

function mockStaffBlockRow(overrides = {}) {
    return {
        id: STAFF_BLOCK_ID,
        practitioner_id: PRACTITIONER_ID,
        start_at: new Date('2026-06-01T01:00:00.000Z'),
        end_at: new Date('2026-06-01T02:00:00.000Z'),
        source: 'admin',
        status: 'active',
        reason: '休憩',
        calendar_id: null,
        external_event_id: null,
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

async function withStaffBlockApiServer(options, callback) {
    const calls = {
        createStaffBlock: [],
        findById: [],
        releaseStaffBlock: [],
        releaseStaffBlockBusyRange: [],
        findByPractitioner: [],
        createAuditLog: [],
        withTransaction: [],
    };

    const cacheEntries = new Map();
    const previousAdminLineId = process.env.ADMIN_LINE_ID;
    const previousLineChannelId = process.env.LINE_CHANNEL_ID;

    function remember(resolvedPath) {
        if (!cacheEntries.has(resolvedPath)) {
            cacheEntries.set(resolvedPath, require.cache[resolvedPath]);
        }
    }

    function setModule(resolvedPath, exports) {
        remember(resolvedPath);
        require.cache[resolvedPath] = { id: resolvedPath, filename: resolvedPath, loaded: true, exports };
    }

    function clearModule(resolvedPath) {
        remember(resolvedPath);
        delete require.cache[resolvedPath];
    }

    const apiPath = require.resolve('../routes/api');
    const lineAuthPath = require.resolve('../services/lineAuth');
    const requireLineUserPath = require.resolve('../middleware/requireLineUser');

    try {
        process.env.ADMIN_LINE_ID = options.adminLineId !== undefined ? options.adminLineId : 'Uadmin';
        process.env.LINE_CHANNEL_ID = '1234567890';

        const mockStaffBlock = options.staffBlockRow || mockStaffBlockRow();

        setModule(require.resolve('../services/db'), {
            withTransaction: async (cb) => {
                calls.withTransaction.push('BEGIN');
                try {
                    const result = await cb({ fakeClient: true });
                    calls.withTransaction.push('COMMIT');
                    return result;
                } catch (err) {
                    calls.withTransaction.push('ROLLBACK');
                    throw err;
                }
            },
        });

        setModule(require.resolve('../repositories'), {
            practitioners: {
                async findPractitionerById() { return null; },
                async findActivePractitioners() { return []; },
            },
            reservations: {},
            outboxEvents: {},
            auditLogs: {
                async createAuditLog(client, input) {
                    calls.createAuditLog.push(input);
                    return { id: 'audit-1', ...input };
                },
            },
            menus: {},
            staffBlocks: {
                async createStaffBlock(client, input) {
                    calls.createStaffBlock.push(input);
                    if (options.createStaffBlockError) {
                        throw options.createStaffBlockError;
                    }
                    return mockStaffBlock;
                },
                async findById(client, id) {
                    calls.findById.push(id);
                    return Object.prototype.hasOwnProperty.call(options, 'findByIdRow')
                        ? options.findByIdRow
                        : mockStaffBlock;
                },
                async releaseStaffBlock(client, id) {
                    calls.releaseStaffBlock.push(id);
                    return { ...mockStaffBlock, status: 'released' };
                },
                async releaseStaffBlockBusyRange(client, id) {
                    calls.releaseStaffBlockBusyRange.push(id);
                    return null;
                },
                async findByPractitioner(client, opts) {
                    calls.findByPractitioner.push(opts);
                    return options.staffBlocksList || [mockStaffBlock];
                },
            },
        });

        setModule(require.resolve('../services/sheets'), { getSettings: async () => ({}) });
        setModule(require.resolve('../services/calendar'), { async createEvent() {}, async deleteEvent() {} });
        setModule(require.resolve('../services/line'), { async pushMessage() {} });
        setModule(require.resolve('../services/storage'), {});

        clearModule(apiPath);
        clearModule(lineAuthPath);
        clearModule(requireLineUserPath);

        const router = require('../routes/api');
        const app = express();
        app.use(express.json());
        app.use('/api', router);
        app.use((err, req, res, next) => {
            res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
        });

        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        const { port } = server.address();
        try {
            return await callback({ baseUrl: `http://127.0.0.1:${port}`, calls });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    } finally {
        if (previousAdminLineId === undefined) {
            delete process.env.ADMIN_LINE_ID;
        } else {
            process.env.ADMIN_LINE_ID = previousAdminLineId;
        }
        if (previousLineChannelId === undefined) {
            delete process.env.LINE_CHANNEL_ID;
        } else {
            process.env.LINE_CHANNEL_ID = previousLineChannelId;
        }

        for (const [resolvedPath, cacheEntry] of cacheEntries) {
            if (cacheEntry === undefined) {
                delete require.cache[resolvedPath];
            } else {
                require.cache[resolvedPath] = cacheEntry;
            }
        }
    }
}

// ====================
// POST /api/admin/staff-blocks
// ====================

test('POST /api/admin/staff-blocks returns 403 when adminId is invalid', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(staffBlockPayload({ adminId: 'Unotadmin' })),
        });
        const body = await response.json();

        assert.equal(response.status, 403);
        assert.equal(body.status, 'error');
        assert.equal(calls.createStaffBlock.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/staff-blocks returns 400 when practitionerId is missing', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const { practitionerId, ...payload } = staffBlockPayload();
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.createStaffBlock.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/staff-blocks returns 400 when endAt <= startAt', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(staffBlockPayload({
                startAt: '2026-06-01T11:00:00+09:00',
                endAt: '2026-06-01T10:00:00+09:00',
            })),
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.status, 'error');
        assert.equal(calls.createStaffBlock.length, 0);
        assert.equal(calls.withTransaction.length, 0);
    });
});

test('POST /api/admin/staff-blocks returns 409 when busy range conflict occurs', async () => {
    const createStaffBlockError = new Error('exclusion violation');
    createStaffBlockError.code = '23P01';

    await withStaffBlockApiServer({ createStaffBlockError }, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(staffBlockPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 409);
        assert.equal(body.status, 'error');
        assert.equal(body.message, '指定時間帯に予約またはブロックがすでに存在します');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.createAuditLog.length, 0);
    });
});

test('POST /api/admin/staff-blocks returns 201 and staffBlock on success', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(staffBlockPayload()),
        });
        const body = await response.json();

        assert.equal(response.status, 201);
        assert.equal(body.status, 'success');
        assert.ok(body.staffBlock);
        assert.equal(body.staffBlock.id, STAFF_BLOCK_ID);
        assert.equal(calls.createStaffBlock.length, 1);
        assert.equal(calls.createStaffBlock[0].practitionerId, PRACTITIONER_ID);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('POST /api/admin/staff-blocks creates audit_log with admin actor on success', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(`${baseUrl}/api/admin/staff-blocks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(staffBlockPayload()),
        });

        assert.equal(response.status, 201);
        assert.equal(calls.createAuditLog.length, 1);
        assert.equal(calls.createAuditLog[0].actorType, 'admin');
        assert.equal(calls.createAuditLog[0].actorId, 'Uadmin');
        assert.equal(calls.createAuditLog[0].action, 'staff_block.create');
        assert.equal(calls.createAuditLog[0].entityType, 'staff_block');
        assert.ok(calls.createAuditLog[0].afterData);
    });
});

// ====================
// DELETE /api/admin/staff-blocks/:id
// ====================

test('DELETE /api/admin/staff-blocks/:id returns 404 when block does not exist', async () => {
    await withStaffBlockApiServer({ findByIdRow: null }, async ({ baseUrl, calls }) => {
        const response = await fetch(
            `${baseUrl}/api/admin/staff-blocks/${STAFF_BLOCK_ID}?adminId=Uadmin`,
            { method: 'DELETE' }
        );
        const body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(body.status, 'error');
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'ROLLBACK']);
        assert.equal(calls.releaseStaffBlock.length, 0);
        assert.equal(calls.createAuditLog.length, 0);
    });
});

test('DELETE /api/admin/staff-blocks/:id returns 200 with released block on success', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(
            `${baseUrl}/api/admin/staff-blocks/${STAFF_BLOCK_ID}?adminId=Uadmin`,
            { method: 'DELETE' }
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.ok(body.staffBlock);
        assert.equal(body.staffBlock.status, 'released');
        assert.equal(calls.releaseStaffBlock.length, 1);
        assert.equal(calls.releaseStaffBlockBusyRange.length, 1);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('DELETE /api/admin/staff-blocks/:id returns 200 idempotently when already released', async () => {
    const releasedBlock = mockStaffBlockRow({ status: 'released' });

    await withStaffBlockApiServer({ findByIdRow: releasedBlock }, async ({ baseUrl, calls }) => {
        const response = await fetch(
            `${baseUrl}/api/admin/staff-blocks/${STAFF_BLOCK_ID}?adminId=Uadmin`,
            { method: 'DELETE' }
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.equal(body.staffBlock.status, 'released');
        assert.equal(calls.releaseStaffBlock.length, 0);
        assert.equal(calls.createAuditLog.length, 0);
        assert.deepEqual(calls.withTransaction, ['BEGIN', 'COMMIT']);
    });
});

test('DELETE /api/admin/staff-blocks/:id creates audit_log on success', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const response = await fetch(
            `${baseUrl}/api/admin/staff-blocks/${STAFF_BLOCK_ID}?adminId=Uadmin`,
            { method: 'DELETE' }
        );

        assert.equal(response.status, 200);
        assert.equal(calls.createAuditLog.length, 1);
        assert.equal(calls.createAuditLog[0].actorType, 'admin');
        assert.equal(calls.createAuditLog[0].action, 'staff_block.release');
        assert.equal(calls.createAuditLog[0].entityType, 'staff_block');
    });
});

// ====================
// GET /api/admin/staff-blocks
// ====================

test('GET /api/admin/staff-blocks returns filtered staffBlocks with practitionerId and from/to', async () => {
    const from = '2026-06-01T00:00:00+09:00';
    const to = '2026-06-01T23:59:59+09:00';

    await withStaffBlockApiServer({}, async ({ baseUrl, calls }) => {
        const url = new URL(`${baseUrl}/api/admin/staff-blocks`);
        url.searchParams.set('adminId', 'Uadmin');
        url.searchParams.set('practitionerId', PRACTITIONER_ID);
        url.searchParams.set('from', from);
        url.searchParams.set('to', to);

        const response = await fetch(url.toString());
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.status, 'success');
        assert.ok(Array.isArray(body.staffBlocks));
        assert.equal(body.staffBlocks.length, 1);
        assert.equal(calls.findByPractitioner.length, 1);
        assert.equal(calls.findByPractitioner[0].practitionerId, PRACTITIONER_ID);
        assert.equal(calls.findByPractitioner[0].from, from);
        assert.equal(calls.findByPractitioner[0].to, to);
    });
});

test('GET /api/admin/staff-blocks returns 403 when adminId is invalid', async () => {
    await withStaffBlockApiServer({}, async ({ baseUrl }) => {
        const response = await fetch(
            `${baseUrl}/api/admin/staff-blocks?adminId=Unotadmin`
        );
        const body = await response.json();

        assert.equal(response.status, 403);
        assert.equal(body.status, 'error');
    });
});
