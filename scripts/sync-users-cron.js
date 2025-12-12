#!/usr/bin/env node

/**
 * 🔄 Daily Cron Job: Sync Enabled Users from Frappe - Social Service
 *
 * This script runs automatically via cron to sync only ENABLED users from Frappe
 * as a backup in case webhooks fail. Optimized for performance with batch processing.
 *
 * Usage: node sync-users-cron.js
 *
 * Requires environment variables:
 * - FRAPPE_API_KEY and FRAPPE_API_SECRET (preferred)
 * - OR FRAPPE_API_TOKEN (fallback)
 * - FRAPPE_API_URL (optional, defaults to https://admin.sis.wellspring.edu.vn)
 * - SOCIAL_SERVICE_URL (optional, defaults to FRAPPE_API_URL)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../config.env') });

const axios = require('axios');

const FRAPPE_API_URL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';
const SOCIAL_SERVICE_URL = process.env.SOCIAL_SERVICE_URL || FRAPPE_API_URL;

// Build auth headers
function buildAuthHeaders() {
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (process.env.FRAPPE_API_KEY && process.env.FRAPPE_API_SECRET) {
    headers['Authorization'] = `token ${process.env.FRAPPE_API_KEY}:${process.env.FRAPPE_API_SECRET}`;
  } else if (process.env.FRAPPE_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.FRAPPE_API_TOKEN}`;
    headers['X-Frappe-CSRF-Token'] = process.env.FRAPPE_API_TOKEN;
  } else {
    throw new Error('Missing authentication: FRAPPE_API_KEY/FRAPPE_API_SECRET or FRAPPE_API_TOKEN required');
  }
  
  return headers;
}

const syncAllUsers = async () => {
  const startTime = new Date();
  console.log(`\n🔄 [Social Cron] Starting daily ENABLED user sync at ${startTime.toISOString()}`);

  try {
    const headers = buildAuthHeaders();
    const url = `${SOCIAL_SERVICE_URL}/api/social/user/sync/manual`;

    console.log(`📡 Calling: ${url} (enabled users only)`);
    
    const response = await axios.post(url, {}, {
      headers,
      timeout: 120000 // 2 minutes timeout
    });
    
    const data = response.data;
    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    if (data.success) {
      console.log(`✅ [Social Cron] Sync completed successfully in ${duration}s`);
      
      if (data.stats) {
        const { synced, failed } = data.stats;
        console.log(`📊 Stats:`);
        console.log(`   ✅ Synced: ${synced}`);
        console.log(`   ❌ Failed: ${failed}`);
        
        if (failed > 0) {
          console.warn(`⚠️  Warning: ${failed} users failed to sync`);
        }
      }
      
      console.log(`✅ [Social Cron] Daily enabled user sync completed at ${endTime.toISOString()}\n`);
      process.exit(0);
    } else {
      console.error(`❌ [Social Cron] Enabled user sync failed: ${data.message}`);
      process.exit(1);
    }
  } catch (error) {
    const endTime = new Date();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.error(`❌ [Social Cron] Error after ${duration}s:`);
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else {
      console.error(error.message);
    }

    console.error(`❌ [Social Cron] Daily enabled user sync failed at ${endTime.toISOString()}\n`);
    process.exit(1);
  }
};

// Run sync
syncAllUsers();
