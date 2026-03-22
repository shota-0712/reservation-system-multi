const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

// Google Sheets API クライアントを取得
async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    return google.sheets({ version: 'v4', auth: authClient });
}

// ====================
// メニュー関連
// ====================

async function getMenus() {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'menus!A2:I',  // A:id, B:category, C:name, D:minutes, E:price, F:description, G:imageUrl, H:sortOrder, I:optionIds
    });

    const rows = response.data.values || [];
    const menus = rows.map(row => ({
        id: row[0],
        category: row[1] || '',
        name: row[2],
        minutes: parseInt(row[3]),
        price: row[4],
        description: row[5] || '',
        imageUrl: row[6] || '',
        sortOrder: row[7] ? parseInt(row[7]) : 9999,
        optionIds: row[8] || '',  // オプションID（カンマ区切り）
    }));

    // sortOrderでソート
    return menus.sort((a, b) => a.sortOrder - b.sortOrder);
}

async function addMenu(menuData) {
    const sheets = await getSheetsClient();

    // 既存のメニューを取得して最大IDと最大順序を見つける
    const menus = await getMenus();
    let maxId = 0;
    let maxOrder = 0;
    menus.forEach(menu => {
        const id = parseInt(menu.id);
        if (id > maxId) maxId = id;
        if (menu.sortOrder && menu.sortOrder < 9999 && menu.sortOrder > maxOrder) {
            maxOrder = menu.sortOrder;
        }
    });

    const newId = maxId + 1;
    const newOrder = maxOrder + 1;

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'menus!A:I',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                newId,
                menuData.category || '',
                menuData.name,
                menuData.minutes,
                menuData.price,
                menuData.description || '',
                menuData.imageUrl || '',
                newOrder,
                menuData.optionIds || ''  // オプションID
            ]],
        },
    });

    return { status: 'success', menuId: newId };
}

async function reorderMenus(orderedIds) {
    const sheets = await getSheetsClient();

    // 全データを取得して、IDと行番号のマッピングを作成
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'menus!A2:A', // ID列のみ取得
    });

    const rows = response.data.values || [];
    const idRowMap = new Map(); // ID -> RowIndex (2-based for A2 start, so +2)
    rows.forEach((row, index) => {
        idRowMap.set(String(row[0]), index + 2);
    });

    const requests = [];
    orderedIds.forEach((id, index) => {
        const rowIndex = idRowMap.get(String(id));
        if (rowIndex) {
            // H列(sortOrder)を更新
            requests.push({
                range: `menus!H${rowIndex}`,
                values: [[index + 1]]
            });
        }
    });

    // Batch update is efficient but sheets API value update is per range.
    // batchUpdate with ValueRange is 'spreadsheets.values.batchUpdate'
    if (requests.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: SHEET_ID,
            requestBody: {
                valueInputOption: 'USER_ENTERED',
                data: requests
            }
        });
    }

    return { status: 'success' };
}

