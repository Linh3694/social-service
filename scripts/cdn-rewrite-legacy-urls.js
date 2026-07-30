#!/usr/bin/env node
/**
 * Phase 4 — chuyển giá trị legacy trong MongoDB sang khoá `cdn://`.
 *
 *   node scripts/cdn-rewrite-legacy-urls.js --dry-run     # BẮT BUỘC chạy trước
 *   node scripts/cdn-rewrite-legacy-urls.js --apply
 *
 * ⚠️  CHƯA ĐƯỢC CHẠY. Quyết định hiện tại là GIỮ fallback đĩa tới ~giữa 2027
 *     (CDN-STATUS.md §9). Script để sẵn cho tới lúc đó.
 *
 * VÌ SAO PHẢI CHỜ LÂU ĐẾN THẾ
 *
 * Chừng nào DB còn giữ `/uploads/...`, `resolve.js` ánh xạ sang CDN lúc đọc và
 * tắt `CDN_ENABLED` là mọi thứ quay về phục vụ từ đĩa — rollback trong một phút.
 * Sau khi rewrite, giá trị cũ không còn trong DB nữa: tắt CDN sẽ ra ảnh vỡ chứ
 * không quay về được. Đó là lý do bước này nằm cuối cùng, sau khi CDN đã chạy ổn
 * định rất lâu, chứ không phải vì nó khó.
 *
 * ĐIỀU KIỆN TRƯỚC KHI CHẠY — cả bốn, không bỏ cái nào:
 *   1. CDN chạy ổn định nhiều tháng, không có sự cố phải rollback.
 *   2. `cdn-verify-legacy.js` sạch: mọi khoá legacy đều có object thật trên MinIO.
 *      Rewrite một giá trị mà object không tồn tại = mất ảnh vĩnh viễn.
 *   3. Đã snapshot MongoDB ngay trước khi chạy.
 *   4. `legacyUploadsGuard.stats.allowed` đã ngừng tăng — không client nào còn
 *      giữ URL `/uploads` cũ.
 *
 * Script ghi file hoàn tác (`--undo-file`) để đảo ngược từng document.
 */

require('dotenv').config({ path: './config.env' });

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { toObjectPath } = require('../services/cdn/resolve');
const { CDN_SCHEME } = require('../services/cdn/sign');

const argv = process.argv.slice(2);
const DRY_RUN = !argv.includes('--apply');
const BATCH = 500;
const UNDO_FILE = (() => {
  const i = argv.indexOf('--undo-file');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return path.join(__dirname, `cdn-rewrite-undo-${Date.now()}.jsonl`);
})();

/** `/uploads/chat/x.jpg` → `cdn://social-chat/legacy/x.jpg`, hoặc null. */
function toCdnKey(stored) {
  const objectPath = toObjectPath(stored);
  if (!objectPath) return null;
  const key = objectPath.replace(/^\/+/, '');
  const moi = `${CDN_SCHEME}${key}`;
  return moi === stored ? null : moi;
}

function rewriteMang(arr) {
  if (!Array.isArray(arr)) return { doi: false, ra: arr };
  let doi = false;
  const ra = arr.map((v) => {
    const moi = typeof v === 'string' ? toCdnKey(v) : null;
    if (moi) { doi = true; return moi; }
    return v;
  });
  return { doi, ra };
}

