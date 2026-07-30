#!/usr/bin/env node
/**
 * Kiểm chứng Phase 3 — upload trực tiếp lên CDN.
 *
 *   node scripts/test-cdn-phase3.js
 *
 * Không cần MinIO: S3 được thay bằng bản giả trong bộ nhớ. Trọng tâm là các
 * RANH GIỚI BẢO MẬT, vì Phase 3 mở cho client ghi thẳng vào storage:
 *
 *   • không promote được khoá của người khác
 *   • không nhét được khoá bucket chat vào bài đăng công khai
 *   • vượt trần dung lượng thì object bị xoá, không nằm lại chiếm chỗ
 *   • tắt cờ thì mọi endpoint đóng
 */

process.env.CDN_ENABLED = 'true';
process.env.CDN_DIRECT_UPLOAD = 'true';
process.env.CDN_PUBLIC_URL = 'https://media.wellspring.edu.vn';
process.env.CDN_LINK_SECRET = 'test-secret';
process.env.CDN_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.CDN_ACCESS_KEY = 'k';
process.env.CDN_SECRET_KEY = 's';
process.env.CDN_PRESIGN_MAX_BYTES = '1048576'; // 1MB cho dễ test

const assert = require('assert');
const path = require('path');

// ── S3 giả: thay module trước khi bất kỳ ai require nó ──────────────────
const s3Path = require.resolve('../services/cdn/s3');
const KHO = new Map(); // `${bucket}/${key}` -> {body, contentType}
const NHAT_KY = [];
require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    async putObject({ bucket, key, body, contentType }) {
      KHO.set(`${bucket}/${key}`, { body, contentType });
      NHAT_KY.push(['put', bucket, key]);
      return { bucket, key };
    },
    async deleteObject({ bucket, key }) {
      KHO.delete(`${bucket}/${key}`);
      NHAT_KY.push(['delete', bucket, key]);
    },
    async headObject({ bucket, key }) {
      const o = KHO.get(`${bucket}/${key}`);
      return o ? { exists: true, size: o.body.length, contentType: o.contentType } : { exists: false };
    },
    async getObjectBuffer({ bucket, key }) {
      const o = KHO.get(`${bucket}/${key}`);
      if (!o) throw new Error('NoSuchKey');
      return { buffer: o.body, contentType: o.contentType };
    },
    async presignPutUrl({ bucket, key, contentType, expiresIn }) {
      NHAT_KY.push(['presign', bucket, key]);
      return `https://media.wellspring.edu.vn/${bucket}/${key}?X-Amz-Expires=${expiresIn}&ct=${encodeURIComponent(contentType)}`;
    },
  },
};

const { config } = require('../services/cdn/config');
const directUpload = require('../services/cdn/directUpload');

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

async function nem(fn, code) {
  try {
    await fn();
  } catch (e) {
    assert.strictEqual(e.code, code, `mong đợi code=${code}, nhận ${e.code}: ${e.message}`);
    return e;
  }
  throw new Error(`không ném lỗi, mong đợi ${code}`);
}

const ANH = 'anh';
const NGUOI_KHAC = 'nguoikhac';

