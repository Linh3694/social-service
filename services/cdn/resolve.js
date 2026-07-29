/**
 * Ánh xạ giá trị lưu trong DB → object path trên CDN.
 *
 * Nguyên tắc migration (CDN-Design.md §9): KHÔNG sửa DB trước. Dữ liệu cũ được
 * `mc mirror` sang prefix `legacy/` giữ nguyên tên file, nên ánh xạ là thuần
 * tất định — không cần bảng tra, và tắt `CDN_ENABLED` là quay lại ngay.
 */

const { config } = require('./config');
const { CDN_SCHEME } = require('./sign');

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

  // URL tuyệt đối (ảnh ngoài) — để nguyên
  if (v.startsWith('http://') || v.startsWith('https://')) return null;

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

module.exports = { toObjectPath };