async function rewritePosts(db, undo) {
  const col = db.collection('posts');
  const loc = {
    $or: [
      { images: { $regex: '^/(api/social/)?uploads/' } },
      { videos: { $regex: '^/(api/social/)?uploads/' } },
    ],
  };
  const tong = await col.countDocuments(loc);
  console.log(`\n[posts] ${tong} document có giá trị legacy`);

  let da = 0;
  let sua = 0;
  const cursor = col.find(loc).batchSize(BATCH);
  const ops = [];

  for await (const doc of cursor) {
    da += 1;
    const img = rewriteMang(doc.images);
    const vid = rewriteMang(doc.videos);
    if (!img.doi && !vid.doi) continue;

    sua += 1;
    const set = {};
    if (img.doi) set.images = img.ra;
    if (vid.doi) set.videos = vid.ra;

    undo.write(`${JSON.stringify({
      col: 'posts',
      _id: doc._id,
      truoc: { images: doc.images, videos: doc.videos },
    })}\n`);

    if (sua <= 3) {
      console.log(`  ví dụ ${doc._id}:`);
      if (img.doi) console.log(`    images: ${JSON.stringify(doc.images)} → ${JSON.stringify(img.ra)}`);
      if (vid.doi) console.log(`    videos: ${JSON.stringify(doc.videos)} → ${JSON.stringify(vid.ra)}`);
    }

    if (!DRY_RUN) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
      if (ops.length >= BATCH) { await col.bulkWrite(ops); ops.length = 0; }
    }
  }
  if (!DRY_RUN && ops.length) await col.bulkWrite(ops);
  console.log(`[posts] duyệt ${da}, sẽ sửa ${sua}`);
  return sua;
}

async function rewriteChat(db, undo) {
  const col = db.collection('chatmessages');
  const loc = { 'attachments.url': { $regex: '^/(api/social/)?uploads/' } };
  const tong = await col.countDocuments(loc);
  console.log(`\n[chatmessages] ${tong} document có giá trị legacy`);

  let da = 0;
  let sua = 0;
  const cursor = col.find(loc).batchSize(BATCH);
  const ops = [];

  for await (const doc of cursor) {
    da += 1;
    let doi = false;
    const attachments = (doc.attachments || []).map((a) => {
      const moi = toCdnKey(a?.url);
      if (moi) { doi = true; return { ...a, url: moi }; }
      return a;
    });
    if (!doi) continue;

    sua += 1;
    undo.write(`${JSON.stringify({
      col: 'chatmessages',
      _id: doc._id,
      truoc: { attachments: doc.attachments },
    })}\n`);

    if (sua <= 3) {
      console.log(`  ví dụ ${doc._id}: ${doc.attachments.map((a) => a.url).join(', ')}`);
      console.log(`    → ${attachments.map((a) => a.url).join(', ')}`);
    }

    if (!DRY_RUN) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { attachments } } } });
      if (ops.length >= BATCH) { await col.bulkWrite(ops); ops.length = 0; }
    }
  }
  if (!DRY_RUN && ops.length) await col.bulkWrite(ops);
  console.log(`[chatmessages] duyệt ${da}, sẽ sửa ${sua}`);
  return sua;
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Thiếu MONGODB_URI trong config.env');
    process.exit(1);
  }

  console.log('='.repeat(64));
  console.log(DRY_RUN
    ? 'CHẾ ĐỘ THỬ (dry-run) — không ghi gì vào DB'
    : '⚠️  CHẾ ĐỘ GHI THẬT (--apply)');
  console.log('='.repeat(64));

  if (!DRY_RUN) {
    console.log('\nĐiều kiện bắt buộc — tự xác nhận trước khi tiếp tục:');
    console.log('  [ ] đã snapshot MongoDB');
    console.log('  [ ] cdn-verify-legacy.js sạch');
    console.log('  [ ] legacyUploadsGuard.stats.allowed đã ngừng tăng');
    console.log('  [ ] chấp nhận MẤT đường rollback về đĩa\n');
    console.log('Bắt đầu sau 10 giây, Ctrl-C để huỷ...');
    await new Promise((r) => setTimeout(r, 10000));
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const undo = fs.createWriteStream(UNDO_FILE, { flags: 'a' });

  try {
    const a = await rewritePosts(db, undo);
    const b = await rewriteChat(db, undo);
    console.log(`\n${'='.repeat(64)}`);
    console.log(`Tổng: ${a + b} document ${DRY_RUN ? 'SẼ được sửa' : 'đã sửa'}`);
    if (!DRY_RUN) console.log(`File hoàn tác: ${UNDO_FILE}`);
    else console.log('Chạy lại với --apply để ghi thật.');
  } finally {
    undo.end();
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error('Lỗi:', e);
  process.exit(1);
});
