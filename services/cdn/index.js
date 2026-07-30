/**
 * Điểm vào của tầng CDN cho social-service.
 *
 * Luồng upload (CDN-Design.md §6.5):
 *   multipart → file tạm /tmp → sha256 → sharp (WebP + variants, strip EXIF)
 *   → PutObject song song lên MinIO VM3 → unlink /tmp
 *   → DB lưu "cdn://social-posts/2026/07/ab/<hash>.webp"
 *
 * DB lưu OBJECT KEY, không lưu URL (§5.3). Nhờ vậy đổi domain, đổi secret hay
 * đổi cửa sổ hết hạn đều không cần migration DB.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { config, validate } = require('./config');
const { signPath, signStored, CDN_SCHEME } = require('./sign');
const { signMediaDeep } = require('./signDeep');
const { toObjectPath } = require('./resolve');
const imagePipeline = require('./imagePipeline');
const { processImage } = imagePipeline;
const { processVideo } = require('./videoPipeline');
const s3 = require('./s3');

/** kind → bucket vật lý */
function bucketFor(kind) {
  const bucket = config.buckets[kind];
  if (!bucket) throw new Error(`[cdn] kind không hợp lệ: ${kind}`);
  return bucket;
}

/** "cdn-social-posts" → "social-posts" (tiền tố dùng trong URL và khoá DB) */
function prefixFor(kind) {
  return bucketFor(kind).replace(/^cdn-/, '');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);
}

/** Đuôi file an toàn — chỉ chữ và số, tối đa 8 ký tự. */
function safeExt(originalname, fallback) {
  const ext = path.extname(originalname || '').replace(/^\./, '').toLowerCase();
  if (!ext || !/^[a-z0-9]{1,8}$/.test(ext)) return fallback;
  return ext;
}

function isImage(mimetype, originalname) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  if (mime) return false;
  // iOS đôi khi gửi mimetype rỗng — fallback theo đuôi file
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?)$/i.test(originalname || '');
}

function isVideo(mimetype, originalname) {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return true;
  if (mime) return false;
  return /\.(mp4|mov|m4v|webm)$/i.test(originalname || '');
}

/**
 * Đưa một file đã upload lên CDN.
 *
 * @param {{path: string, originalname?: string, mimetype?: string, size?: number}} file file của multer
 * @param {{kind: 'posts'|'chat'|'avatars'}} opts
 * @returns {Promise<{stored: string, url: string, kind: 'image'|'video'|'file', contentType: string, width?: number, height?: number, size: number, variants: string[]}>}
 */
async function storeUpload(file, { kind }) {
  const original = await fs.readFile(file.path);
  return storeBuffer(original, {
    kind,
    originalname: file.originalname,
    mimetype: file.mimetype,
    // Chỉ đường multipart mới có file trên đĩa để ffmpeg đọc trực tiếp.
    sourcePath: file.path,
  });
}

/**
 * Lõi dùng chung cho CẢ HAI đường vào: multipart (Phase 1) và upload trực tiếp
 * (Phase 3). Tách ra để hai đường không bao giờ lệch nhau về cách nén, cách đặt
 * khoá hay cách sinh variants — lệch ở đây là loại lỗi chỉ lộ ra ở một trong hai
 * đường và rất khó truy.
 *
 * @param {Buffer} original
 * @param {{kind: 'posts'|'chat'|'avatars', originalname?: string, mimetype?: string, sourcePath?: string}} opts
 */
async function storeBuffer(original, { kind, originalname, mimetype, sourcePath }) {
  const bucket = bucketFor(kind);
  const prefix = prefixFor(kind);
  const file = { originalname, mimetype };

  const image = isImage(file.mimetype, file.originalname);
  let body = original;
  let ext = safeExt(file.originalname, 'bin');
  let contentType = file.mimetype || 'application/octet-stream';
  let width;
  let height;
  let variantParts = [];

  const video = !image && isVideo(file.mimetype, file.originalname);

  if (image) {
    const result = await processImage(original);
    if (result.ok) {
      body = result.main.buffer;
      ext = result.main.ext;
      contentType = result.main.contentType;
      width = result.main.width;
      height = result.main.height;
      variantParts = result.variants;
    }
    // result.ok === false ⇒ giữ nguyên bản gốc (HEIC thiếu libheif, ảnh hỏng…).
    // Đã log trong imagePipeline; không throw để bài đăng vẫn tạo được.
  } else if (video) {
    // Remux `+faststart` để video phát ngay thay vì phải tải gần hết (§7.3).
    // Poster đi kèm dưới dạng variant `_poster.webp` — cùng hash nên client
    // suy ra được đường dẫn từ URL video mà không cần thêm field trong DB.
    //
    // ffmpeg cần đường dẫn file, không nhận buffer. Đường multipart đã có sẵn
    // file trên đĩa; đường upload trực tiếp (Phase 3) chỉ có buffer trong bộ
    // nhớ nên phải ghi tạm rồi dọn.
    let videoPath = sourcePath;
    let tempVideo = null;
    if (!videoPath) {
      tempVideo = path.join(
        os.tmpdir(),
        `cdn-promote-${crypto.randomBytes(8).toString('hex')}.${ext}`,
      );
      await fs.writeFile(tempVideo, original);
      videoPath = tempVideo;
    }
    try {
      const result = await processVideo(videoPath, ext);
      if (result.remuxed && result.buffer) {
        body = result.buffer;
        if (result.poster) {
          variantParts = [{
            suffix: '_poster',
            buffer: result.poster,
            ext: 'webp',
            contentType: 'image/webp',
          }];
        }
      }
      // remuxed === false ⇒ dùng nguyên bản gốc; đã log trong videoPipeline.
    } finally {
      if (tempVideo) await fs.unlink(tempVideo).catch(() => {});
    }
  }

  // Hash tính trên NỘI DUNG CUỐI đã lưu, không phải file gốc: nhờ vậy
  // `Cache-Control: immutable` luôn đúng — đổi tham số nén ⇒ đổi khoá (§5.2).
  const hash = sha256Hex(body);
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dir = `${yyyy}/${mm}/${hash.slice(0, 2)}`;

  const mainKey = `${dir}/${hash}.${ext}`;
  const cacheControl = kind === 'chat'
    ? 'private, max-age=3600'
    : 'private, max-age=86400, immutable';

  await Promise.all([
    s3.putObject({ bucket, key: mainKey, body, contentType, cacheControl }),
    ...variantParts.map((v) => s3.putObject({
      bucket,
      key: `${dir}/${hash}${v.suffix}.${v.ext}`,
      body: v.buffer,
      contentType: v.contentType,
      cacheControl,
    })),
  ]);

  const stored = `${CDN_SCHEME}${prefix}/${mainKey}`;
  return {
    stored,
    url: signPath(`/${prefix}/${mainKey}`),
    kind: image ? 'image' : (video ? 'video' : 'file'),
    contentType,
    width,
    height,
    size: body.length,
    variants: variantParts.map((v) => `${CDN_SCHEME}${prefix}/${dir}/${hash}${v.suffix}.${v.ext}`),
  };
}

