const express = require('express');
const chatController = require('../controllers/chatController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/conversations', authenticate, chatController.listConversations);
router.get('/conversations/:conversationId/messages', authenticate, chatController.getMessages);
router.post('/conversations/:conversationId/messages', authenticate, chatController.sendMessage);
router.post('/conversations/:conversationId/read', authenticate, chatController.markRead);

module.exports = router;