async function updateMenu(menuId, menuData) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'menus!A:I',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(menuId)) {
            targetRowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: 'メニューが見つかりませんでした' };
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `menus!B${targetRowIndex}:I${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                menuData.category || '',
                menuData.name,
                menuData.minutes,
                menuData.price,
                menuData.description || '',
                menuData.imageUrl || '',
                rows[targetRowIndex - 1][7] || '',  // sortOrderはそのまま
                menuData.optionIds || ''  // オプションID
            ]],
        },
    });

    return { status: 'success' };
}

async function deleteMenu(menuId) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'menus!A:G',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(menuId)) {
            targetRowIndex = i + 1; // 1-indexed (header is row 1)
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: 'メニューが見つかりませんでした' };
    }

    // 行を削除
    const sheetId = await getSheetId('menus');
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheetId,
                        dimension: 'ROWS',
                        startIndex: targetRowIndex - 1, // 0-indexed
                        endIndex: targetRowIndex,
                    },
                },
            }],
        },
    });

    return { status: 'success' };
}

// シートIDを取得するヘルパー
async function getSheetId(sheetName) {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.get({
        spreadsheetId: SHEET_ID,
    });

    const sheet = response.data.sheets.find(s => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : null;
}

// ====================
// 予約関連
// ====================

async function getUserReservations(userId) {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:P',  // A-P列まで読み取り（P:電話番号）
    });

    const rows = response.data.values || [];
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    const history = [];
    for (const row of rows) {
        const rowDate = new Date(row[5]);
        if (row[2] === userId && row[7] === 'reserved' && rowDate >= now) {
            history.push({
                id: row[0],
                menu: row[4],
                date: row[5],
                time: row[6],
                practitionerId: row[9] || '',
                practitionerName: row[10] || '',
                optionIds: row[11] || '',
                optionNames: row[12] || '',
                totalMinutes: row[13] ? parseInt(row[13]) : null,
                totalPrice: row[14] ? parseInt(row[14]) : null,
                phone: row[15] || '',  // P: 電話番号
            });
        }
    }

    return history;
}

async function getAllReservations() {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:P',  // A-P列まで読み取り（P:電話番号）
    });

    const rows = response.data.values || [];
    const reservations = rows.map(row => ({
        id: row[0],
        timestamp: row[1],
        lineId: row[2],
        name: row[3],
        menu: row[4],
        date: row[5],
        time: row[6],
        status: row[7],
        calEventId: row[8],
        practitionerId: row[9] || '',
        practitionerName: row[10] || '',
        optionIds: row[11] || '',        // L: オプションID（カンマ区切り）
        optionNames: row[12] || '',      // M: オプション名（カンマ区切り）
        totalMinutes: row[13] ? parseInt(row[13]) : null,  // N: 合計時間
        totalPrice: row[14] ? parseInt(row[14]) : null,    // O: 合計料金
        phone: row[15] || '',            // P: 電話番号
    }));

    // 日付順でソート（新しい順）
    reservations.sort((a, b) => {
        const dateA = new Date(`${a.date} ${a.time}`);
        const dateB = new Date(`${b.date} ${b.time}`);
        return dateB - dateA;
    });

    return reservations;
}

async function addReservation(data) {
    const sheets = await getSheetsClient();

    // オプション情報を準備
    const optionIds = data.selectedOptions ? data.selectedOptions.map(o => o.id).join(',') : '';
    const optionNames = data.selectedOptions ? data.selectedOptions.map(o => o.name).join(',') : '';

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A:P',  // A-P列まで拡張 (P:電話番号)
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                uuidv4(),
                new Date().toISOString(),
                data.userId,
                data.name,
                data.menu.name,
                data.date,
                data.time,
                'reserved',
                data.eventId,
                data.practitionerId || '',
                data.practitionerName || '',
                optionIds,                    // L: option IDs
                optionNames,                  // M: option Names
                data.totalMinutes || data.menu.minutes,  // N: 合計施術時間
                data.totalPrice || data.menu.price,      // O: 合計料金
                data.phone || '',                        // P: 電話番号
            ]],
        },
    });

    return { status: 'success' };
}

async function getReservationById(reservationId, userId) {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:P',  // P列（電話番号）まで拡張
    });

    const rows = response.data.values || [];
    for (const row of rows) {
        if (row[0] === reservationId && row[2] === userId) {
            return {
                id: row[0],
                name: row[3],
                menu: row[4],
                date: row[5],
                time: row[6],
                status: row[7],
                eventId: row[8],
                practitionerId: row[9] || '',
                practitionerName: row[10] || '',
                optionIds: row[11] || '',
                optionNames: row[12] || '',
                totalMinutes: row[13] ? parseInt(row[13]) : null,
                totalPrice: row[14] ? parseInt(row[14]) : null,
                phone: row[15] || '',
            };
        }
    }

    return null;
}

// 管理者用: userIdに関係なく予約を取得
async function getReservationByIdForAdmin(reservationId) {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:P',  // P列（電話番号）まで拡張
    });

    const rows = response.data.values || [];
    for (const row of rows) {
        if (row[0] === reservationId) {
            return {
                id: row[0],
                lineId: row[2],
                name: row[3],
                menu: row[4],
                date: row[5],
                time: row[6],
                status: row[7],
                eventId: row[8],
                practitionerId: row[9] || '',
                practitionerName: row[10] || '',
                optionIds: row[11] || '',
                optionNames: row[12] || '',
                totalMinutes: row[13] ? parseInt(row[13]) : 0,
                totalPrice: row[14] ? parseInt(row[14]) : 0,
                phone: row[15] || '',
            };
        }
    }
    return null;
}

async function getTomorrowReservations() {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:I',
    });

    const rows = response.data.values || [];

    // 明日の日付を取得 (JST)
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).split('/').join('-');

    const targets = [];
    for (const row of rows) {
        // row[5] is date (YYYY-MM-DD), row[7] is status ('reserved')
        if (row[5] === tomorrowStr && row[7] === 'reserved') {
            targets.push({
                lineId: row[2],
                name: row[3],
                menu: row[4],
                date: row[5],
                time: row[6],
            });
        }
    }

    return targets;
}

async function cancelReservation(reservationId) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A:I',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] === reservationId) {
            targetRowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: '予約が見つかりませんでした' };
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `reservations!H${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [['canceled']],
        },
    });

    return { status: 'success' };
}

