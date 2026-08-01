/**
 * Hàng đợi nền transcode video HEVC → H.264 (SIS-174).
 *
 * VẤN ĐỀ. `videoPipeline` chỉ remux `-c copy`, không đổi codec. Video quay bằng
 * iPhone là HEVC/H.265, mà HEVC chỉ phát được trên Safari, trên Chrome/Edge có bộ
 * giải mã của hệ điều hành, và KHÔNG BAO GIỜ phát được trên Firefox hay Windows
 * thiếu gói "HEVC Video Extensions". Những máy đó chỉ thấy một ô đen.
 *
 * VÌ SAO CHẠY NỀN CHỨ KHÔNG TRANSCODE NGAY TRONG REQUEST (phương án (b) đã loại):
 *   • `proxy_read_timeout` mặc định của nginx là 60s, transcode một video 4K dài
 *     một phút mất 1–3 phút ⇒ 504 trước khi ffmpeg kịp xong.
 *   • Người gửi phải giữ tab mở suốt; rớt mạng 4G là mất video, gửi lại từ đầu.
 * Chạy nền thì tin nhắn hiện NGAY với bản gốc — ai có codec xem được luôn — và bản
 * H.264 thay vào chỗ đó vài phút sau, đẩy qua socket nên không phải F5.
 *
 * VÌ SAO IN-PROCESS CHỨ KHÔNG THÊM ENTRY VÀO ecosystem-cron.config.js — giống hệt
 * lý do của `pollScheduler`: worker phải phát socket, mà `global.io` chỉ tồn tại
 * trong tiến trình app. `ecosystem.config.js` để `instances: 1` nên không có hai
 * tiến trình cùng chạy; dù vậy job vẫn được "giành" bằng một update nguyên tử trên
 * chính document, nên nhân bản thêm instance sau này cũng không transcode trùng.
 *
 * MỘT JOB MỘT LÚC. Transcode ăn gần trọn CPU. Chạy song song sẽ làm chậm chat của
 * mọi người để đổi lấy việc vài video xong sớm hơn — không đáng.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const MediaTranscodeJob = require('../models/MediaTranscodeJob');
const ChatMessage = require('../models/ChatMessage');
const ChatConversation = require('../models/ChatConversation');
const Post = require('../models/Post');
const cdn = require('./cdn');
const s3 = require('./cdn/s3');
const { codecAnToan, transcodeToH264 } = require('./cdn/videoPipeline');
const { getChatBroadcastRooms, ioEmitToEachRoom } = require('../utils/chatBroadcastRooms');
const { describeError } = require('../utils/errorLog');

const DEFAULT_INTERVAL_MS = Number(process.env.CDN_TRANSCODE_POLL_MS || 30 * 1000);
/**
 * Hết lượt thử là dừng hẳn ở `failed`, KHÔNG thử lại vô hạn. File mà ffmpeg không
 * đọc nổi thì lần thứ mười cũng thế; video gốc vẫn phục vụ bình thường.
 */
const MAX_ATTEMPTS = 3;

let timer = null;
/** Chặn hai tick chồng nhau khi một video dài hơn chu kỳ quét (chuyện thường). */
let running = false;

function log(...args) {
  console.log('[Transcode]', ...args);
}

/**
 * Xếp job nếu video dùng codec không phổ biến. Gọi từ `storeUpload`/`promote` —
 * tức đúng ranh giới "vừa upload xong", không gọi từ `storeBuffer` để script
 * backfill và bộ test dùng lại pipeline mà không vô tình sinh job.
 *
 * KHÔNG BAO GIỜ throw: hàng đợi hỏng thì cùng lắm là video không được transcode,
 * tuyệt đối không được làm hỏng lượt gửi tin của người dùng.
 *
 * @param {{kind?: string, stored?: string, videoCodec?: string|null}} ketQua kết quả storeBuffer
 * @param {'chat'|'posts'} kind
 */
