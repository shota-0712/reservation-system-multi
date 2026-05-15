const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const reservationSheetsService = require('../services/sheets');
const calendarService = require('../services/calendar');
const calendarSyncService = require('../services/calendarSync');
const calendarWatchService = require('../services/calendarWatch');
const lineService = require('../services/line');
const storageService = require('../services/storage');  // Google Cloud Storage
const db = require('../services/db');
const repositories = require('../repositories');
const { requireLineUser, rejectMismatchedLineUser } = require('../middleware/requireLineUser');

const ADMIN_LINE_IDS = (process.env.ADMIN_LINE_ID || '').split(',').map(id => id.trim()).filter(id => id);

// ヘルパー: 管理者チェック
function isAdmin(userId) {
    return ADMIN_LINE_IDS.includes(userId);
}

function requireAdmin(req, res, next) {
    const adminId = req.query.adminId
        || req.body?.adminId
        || req.get('x-admin-line-id');

    if (!isAdmin(adminId)) {
        return res.status(403).json({ status: 'error', message: '権限がありません' });
    }

    req.adminId = adminId;
    return next();
}

// ヘルパー: 全管理者に通知
async function notifyAdmins(text) {
    const promises = ADMIN_LINE_IDS.map(adminId => lineService.pushMessage(adminId, text));
    await Promise.all(promises);
}

function badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

function conflict(message) {
    const err = new Error(message);
    err.statusCode = 409;
    return err;
}

function forbidden(message) {
    const err = new Error(message);
    err.statusCode = 403;
    return err;
}

function notFound(message) {
    const err = new Error(message);
    err.statusCode = 404;
    return err;
}

function isUuid(value) {
    return typeof value === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getIdempotencyKey(req) {
    const key = req.get('idempotency-key')
        || req.body?.idempotency_key
        || req.body?.idempotencyKey
        || '';
    const normalized = String(key).trim();
    return normalized || null;
}

const ACCEPTED_GOOGLE_CALENDAR_RESOURCE_STATES = new Set([
    'sync',
    'exists',
    'not_exists',
]);

function readGoogleCalendarWebhookHeaders(req) {
    return {
        channelId: req.get('x-goog-channel-id') || '',
        resourceId: req.get('x-goog-resource-id') || '',
        resourceState: req.get('x-goog-resource-state') || '',
        channelToken: req.get('x-goog-channel-token') || '',
        messageNumber: req.get('x-goog-message-number') || null,
    };
}

function safeTokenEquals(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string') {
        return false;
    }

    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);

    return expectedBuffer.length === actualBuffer.length
        && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function parseReservationStartAt(date, time) {
    if (!date || !time) {
        throw badRequest('予約日と時刻を指定してください');
    }

    const normalizedDate = String(date).replace(/\//g, '-');
    const normalizedTime = String(time);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate) || !/^\d{2}:\d{2}$/.test(normalizedTime)) {
        throw badRequest('予約日または時刻の形式が不正です');
    }

    const startAt = new Date(`${normalizedDate}T${normalizedTime}:00+09:00`);
    if (Number.isNaN(startAt.getTime())) {
        throw badRequest('予約日または時刻の形式が不正です');
    }

    return startAt;
}

function formatDateJST(value) {
    const date = new Date(value);
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(0, 10).replace(/-/g, '/');
}

function formatTimeJST(value) {
    const date = new Date(value);
    const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    return jst.toISOString().slice(11, 16);
}

async function withDbClient(callback) {
    return withClient(db.getPool(), callback);
}

function parseJsonArraySetting(value, fallback = []) {
    if (Array.isArray(value)) {
        return value;
    }

    if (!value) {
        return fallback;
    }

    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch (err) {
        return fallback;
    }
}

function csvSetting(value) {
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(Boolean);
    }

    return value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : [];
}

function businessSettingsFrom(settings) {
    return {
        startHour: parseInt(settings.businessStartHour ?? settings.startHour, 10) || 10,
        endHour: parseInt(settings.businessEndHour ?? settings.endHour, 10) || 20,
        holidays: csvSetting(settings.holidays),
        regularHolidays: parseJsonArraySetting(settings.regularHolidays),
        temporaryBusinessDays: csvSetting(settings.temporaryBusinessDays),
    };
}

function formatMenu(row) {
    return {
        id: row.id,
        category: row.category || '',
        name: row.name,
        minutes: row.minutes,
        price: row.price,
        description: row.description || '',
        imageUrl: row.image_url || '',
        sortOrder: row.sort_order,
        optionIds: row.option_ids || '',
        isActive: row.is_active,
    };
}

function formatOption(row) {
    return {
        id: row.id,
        name: row.name,
        minutes: row.additional_minutes,
        price: row.additional_price,
        additionalMinutes: row.additional_minutes,
        additionalPrice: row.additional_price,
        description: row.description || '',
        isActive: row.is_active,
        sortOrder: row.sort_order,
    };
}

function formatPractitioner(row) {
    return {
        id: row.id,
        name: row.name || '',
        calendarId: row.calendar_id || '',
        imageUrl: row.image_url || '',
        active: row.is_active,
        isActive: row.is_active,
        title: row.title || '',
        sns: row.sns || '',
        experience: row.experience || '',
        nominationFee: row.nomination_fee || '',
        prTitle: row.pr_title || '',
        description: row.description || '',
        sortOrder: row.sort_order,
    };
}

function calendarPractitioner(row) {
    const practitioner = formatPractitioner(row);
    return {
        id: practitioner.id,
        name: practitioner.name,
        calendarId: practitioner.calendarId,
    };
}