async function updateReservation(reservationId, userId, updateData) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'reservations!A2:P',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;
    let originalReservation = null;

    for (let i = 0; i < rows.length; i++) {
        if (rows[i][0] === reservationId && rows[i][2] === userId) {
            targetRowIndex = i + 2; // 1-indexed + header
            originalReservation = {
                id: rows[i][0],
                name: rows[i][3],
                menu: rows[i][4],
                date: rows[i][5],
                time: rows[i][6],
                eventId: rows[i][8],
                practitionerId: rows[i][9] || '',
                practitionerName: rows[i][10] || '',
                optionIds: rows[i][11] || '',
                optionNames: rows[i][12] || '',
                totalMinutes: rows[i][13] ? parseInt(rows[i][13]) : null,
                totalPrice: rows[i][14] ? parseInt(rows[i][14]) : null,
                phone: rows[i][15] || '',
            };
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: '予約が見つかりません' };
    }

    // E列(menu), F列(date), G列(time), I列(eventId), J列(practitionerId), K列(practitionerName),
    // L列(optionIds), M列(optionNames), N列(totalMinutes), O列(totalPrice)を更新
    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: [
                { range: `reservations!E${targetRowIndex}`, values: [[updateData.menu]] },
                { range: `reservations!F${targetRowIndex}`, values: [[updateData.date]] },
                { range: `reservations!G${targetRowIndex}`, values: [[updateData.time]] },
                { range: `reservations!I${targetRowIndex}`, values: [[updateData.eventId]] },
                { range: `reservations!J${targetRowIndex}`, values: [[updateData.practitionerId]] },
                { range: `reservations!K${targetRowIndex}`, values: [[updateData.practitionerName]] },
                { range: `reservations!L${targetRowIndex}`, values: [[updateData.optionIds || '']] },
                { range: `reservations!M${targetRowIndex}`, values: [[updateData.optionNames || '']] },
                { range: `reservations!N${targetRowIndex}`, values: [[updateData.totalMinutes]] },
                { range: `reservations!O${targetRowIndex}`, values: [[updateData.totalPrice]] },
                // data.phone が undefined の場合は更新しない（API側で渡さない場合があるため）
                ...(updateData.phone !== undefined ? [{ range: `reservations!P${targetRowIndex}`, values: [[updateData.phone]] }] : []),
            ]
        }
    });

    return { status: 'success', originalReservation };
}

module.exports = {
    getMenus,
    addMenu,
    updateMenu,
    deleteMenu,
    reorderMenus,
    getUserReservations,
    getAllReservations,
    addReservation,
    getReservationById,
    getReservationByIdForAdmin,
    cancelReservation,
    updateReservation,
    getTomorrowReservations,
    // 施術者関連
    getPractitioners,
    getPractitionerById,
    addPractitioner,
    updatePractitioner,
    deletePractitioner,
    // 設定関連
    getSettings,
    updateSettings,
    // オプション関連
    getOptions,
    addOption,
    updateOption,
    deleteOption,
};

