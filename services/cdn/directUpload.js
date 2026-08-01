/**
 * Phase 3 — upload thẳng lên CDN, byte KHÔNG đi qua social-service.
 *
 * Luồng (CDN-Design.md §10 Phase 3):
 *
 *   1. Client  → POST /api/social/media/presign   → nhận presigned PUT + stagingKey
 *   2. Client  → PUT thẳng lên media.wellspring.edu.vn (bucket cdn-staging)
 *   3. Client  → POST /api/social/media/complete  → server promote sang bucket đích
 *   4. Client  → dùng khoá `cdn://…` trả về khi tạo bài / gửi tin nhắn
 *
 * VẤN ĐỀ NÀY GIẢI QUYẾT ĐƯỢC GÌ (và không giải quyết được gì)
 *
 * P1 nói rằng byte media đi xuyên qua process Node đơn luồng. Sau Phase 3, chặng
 * đắt nhất — client chậm giữ kết nối hàng chục giây trên 3G/4G — biến mất hoàn
 * toàn: MinIO nhận trực tiếp.
 *
 * Bước promote VẪN đọc byte về để chạy sharp/ffmpeg. Nhưng khác biệt là thật:
 * đọc từ MinIO qua mạng nội bộ mất ~100 ms thay vì hàng chục giây, và server tự
 * chủ động thời điểm đọc nên xếp hàng/tiết lưu được. Muốn bỏ hẳn byte khỏi Node
 * thì cần worker riêng (`cdn-service` ở §14) — ngoài phạm vi Phase 3.
 *
 * MÔ HÌNH TIN CẬY — client được PUT tuỳ ý vào staging, nên:
 *
 *   • stagingKey LUÔN do server sinh và mang tiền tố `<userId>/` ⇒ không ghi đè
 *     được file của người khác, không promote được file của người khác.
 *   • Mọi thuộc tính (hash, kích thước, loại ảnh/video, kích cỡ) đều suy lại từ
 *     BYTE THẬT lúc promote. Client khai gì cũng không ảnh hưởng kết quả.
 *   • Vượt trần dung lượng ⇒ xoá object rồi báo lỗi. Presigned PUT của S3 không
 *     ép được kích thước nên phải hậu kiểm.
 *   • Bucket staging không có location trên nginx ⇒ không đọc được từ Internet
 *     kể cả khi biết khoá. Lifecycle 1 ngày dọn rác.
 */

const crypto = require('crypto');
const path = require('path');

const { config, directUploadChoUser } = require('./config');
const s3 = require('./s3');

