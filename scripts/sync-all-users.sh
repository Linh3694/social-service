#!/bin/bash

# 🔄 Sync All Users - Social Service
# Script wrapper để chạy sync-all-users.js
# 
# Usage:
#   ./sync-all-users.sh <TOKEN> [BASE_URL]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$1" ]; then
  echo "❌ Error: Token required"
  echo "Usage: ./sync-all-users.sh <TOKEN> [BASE_URL]"
  exit 1
fi

cd "$SCRIPT_DIR/.."
node scripts/sync-all-users.js "$@"

