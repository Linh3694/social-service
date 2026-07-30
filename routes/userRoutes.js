const express = require('express');
const userController = require('../controllers/userController');
const { authenticate, optionalAuth, authenticateOrServiceKey } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * 🔄 User Sync Routes - Social Service
 * Đồng bộ user từ Frappe ERP về MongoDB
 */

// 📝 ENDPOINT 1: Manual sync tất cả enabled users (JWT user HOẶC service key của cron)
// POST /api/social/user/sync/manual
router.post('/sync/manual', authenticateOrServiceKey, userController.syncUsersManual);

// 📧 ENDPOINT 2: Sync user theo email (AUTHENTICATED)
// POST /api/social/user/sync/email/:email
router.post('/sync/email/:email', authenticate, userController.syncUserByEmail);

// 🔔 ENDPOINT 3: Webhook - User changed in Frappe (NO AUTH - internal)
// POST /api/social/user/webhook/frappe-user-changed
router.post('/webhook/frappe-user-changed', userController.webhookUserChanged);

// 👤 ENDPOINT 4: Get user by email (NO AUTH - internal service call)
// GET /api/social/user/email/:email
router.get('/email/:email', userController.getUserByEmail);

// 👤 ENDPOINT 5: Get current user (AUTHENTICATED)
// GET /api/social/user/me
router.get('/me', authenticate, userController.getCurrentUser);

// 🔍 ENDPOINT 6: Search users cho mention (AUTHENTICATED)
// GET /api/social/user/search?q=query&limit=10
router.get('/search', authenticate, userController.searchUsers);

// 📊 ENDPOINT 7: Get user stats (OPTIONAL AUTH)
// GET /api/social/user/stats
router.get('/stats', optionalAuth, userController.getUserStats);

// 🔍 ENDPOINT DEBUG: Test fetch users từ Frappe (AUTHENTICATED)
// GET /api/social/user/debug/fetch-users
router.get('/debug/fetch-users', authenticate, userController.debugFetchUsers);

// 🔍 ENDPOINT DEBUG: Check roles của user hiện tại (AUTHENTICATED)
// GET /api/social/user/check-roles
router.get('/check-roles', authenticate, userController.checkMyRoles);

module.exports = router;
