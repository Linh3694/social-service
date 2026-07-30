/**
 * Pipeline ảnh: strip EXIF → resize → WebP → variants.
 *
 * Đây là hạng mục ROI cao nhất của cả kế hoạch (CDN-Design.md §7.1): ảnh điện
 * thoại 3,5 MB xuống ~350 KB, thumbnail feed ~110 KB — feed nhanh hơn ~33 lần
 * trên 4G, đồng thời loại toạ độ GPS khỏi ảnh học sinh (P5).
 */

const { config } = require('./config');

let sharpLib;
let sharpUnavailableReason = null;

function getSharp() {
  if (sharpLib === undefined) {
    try {
      sharpLib = require('sharp');
    } catch (error) {
      sharpLib = null;
      sharpUnavailableReason = error.message;
      console.error('[cdn] sharp không nạp được, ảnh sẽ upload nguyên bản:', error.message);
    }
  }
  return sharpLib;
}

/**
 * Kiểm tra sharp NGAY lúc khởi động, không đợi user upload.
 *
 * Vì sao quan trọng: `processImage` nuốt lỗi có chủ ý để một ảnh hỏng không làm
 * mất cả bài đăng. Nhưng nếu sharp không nạp được thì MỌI ảnh đều rơi vào nhánh
 * đó — và hỏng âm thầm theo hướng nguy hiểm nhất: ảnh lưu nguyên bản ⇒ **EXIF
 * GPS KHÔNG bị loại** (P5), dung lượng không giảm. Service vẫn xanh, upload vẫn
 * 200, chỉ có toạ độ ảnh học sinh là vẫn nằm trong file.
 *
 * `sharp` là native binary: cài trên macOS rồi copy `node_modules` sang VM Linux
 * là dính đúng bẫy này. Phải `npm rebuild sharp` trên chính VM (§13).
 */
function selfTest() {
  const sharp = getSharp();
  if (!sharp) {
    return { ok: false, reason: sharpUnavailableReason || 'sharp không khả dụng' };
  }
  try {
    return { ok: true, versions: sharp.versions };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * `.rotate()` PHẢI đứng trước khi ghi WebP.
 *
 * Strip EXIF làm mất cờ orientation; nếu không áp orientation trước thì ảnh
 * chụp dọc bằng iPhone sẽ bị xoay ngang. Lỗi này chỉ lộ ra khi user thật dùng
 * (§7.1, §13).
 */
function basePipeline(sharp, input) {
  return sharp(input, { failOn: 'none' }).rotate();
}

/**
 * @param {Buffer} input
 * @returns {Promise<{ok: boolean, main?: {buffer: Buffer, ext: string, contentType: string, width: number, height: number}, variants?: Array<{suffix: string, buffer: Buffer, ext: string, contentType: string}>, reason?: string}>}
 */
async function processImage(input) {
  const sharp = getSharp();
  if (!sharp) {
    return { ok: false, reason: sharpUnavailableReason || 'sharp không khả dụng' };
  }

  try {
    const { maxWidth, quality, variants } = config.image;

    const mainBuffer = await basePipeline(sharp, input)
      .resize({ width: maxWidth, height: maxWidth, fit: 'inside', withoutEnlargement: true })
      // sharp mặc định KHÔNG copy metadata ⇒ EXIF/GPS bị loại.
      // Đừng gọi .withMetadata(), sẽ giữ lại toạ độ chụp.
      .webp({ quality, effort: 4 })
      .toBuffer();

    const meta = await sharp(mainBuffer).metadata();

    const variantOut = [];
    for (const width of variants) {
      // Không phóng to ảnh nhỏ hơn variant — vừa phí dung lượng vừa xấu
      if (meta.width && meta.width <= width) continue;
      const buffer = await basePipeline(sharp, input)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      variantOut.push({ suffix: `_w${width}`, buffer, ext: 'webp', contentType: 'image/webp' });
    }

    return {
      ok: true,
      main: {
        buffer: mainBuffer,
        ext: 'webp',
        contentType: 'image/webp',
        width: meta.width,
        height: meta.height,
      },
      variants: variantOut,
    };
  } catch (error) {
    // Ảnh HEIC thiếu libheif, ảnh hỏng… — KHÔNG throw, để bài đăng vẫn tạo
    // được với file gốc (§13). Thà ảnh nặng còn hơn mất bài.
    console.error('[cdn] xử lý ảnh thất bại, giữ nguyên bản gốc:', error.message);
    return { ok: false, reason: error.message };
  }
}

module.exports = { processImage, selfTest };