// ====================
// 設定関連 (settings sheet)
// ====================

async function getSettings() {
    const sheets = await getSheetsClient();
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'settings!A2:B',  // A:key, B:value
        });

        const rows = response.data.values || [];
        const settings = {};
        rows.forEach(row => {
            if (row[0]) {
                const key = row[0].trim();
                settings[key] = row[1] || '';
            }
        });
        return settings;
    } catch (err) {
        // settings シートが存在しない場合は空オブジェクトを返す
        console.log('Settings sheet not found, returning empty settings');
        return {};
    }
}

async function updateSettings(settingsData) {
    const sheets = await getSheetsClient();
    console.log('[Debug] updateSettings called with:', JSON.stringify(settingsData, null, 2));

    // 設定データを配列形式に変換 (オブジェクトや配列はJSON文字列にする)
    const values = Object.entries(settingsData).map(([key, value]) => {
        const stringValue = (typeof value === 'object' && value !== null) ? JSON.stringify(value) : String(value);
        return [key, stringValue];
    });
    console.log('[Debug] Transformed values for update:', JSON.stringify(values, null, 2));

    // まずヘッダー行を設定
    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'settings!A1:B1',
        valueInputOption: 'RAW',
        requestBody: {
            values: [['key', 'value']]
        }
    });

    // 既存データをクリアして新しいデータを書き込む
    await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: 'settings!A2:B',
    });

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'settings!A2:B',
        valueInputOption: 'RAW',
        requestBody: {
            values: values.length > 0 ? values : [[]]
        }
    });

    return { status: 'success' };
}

// ====================
// 施術者関連
// ====================

async function getPractitioners() {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'practitioners!A2:K',  // A:id, B:name, C:calendarId, D:imageUrl, E:active, F:title, G:sns, H:experience, I:nominationFee, J:prTitle, K:description
    });

    const rows = response.data.values || [];
    return rows
        .filter(row => row[4] !== 'FALSE')  // active が FALSE でないものだけ
        .map(row => ({
            id: row[0],
            name: row[1] || '',
            calendarId: row[2] || '',
            imageUrl: row[3] || '',
            active: row[4] !== 'FALSE',
            title: row[5] || '',           // 役職/肩書き
            sns: row[6] || '',             // SNS/Instagram
            experience: row[7] || '',       // 経歴
            nominationFee: row[8] || '',    // 指名料
            prTitle: row[9] || '',          // PRタイトル
            description: row[10] || '',     // 詳細コメント
        }));
}

async function getPractitionerById(practitionerId) {
    const sheets = await getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'practitioners!A2:K',
    });

    const rows = response.data.values || [];
    for (const row of rows) {
        if (String(row[0]) === String(practitionerId)) {
            return {
                id: row[0],
                name: row[1] || '',
                calendarId: row[2] || '',
                imageUrl: row[3] || '',
                active: row[4] !== 'FALSE',
                title: row[5] || '',           // 役職/肩書き
                sns: row[6] || '',             // SNS/Instagram
                experience: row[7] || '',       // 経歴
                nominationFee: row[8] || '',    // 指名料
                prTitle: row[9] || '',          // PRタイトル
                description: row[10] || '',     // 詳細コメント
            };
        }
    }
    return null;
}

async function addPractitioner(data) {
    const sheets = await getSheetsClient();

    // 既存の施術者を取得して最大IDを見つける
    const practitioners = await getPractitioners();
    let maxId = 0;
    practitioners.forEach(p => {
        const id = parseInt(p.id);
        if (id > maxId) maxId = id;
    });
    const newId = maxId + 1;

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'practitioners!A:K',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                newId,
                data.name,
                data.calendarId,
                data.imageUrl || '',
                'TRUE',
                data.title || '',           // 役職/肩書き
                data.sns || '',             // SNS/Instagram
                data.experience || '',       // 経歴
                data.nominationFee || '',    // 指名料
                data.prTitle || '',          // PRタイトル
                data.description || '',      // 詳細コメント
            ]],
        },
    });

    return { status: 'success', practitionerId: newId };
}

