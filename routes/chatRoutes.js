const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const chatController = require('../controllers/chatController');
const { authenticate } = require('../middleware/authMiddleware');

const chatUploadDir = path.join(__dirname, '../uploads/chat');
if (!fs.existsSync(chatUploadDir)) fs.mkdirSync(chatUploadDir, { recursive: true });

const chatStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, 'uploads/chat/');
  },
  filename(_req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `chat-${unique}${path.extname(file.originalname || '')}`);
  },
});

function chatFileFilter(_req, file, cb) {
  const mime = (file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('video/')) {
    cb(null, true);
    return;
  }
  if (mime === 'application/pdf' || mime.startsWith('text/')) {
    cb(null, true);
    return;
  }
  if (
    mime.includes('word')
    || mime.includes('document')
    || mime.includes('sheet')
    || mime.includes('presentation')
    || mime === 'application/zip'
    || mime === 'application/x-zip-compressed'
  ) {
    cb(null, true);
    return;
  }
  cb(new Error('Loại tệp không được phép trong chat'));
}

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: chatFileFilter,
});

const router = express.Router();

router.get('/conversations', authenticate, chatController.listConversations);
router.post('/messages/:messageId/reactions', authenticate, chatController.toggleReaction);
router.post('/messages/:messageId/recall', authenticate, chatController.recallMessage);
router.get('/conversations/:conversationId/messages', authenticate, chatController.getMessages);
router.post(
  '/conversations/:conversationId/attachments',
  authenticate,
  chatUpload.array('files', 10),
  chatController.uploadAttachments,
);
router.post('/conversations/:conversationId/messages', authenticate, chatController.sendMessage);
router.post('/conversations/:conversationId/read', authenticate, chatController.markRead);

module.exports = router;
