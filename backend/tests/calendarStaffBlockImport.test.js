const test = require('node:test');
const assert = require('node:assert/strict');

const {
    importExternalEventCandidates,
} = require('../services/calendarStaffBlockImport');

const SYNC_STATE_ID = '11111111-1111-4111-8111-111111111111';
const PRACTITIONER_ID = '22222222-2222-4222-8222-222222222222';
const CALENDAR_ID = 'staff-a@example.com';
const RELEASED_AT = '2026-05-14T00:00:00.000Z';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';
const STAFF_BLOCK_ID = '44444444-4444-4444-8444-444444444444';

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

function overlaps(startA, endA, startB, endB) {
    return Date.parse(startA) < Date.parse(endB)
        && Date.parse(endA) > Date.parse(startB);
}

function conflictKey(input, status = 'open') {
    return [
        input.practitionerId,
        input.calendarId || '',
        input.calendarEventId,
        status,
    ].join(':');
}

function openConflicts(state) {
    return [...state.conflicts.values()].filter(conflict => conflict.status === 'open');
}

function resolvedConflicts(state) {
    return [...state.conflicts.values()].filter(conflict => conflict.status === 'resolved');
}

function createHarness() {
    const state = {
        blocks: new Map(),
        eventIndex: new Map(),
        busyRanges: new Map(),
        conflicts: new Map(),
    };
    const conflictEventIds = new Set();
    let nextBlockNumber = 1;
    let nextConflictNumber = 1;
    let nextConflictTimestampNumber = 1;

    function nextConflictTimestamp() {
        return new Date(Date.UTC(2026, 4, 14, 0, nextConflictTimestampNumber++)).toISOString();
    }

    function findBlockingBusyRange(input) {
        const rows = [...state.busyRanges.values()]
            .filter(range => range.practitioner_id === input.practitionerId)
            .filter(range => !range.released_at)
            .filter(range => range.staff_block_id !== input.excludeStaffBlockId)
            .filter(range => overlaps(input.startAt, input.endAt, range.start_at, range.end_at))
            .sort((a, b) => {
                if (a.source_type !== b.source_type) {
                    return a.source_type === 'reservation' ? -1 : 1;
                }
                return Date.parse(a.start_at) - Date.parse(b.start_at);
            });

        return rows[0] ? { ...rows[0] } : null;
    }

    function snapshot() {
        return {
            blocks: copyMap(state.blocks),
            eventIndex: new Map(state.eventIndex),
            busyRanges: copyMap(state.busyRanges),
            conflicts: copyMap(state.conflicts),
            nextBlockNumber,
            nextConflictNumber,
            nextConflictTimestampNumber,
        };
    }

    function restore(saved) {
        state.blocks = saved.blocks;
        state.eventIndex = saved.eventIndex;
        state.busyRanges = saved.busyRanges;
        state.conflicts = saved.conflicts;
        nextBlockNumber = saved.nextBlockNumber;
        nextConflictNumber = saved.nextConflictNumber;
        nextConflictTimestampNumber = saved.nextConflictTimestampNumber;
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
                const blockingBusyRange = findBlockingBusyRange({
                    practitionerId: staffBlock.practitioner_id,
                    startAt: staffBlock.start_at,
                    endAt: staffBlock.end_at,
                    excludeStaffBlockId: staffBlock.id,
                });

                if (conflictEventIds.has(staffBlock.external_event_id) || blockingBusyRange) {
                    const err = new Error('exclusion violation');
                    err.code = '23P01';
                    throw err;
                }

                const busyRange = {
                    id: `busy-${staffBlock.id}`,
                    practitioner_id: staffBlock.practitioner_id,
                    source_type: 'staff_block',
                    reservation_id: null,
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

        calendarSyncConflicts: {
            async findBlockingBusyRange(client, input) {
                return findBlockingBusyRange(input);
            },

            async upsertOpenConflict(client, input) {
                if (!input.calendarEventId) {
                    return null;
                }

                const key = conflictKey(input, 'open');
                const existing = state.conflicts.get(key);
                const updatedAt = nextConflictTimestamp();

                if (existing) {
                    const updated = {
                        ...existing,
                        reservation_id: input.reservationId || existing.reservation_id,
                        staff_block_id: input.staffBlockId || existing.staff_block_id,
                        detail: input.detail,
                        updated_at: updatedAt,
                    };
                    state.conflicts.set(key, updated);
                    return updated;
                }

                const conflict = {
                    id: `conflict-${nextConflictNumber++}`,
                    practitioner_id: input.practitionerId,
                    calendar_id: input.calendarId || null,
                    calendar_event_id: input.calendarEventId,
                    reservation_id: input.reservationId || null,
                    staff_block_id: input.staffBlockId || null,
                    status: 'open',
                    detail: input.detail,
                    created_at: updatedAt,
                    updated_at: updatedAt,
                    resolved_at: null,
                };
                state.conflicts.set(key, conflict);
                return conflict;
            },

            async resolveOpenConflictForEvent(client, input) {
                const key = conflictKey(input, 'open');
                const existing = state.conflicts.get(key);
                if (!existing) {
                    return null;
                }

                const updated = {
                    ...existing,
                    status: 'resolved',
                    detail: {
                        ...existing.detail,
                        resolution_reason: input.reason || 'event_imported',
                        resolved_source: input.source || null,
                    },
                    updated_at: nextConflictTimestamp(),
                    resolved_at: RELEASED_AT,
                };
                state.conflicts.delete(key);
                state.conflicts.set(conflictKey(input, 'resolved'), updated);
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

function seedReservationBusyRange(state, overrides = {}) {
    state.busyRanges.set(overrides.id || 'busy-existing-reservation', {
        id: overrides.id || 'busy-existing-reservation',
        practitioner_id: overrides.practitioner_id || PRACTITIONER_ID,
        source_type: 'reservation',
        reservation_id: overrides.reservation_id || RESERVATION_ID,
        staff_block_id: null,
        start_at: overrides.start_at || '2026-06-01T00:30:00.000Z',
        end_at: overrides.end_at || '2026-06-01T01:30:00.000Z',
        released_at: null,
    });
}

function seedStaffBlockBusyRange(state, overrides = {}) {
    state.busyRanges.set(overrides.id || 'busy-existing-staff-block', {
        id: overrides.id || 'busy-existing-staff-block',
        practitioner_id: overrides.practitioner_id || PRACTITIONER_ID,
        source_type: 'staff_block',
        reservation_id: null,
        staff_block_id: overrides.staff_block_id || STAFF_BLOCK_ID,
        start_at: overrides.start_at || '2026-06-01T00:30:00.000Z',
        end_at: overrides.end_at || '2026-06-01T01:30:00.000Z',
        released_at: null,
    });
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
    seedReservationBusyRange(harness.state);

    const result = await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'conflict-event' }),
        makeCandidate({
            google_event_id: 'ok-event',
            start: { dateTime: '2026-06-01T12:00:00+09:00' },
            end: { dateTime: '2026-06-01T13:00:00+09:00' },
        }),
    ], harness.options);
    const conflicts = openConflicts(harness.state);

    assert.equal(result.failed_count, 1);
    assert.equal(result.imported_count, 1);
    assert.equal(result.results[0].conflict, true);
    assert.equal(result.results[0].conflict_id, 'conflict-1');
    assert.equal(result.results[0].reservation_id, RESERVATION_ID);
    assert.equal(blockByEvent(harness.state, 'conflict-event'), null);
    assert.ok(blockByEvent(harness.state, 'ok-event'));
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].calendar_event_id, 'conflict-event');
    assert.equal(conflicts[0].reservation_id, RESERVATION_ID);
    assert.equal(conflicts[0].detail.reason, 'busy_range_conflict');
    assert.equal(conflicts[0].detail.event_summary, 'Private appointment');
    assert.equal(conflicts[0].detail.event_start, '2026-06-01T01:00:00.000Z');
    assert.equal(conflicts[0].detail.event_end, '2026-06-01T02:00:00.000Z');
    assert.equal(conflicts[0].detail.error_code, '23P01');
    assert.equal(conflicts[0].detail.source, 'calendar_staff_block_import');
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

