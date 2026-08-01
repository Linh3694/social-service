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

const { normalizeUploadFilename } = require('../../utils/uploadFilename');
const { config, validate, directUploadChoUser } = require('./config');
const { signPath, signStored, CDN_SCHEME } = require('./sign');
const { signMediaDeep } = require('./signDeep');
const { toObjectPath } = require('./resolve');
const imagePipeline = require('./imagePipeline');
const { processImage } = imagePipeline;
const { processVideo, probeVideoCodec } = require('./videoPipeline');
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
 * Đổi đuôi tên tải về cho khớp NỘI DUNG ĐÃ LƯU.
 *
 * Pipeline ảnh chuyển sang WebP nhưng tên gốc vẫn là "anh.jpg" (§7.1) — đặt nguyên
 * tên đó vào header thì người dùng lưu được một file `.jpg` chứa byte WebP, vài
 * trình xem ảnh trên Windows từ chối mở.
 */
function alignExt(name, ext) {
  const raw = String(name || '');
  if (!raw || !ext) return raw;
  const cur = path.extname(raw).replace(/^\./, '').toLowerCase();
  if (cur === String(ext).toLowerCase()) return raw;
  const base = cur ? raw.slice(0, raw.length - cur.length - 1) : raw;
  return `${base || raw}.${ext}`;
}

/**
 * Header `Content-Disposition` để trình duyệt lưu file bằng TÊN GỐC.
 *
 * Object key là hash nội dung (§5.2) nên tên trong URL luôn là dạng
 * "6e1246314daf….xlsx". Không có header này thì trình duyệt lưu đúng cái tên hash
 * đó — phụ huynh tải "PR, PO - mẫu mới (3).xlsx" trong chat ra một tên vô nghĩa.
 *
 * Dùng `inline`, KHÔNG dùng `attachment`: ảnh và PDF phải xem trước được ngay
 * trong tab như hiện tại. Trình duyệt vẫn lấy `filename*` khi thật sự tải về
 * (loại file không hiển thị được, hoặc người dùng bấm lưu).
 *
 * Hai tham số là có chủ ý (RFC 6266 §5): `filename` ASCII cho client cũ,
 * `filename*` (RFC 5987) cho tên tiếng Việt. `'()*!` KHÔNG thuộc attr-char nên
 * phải tự percent-encode — encodeURIComponent để nguyên, mà `(` `)` rất hay gặp
 * trong tên file tải về từ Windows: "mẫu mới (3).xlsx".
 *
 * @param {string} [downloadName] tên gốc đã giải mã UTF-8
 * @returns {string|undefined} undefined khi không có tên đáng tin ⇒ không set header
 */
