/**
 * Endpoint upload trực tiếp lên CDN (Phase 3 — CDN-Design.md §10).
 *
 *   POST /api/social/media/presign    xin presigned PUT
 *   POST /api/social/media/complete   promote staging → bucket đích
 *
 * Client cũ KHÔNG bị ảnh hưởng: đường multipart `POST /api/social` vẫn nguyên.
 * Hai đường chạy song song cho tới khi mọi client đã lên bản mới.
 */

const cdn = require('../services/cdn');
const { describeError } = require('../utils/errorLog');

function loi(res, error, mac_dinh = 'Không xử lý được tệp') {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('[Media] lỗi:', describeError(error));
  return res.status(status).json({
    success: false,
    code: error.code || 'MEDIA_ERROR',
    message: status >= 500 ? mac_dinh : error.message,
  });
}

/**
 * Xin presigned PUT cho một loạt tệp.
 *
 * body: { kind: 'posts'|'chat', files: [{ filename, contentType }] }
 */
exports.presign = async (req, res) => {
  try {
    const { kind = 'posts', files } = req.body || {};
    const ket_qua = await cdn.directUpload.presign(req.user, files, kind);
    return res.json({ success: true, data: { uploads: ket_qua } });
  } catch (error) {
    return loi(res, error, 'Không cấp được đường tải lên');
  }
};

/**
 * Báo đã upload xong → server promote sang bucket đích và chạy pipeline.
 *
 * body: { kind: 'posts'|'chat', stagingKeys: ['<userId>/…'] }
 *
 * Trả về khoá `cdn://…` để client dùng khi tạo bài / gửi tin nhắn. KHÔNG tự tạo
 * bài ở đây: giữ hai việc tách nhau thì client soạn thảo xong mới đăng, và
 * upload lỗi một tệp không kéo đổ cả bài.
 */
exports.complete = async (req, res) => {
  try {
    const { kind = 'posts', stagingKeys } = req.body || {};
    const ds = Array.isArray(stagingKeys) ? stagingKeys : [];
    if (!ds.length) {
      return res.status(400).json({
        success: false,
        code: 'NO_KEYS',
        message: 'Thiếu danh sách tệp đã tải lên',
      });
    }
    if (ds.length > cdn.config.directUpload.maxFiles) {
      return res.status(400).json({
        success: false,
        code: 'TOO_MANY_FILES',
        message: `Tối đa ${cdn.config.directUpload.maxFiles} tệp mỗi lượt`,
      });
    }

    // Tuần tự chứ không song song: promote đọc byte về rồi chạy sharp/ffmpeg.
    // Nhiều tệp cùng lúc trên một process Node sẽ ăn hết CPU và làm chậm feed
    // của mọi người khác — đúng vấn đề P1 mà Phase 3 sinh ra để giảm.
    const ket_qua = [];
    for (const key of ds) {
      ket_qua.push(await cdn.directUpload.promote(req.user, key, kind));
    }

    return res.json({
      success: true,
      data: {
        media: ket_qua.map((r) => ({
          stored: r.stored,
          url: r.url,
          kind: r.kind,
          contentType: r.contentType,
          width: r.width,
          height: r.height,
          size: r.size,
        })),
      },
    });
  } catch (error) {
    return loi(res, error, 'Không hoàn tất được tải lên');
  }
};

/** Cho client biết có nên dùng đường trực tiếp hay quay về multipart. */
exports.capability = (req, res) => {
  // Cùng một hàm với presign/promote — xem ghi chú ở services/cdn/config.js.
  const bat = cdn.directUploadChoUser(req.user);
  return res.json({
    success: true,
    data: {
      directUpload: bat,
      maxFiles: cdn.config.directUpload.maxFiles,
      maxBytes: cdn.config.directUpload.maxBytes,
      // Client cũ không đọc trường này ⇒ vẫn dùng một-lượt-PUT như trước.
      multipart: bat,
      partSize: cdn.directUpload.PART_SIZE,
    },
  });
};

// ── Upload nhiều phần, nối lại được (SIS-181) ─────────────────────────────
//
// Bốn endpoint mỏng: mọi kiểm tra quyền và mọi thao tác S3 nằm ở
// services/cdn/directUpload.js, đây chỉ dịch HTTP ↔ hàm.

/** body: { kind, filename, contentType } → { stagingKey, uploadId, partSize, maxBytes } */
exports.multipartCreate = async (req, res) => {
  try {
    const { kind = 'posts', filename, contentType } = req.body || {};
    const data = await cdn.directUpload.multipartCreate(req.user, { kind, filename, contentType });
    return res.json({ success: true, data });
  } catch (error) {
    return loi(res, error, 'Không mở được phiên tải lên');
  }
};

/** body: { stagingKey, uploadId, partNumbers[] } → { urls: [{ partNumber, url }] } */
exports.multipartSign = async (req, res) => {
  try {
    const data = await cdn.directUpload.multipartSign(req.user, req.body || {});
    return res.json({ success: true, data });
  } catch (error) {
    return loi(res, error, 'Không cấp được đường tải phần');
  }
};

/** body: { stagingKey, uploadId } → { uploaded: [{ partNumber, size }] } — dùng để nối lại. */
exports.multipartStatus = async (req, res) => {
  try {
    const data = await cdn.directUpload.multipartStatus(req.user, req.body || {});
    return res.json({ success: true, data });
  } catch (error) {
    return loi(res, error, 'Không đọc được tiến trình tải lên');
  }
};

/** body: { kind, stagingKey, uploadId } → media (đã promote, giống /complete). */
exports.multipartComplete = async (req, res) => {
  try {
    const { kind = 'posts', stagingKey, uploadId } = req.body || {};
    const r = await cdn.directUpload.multipartComplete(req.user, { stagingKey, uploadId, kind });
    return res.json({
      success: true,
      data: {
        media: {
          stored: r.stored,
          url: r.url,
          kind: r.kind,
          contentType: r.contentType,
          width: r.width,
          height: r.height,
          size: r.size,
        },
      },
    });
  } catch (error) {
    return loi(res, error, 'Không hoàn tất được tải lên');
  }
};

/** body: { stagingKey, uploadId } — huỷ phiên, dọn phần đã lên. */
exports.multipartAbort = async (req, res) => {
  try {
    const data = await cdn.directUpload.multipartAbort(req.user, req.body || {});
    return res.json({ success: true, data });
  } catch (error) {
    return loi(res, error, 'Không huỷ được phiên tải lên');
  }
};