function hasField(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeMenuInput(menu = {}, { partial = false } = {}) {
    const input = {};

    if (!partial || hasField(menu, 'category')) input.category = menu.category || '';
    if (!partial || hasField(menu, 'name')) input.name = menu.name;
    if (!partial || hasField(menu, 'minutes')) input.minutes = Number(menu.minutes);
    if (!partial || hasField(menu, 'price')) input.price = Number(menu.price ?? 0);
    if (!partial || hasField(menu, 'description')) input.description = menu.description || null;
    if (!partial || hasField(menu, 'imageUrl')) input.imageUrl = menu.imageUrl || null;
    if (hasField(menu, 'isActive') || hasField(menu, 'active')) input.isActive = menu.isActive ?? menu.active;
    if (hasField(menu, 'sortOrder')) input.sortOrder = menu.sortOrder;
    if (hasField(menu, 'optionIds')) input.optionIds = menu.optionIds;

    return input;
}

function normalizeOptionInput(option = {}, { partial = false } = {}) {
    const input = {};

    if (!partial || hasField(option, 'name')) input.name = option.name;
    if (!partial || hasField(option, 'additionalMinutes') || hasField(option, 'minutes')) {
        input.additionalMinutes = Number(option.additionalMinutes ?? option.minutes ?? 0);
    }
    if (!partial || hasField(option, 'additionalPrice') || hasField(option, 'price')) {
        input.additionalPrice = Number(option.additionalPrice ?? option.price ?? 0);
    }
    if (!partial || hasField(option, 'description')) input.description = option.description || null;
    if (hasField(option, 'isActive')) input.isActive = option.isActive;
    if (hasField(option, 'sortOrder')) input.sortOrder = option.sortOrder;

    return input;
}

function normalizePractitionerInput(practitioner = {}, { partial = false } = {}) {
    const input = {};

    if (!partial || hasField(practitioner, 'name')) input.name = practitioner.name;
    if (!partial || hasField(practitioner, 'calendarId')) input.calendarId = practitioner.calendarId || null;
    if (!partial || hasField(practitioner, 'title')) input.title = practitioner.title || null;
    if (!partial || hasField(practitioner, 'imageUrl')) input.imageUrl = practitioner.imageUrl || null;
    if (!partial || hasField(practitioner, 'description')) input.description = practitioner.description || null;
    if (!partial || hasField(practitioner, 'sns')) input.sns = practitioner.sns || null;
    if (!partial || hasField(practitioner, 'experience')) input.experience = practitioner.experience || null;
    if (!partial || hasField(practitioner, 'nominationFee')) {
        input.nominationFee = Number(practitioner.nominationFee || 0);
    }
    if (!partial || hasField(practitioner, 'prTitle')) input.prTitle = practitioner.prTitle || null;
    if (hasField(practitioner, 'isActive') || hasField(practitioner, 'active')) {
        input.isActive = practitioner.isActive ?? practitioner.active;
    }
    if (hasField(practitioner, 'sortOrder')) input.sortOrder = practitioner.sortOrder;

    return input;
}

async function getSettingsFromDb() {
    return withDbClient((client) => repositories.settings.getAllSettings(client));
}

function explicitPractitionerFrom(data) {
    if (data.practitionerId && data.practitionerId !== 'all') {
        return {
            id: data.practitionerId,
            name: data.practitionerName,
            calendarId: data.calendarId,
        };
    }

    if (data.practitioner_id && data.practitioner_id !== 'all') {
        return {
            id: data.practitioner_id,
            name: data.practitioner_name,
            calendarId: data.calendar_id,
        };
    }

    return null;
}

function isUnrequestedReservation(data) {
    return !explicitPractitionerFrom(data)
        && (
            data.practitionerId === 'all'
            || data.practitioner_id === 'all'
            || Array.isArray(data.availablePractitioners)
        );
}

async function resolvePractitionerSnapshot(client, data, practitionerId) {
    const selected = explicitPractitionerFrom(data);
    const requestCalendarId = data.calendarId || selected?.calendarId || null;
    const practitioner = await repositories.practitioners.findPractitionerById(client, practitionerId);

    if (!practitioner) {
        throw badRequest('施術者が見つかりません');
    }

    return {
        id: practitioner.id,
        name: practitioner.name,
        calendarId: practitioner.calendar_id || requestCalendarId,
    };
}

function buildReservationInput(data, lineUserId, idempotencyKey, practitionerSnapshot) {
    if (!practitionerSnapshot?.id) {
        throw badRequest('施術者を選択してください');
    }

    const practitionerId = String(practitionerSnapshot.id);
    if (!isUuid(practitionerId)) {
        throw badRequest('施術者IDの形式が不正です');
    }

    const menu = data.menu || {};
    const menuName = typeof menu === 'string' ? menu : (menu.name || data.menuName);
    if (!menuName) {
        throw badRequest('メニューを選択してください');
    }

    const customerName = data.name || data.customerName;
    if (!customerName) {
        throw badRequest('お名前を入力してください');
    }

    const totalMinutes = Number(data.totalMinutes ?? (typeof menu === 'object' ? menu.minutes : undefined));
    if (!Number.isInteger(totalMinutes) || totalMinutes <= 0) {
        throw badRequest('合計施術時間が不正です');
    }

    const totalPrice = Number(data.totalPrice ?? (typeof menu === 'object' ? menu.price : 0) ?? 0);
    if (!Number.isFinite(totalPrice) || totalPrice < 0) {
        throw badRequest('合計金額が不正です');
    }

    const startAt = parseReservationStartAt(data.date, data.time);
    const endAt = new Date(startAt.getTime() + totalMinutes * 60000);

    const selectedOptions = Array.isArray(data.selectedOptions) ? data.selectedOptions : [];
    const optionNames = selectedOptions
        .map(option => option?.name)
        .filter(Boolean);

    return {
        customerId: null,
        lineUserId,
        idempotencyKey,
        createdVia: 'customer_liff',
        customerName,
        customerPhone: data.phone || data.customerPhone || null,
        practitionerId,
        practitionerNameSnapshot: practitionerSnapshot.name,
        menuId: typeof menu === 'object' && isUuid(menu.id) ? menu.id : null,
        menuNameSnapshot: menuName,
        startAt,
        endAt,
        status: 'reserved',
        totalMinutes,
        totalPrice,
        calendarEventId: null,
        notes: data.notes || null,
        metadata: {
            selected_options: selectedOptions,
            option_names: optionNames,
            source: 'api',
            requested_date: data.date,
            requested_time: data.time,
            calendar_id: practitionerSnapshot.calendarId,
        },
    };
}

function uniqueUuidList(values) {
    const ids = [];
    const seen = new Set();

    for (const value of values || []) {
        const id = typeof value === 'object' && value !== null ? value.id : value;
        const normalized = id === null || id === undefined ? '' : String(id).trim();

        if (isUuid(normalized) && !seen.has(normalized)) {
            seen.add(normalized);
            ids.push(normalized);
        }
    }

    return ids;
}

function parsePractitionerIds(value) {
    if (value === null || value === undefined || value === '') {
        return [];
    }

    if (Array.isArray(value)) {
        return uniqueUuidList(value);
    }

    if (typeof value === 'string') {
        return uniqueUuidList(value.split(',').map(id => id.trim()));
    }

    return [];
}

function practitionerIdsFromMenuLike(menu) {
    if (!menu || typeof menu !== 'object') {
        return [];
    }

    return parsePractitionerIds(
        menu.practitionerIds
        ?? menu.practitioner_ids
        ?? menu.availablePractitionerIds
        ?? menu.available_practitioner_ids
    );
}

function requestCandidateIdsFrom(data) {
    if (!Array.isArray(data.availablePractitioners)) {
        return null;
    }

    return uniqueUuidList(data.availablePractitioners);
}

function candidateRequestSnapshotById(data) {
    const snapshots = new Map();

    for (const practitioner of data.availablePractitioners || []) {
        if (!practitioner?.id || !isUuid(String(practitioner.id))) {
            continue;
        }

        snapshots.set(String(practitioner.id), practitioner);
    }

    return snapshots;
}

function menuIdFrom(data) {
    const menu = data.menu || {};
    const menuId = typeof menu === 'object' ? menu.id : data.menuId;
    return menuId && isUuid(String(menuId)) ? String(menuId) : null;
}

async function menuRestrictedPractitionerIds(client, data) {
    const menuId = menuIdFrom(data);

    if (menuId && repositories.menus?.findMenuById) {
        const menu = await repositories.menus.findMenuById(client, menuId);
        const metadataIds = practitionerIdsFromMenuLike(menu?.metadata);

        if (metadataIds.length > 0) {
            return metadataIds;
        }
    }

    return practitionerIdsFromMenuLike(data.menu);
}

function intersectCandidateIds(left, right) {
    if (left === null && right.length === 0) {
        return null;
    }
    if (left === null) {
        return right;
    }
    if (right.length === 0) {
        return left;
    }

    const allowed = new Set(right);
    return left.filter(id => allowed.has(id));
}

function orderAssignmentCandidates(candidates) {
    const shuffled = [...candidates];

    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
}

async function resolveUnrequestedCandidates(client, data) {
    const requestCandidateIds = requestCandidateIdsFrom(data);
    const menuCandidateIds = await menuRestrictedPractitionerIds(client, data);
    const candidateIds = intersectCandidateIds(requestCandidateIds, menuCandidateIds);
    const practitioners = await repositories.practitioners.findActivePractitioners(client, candidateIds);
    const requestSnapshots = candidateRequestSnapshotById(data);

    return orderAssignmentCandidates(
        practitioners.map(practitioner => {
            const requestSnapshot = requestSnapshots.get(String(practitioner.id));

            return {
                id: practitioner.id,
                name: practitioner.name,
                calendarId: practitioner.calendar_id || requestSnapshot?.calendarId || null,
            };
        })
    );
}

function reservationResponse(reservation) {
    return {
        id: reservation.id,
        status: reservation.status,
        lineUserId: reservation.line_user_id,
        idempotencyKey: reservation.idempotency_key,
        name: reservation.customer_name,
        phone: reservation.customer_phone || '',
        menu: reservation.menu_name_snapshot,
        menuName: reservation.menu_name_snapshot,
        date: formatDateJST(reservation.start_at),
        time: formatTimeJST(reservation.start_at),
        startAt: new Date(reservation.start_at).toISOString(),
        endAt: new Date(reservation.end_at).toISOString(),
        practitionerId: reservation.practitioner_id,
        practitioner_id: reservation.practitioner_id,
        practitionerName: reservation.practitioner_name_snapshot,
        practitioner: {
            id: reservation.practitioner_id,
            name: reservation.practitioner_name_snapshot,
        },
        totalMinutes: reservation.total_minutes,
        totalPrice: reservation.total_price,
        canceledAt: reservation.canceled_at ? new Date(reservation.canceled_at).toISOString() : null,
        cancelReason: reservation.cancel_reason || null,
    };
}

function buildOutboxPayload(reservation, input) {
    const optionNames = input.metadata.option_names || [];

    return {
        reservationId: reservation.id,
        lineUserId: reservation.line_user_id,
        customerName: reservation.customer_name,
        customerPhone: reservation.customer_phone,
        practitionerId: reservation.practitioner_id,
        practitionerName: reservation.practitioner_name_snapshot,
        calendarId: input.metadata.calendar_id,
        menuName: reservation.menu_name_snapshot,
        optionNames,
        totalMinutes: reservation.total_minutes,
        totalPrice: reservation.total_price,
        startAt: new Date(reservation.start_at).toISOString(),
        endAt: new Date(reservation.end_at).toISOString(),
        date: formatDateJST(reservation.start_at),
        time: formatTimeJST(reservation.start_at),
    };
}

async function enqueueReservationCreatedEvents(client, reservation, input) {
    const payload = buildOutboxPayload(reservation, input);
    const events = [
        {
            eventType: 'reservation.calendar.create',
            idempotencyKey: `calendar:create:${reservation.id}`,
            payload,
        },
        {
            eventType: 'reservation.line.notify_customer_created',
            idempotencyKey: `line:customer_created:${reservation.id}`,
            payload,
        },
        {
            eventType: 'reservation.line.notify_admin_created',
            idempotencyKey: `line:admin_created:${reservation.id}`,
            payload: {
                ...payload,
                adminLineIds: ADMIN_LINE_IDS,
            },
        },
    ];

    for (const event of events) {
        await repositories.outboxEvents.createOutboxEvent(client, {
            eventType: event.eventType,
            aggregateType: 'reservation',
            aggregateId: reservation.id,
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
        });
    }
}

function cancelReasonFrom(value) {
    const reason = value?.reason ?? value?.cancelReason ?? value?.cancel_reason ?? null;
    const normalized = reason === null || reason === undefined ? '' : String(reason).trim();
    return normalized || null;
}

function canCustomerCancel(reservation, now = new Date()) {
    const startAt = new Date(reservation.start_at);
    return startAt.getTime() - now.getTime() >= 24 * 60 * 60 * 1000;
}

function buildCancellationPayload(reservation, cancellation) {
    return {
        reservationId: reservation.id,
        lineUserId: reservation.line_user_id,
        customerName: reservation.customer_name,
        customerPhone: reservation.customer_phone,
        practitionerId: reservation.practitioner_id,
        practitionerName: reservation.practitioner_name_snapshot,
        menuName: reservation.menu_name_snapshot,
        totalMinutes: reservation.total_minutes,
        totalPrice: reservation.total_price,
        calendarEventId: reservation.calendar_event_id,
        startAt: new Date(reservation.start_at).toISOString(),
        endAt: new Date(reservation.end_at).toISOString(),
        date: formatDateJST(reservation.start_at),
        time: formatTimeJST(reservation.start_at),
        canceledAt: reservation.canceled_at ? new Date(reservation.canceled_at).toISOString() : null,
        cancelReason: reservation.cancel_reason || cancellation.reason || null,
        actorType: cancellation.actorType,
        actorLineUserId: cancellation.actorId,
        source: cancellation.source,
    };
}

async function enqueueReservationCanceledEvents(client, reservation, cancellation) {
    const payload = buildCancellationPayload(reservation, cancellation);
    const events = [
        {
            eventType: 'reservation.calendar.cancel',
            idempotencyKey: `calendar:cancel:${reservation.id}`,
            payload,
        },
        {
            eventType: 'reservation.line.notify_customer_canceled',
            idempotencyKey: `line:customer_canceled:${reservation.id}`,
            payload,
        },
        {
            eventType: 'reservation.line.notify_admin_canceled',
            idempotencyKey: `line:admin_canceled:${reservation.id}`,
            payload: {
                ...payload,
                adminLineIds: ADMIN_LINE_IDS,
            },
        },
    ];

    for (const event of events) {
        await repositories.outboxEvents.createOutboxEvent(client, {
            eventType: event.eventType,
            aggregateType: 'reservation',
            aggregateId: reservation.id,
            idempotencyKey: event.idempotencyKey,
            payload: event.payload,
        });
    }
}

function ensureReservationCanBeCanceled(reservation) {
    if (reservation.status === 'reserved') {
        return;
    }

    throw conflict('この予約はキャンセルできません');
}

async function cancelReservationFromDb(input) {
    if (!isUuid(input.reservationId)) {
        throw notFound('予約が見つかりませんでした');
    }

    return db.withTransaction(async (client) => {
        const beforeReservation = await repositories.reservations.findReservationByIdForUpdate(
            client,
            input.reservationId
        );

        if (!beforeReservation) {
            throw notFound('予約が見つかりませんでした');
        }

        if (input.actorType === 'customer' && beforeReservation.line_user_id !== input.actorId) {
            throw notFound('予約が見つかりませんでした');
        }

        if (beforeReservation.status === 'canceled') {
            await repositories.reservations.releaseReservationBusyRange(client, input.reservationId);
            return {
                reservation: beforeReservation,
                alreadyCanceled: true,
            };
        }

        ensureReservationCanBeCanceled(beforeReservation);

        if (input.actorType === 'customer' && !canCustomerCancel(beforeReservation)) {
            throw forbidden('予約日時の24時間前を過ぎているためキャンセルできません');
        }

        const afterReservation = await repositories.reservations.cancelReservation(client, {
            reservationId: input.reservationId,
            cancelReason: input.reason,
        });
        const busyRange = await repositories.reservations.releaseReservationBusyRange(client, input.reservationId);

        if (!afterReservation || !busyRange) {
            throw new Error('予約キャンセルに必要なDBレコードが見つかりません');
        }

        await enqueueReservationCanceledEvents(client, afterReservation, input);
        await repositories.auditLogs.createAuditLog(client, {
            actorType: input.actorType,
            actorId: input.actorId,
            action: 'reservation.canceled',
            entityType: 'reservation',
            entityId: afterReservation.id,
            reservationId: afterReservation.id,
            beforeData: beforeReservation,
            afterData: afterReservation,
            metadata: {
                reason: input.reason || null,
                source: input.source,
                actor_line_user_id: input.actorId,
            },
        });

        return {
            reservation: afterReservation,
            alreadyCanceled: false,
        };
    });
}

function isBusyRangeConflict(err) {
    return err?.code === '23P01';
}

function isReservationIdempotencyConflict(err) {
    return err?.code === '23505'
        && err?.constraint === 'reservations_line_user_id_idempotency_key_uq';
}

function isValidationDbError(err) {
    return ['22P02', '23503', '23514'].includes(err?.code);
}

async function findExistingReservation(lineUserId, idempotencyKey) {
    if (!idempotencyKey) {
        return null;
    }

    return db.withTransaction((client) => (
        repositories.reservations.findReservationByIdempotencyKey(client, lineUserId, idempotencyKey)
    ));
}

async function createReservationForPractitioner(data, lineUserId, idempotencyKey, practitionerId) {
    return db.withTransaction(async (client) => {
        if (idempotencyKey) {
            const existing = await repositories.reservations.findReservationByIdempotencyKey(
                client,
                lineUserId,
                idempotencyKey
            );

            if (existing) {
                return { reservation: existing, existing: true };
            }
        }

        const practitionerSnapshot = await resolvePractitionerSnapshot(client, data, practitionerId);
        const input = buildReservationInput(data, lineUserId, idempotencyKey, practitionerSnapshot);
        const reservation = await repositories.reservations.createReservation(client, input);
        await enqueueReservationCreatedEvents(client, reservation, input);
        return { reservation, existing: false };
    });
}

async function tryCreateReservationWithSnapshot(data, lineUserId, idempotencyKey, practitionerSnapshot) {
    return db.withTransaction(async (client) => {
        if (idempotencyKey) {
            const existing = await repositories.reservations.findReservationByIdempotencyKey(
                client,
                lineUserId,
                idempotencyKey
            );

            if (existing) {
                return { reservation: existing, existing: true };
            }
        }

        const input = buildReservationInput(data, lineUserId, idempotencyKey, practitionerSnapshot);
        const reservation = await repositories.reservations.createReservation(client, input);
        await enqueueReservationCreatedEvents(client, reservation, input);
        return { reservation, existing: false };
    });
}

async function createUnrequestedReservationFromDb(data, lineUserId, idempotencyKey) {
    const candidates = await db.withTransaction((client) => resolveUnrequestedCandidates(client, data));

    if (candidates.length === 0) {
        throw conflict('予約可能な施術者が見つかりません');
    }

    for (const candidate of candidates) {
        try {
            return await tryCreateReservationWithSnapshot(data, lineUserId, idempotencyKey, candidate);
        } catch (err) {
            if (isBusyRangeConflict(err)) {
                continue;
            }

            throw err;
        }
    }

    throw conflict('指定された時間は満席です');
}

async function createReservationFromDb(data, lineUserId, idempotencyKey) {
    if (idempotencyKey) {
        const existing = await findExistingReservation(lineUserId, idempotencyKey);
        if (existing) {
            return { reservation: existing, existing: true };
        }
    }

    const selected = explicitPractitionerFrom(data);

    if (selected?.id) {
        const practitionerId = String(selected.id);
        if (!isUuid(practitionerId)) {
            throw badRequest('施術者IDの形式が不正です');
        }

        return createReservationForPractitioner(data, lineUserId, idempotencyKey, practitionerId);
    }

    if (isUnrequestedReservation(data)) {
        return createUnrequestedReservationFromDb(data, lineUserId, idempotencyKey);
    }

    throw badRequest('施術者を選択してください');
}

// ====================
// アプリ設定関連
// ====================

// POST /api/webhooks/google-calendar - Google Calendar push notification
router.post('/webhooks/google-calendar', async (req, res, next) => {
    try {
        const headers = readGoogleCalendarWebhookHeaders(req);

        if (!headers.channelId || !headers.resourceId || !headers.resourceState || !headers.channelToken) {
            return res.status(400).json({ status: 'error', message: 'Missing Google Calendar webhook headers' });
        }

        const result = await db.withTransaction(async (client) => {
            const syncState = await repositories.calendarSyncStates.findByChannelId(client, headers.channelId);

            if (!syncState) {
                return { statusCode: 404, body: { status: 'error', message: 'Unknown channel' } };
            }

            if (syncState.channel_resource_id !== headers.resourceId) {
                return { statusCode: 403, body: { status: 'error', message: 'Resource mismatch' } };
            }

            if (!safeTokenEquals(syncState.channel_token, headers.channelToken)) {
                return { statusCode: 403, body: { status: 'error', message: 'Forbidden' } };
            }

            if (!ACCEPTED_GOOGLE_CALENDAR_RESOURCE_STATES.has(headers.resourceState)) {
                console.warn('[GoogleCalendarWebhook] Ignored unexpected resource state', {
                    channelId: headers.channelId,
                    resourceState: headers.resourceState,
                    messageNumber: headers.messageNumber,
                });
                return { statusCode: 200, body: { status: 'ignored', reason: 'unexpected_resource_state' } };
            }

            await repositories.calendarSyncStates.recordSyncRequested(client, {
                id: syncState.id,
                resourceState: headers.resourceState,
                messageNumber: headers.messageNumber,
            });

            return { statusCode: 202, body: { status: 'accepted' } };
        });

        return res.status(result.statusCode).json(result.body);
    } catch (err) {
        next(err);
    }
});

// GET /api/config - フロントエンド用設定取得 (LIFF_ID, テーマカラー等)
router.get('/config', (req, res) => {
    res.json({
        liffId: process.env.LIFF_ID || '',
        theme: {
            color: process.env.THEME_COLOR || '#9b1c2c',
            light: process.env.THEME_COLOR_LIGHT || '#b92b3d',
            dark: process.env.THEME_COLOR_DARK || '#7a1522',
        },
        siteTitle: process.env.SERVICE_NAME ? `${process.env.SERVICE_NAME}-予約サイト` : '',
    });
});

// ====================
// メニュー関連
// ====================

// GET /api/menus - メニュー一覧取得
router.get('/menus', async (req, res, next) => {
    try {
        const menus = await withDbClient((client) => repositories.menus.findActiveMenus(client));
        res.json(menus.map(formatMenu));
    } catch (err) {
        next(err);
    }
});

// POST /api/menus - メニュー追加 (管理者のみ)
router.post('/menus', async (req, res, next) => {
    try {
        const { adminId, menu } = req.body;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const created = await db.withTransaction((client) => (
            repositories.menus.createMenu(client, normalizeMenuInput(menu))
        ));
        res.json({ status: 'success', menuId: created.id, menu: formatMenu(created) });
    } catch (err) {
        next(err);
    }
});

// PUT /api/menus/reorder - メニュー並び替え (管理者のみ)
// 注意: :id パラメータより先に定義する必要がある
router.put('/menus/reorder', async (req, res, next) => {
    try {
        const { adminId, orderedIds } = req.body;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const result = await db.withTransaction((client) => (
            repositories.menus.reorderMenus(client, orderedIds || [])
        ));
        res.json({ status: 'success', ...result });
    } catch (err) {
        next(err);
    }
});

// PUT /api/menus/:id - メニュー更新 (管理者のみ)
router.put('/menus/:id', async (req, res, next) => {
    try {
        const { adminId, menu } = req.body;
        const menuId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const updated = await db.withTransaction((client) => (
            repositories.menus.updateMenu(client, {
                id: menuId,
                ...normalizeMenuInput(menu, { partial: true }),
            })
        ));
        if (!updated) {
            return res.json({ status: 'error', message: 'メニューが見つかりませんでした' });
        }
        res.json({ status: 'success', menu: formatMenu(updated) });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/menus/:id - メニュー削除 (管理者のみ)
router.delete('/menus/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const menuId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const deleted = await db.withTransaction((client) => repositories.menus.deactivateMenu(client, menuId));
        if (!deleted) {
            return res.json({ status: 'error', message: 'メニューが見つかりませんでした' });
        }
        res.json({ status: 'success' });
    } catch (err) {
        next(err);
    }
});

// ====================
// 設定関連
// ====================

// GET /api/settings - 設定取得 (公開項目はpublicでアクセス可能、詳細は管理者のみ)
router.get('/settings', async (req, res, next) => {
    try {
        const adminId = req.query.adminId;
        const settings = await getSettingsFromDb();
        console.log('[Debug] Settings loaded from DB:', JSON.stringify(settings));

        // Public access - header customization only
        if (adminId === 'public') {
            return res.json({
                logoUrl: settings.logoUrl || '',
                salonName: settings.salonName || 'LinCal【東京】',
                address: settings.address || '〒123-4567 東京都千代田区1-1-1',
                station: settings.station || '東京駅',
            });
        }

        // Admin access - all settings
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '管理者権限が必要です' });
        }

        // 環境変数のデフォルト値とマージ
        const result = {
            // Header customization
            logoUrl: settings.logoUrl || '',
            salonName: settings.salonName || '',
            address: settings.address || '',
            station: settings.station || '',
            // Business settings
            businessStartHour: settings.businessStartHour || settings.startHour || '10',
            businessEndHour: settings.businessEndHour || settings.endHour || '20',
            holidays: settings.holidays || '',
            regularHolidays: parseJsonArraySetting(settings.regularHolidays),
            temporaryBusinessDays: settings.temporaryBusinessDays || '',
            // Reservation info (空の場合は空のまま、フォールバックしない)
            salonInfo: settings.salonInfo || '',
            precautions: settings.precautions || '',
        };

        res.json(result);
    } catch (err) {
        next(err);
    }
});

