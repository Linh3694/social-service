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

let ffmpegAvailable;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
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

function tmpPath(ext) {
  return path.join(os.tmpdir(), `cdn-vid-${crypto.randomBytes(8).toString('hex')}.${ext}`);
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

module.exports = { processVideo, hasFfmpeg };
