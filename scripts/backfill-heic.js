/**
 * 🔧 Backfill ảnh HEIC đã lưu trên CDN sang WebP (SIS-173)
 *
 * Chạy thử (KHÔNG ghi gì):  node scripts/backfill-heic.js
 * Ghi thật:                 node scripts/backfill-heic.js --apply
 *
 * VÌ SAO CẦN SCRIPT NÀY. Trước SIS-172, `sharp` không giải mã được HEIC nên
 * pipeline rơi vào nhánh giữ nguyên bản gốc: object trên MinIO là .heic, và
 * KHÔNG trình duyệt nào ngoài Safari hiển thị được (SIS-171). Sửa pipeline chỉ
 * có tác dụng với ảnh gửi TỪ NAY; ảnh đã gửi vẫn hỏng cho tới khi chạy script này.
 *
 * KHÔNG mất thêm chất lượng: file .heic đang lưu CHÍNH LÀ bản gốc chưa qua nén
 * lần nào, nên kết quả bằng đúng ảnh mới sau khi sửa.
 *
 * PHẠM VI — chỉ ảnh có khoá `cdn://` (chốt với Hiếu 01/08/2026):
 *
 *   ✅ ChatMessage.attachments[].url
 *   ✅ Post.images[]
 *   ❌ Ảnh legacy (prefix `legacy/`, từ trước khi bật CDN) — CỐ Ý bỏ qua. Khoá
 *      của chúng là TÊN FILE GỐC chứ không phải hash, và `resolve.js` ánh xạ tất
 *      định theo đúng tên + đuôi đó, nên đổi sang .webp phải sửa resolver hoặc
 *      sửa giá trị DB cũ — cả hai đều ngoài phạm vi. Script vẫn ĐẾM và IN ra số
 *      bị bỏ qua để không ai tưởng nhầm là đã quét hết.
 *
 * AN TOÀN
 *   • Dry-run là mặc định. Không có `--apply` thì không ghi MinIO, không ghi DB.
 *   • KHÔNG xoá object .heic cũ — còn nguyên để rollback. Dọn ở lần chạy riêng.
 *   • Idempotent: chạy lại lần hai không tìm thấy gì (URL đã thành .webp).
 *   • Chạy tuần tự: bộ giải mã HEIC vốn đã xếp hàng (heicDecode.js), chạy song
 *     song chỉ tốn RAM chứ không nhanh hơn.
 *
 * TRƯỚC KHI CHẠY THẬT
 *   1. Deploy SIS-172 (script dùng chung `storeBuffer`, thiếu bản vá thì mọi ảnh
 *      lại ra .heic — script tự phát hiện và báo lỗi chứ không ghi bừa).
 *   2. mongodump.
 *   3. Chạy giờ thấp điểm.
 *
 * SAU KHI CHẠY: nginx có thể còn cache URL cũ tới hết max-age (chat 1 giờ,
 * posts 24 giờ) nên ảnh chưa đổi ngay lập tức là bình thường.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config.env') });
const mongoose = require('mongoose');
const path = require('path');

const ChatMessage = require('../models/ChatMessage');
const Post = require('../models/Post');
const cdn = require('../services/cdn');
const s3 = require('../services/cdn/s3');
const { config, validate } = require('../services/cdn/config');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wis_social';
const APPLY = process.argv.includes('--apply');

/** Khớp khoá ảnh HEIC/HEIF. Khoá lưu DB không có query string nên neo cuối chuỗi là đủ. */
const HEIC_KEY_RE = /\.hei[cf]$/i;

/** Truy vấn Mongo dùng chung — cùng một biểu thức để đếm và để quét. */
const CHAT_QUERY = { 'attachments.url': { $regex: '\\.hei[cf]$', $options: 'i' } };
const POST_QUERY = { images: { $regex: '\\.hei[cf]$', $options: 'i' } };