(async () => {
  console.log('\n§Phase 3 — cấp presigned PUT');

  let uploads;
  await t('cấp đủ presigned PUT cho từng tệp', async () => {
    uploads = await directUpload.presign(
      { _id: ANH },
      [{ filename: 'a.jpg', contentType: 'image/jpeg' }, { filename: 'b.mp4', contentType: 'video/mp4' }],
      'posts',
    );
    assert.strictEqual(uploads.length, 2);
    assert.ok(uploads[0].putUrl.startsWith('https://media.wellspring.edu.vn/cdn-staging/'));
    assert.ok(uploads[0].stagingKey.startsWith(`${ANH}/`));
  });

  await t('khoá staging mang tiền tố userId (ranh giới bảo mật)', () => {
    for (const u of uploads) {
      assert.strictEqual(directUpload.userIdCuaKhoa(u.stagingKey), ANH);
    }
  });

  await t('hai lần xin cho khoá KHÁC nhau (không đè file nhau)', async () => {
    const a = await directUpload.presign({ _id: ANH }, [{ filename: 'x.jpg' }], 'posts');
    const b = await directUpload.presign({ _id: ANH }, [{ filename: 'x.jpg' }], 'posts');
    assert.notStrictEqual(a[0].stagingKey, b[0].stagingKey);
  });

  await t('trả về header bắt buộc — thiếu là SigV4 không khớp', () => {
    assert.strictEqual(uploads[0].requiredHeaders['Content-Type'], 'image/jpeg');
  });

  await t('kind lạ bị từ chối, không đụng tới bucket', async () => {
    await nem(() => directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'avatars'), 'INVALID_KIND');
    await nem(() => directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], '../etc'), 'INVALID_KIND');
  });

  await t('danh sách rỗng / quá nhiều tệp bị chặn', async () => {
    await nem(() => directUpload.presign({ _id: ANH }, [], 'posts'), 'NO_FILES');
    const nhieu = Array.from({ length: 11 }, () => ({ filename: 'a.jpg' }));
    await nem(() => directUpload.presign({ _id: ANH }, nhieu, 'posts'), 'TOO_MANY_FILES');
  });

  console.log('\n§Phase 3 — promote staging → bucket đích');

  const sharpCo = (() => { try { require('sharp'); return true; } catch { return false; } })();

  await t('chưa upload mà gọi complete ⇒ 404, không tạo object rác', async () => {
    const u = await directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'posts');
    await nem(() => directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts'), 'STAGING_NOT_FOUND');
  });

  await t('KHÔNG promote được khoá của người khác (leo thang quyền)', async () => {
    const u = await directUpload.presign({ _id: NGUOI_KHAC }, [{ filename: 'a.jpg' }], 'posts');
    KHO.set(`cdn-staging/${u[0].stagingKey}`, { body: Buffer.from('x'), contentType: 'image/jpeg' });
    await nem(() => directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts'), 'STAGING_KEY_FORBIDDEN');
    // object của người kia phải còn nguyên, không bị kẻ khác xoá
    assert.ok(KHO.has(`cdn-staging/${u[0].stagingKey}`), 'đã xoá nhầm file người khác');
  });

  await t('khoá bịa đặt không có tiền tố userId bị từ chối', async () => {
    await nem(() => directUpload.promote({ _id: ANH }, 'khong-co-gach-cheo', 'posts'), 'STAGING_KEY_FORBIDDEN');
    await nem(() => directUpload.promote({ _id: ANH }, '../cdn-social-chat/x.webp', 'posts'), 'STAGING_KEY_FORBIDDEN');
  });

  await t('vượt trần dung lượng ⇒ 413 VÀ object bị xoá khỏi staging', async () => {
    const u = await directUpload.presign({ _id: ANH }, [{ filename: 'big.jpg' }], 'posts');
    const key = `cdn-staging/${u[0].stagingKey}`;
    KHO.set(key, { body: Buffer.alloc(2 * 1024 * 1024), contentType: 'image/jpeg' });
    await nem(() => directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts'), 'FILE_TOO_LARGE');
    assert.ok(!KHO.has(key), 'object quá lớn vẫn nằm lại chiếm chỗ');
  });

  if (sharpCo) {
    const sharp = require('sharp');

    await t('promote ảnh: sinh khoá cdn://, dọn staging, có variants', async () => {
      const jpg = await sharp({
        create: { width: 1600, height: 1200, channels: 3, background: { r: 10, g: 90, b: 200 } },
      }).jpeg().toBuffer();

      const u = await directUpload.presign({ _id: ANH }, [{ filename: 'p.jpg', contentType: 'image/jpeg' }], 'posts');
      const stagingFull = `cdn-staging/${u[0].stagingKey}`;
      KHO.set(stagingFull, { body: jpg, contentType: 'image/jpeg' });

      const r = await directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts');

      assert.ok(r.stored.startsWith('cdn://social-posts/'), r.stored);
      assert.strictEqual(r.kind, 'image');
      assert.strictEqual(r.contentType, 'image/webp');
      assert.ok(r.url.includes('?e=') && r.url.includes('&s='));
      assert.ok(!KHO.has(stagingFull), 'staging chưa được dọn');
      // ảnh chính + ít nhất một variant đã nằm trong bucket đích
      const trongBucket = [...KHO.keys()].filter((k) => k.startsWith('cdn-social-posts/'));
      assert.ok(trongBucket.length >= 2, `chỉ có ${trongBucket.length} object`);
    });

    await t('ảnh qua Phase 3 bị strip EXIF y như Phase 1', async () => {
      const coExif = await sharp({
        create: { width: 900, height: 600, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).jpeg().withMetadata({ exif: { IFD0: { Make: 'Apple' } } }).toBuffer();
      assert.ok((await sharp(coExif).metadata()).exif, 'ảnh nguồn không có EXIF ⇒ test vô nghĩa');

      const u = await directUpload.presign({ _id: ANH }, [{ filename: 'e.jpg', contentType: 'image/jpeg' }], 'posts');
      KHO.set(`cdn-staging/${u[0].stagingKey}`, { body: coExif, contentType: 'image/jpeg' });
      const r = await directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts');

      const raKho = KHO.get(`cdn-social-posts/${r.stored.replace('cdn://social-posts/', '')}`);
      assert.ok(raKho, 'không tìm thấy object đã lưu');
      assert.ok(!(await sharp(raKho.body).metadata()).exif, 'EXIF vẫn còn — Phase 3 lọt lỗ hổng P5');
    });

    await t('cùng nội dung ⇒ cùng khoá (dedupe content-addressed)', async () => {
      const anh = await sharp({
        create: { width: 400, height: 300, channels: 3, background: { r: 7, g: 7, b: 7 } },
      }).jpeg().toBuffer();
      const ra = [];
      for (let i = 0; i < 2; i += 1) {
        const u = await directUpload.presign({ _id: ANH }, [{ filename: 'd.jpg', contentType: 'image/jpeg' }], 'posts');
        KHO.set(`cdn-staging/${u[0].stagingKey}`, { body: anh, contentType: 'image/jpeg' });
        ra.push((await directUpload.promote({ _id: ANH }, u[0].stagingKey, 'posts')).stored);
      }
      assert.strictEqual(ra[0], ra[1], 'hai lần upload cùng ảnh ra hai khoá khác nhau');
    });

    await t('chat dùng bucket riêng, không lẫn sang posts', async () => {
      const anh = await sharp({
        create: { width: 300, height: 200, channels: 3, background: { r: 5, g: 5, b: 5 } },
      }).jpeg().toBuffer();
      const u = await directUpload.presign({ _id: ANH }, [{ filename: 'c.jpg', contentType: 'image/jpeg' }], 'chat');
      KHO.set(`cdn-staging/${u[0].stagingKey}`, { body: anh, contentType: 'image/jpeg' });
      const r = await directUpload.promote({ _id: ANH }, u[0].stagingKey, 'chat');
      assert.ok(r.stored.startsWith('cdn://social-chat/'), r.stored);
    });
  } else {
    console.log('  ⏭️  bỏ qua nhóm promote ảnh: sharp không nạp được');
  }

  console.log('\n§Phase 3 — lọc khoá client gửi khi tạo bài');

  // Nạp hàm lọc mà không kéo cả postController (cần Mongo)
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '../controllers/postController.js'), 'utf8');
  const bat = src.match(/function sanitizePostMediaKeys[\s\S]*?\n}/);
  assert.ok(bat, 'không tìm thấy sanitizePostMediaKeys trong postController');
  // eslint-disable-next-line no-new-func
  const sanitize = new Function('cdn', `${bat[0]}; return sanitizePostMediaKeys;`)({ CDN_SCHEME: 'cdn://' });

  await t('nhận khoá bucket bài đăng hợp lệ', () => {
    const r = sanitize([{ stored: 'cdn://social-posts/2026/07/ab/x.webp', kind: 'image' }]);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].kind, 'image');
  });

  await t('CHẶN khoá bucket chat nhét vào bài công khai (leo thang quyền)', () => {
    const r = sanitize([
      { stored: 'cdn://social-chat/2026/07/ab/rieng-tu.webp', kind: 'image' },
      { stored: 'cdn://social-avatars/u/1.webp', kind: 'image' },
    ]);
    assert.strictEqual(r.length, 0, 'khoá bucket khác lọt vào bài đăng');
  });

  await t('chặn path traversal và giá trị rác', () => {
    assert.strictEqual(sanitize([{ stored: 'cdn://social-posts/../social-chat/x.webp' }]).length, 0);
    assert.strictEqual(sanitize(['/uploads/posts/x.jpg']).length, 0);
    assert.strictEqual(sanitize('không phải mảng').length, 0);
    assert.strictEqual(sanitize(null).length, 0);
    assert.strictEqual(sanitize([null, 42, {}]).length, 0);
  });

  await t('cắt query string khỏi khoá lưu DB', () => {
    const r = sanitize([{ stored: 'cdn://social-posts/a.webp?e=1&s=x' }]);
    assert.strictEqual(r[0].stored, 'cdn://social-posts/a.webp');
  });

  await t('giới hạn 10 tệp', () => {
    const nhieu = Array.from({ length: 20 }, (_, i) => ({ stored: `cdn://social-posts/${i}.webp` }));
    assert.strictEqual(sanitize(nhieu).length, 10);
  });

  await t('nhận chuỗi JSON (multipart gửi field dạng text)', () => {
    const r = sanitize(JSON.stringify([{ stored: 'cdn://social-posts/j.webp', kind: 'video' }]));
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].kind, 'video');
  });

  console.log('\n§Phase 3 — cờ tắt');

  await t('tắt CDN_DIRECT_UPLOAD ⇒ mọi endpoint đóng', async () => {
    config.directUpload.enabled = false;
    await nem(() => directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'posts'), 'DIRECT_UPLOAD_DISABLED');
    await nem(() => directUpload.promote({ _id: ANH }, `${ANH}/x.jpg`, 'posts'), 'DIRECT_UPLOAD_DISABLED');
    config.directUpload.enabled = true;
  });

  await t('tắt CDN_ENABLED ⇒ cũng đóng (kill switch bao trùm)', async () => {
    config.enabled = false;
    await nem(() => directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'posts'), 'DIRECT_UPLOAD_DISABLED');
    config.enabled = true;
  });

  console.log('\n§Phase 3 — danh sách trắng để thử trên máy thật');

  await t('cờ tắt + user trong danh sách ⇒ ĐƯỢC đi đường trực tiếp', async () => {
    config.directUpload.enabled = false;
    config.directUpload.allowUsers = new Set([String(ANH)]);
    const u = await directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'posts');
    assert.strictEqual(u.length, 1);
    config.directUpload.allowUsers = new Set();
    config.directUpload.enabled = true;
  });

  await t('cờ tắt + user NGOÀI danh sách ⇒ vẫn đóng', async () => {
    config.directUpload.enabled = false;
    config.directUpload.allowUsers = new Set([String(ANH)]);
    await nem(() => directUpload.presign({ _id: NGUOI_KHAC }, [{ filename: 'a.jpg' }], 'posts'), 'DIRECT_UPLOAD_DISABLED');
    config.directUpload.allowUsers = new Set();
    config.directUpload.enabled = true;
  });

  await t('CDN_ENABLED tắt ⇒ danh sách trắng KHÔNG vượt qua được kill switch', async () => {
    config.enabled = false;
    config.directUpload.enabled = false;
    config.directUpload.allowUsers = new Set([String(ANH)]);
    await nem(() => directUpload.presign({ _id: ANH }, [{ filename: 'a.jpg' }], 'posts'), 'DIRECT_UPLOAD_DISABLED');
    config.enabled = true;
    config.directUpload.allowUsers = new Set();
    config.directUpload.enabled = true;
  });

  await t('capability đồng ý với presign — cùng một hàm quyết định', async () => {
    const { directUploadChoUser } = require('../services/cdn/config');
    config.directUpload.enabled = false;
    config.directUpload.allowUsers = new Set([String(ANH)]);
    // Nếu hai bên lệch nhau, client sẽ được bảo "được" rồi ăn 409 và im lặng
    // rơi về multipart — loại lỗi không ai nhìn thấy.
    assert.strictEqual(directUploadChoUser({ _id: ANH }), true);
    assert.strictEqual(directUploadChoUser({ _id: NGUOI_KHAC }), false);
    assert.strictEqual(directUploadChoUser(undefined), false);
    config.directUpload.allowUsers = new Set();
    config.directUpload.enabled = true;
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
