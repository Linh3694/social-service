const jwt = require('jsonwebtoken');
const User = require('../models/User');
const frappeService = require('../services/frappeService');
const {
  cacheGetJSON,
  cacheSetJSON,
  cacheDel,
  authUserKeyFromToken,
  redisAvailable,
} = require('./cache');

/** TTL cache auth REST/socket (5 phút — đồng bộ plan medium) */
const AUTH_CACHE_TTL_SEC = parseInt(process.env.SOCIAL_AUTH_CACHE_TTL_SEC || '300', 10) || 300;

const USER_SELECT =
  'fullname fullName email role roles department avatarUrl user_image sis_photo guardian_image guardian_id';

/** Deduplica hai lần resolve cùng token trong handshake Socket.IO */
const socketResolveInflight = new Map();

/** Đuôi email tài khoản PHHS đăng nhập parent portal. */
const PARENT_PORTAL_EMAIL_SUFFIX = '@parent.wellspring.edu.vn';

/**
 * Điền `guardian_id` cho doc PHHS còn thiếu, suy từ email portal.
 *
 * ERP tạo account PH bằng email tổng hợp `{guardian_id}@parent.wellspring.edu.vn`
 * (erp/api/parent_portal/otp_auth.py) nên localpart CHÍNH LÀ guardian_id — cùng value space
 * với field guardian_id. Không dùng claim `guardian` của JWT: claim đó là tên doc
 * (`CRM-GUARDIAN-…`), khác value space, ghi vào sẽ làm lệch mọi phép khớp participants.
 *
 * Không phụ thuộc Frappe nên vẫn chữa được doc lỗi khi SIS đang chết.
 */
async function backfillGuardianLink(userDoc) {
  if (!userDoc || userDoc.guardian_id) return userDoc;
  const email = String(userDoc.email || '').trim().toLowerCase();
  if (!email.endsWith(PARENT_PORTAL_EMAIL_SUFFIX)) return userDoc;
  const guardianId = email.slice(0, -PARENT_PORTAL_EMAIL_SUFFIX.length);
  if (!guardianId) return userDoc;
  try {
    await User.updateOne({ _id: userDoc._id }, { $set: { guardian_id: guardianId } });
    userDoc.guardian_id = guardianId;
  } catch {
    // Ghi thất bại thì thôi — không chặn đăng nhập.
  }
  return userDoc;
}

/**
 * Chuẩn hoá JWT local + Parent Portal secret.
 */
function verifyJwtFlexible(token) {
  let decoded = null;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    try {
      decoded = jwt.verify(
        token,
        process.env.PARENT_PORTAL_JWT_SECRET || process.env.JWT_SECRET
      );
    } catch {
      decoded = null;
    }
  }
  return decoded;
}

async function loadUserFromDecoded(decoded) {
  if (!decoded) return null;
  const userEmail = decoded.sub || decoded.email;
  let user = null;
  try {
    if (userEmail) {
      user = await User.findOne({ email: userEmail }).select(USER_SELECT);
    }
    if (!user && decoded.id) {
      user = await User.findById(decoded.id).select(USER_SELECT);
    }
  } catch {
    user = null;
  }
  return user;
}

async function persistAuthCache(token, userDoc) {
  if (!redisAvailable() || !userDoc || !userDoc._id) return;
  const plain = userDoc.toObject ? userDoc.toObject() : userDoc;
  const payload = {
    _id: String(plain._id),
    fullname: plain.fullname || plain.fullName,
    fullName: plain.fullName,
    email: plain.email,
    role: plain.role,
    roles: plain.roles || [],
    department: plain.department,
    avatarUrl: plain.avatarUrl,
    user_image: plain.user_image,
    sis_photo: plain.sis_photo,
    guardian_image: plain.guardian_image,
    guardian_id: plain.guardian_id,
  };
  await cacheSetJSON(authUserKeyFromToken(token), payload, AUTH_CACHE_TTL_SEC);
}

async function hydrateUserFromRedisCache(token) {
  const cached = await cacheGetJSON(authUserKeyFromToken(token));
  if (!cached?._id) return null;
  const u = await User.findById(cached._id).select(USER_SELECT);
  return u || null;
}

/**
 * Resolve user đã authenticate (Mongo document) — dùng chung middleware HTTP + handshake socket.
 *
 * @param {string} token Bearer token đầy đủ (không bỏ "Bearer ")
 * @param {{ forceRefresh?: boolean }} opts forceRefresh ⇒ xoá cache + buộc gọi Frappe khi không đủ dữ liệu local.
 * @returns {Promise<import('mongoose').Document>}
 */
