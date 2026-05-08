const crypto = require('crypto');
const redisClient = require('../config/redis');

const PREFIX = 'social:cache:';

/** TTL mặc định cache Frappe-heavy (plan: 5 phút) */
const TTL_FRAPPE_DEFAULT_SEC = parseInt(process.env.SOCIAL_CACHE_TTL_SEC || '300', 10) || 300;
/** TTL meta lớp (ít đổi) — 1 giờ */
const TTL_CLASS_META_SEC = parseInt(process.env.SOCIAL_CLASS_META_TTL_SEC || '3600', 10) || 3600;
/** TTL danh sách hội thoại người dùng — 30 giây */
const TTL_CHAT_LIST_SEC = parseInt(process.env.SOCIAL_CHAT_LIST_TTL_SEC || '30', 10) || 30;
/** TTL đếm tin trong hội thoại — 60 giây */
const TTL_MSG_COUNT_SEC = parseInt(process.env.SOCIAL_MSG_COUNT_TTL_SEC || '60', 10) || 60;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function redisAvailable() {
  try {
    return redisClient.isReady();
  } catch {
    return false;
  }
}

async function cacheGetJSON(keySuffix) {
  if (!redisAvailable()) return null;
  try {
    const raw = await redisClient.getClient().get(`${PREFIX}${keySuffix}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[cache] GET fail:', keySuffix, e.message);
    return null;
  }
}

async function cacheSetJSON(keySuffix, obj, ttlSec) {
  if (!redisAvailable()) return;
  try {
    await redisClient.getClient().set(`${PREFIX}${keySuffix}`, JSON.stringify(obj), { EX: ttlSec });
  } catch (e) {
    console.warn('[cache] SET fail:', keySuffix, e.message);
  }
}

async function cacheDel(keySuffix) {
  if (!redisAvailable()) return;
  try {
    await redisClient.getClient().del(`${PREFIX}${keySuffix}`);
  } catch (e) {
    console.warn('[cache] DEL fail:', keySuffix, e.message);
  }
}

async function cacheDelByPattern(patternTail) {
  if (!redisAvailable()) return;
  const client = redisClient.getClient();
  const pattern = `${PREFIX}${patternTail}`;
  try {
    for await (const k of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      await client.del(k);
    }
  } catch (e) {
    console.warn('[cache] scan DEL fail:', pattern, e.message);
  }
}

/**
 * Chuỗi khoá cố định cho cache REST user (TTL 300s trong auth resolver).
 */
function authUserKeyFromToken(token) {
  return `auth:user:${hashToken(token)}`;
}

/** TTL guardian directory đầy đủ (directory nặng) — 10 phút */
const TTL_GUARDIAN_DIRECTORY_SEC =
  parseInt(process.env.SOCIAL_GUARDIAN_DIR_TTL_SEC || '600', 10) || 600;

module.exports = {
  PREFIX,
  TTL_FRAPPE_DEFAULT_SEC,
  TTL_CLASS_META_SEC,
  TTL_CHAT_LIST_SEC,
  TTL_MSG_COUNT_SEC,
  TTL_GUARDIAN_DIRECTORY_SEC,
  hashToken,
  cacheGetJSON,
  cacheSetJSON,
  cacheDel,
  cacheDelByPattern,
  authUserKeyFromToken,
  redisAvailable,
};
