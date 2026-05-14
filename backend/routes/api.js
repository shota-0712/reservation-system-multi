const express = require('express');
const router = express.Router();
const sheetsService = require('../services/sheets');
const calendarService = require('../services/calendar');
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

function selectedPractitionerFrom(data) {
    if (data.practitionerId) {
        return {
            id: data.practitionerId,
            name: data.practitionerName,
            calendarId: data.calendarId,
        };
    }

    if (Array.isArray(data.availablePractitioners) && data.availablePractitioners.length > 0) {
        return data.availablePractitioners[0];
    }

    return null;
}

async function resolvePractitionerSnapshot(client, data, practitionerId) {
    const selected = selectedPractitionerFrom(data);
    const requestCalendarId = data.calendarId || selected?.calendarId || null;
    const practitioner = await repositories.practitioners.findPractitionerById(client, practitionerId);

    if (!practitioner) {
        throw badRequest('施術者が見つかりません');
    }

    return {
        name: practitioner.name,
        calendarId: practitioner.calendar_id || requestCalendarId,
    };
}

function buildReservationInput(data, lineUserId, idempotencyKey, practitionerSnapshot) {
    const selected = selectedPractitionerFrom(data);
    if (!selected?.id) {
        throw badRequest('施術者を選択してください');
    }

    const practitionerId = String(selected.id);
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
        practitionerName: reservation.practitioner_name_snapshot,
        totalMinutes: reservation.total_minutes,
        totalPrice: reservation.total_price,
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

async function createReservationFromDb(data, lineUserId, idempotencyKey) {
    if (idempotencyKey) {
        const existing = await findExistingReservation(lineUserId, idempotencyKey);
        if (existing) {
            return { reservation: existing, existing: true };
        }
    }

    const selected = selectedPractitionerFrom(data);
    const practitionerId = selected?.id ? String(selected.id) : '';
    if (!practitionerId) {
        throw badRequest('施術者を選択してください');
    }
    if (!isUuid(practitionerId)) {
        throw badRequest('施術者IDの形式が不正です');
    }

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

// ====================
// アプリ設定関連
// ====================

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
        const menus = await sheetsService.getMenus();
        res.json(menus);
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
        const result = await sheetsService.addMenu(menu);
        res.json(result);
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
        const result = await sheetsService.reorderMenus(orderedIds);
        res.json(result);
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
        const result = await sheetsService.updateMenu(menuId, menu);
        res.json(result);
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
        const result = await sheetsService.deleteMenu(menuId);
        res.json(result);
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
        const settings = await sheetsService.getSettings();
        console.log('[Debug] Settings loaded from sheet:', JSON.stringify(settings));

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
            businessStartHour: settings.businessStartHour || '10',
            businessEndHour: settings.businessEndHour || '20',
            holidays: settings.holidays || '',
            regularHolidays: JSON.parse(settings.regularHolidays || '[]'),
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

        const result = await sheetsService.updateSettings(settings);
        res.json(result);
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
        const practitioners = await sheetsService.getPractitioners();
        res.json(practitioners);
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
        const result = await sheetsService.addPractitioner(practitioner);
        res.json(result);
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
        const result = await sheetsService.updatePractitioner(practitionerId, practitioner);
        res.json(result);
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
        const result = await sheetsService.deletePractitioner(practitionerId);
        res.json(result);
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
        const options = await sheetsService.getOptions();
        res.json(options);
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
        const result = await sheetsService.addOption(option);
        res.json(result);
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
        const result = await sheetsService.updateOption(optionId, option);
        res.json(result);
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
        const result = await sheetsService.deleteOption(optionId);
        res.json(result);
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
        const practitioner = await sheetsService.getPractitionerById(practitionerId);
        if (!practitioner) {
            return res.status(404).json({ error: '施術者が見つかりません' });
        }
        const slots = await calendarService.getAvailableSlots(date, parseInt(minutes), practitioner.calendarId);
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
        const settings = await sheetsService.getSettings();
        const businessSettings = {
            startHour: parseInt(settings.businessStartHour) || 10,
            endHour: parseInt(settings.businessEndHour) || 20,
            holidays: settings.holidays ? settings.holidays.split(',').map(d => d.trim()) : [],
            regularHolidays: JSON.parse(settings.regularHolidays || '[]'),
            temporaryBusinessDays: settings.temporaryBusinessDays ? settings.temporaryBusinessDays.split(',').map(d => d.trim()) : [],
        };

        // 「指名なし」の場合は全施術者のカレンダーを統合
        if (practitionerId === 'all') {
            const practitioners = await sheetsService.getPractitioners();
            if (practitioners.length === 0) {
                return res.status(404).json({ error: '施術者が登録されていません' });
            }
            const availability = await calendarService.getMergedWeeklyAvailability(startDate, parseInt(minutes), practitioners, businessSettings);
            res.json(availability);
        } else {
            const practitioner = await sheetsService.getPractitionerById(practitionerId);
            if (!practitioner) {
                return res.status(404).json({ error: '施術者が見つかりません' });
            }
            const availability = await calendarService.getWeeklyAvailability(startDate, parseInt(minutes), practitioner.calendarId, businessSettings);
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
        const history = await sheetsService.getUserReservations(userId);
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
        const reservations = await sheetsService.getAllReservations();
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

        next(err);
    }
});