// PUT /api/settings - 設定更新 (管理者のみ)
router.put('/settings', async (req, res, next) => {
    try {
        console.log('[Debug] PUT /settings payload:', JSON.stringify(req.body, null, 2));
        const { adminId, settings } = req.body;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '管理者権限が必要です' });
        }

        await db.withTransaction((client) => repositories.settings.upsertSettings(client, settings || {}));
        res.json({ status: 'success' });
    } catch (err) {
        next(err);
    }
});

// ====================
// 施術者関連
// ====================

// GET /api/practitioners - 施術者一覧取得
router.get('/practitioners', async (req, res, next) => {
    try {
        const practitioners = await withDbClient((client) => repositories.practitioners.findAllPractitioners(client));
        res.json(practitioners.map(formatPractitioner));
    } catch (err) {
        next(err);
    }
});

// POST /api/practitioners - 施術者追加 (管理者のみ)
router.post('/practitioners', async (req, res, next) => {
    try {
        const { adminId, practitioner } = req.body;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const created = await db.withTransaction((client) => (
            repositories.practitioners.createPractitioner(client, normalizePractitionerInput(practitioner))
        ));
        res.json({ status: 'success', practitionerId: created.id, practitioner: formatPractitioner(created) });
    } catch (err) {
        next(err);
    }
});

