const db = require('./db');
const repositories = require('../repositories');

const DEFAULT_REASON = 'Google Calendar event';

function resolveDependencies(options = {}) {
    return {
        db: options.db || db,
        repositories: options.repositories || repositories,
        withTransaction: options.withTransaction || null,
    };
}

async function runWithTransaction(deps, callback) {
    if (deps.withTransaction) {
        return deps.withTransaction(callback);
    }

    return deps.db.withTransaction(callback);
}

function serializeError(err) {
    const status = err?.code || err?.status || err?.response?.status || null;
    const message = err?.message || String(err);
    return [status, message].filter(Boolean).join(' ').slice(0, 2000);
}

function eventStatus(candidate) {
    return String(candidate?.status || '').toLowerCase();
}

function isCancelled(candidate) {
    return eventStatus(candidate) === 'cancelled';
}

function externalEventId(candidate) {
    return candidate?.external_event_id
        || candidate?.google_event_id
        || candidate?.id
        || null;
}

function eventRef(candidate) {
    return {
        calendar_sync_state_id: candidate?.calendar_sync_state_id || null,
        practitioner_id: candidate?.practitioner_id || null,
        calendar_id: candidate?.calendar_id || null,
        external_event_id: externalEventId(candidate),
        status: candidate?.status || null,
    };
}

function skipped(candidate, reason) {
    return {
        action: 'skipped',
        reason,
        ...eventRef(candidate),
    };
}

function optionalTimestamp(value) {
    if (!value) {
        return null;
    }

    const time = Date.parse(value);
    if (Number.isNaN(time)) {
        return null;
    }

    return new Date(time).toISOString();
}

function normalizeReason(candidate) {
    const summary = String(candidate?.summary || '').trim();
    return summary || DEFAULT_REASON;
}

function buildMetadata(candidate) {
    return {
        google_calendar: {
            calendar_sync_state_id: candidate?.calendar_sync_state_id || null,
            status: candidate?.status || null,
            description: candidate?.description || null,
            recurring_event_id: candidate?.recurring_event_id || null,
            original_start_time: candidate?.original_start_time || null,
            html_link: candidate?.html_link || null,
        },
    };
}

function normalizeTimedCandidate(candidate) {
    const ref = eventRef(candidate);

    if (!ref.calendar_id || !ref.external_event_id || !ref.practitioner_id) {
        return { skipped: skipped(candidate, 'missing_identity') };
    }

    if (candidate?.start?.date || candidate?.end?.date) {
        return { skipped: skipped(candidate, 'all_day_event') };
    }

    const startDateTime = candidate?.start?.dateTime || null;
    const endDateTime = candidate?.end?.dateTime || null;
    if (!startDateTime || !endDateTime) {
        return { skipped: skipped(candidate, 'missing_start_or_end') };
    }

    const startTime = Date.parse(startDateTime);
    const endTime = Date.parse(endDateTime);
    if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime <= startTime) {
        return { skipped: skipped(candidate, 'invalid_time_range') };
    }

    return {
        input: {
            practitionerId: ref.practitioner_id,
            calendarId: ref.calendar_id,
            externalEventId: ref.external_event_id,
            startAt: new Date(startTime).toISOString(),
            endAt: new Date(endTime).toISOString(),
            reason: normalizeReason(candidate),
            externalEventEtag: candidate?.etag || candidate?.external_event_etag || null,
            externalEventUpdatedAt: optionalTimestamp(
                candidate?.updated || candidate?.external_event_updated_at
            ),
            metadata: buildMetadata(candidate),
        },
    };
}

async function importActiveEvent(candidate, deps) {
    const normalized = normalizeTimedCandidate(candidate);
    if (normalized.skipped) {
        return normalized.skipped;
    }

    return runWithTransaction(deps, async (client) => {
        const staffBlock = await deps.repositories.staffBlocks.upsertGoogleCalendarStaffBlock(
            client,
            normalized.input
        );
        await deps.repositories.staffBlocks.upsertStaffBlockBusyRange(client, staffBlock);

        return {
            action: staffBlock.inserted === true ? 'imported' : 'updated',
            staff_block_id: staffBlock.id,
            ...eventRef(candidate),
        };
    });
}

async function releaseCancelledEvent(candidate, deps) {
    const ref = eventRef(candidate);

    if (!ref.calendar_id || !ref.external_event_id) {
        return skipped(candidate, 'missing_identity');
    }

    return runWithTransaction(deps, async (client) => {
        const existing = await deps.repositories.staffBlocks.findByCalendarEventForUpdate(
            client,
            {
                calendarId: ref.calendar_id,
                externalEventId: ref.external_event_id,
            }
        );

        if (!existing) {
            return skipped(candidate, 'missing_existing_block');
        }

        if (existing.status === 'canceled') {
            return {
                action: 'released',
                changed: false,
                staff_block_id: existing.id,
                ...ref,
            };
        }

        const staffBlock = await deps.repositories.staffBlocks.cancelGoogleCalendarStaffBlock(
            client,
            {
                id: existing.id,
                cancelReason: 'google_calendar_cancelled',
                externalEventEtag: candidate?.etag || candidate?.external_event_etag || null,
                externalEventUpdatedAt: optionalTimestamp(
                    candidate?.updated || candidate?.external_event_updated_at
                ),
                metadata: buildMetadata(candidate),
            }
        );
        await deps.repositories.staffBlocks.releaseStaffBlockBusyRange(client, existing.id);

        return {
            action: 'released',
            changed: true,
            staff_block_id: staffBlock?.id || existing.id,
            ...ref,
        };
    });
}

async function importExternalEventCandidate(candidate, deps) {
    if (isCancelled(candidate)) {
        return releaseCancelledEvent(candidate, deps);
    }

    return importActiveEvent(candidate, deps);
}

function applyResultCount(summary, result) {
    if (result.action === 'imported') {
        summary.imported_count++;
        return;
    }

    if (result.action === 'updated') {
        summary.updated_count++;
        return;
    }

    if (result.action === 'released') {
        if (result.changed !== false) {
            summary.released_count++;
        }
        return;
    }

    if (result.action === 'skipped') {
        summary.skipped_count++;
    }
}

async function importExternalEventCandidates(candidates = [], options = {}) {
    const deps = resolveDependencies(options);
    const summary = {
        processed_count: candidates.length,
        imported_count: 0,
        updated_count: 0,
        released_count: 0,
        skipped_count: 0,
        failed_count: 0,
        results: [],
    };

    for (const candidate of candidates) {
        try {
            const result = await importExternalEventCandidate(candidate, deps);
            applyResultCount(summary, result);
            summary.results.push(result);
        } catch (err) {
            summary.failed_count++;
            summary.results.push({
                action: 'failed',
                error: serializeError(err),
                conflict: err?.code === '23P01',
                ...eventRef(candidate),
            });
        }
    }

    return summary;
}

module.exports = {
    importExternalEventCandidates,
};
