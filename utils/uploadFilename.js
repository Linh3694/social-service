/**
 * Sửa tên file upload bị lỗi mã hoá (SIS-169).
 *
 * multer 1.x khởi tạo busboy KHÔNG truyền `defParamCharset`
 * (node_modules/multer/lib/make-middleware.js) ⇒ busboy dùng `nullDecoder` cho tham số
 * của Content-Disposition, trong khi header được đọc bằng `latin1Slice`
 * (node_modules/busboy/lib/types/multipart.js). Kết quả: `file.originalname` là bytes
 * UTF-8 bị decode thành latin1 — "Chính sách" thành "ChÃ­nh sÃ¡ch".
 *
 * Không thể truyền option cho busboy qua multer nên phải giải mã lại ở tầng ứng dụng.
 */

/**
 * Trả tên file đã giải mã về UTF-8. Giữ nguyên chuỗi khi không chắc là mojibake.
 *
 * @param {string} raw giá trị `file.originalname` do multer trả về
 * @returns {string}
 */
function decodeMultipartFilename(raw) {
  const name = String(raw || '');
  if (!name) return '';

  // Có ký tự ngoài latin1 ⇒ tên đã được decode đúng (client gửi `filename*` RFC 5987).
  if (Array.from(name).some((ch) => ch.codePointAt(0) > 0xff)) return name;

  const bytes = Buffer.from(name, 'latin1');
  const decoded = bytes.toString('utf8');

  // Round-trip: chỉ nhận kết quả khi chuỗi byte đúng là UTF-8 hợp lệ. Tên ASCII thuần
  // hoặc tên latin1 thật (vd "café.pdf") sẽ không khớp và được giữ nguyên.
  if (Buffer.compare(Buffer.from(decoded, 'utf8'), bytes) !== 0) return name;

  return decoded;
}

/** Có escape percent của byte ngoài ASCII (`%C3`, `%CC`…) ⇒ dấu vết UTF-8 đã bị encode. */
const NON_ASCII_ESCAPE = /%[89a-f][0-9a-f]/i;

/**
 * Chuẩn hoá tên file trước khi LƯU VÀO DB — dùng cho mọi đường nạp đính kèm.
 *
 * Ngoài mojibake latin1 (xem trên), còn gặp tên đã bị percent-encode:
 * "HƯỚNG DẪN SỬ DỤNG.pdf" vào DB thành "HU%CC%9BO%CC%9B%CC%81NG%20DA%CC%82%CC%83N…".
 * Chuỗi này sinh ra khi tên đi qua một URL (đường dẫn file:// trên iOS, tham số
 * `filename*` của Content-Disposition, khoá CDN…) rồi được lấy nguyên xi làm tên
 * file khi người dùng gửi lại. Tên hỏng nằm trong DB nên hiện sai ở MỌI client
 * (app + web, PH lẫn GV) ⇒ chặn ngay tại cửa vào.
 *
 * Chỉ giải mã khi có escape của byte ≥ 0x80, nên tên chứa `%` hợp lệ được giữ
 * nguyên: "Doanh thu 50%.pdf" (decodeURIComponent ném lỗi) và "Bao cao 100%20.pdf"
 * (escape ASCII, không đụng tới).
 *
 * Cuối cùng chuẩn hoá NFC: macOS/iOS đặt tên ở dạng NFD ("Ư" = "U" + dấu móc rời),
 * nhiều font trên Android dựng chồng dấu rất xấu.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeUploadFilename(raw) {
  const name = decodeMultipartFilename(raw);
  if (!name) return '';

  let decoded = name;
  if (NON_ASCII_ESCAPE.test(name)) {
    try {
      decoded = decodeURIComponent(name);
    } catch {
      // Có `%` nhưng không phải percent-encoding hợp lệ ⇒ giữ nguyên.
      decoded = name;
    }
  }

  return decoded.normalize('NFC');
}

module.exports = { decodeMultipartFilename, normalizeUploadFilename };