// PUT /api/practitioners/:id - 施術者更新 (管理者のみ)
router.put('/practitioners/:id', async (req, res, next) => {
    try {
        const { adminId, practitioner } = req.body;
        const practitionerId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const updated = await db.withTransaction((client) => (
            repositories.practitioners.updatePractitioner(client, {
                id: practitionerId,
                ...normalizePractitionerInput(practitioner, { partial: true }),
            })
        ));
        if (!updated) {
            return res.json({ status: 'error', message: '施術者が見つかりませんでした' });
        }
        res.json({ status: 'success', practitioner: formatPractitioner(updated) });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/practitioners/:id - 施術者削除 (管理者のみ)
router.delete('/practitioners/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const practitionerId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const deleted = await db.withTransaction((client) => (
            repositories.practitioners.deactivatePractitioner(client, practitionerId)
        ));
        if (!deleted) {
            return res.json({ status: 'error', message: '施術者が見つかりませんでした' });
        }
        res.json({ status: 'success' });
    } catch (err) {
        next(err);
    }
});

// ====================
// オプション関連
// ====================

// GET /api/options - オプション一覧取得
router.get('/options', async (req, res, next) => {
    try {
        const options = await withDbClient((client) => repositories.options.findActiveOptions(client));
        res.json(options.map(formatOption));
    } catch (err) {
        next(err);
    }
});

