/**
 * Resolve danh sách email người nhận cho notify broadcast / lớp — chỉ đọc ERP/Mongo, không gọi webhook Frappe.
 * Lazy-require frappeService để tránh vòng phụ thuộc với notificationDispatcher.
 */
const User = require('../models/User');
const { cacheGetJSON, cacheSetJSON } = require('./cache');

// TTL cache ngắn tránh spam resolve khi nhiều tin liên tiếp (giây)
const TTL_NOTIFY_RECIPIENTS_SEC = parseInt(process.env.SOCIAL_NOTIFY_RECIPIENTS_CACHE_SEC || '60', 10) || 60;
const CACHE_BROADCAST_KEY = 'notify:recipients:broadcast:all';
const CACHE_CLASS_PREFIX = 'notify:recipients:class:';

/**
 * Chuẩn hoá email một chuỗi
 * @param {string} v
 */
function oneEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return e.includes('@') ? e : '';
}

/**
 * Danh sách email PH (guardian) trong lớp — ưu tiên Bearer của người đăng (GV/BOD), fallback API key service.
 * @param {string} classId
 * @param {string} [schoolYearId]
 * @param {string} [bearerToken]
 * @returns {Promise<string[]>}
 */
async function resolveClassRecipients(classId, schoolYearId, bearerToken) {
  const cid = String(classId || '').trim();
  if (!cid) return [];

  const sy = schoolYearId != null ? String(schoolYearId).trim() : '';
  const cacheKey = `${CACHE_CLASS_PREFIX}${encodeURIComponent(cid)}:${encodeURIComponent(sy || '_')}`;
  const cached = await cacheGetJSON(cacheKey);
  if (Array.isArray(cached)) return cached;

  const frappeService = require('../services/frappeService');
  const hdr = bearerToken && typeof bearerToken === 'string' ? bearerToken : null;
  let dir = null;
  try {
    dir = await frappeService.getClassGuardianDirectory(cid, sy || undefined, hdr);
  } catch (e) {
    console.warn('[recipientResolver] getClassGuardianDirectory lỗi (token):', e?.response?.status || e.message);
    if (hdr) {
      try {
        dir = await frappeService.getClassGuardianDirectory(cid, sy || undefined, null);
      } catch (e2) {
        console.warn('[recipientResolver] getClassGuardianDirectory lỗi (service key):', e2?.response?.status || e2.message);
      }
    }
  }
  const seen = new Set();
  const emails = [];
  for (const g of dir?.guardians || []) {
    const raw = g.email || g.portalEmail;
    const e = oneEmail(raw);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    emails.push(e);
  }

  await cacheSetJSON(cacheKey, emails, TTL_NOTIFY_RECIPIENTS_SEC);
  return emails;
}

/**
 * Broadcast toàn trường: ưu tiên User Mongo đã sync; fallback getAllEnabledUsers (Bearer của người đăng → API key).
 * @param {string} [bearerToken]
 * @returns {Promise<string[]>}
 */
async function resolveSchoolWideRecipients(bearerToken) {
  const cached = await cacheGetJSON(CACHE_BROADCAST_KEY);
  if (Array.isArray(cached)) return cached;

  const seen = new Set();
  /** @type {string[]} */
  let emails = [];

  try {
    const users = await User.find({
      active: true,
      $or: [{ disabled: { $ne: true } }, { disabled: { $exists: false } }],
    })
      .select('email')
      .lean();

    for (const u of users) {
      const e = oneEmail(u.email);
      if (!e || seen.has(e)) continue;
      seen.add(e);
      emails.push(e);
    }
  } catch (e) {
    console.warn('[recipientResolver] Mongo User query lỗi:', e.message);
  }

  if (emails.length === 0) {
    try {
      const frappeService = require('../services/frappeService');
      const tok = bearerToken && typeof bearerToken === 'string' ? bearerToken : null;
      const frappeUsers = await frappeService.getAllEnabledUsers(tok);
      for (const fu of frappeUsers || []) {
        const e = oneEmail(fu.email || fu.name);
        if (!e || seen.has(e)) continue;
        seen.add(e);
        emails.push(e);
      }
    } catch (e) {
      console.warn('[recipientResolver] Fallback getAllEnabledUsers lỗi:', e.message);
    }
  }

  await cacheSetJSON(CACHE_BROADCAST_KEY, emails, TTL_NOTIFY_RECIPIENTS_SEC);
  return emails;
}

module.exports = {
  resolveClassRecipients,
  resolveSchoolWideRecipients,
  oneEmail,
};
