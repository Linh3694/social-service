#!/bin/bash

# 🔄 Cron Job: Sync Users - Social Service
# Script để chạy trong cron job
# 
# Crontab example (chạy lúc 6:00 AM mỗi ngày):
#   0 6 * * * /path/to/social-service/scripts/sync-users-cron.sh >> /var/log/social-user-sync.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/social-user-sync.log"

echo "======================================"
echo "🔄 [Social Service] User Sync Cron Job"
echo "Started at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "======================================"

cd "$SCRIPT_DIR/.."

# Chạy sync script
node scripts/sync-users-cron.js

EXIT_CODE=$?

echo "======================================"
echo "Completed at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "Exit code: $EXIT_CODE"
echo "======================================"

exit $EXIT_CODE

