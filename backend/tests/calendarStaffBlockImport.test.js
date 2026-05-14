const test = require('node:test');
const assert = require('node:assert/strict');

const {
    importExternalEventCandidates,
} = require('../services/calendarStaffBlockImport');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';
const PRACTITIONER_ID = '22222222-2222-4222-8222-222222222222';
const CALENDAR_ID = 'staff-a@example.com';
const RELEASED_AT = '2026-05-14T00:00:00.000Z';

function makeCandidate(overrides = {}) {
    return {
        calendar_sync_state_id: SYNC_STATE_ID,
        practitioner_id: PRACTITIONER_ID,
        calendar_id: CALENDAR_ID,
        google_event_id: 'external-event-1',
        etag: '"etag-1"',
        status: 'confirmed',
        summary: 'Private appointment',
        description: 'manual calendar block',
        start: { dateTime: '2026-06-01T10:00:00+09:00' },
        end: { dateTime: '2026-06-01T11:00:00+09:00' },
        updated: '2026-05-14T01:00:00.000Z',
        ...overrides,
    };
}

function eventKey(calendarId, externalEventId) {
    return `${calendarId}:${externalEventId}`;
}

function copyMap(map) {
    return new Map([...map].map(([key, value]) => [key, { ...value }]));
}

function createHarness() {
    const state = {
        blocks: new Map(),
        eventIndex: new Map(),
        busyRanges: new Map(),
    };
    const conflictEventIds = new Set();
    let nextBlockNumber = 1;

    function snapshot() {
        return {
            blocks: copyMap(state.blocks),
            eventIndex: new Map(state.eventIndex),
            busyRanges: copyMap(state.busyRanges),
            nextBlockNumber,
        };
    }

    function restore(saved) {
        state.blocks = saved.blocks;
        state.eventIndex = saved.eventIndex;
        state.busyRanges = saved.busyRanges;
        nextBlockNumber = saved.nextBlockNumber;
    }

    const repositories = {
        staffBlocks: {
            async upsertGoogleCalendarStaffBlock(client, input) {
                const key = eventKey(input.calendarId, input.externalEventId);
                const existingId = state.eventIndex.get(key);
                if (existingId) {
                    const existing = state.blocks.get(existingId);
                    const updated = {
                        ...existing,
                        practitioner_id: input.practitionerId,
                        start_at: input.startAt,
                        end_at: input.endAt,
                        status: 'active',
                        reason: input.reason,
                        external_event_etag: input.externalEventEtag,
                        external_event_updated_at: input.externalEventUpdatedAt,
                        canceled_at: null,
                        cancel_reason: null,
                        metadata: input.metadata,
                        inserted: false,
                    };
                    state.blocks.set(existingId, updated);
                    return updated;
                }

                const id = `staff-block-${nextBlockNumber++}`;
                const staffBlock = {
                    id,
                    practitioner_id: input.practitionerId,
                    start_at: input.startAt,
                    end_at: input.endAt,
                    source: 'google_calendar',
                    status: 'active',
                    reason: input.reason,
                    calendar_id: input.calendarId,
                    external_event_id: input.externalEventId,
                    external_event_etag: input.externalEventEtag,
                    external_event_updated_at: input.externalEventUpdatedAt,
                    canceled_at: null,
                    cancel_reason: null,
                    metadata: input.metadata,
                    inserted: true,
                };

                state.blocks.set(id, staffBlock);
                state.eventIndex.set(key, id);
                return staffBlock;
            },

            async upsertStaffBlockBusyRange(client, staffBlock) {
                if (conflictEventIds.has(staffBlock.external_event_id)) {
                    const err = new Error('exclusion violation');
                    err.code = '23P01';
                    throw err;
                }

                const busyRange = {
                    id: `busy-${staffBlock.id}`,
                    practitioner_id: staffBlock.practitioner_id,
                    source_type: 'staff_block',
                    staff_block_id: staffBlock.id,
                    start_at: staffBlock.start_at,
                    end_at: staffBlock.end_at,
                    released_at: null,
                };
                state.busyRanges.set(staffBlock.id, busyRange);
                return busyRange;
            },

            async findByCalendarEventForUpdate(client, input) {
                const id = state.eventIndex.get(eventKey(input.calendarId, input.externalEventId));
                return id ? { ...state.blocks.get(id) } : null;
            },

            async cancelGoogleCalendarStaffBlock(client, input) {
                const existing = state.blocks.get(input.id);
                if (!existing) {
                    return null;
                }

                const updated = {
                    ...existing,
                    status: 'canceled',
                    canceled_at: existing.canceled_at || RELEASED_AT,
                    cancel_reason: input.cancelReason || existing.cancel_reason,
                    external_event_etag: input.externalEventEtag || existing.external_event_etag,
                    external_event_updated_at: input.externalEventUpdatedAt || existing.external_event_updated_at,
                    metadata: input.metadata || existing.metadata,
                };
                state.blocks.set(input.id, updated);
                return updated;
            },

            async releaseStaffBlockBusyRange(client, staffBlockId) {
                const existing = state.busyRanges.get(staffBlockId);
                if (!existing) {
                    return null;
                }

                const updated = {
                    ...existing,
                    released_at: existing.released_at || RELEASED_AT,
                };
                state.busyRanges.set(staffBlockId, updated);
                return updated;
            },
        },
    };

    const db = {
        async withTransaction(callback) {
            const saved = snapshot();
            try {
                return await callback({ tx: true });
            } catch (err) {
                restore(saved);
                throw err;
            }
        },
    };

    return {
        options: { db, repositories },
        state,
        conflictEventIds,
    };
}