/**
 * Xoá object đã lên MinIO — dùng ở nhánh cleanup khi controller lỗi giữa chừng.
 * Nuốt lỗi có chủ ý: cleanup thất bại không được che mất lỗi gốc.
 */
async function removeStored(stored) {
  try {
    if (typeof stored !== 'string' || !stored.startsWith(CDN_SCHEME)) return;
    const rest = stored.slice(CDN_SCHEME.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return;
    const bucket = `cdn-${rest.slice(0, slash)}`;
    const key = rest.slice(slash + 1);
    if (key) await s3.deleteObject({ bucket, key });
  } catch (error) {
    console.error('[cdn] removeStored:', error.message);
  }
}

/** Xoá file tạm của multer; không bao giờ throw. */
async function cleanupTempFiles(files) {
  await Promise.all((files || []).map(async (f) => {
    try {
      if (f?.path) await fs.unlink(f.path);
    } catch { /* file có thể đã bị xoá — bỏ qua */ }
  }));
}

/** Log cấu hình một lần lúc khởi động để lỗi env lộ ra ngay, không đợi user upload. */
function logStartupState() {
  if (!config.enabled) {
    console.log('[cdn] CDN_ENABLED=false — dùng đĩa local + express.static như cũ');
    return;
  }
  const { ok, errors } = validate();
  if (!ok) {
    console.error(`[cdn] ⚠️  CDN_ENABLED=true nhưng thiếu biến: ${errors.join(', ')} — upload sẽ lỗi`);
    return;
  }
  console.log(`[cdn] bật — ${config.publicUrl} qua ${config.s3.endpoint}`);

  // sharp hỏng = hỏng ÂM THẦM theo hướng nguy hiểm: ảnh lưu nguyên bản, EXIF
  // GPS không bị loại, upload vẫn trả 200. Phải hét lên ngay lúc khởi động.
  const img = imagePipeline.selfTest();
  if (!img.ok) {
    console.error('');
    console.error('  ╔════════════════════════════════════════════════════════════╗');
    console.error('  ║  ⚠️  SHARP KHÔNG NẠP ĐƯỢC — ẢNH SẼ LƯU NGUYÊN BẢN          ║');
    console.error('  ║                                                            ║');
    console.error('  ║  Hệ quả: EXIF/GPS trong ảnh học sinh KHÔNG bị loại (P5),   ║');
    console.error('  ║  dung lượng và băng thông không giảm. Upload vẫn trả 200   ║');
    console.error('  ║  nên lỗi này KHÔNG tự lộ ra — phải xử lý ngay.             ║');
    console.error('  ║                                                            ║');
    console.error('  ║  Khắc phục trên VM:  npm rebuild sharp                      ║');
    console.error('  ║  (sharp là native binary — không copy node_modules từ máy   ║');
    console.error('  ║   macOS sang VM Linux được)                                ║');
    console.error('  ╚════════════════════════════════════════════════════════════╝');
    console.error(`  Chi tiết: ${img.reason}`);
    console.error('');
    return;
  }
  console.log(`[cdn] sharp OK — libvips ${img.versions?.vips || '?'}`);
}

module.exports = {
  config,
  storeUpload,
  storeBuffer,
  // Phase 3 — nạp lười để tránh vòng require (directUpload cần storeBuffer).
  get directUpload() { return require('./directUpload'); },
  removeStored,
  cleanupTempFiles,
  signMediaDeep,
  signPath,
  signStored,
  toObjectPath,
  logStartupState,
  CDN_SCHEME,
};
