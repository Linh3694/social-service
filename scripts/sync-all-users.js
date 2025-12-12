#!/usr/bin/env node

/**
 * 🔄 Sync Users from Frappe - Social Service
 * 
 * Syncs all enabled users from Frappe to social-service Users collection.
 * Giống ticket-service pattern để đảm bảo nhất quán.
 * 
 * Usage: 
 *   node sync-all-users.js <TOKEN> [BASE_URL]
 * 
 * Example:
 *   node sync-all-users.js eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *   node sync-all-users.js <TOKEN> https://admin.sis.wellspring.edu.vn
 */

const axios = require('axios');

const args = process.argv.slice(2);
const token = args[0];
const baseURL = args[1] || 'https://admin.sis.wellspring.edu.vn';

if (!token) {
  console.error('❌ Error: Token required');
  console.error('Usage: node sync-all-users.js <TOKEN> [BASE_URL]');
  console.error('');
  console.error('Example:');
  console.error('  node sync-all-users.js eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...');
  process.exit(1);
}

const syncAllUsers = async () => {
  try {
    const url = `${baseURL}/api/social/user/sync/manual`;
    
    console.log('🔄 [Social Service] Starting user sync...');
    console.log(`📍 Target: ${baseURL}`);
    console.log('');
    
    const startTime = Date.now();
    const response = await axios.post(url, {}, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000 // 2 minutes timeout
    });
    
    const data = response.data;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    if (data.success) {
      console.log('✅ Sync completed successfully!');
      console.log('');
      console.log('📊 Statistics:');
      console.log(`   ✅ Synced:   ${data.stats.synced}`);
      console.log(`   ❌ Failed:   ${data.stats.failed}`);
      console.log(`   ⏭️  Skipped:  ${data.stats.skipped || 0}`);
      console.log(`   📋 Total:    ${data.stats.total}`);
      console.log(`   ⏱️  Duration: ${duration}s`);
      
      if (data.stats.user_type_breakdown) {
        console.log('');
        console.log('📊 User Types:');
        console.log(`   - System Users:  ${data.stats.user_type_breakdown['System User'] || 0}`);
        console.log(`   - Website Users: ${data.stats.user_type_breakdown['Website User'] || 0}`);
        console.log(`   - Other:         ${data.stats.user_type_breakdown['Other'] || 0}`);
      }
      
      console.log('');
      console.log('💡 Users are now synced and ready for Social/Newsfeed features.');
    } else {
      console.error(`❌ Sync failed: ${data.message}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Sync failed!');
    console.error('');
    if (error.response) {
      console.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
      if (error.response.data?.message) {
        console.error(`Error: ${error.response.data.message}`);
      }
    } else {
      console.error(`Error: ${error.message}`);
    }
    process.exit(1);
  }
};

syncAllUsers();