/** Đuôi file an toàn — chỉ chữ và số. Giống quy ước ở index.js. */
function safeExt(originalname, fallback = 'bin') {
  const ext = path.extname(originalname || '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

/** `kind` client gửi lên phải nằm trong danh sách trắng — không nhận bucket tuỳ ý. */
const KIND_HOP_LE = new Set(['posts', 'chat']);

function kiemTraKind(kind) {
  if (!KIND_HOP_LE.has(kind)) {
    const e = new Error(`kind không hợp lệ: ${kind}`);
    e.statusCode = 400;
    e.code = 'INVALID_KIND';
    throw e;
  }
  return kind;
}

/**
 * Khoá staging — tiền tố userId là ranh giới bảo mật, không phải để cho đẹp.
 * `promote()` kiểm lại tiền tố này trước khi làm bất cứ việc gì.
 */
function stagingKeyFor(userId, originalname) {
  const rand = crypto.randomBytes(16).toString('hex');
  return `${userId}/${Date.now()}-${rand}.${safeExt(originalname)}`;
}

function userIdCuaKhoa(stagingKey) {
  const i = String(stagingKey || '').indexOf('/');
  return i > 0 ? stagingKey.slice(0, i) : null;
}

/**
 * Cấp presigned PUT cho một loạt file.
 *
 * @param {{_id: any}} user
 * @param {Array<{filename?: string, contentType?: string}>} files
 * @param {'posts'|'chat'} kind
 */
async function presign(user, files, kind) {
  if (!directUploadChoUser(user)) {
    const e = new Error('Upload trực tiếp chưa được bật');
    e.statusCode = 409;
    e.code = 'DIRECT_UPLOAD_DISABLED';
    throw e;
  }
  kiemTraKind(kind);

  const ds = Array.isArray(files) ? files : [];
  if (!ds.length) {
    const e = new Error('Danh sách tệp trống');
    e.statusCode = 400;
    e.code = 'NO_FILES';
    throw e;
  }
  if (ds.length > config.directUpload.maxFiles) {
    const e = new Error(`Tối đa ${config.directUpload.maxFiles} tệp mỗi lượt`);
    e.statusCode = 400;
    e.code = 'TOO_MANY_FILES';
    throw e;
  }

  const userId = String(user._id);
  const bucket = config.buckets.staging;
  const ttl = config.directUpload.presignTtlSec;

  return Promise.all(ds.map(async (f) => {
    const stagingKey = stagingKeyFor(userId, f.filename);
    const contentType = String(f.contentType || '').slice(0, 120) || 'application/octet-stream';
    const putUrl = await s3.presignPutUrl({
      bucket,
      key: stagingKey,
      contentType,
      expiresIn: ttl,
    });
    return {
      stagingKey,
      putUrl,
      // Đo trên prod 30/07: presigner của SDK v3 ký `X-Amz-SignedHeaders=host`,
      // KHÔNG có content-type. Nên gửi lệch Content-Type sẽ vẫn 200 chứ không
      // 403 như trực giác. Vẫn yêu cầu client gửi đúng, vì `promote()` lấy
      // Content-Type ĐÃ LƯU để chọn nhánh ảnh/video của pipeline: khai lệch thì
      // sharp/ffmpeg sẽ ném lỗi ở bước promote.
      requiredHeaders: { 'Content-Type': contentType },
      expiresInSec: ttl,
      maxBytes: config.directUpload.maxBytes,
    };
  }));
}

/**
 * Chuyển object từ staging sang bucket đích, chạy pipeline ảnh/video.
 *
 * Trả về đúng hình dạng mà `storeUpload()` trả — nhờ vậy controller dùng chung
 * một đường xử lý cho cả upload multipart cũ lẫn upload trực tiếp mới.
 */
async function promote(user, stagingKey, kind) {
  if (!directUploadChoUser(user)) {
    const e = new Error('Upload trực tiếp chưa được bật');
    e.statusCode = 409;
    e.code = 'DIRECT_UPLOAD_DISABLED';
    throw e;
  }
  kiemTraKind(kind);

  const userId = String(user._id);
  // Ranh giới bảo mật: chỉ promote được khoá do CHÍNH user này xin.
  if (userIdCuaKhoa(stagingKey) !== userId) {
    const e = new Error('Khoá tải lên không thuộc về bạn');
    e.statusCode = 403;
    e.code = 'STAGING_KEY_FORBIDDEN';
    throw e;
  }

  const staging = config.buckets.staging;

  const head = await s3.headObject({ bucket: staging, key: stagingKey });
  if (!head.exists) {
    const e = new Error('Chưa thấy tệp trên vùng đệm — tải lên chưa xong?');
    e.statusCode = 404;
    e.code = 'STAGING_NOT_FOUND';
    throw e;
  }
  if (head.size > config.directUpload.maxBytes) {
    // Xoá ngay: đã vượt trần thì không có lý do giữ lại chiếm chỗ.
    await s3.deleteObject({ bucket: staging, key: stagingKey }).catch(() => {});
    const mb = Math.round(config.directUpload.maxBytes / 1024 / 1024);
    const e = new Error(`Tệp quá lớn (tối đa ${mb}MB)`);
    e.statusCode = 413;
    e.code = 'FILE_TOO_LARGE';
    throw e;
  }

  const { buffer, contentType } = await s3.getObjectBuffer({ bucket: staging, key: stagingKey });

  // Dùng lại đúng pipeline của đường multipart. require ở đây để tránh vòng lặp
  // require giữa index.js và module này.
  const { storeBuffer } = require('./index');
  const ket_qua = await storeBuffer(buffer, {
    kind,
    originalname: path.basename(stagingKey),
    mimetype: contentType,
  });

  // Dọn staging. Thất bại cũng không sao — lifecycle 1 ngày sẽ quét.
  await s3.deleteObject({ bucket: staging, key: stagingKey }).catch(() => {});

  // Video codec lạ ⇒ xếp hàng transcode nền (SIS-174). Đặt ở đây chứ không trong
  // `storeBuffer` — xem ghi chú ở `enqueueTranscode` trong index.js.
  try {
    const { enqueueIfNeeded } = require('../transcodeScheduler');
    await enqueueIfNeeded(ket_qua, kind);
  } catch (error) {
    console.error('[cdn] enqueue transcode lỗi:', error.message);
  }

  return ket_qua;
}

module.exports = { presign, promote, stagingKeyFor, userIdCuaKhoa, kiemTraKind };