// DELETE /api/reservations/:id - 予約キャンセル
router.delete('/reservations/:id', requireLineUser, rejectMismatchedLineUser, async (req, res, next) => {
    try {
        const userId = req.lineUser.lineUserId;
        const reservationId = req.params.id;

        // 予約情報を取得
        const reservation = await sheetsService.getReservationById(reservationId, userId);
        if (!reservation) {
            return res.json({ status: 'error', message: '予約が見つかりませんでした' });
        }

        // 24時間前チェック
        const reservationDateTime = new Date(`${reservation.date.replace(/\//g, '-')}T${reservation.time}:00+09:00`);
        const now = new Date();
        const hoursUntilReservation = (reservationDateTime - now) / (1000 * 60 * 60);
        if (hoursUntilReservation < 24) {
            return res.json({ status: 'error', message: '予約日時の24時間前を過ぎているためキャンセルできません' });
        }

        // 施術者のカレンダーからイベント削除
        if (reservation.eventId && reservation.practitionerId) {
            const practitioner = await sheetsService.getPractitionerById(reservation.practitionerId);
            if (practitioner) {
                await calendarService.deleteEvent(reservation.eventId, practitioner.calendarId);
            }
        }

        // スプレッドシートのステータスを更新
        await sheetsService.cancelReservation(reservationId);

        // LINE通知 (ユーザーへ)
        // スプレッドシートから保存された設定を取得 (空の場合は空のまま)
        const settings = await sheetsService.getSettings();
        const salonInfo = settings.salonInfo || '';
        const salonInfoSection = salonInfo ? `---------------\n${salonInfo}\n---------------` : '';

        const userMessage = `
${reservation.name}様
ご予約のキャンセルを承りました。

📅 日時: ${reservation.date} ${reservation.time}
💆‍♀️ メニュー: ${reservation.menu}
${reservation.practitionerName ? `👤 担当: ${reservation.practitionerName}` : ''}
${salonInfoSection}
またのご来店を心よりお待ちしております。
`.trim().replace(/\n\n+/g, '\n');
        await lineService.pushMessage(userId, userMessage);

        // LINE通知 (管理者へ)
        const adminMessage = `
【予約キャンセルがありました】
👤 名前: ${reservation.name} 様
📅 日時: ${reservation.date} ${reservation.time}
💆‍♀️ メニュー: ${reservation.menu}
${reservation.practitionerName ? `👤 担当: ${reservation.practitionerName}` : ''}
`.trim();
        await notifyAdmins(adminMessage);

        res.json({ status: 'success' });
    } catch (err) {
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
        const reservation = await sheetsService.getReservationById(reservationId, userId);
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
        const practitioner = await sheetsService.getPractitionerById(practitionerId);
        if (!practitioner) {
            return res.json({ status: 'error', message: '施術者が見つかりません' });
        }

        // 4. 新しい日時で重複チェック
        const newDateTime = new Date(`${newDate.replace(/\//g, '-')}T${newTime}:00+09:00`);
        const newEndTime = new Date(newDateTime.getTime() + totalMinutes * 60000);

        // 同じ施術者の場合は自身のイベントを除外してチェック
        const excludeEventId = String(reservation.practitionerId) === String(practitionerId) ? reservation.eventId : null;
        const hasConflict = await calendarService.checkConflict(newDateTime, newEndTime, practitioner.calendarId, excludeEventId);
        if (hasConflict) {
            return res.json({ status: 'error', message: '指定された時間は既に予約が入っています' });
        }

        // 5. 旧カレンダーイベント削除
        if (reservation.eventId && reservation.practitionerId) {
            const oldPractitioner = await sheetsService.getPractitionerById(reservation.practitionerId);
            if (oldPractitioner) {
                await calendarService.deleteEvent(reservation.eventId, oldPractitioner.calendarId);
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
            practitioner.calendarId
        );

        // 7. スプレッドシート更新
        const optionIds = selectedOptions ? selectedOptions.map(o => o.id).join(',') : '';
        const optionNamesStr = selectedOptions ? selectedOptions.map(o => o.name).join(',') : '';

        await sheetsService.updateReservation(reservationId, userId, {
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

// DELETE /api/admin/reservations/:id - 管理者による予約キャンセル
router.delete('/admin/reservations/:id', async (req, res, next) => {
    try {
        const adminId = req.query.adminId || (req.body && req.body.adminId);
        const reservationId = req.params.id;

        if (!isAdmin(adminId)) {
            return res.status(403).json({ status: 'error', message: '権限がありません' });
        }

        // 予約情報を取得（管理者用）
        const reservation = await sheetsService.getReservationByIdForAdmin(reservationId);
        if (!reservation) {
            return res.json({ status: 'error', message: '予約が見つかりませんでした' });
        }

        if (reservation.status === 'canceled') {
            return res.json({ status: 'error', message: 'この予約は既にキャンセル済みです' });
        }

        // 施術者のカレンダーからイベント削除
        if (reservation.eventId && reservation.practitionerId) {
            const practitioner = await sheetsService.getPractitionerById(reservation.practitionerId);
            if (practitioner) {
                await calendarService.deleteEvent(reservation.eventId, practitioner.calendarId);
            }
        }

        // スプレッドシートのステータスを更新
        await sheetsService.cancelReservation(reservationId);

        // 設定からサロン情報を取得
        const settings = await sheetsService.getSettings();
        const salonInfo = settings.salonInfo || '';

        // LINE通知 (ユーザーへ) - lineIdが存在する場合のみ
        if (reservation.lineId) {
            const salonInfoSection = salonInfo ? `\n---------------\n${salonInfo}\n---------------` : '';
            const userMessage = `
${reservation.name}様

誠に申し訳ございませんが、ご予約をキャンセルさせていただきました。

📅 日時: ${reservation.date} ${reservation.time}
💆‍♀️ メニュー: ${reservation.menu}
${reservation.practitionerName ? `👤 担当: ${reservation.practitionerName}` : ''}
${salonInfoSection}

ご不明な点がございましたら、お気軽にお問い合わせください。
`.trim().replace(/\n\n+/g, '\n');
            await lineService.pushMessage(reservation.lineId, userMessage);
        }

        // LINE通知 (管理者へ)
        const adminMessage = `
【管理者によるキャンセル】
👤 名前: ${reservation.name} 様
📅 日時: ${reservation.date} ${reservation.time}
💆‍♀️ メニュー: ${reservation.menu}
${reservation.practitionerName ? `👤 担当: ${reservation.practitionerName}` : ''}
`.trim();
        await notifyAdmins(adminMessage);

        res.json({ status: 'success' });
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
        const settings = await sheetsService.getSettings();
        const salonInfo = settings.salonInfo || '';
        const precautions = settings.precautions || '';

        const reservations = await sheetsService.getTomorrowReservations();
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
