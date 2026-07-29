#!/usr/bin/env node
/**
 * Kiểm chứng pipeline video trên production: remux `+faststart` + poster.
 *
 * Chạy trên VM microservices:
 *   cd /srv/app/social-service && node scripts/test-video-cdn.js
 *
 * Điều đáng kiểm nhất là THỨ TỰ ATOM, không phải sự tồn tại của file: một video
 * upload nguyên bản vẫn phát được trên wifi nên khó phát hiện thiếu faststart
 * bằng mắt. Script dựng một video mà ffmpeg cố tình để `moov` ở cuối, rồi đối
 * chiếu vị trí `moov` trước và sau khi qua pipeline.
 *
 * Tự dọn object đã tạo ở cuối, kể cả khi giữa đường lỗi.
 */

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const https = require('https');

// Phải nạp trước khi require tầng CDN: `services/cdn/config.js` đọc env ngay lúc
// được require, nạp muộn thì client S3 dựng lên với khoá rỗng.
require('dotenv').config({ path: path.join(__dirname, '../config.env') });

const cdn = require('../services/cdn');
const s3 = require('../services/cdn/s3');

const created = [];
let failed = 0;

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${bin}: ${err.message} ${String(stderr).slice(-300)}`));
      resolve(stdout);
    });
  });
}

function check(label, ok, detail = '') {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

/** Vị trí byte của một atom trong container MP4; -1 nếu không thấy. */
function atomOffset(buffer, name) {
  return buffer.indexOf(Buffer.from(name, 'ascii'));
}

function splitStored(stored) {
  const rest = stored.slice(cdn.CDN_SCHEME.length);
  const slash = rest.indexOf('/');
  return { bucket: `cdn-${rest.slice(0, slash)}`, key: rest.slice(slash + 1) };
}

async function getObjectBytes(bucket, key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await s3.getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function httpStatus(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', (e) => resolve(`ERR ${e.message}`));
  });
}

async function main() {
  const inPath = path.join(os.tmpdir(), `test-video-cdn-${Date.now()}.mp4`);

  // testsrc + sine để có cả luồng hình và tiếng; không truyền `+faststart` nên
  // ffmpeg để `moov` ở cuối — đúng hình dạng video điện thoại gửi lên.
  await run('ffmpeg', [
    '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    inPath,
  ]);

  const originalBytes = await fs.readFile(inPath);
  const origMoov = atomOffset(originalBytes, 'moov');
  const origMdat = atomOffset(originalBytes, 'mdat');
  check('video nguon co moov SAU mdat (dung tien de cua phep thu)',
    origMoov > origMdat,
    `moov@${origMoov} mdat@${origMdat} size=${originalBytes.length}`);

  const result = await cdn.storeUpload(
    { path: inPath, originalname: 'test-video-cdn.mp4', mimetype: 'video/mp4' },
    { kind: 'chat' },
  );
  created.push(result.stored, ...result.variants);
  await fs.unlink(inPath).catch(() => {});

  check('kind = video', result.kind === 'video', result.kind);
  check('co variant _poster.webp',
    result.variants.some((v) => v.endsWith('_poster.webp')),
    result.variants.join(', ') || '(khong co)');

  const main_ = splitStored(result.stored);
  const head = await s3.headObject(main_);
  check('object video ton tai tren MinIO', head.exists,
    head.exists ? `${head.size} bytes, ${head.contentType}` : main_.key);

  const posterStored = result.variants.find((v) => v.endsWith('_poster.webp'));
  if (posterStored) {
    const poster = splitStored(posterStored);
    const posterHead = await s3.headObject(poster);
    check('object poster ton tai tren MinIO', posterHead.exists,
      posterHead.exists ? `${posterHead.size} bytes, ${posterHead.contentType}` : poster.key);
  } else {
    check('object poster ton tai tren MinIO', false, 'khong co variant poster');
  }

  const storedBytes = await getObjectBytes(main_.bucket, main_.key);
  const newMoov = atomOffset(storedBytes, 'moov');
  const newMdat = atomOffset(storedBytes, 'mdat');
  check('moov nam TRUOC mdat sau khi remux (+faststart)',
    newMoov > 0 && newMoov < newMdat,
    `moov@${newMoov} mdat@${newMdat} size=${storedBytes.length}`);

  // Giữ đủ luồng: `-map 0` phải mang cả video lẫn audio sang bản mới. Mất luồng
  // metadata là mất thông tin xoay ảnh — video điện thoại sẽ hiện nằm ngang.
  const probePath = path.join(os.tmpdir(), `test-video-cdn-probe-${Date.now()}.mp4`);
  await fs.writeFile(probePath, storedBytes);
  const streams = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0', probePath,
  ]).catch((e) => `LOI ${e.message}`);
  await fs.unlink(probePath).catch(() => {});
  const kinds = String(streams).trim().split(/\s+/).sort();
  check('ban moi con du luong hinh va tieng',
    kinds.includes('video') && kinds.includes('audio'),
    kinds.join(','));

  const status = await httpStatus(result.url);
  check('nginx phuc vu URL da ky', status === 200, String(status));

  return result;
}

main()
  .catch((error) => {
    failed += 1;
    console.error('LOI:', error.message);
  })
  .finally(async () => {
    for (const stored of created) await cdn.removeStored(stored);
    console.log(`\nDa don ${created.length} object thu.`);
    console.log(failed === 0 ? 'KET QUA: tat ca dat.' : `KET QUA: ${failed} muc khong dat.`);
    process.exit(failed === 0 ? 0 : 1);
  });
