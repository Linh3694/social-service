const User = require('../models/User');
const frappeService = require('../services/frappeService');

const FRAPPE_API_URL = process.env.FRAPPE_API_URL || 'https://admin.sis.wellspring.edu.vn';

/**
 * 🔄 Redis event handler - xử lý user events từ Redis pub/sub
 * Nhận events từ Frappe khi user được tạo/cập nhật/xóa
 */
const handleUserRedisEvent = async (message) => {
  try {
    if (process.env.DEBUG_USER_EVENTS === '1') {
      console.log('[Social Service] User event received:', message?.type);
    }

    if (!message || typeof message !== 'object' || !message.type) return;

    const payload = message.user || message.data || null;

    switch (message.type) {
      case 'user_created':
      case 'user_updated':
        if (payload) {
          const updated = await User.updateFromFrappe(payload);
          console.log(`✅ [Social Service] User synced via Redis: ${updated.email}`);
        }
        break;
      case 'user_deleted':
        if (process.env.USER_EVENT_DELETE_ENABLED === 'true' && payload) {
          const identifier = payload?.email || message.user_id || message.name;
          if (identifier) {
            await User.deleteOne({ $or: [{ email: identifier }, { name: identifier }] });
            console.log(`🗑️ [Social Service] User deleted via Redis: ${identifier}`);
          }
        }
        break;
      default:
        break;
    }
  } catch (err) {
    console.error('[Social Service] Failed handling user Redis event:', err.message);
  }
};

/**
 * 📋 Format Frappe user → User model
 * Normalize fields từ Frappe response về format chuẩn cho MongoDB
 */
function formatFrappeUser(frappeUser) {
  // Normalize roles: hỗ trợ cả string array và object array
  const roles = Array.isArray(frappeUser.roles)
    ? frappeUser.roles.map((r) => (typeof r === 'string' ? r : r?.role)).filter(Boolean)
    : Array.isArray(frappeUser.roles_list)
    ? frappeUser.roles_list
    : [];

  // Xác định enabled status
  const isEnabled = frappeUser.docstatus === 0 || 
    (frappeUser.docstatus === undefined && frappeUser.enabled !== false && frappeUser.disabled !== true);

  // Normalize fullname
  const fullName = frappeUser.full_name || frappeUser.fullname || frappeUser.fullName ||
    [frappeUser.first_name, frappeUser.middle_name, frappeUser.last_name].filter(Boolean).join(' ') ||
    frappeUser.name;

  // Lấy email
  const userEmail = frappeUser.email || frappeUser.name || '';

  return {
    email: userEmail,
    fullname: fullName,
    fullName: fullName,
    username: frappeUser.username || frappeUser.name,
    avatarUrl: frappeUser.user_image || frappeUser.userImage || frappeUser.avatar || frappeUser.avatar_url || '',
    department: frappeUser.department || frappeUser.location || '',
    jobTitle: frappeUser.job_title || frappeUser.designation || 'User',
    provider: 'frappe',
    disabled: !isEnabled,
    active: isEnabled,
    roles: roles,
    role: roles.length > 0 ? roles[0].toLowerCase() : 'user',
    microsoftId: frappeUser.microsoft_id || frappeUser.microsoftId,
    employeeCode: frappeUser.employee_code || frappeUser.employeeCode || undefined,
    phone: frappeUser.phone,
    mobileNo: frappeUser.mobile_no,
  };
}

/**
 * 🔄 ENDPOINT: Manual sync tất cả enabled users từ Frappe
 * POST /api/social/user/sync/manual
 */
