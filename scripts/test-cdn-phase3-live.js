#!/usr/bin/env node
/**
 * Thử đường upload trực tiếp (Phase 3) trên HẠ TẦNG THẬT.
 *
 *   cd /srv/app/social-service && node scripts/test-cdn-phase3-live.js
 *
 * Khác `test-cdn-phase3.js` (unit, chạy được ở local, không cần mạng): script này
 * PUT thật qua nginx vào MinIO, promote thật, tải về thật. Chỉ chạy được trên máy
 * có đường tới MinIO — tức VM microservice.
 *
 * VÌ SAO KHÔNG BẬT CỜ TRONG config.env ĐỂ THỬ
 *
 * Tiến trình này bật `CDN_DIRECT_UPLOAD` trong bộ nhớ CỦA CHÍNH NÓ. Tiến trình
 * social-service đang phục vụ người dùng không bị ảnh hưởng, không cần reload, và
 * không phút nào cờ được bật cho người thật. Không có gì phải rollback.
 *
 * NÓ KHÔNG KIỂM ĐƯỢC GÌ
 *
 * Hành vi React Native: bộ nhớ khi gửi video lớn, và việc thiết bị thật có gửi
 * đúng header hay không. Hai thứ đó chỉ hiện ra trên thiết bị với bản app mới.
 *
 * Tự dọn mọi object nó tạo ra.
 */

const path = require('path');
const assert = require('assert');

require('dotenv').config({ path: path.resolve(__dirname, '../config.env') });

// PHẢI đặt TRƯỚC khi require services/cdn — config.js đọc process.env một lần
// duy nhất lúc nạp module.
process.env.CDN_DIRECT_UPLOAD = 'true';

const cdn = require('../services/cdn');
const s3 = require('../services/cdn/s3');

const USER = { _id: 'phase3-live-test' };
const STAGING = cdn.config.buckets.staging;

let pass = 0;
let fail = 0;
const CAN_DON = [];

async function t(ten, fn) {
  try {
    await fn();
    console.log(`  ✅ ${ten}`);
    pass += 1;
  } catch (e) {
    console.log(`  ❌ ${ten}\n       ${e.message}`);
    fail += 1;
  }
}

/** JPEG thật, tạo bằng chính sharp mà pipeline dùng. */
function anhThat(w = 40, h = 30) {
  const sharp = require('sharp');
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 60 } },
  })
    .jpeg()
    .toBuffer();
}

async function put(url, headers, body) {
  const res = await fetch(url, { method: 'PUT', headers, body });
  return { status: res.status, text: res.status >= 400 ? await res.text() : '' };
}

