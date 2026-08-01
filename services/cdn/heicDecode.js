/**
 * Giải mã HEIC/HEIF cho pipeline ảnh (SIS-172).
 *
 * VÌ SAO CẦN FILE NÀY. `sharp` bản prebuilt KHÔNG giải mã được HEIC: libheif đi
 * kèm nó chỉ được build cho AVIF, phần HEVC bị bỏ vì lý do bằng sáng chế. Kiểm
 * chứng nhanh trên đúng version đang dùng (0.33.5):
 *
 *   sharp.format.heif.input.fileSuffix  →  ['.avif']          (không có .heic)
 *   sharp(<file .heic thật>).toBuffer() →  "source: bad seek"
 *
 * Hệ quả trước khi có file này (SIS-171): processImage() ném lỗi → storeBuffer()
 * rơi vào nhánh giữ nguyên bản gốc → object trên CDN là .heic → KHÔNG trình
 * duyệt nào ngoài Safari hiển thị được. Upload vẫn trả 200, tin nhắn vẫn nằm
 * trong hội thoại, chỉ ảnh là ô trắng. Người gửi dùng iPhone/Safari thấy bình
 * thường nên không ai biết bên nhận không xem được.
 *
 * VÌ SAO WASM CHỨ KHÔNG REBUILD SHARP. Đường còn lại là build libvips global
 * kèm libheif+libde265 rồi `npm rebuild sharp` trên VM. Nhanh hơn thật, nhưng
 * buộc mọi VM mới phải lặp đúng quy trình build đó — cùng loại bẫy đã khiến
 * sharp hỏng âm thầm ở CDN-Design.md §13. Bản WASM đi theo node_modules, `npm ci`
 * là xong, không có bước thủ công nào để quên.
 *
 * ORIENTATION — điểm dễ sai nhất. Ảnh iPhone chụp dọc lưu chiều xoay trong thuộc
 * tính `irot` của HEIF chứ không phải EXIF. libheif áp `irot` ngay lúc giải mã,
 * và `heif_image_handle_get_width/height` trả kích thước SAU khi đã áp — nên
 * pixel lấy ra đã đúng chiều, không cần đọc EXIF. Đổi lại, RGBA thô không mang
 * metadata ⇒ `.rotate()` ở basePipeline thành no-op (đúng ý, không xoay hai lần),
 * và EXIF/GPS bị loại ngay từ khâu giải mã: nhánh HEIC không thể lọt toạ độ chụp
 * kể cả khi sau này có ai lỡ thêm `.withMetadata()`.
 * Lưu ý khi kiểm thử: file .heic tạo bằng `sips` trên macOS đã nướng sẵn chiều
 * xoay vào pixel nên KHÔNG chứng minh được nhánh `irot` — phải test bằng ảnh dọc
 * chụp từ iPhone thật.
 */

/**
 * Major brand của ftyp — xem ISO/IEC 23008-12.
 * `mif1`/`msf1` là brand chung của HEIF, dùng cho cả HEIC lẫn AVIF ⇒ xử lý riêng
 * bên dưới, không đưa vào đây.
 */
const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);

/** Brand HEIF chung — phải soi thêm compatible brands mới biết HEIC hay AVIF. */
const BRANDS_CHUNG = new Set(['mif1', 'msf1']);

/** AVIF cũng là HEIF nhưng sharp đọc được ⇒ để nguyên cho sharp, đừng cướp việc. */
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** Đọc danh sách compatible brands trong box `ftyp`. */
function compatibleBrands(buffer) {
  const boxSize = buffer.readUInt32BE(0);
  const end = Math.min(boxSize > 0 ? boxSize : buffer.length, buffer.length);
  const out = [];
  for (let i = 16; i + 4 <= end; i += 4) {
    out.push(buffer.toString('latin1', i, i + 4));
  }
  return out;
}

