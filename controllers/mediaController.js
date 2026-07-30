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

function loi(res, error, mac_dinh = 'Không xử lý được tệp') {
  const status = error.statusCode || 500;
  if (status >= 500) console.error('[Media] lỗi:', error);
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
    // Mười tệp cùng lúc trên một process Node sẽ ăn hết CPU và làm chậm feed
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
  const bat = Boolean(cdn.config.enabled && cdn.config.directUpload.enabled);
  return res.json({
    success: true,
    data: {
      directUpload: bat,
      maxFiles: cdn.config.directUpload.maxFiles,
      maxBytes: cdn.config.directUpload.maxBytes,
    },
  });
};
