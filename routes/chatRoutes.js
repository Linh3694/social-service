const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const chatController = require('../controllers/chatController');
const chatSyncController = require('../controllers/chatSyncController');
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

// SIS-125: 25MB quá nhỏ cho video điện thoại ⇒ video bị multer chặn (LIMIT_FILE_SIZE) và app hiện
// lỗi chung "Không thể gửi tin nhắn". Nâng lên 100MB làm lưới an toàn (client đã nén video trước khi gửi).
const CHAT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100MB
const CHAT_UPLOAD_MAX_MB = Math.round(CHAT_UPLOAD_MAX_BYTES / (1024 * 1024));

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: CHAT_UPLOAD_MAX_BYTES },
  fileFilter: chatFileFilter,
});

// Bọc chatUpload.array để trả JSON lỗi rõ ràng. Lỗi multer (quá dung lượng / sai loại) phát sinh ở
// middleware — KHÔNG đi vào try/catch của controller — nên nếu không bắt ở đây client chỉ nhận lỗi chung.
function chatUploadArray(req, res, next) {
  chatUpload.array('files', 10)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          success: false,
          code: 'FILE_TOO_LARGE',
          message: `Tệp/video quá lớn (tối đa ${CHAT_UPLOAD_MAX_MB}MB)`,
        });
      }
      return res.status(400).json({ success: false, code: err.code, message: 'Không thể tải tệp lên' });
    }
    return res.status(415).json({
      success: false,
      code: 'UNSUPPORTED_FILE_TYPE',
      message: err.message || 'Loại tệp không được phép trong chat',
    });
  });
}

const router = express.Router();

router.post(
  '/conversations/teacher-guardian',
  authenticate,
  chatController.ensureTeacherGuardianConversation,
);
router.post(
  '/conversations/teacher-guardian/messages',
  authenticate,
  chatController.sendTeacherGuardianMessage,
);
router.post(
  '/conversations/teacher-guardian/attachments',
  authenticate,
  chatUploadArray,
  chatController.uploadTeacherGuardianAttachments,
);
// Endpoint cũ (group GV + tất cả guardian của HS) đã được thay bằng chat 1-1 GV<->guardian.
// Trả 410 để các client cũ biết và chuyển sang `teacher-guardian`.
router.post('/conversations/teacher-student', authenticate, (req, res) => {
  res.status(410).json({
    success: false,
    code: 'ENDPOINT_REMOVED',
    message: 'Endpoint /conversations/teacher-student đã bị thay thế bởi /conversations/teacher-guardian (chat 1-1).',
  });
});
// Sync/revoke membership theo roster — auth bằng API key service (không phải user token).
// Đặt trước các route /conversations/:conversationId để không bị nuốt param.
router.post('/sync/memberships', chatSyncController.syncChatMemberships);

router.get('/conversations', authenticate, chatController.listConversations);
router.post('/messages/:messageId/reactions', authenticate, chatController.toggleReaction);
router.post('/messages/:messageId/recall', authenticate, chatController.recallMessage);
router.get('/conversations/:conversationId/messages', authenticate, chatController.getMessages);
router.post(
  '/conversations/:conversationId/attachments',
  authenticate,
  chatUploadArray,
  chatController.uploadAttachments,
);
router.post('/conversations/:conversationId/messages', authenticate, chatController.sendMessage);
router.post('/conversations/:conversationId/read', authenticate, chatController.markRead);
router.post(
  '/conversations/:conversationId/hide-from-list',
  authenticate,
  chatController.hideConversationFromList,
);
router.post('/conversations/:conversationId/pin', authenticate, chatController.pinMessage);
router.delete('/conversations/:conversationId/pin', authenticate, chatController.unpinMessage);
// Quản lý GVBM trong nhóm lớp — chỉ GVCN/Phó GVCN (check trong controller theo scope Frappe).
router.get(
  '/conversations/:conversationId/members/addable',
  authenticate,
  chatController.listAddableTeachers,
);
router.post(
  '/conversations/:conversationId/members',
  authenticate,
  chatController.addConversationTeacher,
);
router.delete(
  '/conversations/:conversationId/members/:teacherId',
  authenticate,
  chatController.removeConversationTeacher,
);

module.exports = router;
