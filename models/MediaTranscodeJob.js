/**
 * Hàng đợi transcode video (SIS-174).
 *
 * VÌ SAO TRẠNG THÁI NẰM Ở COLLECTION RIÊNG, KHÔNG NẰM TRÊN TIN NHẮN/BÀI ĐĂNG.
 * `Post.videos` là mảng CHUỖI thuần (`[String]`) — không có chỗ nào gắn trạng thái
 * cho từng video mà không phải đổi schema và migrate dữ liệu cũ. Đặt job ra ngoài
 * thì một cơ chế phục vụ được cả chat lẫn bài đăng, và khoá `cdn://` (vốn là hash
 * nội dung, duy nhất toàn hệ thống) làm khoá tự nhiên: hai người gửi CÙNG một
 * video chỉ sinh một job.
 *
 * Vòng đời: pending → running → done | failed
 * `failed` là trạng thái CUỐI có chủ ý — video gốc vẫn phục vụ bình thường, chỉ là
 * người xem thiếu codec sẽ không phát được. Thà dừng lại và để lại dấu vết trong
 * DB còn hơn thử lại vô hạn một file mà ffmpeg không đọc nổi.
 */

const mongoose = require('mongoose');

const mediaTranscodeJobSchema = new mongoose.Schema(
  {
    /** Khoá `cdn://social-chat/…` của video GỐC. Duy nhất ⇒ không xếp trùng job. */
    stored: { type: String, required: true, unique: true, trim: true },
    /** Bucket đích — cần để đọc lại byte và để ghi bản mới vào đúng chỗ. */
    kind: { type: String, enum: ['chat', 'posts'], required: true },
    /** Codec ffprobe đo được lúc upload ('hevc', 'mpeg4'…). Giữ lại để về sau còn thống kê. */
    codec: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'done', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: '' },
    /** Khoá `cdn://` của bản H.264 sau khi xong. */
    newStored: { type: String, default: '', trim: true },
    /** Số bản ghi (tin nhắn/bài đăng) đã được trỏ sang khoá mới. */
    refsUpdated: { type: Number, default: 0 },
    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

/** Worker lấy job cũ nhất đang chờ — index này phục vụ đúng truy vấn đó. */
mediaTranscodeJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('MediaTranscodeJob', mediaTranscodeJobSchema);
