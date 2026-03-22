const { Storage } = require('@google-cloud/storage');

const BUCKET_NAME = process.env.GCS_BUCKET_NAME || `${process.env.GCP_PROJECT_ID || 'reservation-system-template'}-images`;

// Google Cloud Storage クライアント
const storage = new Storage();

/**
 * Base64画像データをGoogle Cloud Storageにアップロード
 * @param {string} imageData - Base64エンコードされた画像データ (data:image/...;base64,... 形式)
 * @param {string} fileName - ファイル名
 * @returns {Object} - { status, imageUrl } or { status, code, message }
 */
async function uploadImage(imageData, fileName) {
    // Base64データを解析
    const match = imageData.match(/data:([^;]+);base64,(.+)/);
    if (!match) {
        return { status: 'error', code: 'E004', message: '[E004] 画像フォーマットが不正です' };
    }

    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, 'base64');

    // ユニークなファイル名を生成
    const timestamp = Date.now();
    const uniqueFileName = `menu-images/${timestamp}_${fileName}`;

    try {
        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(uniqueFileName);

        // ファイルをアップロード (bucket has uniform access, no per-object ACL)
        await file.save(buffer, {
            metadata: {
                contentType: mimeType,
            },
            // Note: public access is controlled at bucket level via IAM
        });

        // 公開URLを生成
        const imageUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${uniqueFileName}`;

        return { status: 'success', imageUrl: imageUrl };
    } catch (err) {
        console.error('[GCS] Upload error:', err.message);
        return { status: 'error', code: 'E006', message: '[E006] ' + err.message };
    }
}

module.exports = {
    uploadImage,
};