// POST /api/options - オプション追加 (管理者のみ)
router.post('/options', async (req, res, next) => {
    try {
        const { adminId, option } = req.body;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const created = await db.withTransaction((client) => (
            repositories.options.createOption(client, normalizeOptionInput(option))
        ));
        res.json({ status: 'success', optionId: created.id, option: formatOption(created) });
    } catch (err) {
        next(err);
    }
});

// PUT /api/options/:id - オプション更新 (管理者のみ)
router.put('/options/:id', async (req, res, next) => {
    try {
        const { adminId, option } = req.body;
        const optionId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const updated = await db.withTransaction((client) => (
            repositories.options.updateOption(client, {
                id: optionId,
                ...normalizeOptionInput(option, { partial: true }),
            })
        ));
        if (!updated) {
            return res.json({ status: 'error', message: 'オプションが見つかりませんでした' });
        }
        res.json({ status: 'success', option: formatOption(updated) });
    } catch (err) {
        next(err);
    }
});

// DELETE /api/options/:id - オプション削除 (管理者のみ)
router.delete('/options/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const optionId = req.params.id;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const deleted = await db.withTransaction((client) => repositories.options.deactivateOption(client, optionId));
        if (!deleted) {
            return res.json({ status: 'error', message: 'オプションが見つかりませんでした' });
        }
        res.json({ status: 'success' });
    } catch (err) {
        next(err);
    }
});

// ====================
// 予約スロット関連
// ====================

// GET /api/slots - 指定日の空き時間取得
router.get('/slots', async (req, res, next) => {
    try {
        const { date, minutes, practitionerId } = req.query;
        if (!practitionerId) {
            return res.status(400).json({ error: '施術者を選択してください' });
        }
        const practitioner = await withDbClient((client) => (
            repositories.practitioners.findPractitionerById(client, practitionerId)
        ));
        if (!practitioner) {
            return res.status(404).json({ error: '施術者が見つかりません' });
        }
        const slots = await calendarService.getAvailableSlots(date, parseInt(minutes), practitioner.calendar_id);
        res.json(slots);
    } catch (err) {
        next(err);
    }
});

// GET /api/weekly-availability - 週間空き状況取得
router.get('/weekly-availability', async (req, res, next) => {
    try {
        const { startDate, minutes, practitionerId } = req.query;
        if (!practitionerId) {
            return res.status(400).json({ error: '施術者を選択してください' });
        }

        // Get business settings
        const settings = await getSettingsFromDb();
        const businessSettings = businessSettingsFrom(settings);

        // 「指名なし」の場合は全施術者のカレンダーを統合
        if (practitionerId === 'all') {
            const practitioners = await withDbClient((client) => repositories.practitioners.findActivePractitioners(client));
            if (practitioners.length === 0) {
                return res.status(404).json({ error: '施術者が登録されていません' });
            }
            const availability = await calendarService.getMergedWeeklyAvailability(
                startDate,
                parseInt(minutes),
                practitioners.map(calendarPractitioner),
                businessSettings
            );
            res.json(availability);
        } else {
            const practitioner = await withDbClient((client) => (
                repositories.practitioners.findPractitionerById(client, practitionerId)
            ));
            if (!practitioner) {
                return res.status(404).json({ error: '施術者が見つかりません' });
            }
            const availability = await calendarService.getWeeklyAvailability(
                startDate,
                parseInt(minutes),
                practitioner.calendar_id,
                businessSettings
            );
            res.json(availability);
        }
    } catch (err) {
        next(err);
    }
});

// ====================
// 予約関連
// ====================

// GET /api/history - ユーザーの予約履歴取得
router.get('/history', requireLineUser, rejectMismatchedLineUser, async (req, res, next) => {
    try {
        const userId = req.lineUser.lineUserId;
        const history = await reservationSheetsService.getUserReservations(userId);
        res.json(history);
    } catch (err) {
        next(err);
    }
});

// GET /api/reservations - 全予約一覧 (管理者のみ)
router.get('/reservations', async (req, res, next) => {
    try {
        const { adminId } = req.query;
        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }
        const reservations = await reservationSheetsService.getAllReservations();
        res.json(reservations);
    } catch (err) {
        next(err);
    }
});

// POST /api/reservations - 予約作成
router.post('/reservations', requireLineUser, rejectMismatchedLineUser, async (req, res, next) => {
    try {
        const lineUserId = req.lineUser.lineUserId;
        const idempotencyKey = getIdempotencyKey(req);
        const result = await createReservationFromDb(req.body || {}, lineUserId, idempotencyKey);
        const statusCode = result.existing ? 200 : 201;

        res.status(statusCode).json({
            status: 'success',
            id: result.reservation.id,
            existing: result.existing,
            reservation: reservationResponse(result.reservation),
        });
    } catch (err) {
        if (isReservationIdempotencyConflict(err)) {
            try {
                const existing = await findExistingReservation(req.lineUser.lineUserId, getIdempotencyKey(req));
                if (existing) {
                    return res.status(200).json({
                        status: 'success',
                        id: existing.id,
                        existing: true,
                        reservation: reservationResponse(existing),
                    });
                }
            } catch (lookupErr) {
                return next(lookupErr);
            }
        }

        if (isBusyRangeConflict(err)) {
            const slotConflict = conflict('指定された時間は既に予約が入っています');
            return res.status(slotConflict.statusCode).json({
                status: 'error',
                message: slotConflict.message,
            });
        }

        if (err.statusCode === 400 || isValidationDbError(err)) {
            return res.status(400).json({
                status: 'error',
                message: err.statusCode === 400 ? err.message : '予約内容が不正です',
            });
        }

        if (err.statusCode) {
            return res.status(err.statusCode).json({
                status: 'error',
                message: err.message,
            });
        }

        next(err);
    }
});

