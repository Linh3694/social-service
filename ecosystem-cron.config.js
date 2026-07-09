/**
 * 🔄 PM2 Cron Config - Social Service
 * Chạy sync users định kỳ từ Frappe
 * 
 * Usage:
 *   pm2 start ecosystem-cron.config.js
 */

module.exports = {
  apps: [
    {
      name: 'social-sync-users-cron',
      script: './scripts/sync-users-cron.js',
      cron_restart: '0 6 * * *', // Chạy lúc 6:00 AM mỗi ngày
      autorestart: false,
      watch: false,
      instances: 1,
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/sync-users-cron-err.log',
      out_file: './logs/sync-users-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
    {
      // Sync/revoke membership nhóm chat theo roster — chạy SAU user-sync 6:00
      // để Mongo User tươi (attachMongoUsers resolve được user._id cho GV/PH mới).
      name: 'social-sync-chat-memberships-cron',
      script: './scripts/sync-chat-memberships-cron.js',
      cron_restart: '30 6 * * *', // 6:30 AM mỗi ngày
      autorestart: false,
      watch: false,
      instances: 1,
      env: {
        NODE_ENV: 'production'
        // CHAT_SYNC_DRY_RUN: '1', // bật trong giai đoạn rollout — chỉ log diff
      },
      error_file: './logs/sync-chat-memberships-cron-err.log',
      out_file: './logs/sync-chat-memberships-cron-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    }
  ]
};