async function enqueueIfNeeded(ketQua, kind) {
  try {
    if (!ketQua || ketQua.kind !== 'video' || !ketQua.stored) return;
    if (codecAnToan(ketQua.videoCodec)) return;
    if (kind !== 'chat' && kind !== 'posts') return;

    // `$setOnInsert` + upsert: khoá là hash nội dung nên hai người gửi cùng một
    // video chỉ sinh MỘT job, và gửi lại video đã transcode xong không reset job cũ.
    await MediaTranscodeJob.updateOne(
      { stored: ketQua.stored },
      { $setOnInsert: { stored: ketQua.stored, kind, codec: ketQua.videoCodec || '', status: 'pending' } },
      { upsert: true },
    );
    log(`xếp hàng ${ketQua.videoCodec} → h264: ${ketQua.stored}`);
  } catch (error) {
    console.error('[Transcode] không xếp được hàng đợi:', describeError(error));
  }
}

/** Trỏ mọi tin nhắn đang dùng khoá cũ sang khoá mới, rồi đẩy socket cho ai đang mở. */
async function capNhatChat(cu, moi) {
  const truoc = await ChatMessage.find({ 'attachments.url': cu }, { conversation: 1 }).lean();
  if (!truoc.length) return 0;

  await ChatMessage.updateMany(
    { 'attachments.url': cu },
    {
      $set: {
        'attachments.$[el].url': moi.stored,
        'attachments.$[el].mimeType': 'video/mp4',
        'attachments.$[el].size': moi.size,
        // Suy khoá poster y như lúc upload (sanitizeIncomingAttachments) để hai
        // đường không lệch nhau. Suy "mù" chứ không dùng `moi.posterStored`: khi
        // ffmpeg vắng mặt thì poster không được sinh, và ta muốn hành vi giống hệt
        // đường upload — poster không tồn tại thì thẻ <video> lặng lẽ bỏ qua.
        'attachments.$[el].posterUrl': cdn.posterKeyFor(moi.stored) || '',
      },
    },
    { arrayFilters: [{ 'el.url': cu }] },
  );

  if (!global.io) return truoc.length;

  // Đẩy NGUYÊN mảng attachments đã cập nhật, không đẩy "url cũ → url mới": URL mà
  // client đang giữ là URL ĐÃ KÝ, còn ta chỉ biết khoá `cdn://`, hai thứ không so
  // khớp được. Client thay theo messageId là chắc chắn đúng.
  const idHoiThoai = [...new Set(truoc.map((m) => String(m.conversation)))];
  for (const convId of idHoiThoai) {
    const conversation = await ChatConversation.findById(convId).lean();
    if (!conversation) continue;
    const tinNhan = await ChatMessage.find(
      { conversation: convId, 'attachments.url': moi.stored },
      { attachments: 1 },
    ).lean();
    for (const m of tinNhan) {
      ioEmitToEachRoom(global.io, getChatBroadcastRooms(conversation), 'chat:message:media_updated', {
        conversationId: String(convId),
        messageId: String(m._id),
        attachments: m.attachments,
      });
    }
  }
  return truoc.length;
}

/**
 * Trỏ bài đăng sang khoá mới.
 *
 * KHÔNG đẩy socket: `NewfeedSocket` hiện chỉ có `broadcastNewPost`, chưa có sự kiện
 * "bài đăng đã đổi". Người đang mở feed sẽ thấy bản mới ở lần tải lại kế tiếp — ghi
 * rõ ở đây để không ai tưởng đã có realtime cho feed.
 */
async function capNhatPost(cu, moi) {
  const r = await Post.updateMany(
    { videos: cu },
    { $set: { 'videos.$[el]': moi.stored } },
    { arrayFilters: [{ el: cu }] },
  );
  return r.modifiedCount || 0;
}

/**
 * Lấy MỘT job và xử lý.
 * @returns {Promise<boolean>} true nếu có job được xử lý (để tick gọi tiếp)
 */