// DELETE /api/reservations/:id - 予約キャンセル
router.delete('/reservations/:id', requireLineUser, rejectMismatchedLineUser, async (req, res, next) => {
    try {
        const lineUserId = req.lineUser.lineUserId;
        const reservationId = req.params.id;
        const reason = cancelReasonFrom(req.body);

        const result = await cancelReservationFromDb({
            reservationId,
            actorType: 'customer',
            actorId: lineUserId,
            reason,
            source: 'customer_liff',
        });

        res.json({
            status: 'success',
            alreadyCanceled: result.alreadyCanceled,
            reservation: reservationResponse(result.reservation),
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        if (isValidationDbError(err)) {
            return res.status(400).json({ status: 'error', message: '予約IDが不正です' });
        }

        next(err);
    }
});

// PUT /api/reservations/:id - 予約変更
router.put('/reservations/:id', requireLineUser, rejectMismatchedLineUser, async (req, res, next) => {
    try {
        const userId = req.lineUser.lineUserId;
        const { menu, selectedOptions, newDate, newTime, practitionerId, totalMinutes, totalPrice } = req.body;
        const reservationId = req.params.id;

        // 1. 現在の予約情報を取得
        const reservation = await reservationSheetsService.getReservationById(reservationId, userId);
        if (!reservation) {
            return res.json({ status: 'error', message: '予約が見つかりませんでした' });
        }

        // 2. 24時間前チェック
        const reservationDateTime = new Date(`${reservation.date.replace(/\//g, '-')}T${reservation.time}:00+09:00`);
        const now = new Date();
        const hoursUntilReservation = (reservationDateTime - now) / (1000 * 60 * 60);
        if (hoursUntilReservation < 24) {
            return res.json({ status: 'error', message: '予約日時の24時間前を過ぎているため変更できません' });
        }

        // 3. 施術者情報を取得
        const practitioner = await withDbClient((client) => (
            repositories.practitioners.findPractitionerById(client, practitionerId)
        ));
        if (!practitioner) {
            return res.json({ status: 'error', message: '施術者が見つかりません' });
        }

        // 4. 新しい日時で重複チェック
        const newDateTime = new Date(`${newDate.replace(/\//g, '-')}T${newTime}:00+09:00`);
        const newEndTime = new Date(newDateTime.getTime() + totalMinutes * 60000);

        // 同じ施術者の場合は自身のイベントを除外してチェック
        const excludeEventId = String(reservation.practitionerId) === String(practitionerId) ? reservation.eventId : null;
        const hasConflict = await calendarService.checkConflict(newDateTime, newEndTime, practitioner.calendar_id, excludeEventId);
        if (hasConflict) {
            return res.json({ status: 'error', message: '指定された時間は既に予約が入っています' });
        }

        // 5. 旧カレンダーイベント削除
        if (reservation.eventId && reservation.practitionerId) {
            const oldPractitioner = await withDbClient((client) => (
                repositories.practitioners.findPractitionerById(client, reservation.practitionerId)
            ));
            if (oldPractitioner) {
                await calendarService.deleteEvent(reservation.eventId, oldPractitioner.calendar_id);
            }
        }

        // 6. 新カレンダーイベント作成
        const optionNames = selectedOptions && selectedOptions.length > 0
            ? selectedOptions.map(o => o.name).join('、')
            : '';

        const eventTitle = optionNames
            ? `【予約】${reservation.name}様 (${menu.name} + ${optionNames})`
            : `【予約】${reservation.name}様 (${menu.name})`;

        const eventDescription = optionNames
            ? `LINE ID: ${userId}\n担当: ${practitioner.name}\nオプション: ${optionNames}\n合計時間: ${totalMinutes}分 / ¥${Number(totalPrice).toLocaleString()}`
            : `LINE ID: ${userId}\n担当: ${practitioner.name}`;

        const newEventId = await calendarService.createEvent(
            eventTitle,
            newDateTime,
            newEndTime,
            eventDescription,
            practitioner.calendar_id
        );

        // 7. スプレッドシート更新
        const optionIds = selectedOptions ? selectedOptions.map(o => o.id).join(',') : '';
        const optionNamesStr = selectedOptions ? selectedOptions.map(o => o.name).join(',') : '';

        await reservationSheetsService.updateReservation(reservationId, userId, {
            menu: menu.name,
            date: newDate,
            time: newTime,
            eventId: newEventId,
            practitionerId: practitioner.id,
            practitionerName: practitioner.name,
            optionIds,
            optionNames: optionNamesStr,
            totalMinutes,
            totalPrice,
        });

        // 8. LINE通知（ユーザーへ）
        const oldOptionLine = reservation.optionNames ? `✨ オプション: ${reservation.optionNames.replace(/,/g, '、')}` : '';
        const newOptionLine = optionNames ? `✨ オプション: ${optionNames}` : '';

        const userMessage = `
${reservation.name}様
ご予約が変更されました。

【変更前】
📅 日時: ${reservation.date} ${reservation.time}
💆‍♀️ メニュー: ${reservation.menu}
${oldOptionLine}
👤 担当: ${reservation.practitionerName || '指名なし'}

【変更後】
📅 日時: ${newDate} ${newTime}
💆‍♀️ メニュー: ${menu.name}
${newOptionLine}
⏱️ 合計時間: ${totalMinutes}分
💰 合計料金: ¥${Number(totalPrice).toLocaleString()}
👤 担当: ${practitioner.name}
`.trim().replace(/\n\n+/g, '\n');
        await lineService.pushMessage(userId, userMessage);

        // 9. LINE通知（管理者へ）
        const adminMessage = `
【予約変更がありました】
👤 名前: ${reservation.name} 様
【変更前】📅 ${reservation.date} ${reservation.time} / ${reservation.menu}
【変更後】📅 ${newDate} ${newTime} / ${menu.name}
${newOptionLine}
⏱️ 合計: ${totalMinutes}分 / ¥${Number(totalPrice).toLocaleString()}
👤 担当: ${practitioner.name}
`.trim().replace(/\n\n+/g, '\n');
        await notifyAdmins(adminMessage);

        res.json({
            status: 'success',
            oldReservation: {
                date: reservation.date,
                time: reservation.time,
                menu: reservation.menu,
                practitionerName: reservation.practitionerName
            },
            newReservation: {
                date: newDate,
                time: newTime,
                menu: menu.name,
                practitionerName: practitioner.name
            }
        });
    } catch (err) {
        next(err);
    }
});

// ====================
// 管理者関連
// ====================

// GET /api/check-admin - 管理者判定
router.get('/check-admin', (req, res) => {
    const { userId } = req.query;
    res.json({ isAdmin: isAdmin(userId) });
});

// POST /api/admin/reservations - 管理者による代理予約作成
router.post('/admin/reservations', async (req, res, next) => {
    try {
        const data = req.body || {};
        const { adminId } = data;

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        if (!isUuid(data.practitionerId)) {
            return res.status(400).json({ status: 'error', message: '施術者IDが不正です' });
        }

        const customerName = data.name || data.customerName;
        if (!customerName) {
            return res.status(400).json({ status: 'error', message: 'お名前を入力してください' });
        }

        const lineUserId = data.lineUserId || null;

        const result = await db.withTransaction(async (client) => {
            const practitioner = await repositories.practitioners.findPractitionerById(client, data.practitionerId);
            if (!practitioner) {
                throw badRequest('施術者が見つかりません');
            }

            const practitionerSnapshot = {
                id: practitioner.id,
                name: practitioner.name,
                calendarId: practitioner.calendar_id || null,
            };

            const input = {
                ...buildReservationInput(data, lineUserId, null, practitionerSnapshot),
                createdVia: 'staff_admin',
            };

            const reservation = await repositories.reservations.createReservation(client, input);
            const payload = buildOutboxPayload(reservation, input);

            await repositories.outboxEvents.createOutboxEvent(client, {
                eventType: 'reservation.calendar.create',
                aggregateType: 'reservation',
                aggregateId: reservation.id,
                idempotencyKey: `calendar:create:${reservation.id}`,
                payload,
            });

            if (lineUserId) {
                await repositories.outboxEvents.createOutboxEvent(client, {
                    eventType: 'reservation.line.notify_customer_created',
                    aggregateType: 'reservation',
                    aggregateId: reservation.id,
                    idempotencyKey: `line:customer_created:${reservation.id}`,
                    payload,
                });
            }

            await repositories.outboxEvents.createOutboxEvent(client, {
                eventType: 'reservation.line.notify_admin_created',
                aggregateType: 'reservation',
                aggregateId: reservation.id,
                idempotencyKey: `line:admin_created:${reservation.id}`,
                payload: { ...payload, adminLineIds: ADMIN_LINE_IDS },
            });

            await repositories.auditLogs.createAuditLog(client, {
                actorType: 'admin',
                actorId: adminId,
                action: 'reservation.create',
                entityType: 'reservation',
                entityId: reservation.id,
                reservationId: reservation.id,
                afterData: reservation,
            });

            return { reservation };
        });

        res.status(201).json({
            status: 'success',
            reservation: reservationResponse(result.reservation),
            existing: false,
        });
    } catch (err) {
        if (isBusyRangeConflict(err)) {
            return res.status(409).json({ status: 'error', message: '指定された時間は既に予約が入っています' });
        }

        if (err.statusCode === 400 || isValidationDbError(err)) {
            return res.status(400).json({
                status: 'error',
                message: err.statusCode === 400 ? err.message : '予約内容が不正です',
            });
        }

        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        next(err);
    }
});

// DELETE /api/admin/reservations/:id - 管理者による予約キャンセル
router.delete('/admin/reservations/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const reservationId = req.params.id;
        const reason = cancelReasonFrom({ ...req.query, ...(req.body || {}) });

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        if (!reason) {
            return res.status(400).json({ status: 'error', message: 'キャンセル理由を指定してください' });
        }

        const result = await cancelReservationFromDb({
            reservationId,
            actorType: 'admin',
            actorId: adminId,
            reason,
            source: 'admin_api',
        });

        res.json({
            status: 'success',
            alreadyCanceled: result.alreadyCanceled,
            reservation: reservationResponse(result.reservation),
        });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        if (isValidationDbError(err)) {
            return res.status(400).json({ status: 'error', message: '予約IDが不正です' });
        }

        next(err);
    }
});

