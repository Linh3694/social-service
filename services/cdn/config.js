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

module.exports = { config, validate };