async function resolveAuthenticatedUser(token, opts = {}) {
  const { forceRefresh = false } = opts;
  const key = authUserKeyFromToken(token);

  if (forceRefresh) {
    await cacheDel(key);
  }

  // Decode TRƯỚC khi đọc cache: claim `guardian` là tín hiệu duy nhất đáng tin để biết đây là
  // token parent portal. Nếu chỉ kiểm sau cache thì doc PH thiếu guardian_id vẫn được trả về
  // suốt TTL và PH tiếp tục bị xếp thành GV.
  const decoded = verifyJwtFlexible(token);
  if (!decoded) {
    const err = new Error('Invalid token');
    err.statusCode = 401;
    throw err;
  }
  const isParentPortalToken = Boolean(decoded.guardian);

  if (!forceRefresh) {
    const fromRedis = await hydrateUserFromRedisCache(token);
    if (fromRedis && !(isParentPortalToken && !fromRedis.guardian_id)) {
      await persistAuthCache(token, fromRedis);
      return fromRedis;
    }
  }

  let user = await loadUserFromDecoded(decoded);

  // Token parent portal mà doc Mongo không có guardian_id ⇒ doc do luồng sync user ghi
  // (roles ['Parent','Guardian'], không mang guardian_id). Điều kiện needFrappe cũ bỏ qua vì
  // roles không rỗng, nên doc bị đóng băng vĩnh viễn: userRole() xếp PH này thành GV rồi mọi
  // read-path lớp trả 403.
  const missingGuardianLink = isParentPortalToken && !user?.guardian_id;

  const needFrappe =
    forceRefresh ||
    !user ||
    !user.roles ||
    user.roles.length === 0 ||
    missingGuardianLink;

  if (!needFrappe && user) {
    await persistAuthCache(token, user);
    return user;
  }

  try {
    let frappeUser;
    try {
      if (isParentPortalToken) {
        frappeUser = await frappeService.authenticateParentGuardian(token);
      } else {
        frappeUser = await frappeService.authenticateUser(token);
      }
    } catch {
      frappeUser = await frappeService.authenticateParentGuardian(token);
    }

    if (!frappeUser && !isParentPortalToken) {
      frappeUser = await frappeService.authenticateUser(token);
    }
    if (!isParentPortalToken && frappeUser && (!frappeUser.roles || frappeUser.roles.length === 0)) {
      const userEmail = frappeUser.email || frappeUser.name;
      const userDetail = await frappeService.getUserDetail(userEmail, token);
      if (userDetail?.roles?.length) {
        frappeUser.roles = userDetail.roles;
      }
    }
    user = await User.updateFromFrappe(frappeUser);
    if (!user) {
      const err = new Error('Frappe user not found');
      err.statusCode = 401;
      throw err;
    }
    // Guardian record bên Frappe có thể thiếu `guardian_id` ⇒ doc vẫn không có liên kết và PH
    // lại bị xếp thành GV. Chốt lại bằng email portal.
    user = await backfillGuardianLink(user);
    await persistAuthCache(token, user);
    return user;
  } catch (e) {
    // SIS lỗi/timeout: nếu chỉ vào đây vì thiếu liên kết guardian thì vẫn cho đăng nhập bằng doc
    // local — trước khi có nhánh missingGuardianLink, PH không phụ thuộc SIS ở bước này, không
    // được để bản sửa biến sự cố SIS thành sự cố đăng nhập. Backfill từ email vẫn chạy được.
    if (user && missingGuardianLink) {
      user = await backfillGuardianLink(user);
      await persistAuthCache(token, user);
      return user;
    }
    const err = e.statusCode ? e : Object.assign(e, { statusCode: 401 });
    throw err;
  }
}

function toReqUserShape(userDoc) {
  const u = userDoc.toObject ? userDoc.toObject() : userDoc;
  return {
    _id: u._id,
    fullname: u.fullname || u.fullName,
    email: u.email,
    role: u.role,
    roles: u.roles || [],
    department: u.department,
    avatarUrl: u.avatarUrl,
    user_image: u.user_image,
    sis_photo: u.sis_photo,
    guardian_image: u.guardian_image,
    guardian_id: u.guardian_id,
  };
}

/**
 * Phiên bản cho Socket: không throw, không log stack; dedupe handshake gọi 2 lần.
 */
async function resolveSocketUser(token) {
  if (!token) return null;
  if (socketResolveInflight.has(token)) return socketResolveInflight.get(token);
  const promise = resolveAuthenticatedUser(token, {})
    .catch(() => null)
    .finally(() => socketResolveInflight.delete(token));
  socketResolveInflight.set(token, promise);
  return promise;
}

async function invalidateAuthCacheForToken(token) {
  if (!token) return;
  await cacheDel(authUserKeyFromToken(token));
}

module.exports = {
  AUTH_CACHE_TTL_SEC,
  verifyJwtFlexible,
  resolveAuthenticatedUser,
  resolveSocketUser,
  toReqUserShape,
  invalidateAuthCacheForToken,
  persistAuthCache,
};
