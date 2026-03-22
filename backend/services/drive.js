const { google } = require('googleapis');

const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

// Google Drive API クライアントを取得
async function getDriveClient() {
    const auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const authClient = await auth.getClient();
    return google.drive({ version: 'v3', auth: authClient });
}

/**
 * Base64画像データをGoogle Driveにアップロード
 * @param {string} imageData - Base64エンコードされた画像データ (data:image/...;base64,... 形式)
 * @param {string} fileName - ファイル名
 * @returns {Object} - { status, imageUrl } or { status, code, message }
 */
async function uploadImage(imageData, fileName) {
    if (!FOLDER_ID) {
        return { status: 'error', code: 'E002', message: '[E002] GOOGLE_DRIVE_FOLDER_ID が設定されていません' };
    }

    // Base64データを解析
    const match = imageData.match(/data:([^;]+);base64,(.+)/);
    if (!match) {
        return { status: 'error', code: 'E004', message: '[E004] 画像フォーマットが不正です' };
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');

    try {
        const drive = await getDriveClient();

        // ファイルをアップロード (supportsAllDrives for shared drive support)
        const response = await drive.files.create({
            requestBody: {
                name: fileName,
                parents: [FOLDER_ID],
            },
            media: {
                mimeType: mimeType,
                body: require('stream').Readable.from(buffer),
            },
            fields: 'id',
            supportsAllDrives: true,  // 共有ドライブサポートを有効化
        });

        const fileId = response.data.id;

        // 公開設定
        await drive.permissions.create({
            fileId: fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
            supportsAllDrives: true,  // 共有ドライブサポートを有効化
        });

        // 公開URLを生成
        const imageUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;

        return { status: 'success', imageUrl: imageUrl };
    } catch (err) {
        console.error('[Drive] Upload error:', err.message);
        return { status: 'error', code: 'E006', message: '[E006] ' + err.message };
    }
}

module.exports = {
    uploadImage,
};
