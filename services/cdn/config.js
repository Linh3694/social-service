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
    //
    // ⚠️ CÂU TRÊN LÀ CON DAO HAI LƯỠI (xác minh 03/08/2026, SIS-182). "Không có
    // location" chặn cả chiều GHI, không riêng chiều đọc: trình duyệt PUT tới
    // `https://media.wellspring.edu.vn/cdn-staging/…` sẽ ăn 404. Nên đường upload
    // trực tiếp CHƯA BAO GIỜ chạy được với bất kỳ ai kể từ khi Phase 3 lên.
    // Muốn dùng thì phải mở location CHỈ-GHI trên nginx VM media — xem ghi chú
    // đầy đủ ở `directUpload.enabled` bên dưới.
    staging: process.env.CDN_BUCKET_STAGING || 'cdn-staging',
  },

  // Phase 3 — client PUT thẳng lên MinIO, byte không đi qua social-service.
  // Tắt mặc định: bật được ngay khi hạ tầng sẵn sàng mà không cần deploy lại,
  // và client cũ vẫn dùng đường multipart cũ song song.
  //
  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║  ⛔ ĐỪNG BẬT `CDN_DIRECT_UPLOAD=true` TRƯỚC KHI LÀM XONG PHẦN NGINX   ║
  // ║     Ở VM MEDIA. Bật lúc chưa xong = HỎNG UPLOAD TOÀN TRƯỜNG.         ║
  // ╚══════════════════════════════════════════════════════════════════════╝
  //
  // Hiện trạng đã xác minh trên prod ngày 03/08/2026 (SIS-182):
  //   • `CDN_ENABLED=true` — file VẪN lên CDN bình thường. Cái chưa bật chỉ là
  //     ĐƯỜNG ĐI của byte, và cả hai đường đều kết thúc trên MinIO.
  //   • `CDN_DIRECT_UPLOAD` không khai trong config.env ⇒ false.
  //   • `CDN_DIRECT_UPLOAD_USERS=phase3-probe-user` — placeholder, phải là
  //     ObjectId hex 24 ký tự mới khớp, nên KHÔNG khớp ai. Đường trực tiếp vì
  //     vậy chưa từng chạy với một người dùng thật nào.
  //   • Chốt chặn: bucket `cdn-staging` KHÔNG có location trên nginx VM media
  //     (172.16.20.31 — CDN-Design.md ghi .94 và cdn.wellspring.edu.vn, cả hai
  //     đều LỆCH thực tế; config.env mới là sự thật). Browser PUT vào đó ⇒ 404.
  //
  // Việc cần làm trên nginx VM media trước khi bật:
  //   1. `location ~ ^/cdn-staging(/.*)?$` proxy sang MinIO, kèm
  //      `limit_except PUT OPTIONS { deny all; }` để giữ nguyên tính chất
  //      "không đọc được từ Internet" — mở chiều ghi, vẫn khoá chiều đọc.
  //   2. Trả preflight `OPTIONS` 204 + `Access-Control-Allow-Origin`. BẮT BUỘC:
  //      PUT kèm Content-Type luôn sinh preflight, thiếu là hỏng 100% và lại
  //      hiện ra dưới dạng "lỗi CORS" che mất nguyên nhân thật (đúng bẫy SIS-181).
  //   3. `$cors_allow_origin` nhận https://wis.wellspring.edu.vn + origin portal PH.
  //   4. `client_max_body_size 1200m`, `proxy_request_buffering off`, timeout rộng.
  //   5. Lifecycle 1 ngày cho bucket staging.
  //
  // Xác nhận đã thông (kỳ vọng 204 + có header ACAO):
  //   curl -i -X OPTIONS https://media.wellspring.edu.vn/cdn-staging/test \
  //     -H "Origin: https://wis.wellspring.edu.vn" \
  //     -H "Access-Control-Request-Method: PUT" \
  //     -H "Access-Control-Request-Headers: content-type"
  // Và chiều đọc PHẢI vẫn 403:
  //   curl -s -o /dev/null -w "%{http_code}\n" https://media.wellspring.edu.vn/cdn-staging/test
  //
  // Thông rồi thì THỬ MỘT TÀI KHOẢN trước (CDN_DIRECT_UPLOAD_USERS = _id thật
  // trong Mongo), chạy ổn vài ngày mới bật cờ cho cả trường.
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
    //
    // SIS-181: nâng 100MB → 1GB cho khớp trần multipart ở routes/chatRoutes.js.
    // Hai đường phải cùng một con số, lệch nhau là loại lỗi chỉ hiện ở MỘT trong
    // hai đường và rất khó truy (cùng lý do đã ghi ở storeBuffer).
    maxBytes: int('CDN_PRESIGN_MAX_BYTES', 1024 * 1024 * 1024),
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
