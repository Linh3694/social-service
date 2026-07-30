#!/usr/bin/env node
/**
 * Đối soát: mọi giá trị legacy trong DB có object thật trên MinIO chưa?
 *
 *   node scripts/cdn-verify-legacy.js
 *
 * Đây là ĐIỀU KIỆN CỔNG của Phase 4 (§9 Bước 3). Rewrite DB khi còn khoá thiếu
 * object = mất ảnh vĩnh viễn, vì giá trị `/uploads/...` cũ không còn trong DB để
 * quay lại đọc từ đĩa nữa.
 *
 * Cũng nên chạy định kỳ trong lúc CDN đang chạy: nếu `mc mirror` sót file nào
 * thì phát hiện ở đây chứ không phải khi phụ huynh mở ra thấy ảnh vỡ.
 *
 * Mã thoát:
 *   0 — mọi khoá legacy đều có object trên CDN
 *   1 — có khoá thiếu (in ra danh sách), hoặc lỗi kết nối
 */

require('dotenv').config({ path: './config.env' });

const mongoose = require('mongoose');

const { config } = require('../services/cdn/config');
const { toObjectPath } = require('../services/cdn/resolve');
const s3 = require('../services/cdn/s3');

const LEGACY_RE = /^\/(api\/social\/)?uploads\//;

/** `/social-chat/legacy/x.jpg` → { bucket: 'cdn-social-chat', key: 'legacy/x.jpg' } */
function tachBucket(objectPath) {
  const p = objectPath.replace(/^\/+/, '');
  const i = p.indexOf('/');
  if (i <= 0) return null;
  return { bucket: `cdn-${p.slice(0, i)}`, key: p.slice(i + 1) };
}

async function thuThapKhoa(db) {
  const khoa = new Map(); // objectPath -> nguồn (để in khi thiếu)

  const posts = db.collection('posts');
  const cur = posts.find(
    { $or: [{ images: { $regex: LEGACY_RE } }, { videos: { $regex: LEGACY_RE } }] },
    { projection: { images: 1, videos: 1 } },
  ).batchSize(500);
  for await (const doc of cur) {
    for (const v of [...(doc.images || []), ...(doc.videos || [])]) {
      if (typeof v !== 'string' || !LEGACY_RE.test(v)) continue;
      const p = toObjectPath(v);
      if (p) khoa.set(p, `posts/${doc._id}`);
    }
  }

  const msgs = db.collection('chatmessages');
  const cur2 = msgs.find(
    { 'attachments.url': { $regex: LEGACY_RE } },
    { projection: { attachments: 1 } },
  ).batchSize(500);
  for await (const doc of cur2) {
    for (const a of doc.attachments || []) {
      if (typeof a?.url !== 'string' || !LEGACY_RE.test(a.url)) continue;
      const p = toObjectPath(a.url);
      if (p) khoa.set(p, `chatmessages/${doc._id}`);
    }
  }

  return khoa;
}

(async () => {
  if (!config.enabled) {
    console.error('CDN_ENABLED=false — bật lên rồi mới đối soát được.');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Thiếu MONGODB_URI trong config.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log('Đang thu thập khoá legacy từ MongoDB...');
  const khoa = await thuThapKhoa(db);
  console.log(`Tìm thấy ${khoa.size} khoá legacy riêng biệt\n`);

  const thieu = [];
  let da = 0;
  // Tuần tự theo lô nhỏ: HeadObject hàng nghìn lần song song sẽ làm nghẽn MinIO
  // và làm chậm chính CDN đang phục vụ người dùng thật.
  const entries = [...khoa.entries()];
  const LO = 20;
  for (let i = 0; i < entries.length; i += LO) {
    await Promise.all(entries.slice(i, i + LO).map(async ([objectPath, nguon]) => {
      const t = tachBucket(objectPath);
      if (!t) { thieu.push([objectPath, nguon, 'khoá không hợp lệ']); return; }
      try {
        const head = await s3.headObject(t);
        if (!head.exists) thieu.push([objectPath, nguon, 'không có trên MinIO']);
      } catch (e) {
        thieu.push([objectPath, nguon, `lỗi: ${e.message}`]);
      }
    }));
    da += Math.min(LO, entries.length - i);
    if (da % 200 === 0 || da === entries.length) {
      process.stdout.write(`\r  đã kiểm ${da}/${entries.length}`);
    }
  }
  console.log('');

  await mongoose.disconnect();

  if (thieu.length) {
    console.log(`\n❌ ${thieu.length}/${khoa.size} khoá THIẾU object trên CDN:\n`);
    for (const [p, nguon, ly_do] of thieu.slice(0, 50)) {
      console.log(`  ${p}\n     nguồn: ${nguon} — ${ly_do}`);
    }
    if (thieu.length > 50) console.log(`  … và ${thieu.length - 50} khoá nữa`);
    console.log('\nKhắc phục: chạy lại `mc mirror` cho phần thiếu, rồi đối soát lại.');
    console.log('TUYỆT ĐỐI không chạy cdn-rewrite-legacy-urls.js khi còn khoá thiếu.');
    process.exit(1);
  }

  console.log(`\n✅ Cả ${khoa.size} khoá legacy đều có object trên CDN.`);
  process.exit(0);
})().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(1);
});
