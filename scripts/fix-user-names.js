/**
 * 🔧 Script fix tên user bị format sai trong MongoDB
 *
 * Xem trước (KHÔNG ghi DB):  node scripts/fix-user-names.js
 * Ghi thật vào DB:            node scripts/fix-user-names.js --apply
 *
 * Script này sẽ:
 * 1. Lấy tất cả users từ DB
 * 2. Kiểm tra và format lại tên theo chuẩn Việt Nam
 * 3. Liệt kê những users cần sửa — chỉ ghi DB khi chạy kèm --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { formatVietnameseName, detectNameFormat } = require('../utils/nameUtils');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/wis_social';

/** Mặc định dry-run — tránh ghi đè tên hàng loạt chỉ vì gõ nhầm lệnh. */
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

async function fixUserNames() {
  console.log(
    APPLY
      ? '\n✍️  CHẾ ĐỘ GHI (--apply): sẽ cập nhật tên vào DB.\n'
      : '\n👀 CHẾ ĐỘ XEM TRƯỚC (dry-run): KHÔNG ghi DB. Thêm --apply để ghi thật.\n'
  );
  console.log('🔍 Scanning users for name format issues...\n');

  // Debug: Đếm tổng số users trong collection
  const totalCount = await User.countDocuments({});
  console.log(`📊 Total users in collection: ${totalCount}`);
  
  // Debug: Xem cấu trúc của 1 user
  const sampleUser = await User.findOne({}).lean();
  if (sampleUser) {
    console.log('\n📝 Sample user structure:');
    console.log(`   Keys: ${Object.keys(sampleUser).join(', ')}`);
    console.log(`   email: ${sampleUser.email}`);
    console.log(`   fullname: ${sampleUser.fullname}`);
    console.log(`   fullName: ${sampleUser.fullName}`);
    console.log(`   name: ${sampleUser.name}`);
    console.log('');
  }
  
  // Tìm users có fullname HOẶC fullName (cả 2 variants)
  const users = await User.find({
    $or: [
      { fullname: { $exists: true, $ne: null, $ne: '' } },
      { fullName: { $exists: true, $ne: null, $ne: '' } }
    ]
  }).lean();
  
  console.log(`📊 Users with fullname/fullName: ${users.length}\n`);
  
  // Debug: show first few users
  if (users.length > 0) {
    console.log('📝 Sample users with names:');
    users.slice(0, 5).forEach((u, i) => {
      console.log(`   ${i + 1}. ${u.email}: fullname="${u.fullname}", fullName="${u.fullName}"`);
    });
    console.log('');
  }
  
  let fixedCount = 0;
  let skippedCount = 0;
  const fixes = [];
  
  for (const user of users) {
    // Lấy tên từ fullname hoặc fullName
    const originalName = user.fullname || user.fullName;
    if (!originalName) continue;
    
    const parts = originalName.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      skippedCount++;
      continue;
    }
    
    const { format, surnameIndex } = detectNameFormat(parts);
    const formattedName = formatVietnameseName(originalName);
    
    if (formattedName !== originalName) {
      fixes.push({
        email: user.email,
        original: originalName,
        fixed: formattedName,
        format: format
      });
      
      if (APPLY) {
        // Update in DB - cập nhật CẢ HAI fields
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              fullname: formattedName,
              fullName: formattedName
            }
          }
        );
      }

      fixedCount++;
      console.log(
        `${APPLY ? '✅ Fixed' : '📋 Sẽ sửa'}: "${originalName}" → "${formattedName}" (${format})`
      );
    } else {
      skippedCount++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY:');
  console.log(`   - Total users scanned: ${users.length}`);
  console.log(`   - ${APPLY ? 'Users fixed' : 'Users cần sửa (chưa ghi)'}: ${fixedCount}`);
  console.log(`   - Users skipped (already correct): ${skippedCount}`);
  console.log('='.repeat(60) + '\n');

  if (fixes.length > 0) {
    console.log(APPLY ? '📝 Fixed users list:' : '📝 Danh sách sẽ sửa (dry-run):');
    fixes.forEach((fix, i) => {
      console.log(`   ${i + 1}. ${fix.email}: "${fix.original}" → "${fix.fixed}"`);
    });
    if (!APPLY) {
      console.log('\n⚠️  Chưa ghi gì vào DB. Chạy lại kèm --apply để cập nhật.');
    }
  }
  
  return fixes;
}

async function main() {
  try {
    await connectDB();
    await fixUserNames();
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
    process.exit(0);
  }
}

main();