async function updatePractitioner(practitionerId, data) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'practitioners!A:K',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(practitionerId)) {
            targetRowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: '施術者が見つかりませんでした' };
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `practitioners!B${targetRowIndex}:K${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                data.name,
                data.calendarId,
                data.imageUrl || '',
                data.active !== false ? 'TRUE' : 'FALSE',
                data.title || '',           // 役職/肩書き
                data.sns || '',             // SNS/Instagram
                data.experience || '',       // 経歴
                data.nominationFee || '',    // 指名料
                data.prTitle || '',          // PRタイトル
                data.description || '',      // 詳細コメント
            ]],
        },
    });

    return { status: 'success' };
}

async function deletePractitioner(practitionerId) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'practitioners!A:K',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(practitionerId)) {
            targetRowIndex = i + 1;
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: '施術者が見つかりませんでした' };
    }

    // 行を削除
    const sheetId = await getSheetId('practitioners');
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheetId,
                        dimension: 'ROWS',
                        startIndex: targetRowIndex - 1,
                        endIndex: targetRowIndex,
                    },
                },
            }],
        },
    });

    return { status: 'success' };
}

// ====================
// オプション関連
// ====================

async function getOptions() {
    const sheets = await getSheetsClient();
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'options!A2:F',  // A:id, B:name, C:minutes, D:price, E:description, F:isActive
        });

        const rows = response.data.values || [];
        return rows
            .map(row => ({
                id: row[0],
                name: row[1],
                minutes: parseInt(row[2]) || 0,
                price: parseInt(row[3]) || 0,
                description: row[4] || '',
                isActive: row[5] !== 'FALSE',  // デフォルトはtrue
            }))
            .filter(opt => opt.isActive);  // アクティブなもののみ返す
    } catch (err) {
        console.log('Options sheet not found or error:', err.message);
        return [];
    }
}

async function addOption(optionData) {
    const sheets = await getSheetsClient();

    // 既存のオプションを取得して最大IDを見つける
    let maxId = 0;
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'options!A:A',
        });
        const rows = response.data.values || [];
        for (let i = 1; i < rows.length; i++) {
            const id = parseInt(rows[i][0]);
            if (id > maxId) maxId = id;
        }
    } catch (err) {
        console.log('Options sheet not found, will create:', err.message);
    }
    const newId = maxId + 1;

    await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'options!A:F',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                newId,
                optionData.name,
                optionData.minutes || 0,
                optionData.price || 0,
                optionData.description || '',
                'TRUE',
            ]],
        },
    });

    return { status: 'success', optionId: newId };
}

async function updateOption(optionId, optionData) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'options!A:F',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(optionId)) {
            targetRowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: 'オプションが見つかりませんでした' };
    }

    await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `options!B${targetRowIndex}:F${targetRowIndex}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
            values: [[
                optionData.name,
                optionData.minutes || 0,
                optionData.price || 0,
                optionData.description || '',
                optionData.isActive !== false ? 'TRUE' : 'FALSE',
            ]],
        },
    });

    return { status: 'success' };
}

async function deleteOption(optionId) {
    const sheets = await getSheetsClient();

    // 対象行を見つける
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: 'options!A:F',
    });

    const rows = response.data.values || [];
    let targetRowIndex = -1;

    for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]) === String(optionId)) {
            targetRowIndex = i + 1; // 1-indexed
            break;
        }
    }

    if (targetRowIndex === -1) {
        return { status: 'error', message: 'オプションが見つかりませんでした' };
    }

    // 行を削除
    const sheetId = await getSheetId('options');
    await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheetId,
                        dimension: 'ROWS',
                        startIndex: targetRowIndex - 1, // 0-indexed
                        endIndex: targetRowIndex,
                    },
                },
            }],
        },
    });

    return { status: 'success' };
}
