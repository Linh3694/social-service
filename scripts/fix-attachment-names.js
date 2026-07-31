/**
 * 🔧 Script chữa tên file đính kèm chat bị lỗi mã hoá (SIS-169)
 *
 * Chạy thử (KHÔNG ghi DB):  node scripts/fix-attachment-names.js
 * Ghi DB thật:              node scripts/fix-attachment-names.js --apply
 *
 * Chữa hai kiểu hỏng của `attachments[].name` trong tin nhắn cũ, bằng đúng helper
 * mà API đang dùng (`normalizeUploadFilename`) nên DB và dữ liệu mới luôn cùng dạng:
 *
 *   1. Mojibake latin1 do multer (SIS-169): "ChÃ­nh sÃ¡ch.docx".
 *   2. Tên bị percent-encode: "HU%CC%9BO%CC%9B%CC%81NG%20DA%CC%82%CC%83N…" —
 *      tên đi qua một URL (file:// trên iOS, `filename*` của Content-Disposition,
 *      khoá CDN…) rồi được gửi lại nguyên xi. Sửa luôn cả dạng NFC.
 *
 * An toàn: chỉ đổi khi chắc chắn (byte đúng UTF-8 hợp lệ / có escape percent của byte
 * ngoài ASCII), nên tên ASCII, tên latin1 thật và tên chứa `%` hợp lệ được giữ nguyên.
 * Chạy lại nhiều lần không đổi thêm (idempotent).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config.env') });
const mongoose = require('mongoose');
const ChatMessage = require('../models/ChatMessage');
const { normalizeUploadFilename } = require('../utils/uploadFilename');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wis_social';
const APPLY = process.argv.includes('--apply');

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

async function fixAttachmentNames() {
  console.log(`\n🔍 Quét tên file đính kèm — chế độ: ${APPLY ? 'APPLY (ghi DB)' : 'DRY-RUN (chỉ in)'}\n`);

  const total = await ChatMessage.countDocuments({ 'attachments.0': { $exists: true } });
  console.log(`📊 Tin nhắn có đính kèm: ${total}\n`);

  // Cursor thay vì find().lean() để không nạp hết vào RAM.
  const cursor = ChatMessage
    .find({ 'attachments.0': { $exists: true } }, { attachments: 1 })
    .lean()
    .cursor();

  let scanned = 0;
  let changedMessages = 0;
  let changedNames = 0;
  const samples = [];

  for await (const msg of cursor) {
    scanned++;
    const attachments = msg.attachments || [];
    let dirty = false;

    const next = attachments.map((att) => {
      const fixed = normalizeUploadFilename(att.name);
      if (fixed === att.name) return att;
      dirty = true;
      changedNames++;
      if (samples.length < 20) samples.push({ id: String(msg._id), from: att.name, to: fixed });
      return { ...att, name: fixed };
    });

    if (!dirty) continue;
    changedMessages++;

    if (APPLY) {
      await ChatMessage.updateOne({ _id: msg._id }, { $set: { attachments: next } });
    }
  }

  console.log('='.repeat(60));
  console.log('📊 KẾT QUẢ:');
  console.log(`   - Tin nhắn đã quét:        ${scanned}`);
  console.log(`   - Tin nhắn ${APPLY ? 'đã sửa' : 'sẽ sửa'}:  ${changedMessages}`);
  console.log(`   - Tên file ${APPLY ? 'đã sửa' : 'sẽ sửa'}:  ${changedNames}`);
  console.log('='.repeat(60) + '\n');

  if (samples.length) {
    console.log(`📝 Ví dụ (tối đa 20):`);
    samples.forEach((s, i) => {
      console.log(`   ${i + 1}. [${s.id}] "${s.from}" → "${s.to}"`);
    });
    console.log('');
  }

  if (!APPLY && changedMessages > 0) {
    console.log('ℹ️  Đây là DRY-RUN. Chạy lại với --apply để ghi vào DB.\n');
  }
}

async function main() {
  try {
    await connectDB();
    await fixAttachmentNames();
  } catch (err) {
    console.error('❌ Error:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
  }
}

main();
