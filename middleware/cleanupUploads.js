/**
 * Dọn file tạm của multer sau khi response kết thúc — bất kể đi nhánh nào.
 *
 * Vì sao cần: multer ghi file xuống đĩa TRƯỚC khi controller chạy, nhưng
 * `createPost`/`updatePost`/`uploadAttachments` đều có nhiều lệnh `return` sớm
 * (400 nội dung rỗng, 401 thiếu user, 423 nhóm bị khoá…). Mỗi nhánh như vậy
 * thoát ra mà không dọn ⇒ file tạm nằm lại vĩnh viễn trong /tmp.
 *
 * Quan sát thực tế trên UAT 2026-07-29: một POST trả 400 để lại 373 KB trong
 * /tmp/social-uploads/posts/. Với hàng trăm lượt đăng hỏng mỗi ngày, đĩa sẽ đầy
 * âm thầm.
 *
 * Đặt ở tầng route thay vì trong từng controller để endpoint thêm sau này tự
 * động được bảo vệ, không phải nhớ gọi.
 */

const { config } = require('../services/cdn/config');
const { cleanupTempFiles } = require('../services/cdn');

function cleanupUploads(req, res, next) {
  // CDN tắt ⇒ multer ghi thẳng vào ./uploads và file LÀ dữ liệu thật, không được xoá
  if (!config.enabled) return next();

  let done = false;
  const sweep = () => {
    if (done) return;
    done = true;
    // Chạy sau khi response đã gửi xong ⇒ controller chắc chắn đã đọc xong file.
    // Nuốt lỗi: file có thể đã được controller xoá (ENOENT) — đó là trường hợp bình thường.
    cleanupTempFiles(req.files).catch(() => {});
  };

  res.on('finish', sweep);
  res.on('close', sweep);
  next();
}

module.exports = cleanupUploads;