/**
 * File này có phải HEIC không — nhận theo magic bytes, KHÔNG theo mimetype hay
 * đuôi file. Lý do: đường upload trực tiếp đặt tên object theo stagingKey và lấy
 * Content-Type do client khai, cả hai đều không đáng tin.
 *
 * @param {Buffer} buffer
 */
function isHeic(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  if (buffer.toString('latin1', 4, 8) !== 'ftyp') return false;

  const major = buffer.toString('latin1', 8, 12);
  if (AVIF_BRANDS.has(major)) return false;
  if (HEIC_BRANDS.has(major)) return true;
  if (!BRANDS_CHUNG.has(major)) return false;

  const brands = compatibleBrands(buffer);
  if (brands.some((b) => AVIF_BRANDS.has(b))) return false;
  return brands.some((b) => HEIC_BRANDS.has(b) || BRANDS_CHUNG.has(b));
}

let libheifLib;
let libheifUnavailableReason = null;

function getLibheif() {
  if (libheifLib === undefined) {
    try {
      libheifLib = require('libheif-js/wasm-bundle');
    } catch (error) {
      libheifLib = null;
      libheifUnavailableReason = error.message;
      console.error('[cdn] libheif không nạp được, ảnh HEIC sẽ giữ nguyên bản:', error.message);
    }
  }
  return libheifLib;
}

/**
 * MỘT decoder dùng chung + xếp hàng tuần tự. Đây là ràng buộc của thư viện,
 * không phải lựa chọn phong cách:
 *
 *   • `HeifDecoder.decode()` giải phóng context của lần decode TRƯỚC ĐÓ. Tạo
 *     decoder mới cho mỗi ảnh ⇒ context cũ không bao giờ được giải phóng ⇒ rò
 *     bộ nhớ trong heap WASM.
 *   • Dùng chung một decoder thì hai lượt decode KHÔNG được chồng nhau, vì lượt
 *     sau sẽ giải phóng đúng context lượt trước đang đọc. Mà chồng nhau là chắc
 *     chắn xảy ra: đường multipart chạy `Promise.all` trên từng file
 *     (chatController.js:1635, postController.js:550) ⇒ phải xếp hàng.
 *
 * Tuần tự cũng là hàng rào tài nguyên có ích: ảnh 12MP chiếm ~48MB RGBA, chạy
 * song song 10 ảnh là 480MB.
 */
let decoderDungChung = null;
let hangDoi = Promise.resolve();

function xepHang(fn) {
  // `then(fn, fn)` chứ không phải `then(fn)`: một ảnh hỏng làm lượt trước reject
  // thì lượt sau vẫn phải được chạy, không được kẹt hàng đợi vĩnh viễn.
  const ketQua = hangDoi.then(fn, fn);
  hangDoi = ketQua.then(() => {}, () => {});
  return ketQua;
}

/**
 * Giải mã HEIC → RGBA thô để đưa thẳng vào sharp.
 *
 * Trả RGBA thô chứ không phải JPEG trung gian: bớt được một vòng nén-giải nén,
 * nghĩa là nhanh hơn và ảnh chỉ chịu ĐÚNG MỘT lần nén mất dữ liệu (bước WebP
 * cuối), thay vì hai.
 *
 * @param {Buffer} input
 * @returns {Promise<{data: Buffer, width: number, height: number, channels: 4}>}
 */
