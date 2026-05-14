const db = require('./db');
const calendarService = require('./calendar');
const repositories = require('../repositories');

const DEFAULT_FULL_SYNC_PAST_DAYS = 1;
const DEFAULT_FULL_SYNC_FUTURE_DAYS = 90;
const DEFAULT_BATCH_LIMIT = 20;
const MAX_BATCH_LIMIT = 100;
const SYSTEM_EVENT_SOURCE = 'reservation_system';

function addDays(date, days) {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
}

function clampLimit(limit) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return DEFAULT_BATCH_LIMIT;
    }
    return Math.min(parsed, MAX_BATCH_LIMIT);
}

function serializeError(err) {
    const status = err?.code || err?.status || err?.response?.status || null;
    const message = err?.message || String(err);
    return [status, message].filter(Boolean).join(' ').slice(0, 2000);
}

function isSyncTokenExpiredError(err) {
    const status = Number(err?.code || err?.status || err?.response?.status);
    if (status === 410) {
        return true;
    }

    return /sync token/i.test(err?.message || '') && /(expired|invalid|gone)/i.test(err.message);
}

function isSystemCreatedEvent(event) {
    return event?.extendedProperties?.private?.source === SYSTEM_EVENT_SOURCE;
}

function normalizeStateIds(stateIds) {
    if (!stateIds) {
        return [];
    }

    const values = Array.isArray(stateIds) ? stateIds : [stateIds];
    return values
        .map(value => String(value || '').trim())
        .filter(Boolean);
}

function toExternalEventCandidate(syncState, event) {
    return {
        calendar_sync_state_id: syncState.id,
        practitioner_id: syncState.practitioner_id,
        calendar_id: syncState.calendar_id,
        google_event_id: event.id || null,
        etag: event.etag || null,
        status: event.status || null,
        summary: event.summary || '',
        description: event.description || '',
        start: event.start || null,
        end: event.end || null,
        updated: event.updated || null,
        recurring_event_id: event.recurringEventId || null,
        original_start_time: event.originalStartTime || null,
        html_link: event.htmlLink || null,
        raw_event: event,
    };
}

function buildFullSyncParams(syncState, options) {
    const now = new Date(options.now());
    return {
        calendarId: syncState.calendar_id,
        singleEvents: true,
        showDeleted: true,
        timeMin: addDays(now, -options.fullSyncPastDays).toISOString(),
        timeMax: addDays(now, options.fullSyncFutureDays).toISOString(),
    };
}

function buildIncrementalSyncParams(syncState) {
    return {
        calendarId: syncState.calendar_id,
        syncToken: syncState.sync_token,
        singleEvents: true,
        showDeleted: true,
    };
}

async function listAllEvents(calendarClient, baseParams) {
    const events = [];
    let pageToken = null;
    let nextSyncToken = null;

    do {
        const params = pageToken ? { ...baseParams, pageToken } : { ...baseParams };
        const response = await calendarClient.events.list(params);
        const data = response?.data || response || {};

        events.push(...(data.items || []));
        pageToken = data.nextPageToken || null;
        if (data.nextSyncToken) {
            nextSyncToken = data.nextSyncToken;
        }
    } while (pageToken);

    return { events, nextSyncToken };
}

function resolveDependencies(options = {}) {
    return {
        db: options.db || db,
        repositories: options.repositories || repositories,
        getCalendarClient: options.getCalendarClient || calendarService.getCalendarClient,
        withClient: options.withClient,
        now: options.now || (() => new Date()),
        fullSyncPastDays: options.fullSyncPastDays || DEFAULT_FULL_SYNC_PAST_DAYS,
        fullSyncFutureDays: options.fullSyncFutureDays || DEFAULT_FULL_SYNC_FUTURE_DAYS,
    };
}

async function withClient(pool, callback) {
    const client = await pool.connect();
    try {
        return await callback(client);
    } finally {
        client.release();
    }
}

async function runWithClient(deps, callback) {
    if (deps.withClient) {
        return deps.withClient(callback);
    }
    return withClient(deps.db.getPool(), callback);
}

async function runWithTransaction(deps, callback) {
    if (deps.db?.withTransaction) {
        return deps.db.withTransaction(callback);
    }
    return runWithClient(deps, callback);
}

async function fetchEvents(syncState, mode, deps, calendarClient) {
    const params = mode === 'full'
        ? buildFullSyncParams(syncState, deps)
        : buildIncrementalSyncParams(syncState);

    const { events, nextSyncToken } = await listAllEvents(calendarClient, params);

    if (!nextSyncToken) {
        throw new Error('Google Calendar events.list did not return nextSyncToken');
    }

    return { mode, events, nextSyncToken };
}

async function persistSuccess(deps, syncState, result) {
    const savedState = await runWithTransaction(deps, (client) =>
        deps.repositories.calendarSyncStates.recordSyncSucceeded(client, {
            id: syncState.id,
            syncToken: result.nextSyncToken,
            syncedAt: deps.now(),
            fullSync: result.mode === 'full',
        })
    );

    return savedState;
}

