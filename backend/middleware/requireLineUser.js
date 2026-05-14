const lineAuth = require('../services/lineAuth');

function unauthorized(res) {
    return res.status(401).json({ status: 'error', message: 'LINE認証が必要です' });
}

function getBearerToken(req) {
    const authorization = req.get('authorization') || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

async function requireLineUser(req, res, next) {
    const token = getBearerToken(req);
    if (!token) {
        return unauthorized(res);
    }

    try {
        const raw = await lineAuth.verifyIdToken(token);
        if (!raw || !raw.sub) {
            return unauthorized(res);
        }

        req.lineUser = {
            lineUserId: raw.sub,
            raw,
        };
        return next();
    } catch (err) {
        console.error('[LINE Auth] ID token verification failed:', err.response?.data || err.message);
        return unauthorized(res);
    }
}

function getRequestLineUserId(req) {
    return req.body?.line_user_id
        || req.body?.lineUserId
        || req.body?.userId
        || req.query?.line_user_id
        || req.query?.lineUserId
        || req.query?.userId
        || '';
}

function rejectMismatchedLineUser(req, res, next) {
    const requestedLineUserId = getRequestLineUserId(req);
    if (requestedLineUserId && requestedLineUserId !== req.lineUser?.lineUserId) {
        return res.status(403).json({
            status: 'error',
            message: '認証済みユーザーとリクエストユーザーが一致しません',
        });
    }

    return next();
}

module.exports = {
    requireLineUser,
    rejectMismatchedLineUser,
    getBearerToken,
    getRequestLineUserId,
};
