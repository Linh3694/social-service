/**
 * 🔧 Script fix tên user bị format sai trong MongoDB
 * 
 * Chạy: node scripts/fix-user-names.js
 * 
 * Script này sẽ:
 * 1. Lấy tất cả users từ DB
 * 2. Kiểm tra và format lại tên theo chuẩn Việt Nam
 * 3. Cập nhật những users cần sửa
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const { formatVietnameseName, detectNameFormat } = require('../utils/nameUtils');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/social-service';

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
  console.log('\n🔍 Scanning users for name format issues...\n');
  
  const users = await User.find({
    fullname: { $exists: true, $ne: null, $ne: '' }
  }).lean();
  
  console.log(`📊 Total users with fullname: ${users.length}\n`);
  
  let fixedCount = 0;
  let skippedCount = 0;
  const fixes = [];
  
  for (const user of users) {
    const originalName = user.fullname;
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
      
      // Update in DB
      await User.updateOne(
        { _id: user._id },
        { 
          $set: { 
            fullname: formattedName,
            fullName: formattedName 
          } 
        }
      );
      
      fixedCount++;
      console.log(`✅ Fixed: "${originalName}" → "${formattedName}" (${format})`);
    } else {
      skippedCount++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY:');
  console.log(`   - Total users scanned: ${users.length}`);
  console.log(`   - Users fixed: ${fixedCount}`);
  console.log(`   - Users skipped (already correct): ${skippedCount}`);
  console.log('='.repeat(60) + '\n');
  
  if (fixes.length > 0) {
    console.log('📝 Fixed users list:');
    fixes.forEach((fix, i) => {
      console.log(`   ${i + 1}. ${fix.email}: "${fix.original}" → "${fix.fixed}"`);
    });
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