function blockByEvent(state, externalEventId, calendarId = CALENDAR_ID) {
    const id = state.eventIndex.get(eventKey(calendarId, externalEventId));
    return id ? state.blocks.get(id) : null;
}

test('imports new timed Calendar event as staff block and busy range', async () => {
    const harness = createHarness();

    const result = await importExternalEventCandidates([makeCandidate()], harness.options);
    const block = blockByEvent(harness.state, 'external-event-1');
    const busyRange = harness.state.busyRanges.get(block.id);

    assert.equal(result.imported_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(block.source, 'google_calendar');
    assert.equal(block.status, 'active');
    assert.equal(block.reason, 'Private appointment');
    assert.equal(block.start_at, '2026-06-01T01:00:00.000Z');
    assert.equal(busyRange.released_at, null);
    assert.equal(busyRange.staff_block_id, block.id);
});

test('processing the same event twice updates one block without duplicate busy range', async () => {
    const harness = createHarness();

    await importExternalEventCandidates([makeCandidate()], harness.options);
    const second = await importExternalEventCandidates([makeCandidate()], harness.options);

    assert.equal(second.imported_count, 0);
    assert.equal(second.updated_count, 1);
    assert.equal(harness.state.blocks.size, 1);
    assert.equal(harness.state.busyRanges.size, 1);
});

test('summary and time changes update the block and busy range', async () => {
    const harness = createHarness();

    await importExternalEventCandidates([makeCandidate()], harness.options);
    const result = await importExternalEventCandidates([
        makeCandidate({
            summary: 'No nomination',
            start: { dateTime: '2026-06-01T12:00:00+09:00' },
            end: { dateTime: '2026-06-01T13:00:00+09:00' },
            etag: '"etag-2"',
        }),
    ], harness.options);

    const block = blockByEvent(harness.state, 'external-event-1');
    const busyRange = harness.state.busyRanges.get(block.id);

    assert.equal(result.updated_count, 1);
    assert.equal(block.reason, 'No nomination');
    assert.equal(block.start_at, '2026-06-01T03:00:00.000Z');
    assert.equal(block.external_event_etag, '"etag-2"');
    assert.equal(busyRange.start_at, '2026-06-01T03:00:00.000Z');
    assert.equal(busyRange.released_at, null);
});

test('cancelled event cancels existing block and releases busy range idempotently', async () => {
    const harness = createHarness();
    const cancelled = makeCandidate({
        status: 'cancelled',
        start: null,
        end: null,
    });

    await importExternalEventCandidates([makeCandidate()], harness.options);
    const firstCancel = await importExternalEventCandidates([cancelled], harness.options);
    const secondCancel = await importExternalEventCandidates([cancelled], harness.options);

    const block = blockByEvent(harness.state, 'external-event-1');
    const busyRange = harness.state.busyRanges.get(block.id);

    assert.equal(firstCancel.released_count, 1);
    assert.equal(secondCancel.released_count, 0);
    assert.equal(secondCancel.failed_count, 0);
    assert.equal(secondCancel.results[0].changed, false);
    assert.equal(block.status, 'canceled');
    assert.equal(block.canceled_at, RELEASED_AT);
    assert.equal(busyRange.released_at, RELEASED_AT);
});

test('all-day events and events without timed start or end are skipped', async () => {
    const harness = createHarness();

    const result = await importExternalEventCandidates([
        makeCandidate({
            google_event_id: 'all-day-event',
            start: { date: '2026-06-01' },
            end: { date: '2026-06-02' },
        }),
        makeCandidate({
            google_event_id: 'missing-end-event',
            end: {},
        }),
    ], harness.options);

    assert.equal(result.skipped_count, 2);
    assert.deepEqual(result.results.map(item => item.reason), [
        'all_day_event',
        'missing_start_or_end',
    ]);
    assert.equal(harness.state.blocks.size, 0);
    assert.equal(harness.state.busyRanges.size, 0);
});

test('busy range conflict fails one event without stopping later imports', async () => {
    const harness = createHarness();
    harness.conflictEventIds.add('conflict-event');

    const result = await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'conflict-event' }),
        makeCandidate({ google_event_id: 'ok-event' }),
    ], harness.options);

    assert.equal(result.failed_count, 1);
    assert.equal(result.imported_count, 1);
    assert.equal(result.results[0].conflict, true);
    assert.equal(blockByEvent(harness.state, 'conflict-event'), null);
    assert.ok(blockByEvent(harness.state, 'ok-event'));
});

test('busy range conflict while updating preserves the existing block', async () => {
    const harness = createHarness();

    await importExternalEventCandidates([makeCandidate()], harness.options);
    harness.conflictEventIds.add('external-event-1');

    const result = await importExternalEventCandidates([
        makeCandidate({
            summary: 'Moved private appointment',
            start: { dateTime: '2026-06-01T12:00:00+09:00' },
            end: { dateTime: '2026-06-01T13:00:00+09:00' },
        }),
    ], harness.options);

    const block = blockByEvent(harness.state, 'external-event-1');
    const busyRange = harness.state.busyRanges.get(block.id);

    assert.equal(result.failed_count, 1);
    assert.equal(block.reason, 'Private appointment');
    assert.equal(block.start_at, '2026-06-01T01:00:00.000Z');
    assert.equal(busyRange.start_at, '2026-06-01T01:00:00.000Z');
});
