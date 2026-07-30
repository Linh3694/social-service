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

module.exports = { decodeMultipartFilename };