// ====================
// スタッフブロック管理
// ====================

// POST /api/admin/staff-blocks - スタッフブロック登録
router.post('/admin/staff-blocks', async (req, res, next) => {
    try {
        const data = req.body || {};
        const { adminId } = data;

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        if (!isUuid(data.practitionerId)) {
            return res.status(400).json({ status: 'error', message: '施術者IDが不正です' });
        }

        if (!data.startAt || Number.isNaN(Date.parse(data.startAt))) {
            return res.status(400).json({ status: 'error', message: 'startAt が不正です' });
        }

        if (!data.endAt || Number.isNaN(Date.parse(data.endAt))) {
            return res.status(400).json({ status: 'error', message: 'endAt が不正です' });
        }

        if (Date.parse(data.endAt) <= Date.parse(data.startAt)) {
            return res.status(400).json({ status: 'error', message: 'endAt は startAt より後にしてください' });
        }

        const result = await db.withTransaction(async (client) => {
            const staffBlock = await repositories.staffBlocks.createStaffBlock(client, {
                practitionerId: data.practitionerId,
                startAt: data.startAt,
                endAt: data.endAt,
                reason: data.reason,
                source: data.source || 'admin',
            });

            await repositories.auditLogs.createAuditLog(client, {
                actorType: 'admin',
                actorId: adminId,
                action: 'staff_block.create',
                entityType: 'staff_block',
                entityId: staffBlock.id,
                staffBlockId: staffBlock.id,
                afterData: staffBlock,
            });

            return { staffBlock };
        });

        res.status(201).json({ status: 'success', staffBlock: result.staffBlock });
    } catch (err) {
        if (isBusyRangeConflict(err)) {
            return res.status(409).json({ status: 'error', message: '指定時間帯に予約またはブロックがすでに存在します' });
        }

        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        next(err);
    }
});

// DELETE /api/admin/staff-blocks/:id - スタッフブロック取消
router.delete('/admin/staff-blocks/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const staffBlockId = req.params.id;

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        const result = await db.withTransaction(async (client) => {
            const existing = await repositories.staffBlocks.findById(client, staffBlockId);
            if (!existing) {
                throw notFound('スタッフブロックが見つかりません');
            }

            if (existing.status === 'released') {
                return { staffBlock: existing };
            }

            const staffBlock = await repositories.staffBlocks.releaseStaffBlock(client, staffBlockId);
            await repositories.staffBlocks.releaseStaffBlockBusyRange(client, staffBlockId);

            await repositories.auditLogs.createAuditLog(client, {
                actorType: 'admin',
                actorId: adminId,
                action: 'staff_block.release',
                entityType: 'staff_block',
                entityId: staffBlockId,
                staffBlockId,
                beforeData: existing,
                afterData: staffBlock,
            });

            return { staffBlock };
        });

        res.status(200).json({ status: 'success', staffBlock: result.staffBlock });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        next(err);
    }
});

// GET /api/admin/staff-blocks - スタッフブロック一覧取得
router.get('/admin/staff-blocks', async (req, res, next) => {
    try {
        const adminId = req.query.adminId;

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        const { practitionerId, from, to } = req.query;

        const staffBlocks = await db.withTransaction(async (client) => {
            return repositories.staffBlocks.findByPractitioner(client, {
                practitionerId: practitionerId || undefined,
                from: from || undefined,
                to: to || undefined,
            });
        });

        res.json({ status: 'success', staffBlocks });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ status: 'error', message: err.message });
        }

        next(err);
    }
});

router.get('/admin/outbox/stats', requireAdmin, async (req, res, next) => {
    try {
        const pool = db.getPool();
        const stats = await withClient(pool, (client) => repositories.outboxEvents.getStats(client));
        res.status(200).json(stats);
    } catch (err) {
        next(err);
    }
});

router.post('/admin/outbox/reset-stale', requireAdmin, async (req, res, next) => {
    try {
        const pool = db.getPool();
        const reset = await withClient(pool, (client) => repositories.outboxEvents.resetStaleProcessing(client));
        res.status(200).json({ reset });
    } catch (err) {
        next(err);
    }
});

router.post('/admin/outbox/:id/retry', requireAdmin, async (req, res, next) => {
    try {
        const pool = db.getPool();
        const queued = await withClient(pool, (client) => repositories.outboxEvents.retryEvent(client, req.params.id));

        if (!queued) {
            return res.status(409).json({ error: 'event is not retryable' });
        }

        return res.status(200).json({ queued: true });
    } catch (err) {
        next(err);
    }
});

// ====================
// 画像アップロード
// ====================

// POST /api/upload-image - 画像アップロード (管理者のみ)
router.post('/upload-image', async (req, res, next) => {
    try {
        const { adminId, imageData, fileName } = req.body;

        if (!isAdmin(adminId)) {
            return res.json({ status: 'error', code: 'E001', message: '[E001] 権限がありません' });
        }

        if (!imageData) {
            return res.json({ status: 'error', code: 'E003', message: '[E003] 画像データがありません' });
        }

        const result = await storageService.uploadImage(imageData, fileName);
        res.json(result);
    } catch (err) {
        next(err);
    }
});

// ====================
// バッチ処理関連
// ====================

// POST /api/batch/outbox - outbox イベント処理
async function withClient(pool, callback) {
    const client = await pool.connect();
    try {
        return await callback(client);
    } finally {
        client.release();
    }
}

function buildCalendarDescription(p) {
    return [
        `担当: ${p.practitionerName}`,
        `メニュー: ${p.menuName}`,
        `所要時間: ${p.totalMinutes}分`,
        `金額: ${p.totalPrice}円`,
        `電話: ${p.customerPhone}`,
    ].join('\n');
}

function parseCalendarSyncStateIds(body = {}) {
    const raw = body.calendarSyncStateIds
        ?? body.calendar_sync_state_ids
        ?? body.stateIds
        ?? body.state_ids
        ?? body.calendarSyncStateId
        ?? body.calendar_sync_state_id
        ?? body.stateId
        ?? body.id
        ?? null;

    if (raw === null || raw === undefined || raw === '') {
        return [];
    }

    const values = Array.isArray(raw)
        ? raw
        : String(raw).split(',').map(id => id.trim());
    const nonEmptyValues = values.map(value => String(value || '').trim()).filter(Boolean);
    const ids = [];
    const seen = new Set();

    for (const id of nonEmptyValues) {
        if (!isUuid(id)) {
            throw badRequest('calendar_sync_state.id の形式が不正です');
        }
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }

    return ids;
}

function parseCalendarSyncLimit(value) {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }

    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
        throw badRequest('limit は1から100の整数で指定してください');
    }

    return limit;
}

