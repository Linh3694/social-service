/**
 * Ánh xạ giá trị lưu trong DB → object path trên CDN.
 *
 * Nguyên tắc migration (CDN-Design.md §9): KHÔNG sửa DB trước. Dữ liệu cũ được
 * `mc mirror` sang prefix `legacy/` giữ nguyên tên file, nên ánh xạ là thuần
 * tất định — không cần bảng tra, và tắt `CDN_ENABLED` là quay lại ngay.
 */

const { config } = require('./config');
const { CDN_SCHEME } = require('./sign');

/** Prefix object path được phép lấy từ URL công khai media.* */
const MEDIA_PATH_RE = /^\/(social-posts|social-chat|social-avatars)\/(.+)$/;

/**
 * Bóc object path từ URL đã ký của media.wellspring.edu.vn.
 * Host khác hoặc path lạ → null (giữ nguyên, không ký nhầm).
 */
function pathFromMediaPublicUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = (config.publicUrl && (() => {
    try { return new URL(config.publicUrl).host; } catch { return ''; }
  })()) || 'media.wellspring.edu.vn';
  if (parsed.host !== host) return null;
  const pathname = decodeURIComponent(parsed.pathname || '');
  const m = pathname.match(MEDIA_PATH_RE);
  if (!m) return null;
  const rest = m[2];
  if (!rest || rest.includes('..')) return null;
  return `/${m[1]}/${rest}`;
}

/**
 * Chuẩn hoá giá trị media về khoá `cdn://…` trước khi ghi DB.
 * Nhận cdn://, URL media đã ký, hoặc để null nếu không phải media CDN.
 */
function toStoredKey(stored) {
  if (typeof stored !== 'string') return null;
  const v = stored.trim();
  if (!v) return null;
  if (v.startsWith(CDN_SCHEME)) {
    const key = v.slice(CDN_SCHEME.length).replace(/^\/+/, '').split('?')[0];
    return key && !key.includes('..') ? `${CDN_SCHEME}${key}` : null;
  }
  const path = pathFromMediaPublicUrl(v);
  if (!path) return null;
  return `${CDN_SCHEME}${path.slice(1)}`;
}

/**
 * @param {unknown} stored
 * @returns {string|null} đường dẫn bắt đầu bằng "/", hoặc null nếu không ánh xạ được
 */
function toObjectPath(stored) {
  if (typeof stored !== 'string') return null;
  const v = stored.trim();
  if (!v) return null;

  // Khoá CDN mới
  if (v.startsWith(CDN_SCHEME)) {
    const key = v.slice(CDN_SCHEME.length).replace(/^\/+/, '');
    return key ? `/${key}` : null;
  }

  // URL đã ký của chính CDN (lỡ bị ghi vào DB khi client edit/echo).
  // Bóc path → ký lại mỗi response; URL host khác vẫn để nguyên.
  if (v.startsWith('http://') || v.startsWith('https://')) {
    return pathFromMediaPublicUrl(v);
  }

  // Avatar của Frappe: `/files/Avatar/<tên>.<ext>` → `<prefix>/<tên>.webp`
  //
  // Ánh xạ chỉ đổi phần mở rộng nên là hàm thuần — phủ cả avatar cũ (đã
  // migrate) lẫn avatar mới (Frappe ghi song song). Nhờ vậy `User.user_image`
  // giữ nguyên giá trị, không phải migration DB, không phải sửa client.
  if (config.avatar.enabled && v.startsWith('/files/Avatar/')) {
    const name = v.slice('/files/Avatar/'.length);
    if (!name || name.includes('/') || name.includes('..')) return null;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    if (!stem) return null;
    return `/social-avatars/${config.avatar.prefix}/${stem}.webp`;
  }

  if (!config.legacyFallback) return null;

  // Dữ liệu cũ: giữ nguyên tên file, đổi prefix
  const legacy = [
    ['/api/social/uploads/posts/', '/social-posts/legacy/'],
    ['/api/social/uploads/chat/', '/social-chat/legacy/'],
    ['/uploads/posts/', '/social-posts/legacy/'],
    ['/uploads/chat/', '/social-chat/legacy/'],
  ];
  for (const [prefix, target] of legacy) {
    if (v.startsWith(prefix)) {
      const name = v.slice(prefix.length);
      // Chặn path traversal: chỉ nhận tên file phẳng
      if (!name || name.includes('/') || name.includes('..')) return null;
      return `${target}${name}`;
    }
  }

  return null;
}

module.exports = { toObjectPath, toStoredKey, pathFromMediaPublicUrl };
