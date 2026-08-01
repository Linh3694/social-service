#!/usr/bin/env node
/**
 * Kiểm chứng tầng CDN Phase 1 — chạy độc lập, KHÔNG cần MinIO/Mongo/Redis.
 *
 *   node scripts/test-cdn-phase1.js
 *
 * Phủ đúng những chỗ CDN-Design.md §13 đánh dấu là dễ sai:
 *   - thuật toán ký phải khớp ngx_http_secure_link_module (lệch ⇒ 403 toàn bộ)
 *   - làm tròn cửa sổ (§3.2) — sai ⇒ cache miss 100%
 *   - EXIF/GPS phải bị loại (P5) và ảnh dọc không được xoay ngang (§7.1)
 *   - signMediaDeep phải phủ cả nhánh lồng sâu (§6.4)
 *   - guard /uploads phải chặn ẩn danh (P3)
 */

process.env.CDN_ENABLED = 'true';
process.env.CDN_PUBLIC_URL = 'https://cdn.wellspring.edu.vn';
process.env.CDN_LINK_SECRET = 'test-secret-do-not-use-in-prod';
process.env.CDN_S3_ENDPOINT = 'http://127.0.0.1:9000';
process.env.CDN_ACCESS_KEY = 'k';
process.env.CDN_SECRET_KEY = 's';
process.env.CDN_AVATAR_ENABLED = 'true';

const assert = require('assert');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { signPath, signStored } = require('../services/cdn/sign');
const { toObjectPath } = require('../services/cdn/resolve');
const { signMediaDeep } = require('../services/cdn/signDeep');
const { processImage } = require('../services/cdn/imagePipeline');
const { contentDispositionFor, alignExt } = require('../services/cdn');
const { config } = require('../services/cdn/config');

let pass = 0;
let fail = 0;
const failures = [];

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Đúng thuật toán nginx, tính bằng openssl để độc lập với code đang test. */
function nginxSecureLink(expires, uri, secret) {
  const out = execFileSync(
    'bash',
    ['-c', `printf '%s' "${expires}${uri} ${secret}" | openssl md5 -binary | openssl base64 | tr +/ -_ | tr -d '='`],
    { encoding: 'utf8' },
  );
  return out.trim();
}

function parse(url) {
  const u = new URL(url);
  return { path: u.pathname, e: u.searchParams.get('e'), s: u.searchParams.get('s') };
}

