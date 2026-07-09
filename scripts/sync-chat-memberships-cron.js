#!/usr/bin/env node

/**
 * 🔄 Daily Cron Job: Sync/revoke membership nhóm chat lớp theo roster Frappe.
 *
 * Gọi endpoint admin của social-service (POST /api/social/chat/sync/memberships):
 * mỗi nhóm class_general được ADD/merge theo roster mới nhất và soft-remove
 * participant không còn trong roster (có guards an toàn — xem services/chatMembershipSync.js).
 *
 * Usage: node sync-chat-memberships-cron.js
 *
 * Env:
 * - FRAPPE_API_KEY + FRAPPE_API_SECRET (bắt buộc — endpoint so khớp đúng cặp key này)
 * - SOCIAL_SERVICE_URL (mặc định FRAPPE_API_URL)
 * - CHAT_SYNC_DRY_RUN=1 → chỉ log diff, không ghi DB (dùng trong giai đoạn rollout)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config.env') });

const axios = require('axios');

const FRAPPE_API_URL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
const SOCIAL_SERVICE_URL = process.env.SOCIAL_SERVICE_URL || FRAPPE_API_URL;
const DRY_RUN = ['1', 'true'].includes(String(process.env.CHAT_SYNC_DRY_RUN || '').toLowerCase());

function buildAuthHeaders() {
  if (!process.env.FRAPPE_API_KEY || !process.env.FRAPPE_API_SECRET) {
    throw new Error('Missing authentication: FRAPPE_API_KEY/FRAPPE_API_SECRET required');
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `token ${process.env.FRAPPE_API_KEY}:${process.env.FRAPPE_API_SECRET}`,
  };
}

const syncChatMemberships = async () => {
  const startTime = new Date();
  console.log(`\n🔄 [Chat Cron] Starting chat membership sync at ${startTime.toISOString()} (dryRun=${DRY_RUN})`);

  try {
    const headers = buildAuthHeaders();
    const url = `${SOCIAL_SERVICE_URL}/api/social/chat/sync/memberships`;

    console.log(`📡 Calling: ${url}`);

    const response = await axios.post(url, { dryRun: DRY_RUN }, {
      headers,
      timeout: 600000, // 10 phút — quét toàn bộ lớp
    });

    const data = response.data;
    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    if (data.success) {
      const s = data.data || {};
      console.log(`✅ [Chat Cron] Sync completed in ${duration}s`);
      console.log(`📊 Stats:`);
      console.log(`   🏫 Classes: ${s.processed}/${s.total}`);
      console.log(`   ➕ Added: ${s.added}`);
      console.log(`   🆕 Created groups: ${s.created ?? 0}`);
      console.log(`   ➖ Removed: ${s.removed}`);
      console.log(`   ♻️  Reactivated: ${s.reactivated}`);
      console.log(`   🛡  Guards: ${JSON.stringify(s.guards || {})}`);
      console.log(`   ⚠️  Scope errors: ${s.scopeErrors}`);
      console.log(`✅ [Chat Cron] Done at ${endTime.toISOString()}\n`);
      process.exit(0);
    } else {
      console.error(`❌ [Chat Cron] Sync failed: ${data.message}`);
      process.exit(1);
    }
  } catch (error) {
    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.error(`❌ [Chat Cron] Error after ${duration}s:`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(error.message);
    }

    console.error(`❌ [Chat Cron] Chat membership sync failed at ${endTime.toISOString()}\n`);
    process.exit(1);
  }
};

syncChatMemberships();
