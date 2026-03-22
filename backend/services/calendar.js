const { google } = require('googleapis');

// カレンダーIDは施術者ごとに動的に受け取る

// Google Calendar API クライアントを取得
async function getCalendarClient() {
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    const authClient = await auth.getClient();
    return google.calendar({ version: 'v3', auth: authClient });
}

// 日付をJSTでフォーマット
function formatDateJST(date) {
    const jst = new Date(date.getTime() + (9 * 60 * 60 * 1000));
    return jst.toISOString().slice(0, 10).replace(/-/g, '/');
}

function formatTimeJST(date) {
    const jst = new Date(date.getTime() + (9 * 60 * 60 * 1000));
    return jst.toISOString().slice(11, 16);
}

// 週間空き状況を取得
async function getWeeklyAvailability(startDateStr, menuMinutes, calendarId, businessSettings = {}) {
    const calendar = await getCalendarClient();
    const result = [];

    // Default business hours
    const startHour = businessSettings.startHour || 10;
    const endHour = businessSettings.endHour || 20;
    const holidays = businessSettings.holidays || [];
    const regularHolidays = businessSettings.regularHolidays || [];
    const temporaryBusinessDays = businessSettings.temporaryBusinessDays || [];

    // 1週間分ループ
    for (let i = 0; i < 7; i++) {
        // JSTで日付を作成
        const [year, month, day] = startDateStr.split('/').map(Number);
        const targetDate = new Date(year, month - 1, day + i);

        const dateStr = `${targetDate.getFullYear()}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${String(targetDate.getDate()).padStart(2, '0')}`;
        const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][targetDate.getDay()]; // 0=Sun, 1=Mon...

        // 営業日判定ロジック
        // 1. 臨時休業日 (最優先で休み)
        let isClosed = false;
        if (holidays.includes(dateStr)) {
            isClosed = true;
        }
        // 2. 臨時営業日 (定休日より優先で営業 -> 休みではない)
        else if (temporaryBusinessDays.includes(dateStr)) {
            isClosed = false;
        }
        // 3. 定休日 (デフォルト休み)
        else if (regularHolidays.includes(targetDate.getDay())) {
            isClosed = true;
        }

        if (isClosed) {
            // 休業日の場合、全スロットを「休」に
            const slots = [];
            for (let hour = startHour; hour < endHour; hour++) {
                for (let minute = 0; minute < 60; minute += 30) {
                    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                    slots.push({ time: timeStr, status: '休' });
                }
            }
            result.push({ date: dateStr, day: dayOfWeek, slots: slots });
            continue;
        }

        // その日のイベントを取得 (JSTの0:00-23:59をUTCに変換)
        const dayStartJST = new Date(targetDate);
        dayStartJST.setHours(0, 0, 0, 0);
        const dayEndJST = new Date(targetDate);
        dayEndJST.setHours(23, 59, 59, 999);

        const eventsResponse = await calendar.events.list({
            calendarId: calendarId,
            timeMin: dayStartJST.toISOString(),
            timeMax: dayEndJST.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = eventsResponse.data.items || [];
        const slots = [];

        // 営業開始〜終了まで30分刻み (JST)
        for (let hour = startHour; hour < endHour; hour++) {
            for (let minute = 0; minute < 60; minute += 30) {
                const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                // JSTでスロットの開始・終了時間を作成
                const slotStart = new Date(targetDate);
                slotStart.setHours(hour, minute, 0, 0);
                const slotEnd = new Date(slotStart.getTime() + (menuMinutes * 60000));

                let status = '⚪︎'; // デフォルトは空き

                // 1. 過去チェック
                const now = new Date();
                if (slotStart < now) {
                    status = '-';
                } else {
                    // 2. 終了時間が営業終了時間を超える場合は不可
                    const closingTime = new Date(targetDate);
                    closingTime.setHours(endHour, 0, 0, 0);

                    if (slotEnd > closingTime) {
                        status = '×';
                    } else {
                        // 3. 予定重複チェック
                        for (const event of events) {
                            const eventStart = new Date(event.start.dateTime || event.start.date);
                            const eventEnd = new Date(event.end.dateTime || event.end.date);

                            if (slotStart < eventEnd && slotEnd > eventStart) {
                                status = '×';
                                break;
                            }
                        }
                    }
                }

                slots.push({ time: timeStr, status: status });
            }
        }

        result.push({
            date: dateStr,
            day: dayOfWeek,
            slots: slots,
        });
    }

    return result;
}


// 指定日の空き時間を取得
async function getAvailableSlots(dateStr, menuMinutes, calendarId) {
    const calendar = await getCalendarClient();
    const targetDate = new Date(dateStr.replace(/\//g, '-') + 'T00:00:00+09:00');

    // その日のイベントを取得
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    const eventsResponse = await calendar.events.list({
        calendarId: calendarId,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
    });

    const events = eventsResponse.data.items || [];
    const availableSlots = [];

    const current = new Date(targetDate);
    current.setHours(10 - 9, 0, 0, 0);

    const endTimeLimit = new Date(targetDate);
    endTimeLimit.setHours(20 - 9, 0, 0, 0);

    while (current.getTime() + (menuMinutes * 60000) <= endTimeLimit.getTime()) {
        const slotStart = new Date(current);
        const slotEnd = new Date(current.getTime() + (menuMinutes * 60000));

        let isConflict = false;

        if (slotStart < new Date()) {
            isConflict = true;
        } else {
            for (const event of events) {
                const eventStart = new Date(event.start.dateTime || event.start.date);
                const eventEnd = new Date(event.end.dateTime || event.end.date);

                if (slotStart < eventEnd && slotEnd > eventStart) {
                    isConflict = true;
                    break;
                }
            }
        }

        if (!isConflict) {
            availableSlots.push(formatTimeJST(slotStart));
        }

        current.setMinutes(current.getMinutes() + 30);
    }

    return availableSlots;
}

// 予約の重複チェック
// excludeEventId: 除外するイベントID（予約変更時に自身のイベントを除外するため）
async function checkConflict(startTime, endTime, calendarId, excludeEventId = null) {
    const calendar = await getCalendarClient();

    const eventsResponse = await calendar.events.list({
        calendarId: calendarId,
        timeMin: startTime.toISOString(),
        timeMax: endTime.toISOString(),
        singleEvents: true,
    });

    const events = eventsResponse.data.items || [];
    // excludeEventId が指定されている場合、そのイベントを除外してチェック
    const conflictingEvents = excludeEventId
        ? events.filter(e => e.id !== excludeEventId)
        : events;
    return conflictingEvents.length > 0;
}

// カレンダーにイベント作成
async function createEvent(title, startTime, endTime, description, calendarId) {
    const calendar = await getCalendarClient();

    const response = await calendar.events.insert({
        calendarId: calendarId,
        requestBody: {
            summary: title,
            description: description,
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'Asia/Tokyo',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'Asia/Tokyo',
            },
        },
    });

    return response.data.id;
}

// カレンダーからイベント削除
async function deleteEvent(eventId, calendarId) {
    const calendar = await getCalendarClient();

    try {
        await calendar.events.delete({
            calendarId: calendarId,
            eventId: eventId,
        });
        return true;
    } catch (err) {
        console.error('Failed to delete calendar event:', err.message);
        return false;
    }
}

// 全施術者の統合空き状況を取得（指名なし用）
// practitioners: [{id, name, calendarId}, ...]
async function getMergedWeeklyAvailability(startDateStr, menuMinutes, practitioners, businessSettings = {}) {
    const calendar = await getCalendarClient();
    const result = [];

    // Default business hours
    const startHour = businessSettings.startHour || 10;
    const endHour = businessSettings.endHour || 20;
    const holidays = businessSettings.holidays || [];
    const regularHolidays = businessSettings.regularHolidays || [];
    const temporaryBusinessDays = businessSettings.temporaryBusinessDays || [];

    // 1週間分ループ
    for (let i = 0; i < 7; i++) {
        // JSTで日付を作成
        const [year, month, day] = startDateStr.split('/').map(Number);
        const targetDate = new Date(year, month - 1, day + i);

        const dateStr = `${targetDate.getFullYear()}/${String(targetDate.getMonth() + 1).padStart(2, '0')}/${String(targetDate.getDate()).padStart(2, '0')}`;
        const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][targetDate.getDay()];

        // 営業日判定ロジック
        let isClosed = false;
        if (holidays.includes(dateStr)) {
            isClosed = true;
        } else if (temporaryBusinessDays.includes(dateStr)) {
            isClosed = false;
        } else if (regularHolidays.includes(targetDate.getDay())) {
            isClosed = true;
        }

        if (isClosed) {
            const slots = [];
            for (let hour = startHour; hour < endHour; hour++) {
                for (let minute = 0; minute < 60; minute += 30) {
                    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                    slots.push({ time: timeStr, status: '休', availablePractitioners: [] });
                }
            }
            result.push({ date: dateStr, day: dayOfWeek, slots: slots });
            continue;
        }

        // その日のイベントを全施術者分取得
        const dayStartJST = new Date(targetDate);
        dayStartJST.setHours(0, 0, 0, 0);
        const dayEndJST = new Date(targetDate);
        dayEndJST.setHours(23, 59, 59, 999);

        // 各施術者のイベントを並列取得
        const practitionerEvents = await Promise.all(
            practitioners.map(async (p) => {
                try {
                    const eventsResponse = await calendar.events.list({
                        calendarId: p.calendarId,
                        timeMin: dayStartJST.toISOString(),
                        timeMax: dayEndJST.toISOString(),
                        singleEvents: true,
                        orderBy: 'startTime',
                    });
                    return { practitioner: p, events: eventsResponse.data.items || [] };
                } catch (err) {
                    console.error(`Failed to get events for ${p.name}:`, err.message);
                    return { practitioner: p, events: [] };
                }
            })
        );

        const slots = [];

        // 営業開始〜終了まで30分刻み (JST)
        for (let hour = startHour; hour < endHour; hour++) {
            for (let minute = 0; minute < 60; minute += 30) {
                const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                // JSTでスロットの開始・終了時間を作成
                const slotStart = new Date(targetDate);
                slotStart.setHours(hour, minute, 0, 0);
                const slotEnd = new Date(slotStart.getTime() + (menuMinutes * 60000));

                const now = new Date();
                const closingTime = new Date(targetDate);
                closingTime.setHours(endHour, 0, 0, 0);

                // 過去または営業時間外の場合
                if (slotStart < now) {
                    slots.push({ time: timeStr, status: '-', availablePractitioners: [] });
                    continue;
                }
                if (slotEnd > closingTime) {
                    slots.push({ time: timeStr, status: '×', availablePractitioners: [] });
                    continue;
                }

                // 各施術者の空き状況をチェック
                const availablePractitioners = [];
                for (const { practitioner, events } of practitionerEvents) {
                    let isAvailable = true;
                    for (const event of events) {
                        const eventStart = new Date(event.start.dateTime || event.start.date);
                        const eventEnd = new Date(event.end.dateTime || event.end.date);
                        if (slotStart < eventEnd && slotEnd > eventStart) {
                            isAvailable = false;
                            break;
                        }
                    }
                    if (isAvailable) {
                        availablePractitioners.push({
                            id: practitioner.id,
                            name: practitioner.name,
                            calendarId: practitioner.calendarId
                        });
                    }
                }

                // 誰か空いていれば「⚪︎」、全員埋まっていれば「×」
                const status = availablePractitioners.length > 0 ? '⚪︎' : '×';
                slots.push({ time: timeStr, status: status, availablePractitioners: availablePractitioners });
            }
        }

        result.push({
            date: dateStr,
            day: dayOfWeek,
            slots: slots,
        });
    }

    return result;
}

// 空いている施術者からランダムに1人選択
function selectRandomPractitioner(availablePractitioners) {
    if (!availablePractitioners || availablePractitioners.length === 0) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * availablePractitioners.length);
    return availablePractitioners[randomIndex];
}

module.exports = {
    getWeeklyAvailability,
    getMergedWeeklyAvailability,
    getAvailableSlots,
    checkConflict,
    createEvent,
    deleteEvent,
    selectRandomPractitioner,
};
