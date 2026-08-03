/**
 * Pipeline video: remux `+faststart` + sinh poster.
 *
 * CDN-Design.md §7.3 Phase 1 — rẻ, không re-encode:
 *
 *   ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4
 *   ffmpeg -i in.mp4 -ss 1 -vframes 1 -vf scale=480:-1 poster.webp
 *
 * `+faststart` đẩy moov atom lên đầu file. Không có nó, trình phát phải tải
 * gần hết file mới bắt đầu phát được — với video 100 MB trên 4G của phụ huynh
 * thì gần như không xem được. `-c copy` nghĩa là chỉ sắp xếp lại container,
 * không giải mã lại, nên tốn khoảng một giây cho video vài chục MB.
 *
 * Poster giúp feed không bị khoảng trắng trong lúc chờ, và là thứ duy nhất
 * hiển thị nếu người dùng không bấm phát.
 *
 * KHÔNG transcode 720p ở bước này (§7.3 Phase 2). Transcode ăn 100% CPU nhiều
 * phút cho mỗi video và cần một hàng đợi riêng; chỉ đáng làm nếu video chat
 * vượt ~0,5 GB/ngày.
 */

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Video dài/lớn có thể remux lâu; cắt để một file hỏng không giữ mãi tiến trình.
const TIMEOUT_MS = 120_000;
const POSTER_WIDTH = 480;

/**
 * Transcode (SIS-174) đắt hơn remux hàng trăm lần nên có trần riêng, rộng hơn nhiều.
 * Chạy ở worker nền chứ không trong request nên kéo dài không ảnh hưởng ai.
 */
// SIS-181 nâng trần upload lên 1GB ⇒ đầu vào có thể lớn gấp 10 lần trước.
// Hết 30 phút mà chưa xong thì gần như chắc chắn là kẹt, không phải chậm.
const TRANSCODE_TIMEOUT_MS = Number(process.env.CDN_TRANSCODE_TIMEOUT_MS || 30 * 60 * 1000);

/**
 * Hạ độ phân giải khi transcode. H.264 kém hiệu quả hơn HEVC khoảng 40-50% ở cùng
 * chất lượng, nên giữ nguyên 4K sẽ cho ra file LỚN HƠN HẲN bản gốc — vừa tốn đĩa
 * vừa tốn băng thông của phụ huynh. 1080p là mức vừa đủ cho video xem trong chat.
 * Video thấp hơn ngưỡng này KHÔNG bị phóng to.
 */
const TRANSCODE_MAX_HEIGHT = Number(process.env.CDN_TRANSCODE_MAX_HEIGHT || 1080);

/**
 * Trần khung hình/giây (SIS-181). 60fps gấp đôi số khung so với 30fps ⇒ gần gấp
 * đôi dung lượng cho một thứ gần như không ai nhận ra trên video lớp học. Khớp
 * với mức client web nén trước khi gửi để hai đường cho ra cùng một dạng.
 */
const TRANSCODE_MAX_FPS = Number(process.env.CDN_TRANSCODE_MAX_FPS || 30);

/** Codec trình duyệt nào cũng phát được — thấy codec này thì không cần đụng vào. */
const CODEC_AN_TOAN = new Set(['h264', 'vp8', 'vp9', 'av1']);

let ffmpegAvailable;
let ffprobeAvailable;