async function persistFailure(deps, syncState, err) {
    try {
        await runWithTransaction(deps, (client) =>
            deps.repositories.calendarSyncStates.recordSyncFailed(client, {
                id: syncState.id,
                error: serializeError(err),
            })
        );
    } catch (recordErr) {
        console.error('[CalendarSync] Failed to record sync failure:', recordErr.message);
    }
}

async function clearExpiredSyncToken(deps, syncState) {
    await runWithTransaction(deps, (client) =>
        deps.repositories.calendarSyncStates.clearSyncToken(client, { id: syncState.id })
    );
}

function buildResult(syncState, fetchResult, savedState, recoveredFromExpiredSyncToken) {
    const ignoredSystemEvents = fetchResult.events.filter(isSystemCreatedEvent);
    const externalEvents = fetchResult.events
        .filter(event => !isSystemCreatedEvent(event))
        .map(event => toExternalEventCandidate(syncState, event));

    return {
        status: 'succeeded',
        sync_state_id: syncState.id,
        practitioner_id: syncState.practitioner_id,
        calendar_id: syncState.calendar_id,
        mode: fetchResult.mode,
        recovered_from_expired_sync_token: recoveredFromExpiredSyncToken,
        fetched_count: fetchResult.events.length,
        ignored_system_event_count: ignoredSystemEvents.length,
        external_event_count: externalEvents.length,
        external_events: externalEvents,
        next_sync_token: fetchResult.nextSyncToken,
        next_sync_token_saved: Boolean(savedState),
    };
}

async function syncCalendarState(syncState, options = {}) {
    const deps = resolveDependencies(options);
    const calendarClient = options.calendarClient
        || await deps.getCalendarClient();
    const initialMode = syncState.sync_token ? 'incremental' : 'full';
    let recoveredFromExpiredSyncToken = false;

    try {
        let fetchResult;

        try {
            fetchResult = await fetchEvents(syncState, initialMode, deps, calendarClient);
        } catch (err) {
            if (initialMode !== 'incremental' || !isSyncTokenExpiredError(err)) {
                throw err;
            }

            recoveredFromExpiredSyncToken = true;
            await clearExpiredSyncToken(deps, syncState);
            fetchResult = await fetchEvents(
                { ...syncState, sync_token: null },
                'full',
                deps,
                calendarClient
            );
        }

        const savedState = await persistSuccess(deps, syncState, fetchResult);
        return buildResult(syncState, fetchResult, savedState, recoveredFromExpiredSyncToken);
    } catch (err) {
        await persistFailure(deps, syncState, err);
        throw err;
    }
}

async function loadSyncStates(deps, { stateIds, limit }) {
    const ids = normalizeStateIds(stateIds);
    const syncStates = [];
    const missingStateIds = [];

    await runWithClient(deps, async (client) => {
        if (ids.length > 0) {
            for (const id of ids) {
                const row = await deps.repositories.calendarSyncStates.findById(client, id);
                if (row) {
                    syncStates.push(row);
                } else {
                    missingStateIds.push(id);
                }
            }
            return;
        }

        const rows = await deps.repositories.calendarSyncStates.listRequested(client, {
            limit: clampLimit(limit),
        });
        syncStates.push(...rows);
    });

    return { syncStates, missingStateIds };
}

function failedResult(syncState, err) {
    return {
        status: 'failed',
        sync_state_id: syncState.id,
        practitioner_id: syncState.practitioner_id,
        calendar_id: syncState.calendar_id,
        error: serializeError(err),
    };
}

async function syncCalendarStates(options = {}) {
    const deps = resolveDependencies(options);
    const { syncStates, missingStateIds } = await loadSyncStates(deps, {
        stateIds: options.stateIds,
        limit: options.limit,
    });

    const results = missingStateIds.map(id => ({
        status: 'not_found',
        sync_state_id: id,
    }));
    let processed = 0;
    let failed = 0;

    for (const syncState of syncStates) {
        try {
            const result = await syncCalendarState(syncState, options);
            results.push(result);
            processed++;
        } catch (err) {
            results.push(failedResult(syncState, err));
            failed++;
        }
    }

    const successfulResults = results.filter(result => result.status === 'succeeded');
    return {
        requested: syncStates.length + missingStateIds.length,
        processed,
        failed,
        not_found: missingStateIds.length,
        fetched_count: successfulResults.reduce((sum, result) => sum + result.fetched_count, 0),
        ignored_system_event_count: successfulResults.reduce((sum, result) => sum + result.ignored_system_event_count, 0),
        external_event_count: successfulResults.reduce((sum, result) => sum + result.external_event_count, 0),
        results,
    };
}

module.exports = {
    syncCalendarState,
    syncCalendarStates,
    isSystemCreatedEvent,
    isSyncTokenExpiredError,
};