function contentDispositionFor(downloadName) {
  const raw = String(downloadName || '').trim();
  if (!raw) return undefined;
  // Loại ký tự điều khiển (CR/LF là lỗ hổng chèn header), dấu ngoặc kép và mọi
  // dấu tách đường dẫn — tên file không bao giờ được mang đường dẫn.
  const safe = raw.replace(/[\x00-\x1f\x7f"\\/]+/g, '_').trim().slice(0, 200);
  if (!safe) return undefined;
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe)
    .replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
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
  const ketQua = await storeBuffer(original, {
    kind,
    originalname: file.originalname,
    mimetype: file.mimetype,
    // Chỉ đường multipart mới có file trên đĩa để ffmpeg đọc trực tiếp.
    sourcePath: file.path,
    // Tên gốc để đặt Content-Disposition. PHẢI giải mã latin1 trước (SIS-169):
    // đặt thẳng `originalname` của multer thì header ra "ChÃ­nh sÃ¡ch.docx".
    downloadName: normalizeUploadFilename(file.originalname || ''),
  });
  await enqueueTranscode(ketQua, kind);
  return ketQua;
}

/**
 * Xếp job transcode nếu video dùng codec lạ (SIS-174).
 *
 * Đặt ở `storeUpload`/`promote` chứ KHÔNG ở `storeBuffer`: đây mới là ranh giới
 * "người dùng vừa upload". `storeBuffer` còn được script backfill và worker
 * transcode gọi lại — xếp hàng ở đó là tự sinh việc cho chính mình.
 *
 * Nạp lười để tránh vòng require (scheduler cần cdn) và để tầng cdn không phải
 * biết tới Mongo lúc khởi động. Nuốt lỗi: hàng đợi hỏng không được làm hỏng upload.
 */
async function enqueueTranscode(ketQua, kind) {
  try {
    const { enqueueIfNeeded } = require('../transcodeScheduler');
    await enqueueIfNeeded(ketQua, kind);
  } catch (error) {
    console.error('[cdn] enqueue transcode lỗi:', error.message);
  }
}

/**
 * Lõi dùng chung cho CẢ HAI đường vào: multipart (Phase 1) và upload trực tiếp
 * (Phase 3). Tách ra để hai đường không bao giờ lệch nhau về cách nén, cách đặt
 * khoá hay cách sinh variants — lệch ở đây là loại lỗi chỉ lộ ra ở một trong hai
 * đường và rất khó truy.
 *
 * `downloadName` là tên gốc do người dùng đặt, dùng riêng cho
 * `Content-Disposition`. Tách khỏi `originalname` (chỉ dùng để suy đuôi file và
 * đoán loại khi thiếu mimetype) vì đường upload trực tiếp KHÔNG biết tên gốc —
 * `promote()` chỉ có stagingKey — và đặt một tên bịa vào header còn tệ hơn không
 * đặt gì.
 *
 * @param {Buffer} original
 * @param {{kind: 'posts'|'chat'|'avatars', originalname?: string, mimetype?: string, sourcePath?: string, downloadName?: string}} opts
 */
async function storeBuffer(original, { kind, originalname, mimetype, sourcePath, downloadName }) {
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
  /** Codec luồng video (SIS-174) — null với ảnh/tệp hoặc khi không đo được. */
  let videoCodec = null;

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
      // Đo codec để biết có phải xếp hàng transcode không (SIS-174). Đo TRƯỚC khi
      // remux cho gọn: remux `-c copy` không đổi codec nên đo lúc nào cũng ra một
      // kết quả, mà file gốc thì chắc chắn đang có sẵn ở đây.
      videoCodec = await probeVideoCodec(videoPath);

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

  // Chỉ object chính mang tên gốc. Variants (`_poster.webp`, `_w480.webp`) là ảnh
  // dẫn xuất, không có tên người dùng đặt nào tương ứng.
  //
  // Giới hạn đã biết của khoá content-addressed: hai người gửi CÙNG nội dung với
  // hai tên khác nhau dùng chung một object ⇒ lượt ghi sau thắng, và nginx cache
  // có thể giữ header cũ tới hết `max-age`. Vì vậy đây chỉ là lưới an toàn cho
  // đường mở tab trực tiếp; client vẫn phải tự đặt tên khi tải (nó có tên đúng
  // của từng tin nhắn trong DB).
  const contentDisposition = contentDispositionFor(alignExt(downloadName, ext));

  await Promise.all([
    s3.putObject({ bucket, key: mainKey, body, contentType, cacheControl, contentDisposition }),
    ...variantParts.map((v) => s3.putObject({
      bucket,
      key: `${dir}/${hash}${v.suffix}.${v.ext}`,
      body: v.buffer,
      contentType: v.contentType,
      cacheControl,
    })),
  ]);

  const stored = `${CDN_SCHEME}${prefix}/${mainKey}`;
  const variants = variantParts.map((v) => `${CDN_SCHEME}${prefix}/${dir}/${hash}${v.suffix}.${v.ext}`);
  return {
    stored,
    url: signPath(`/${prefix}/${mainKey}`),
    kind: image ? 'image' : (video ? 'video' : 'file'),
    contentType,
    width,
    height,
    size: body.length,
    variants,
    // Tách riêng poster thay vì bắt gọi phía trên tự lọc trong `variants`: client
    // KHÔNG tự suy ra được đường dẫn poster, vì URL phục vụ ra ngoài là URL đã ký
    // theo từng path — nối chuỗi `_poster.webp` vào URL đã ký là chữ ký sai (403).
    // Vì vậy khoá poster phải được lưu vào DB như một giá trị riêng để signMediaDeep ký.
    posterStored: variants.find((v) => v.endsWith('_poster.webp')) || null,
    videoCodec,
  };
}

/**
 * Bóc khoá `cdn://social-chat/2026/08/ab/<hash>.mp4` thành các mảnh dùng được.
 * @returns {{bucket: string, prefix: string, key: string, kind: 'chat'|'posts'|null}|null}
 */
function parseStored(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(CDN_SCHEME)) return null;
  const rest = stored.slice(CDN_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const prefix = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!key) return null;
  const kind = prefix === 'social-chat' ? 'chat' : prefix === 'social-posts' ? 'posts' : null;
  return { bucket: `cdn-${prefix}`, prefix, key, kind };
}