async function xuLyMotJob() {
  const job = await MediaTranscodeJob.findOneAndUpdate(
    { status: 'pending', attempts: { $lt: MAX_ATTEMPTS } },
    { $set: { status: 'running', startedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
  if (!job) return false;

  const that_bai = async (ly_do) => {
    const conThu = job.attempts < MAX_ATTEMPTS;
    await MediaTranscodeJob.updateOne(
      { _id: job._id },
      { $set: { status: conThu ? 'pending' : 'failed', lastError: String(ly_do).slice(0, 500), finishedAt: new Date() } },
    );
    console.error(`[Transcode] ${conThu ? 'lỗi, sẽ thử lại' : 'THẤT BẠI HẲN'} (${job.attempts}/${MAX_ATTEMPTS}) ${job.stored}: ${ly_do}`);
  };

  try {
    const bo = cdn.parseStored(job.stored);
    if (!bo || !bo.kind) {
      await that_bai('khoá không nhận dạng được');
      return true;
    }

    log(`bắt đầu ${job.codec || '?'} → h264: ${job.stored}`);
    const t0 = Date.now();

    const { buffer } = await s3.getObjectBuffer({ bucket: bo.bucket, key: bo.key });

    // ffmpeg cần đường dẫn file. Ghi tạm rồi dọn — cùng cách `storeBuffer` làm ở
    // nhánh upload trực tiếp.
    const tam = path.join(os.tmpdir(), `cdn-tc-${crypto.randomBytes(8).toString('hex')}`);
    await fs.writeFile(tam, buffer);

    let ketQuaTranscode;
    try {
      ketQuaTranscode = await transcodeToH264(tam);
    } finally {
      await fs.unlink(tam).catch(() => {});
    }

    if (!ketQuaTranscode.ok) {
      await that_bai(ketQuaTranscode.reason || 'transcode thất bại');
      return true;
    }

    // Đi qua đúng `storeBuffer` như mọi upload khác ⇒ có faststart, có poster, có
    // khoá theo hash nội dung. Gọi storeBuffer (không phải storeUpload) nên không
    // sinh job mới — dù codec đầu ra là h264 nên có gọi cũng không xếp thêm.
    const moi = await cdn.storeBuffer(ketQuaTranscode.buffer, {
      kind: bo.kind,
      originalname: 'video.mp4',
      mimetype: 'video/mp4',
    });

    const refs = bo.kind === 'chat'
      ? await capNhatChat(job.stored, moi)
      : await capNhatPost(job.stored, moi);

    await MediaTranscodeJob.updateOne(
      { _id: job._id },
      { $set: { status: 'done', newStored: moi.stored, refsUpdated: refs, lastError: '', finishedAt: new Date() } },
    );

    const giay = ((Date.now() - t0) / 1000).toFixed(0);
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    log(`xong sau ${giay}s — ${mb(buffer.length)}MB → ${mb(moi.size)}MB, cập nhật ${refs} bản ghi`);
    return true;
  } catch (error) {
    await that_bai(describeError(error));
    return true;
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // Làm liên tục cho tới khi hết job — không đợi tick sau, vì một tồn đọng sau
    // đợt deploy có thể có hàng chục video.
    // eslint-disable-next-line no-await-in-loop -- CỐ Ý tuần tự: một job một lúc
    while (await xuLyMotJob()) { /* tiếp job kế */ }
  } catch (error) {
    console.error('[Transcode] tick lỗi:', describeError(error));
  } finally {
    running = false;
  }
}

function startTranscodeScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  log(`bật — quét mỗi ${Math.round(intervalMs / 1000)}s, tối đa ${MAX_ATTEMPTS} lượt thử/job`);
  timer = setInterval(() => { void tick(); }, intervalMs);
  if (timer.unref) timer.unref();
  void tick();
}

function stopTranscodeScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  enqueueIfNeeded,
  startTranscodeScheduler,
  stopTranscodeScheduler,
  // Xuất để test gọi trực tiếp, không phải đợi hết một chu kỳ.
  xuLyMotJob,
  capNhatChat,
  capNhatPost,
};