async function decodeToRaw(input) {
  const libheif = getLibheif();
  if (!libheif) {
    throw new Error(libheifUnavailableReason || 'libheif không khả dụng');
  }

  return xepHang(async () => {
    if (!decoderDungChung) decoderDungChung = new libheif.HeifDecoder();

    const images = decoderDungChung.decode(input);
    if (!images || !images.length) {
      throw new Error('libheif không đọc được ảnh nào trong file');
    }

    // Ảnh đầu tiên là ảnh chính. File từ iPhone có thể chứa nhiều ảnh (Live Photo,
    // burst, ảnh phụ độ phân giải thấp) — ta chỉ lấy ảnh chính như mọi trình xem ảnh.
    const image = images[0];
    try {
      const width = image.get_width();
      const height = image.get_height();
      if (!width || !height) {
        throw new Error(`kích thước ảnh không hợp lệ: ${width}x${height}`);
      }

      const imageData = {
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      };
      await new Promise((resolve, reject) => {
        // `display()` gọi callback với `null` khi giải mã thất bại.
        image.display(imageData, (out) => {
          if (out) resolve(out);
          else reject(new Error('libheif giải mã thất bại'));
        });
      });

      return {
        // Bọc Buffer quanh cùng ArrayBuffer, không sao chép lại vài chục MB.
        data: Buffer.from(imageData.data.buffer, imageData.data.byteOffset, imageData.data.length),
        width,
        height,
        channels: 4,
      };
    } finally {
      // Giải phóng MỌI handle, kể cả ảnh phụ không dùng tới.
      for (const im of images) {
        try {
          im.free();
        } catch {
          /* handle có thể đã được giải phóng — bỏ qua */
        }
      }
    }
  });
}

/**
 * Ảnh HEIC 64x32 thật (499 byte, tạo bằng `sips -s format heic`) nhúng thẳng vào
 * mã nguồn để `selfTest()` chạy được ĐẦU-CUỐI mà không cần file phụ hay mạng.
 *
 * Vì sao phải là ảnh thật: chỉ kiểm tra `require()` thành công là chưa đủ — WASM
 * nạp được nhưng giải mã hỏng vẫn rơi vào đúng nhánh fallback im lặng đã gây ra
 * SIS-171.
 */
const TINY_HEIC_B64 = [
  'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABhm1ldGEAAAAAAAAAIWhkbHIA',
  'AAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAA',
  'AAABAAAADnBpdG0AAAAAAAEAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAOZp',
  'cHJwAAAAxWlwY28AAAATY29scm5jbHgAAgACAAaAAAAADGNsbGkAywBAAAAAFGlzcGUAAAAAAAAA',
  'QAAAACAAAAAJaXJvdAAAAAAQcGl4aQAAAAADCAgIAAAAcWh2Y0MBA3AAAACwAAAAAAAe8AD8/fj4',
  'AAALA6AAAQAXQAEMAf//A3AAAAMAsAAAAwAAAwAecCShAAEAI0IBAQNwAAADALAAAAMAAAMAHqAU',
  'IEHBjCOIe5FlU3AgIGAIogABAAlEAcBhcshAUyQAAAAZaXBtYQAAAAAAAAABAAEGgQIDBYaEAAAA',
  'Hmlsb2MAAAAARAAAAQABAAAAAQAAAboAAAA5AAAAAW1kYXQAAAAAAAAASQAAADUoAa+i8kaBfP/s',
  'D//+CX7L61YPsNrRL8q++Zvf/2V0/p/9O3DKiX5V98ze//sq97KkU2dh/A==',
].join('');

/** Buffer của ảnh mẫu — dùng lại trong bộ test tự động. */
function tinyHeicBuffer() {
  return Buffer.from(TINY_HEIC_B64, 'base64');
}

/**
 * Kiểm tra decoder NGAY lúc khởi động, không đợi user upload — cùng lý do với
 * `imagePipeline.selfTest()`: nhánh HEIC hỏng thì hỏng âm thầm.
 *
 * @returns {Promise<{ok: boolean, width?: number, height?: number, reason?: string}>}
 */
async function selfTest() {
  try {
    const raw = await decodeToRaw(tinyHeicBuffer());
    if (raw.width !== 64 || raw.height !== 32) {
      return { ok: false, reason: `giải mã ra ${raw.width}x${raw.height}, kỳ vọng 64x32` };
    }
    return { ok: true, width: raw.width, height: raw.height };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

module.exports = { isHeic, decodeToRaw, selfTest, tinyHeicBuffer };