/**
 * Khoá poster suy ra từ khoá video: `…/<hash>.mp4` → `…/<hash>_poster.webp`.
 *
 * Suy ra được vì poster là variant cùng hash, sinh trong cùng một lượt `storeBuffer`
 * (§7.3). Nhưng CHỈ server mới suy được: URL phục vụ ra ngoài là URL đã ký theo
 * từng path, nên client nối thêm `_poster.webp` vào URL đã ký sẽ ra chữ ký sai (403).
 * Vì thế khoá poster phải nằm sẵn trong DB dưới dạng một giá trị `cdn://` riêng để
 * `signMediaDeep` ký cùng lúc với video.
 *
 * @returns {string|null} null nếu không phải khoá cdn:// (dữ liệu legacy không có poster)
 */
function posterKeyFor(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(CDN_SCHEME)) return null;
  const dot = stored.lastIndexOf('.');
  const slash = stored.lastIndexOf('/');
  if (dot <= slash) return null;
  return `${stored.slice(0, dot)}_poster.webp`;
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

  // Decoder HEIC nằm NGOÀI sharp (xem heicDecode.js) nên phải kiểm riêng. Hỏng
  // thì ảnh iPhone lại rơi vào đúng nhánh giữ-nguyên-bản-gốc của SIS-171: upload
  // 200, tin nhắn có, ảnh trắng. Không tự lộ ra ⇒ phải hét lên lúc khởi động.
  //
  // Chạy nền, không await: nạp WASM tốn khoảng một giây, không đáng chặn tiến
  // trình khởi động chỉ để in một dòng log.
  imagePipeline.selfTestHeic().then((heic) => {
    if (heic.ok) {
      console.log(`[cdn] decoder HEIC OK — ảnh mẫu ${heic.width}x${heic.height}`);
      return;
    }
    console.error('');
    console.error('  ╔════════════════════════════════════════════════════════════╗');
    console.error('  ║  ⚠️  DECODER HEIC HỎNG — ẢNH iPHONE SẼ LƯU NGUYÊN BẢN      ║');
    console.error('  ║                                                            ║');
    console.error('  ║  Hệ quả: ảnh .heic gửi vào chat/bảng tin KHÔNG hiển thị    ║');
    console.error('  ║  được trên mọi trình duyệt ngoài Safari (SIS-171). Upload  ║');
    console.error('  ║  vẫn trả 200 nên lỗi này KHÔNG tự lộ ra.                   ║');
    console.error('  ║                                                            ║');
    console.error('  ║  Khắc phục trên VM:  npm ci   (thiếu gói libheif-js)        ║');
    console.error('  ╚════════════════════════════════════════════════════════════╝');
    console.error(`  Chi tiết: ${heic.reason}`);
    console.error('');
  });
}

module.exports = {
  config,
  directUploadChoUser,
  storeUpload,
  storeBuffer,
  contentDispositionFor,
  alignExt,
  posterKeyFor,
  parseStored,
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
