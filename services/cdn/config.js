/**
 * Cấu hình CDN — đọc một lần lúc khởi động.
 *
 * `CDN_ENABLED=false` là kill switch: mọi nhánh CDN tắt, service quay về ghi
 * đĩa local + express.static như trước. Xem CDN-Design.md §11 (Rollback).
 */

function int(name, fallback) {
  const raw = process.env[name];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

const enabled = bool('CDN_ENABLED', false);

const config = {
  enabled,

  publicUrl: (process.env.CDN_PUBLIC_URL || '').replace(/\/+$/, ''),
  linkSecret: process.env.CDN_LINK_SECRET || '',

  s3: {
    endpoint: process.env.CDN_S3_ENDPOINT || '',
    region: process.env.CDN_REGION || 'us-east-1',
    accessKeyId: process.env.CDN_ACCESS_KEY || '',
    secretAccessKey: process.env.CDN_SECRET_KEY || '',
    forcePathStyle: bool('CDN_FORCE_PATH_STYLE', true),
  },

  // Bucket vật lý trên MinIO. Tiền tố `cdn-` bị lược khi dựng object key và
  // URL công khai (`cdn-social-posts` ⇒ `cdn://social-posts/…`).
  buckets: {
    posts: process.env.CDN_BUCKET_POSTS || 'cdn-social-posts',
    chat: process.env.CDN_BUCKET_CHAT || 'cdn-social-chat',
    avatars: process.env.CDN_BUCKET_AVATARS || 'cdn-social-avatars',
    // Vùng đệm cho upload trực tiếp (Phase 3). KHÔNG phát ra Internet —
    // nginx VM3 không có location cho bucket này. Lifecycle xoá sau 1 ngày.
    staging: process.env.CDN_BUCKET_STAGING || 'cdn-staging',
  },

  // Phase 3 — client PUT thẳng lên MinIO, byte không đi qua social-service.
  // Tắt mặc định: bật được ngay khi hạ tầng sẵn sàng mà không cần deploy lại,
  // và client cũ vẫn dùng đường multipart cũ song song.
  directUpload: {
    enabled: bool('CDN_DIRECT_UPLOAD', false),
    // Danh sách trắng để THỬ trên máy thật mà không bật cho cả trường.
    //
    // Vì sao cần: hai rủi ro nặng nhất của đường trực tiếp trên mobile — hết bộ
    // nhớ khi gửi video, và Content-Type lệch chữ ký — chỉ hiện ra trên thiết bị
    // thật, không phát hiện được bằng đọc code hay test đơn vị. Mà app đã lên
    // store thì không hotfix được, nên phải xác minh được bằng MỘT tài khoản
    // trước khi bật rộng.
    //
    // `CDN_DIRECT_UPLOAD=true` ⇒ bật cho mọi người, danh sách này vô nghĩa.
    // Cờ tắt + danh sách có người ⇒ CHỈ những người đó đi đường trực tiếp.
    allowUsers: new Set(
      String(process.env.CDN_DIRECT_UPLOAD_USERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    // TTL của presigned PUT. Ngắn thôi — client xin xong là upload ngay.
    presignTtlSec: int('CDN_PRESIGN_TTL_SEC', 900),
    maxFiles: int('CDN_PRESIGN_MAX_FILES', 30),
    // Trần dung lượng, kiểm ở bước complete bằng HeadObject. Presigned PUT của
    // S3 không ép được kích thước, nên phải hậu kiểm rồi xoá nếu vượt.
    maxBytes: int('CDN_PRESIGN_MAX_BYTES', 100 * 1024 * 1024),
  },

  // Cửa sổ làm tròn expiry (§3.2). Cùng cửa sổ ⇒ cùng URL ⇒ cache hit.
  sign: {
    default: {
      window: int('CDN_SIGN_WINDOW_SEC', 6 * 3600),
      lifetime: int('CDN_SIGN_LIFETIME_SEC', 24 * 3600),
    },
    chat: {
      window: int('CDN_SIGN_WINDOW_CHAT_SEC', 3600),
      lifetime: int('CDN_SIGN_LIFETIME_CHAT_SEC', 2 * 3600),
    },
  },

  image: {
    maxWidth: int('CDN_IMAGE_MAX_WIDTH', 2048),
    quality: int('CDN_IMAGE_QUALITY', 82),
    variants: (process.env.CDN_IMAGE_VARIANTS || '480,1080')
      .split(',')
      .map((v) => Number.parseInt(v.trim(), 10))
      .filter((v) => Number.isFinite(v) && v > 0),
    stripExif: bool('CDN_STRIP_EXIF', true),
  },

  legacyFallback: bool('CDN_LEGACY_FALLBACK', true),

  // Avatar do Frappe quản lý (`/files/Avatar/...`), không phải upload của
  // social-service. Cờ riêng để tắt được độc lập: nếu avatar lỗi thì không
  // phải tắt cả CDN, ảnh bài đăng và chat vẫn chạy.
  avatar: {
    enabled: bool('CDN_AVATAR_ENABLED', false),
    prefix: process.env.CDN_AVATAR_PREFIX || 'users',
  },
};

/**
 * Cấu hình thiếu mà vẫn bật CDN là lỗi cấu hình nguy hiểm: upload sẽ hỏng
 * hàng loạt lúc chạy. Kiểm tra ngay khi khởi động để fail nhanh và rõ.
 */
function validate() {
  if (!config.enabled) return { ok: true, errors: [] };
  const errors = [];
  if (!config.publicUrl) errors.push('CDN_PUBLIC_URL');
  if (!config.linkSecret) errors.push('CDN_LINK_SECRET');
  if (!config.s3.endpoint) errors.push('CDN_S3_ENDPOINT');
  if (!config.s3.accessKeyId) errors.push('CDN_ACCESS_KEY');
  if (!config.s3.secretAccessKey) errors.push('CDN_SECRET_KEY');
  return { ok: errors.length === 0, errors };
}

/**
 * User này có được đi đường upload trực tiếp không.
 *
 * MỘT nguồn sự thật cho cả `capability`, `presign` và `promote`. Nếu ba chỗ tự
 * suy riêng thì sẽ có ngày `capability` bảo "được" mà `presign` trả 409 — client
 * rơi về multipart im lặng và không ai hiểu tại sao đường trực tiếp không chạy.
 */
function directUploadChoUser(user) {
  if (!config.enabled) return false;
  if (config.directUpload.enabled) return true;
  const id = user && user._id !== undefined ? String(user._id) : '';
  return Boolean(id) && config.directUpload.allowUsers.has(id);
}

module.exports = { config, validate, directUploadChoUser };
