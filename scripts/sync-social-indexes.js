/**
 * One-shot đồng bộ index Mongo cho social-service (PM2 cron / tay).
 * NODE_PATH phải trỏ vào social-service cwd.
 */

require('dotenv').config({ path: `${__dirname}/../config.env` });
const mongoose = require('mongoose');
const ChatConversation = require('../models/ChatConversation');
const ChatMessage = require('../models/ChatMessage');
const Post = require('../models/Post');
const PostComment = require('../models/PostComment');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error('[sync-social-indexes] Thiếu MONGODB_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('[sync-social-indexes] Đã kết nối Mongo');

  for (const M of [ChatConversation, ChatMessage, Post, PostComment]) {
    const name = M.modelName || M.collection?.name || 'unknown';
    process.stdout.write(`[sync-social-indexes] syncIndexes(${name}) … `);
    const dropped = await M.syncIndexes();
    console.log('OK.', dropped?.length ? `Dropped: ${dropped.join(', ')}` : 'No drop.');
  }

  await mongoose.disconnect();
  console.log('[sync-social-indexes] Xong.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
