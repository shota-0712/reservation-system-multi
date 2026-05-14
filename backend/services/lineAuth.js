const axios = require('axios');

const LINE_ID_TOKEN_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

async function verifyIdToken(idToken) {
    const clientId = process.env.LINE_CHANNEL_ID;
    if (!clientId) {
        const err = new Error('LINE_CHANNEL_ID is not configured');
        err.code = 'LINE_CHANNEL_ID_MISSING';
        throw err;
    }

    const body = new URLSearchParams({
        id_token: idToken,
        client_id: clientId,
    });

    const response = await axios.post(LINE_ID_TOKEN_VERIFY_URL, body.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    return response.data;
}

module.exports = {
    LINE_ID_TOKEN_VERIFY_URL,
    verifyIdToken,
};