const syncUsersManual = async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    console.log('🔄 [Social Sync] Starting user sync...');
    const startTime = Date.now();

    // Fetch enabled users từ Frappe
    const frappeUsers = await frappeService.getAllEnabledUsers(token);
    console.log(`📊 [Social Sync] Found ${frappeUsers.length} enabled users from Frappe`);

    if (frappeUsers.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No enabled users to sync',
        stats: { synced: 0, failed: 0, total: 0 }
      });
    }

    // Filter valid users (phải có email)
    const validUsers = frappeUsers.filter(user => {
      const email = user.email || user.name || '';
      return email && email.includes('@');
    });
    
    const skipped = frappeUsers.length - validUsers.length;
    if (skipped > 0) {
      console.log(`⚠️  [Social Sync] Skipped ${skipped} users without valid email`);
    }

    // Batch process users (20 cùng lúc)
    const batchSize = 20;
    let synced = 0;
    let failed = 0;
    const userTypeStats = { 'System User': 0, 'Website User': 0, 'Other': 0 };

    for (let i = 0; i < validUsers.length; i += batchSize) {
      const batch = validUsers.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (frappeUser) => {
          const userEmail = frappeUser.email || frappeUser.name;
          const userData = formatFrappeUser(frappeUser);
          
          await User.findOneAndUpdate(
            { email: userEmail.toLowerCase() },
            { $set: userData },
            { upsert: true, new: true }
          );
          
          return { 
            email: userEmail, 
            userType: frappeUser.user_type || 'Other'
          };
        })
      );

      // Đếm kết quả
      batchResults.forEach(result => {
        if (result.status === 'fulfilled') {
          synced++;
          const userType = result.value.userType;
          if (userTypeStats.hasOwnProperty(userType)) {
            userTypeStats[userType]++;
          } else {
            userTypeStats['Other']++;
          }
        } else {
          failed++;
        }
      });

      // Log progress mỗi 100 users
      if ((i + batchSize) % 100 === 0 || i + batchSize >= validUsers.length) {
        const progress = Math.round(((synced + failed) / validUsers.length) * 100);
        console.log(`📊 [Social Sync] Progress: ${synced + failed}/${validUsers.length} (${progress}%)`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Social Sync] Complete: ${synced} synced, ${failed} failed in ${duration}s`);

    res.status(200).json({
      success: true,
      message: `Synced ${synced} users successfully`,
      stats: { 
        synced, 
        failed, 
        skipped,
        total: frappeUsers.length,
        user_type_breakdown: userTypeStats
      },
      duration_seconds: parseFloat(duration)
    });
  } catch (error) {
    console.error('❌ [Social Sync] Error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

/**
 * 📧 ENDPOINT: Sync user theo email cụ thể
 * POST /api/social/user/sync/email/:email
 */
const syncUserByEmail = async (req, res) => {
  try {
    const { email } = req.params;
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }
    
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email parameter required' });
    }
    
    console.log(`📧 [Social Sync] Syncing user: ${email}`);
    
    const frappeUser = await frappeService.getUserDetail(email, token);
    
    if (!frappeUser) {
      return res.status(404).json({
        success: false,
        message: `User not found in Frappe: ${email}`
      });
    }
    
    // Chỉ sync enabled users
    const isEnabled = frappeUser.docstatus === 0 || 
      (frappeUser.docstatus === undefined && !frappeUser.disabled);
    if (!isEnabled) {
      return res.status(400).json({
        success: false,
        message: `User is not active in Frappe: ${email}`
      });
    }
    
    const userData = formatFrappeUser(frappeUser);
    
    const result = await User.findOneAndUpdate(
      { email: frappeUser.email?.toLowerCase() || email.toLowerCase() },
      userData,
      { upsert: true, new: true }
    );
    
    console.log(`✅ [Social Sync] User synced: ${email}`);
    
    res.status(200).json({
      success: true,
      message: 'User synced successfully',
      user: {
        _id: result._id,
        email: result.email,
        fullname: result.fullname,
        roles: result.roles,
        department: result.department,
        avatarUrl: result.avatarUrl
      }
    });
  } catch (error) {
    console.error('❌ [Social Sync] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🔔 ENDPOINT: Webhook - User changed in Frappe
 * POST /api/social/user/webhook/frappe-user-changed
 * Được gọi từ Frappe webhook khi user được tạo/cập nhật/xóa
 */
const webhookUserChanged = async (req, res) => {
  try {
    const { doc, event } = req.body;

    if (process.env.DEBUG_WEBHOOK === '1') {
      console.log('🔔 [Webhook] Raw payload:', JSON.stringify(req.body, null, 2));
    }

    // Handle template strings trong event
    let actualEvent = event;
    if (typeof event === 'string' && event.includes('{{')) {
      actualEvent = 'update';
    }

    console.log(`🔔 [Social Webhook] User ${actualEvent}: ${doc?.name}`);

    if (!doc || !doc.name) {
      return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
    }
    
    // Xử lý delete event
    if (actualEvent === 'delete' || actualEvent === 'on_trash') {
      console.log(`🗑️ [Social Webhook] Deleting user: ${doc.name}`);
      await User.deleteOne({ email: doc.email });
      return res.status(200).json({ success: true, message: 'User deleted' });
    }
    
    // Xử lý insert/update event
    if (actualEvent === 'insert' || actualEvent === 'update' || actualEvent === 'after_insert' || actualEvent === 'on_update') {
      // Kiểm tra disabled
      if (doc.disabled === true || doc.disabled === 1 || doc.disabled === "1") {
        console.log(`⏭️ [Social Webhook] Skipping disabled user: ${doc.name}`);
        return res.status(200).json({ success: true, message: 'User is disabled, skipped' });
      }
      
      // Kiểm tra enabled
      let isEnabled = true;
      if (doc.enabled !== undefined && doc.enabled !== null) {
        isEnabled = doc.enabled === 1 || doc.enabled === true || doc.enabled === "1";
      } else if (doc.docstatus !== undefined && doc.docstatus !== null) {
        isEnabled = doc.docstatus === 0;
      }
      
      if (!isEnabled) {
        console.log(`⏭️ [Social Webhook] Skipping inactive user: ${doc.name}`);
        return res.status(200).json({ success: true, message: 'User is not active, skipped' });
      }
      
      // Normalize roles
      const frappe_roles = Array.isArray(doc.roles)
        ? doc.roles.map(r => typeof r === 'string' ? r : r?.role).filter(Boolean)
        : [];
      
      // Get existing user để preserve fields
      const existingUser = await User.findOne({ email: doc.email });
      
      // Build update object
      const userData = {
        email: doc.email,
        fullname: doc.full_name || doc.name,
        fullName: doc.full_name || doc.name,
        provider: 'frappe',
        disabled: false,
        active: true,
        roles: frappe_roles,
        role: frappe_roles.length > 0 ? frappe_roles[0].toLowerCase() : 'user',
        updatedAt: new Date()
      };
      
      // Conditional updates
      if (doc.user_image) {
        userData.avatarUrl = doc.user_image;
      } else if (!existingUser) {
        userData.avatarUrl = '';
      }
      
      if (doc.department || doc.location) {
        userData.department = doc.department || doc.location;
      } else if (!existingUser) {
        userData.department = '';
      }
      
      if (doc.job_title || doc.designation) {
        userData.jobTitle = doc.job_title || doc.designation;
      } else if (!existingUser) {
        userData.jobTitle = 'User';
      }
      
      if (doc.employee_code) {
        userData.employeeCode = doc.employee_code;
      }
      
      if (doc.microsoft_id) {
        userData.microsoftId = doc.microsoft_id;
      }
      
      const result = await User.findOneAndUpdate(
        { email: doc.email?.toLowerCase() },
        userData,
        { upsert: true, new: true }
      );
      
      console.log(`✅ [Social Webhook] User synced: ${doc.name} (roles: ${frappe_roles.join(', ')})`);
      
      return res.status(200).json({
        success: true,
        message: `User ${actualEvent} synced`,
        user: {
          email: result.email,
          fullname: result.fullname,
          roles: result.roles
        }
      });
    }
    
    res.status(200).json({ success: true, message: 'Unknown event, ignored' });
  } catch (error) {
    console.error('❌ [Social Webhook] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 👤 ENDPOINT: Lấy user theo email
 * GET /api/social/user/email/:email
 */
const getUserByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({ success: false, message: 'Email parameter is required' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    if (user) {
      console.log(`[getUserByEmail] ✅ Found user: ${user._id}`);
      return res.status(200).json({
        success: true,
        user: user,
        message: 'User found'
      });
    } else {
      console.log(`[getUserByEmail] ❌ User not found: ${email}`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (error) {
    console.error('[getUserByEmail] ❌ Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 👤 ENDPOINT: Lấy thông tin user hiện tại
 * GET /api/social/user/me
 */
const getCurrentUser = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const user = await User.findById(req.user._id).select('-following -followers');

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        email: user.email,
        fullname: user.fullname,
        avatarUrl: user.avatarUrl,
        department: user.department,
        jobTitle: user.jobTitle,
        role: user.role,
        roles: user.roles,
      }
    });
  } catch (error) {
    console.error('[getCurrentUser] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🔍 ENDPOINT: Debug - test fetch users từ Frappe
 * GET /api/social/user/debug/fetch-users
 */
const debugFetchUsers = async (req, res) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, message: 'Token required' });
    }

    console.log('🔍 [Debug] Testing Frappe user fetch...');

    const users = await frappeService.getUsersPage(token, 0, 10);
    
    const sampleUsers = users.slice(0, 5).map(user => ({
      email: user.email,
      name: user.name,
      enabled: user.enabled,
      disabled: user.disabled,
      docstatus: user.docstatus,
      user_type: user.user_type,
      full_name: user.full_name,
    }));

    res.status(200).json({
      success: true,
      message: 'Debug fetch completed',
      count: users.length,
      sample_users: sampleUsers
    });
  } catch (error) {
    console.error('❌ [Debug] Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 📊 ENDPOINT: Lấy stats về users
 * GET /api/social/user/stats
 */
const getUserStats = async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ active: true, disabled: false });
    const departmentStats = await User.aggregate([
      { $match: { active: true } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.status(200).json({
      success: true,
      stats: {
        total: totalUsers,
        active: activeUsers,
        inactive: totalUsers - activeUsers,
        byDepartment: departmentStats
      }
    });
  } catch (error) {
    console.error('[getUserStats] Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  // Sync endpoints
  syncUsersManual,
  syncUserByEmail,
  
  // Webhook
  webhookUserChanged,
  
  // User queries
  getUserByEmail,
  getCurrentUser,
  getUserStats,
  
  // Debug
  debugFetchUsers,
  
  // Redis event handler
  handleUserRedisEvent,
};