const stats = {
  chatMessages: 0,
  chatAttachments: 0,
  posts: 0,
  postImages: 0,
  legacyBoQua: 0,
  loi: 0,
  bytesTruoc: 0,
  bytesSau: 0,
};

/** Khoá cũ → khoá mới. Ảnh trùng nội dung dùng chung khoá ⇒ chỉ chuyển một lần. */
const daChuyen = new Map();
/** Khoá legacy đã gặp — đếm theo KHOÁ chứ không theo lượt tham chiếu. */
const legacyDaGap = new Set();
const loiTheoKhoa = new Map();
const viDu = [];

function laKhoaCdn(v) {
  return typeof v === 'string' && v.startsWith(cdn.CDN_SCHEME);
}

/** `cdn://social-chat/2026/08/ab/<hash>.heic` → `{ bucket, key, kind }` */
function boKhoa(stored) {
  const rest = stored.slice(cdn.CDN_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const prefix = rest.slice(0, slash);
  const key = rest.slice(slash + 1);
  if (!key) return null;
  // prefix `social-chat` → kind `chat` (tên bucket là `cdn-<prefix>`).
  const kind = prefix === 'social-chat' ? 'chat' : prefix === 'social-posts' ? 'posts' : null;
  if (!kind) return null;
  return { bucket: `cdn-${prefix}`, key, kind };
}

/**
 * Chuyển một object .heic sang .webp.
 *
 * Trả về object chứ không phải chuỗi, vì có ba kết cục khác nhau mà một giá trị
 * `string|null` không phân biệt được — và nhầm chúng chính là cách làm hỏng
 * dry-run: "sẽ chuyển" (chưa có khoá mới) khác hẳn "bỏ qua/lỗi" (không bao giờ
 * có khoá mới). Lẫn hai cái là dry-run báo 0 ảnh trong khi thực tế có hàng nghìn.
 *
 * @returns {Promise<{doi: boolean, stored: string|null}>}
 *   doi=false ⇒ giữ nguyên attachment (legacy, khoá lạ, hoặc lỗi)
 *   doi=true, stored=null ⇒ dry-run: sẽ chuyển nhưng chưa làm gì
 *   doi=true, stored='cdn://…webp' ⇒ đã chuyển xong
 */
async function chuyenMotKhoa(stored, downloadName) {
  if (daChuyen.has(stored)) return { doi: true, stored: daChuyen.get(stored) };
  if (loiTheoKhoa.has(stored) || legacyDaGap.has(stored)) return { doi: false, stored: null };

  // Ảnh legacy có HAI dạng trong DB và cả hai đều ngoài phạm vi. Phải ĐẾM chứ
  // không được lặng lẽ bỏ qua: con số này chính là "còn bao nhiêu ảnh vẫn hỏng",
  // im lặng ở đây là báo cáo sai thành "đã quét sạch".
  //   1. `/uploads/chat/IMG.heic` — bản ghi trước khi bật CDN; §9 cố ý KHÔNG sửa
  //      giá trị DB cũ nên chúng vẫn nguyên dạng này.
  //   2. `cdn://social-chat/legacy/IMG.heic` — nếu đã chạy cdn-rewrite-legacy-urls.
  if (!laKhoaCdn(stored)) {
    legacyDaGap.add(stored);
    stats.legacyBoQua += 1;
    return { doi: false, stored: null };
  }

  const bo = boKhoa(stored);
  if (!bo) {
    stats.loi += 1;
    loiTheoKhoa.set(stored, 'khoá không nhận dạng được');
    console.error(`   ⚠️  khoá lạ, bỏ qua: ${stored}`);
    return { doi: false, stored: null };
  }

  if (bo.key.startsWith('legacy/')) {
    legacyDaGap.add(stored);
    stats.legacyBoQua += 1;
    return { doi: false, stored: null };
  }

  if (!APPLY) {
    daChuyen.set(stored, null);
    if (viDu.length < 10) viDu.push({ from: stored, to: '(sẽ chuyển sang .webp)' });
    return { doi: true, stored: null };
  }

  try {
    const { buffer } = await s3.getObjectBuffer({ bucket: bo.bucket, key: bo.key });
    const ketQua = await cdn.storeBuffer(buffer, {
      kind: bo.kind,
      originalname: path.basename(bo.key),
      mimetype: 'image/heic',
      downloadName: downloadName || undefined,
    });

    // Chốt chặn quan trọng: pipeline vẫn có nhánh "giữ nguyên bản gốc". Nếu
    // SIS-172 chưa được deploy thì storeBuffer trả lại đúng một khoá .heic khác
    // — ghi vào DB là vô nghĩa mà lại tưởng đã xong.
    if (HEIC_KEY_RE.test(ketQua.stored)) {
      stats.loi += 1;
      loiTheoKhoa.set(stored, 'vẫn ra .heic — pipeline chưa có bản vá SIS-172?');
      console.error(`   ❌ ${bo.key}: chuyển xong VẪN là .heic — kiểm tra đã deploy SIS-172 chưa`);
      return { doi: false, stored: null };
    }

    stats.bytesTruoc += buffer.length;
    stats.bytesSau += ketQua.size;
    daChuyen.set(stored, ketQua.stored);
    if (viDu.length < 10) viDu.push({ from: stored, to: ketQua.stored });
    return { doi: true, stored: ketQua.stored };
  } catch (error) {
    stats.loi += 1;
    loiTheoKhoa.set(stored, error.message);
    console.error(`   ❌ ${bo.key}: ${error.message}`);
    return { doi: false, stored: null };
  }
}

async function backfillChat() {
  const total = await ChatMessage.countDocuments(CHAT_QUERY);
  console.log(`\n💬 Tin nhắn chat có ảnh HEIC: ${total}`);
  if (!total) return;

  const cursor = ChatMessage.find(CHAT_QUERY, { attachments: 1 }).lean().cursor();

  for await (const msg of cursor) {
    const attachments = msg.attachments || [];
    let dirty = false;

    const next = [];
    for (const att of attachments) {
      // Lọc theo ĐUÔI thôi, đừng lọc luôn cả `cdn://` ở đây: ảnh legacy dạng
      // `/uploads/chat/…heic` cũng phải đi vào để được ĐẾM là bỏ qua.
      if (!HEIC_KEY_RE.test(att.url || '')) {
        next.push(att);
        continue;
      }
      stats.chatAttachments += 1;

      const kq = await chuyenMotKhoa(att.url, att.name);
      if (!kq.doi) {
        next.push(att);
        continue;
      }
      dirty = true;
      if (!kq.stored) {
        // Dry-run: đã đếm là "sẽ đổi", nhưng không được sinh dữ liệu mới.
        next.push(att);
        continue;
      }

      next.push({
        ...att,
        url: kq.stored,
        // Tên hiển thị phải đi theo NỘI DUNG thật: lightbox dùng chính giá trị
        // này làm tên file khi bấm tải xuống, để nguyên "IMG_9698.heic" là người
        // dùng lưu được một file .heic chứa byte WebP (cùng lý do với alignExt).
        name: cdn.alignExt(att.name, 'webp'),
        mimeType: 'image/webp',
      });
    }

    if (!dirty) continue;
    stats.chatMessages += 1;
    if (APPLY) await ChatMessage.updateOne({ _id: msg._id }, { $set: { attachments: next } });
    if (stats.chatMessages % 50 === 0) console.log(`   … ${stats.chatMessages} tin nhắn`);
  }
}

async function backfillPosts() {
  const total = await Post.countDocuments(POST_QUERY);
  console.log(`\n📰 Bài đăng có ảnh HEIC: ${total}`);
  if (!total) return;

  const cursor = Post.find(POST_QUERY, { images: 1 }).lean().cursor();

  for await (const post of cursor) {
    const images = post.images || [];
    let dirty = false;

    const next = [];
    for (const img of images) {
      if (!HEIC_KEY_RE.test(img || '')) {
        next.push(img);
        continue;
      }
      stats.postImages += 1;

      const kq = await chuyenMotKhoa(img, null);
      if (!kq.doi) {
        next.push(img);
        continue;
      }
      dirty = true;
      next.push(kq.stored || img);
    }

    if (!dirty) continue;
    stats.posts += 1;
    if (APPLY) await Post.updateOne({ _id: post._id }, { $set: { images: next } });
    if (stats.posts % 50 === 0) console.log(`   … ${stats.posts} bài đăng`);
  }
}

function inKetQua() {
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  const da = APPLY ? 'đã' : 'sẽ';
  console.log('\n' + '='.repeat(60));
  console.log('📊 KẾT QUẢ:');
  console.log(`   - Ảnh HEIC tìm thấy (chat): ${stats.chatAttachments} — ${stats.chatMessages} tin nhắn ${da} sửa`);
  console.log(`   - Ảnh HEIC tìm thấy (bài):  ${stats.postImages} — ${stats.posts} bài ${da} sửa`);
  console.log(`   - Khoá ${da} chuyển:            ${daChuyen.size}`);
  if (stats.legacyBoQua) {
    console.log(`   - Ảnh legacy BỎ QUA:        ${stats.legacyBoQua}  ← ngoài phạm vi, VẪN không xem được trên web`);
  }
  if (stats.loi) {
    console.log(`   - Lỗi:                      ${stats.loi}`);
  }
  if (APPLY && stats.bytesTruoc) {
    const tiLe = (100 - (stats.bytesSau / stats.bytesTruoc) * 100).toFixed(0);
    console.log(`   - Dung lượng:               ${mb(stats.bytesTruoc)} → ${mb(stats.bytesSau)} (giảm ${tiLe}%)`);
  }
  console.log('='.repeat(60));

  if (viDu.length) {
    console.log('\n📝 Ví dụ:');
    viDu.forEach((v, i) => console.log(`   ${i + 1}. ${v.from}\n      → ${v.to}`));
  }

  if (loiTheoKhoa.size) {
    console.log('\n⚠️  Khoá lỗi (tối đa 20):');
    [...loiTheoKhoa.entries()].slice(0, 20).forEach(([k, v]) => console.log(`   ${k} — ${v}`));
  }

  if (!APPLY) {
    console.log('\nℹ️  Đây là DRY-RUN — chưa ghi MinIO, chưa ghi DB.');
    console.log('    Chạy lại với --apply để thực hiện. Nhớ mongodump trước.\n');
  } else {
    console.log('\n✅ Xong. Object .heic cũ VẪN CÒN trên MinIO (để rollback được).');
    console.log('    nginx có thể phục vụ URL cũ tới hết max-age: chat 1 giờ, posts 24 giờ.\n');
  }
}

async function main() {
  console.log(`\n🔍 Backfill HEIC → WebP — chế độ: ${APPLY ? 'APPLY (ghi thật)' : 'DRY-RUN (chỉ đếm)'}`);

  if (!config.enabled) {
    console.error('❌ CDN_ENABLED=false — script này chỉ xử lý ảnh có khoá cdn://. Dừng.');
    process.exit(1);
  }
  const { ok, errors } = validate();
  if (!ok) {
    console.error(`❌ Thiếu biến cấu hình CDN: ${errors.join(', ')}. Dừng.`);
    process.exit(1);
  }

  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    await backfillChat();
    await backfillPosts();
    inKetQua();
  } catch (error) {
    console.error('❌ Error:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

// Chỉ chạy khi được gọi trực tiếp — nhờ vậy bộ test require được file này để
// kiểm phần thuần (bóc khoá, nhận diện đuôi) mà không đụng Mongo/MinIO.
if (require.main === module) main();

module.exports = { boKhoa, laKhoaCdn, HEIC_KEY_RE, CHAT_QUERY, POST_QUERY };