(async () => {
  // ─────────────────────────────────────────────────────────────────────
  section('§3.1 Ký URL — phải khớp ngx_http_secure_link_module');

  await t('chữ ký khớp openssl (md5 nhị phân → base64url)', () => {
    const url = signPath('/social-posts/2026/07/ab/abc.webp');
    const { path, e, s } = parse(url);
    assert.strictEqual(s, nginxSecureLink(e, path, config.linkSecret));
  });

  await t('chuỗi băm có ĐÚNG một dấu cách trước secret', () => {
    const url = signPath('/social-posts/x.webp');
    const { path, e, s } = parse(url);
    const correct = crypto.createHash('md5').update(`${e}${path} ${config.linkSecret}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const noSpace = crypto.createHash('md5').update(`${e}${path}${config.linkSecret}`).digest('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    assert.strictEqual(s, correct);
    assert.notStrictEqual(s, noSpace, 'thiếu dấu cách vẫn pass ⇒ test vô nghĩa');
  });

  await t('base64url: không còn ký tự +, /, =', () => {
    // thử nhiều path để chắc chắn gặp trường hợp có +/ trong base64 chuẩn
    for (let i = 0; i < 200; i += 1) {
      const { s } = parse(signPath(`/social-posts/probe-${i}.webp`));
      assert.ok(!/[+/=]/.test(s), `chữ ký còn ký tự chưa escape: ${s}`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  section('§3.2 Làm tròn cửa sổ — mấu chốt để cache hit');

  await t('hai lần ký liên tiếp cho URL GIỐNG HỆT nhau', () => {
    const a = signPath('/social-posts/2026/07/ab/x.webp');
    const b = signPath('/social-posts/2026/07/ab/x.webp');
    assert.strictEqual(a, b);
  });

  await t('expiry rơi đúng mốc biên cửa sổ (chia hết cho window)', () => {
    const { e } = parse(signPath('/social-posts/x.webp'));
    const { window, lifetime } = config.sign.default;
    assert.strictEqual((Number(e) - lifetime) % window, 0);
  });

  await t('URL sống trong khoảng [lifetime, lifetime+window]', () => {
    const { e } = parse(signPath('/social-posts/x.webp'));
    const remain = Number(e) - Math.floor(Date.now() / 1000);
    const { window, lifetime } = config.sign.default;
    assert.ok(remain >= lifetime - 2, `còn ${remain}s < lifetime ${lifetime}s`);
    assert.ok(remain <= lifetime + window + 2, `còn ${remain}s > lifetime+window`);
  });

  await t('bucket chat dùng TTL ngắn hơn hẳn bài đăng (§3.4)', () => {
    const now = Math.floor(Date.now() / 1000);
    const chat = Number(parse(signPath('/social-chat/a.webp')).e) - now;
    const post = Number(parse(signPath('/social-posts/a.webp')).e) - now;
    assert.ok(chat < post, `chat ${chat}s phải < post ${post}s`);
    assert.ok(chat <= config.sign.chat.lifetime + config.sign.chat.window + 2);
  });

  await t('đổi CDN_LINK_SECRET ⇒ chữ ký cũ chết (kill switch §11)', () => {
    const before = parse(signPath('/social-posts/x.webp')).s;
    const original = config.linkSecret;
    config.linkSecret = 'secret-da-doi';
    const after = parse(signPath('/social-posts/x.webp')).s;
    config.linkSecret = original;
    assert.notStrictEqual(before, after);
  });

  // ─────────────────────────────────────────────────────────────────────
  section('§9 Resolver dữ liệu cũ');

  await t('ánh xạ 4 dạng giá trị legacy', () => {
    assert.strictEqual(toObjectPath('/api/social/uploads/posts/f-1.jpg'), '/social-posts/legacy/f-1.jpg');
    assert.strictEqual(toObjectPath('/uploads/posts/f-2.jpg'), '/social-posts/legacy/f-2.jpg');
    assert.strictEqual(toObjectPath('/api/social/uploads/chat/c-1.jpg'), '/social-chat/legacy/c-1.jpg');
    assert.strictEqual(toObjectPath('/uploads/chat/c-2.jpg'), '/social-chat/legacy/c-2.jpg');
  });

  await t('khoá CDN mới đi thẳng', () => {
    assert.strictEqual(toObjectPath('cdn://social-posts/2026/07/ab/x.webp'), '/social-posts/2026/07/ab/x.webp');
  });

  await t('CHẶN path traversal', () => {
    assert.strictEqual(toObjectPath('/uploads/chat/../../etc/passwd'), null);
    assert.strictEqual(toObjectPath('/uploads/chat/a/b.jpg'), null);
    assert.strictEqual(toObjectPath('/files/Avatar/../x.png'), null);
  });

  await t('URL tuyệt đối bên ngoài giữ nguyên (trả null)', () => {
    assert.strictEqual(toObjectPath('https://example.com/a.jpg'), null);
    assert.strictEqual(toObjectPath('http://example.com/a.jpg'), null);
  });

  await t('giá trị rác không làm vỡ', () => {
    for (const v of [null, undefined, 42, {}, [], '', '   ', true]) {
      assert.strictEqual(toObjectPath(v), null);
    }
  });

  await t('avatar Frappe đổi đuôi sang .webp', () => {
    assert.strictEqual(toObjectPath('/files/Avatar/abc.png'), '/social-avatars/users/abc.webp');
  });

  // ─────────────────────────────────────────────────────────────────────
  section('§6.4 signMediaDeep — điểm ký duy nhất');

  await t('ký ảnh lồng sâu trong post + comment + author', () => {
    const out = signMediaDeep({
      data: {
        images: ['cdn://social-posts/a.webp', '/uploads/posts/old.jpg'],
        authorSnapshot: { avatarUrl: 'cdn://social-avatars/u/1.webp' },
        comments: [{ user: { user_image: '/uploads/posts/c.jpg' } }],
      },
    });
    assert.ok(out.data.images[0].startsWith('https://cdn.wellspring.edu.vn/social-posts/a.webp?e='));
    assert.ok(out.data.images[1].includes('/social-posts/legacy/old.jpg?e='));
    assert.ok(out.data.authorSnapshot.avatarUrl.includes('/social-avatars/u/1.webp?e='));
    assert.ok(out.data.comments[0].user.user_image.includes('/social-posts/legacy/c.jpg?e='));
  });

  await t('ký payload chat lồng trong replyTo (đường realtime hay sót)', () => {
    const out = signMediaDeep({
      attachments: [{ kind: 'image', url: 'cdn://social-chat/x.webp' }],
      replyTo: { attachments: [{ url: 'cdn://social-chat/y.webp' }] },
    });
    assert.ok(out.attachments[0].url.includes('/social-chat/x.webp?e='));
    assert.ok(out.replyTo.attachments[0].url.includes('/social-chat/y.webp?e='));
  });

  await t('KHÔNG đụng vào chuỗi thường (nội dung, tên người)', () => {
    const out = signMediaDeep({ content: 'Chào cả nhà', name: 'Nguyễn Văn A', n: 5, ok: true });
    assert.deepStrictEqual(out, { content: 'Chào cả nhà', name: 'Nguyễn Văn A', n: 5, ok: true });
  });

  await t('structural sharing: nhánh không media giữ nguyên tham chiếu', () => {
    const inner = { content: 'không có ảnh' };
    const out = signMediaDeep({ inner, img: 'cdn://social-posts/a.webp' });
    assert.strictEqual(out.inner, inner, 'nhánh sạch bị clone thừa ⇒ tốn GC trên feed lớn');
  });

  await t('xử lý được mongoose document (toJSON)', () => {
    const doc = { toJSON: () => ({ images: ['cdn://social-posts/a.webp'] }) };
    const out = signMediaDeep({ post: doc });
    assert.ok(out.post.images[0].includes('/social-posts/a.webp?e='));
  });

  await t('Date không bị phá (toJSON trả primitive)', () => {
    const d = new Date('2026-07-30T10:00:00.000Z');
    const out = signMediaDeep({ createdAt: d });
    assert.strictEqual(out.createdAt, '2026-07-30T10:00:00.000Z');
  });

  await t('cấu trúc vòng không làm treo event loop', () => {
    const a = { img: 'cdn://social-posts/a.webp' };
    a.self = a;
    const out = signMediaDeep(a); // MAX_DEPTH cắt, không stack overflow
    assert.ok(out.img.includes('?e='));
  });

  await t('CDN tắt ⇒ trả nguyên payload, không ký', () => {
    config.enabled = false;
    const input = { images: ['cdn://social-posts/a.webp'] };
    assert.strictEqual(signMediaDeep(input), input);
    config.enabled = true;
  });

  // ─────────────────────────────────────────────────────────────────────
  section('§7.1 Pipeline ảnh — EXIF/GPS (P5) và orientation');

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('  ⏭️  bỏ qua: sharp không nạp được trong môi trường này');
  }

  if (sharp) {
    // Ảnh NGANG 1200x800, gắn EXIF có toạ độ GPS + Orientation=6 (xoay 90° CW).
    // Orientation 6 ⇒ sau .rotate() ảnh phải thành DỌC 800x1200.
    const withExif = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: {
          IFD0: { Copyright: 'Wellspring', Make: 'Apple', Model: 'iPhone 15 Pro' },
          GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
        },
      })
      .toBuffer();

    await t('ảnh nguồn THỰC SỰ có EXIF (nếu không, test sau vô nghĩa)', async () => {
      const meta = await sharp(withExif).metadata();
      assert.ok(meta.exif && meta.exif.length > 0, 'không tạo được EXIF để test');
      assert.strictEqual(meta.orientation, 6);
    });

    let result;
    await t('processImage chạy thành công', async () => {
      result = await processImage(withExif);
      assert.strictEqual(result.ok, true, result.reason || '');
    });

    await t('EXIF/GPS bị loại khỏi ảnh đầu ra (P5)', async () => {
      const meta = await sharp(result.main.buffer).metadata();
      assert.ok(!meta.exif, 'EXIF vẫn còn ⇒ toạ độ GPS ảnh học sinh bị lộ');
    });

    await t('orientation được ÁP trước khi strip (ảnh dọc không bị xoay ngang)', async () => {
      const meta = await sharp(result.main.buffer).metadata();
      assert.strictEqual(meta.width, 800, `rộng ${meta.width}, kỳ vọng 800`);
      assert.strictEqual(meta.height, 1200, `cao ${meta.height}, kỳ vọng 1200`);
    });

    await t('đầu ra là WebP', () => {
      assert.strictEqual(result.main.ext, 'webp');
      assert.strictEqual(result.main.contentType, 'image/webp');
    });

    await t('sinh variants nhỏ hơn ảnh chính', async () => {
      assert.ok(result.variants.length > 0, 'không sinh variant nào');
      for (const v of result.variants) {
        const meta = await sharp(v.buffer).metadata();
        assert.ok(meta.width <= result.main.width, `${v.suffix} rộng hơn ảnh chính`);
        assert.ok(!meta.exif, `${v.suffix} còn EXIF`);
      }
    });

    await t('ảnh nhỏ hơn variant thì KHÔNG phóng to', async () => {
      const tiny = await sharp({
        create: { width: 200, height: 150, channels: 3, background: { r: 1, g: 2, b: 3 } },
      }).jpeg().toBuffer();
      const r = await processImage(tiny);
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.variants.length, 0, 'đã phóng to ảnh nhỏ — phí dung lượng');
    });

    await t('ảnh lớn bị giới hạn về maxWidth', async () => {
      const huge = await sharp({
        create: { width: 5000, height: 3000, channels: 3, background: { r: 9, g: 9, b: 9 } },
      }).jpeg().toBuffer();
      const r = await processImage(huge);
      assert.strictEqual(r.main.width, config.image.maxWidth);
    });

    await t('WebP giảm dung lượng đáng kể so với JPEG gốc', async () => {
      // Ảnh nhiễu ngẫu nhiên = trường hợp XẤU NHẤT cho nén (không nén được nhiều).
      const noise = Buffer.alloc(1600 * 1200 * 3);
      crypto.randomFillSync(noise);
      const jpg = await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } })
        .jpeg({ quality: 92 }).toBuffer();
      const r = await processImage(jpg);
      const ratio = r.main.buffer.length / jpg.length;
      console.log(`       JPEG ${(jpg.length / 1024).toFixed(0)}KB → WebP ${(r.main.buffer.length / 1024).toFixed(0)}KB (${(ratio * 100).toFixed(0)}%)`);
      assert.ok(ratio < 1, 'WebP không nhỏ hơn JPEG kể cả ở ảnh nhiễu');
    });

    await t('file hỏng KHÔNG throw (bài đăng vẫn tạo được — §13)', async () => {
      const r = await processImage(Buffer.from('day khong phai anh'));
      assert.strictEqual(r.ok, false);
      assert.ok(r.reason);
    });

    await t('selfTest báo sharp sẵn sàng (chặn hỏng âm thầm — P5)', () => {
      const { selfTest } = require('../services/cdn/imagePipeline');
      const r = selfTest();
      assert.strictEqual(r.ok, true, 'selfTest phải xanh khi sharp nạp được');
      assert.ok(r.versions?.vips, 'thiếu version libvips');
    });

    // ───────────────────────────────────────────────────────────────────
    section('SIS-172 Ảnh HEIC từ iPhone — phải ra WebP, không được giữ nguyên bản');

    const heicDecode = require('../services/cdn/heicDecode');
    const heic = heicDecode.tinyHeicBuffer();

    // Ghi lại hiện trạng để người sau biết vì sao cần libheif riêng. Cố tình KHÔNG
    // assert: sharp mai này có HEIC thì đó là tin tốt, không phải test hỏng.
    //
    // PHẢI thử GIẢI MÃ chứ đừng thử `metadata()`: libvips đọc được phần container
    // của HEIF nên `metadata()` trả 64x32 rất thuyết phục, chỉ tới lúc đụng pixel
    // mới lộ ra là không có bộ giải mã HEVC.
    try {
      await sharp(heic).resize(16).webp().toBuffer();
      console.log('       ℹ️  sharp bản này ĐÃ giải mã được HEIC — cân nhắc bỏ libheif-js');
    } catch (error) {
      console.log(`       ℹ️  sharp một mình không giải mã được HEIC ("${error.message.slice(0, 40)}") ⇒ cần libheif`);
    }

    await t('isHeic nhận đúng HEIC, không nhận JPEG/PNG', async () => {
      assert.strictEqual(heicDecode.isHeic(heic), true, 'không nhận ra file HEIC');
      const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .jpeg().toBuffer();
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png().toBuffer();
      assert.strictEqual(heicDecode.isHeic(jpg), false, 'nhận nhầm JPEG là HEIC');
      assert.strictEqual(heicDecode.isHeic(png), false, 'nhận nhầm PNG là HEIC');
      assert.strictEqual(heicDecode.isHeic(Buffer.alloc(4)), false, 'buffer quá ngắn phải trả false');
    });

    await t('KHÔNG cướp AVIF khỏi sharp (cùng họ HEIF nhưng sharp đọc được)', async () => {
      const avif = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 7, g: 8, b: 9 } } })
        .avif({ quality: 40 }).toBuffer();
      assert.strictEqual(heicDecode.isHeic(avif), false, 'AVIF bị đẩy nhầm sang libheif');
      const r = await processImage(avif);
      assert.strictEqual(r.ok, true, `AVIF phải xử lý được: ${r.reason || ''}`);
    });

    await t('processImage chuyển HEIC sang WebP (SIS-171 — không còn giữ nguyên .heic)', async () => {
      const r = await processImage(heic);
      assert.strictEqual(r.ok, true, `HEIC vẫn hỏng: ${r.reason || ''}`);
      assert.strictEqual(r.main.ext, 'webp', 'HEIC không ra WebP ⇒ trình duyệt vẫn không xem được');
      assert.strictEqual(r.main.contentType, 'image/webp');
      assert.strictEqual(r.main.width, 64, `rộng ${r.main.width}, kỳ vọng 64`);
      assert.strictEqual(r.main.height, 32, `cao ${r.main.height}, kỳ vọng 32`);
    });

    await t('ảnh HEIC đầu ra không còn metadata (GPS không thể lọt — P5)', async () => {
      const r = await processImage(heic);
      const meta = await sharp(r.main.buffer).metadata();
      assert.ok(!meta.exif, 'EXIF vẫn còn trong ảnh HEIC đã xử lý');
    });

    await t('nhiều ảnh HEIC song song vẫn đúng (hàng đợi decoder dùng chung)', async () => {
      // Đường multipart chạy Promise.all trên từng file (chatController.js:1635).
      // Không xếp hàng thì lượt sau giải phóng context lượt trước đang đọc.
      const rs = await Promise.all([heic, heic, heic, heic].map((b) => processImage(b)));
      for (const r of rs) {
        assert.strictEqual(r.ok, true, `một lượt song song hỏng: ${r.reason || ''}`);
        assert.strictEqual(r.main.width, 64);
      }
    });

    await t('file HEIC hỏng KHÔNG throw, vẫn fallback như cũ', async () => {
      // Giữ nguyên header ftyp cho isHeic() nhận, phần thân là rác.
      const hong = Buffer.concat([heic.subarray(0, 32), crypto.randomBytes(200)]);
      const r = await processImage(hong);
      assert.strictEqual(r.ok, false, 'file rác lại báo thành công');
      assert.ok(r.reason);
    });

    await t('hàng đợi không kẹt sau khi một ảnh hỏng', async () => {
      const r = await processImage(heic);
      assert.strictEqual(r.ok, true, `ảnh tốt sau ảnh hỏng lại lỗi: ${r.reason || ''}`);
    });

    await t('selfTestHeic báo decoder sẵn sàng (chặn hỏng âm thầm — SIS-171)', async () => {
      const { selfTestHeic } = require('../services/cdn/imagePipeline');
      const r = await selfTestHeic();
      assert.strictEqual(r.ok, true, `selfTestHeic đỏ: ${r.reason || ''}`);
      assert.strictEqual(r.width, 64);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  section('P3 Guard /uploads — chặn truy cập ẩn danh');

  const guard = require('../middleware/legacyUploadsGuard');

  function fakeRes() {
    const res = {
      statusCode: null, body: null, headers: {},
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      setHeader(k, v) { this.headers[k] = v; },
      removeHeader(k) { delete this.headers[k]; },
    };
    return res;
  }

  await t('không token ⇒ 403, KHÔNG serve file', async () => {
    const res = fakeRes();
    let nexted = false;
    await guard({ headers: {}, query: {} }, res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(nexted, false, 'đã đi tiếp tới express.static ⇒ vẫn lộ file');
    assert.strictEqual(res.body.code, 'LEGACY_UPLOADS_FORBIDDEN');
  });

  await t('token rác ⇒ 403', async () => {
    const res = fakeRes();
    let nexted = false;
    await guard({ headers: {}, query: { token: 'khong-phai-jwt' } }, res, () => { nexted = true; });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(nexted, false);
  });

  await t('CDN tắt ⇒ cho qua (đường rollback §11 nguyên vẹn)', async () => {
    config.enabled = false;
    const res = fakeRes();
    let nexted = false;
    await guard({ headers: {}, query: {} }, res, () => { nexted = true; });
    assert.strictEqual(nexted, true, 'rollback bị chặn ⇒ tắt CDN là mất hết ảnh cũ');
    assert.strictEqual(res.statusCode, null);
    config.enabled = true;
  });

  await t('đếm được lượt bị chặn (để biết khi nào gỡ mount an toàn)', () => {
    assert.ok(guard.stats.denied >= 2);
  });

  // ─────────────────────────────────────────────────────────────────────
  section('Content-Disposition — giữ tên file gốc (khoá là hash nên URL không mang tên)');

  await t('tên tiếng Việt: filename* mang UTF-8, filename ASCII là bản dự phòng', () => {
    const cd = contentDispositionFor('PR, PO - mẫu mới (3).xlsx');
    assert.ok(cd.startsWith('inline; '), `phải là inline để PDF/ảnh còn xem trước được: ${cd}`);
    assert.ok(
      cd.includes("filename*=UTF-8''PR%2C%20PO%20-%20m%E1%BA%ABu%20m%E1%BB%9Bi%20%283%29.xlsx"),
      `filename* sai: ${cd}`,
    );
    const ascii = /filename="([^"]*)"/.exec(cd)[1];
    assert.ok(!/[^\x20-\x7e]/.test(ascii), `filename ASCII còn ký tự ngoài ASCII: ${ascii}`);
    assert.ok(ascii.endsWith('.xlsx'), `mất đuôi file ⇒ Windows không mở được: ${ascii}`);
  });

  await t("`(`, `)` phải percent-encode (không thuộc attr-char RFC 5987)", () => {
    const cd = contentDispositionFor('bao cao (1).pdf');
    assert.ok(!/filename\*=UTF-8''[^;]*[()]/.test(cd), `còn ngoặc thô trong filename*: ${cd}`);
  });

  await t('CR/LF trong tên bị loại — không chèn được header', () => {
    const cd = contentDispositionFor('a\r\nX-Injected: 1\r\n.docx');
    assert.ok(!/[\r\n]/.test(cd), `header còn ký tự xuống dòng: ${JSON.stringify(cd)}`);
  });

  await t('dấu tách đường dẫn bị loại — tên file không mang đường dẫn', () => {
    const cd = contentDispositionFor('../../etc/passwd');
    assert.ok(!cd.includes('/'), cd);
    assert.ok(!cd.includes('\\'), cd);
  });

  await t('không có tên đáng tin ⇒ undefined (không set header bịa)', () => {
    assert.strictEqual(contentDispositionFor(''), undefined);
    assert.strictEqual(contentDispositionFor('   '), undefined);
    assert.strictEqual(contentDispositionFor(undefined), undefined);
  });

  await t('ảnh chuyển WebP ⇒ đuôi tên tải về đi theo nội dung thật', () => {
    assert.strictEqual(alignExt('anh nghỉ phép.jpg', 'webp'), 'anh nghỉ phép.webp');
    assert.strictEqual(alignExt('anh.JPEG', 'webp'), 'anh.webp');
  });

  await t('đuôi đã khớp / tên không có đuôi ⇒ không phá tên', () => {
    assert.strictEqual(alignExt('PR, PO - mẫu mới (3).xlsx', 'xlsx'), 'PR, PO - mẫu mới (3).xlsx');
    assert.strictEqual(alignExt('bao.cao.thang.5.docx', 'docx'), 'bao.cao.thang.5.docx');
    assert.strictEqual(alignExt('khong-co-duoi', 'pdf'), 'khong-co-duoi.pdf');
    assert.strictEqual(alignExt('', 'webp'), '');
  });

  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass} pass, ${fail} fail`);
  if (fail) {
    console.log('\nChi tiết lỗi:');
    for (const f of failures) console.log(`  • ${f.name}\n    ${f.error.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
  process.exit(fail ? 1 : 0);
})();