(async () => {
  console.log(`\nBucket đệm     : ${STAGING}`);
  console.log(`Trần dung lượng: ${Math.round(cdn.config.directUpload.maxBytes / 1048576)} MB`);

  const anh = await anhThat();
  console.log(`Ảnh thử        : ${anh.length} byte JPEG thật\n`);

  console.log('§1 — presign');
  let uploads;
  await t('cấp được presigned PUT, ký bằng host CÔNG KHAI', async () => {
    uploads = await cdn.directUpload.presign(
      USER,
      [{ filename: 'phase3-live.jpg', contentType: 'image/jpeg' }],
      'posts',
    );
    assert.strictEqual(uploads.length, 1);
    const u = new URL(uploads[0].putUrl);
    // Ký bằng endpoint private rồi cho client dùng qua tên miền công khai là
    // SignatureDoesNotMatch chắc chắn — SigV4 phủ Host.
    assert.strictEqual(u.host, new URL(cdn.config.publicUrl).host);
    assert.ok(uploads[0].stagingKey.startsWith(`${USER._id}/`), 'khoá phải mang tiền tố userId');
    CAN_DON.push({ bucket: STAGING, key: uploads[0].stagingKey });
  });

  console.log('\n§2 — PUT thật qua nginx vào MinIO');
  await t('PUT được vào vùng đệm', async () => {
    // Cần `location /cdn-staging/` trên vhost media. Thiếu nó thì nginx trả 404
    // và client âm thầm quay về multipart — đúng lỗi đã bắt được ngày 30/07.
    const r = await put(uploads[0].putUrl, uploads[0].requiredHeaders, anh);
    assert.ok(r.status >= 200 && r.status < 300, `nhận HTTP ${r.status} — ${r.text.slice(0, 200)}`);
  });

  await t('object có thật trên vùng đệm, đúng số byte', async () => {
    const h = await s3.headObject({ bucket: STAGING, key: uploads[0].stagingKey });
    assert.ok(h.exists, 'không thấy object');
    assert.strictEqual(h.size, anh.length);
  });

  await t('chữ ký chỉ phủ `host` ⇒ Content-Type KHÔNG bị chữ ký ràng buộc', async () => {
    // Ghi lại sự thật đã đo, chống lại trực giác "lệch Content-Type là 403".
    // Nếu một ngày SDK đổi sang ký cả content-type, phép thử này sẽ đỏ và nhắc ta
    // rằng client bắt buộc phải gửi header khớp từng ký tự.
    const u = new URL(uploads[0].putUrl);
    assert.strictEqual(u.searchParams.get('X-Amz-SignedHeaders'), 'host');

    const u2 = await cdn.directUpload.presign(
      USER,
      [{ filename: 'ct-lech.jpg', contentType: 'image/jpeg' }],
      'posts',
    );
    CAN_DON.push({ bucket: STAGING, key: u2[0].stagingKey });
    const r = await put(u2[0].putUrl, { 'Content-Type': 'image/png' }, anh);
    assert.ok(r.status >= 200 && r.status < 300, `chờ 2xx, nhận ${r.status}`);
  });

  await t('vùng đệm CHỈ GHI: GET từ ngoài bị nginx chặn', async () => {
    const res = await fetch(uploads[0].putUrl, { method: 'GET' });
    assert.ok(res.status === 403 || res.status === 405, `chờ 403/405, nhận ${res.status}`);
  });

  await t('preflight OPTIONS được trả lời (web client cần)', async () => {
    const res = await fetch(uploads[0].putUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://wis.wellspring.edu.vn', 'Access-Control-Request-Method': 'PUT' },
    });
    assert.strictEqual(res.status, 204, `nhận ${res.status}`);
    assert.ok(
      (res.headers.get('access-control-allow-methods') || '').includes('PUT'),
      'thiếu Allow-Methods: PUT',
    );
  });

  console.log('\n§3 — promote sang bucket đích + pipeline ảnh');
  let ketQua;
  await t('promote chạy xong, trả khoá cdn://', async () => {
    ketQua = await cdn.directUpload.promote(USER, uploads[0].stagingKey, 'posts');
    assert.ok(String(ketQua.stored).startsWith('cdn://'), `stored = ${ketQua.stored}`);
    CAN_DON.push({ stored: ketQua.stored });
    console.log(`       ${ketQua.stored}`);
    console.log(`       kind=${ketQua.kind} ct=${ketQua.contentType} ${ketQua.width}x${ketQua.height}`);
  });

  await t('vùng đệm đã được dọn sau promote', async () => {
    const h = await s3.headObject({ bucket: STAGING, key: uploads[0].stagingKey });
    assert.ok(!h.exists, 'object vẫn còn trên staging');
  });

  await t('ảnh thành WebP và ĐỌC ĐƯỢC qua URL đã ký', async () => {
    const url = cdn.signStored(ketQua.stored);
    assert.ok(url && url.startsWith('http'), `signStored trả ${url}`);
    const res = await fetch(url);
    assert.strictEqual(res.status, 200, `tải về nhận HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.slice(0, 4).toString('latin1'), 'RIFF', 'không phải WebP');
    assert.strictEqual(buf.slice(8, 12).toString('latin1'), 'WEBP', 'không phải WebP');
  });

  await t('KHÔNG ký thì không đọc được (bucket đích vẫn kín)', async () => {
    const url = cdn.signStored(ketQua.stored).split('?')[0];
    const res = await fetch(url);
    assert.ok(res.status === 403 || res.status === 404, `chờ 403/404, nhận ${res.status}`);
  });

  console.log('\n§4 — ranh giới bảo mật trên hạ tầng thật');
  await t('không promote được khoá của người khác', async () => {
    await assert.rejects(
      () => cdn.directUpload.promote({ _id: 'nguoi-khac' }, uploads[0].stagingKey, 'posts'),
      (e) => e.code === 'STAGING_KEY_FORBIDDEN',
    );
  });

  await t('vượt trần ⇒ promote xoá object, không để chiếm chỗ', async () => {
    const u = await cdn.directUpload.presign(
      USER,
      [{ filename: 'to.bin', contentType: 'application/octet-stream' }],
      'posts',
    );
    const to = Buffer.alloc(cdn.config.directUpload.maxBytes + 1024, 7);
    const r = await put(u[0].putUrl, u[0].requiredHeaders, to);
    assert.ok(r.status >= 200 && r.status < 300, `PUT nhận ${r.status}`);
    await assert.rejects(
      () => cdn.directUpload.promote(USER, u[0].stagingKey, 'posts'),
      (e) => e.code === 'FILE_TOO_LARGE',
    );
    const h = await s3.headObject({ bucket: STAGING, key: u[0].stagingKey });
    assert.ok(!h.exists, 'object vượt trần vẫn còn nằm lại');
  });

  console.log('\n§5 — dọn dẹp');
  for (const item of CAN_DON) {
    if (item.stored) await cdn.removeStored(item.stored);
    else await s3.deleteObject(item).catch(() => {});
  }
  console.log(`  đã dọn ${CAN_DON.length} mục`);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n[LỖI KHÔNG BẮT ĐƯỢC]', e);
  process.exit(1);
});
