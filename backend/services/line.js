const axios = require('axios');

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_API_URL = 'https://api.line.me/v2/bot/message/push';

/**
 * LINEにプッシュメッセージを送信
 * @param {string} userId - 送信先のLINE User ID
 * @param {string} text - メッセージ本文
 */
async function pushMessage(userId, text) {
    if (!LINE_ACCESS_TOKEN || LINE_ACCESS_TOKEN === 'your_line_channel_access_token_here') {
        console.log('[LINE] Skipping push message (no access token configured)');
        console.log('[LINE] Would send to:', userId);
        console.log('[LINE] Message:', text.substring(0, 100) + '...');
        return;
    }

    try {
        await axios.post(LINE_API_URL, {
            to: userId,
            messages: [{ type: 'text', text: text }],
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`,
            },
        });
        console.log('[LINE] Message sent successfully to:', userId);
    } catch (err) {
        console.error('[LINE] Failed to send message:', err.response?.data || err.message);
        // エラーでも処理は続行（予約自体は成功させる）
    }
}

module.exports = {
    pushMessage,
};
