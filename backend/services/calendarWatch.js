const crypto = require('node:crypto');

const db = require('./db');
const calendarService = require('./calendar');
const repositories = require('../repositories');

const DEFAULT_BATCH_LIMIT = 100;
const MAX_BATCH_LIMIT = 500;
const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const WATCH_TTL_MS = 6 * 24 * 60 * 60 * 1000;

function clampLimit(limit) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        return DEFAULT_BATCH_LIMIT;
    }
    return Math.min(parsed, MAX_BATCH_LIMIT);
}

function redactSensitive(value, sensitiveValues = []) {
    let output = String(value || '');
    for (const sensitive of sensitiveValues) {
        if (sensitive) {
            output = output.split(String(sensitive)).join('[redacted]');
        }
    }
    return output;
}

function serializeError(err, sensitiveValues = []) {
    const status = err?.code || err?.status || err?.response?.status || null;
    const message = redactSensitive(err?.message || String(err), sensitiveValues);
    return [status, message].filter(Boolean).join(' ').slice(0, 2000);
}

function parseExpiration(value) {
    if (!value) {
        return null;
    }

    const timestamp = Number(value);
    if (Number.isFinite(timestamp)) {
        const date = new Date(timestamp);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function hasExistingWatch(syncState) {
    return Boolean(syncState?.channel_id && syncState?.channel_resource_id);
}

function shouldRefreshWatchChannel(syncState, { force = false, refreshBefore } = {}) {
    if (force) {
        return true;
    }

    if (!syncState?.watch_expires_at) {
        return true;
    }

    const expiresAt = new Date(syncState.watch_expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
        return true;
    }

    return expiresAt < refreshBefore;
}

function sanitizeResult(result) {
    const sanitized = { ...result };
    delete sanitized.channel_token;
    delete sanitized.channelToken;
    return sanitized;
}

function resolveWebhookUrl(options = {}) {
    const url = String(options.webhookUrl || process.env.GOOGLE_CALENDAR_WEBHOOK_URL || '').trim();
    if (!url) {
        throw new Error('GOOGLE_CALENDAR_WEBHOOK_URL is required');
    }
    return url;
}

function resolveDependencies(options = {}) {
    const now = options.now || (() => new Date());
    return {
        db: options.db || db,
        repositories: options.repositories || repositories,
        getCalendarClient: options.getCalendarClient || calendarService.getCalendarClient,
        calendarClient: options.calendarClient || null,
        withClient: options.withClient,
        now,
        generateChannelId: options.generateChannelId || (() => crypto.randomUUID()),
        generateChannelToken: options.generateChannelToken || (() => crypto.randomBytes(32).toString('base64url')),
        webhookUrl: options.webhookUrl,
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

async function loadWatchStates(deps, { refreshBefore, force, limit }) {
    const rows = await runWithClient(deps, (client) =>
        deps.repositories.calendarSyncStates.listWatchRefreshCandidates(client, {
            refreshBefore,
            force,
            limit,
        })
    );
    return rows;
}

function buildWatchRequestBody(deps, { channelId, channelToken, expiresAt }) {
    return {
        id: channelId,
        type: 'web_hook',
        address: resolveWebhookUrl(deps),
        token: channelToken,
        expiration: String(expiresAt.getTime()),
    };
}

async function persistWatchSuccess(deps, syncState, input) {
    return runWithTransaction(deps, (client) =>
        deps.repositories.calendarSyncStates.recordWatchChannel(client, {
            id: syncState.id,
            channelId: input.channelId,
            channelResourceId: input.channelResourceId,
            channelToken: input.channelToken,
            watchExpiresAt: input.watchExpiresAt,
            requestSync: !syncState.sync_token,
        })
    );
}

async function persistWatchFailure(deps, syncState, err, sensitiveValues = []) {
    try {
        await runWithTransaction(deps, (client) =>
            deps.repositories.calendarSyncStates.recordWatchRefreshFailed(client, {
                id: syncState.id,
                error: serializeError(err, sensitiveValues),
            })
        );
    } catch (recordErr) {
        console.error('[CalendarWatch] Failed to record watch refresh failure:', recordErr.message);
    }
}

async function stopOldChannelBestEffort(calendarClient, syncState) {
    if (!hasExistingWatch(syncState)) {
        return { attempted: false, stopped: false };
    }

    try {
        await calendarClient.channels.stop({
            requestBody: {
                id: syncState.channel_id,
                resourceId: syncState.channel_resource_id,
            },
        });
        return { attempted: true, stopped: true };
    } catch (err) {
        console.warn('[CalendarWatch] Failed to stop old channel', {
            syncStateId: syncState.id,
            channelId: syncState.channel_id,
            error: err.message,
        });
        return { attempted: true, stopped: false, error: serializeError(err) };
    }
}

async function refreshOneWatchChannel(syncState, deps, options) {
    if (!shouldRefreshWatchChannel(syncState, options)) {
        return {
            status: 'skipped',
            sync_state_id: syncState.id,
            practitioner_id: syncState.practitioner_id,
            calendar_id: syncState.calendar_id,
            reason: 'watch_not_expiring',
        };
    }

    const calendarClient = deps.calendarClient || await deps.getCalendarClient();
    deps.calendarClient = calendarClient;

    const channelId = deps.generateChannelId();
    const channelToken = deps.generateChannelToken();
    const requestedExpiresAt = new Date(deps.now().getTime() + WATCH_TTL_MS);
    const requestBody = buildWatchRequestBody(deps, {
        channelId,
        channelToken,
        expiresAt: requestedExpiresAt,
    });

    try {
        const response = await calendarClient.events.watch({
            calendarId: syncState.calendar_id,
            requestBody,
        });
        const data = response?.data || response || {};
        const channelResourceId = data.resourceId || data.resource_id || null;

        if (!channelResourceId) {
            throw new Error('Google Calendar events.watch did not return resourceId');
        }

        const watchExpiresAt = parseExpiration(data.expiration) || requestedExpiresAt;
        await persistWatchSuccess(deps, syncState, {
            channelId,
            channelResourceId,
            channelToken,
            watchExpiresAt,
        });

        const stopResult = await stopOldChannelBestEffort(calendarClient, syncState);

        return {
            status: hasExistingWatch(syncState) ? 'refreshed' : 'created',
            sync_state_id: syncState.id,
            practitioner_id: syncState.practitioner_id,
            calendar_id: syncState.calendar_id,
            watch_expires_at: watchExpiresAt.toISOString(),
            old_channel_stop_attempted: stopResult.attempted,
            old_channel_stopped: stopResult.stopped,
        };
    } catch (err) {
        await persistWatchFailure(deps, syncState, err, [channelToken]);
        return {
            status: 'failed',
            sync_state_id: syncState.id,
            practitioner_id: syncState.practitioner_id,
            calendar_id: syncState.calendar_id,
            error: serializeError(err, [channelToken]),
        };
    }
}

async function refreshCalendarWatchChannels(options = {}) {
    const deps = resolveDependencies(options);
    const now = deps.now();
    const refreshBefore = options.refreshBefore || new Date(now.getTime() + REFRESH_WINDOW_MS);
    const force = Boolean(options.force);
    const limit = clampLimit(options.limit);
    const syncStates = options.syncStates || await loadWatchStates(deps, {
        refreshBefore,
        force,
        limit,
    });

    const results = [];
    for (const syncState of syncStates) {
        const result = await refreshOneWatchChannel(syncState, deps, {
            force,
            refreshBefore,
        });
        results.push(sanitizeResult(result));
    }

    const created = results.filter(result => result.status === 'created');
    const refreshed = results.filter(result => result.status === 'refreshed');
    const skipped = results.filter(result => result.status === 'skipped');
    const failed = results.filter(result => result.status === 'failed');

    return {
        checked_count: syncStates.length,
        created_count: created.length,
        refreshed_count: refreshed.length,
        skipped_count: skipped.length,
        failed_count: failed.length,
        results,
    };
}

module.exports = {
    refreshCalendarWatchChannels,
    shouldRefreshWatchChannel,
    serializeError,
};