function parseBooleanFlag(value) {
    if (value === undefined || value === null || value === '') {
        return false;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value === 1;
    }
    return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function handleCalendarCreate(event) {
    const p = event.payload;
    if (!p.calendarId) {
        console.log('[outbox] calendar create: no calendarId, skip', event.id);
        return;
    }

    const calEventId = 'r' + p.reservationId.replace(/-/g, '');

    await calendarService.createEvent(
        `${p.menuName}（${p.customerName}）`,
        new Date(p.startAt),
        new Date(p.endAt),
        buildCalendarDescription(p),
        p.calendarId,
        { eventId: calEventId, reservationId: p.reservationId }
    );

    const pool = db.getPool();
    await withClient(pool, (client) =>
        repositories.reservations.updateCalendarEventId(client, {
            id: p.reservationId,
            calendarEventId: calEventId,
        })
    );
}

async function handleCalendarCancel(event) {
    const p = event.payload;
    if (!p.calendarId) {
        console.log('[outbox] calendar cancel: no calendarId, skip', event.id);
        return;
    }
    const calEventId = p.calendarEventId || ('r' + p.reservationId.replace(/-/g, ''));
    await calendarService.deleteEvent(calEventId, p.calendarId);
}

router.post('/batch/calendar-sync', async (req, res, next) => {
    try {
        const secret = req.headers['x-scheduler-secret'];
        const expectedSecret = process.env.SCHEDULER_SECRET;

        if (!expectedSecret || secret !== expectedSecret) {
            console.log('[CalendarSync] Unauthorized access attempt');
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        const result = await calendarSyncService.syncCalendarStates({
            stateIds: parseCalendarSyncStateIds(req.body || {}),
            limit: parseCalendarSyncLimit(req.body?.limit),
        });

        return res.json({ status: 'ok', ...result });
    } catch (err) {
        next(err);
    }
});

router.post('/batch/calendar-watch/refresh', async (req, res, next) => {
    try {
        const secret = req.headers['x-scheduler-secret'];
        const expectedSecret = process.env.SCHEDULER_SECRET;

        if (!expectedSecret || secret !== expectedSecret) {
            console.log('[CalendarWatch] Unauthorized access attempt');
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        const result = await calendarWatchService.refreshCalendarWatchChannels({
            force: parseBooleanFlag(req.body?.force),
            limit: parseCalendarSyncLimit(req.body?.limit),
        });

        return res.json({ status: 'ok', ...result });
    } catch (err) {
        next(err);
    }
});

function formatOptionNames(optionNames) {
    if (Array.isArray(optionNames) && optionNames.length > 0) {
        return optionNames.join('、');
    }
    if (typeof optionNames === 'string' && optionNames) {
        return optionNames;
    }
    return null;
}

function buildCustomerCreatedMessage(p) {
    const opts = formatOptionNames(p.optionNames);
    const lines = [
        `${p.customerName}様`,
        'ご予約が完了しました。',
        '',
        `📅 日時: ${p.date} ${p.time}`,
        `💆 メニュー: ${p.menuName}`,
    ];
    if (opts) lines.push(`✨ オプション: ${opts}`);
    lines.push(
        `⏱️ 所要時間: ${p.totalMinutes}分`,
        `💰 料金: ¥${Number(p.totalPrice).toLocaleString()}`,
        `👤 担当: ${p.practitionerName || '指名なし'}`,
        '',
        'ご来店をお待ちしております。'
    );
    return lines.join('\n');
}

function buildAdminCreatedMessage(p) {
    const opts = formatOptionNames(p.optionNames);
    const menuLine = opts ? `💆 ${p.menuName} + ${opts}` : `💆 ${p.menuName}`;
    return [
        '【新規予約】',
        `👤 ${p.customerName} 様`,
        `📅 ${p.date} ${p.time}`,
        menuLine,
        `⏱️ ${p.totalMinutes}分 / ¥${Number(p.totalPrice).toLocaleString()}`,
        `👤 担当: ${p.practitionerName || '未定'}`,
        `📞 ${p.customerPhone || '-'}`,
    ].join('\n');
}

function buildCustomerCanceledMessage(p) {
    const lines = [
        `${p.customerName}様`,
        'ご予約をキャンセルしました。',
        '',
        `📅 ${p.date} ${p.time}`,
        `💆 ${p.menuName}`,
        `👤 担当: ${p.practitionerName || '指名なし'}`,
    ];
    if (p.cancelReason) lines.push(`キャンセル理由: ${p.cancelReason}`);
    lines.push('', 'またのご利用をお待ちしております。');
    return lines.join('\n');
}

function buildAdminCanceledMessage(p) {
    const lines = [
        '【予約キャンセル】',
        `👤 ${p.customerName} 様`,
        `📅 ${p.date} ${p.time}`,
        `💆 ${p.menuName}`,
        `👤 担当: ${p.practitionerName || '未定'}`,
    ];
    if (p.cancelReason) lines.push(`キャンセル理由: ${p.cancelReason}`);
    return lines.join('\n');
}

async function handleLineNotifyCustomerCreated(event) {
    const p = event.payload;
    if (!p || !p.lineUserId) return;
    await lineService.pushMessage(p.lineUserId, buildCustomerCreatedMessage(p));
}

async function handleLineNotifyAdminCreated(event) {
    const p = event.payload;
    const ids = (p && p.adminLineIds) || [];
    await Promise.all(ids.map(id => lineService.pushMessage(id, buildAdminCreatedMessage(p))));
}

async function handleLineNotifyCustomerCanceled(event) {
    const p = event.payload;
    if (!p || !p.lineUserId) return;
    await lineService.pushMessage(p.lineUserId, buildCustomerCanceledMessage(p));
}

async function handleLineNotifyAdminCanceled(event) {
    const p = event.payload;
    const ids = (p && p.adminLineIds) || [];
    await Promise.all(ids.map(id => lineService.pushMessage(id, buildAdminCanceledMessage(p))));
}

const EVENT_HANDLERS = {
    'reservation.calendar.create':               handleCalendarCreate,
    'reservation.calendar.cancel':               handleCalendarCancel,
    'reservation.line.notify_customer_created':  handleLineNotifyCustomerCreated,
    'reservation.line.notify_admin_created':     handleLineNotifyAdminCreated,
    'reservation.line.notify_customer_canceled': handleLineNotifyCustomerCanceled,
    'reservation.line.notify_admin_canceled':    handleLineNotifyAdminCanceled,
};

async function processEvent(event) {
    const handler = EVENT_HANDLERS[event.event_type];
    if (!handler) {
        throw new Error(`Unknown event_type: ${event.event_type}`);
    }
    await handler(event);
}

router.post('/batch/outbox', async (req, res, next) => {
    try {
        const secret = req.headers['x-scheduler-secret'];
        const expectedSecret = process.env.SCHEDULER_SECRET;

        if (!expectedSecret || secret !== expectedSecret) {
            console.log('[Outbox] Unauthorized access attempt');
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        const workerId = `outbox-worker-${Date.now()}`;
        const pool = db.getPool();
        const { outboxEvents } = repositories;

        const staleRows = await withClient(pool, (client) => outboxEvents.recoverStale(client));
        const recovered = staleRows.length;
        console.log(`[Outbox] Recovered ${recovered} stale events`);

        const events = await withClient(pool, (client) => outboxEvents.claimEvents(client, { workerId }));
        console.log(`[Outbox] Worker ${workerId} claimed ${events.length} events`);

        let processed = 0;
        let failed = 0;

        for (const event of events) {
            try {
                await processEvent(event);
                await withClient(pool, (client) => outboxEvents.markSucceeded(client, { id: event.id }));
                processed++;
            } catch (err) {
                console.error(`[Outbox] Failed to process event ${event.id}:`, err.message);
                try {
                    await withClient(pool, (client) => outboxEvents.markFailed(client, { id: event.id, error: err }));
                } catch (markErr) {
                    console.error(`[Outbox] markFailed failed for event ${event.id}:`, markErr.message);
                }
                failed++;
            }
        }

        res.json({ processed, failed, recovered });
    } catch (err) {
        next(err);
    }
});

// POST /api/batch/reminders - 翌日の予約リマインダー送信
router.post('/batch/reminders', async (req, res, next) => {
    try {
        const secret = req.headers['x-scheduler-secret'];
        const expectedSecret = process.env.SCHEDULER_SECRET;

        // セキュリティチェック
        if (!expectedSecret || secret !== expectedSecret) {
            console.log('[Batch] Unauthorized access attempt');
            return res.status(403).json({ status: 'error', message: 'Forbidden' });
        }

        console.log('[Batch] Starting reminder batch...');

        // スプレッドシートから保存された設定を取得 (空の場合は空のまま)
        const settings = await getSettingsFromDb();
        const salonInfo = settings.salonInfo || '';
        const precautions = settings.precautions || '';

        const reservations = await reservationSheetsService.getTomorrowReservations();
        console.log(`[Batch] Found ${reservations.length} reservations for tomorrow`);

        let sentCount = 0;
        for (const r of reservations) {
            // 注意事項・店舗情報セクションを動的に構築
            const precautionsSection = precautions ? `\n${precautions.trim()}` : '';
            const salonInfoSection = salonInfo ? `\n---------------\n${salonInfo.trim()}\n---------------` : '';

            const message = `
${r.name}様
明日、ご予約の日時となりましたのでご連絡差し上げました。

📅 日時: ${r.date} ${r.time}
💆‍♀️ メニュー: ${r.menu}
${precautionsSection}
${salonInfoSection}

ご来店を心よりお待ちしております。
`.trim().replace(/\n\n+/g, '\n');

            await lineService.pushMessage(r.lineId, message);
            sentCount++;
        }

        console.log(`[Batch] Sent ${sentCount} reminders`);
        res.json({ status: 'success', sentCount });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