function run(bin, args, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin}: ${err.message} ${String(stderr).slice(-300)}`));
      resolve(stdout);
    });
  });
}

/** Kiểm tra một lần rồi nhớ — tránh gọi ffmpeg mỗi lần upload chỉ để hỏi có tồn tại không. */
async function hasFfmpeg() {
  if (ffmpegAvailable === undefined) {
    try {
      await run('ffmpeg', ['-version']);
      ffmpegAvailable = true;
    } catch {
      ffmpegAvailable = false;
      console.warn('[cdn] khong tim thay ffmpeg — video se upload nguyen ban, khong co faststart/poster');
    }
  }
  return ffmpegAvailable;
}

/** ffprobe đi kèm ffmpeg nhưng vẫn kiểm riêng — có bản đóng gói thiếu nó. */
async function hasFfprobe() {
  if (ffprobeAvailable === undefined) {
    try {
      await run('ffprobe', ['-version']);
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = false;
      console.warn('[cdn] khong tim thay ffprobe — khong do duoc codec video, bo qua transcode');
    }
  }
  return ffprobeAvailable;
}

function tmpPath(ext) {
  return path.join(os.tmpdir(), `cdn-vid-${crypto.randomBytes(8).toString('hex')}.${ext}`);
}

/**
 * Codec của luồng video đầu tiên: 'h264', 'hevc', 'vp9'… hoặc null nếu không đo được.
 * Không bao giờ throw — không đo được thì coi như không biết, và "không biết" phải
 * dẫn tới KHÔNG làm gì, chứ không phải transcode bừa.
 */
async function probeVideoCodec(inputPath) {
  if (!(await hasFfprobe())) return null;
  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nw=1:nk=1',
      inputPath,
    ]);
    const codec = String(out).trim().split('\n')[0].trim().toLowerCase();
    return codec || null;
  } catch (error) {
    console.warn('[cdn] khong do duoc codec video:', error.message);
    return null;
  }
}

/** Codec này trình duyệt nào cũng phát được ⇒ không cần transcode. */
function codecAnToan(codec) {
  return !codec || CODEC_AN_TOAN.has(String(codec).toLowerCase());
}

/**
 * Số khung hình/giây của luồng video, hoặc null nếu không đo được.
 * ffprobe trả phân số ("60000/1001", "30/1") chứ không trả số thập phân.
 */
async function probeFps(inputPath) {
  if (!(await hasFfprobe())) return null;
  try {
    const out = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-of', 'default=nw=1:nk=1',
      inputPath,
    ]);
    const raw = String(out).trim().split('\n')[0].trim();
    const [tu, mau] = raw.split('/');
    const fps = Number(mau) ? Number(tu) / Number(mau) : Number(tu);
    return Number.isFinite(fps) && fps > 0 ? fps : null;
  } catch {
    return null;
  }
}

/**
 * Chuyển video sang H.264/AAC trong MP4 — chạy ở worker nền (SIS-174).
 *
 * Ba tham số dưới đây đều là bắt buộc chứ không phải tuỳ chọn:
 *
 *   `-pix_fmt yuv420p` — iPhone quay HDR ra HEVC 10-bit. Không ép về 8-bit thì
 *   libx264 xuất yuv420p10le, mà H.264 High 10 profile thì Chrome/Firefox KHÔNG
 *   giải mã được. Thiếu dòng này là transcode xong vẫn không xem được — đúng thứ
 *   ta đang đi sửa, chỉ đổi tên codec.
 *
 *   `-vf scale` giới hạn chiều cao — xem ghi chú ở TRANSCODE_MAX_HEIGHT.
 *
 *   `-movflags +faststart` — cùng lý do với nhánh remux (§7.3).
 *
 * @returns {Promise<{ok: boolean, buffer?: Buffer, reason?: string}>} không bao giờ throw
 */
async function transcodeToH264(inputPath) {
  if (!(await hasFfmpeg())) {
    return { ok: false, reason: 'ffmpeg khong co san' };
  }

  const outPath = tmpPath('mp4');
  try {
    // `-2` để chiều rộng luôn chẵn (yêu cầu của yuv420p); `min(h,MAX)` nên video
    // thấp hơn ngưỡng giữ nguyên, không bị phóng to.
    const filters = [`scale=-2:'min(${TRANSCODE_MAX_HEIGHT},ih)'`];

    // Hạ fps CHỈ khi nguồn cao hơn trần (SIS-181). Đo trước rồi mới quyết định,
    // chứ không đặt `-r 30` vô điều kiện: nguồn 24fps mà ép lên 30 thì ffmpeg
    // NHÂN BẢN khung hình — file to thêm mà chẳng mượt hơn chút nào.
    const fps = await probeFps(inputPath);
    if (fps && fps > TRANSCODE_MAX_FPS + 0.5) {
      filters.push(`fps=${TRANSCODE_MAX_FPS}`);
    }

    await run('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', inputPath,
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outPath,
    ], TRANSCODE_TIMEOUT_MS);
    const buffer = await fs.readFile(outPath);
    return { ok: true, buffer };
  } catch (error) {
    console.error('[cdn] transcode that bai:', error.message);
    return { ok: false, reason: error.message };
  } finally {
    await unlinkQuiet(outPath);
  }
}

async function unlinkQuiet(p) {
  try { await fs.unlink(p); } catch { /* đã bị xoá — bỏ qua */ }
}

/**
 * @param {string} inputPath đường dẫn file video tạm
 * @param {string} ext đuôi file gốc
 * @returns {Promise<{buffer?: Buffer, poster?: Buffer, remuxed: boolean, reason?: string}>}
 *
 * Không bao giờ throw: video là nội dung người dùng, một file lạ không được
 * làm hỏng cả bài đăng. Lỗi ⇒ trả `remuxed: false` và người gọi dùng bản gốc.
 */
async function processVideo(inputPath, ext = 'mp4') {
  if (!(await hasFfmpeg())) {
    return { remuxed: false, reason: 'ffmpeg khong co san' };
  }

  const outPath = tmpPath(ext);
  const posterPath = tmpPath('webp');
  let buffer;
  let poster;

  try {
    // Chỉ sắp xếp lại container. `-map 0` để giữ đủ mọi luồng (một số video
    // điện thoại có luồng metadata riêng, bỏ đi thì mất thông tin xoay ảnh).
    await run('ffmpeg', [
      '-nostdin', '-y', '-loglevel', 'error',
      '-i', inputPath,
      '-map', '0', '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ]);
    buffer = await fs.readFile(outPath);
  } catch (error) {
    console.error('[cdn] remux video that bai, giu nguyen ban goc:', error.message);
    await unlinkQuiet(outPath);
    await unlinkQuiet(posterPath);
    return { remuxed: false, reason: error.message };
  }

  try {
    // `-ss 1` lấy khung giây thứ nhất: khung 0 của nhiều video là màn hình đen.
    // Video ngắn hơn 1 giây sẽ lỗi ⇒ thử lại ở khung đầu.
    try {
      await run('ffmpeg', [
        '-nostdin', '-y', '-loglevel', 'error',
        '-ss', '1', '-i', inputPath,
        '-vframes', '1', '-vf', `scale=${POSTER_WIDTH}:-2`,
        posterPath,
      ]);
    } catch {
      await run('ffmpeg', [
        '-nostdin', '-y', '-loglevel', 'error',
        '-i', inputPath,
        '-vframes', '1', '-vf', `scale=${POSTER_WIDTH}:-2`,
        posterPath,
      ]);
    }
    poster = await fs.readFile(posterPath);
  } catch (error) {
    // Không có poster thì feed hơi trống chứ video vẫn phát được — không phải lỗi chặn.
    console.warn('[cdn] khong sinh duoc poster:', error.message);
  }

  await unlinkQuiet(outPath);
  await unlinkQuiet(posterPath);

  // Remux đôi khi làm file to hơn chút (do padding); vẫn dùng bản mới vì
  // faststart mới là thứ ta cần, không phải dung lượng.
  return { buffer, poster, remuxed: true };
}

module.exports = {
  processVideo,
  hasFfmpeg,
  hasFfprobe,
  probeVideoCodec,
  probeFps,
  codecAnToan,
  transcodeToH264,
  TRANSCODE_MAX_HEIGHT,
  TRANSCODE_MAX_FPS,
};
