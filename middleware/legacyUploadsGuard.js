/**
 * Chặn truy cập ẩn danh vào `/uploads` (lỗ hổng P3 — CDN-Design.md §1.2).
 *
 * Trước đây `express.static` phục vụ toàn bộ thư mục uploads KHÔNG kiểm tra gì:
 * bất kỳ ai có URL đều tải được ảnh chat GV↔phụ huynh về học sinh. Tên file chỉ
 * là `chat-<timestamp>-<random>.jpg` — đoán được khoảng thời gian, và URL thì rò
 * rỉ qua lịch sử duyệt web, log proxy, ảnh chụp màn hình chuyển tiếp.
 *
 * Vì sao không gỡ hẳn mount mà chỉ khoá lại:
 *   - `CDN_ENABLED=false` là đường rollback (§11) — lúc đó `/uploads` LÀ nguồn
 *     phục vụ chính thức, phải chạy y như cũ.
 *   - Khi bật CDN, client nhận URL CDN đã ký (resolve.js ánh xạ cả dữ liệu cũ),
 *     nên `/uploads` chỉ còn là lưới an toàn cho client giữ cache cũ.
 *
 * Vì sao chấp nhận token qua query: thẻ `<img>`/`<video>` không gắn được header
 * `Authorization`. Đường socket trong app.js cũng đã dùng `?token=` sẵn, nên đây
 * là quy ước có sẵn của service chứ không phải ngoại lệ mới.
 */

const { config } = require('../services/cdn/config');
const { resolveSocketUser } = require('../utils/authResolve');

/**
 * Đếm lượt truy cập để biết khi nào gỡ mount an toàn (§9 Bước 5 / Phase 4).
 * Gỡ khi `denied` về 0 và `allowed` không còn tăng — nghĩa là không client nào
 * còn giữ URL `/uploads` cũ.
 */
const stats = { allowed: 0, denied: 0, lastDeniedAt: null };

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    const t = header.slice(7).trim();
    if (t) return t;
  }
  const q = req.query?.token;
  return typeof q === 'string' && q ? q : null;
}

async function legacyUploadsGuard(req, res, next) {
  // Rollback: CDN tắt ⇒ hành vi cũ nguyên vẹn, không thêm rào nào.
  if (!config.enabled) return next();

  const token = extractToken(req);
  if (!token) {
    stats.denied += 1;
    stats.lastDeniedAt = new Date().toISOString();
    return res.status(403).json({
      success: false,
      code: 'LEGACY_UPLOADS_FORBIDDEN',
      message: 'Media phục vụ qua CDN đã ký. Tải lại dữ liệu để nhận URL mới.',
    });
  }

  let user = null;
  try {
    user = await resolveSocketUser(token);
  } catch {
    user = null;
  }

  if (!user) {
    stats.denied += 1;
    stats.lastDeniedAt = new Date().toISOString();
    return res.status(403).json({
      success: false,
      code: 'LEGACY_UPLOADS_FORBIDDEN',
      message: 'Token không hợp lệ hoặc đã hết hạn.',
    });
  }

  stats.allowed += 1;

  // express.static bên dưới đặt `public, max-age=86400, immutable` — sai hoàn
  // toàn cho nội dung đã xác thực: proxy dùng chung (ISP, proxy trường) được
  // phép cache rồi trả cho người khác. Ghi đè TRƯỚC khi static chạy.
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.removeHeader('Pragma');
  return next();
}

legacyUploadsGuard.stats = stats;

module.exports = legacyUploadsGuard;