test('busy range conflict against an existing staff block records staff_block_id', async () => {
    const harness = createHarness();
    seedStaffBlockBusyRange(harness.state);

    const result = await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'staff-block-conflict' }),
    ], harness.options);
    const conflicts = openConflicts(harness.state);

    assert.equal(result.failed_count, 1);
    assert.equal(result.results[0].staff_block_id, STAFF_BLOCK_ID);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].staff_block_id, STAFF_BLOCK_ID);
    assert.equal(conflicts[0].reservation_id, null);
    assert.equal(conflicts[0].detail.conflicting_busy_range.staff_block_id, STAFF_BLOCK_ID);
});

test('reprocessing the same conflict updates one open conflict instead of duplicating it', async () => {
    const harness = createHarness();
    seedReservationBusyRange(harness.state);

    await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'same-conflict' }),
    ], harness.options);
    const firstConflict = openConflicts(harness.state)[0];

    await importExternalEventCandidates([
        makeCandidate({
            google_event_id: 'same-conflict',
            summary: 'Updated manual block',
            etag: '"etag-2"',
        }),
    ], harness.options);
    const conflicts = openConflicts(harness.state);

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].id, firstConflict.id);
    assert.equal(conflicts[0].created_at, firstConflict.created_at);
    assert.notEqual(conflicts[0].updated_at, firstConflict.updated_at);
    assert.equal(conflicts[0].detail.event_summary, 'Updated manual block');
    assert.equal(conflicts[0].detail.external_event_etag, '"etag-2"');
});

test('successful later import resolves an existing open conflict', async () => {
    const harness = createHarness();
    seedReservationBusyRange(harness.state);

    await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'event-that-recovers' }),
    ], harness.options);
    harness.state.busyRanges.delete('busy-existing-reservation');

    const result = await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'event-that-recovers' }),
    ], harness.options);
    const resolved = resolvedConflicts(harness.state);

    assert.equal(result.imported_count, 1);
    assert.equal(result.failed_count, 0);
    assert.equal(result.results[0].conflict_resolved, true);
    assert.equal(openConflicts(harness.state).length, 0);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].calendar_event_id, 'event-that-recovers');
    assert.equal(resolved[0].detail.resolution_reason, 'event_imported');
});

test('cancelled event resolves a related open conflict even without an imported block', async () => {
    const harness = createHarness();
    seedReservationBusyRange(harness.state);

    await importExternalEventCandidates([
        makeCandidate({ google_event_id: 'cancelled-conflict' }),
    ], harness.options);
    const result = await importExternalEventCandidates([
        makeCandidate({
            google_event_id: 'cancelled-conflict',
            status: 'cancelled',
            start: null,
            end: null,
        }),
    ], harness.options);
    const resolved = resolvedConflicts(harness.state);

    assert.equal(result.skipped_count, 1);
    assert.equal(result.results[0].reason, 'missing_existing_block');
    assert.equal(openConflicts(harness.state).length, 0);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].detail.resolution_reason, 'event_cancelled');
});
