#!/usr/bin/env node
/**
 * Smoke test WIRING thật của app.js — không cần Mongo/Redis/MinIO.
 *
 *   node scripts/test-cdn-wiring.js
 *
 * Dựng lại đúng chuỗi middleware như app.js (guard → static, cdnSignResponse →
 * routes) rồi gọi bằng HTTP thật. Test đơn vị ở test-cdn-phase1.js kiểm từng
 * hàm; file này kiểm thứ tự lắp ráp — nơi lỗi hay nằm mà unit test không thấy.
 */

process.env.CDN_ENABLED = 'true';
process.env.CDN_PUBLIC_URL = 'https://cdn.wellspring.edu.vn';
process.env.CDN_LINK_SECRET = 'test-secret-do-not-use-in-prod';
process.env.CDN_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.CDN_ACCESS_KEY = 'k';
process.env.CDN_SECRET_KEY = 's';

const assert = require('assert');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { config } = require('../services/cdn/config');

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

/** Thư mục uploads giả, có sẵn một "ảnh chat cũ" để thử rò rỉ. */
const uploadPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-wiring-'));
fs.mkdirSync(path.join(uploadPath, 'chat'), { recursive: true });
fs.writeFileSync(path.join(uploadPath, 'chat', 'chat-secret.jpg'), 'ANH-CHAT-RIENG-TU');

function buildApp() {
  const app = express();
  app.use(express.json());

  // ── sao chép ĐÚNG thứ tự trong app.js ──
  const staticUploadsOptions = {
    setHeaders(res) {
      if (!config.enabled) {
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      }
    },
  };
  const legacyUploadsGuard = require('../middleware/legacyUploadsGuard');
  const staticUploads = express.static(uploadPath, staticUploadsOptions);
  app.use('/uploads', legacyUploadsGuard, staticUploads);
  app.use('/api/social/uploads', legacyUploadsGuard, staticUploads);

  app.use(require('../middleware/cdnSignResponse'));

  // Route giả mô phỏng controller trả bài viết
  app.get('/api/social/fake-post', (req, res) => {
    res.json({
      success: true,
      data: {
        content: 'Nội dung không đổi',
        images: ['cdn://social-posts/2026/07/ab/x.webp'],
        legacy: ['/uploads/posts/old.jpg'],
        author: { avatarUrl: 'cdn://social-avatars/u/1.webp' },
      },
    });
  });
  return app;
}

function req(server, urlPath, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

(async () => {
  const server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('\nP3 — rò rỉ media cũ qua /uploads');

  await t('GET /uploads/chat/... ẩn danh ⇒ 403, KHÔNG lộ nội dung', async () => {
    const r = await req(server, '/uploads/chat/chat-secret.jpg');
    assert.strictEqual(r.status, 403);
    assert.ok(!r.body.includes('ANH-CHAT-RIENG-TU'), 'NỘI DUNG ẢNH BỊ LỘ');
  });

  await t('đường mount thứ hai /api/social/uploads cũng được chặn', async () => {
    const r = await req(server, '/api/social/uploads/chat/chat-secret.jpg');
    assert.strictEqual(r.status, 403);
    assert.ok(!r.body.includes('ANH-CHAT-RIENG-TU'));
  });

  await t('không lộ qua path traversal có mã hoá URL', async () => {
    for (const p of [
      '/uploads/..%2fchat/chat-secret.jpg',
      '/uploads/%2e%2e/chat/chat-secret.jpg',
      '/uploads//chat/chat-secret.jpg',
    ]) {
      const r = await req(server, p);
      assert.ok(!r.body.includes('ANH-CHAT-RIENG-TU'), `lộ qua ${p}`);
    }
  });

  console.log('\n§6.4 — ký media ở ranh giới response');

  await t('res.json trả URL đã ký, không còn cdn://', async () => {
    const r = await req(server, '/api/social/fake-post');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('cdn://'), 'khoá thô cdn:// lọt ra client');
    const j = JSON.parse(r.body);
    assert.ok(j.data.images[0].startsWith('https://cdn.wellspring.edu.vn/social-posts/'));
    assert.ok(j.data.images[0].includes('?e=') && j.data.images[0].includes('&s='));
  });

  await t('giá trị legacy trong DB cũng ra URL CDN đã ký', async () => {
    const j = JSON.parse((await req(server, '/api/social/fake-post')).body);
    assert.ok(j.data.legacy[0].includes('/social-posts/legacy/old.jpg?e='));
  });

  await t('nội dung văn bản không bị đụng tới', async () => {
    const j = JSON.parse((await req(server, '/api/social/fake-post')).body);
    assert.strictEqual(j.data.content, 'Nội dung không đổi');
  });

  console.log('\n§11 — đường rollback');

  await t('CDN tắt ⇒ /uploads phục vụ lại bình thường + cache public', async () => {
    config.enabled = false;
    const r = await req(server, '/uploads/chat/chat-secret.jpg');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('ANH-CHAT-RIENG-TU'), 'rollback hỏng — media cũ không phục vụ được');
    assert.ok(/public/.test(r.headers['cache-control'] || ''), 'thiếu cache header cũ');
    config.enabled = true;
  });

  await t('CDN tắt ⇒ response giữ nguyên khoá thô (không ký)', async () => {
    config.enabled = false;
    const r = await req(server, '/api/social/fake-post');
    assert.ok(r.body.includes('cdn://social-posts'), 'vẫn ký dù CDN đã tắt');
    config.enabled = true;
  });

  server.close();
  fs.rmSync(uploadPath, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
