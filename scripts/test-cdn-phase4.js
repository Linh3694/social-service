#!/usr/bin/env node
/**
 * Kiểm chứng phần logic thuần của script Phase 4.
 *
 *   node scripts/test-cdn-phase4.js
 *
 * Không cần Mongo/MinIO. Test đúng chỗ nguy hiểm nhất: phép ánh xạ
 * `/uploads/...` → `cdn://...`. Sai ở đây thì rewrite sẽ ghi khoá rác vào DB và
 * KHÔNG quay lại được — giá trị cũ đã mất.
 */

process.env.CDN_ENABLED = 'true';
process.env.CDN_PUBLIC_URL = 'https://media.wellspring.edu.vn';
process.env.CDN_LINK_SECRET = 'test-secret';
process.env.CDN_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.CDN_ACCESS_KEY = 'k';
process.env.CDN_SECRET_KEY = 's';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { toObjectPath } = require('../services/cdn/resolve');
const { CDN_SCHEME } = require('../services/cdn/sign');

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name}\n     ${e.message}`);
  }
}

// Nạp hàm từ script mà không chạy phần kết nối DB
function napHam(tenFile, tenHam) {
  const src = fs.readFileSync(path.join(__dirname, tenFile), 'utf8');
  const m = src.match(new RegExp(`function ${tenHam}[\\s\\S]*?\\n}`));
  assert.ok(m, `không tìm thấy ${tenHam} trong ${tenFile}`);
  // eslint-disable-next-line no-new-func
  return new Function('toObjectPath', 'CDN_SCHEME', `${m[0]}; return ${tenHam};`)(
    toObjectPath, CDN_SCHEME,
  );
}

const toCdnKey = napHam('cdn-rewrite-legacy-urls.js', 'toCdnKey');
const rewriteMang = (() => {
  const src = fs.readFileSync(path.join(__dirname, 'cdn-rewrite-legacy-urls.js'), 'utf8');
  const m = src.match(/function rewriteMang[\s\S]*?\n}/);
  // eslint-disable-next-line no-new-func
  return new Function('toCdnKey', `${m[0]}; return rewriteMang;`)(toCdnKey);
})();
const tachBucket = napHam('cdn-verify-legacy.js', 'tachBucket');

console.log('\n§Phase 4 — ánh xạ legacy → cdn://');

t('bốn dạng giá trị legacy đều ánh xạ đúng', () => {
  assert.strictEqual(toCdnKey('/uploads/posts/f-1.jpg'), 'cdn://social-posts/legacy/f-1.jpg');
  assert.strictEqual(toCdnKey('/api/social/uploads/posts/f-2.jpg'), 'cdn://social-posts/legacy/f-2.jpg');
  assert.strictEqual(toCdnKey('/uploads/chat/c-1.jpg'), 'cdn://social-chat/legacy/c-1.jpg');
  assert.strictEqual(toCdnKey('/api/social/uploads/chat/c-2.jpg'), 'cdn://social-chat/legacy/c-2.jpg');
});

t('giá trị ĐÃ là cdn:// thì trả null (không rewrite hai lần)', () => {
  assert.strictEqual(toCdnKey('cdn://social-posts/2026/07/ab/x.webp'), null);
});

t('URL ngoài và giá trị rác trả null — KHÔNG đụng vào', () => {
  for (const v of ['https://example.com/a.jpg', 'http://x/a.jpg', '', null, undefined, 42, {}]) {
    assert.strictEqual(toCdnKey(v), null, String(v));
  }
});

t('path traversal trả null — không sinh khoá thoát thư mục', () => {
  assert.strictEqual(toCdnKey('/uploads/chat/../../etc/passwd'), null);
  assert.strictEqual(toCdnKey('/uploads/chat/a/b.jpg'), null);
});

console.log('\n§Phase 4 — rewrite mảng, giữ nguyên phần tử không liên quan');

t('chỉ đổi phần tử legacy, giữ nguyên phần tử khác', () => {
  const vao = ['/uploads/posts/a.jpg', 'cdn://social-posts/b.webp', 'https://x.com/c.jpg'];
  const { doi, ra } = rewriteMang(vao);
  assert.strictEqual(doi, true);
  assert.deepStrictEqual(ra, [
    'cdn://social-posts/legacy/a.jpg',
    'cdn://social-posts/b.webp',
    'https://x.com/c.jpg',
  ]);
});

t('mảng không có legacy ⇒ doi=false (không ghi DB vô ích)', () => {
  const vao = ['cdn://social-posts/a.webp', 'https://x.com/b.jpg'];
  const { doi, ra } = rewriteMang(vao);
  assert.strictEqual(doi, false);
  assert.deepStrictEqual(ra, vao);
});

t('mảng rỗng / không phải mảng không làm vỡ', () => {
  assert.strictEqual(rewriteMang([]).doi, false);
  assert.strictEqual(rewriteMang(undefined).doi, false);
  assert.strictEqual(rewriteMang(null).doi, false);
  assert.strictEqual(rewriteMang('chuỗi').doi, false);
});

t('phần tử không phải chuỗi được giữ nguyên', () => {
  const vao = [42, null, { a: 1 }, '/uploads/posts/x.jpg'];
  const { ra } = rewriteMang(vao);
  assert.strictEqual(ra[0], 42);
  assert.strictEqual(ra[1], null);
  assert.deepStrictEqual(ra[2], { a: 1 });
  assert.strictEqual(ra[3], 'cdn://social-posts/legacy/x.jpg');
});

console.log('\n§Phase 4 — tách bucket khi đối soát');

t('tách đúng bucket và khoá', () => {
  assert.deepStrictEqual(tachBucket('/social-chat/legacy/x.jpg'), {
    bucket: 'cdn-social-chat', key: 'legacy/x.jpg',
  });
  assert.deepStrictEqual(tachBucket('/social-posts/2026/07/ab/y.webp'), {
    bucket: 'cdn-social-posts', key: '2026/07/ab/y.webp',
  });
});

t('đường dẫn không có phần khoá trả null', () => {
  assert.strictEqual(tachBucket('/social-chat'), null);
  assert.strictEqual(tachBucket('/'), null);
  assert.strictEqual(tachBucket(''), null);
});

console.log('\n§Phase 4 — vòng khép kín: ánh xạ rồi tách phải ra đúng bucket');

t('mọi dạng legacy đi trọn vòng không lệch bucket', () => {
  const ca = [
    ['/uploads/posts/a.jpg', 'cdn-social-posts', 'legacy/a.jpg'],
    ['/uploads/chat/b.jpg', 'cdn-social-chat', 'legacy/b.jpg'],
    ['/api/social/uploads/posts/c.mp4', 'cdn-social-posts', 'legacy/c.mp4'],
  ];
  for (const [vao, bucket, key] of ca) {
    const cdnKey = toCdnKey(vao);
    const objectPath = `/${cdnKey.slice(CDN_SCHEME.length)}`;
    assert.deepStrictEqual(tachBucket(objectPath), { bucket, key }, vao);
  }
});

console.log('\n§Phase 4 — script phải mặc định AN TOÀN');

t('rewrite mặc định là dry-run, chỉ ghi khi có --apply', () => {
  const src = fs.readFileSync(path.join(__dirname, 'cdn-rewrite-legacy-urls.js'), 'utf8');
  assert.ok(/const DRY_RUN = !argv\.includes\('--apply'\)/.test(src),
    'mặc định phải là dry-run — thiếu cờ là ghi thật thì quá nguy hiểm');
  assert.ok(src.includes('undo'), 'thiếu cơ chế ghi file hoàn tác');
});

t('verify-legacy thoát mã 1 khi có khoá thiếu', () => {
  const src = fs.readFileSync(path.join(__dirname, 'cdn-verify-legacy.js'), 'utf8');
  assert.ok(/if \(thieu\.length\)[\s\S]*process\.exit\(1\)/.test(src),
    'thiếu object mà vẫn thoát 0 thì cổng chặn Phase 4 vô nghĩa');
});

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
