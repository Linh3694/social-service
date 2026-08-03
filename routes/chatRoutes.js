const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const chatController = require('../controllers/chatController');
const chatSyncController = require('../controllers/chatSyncController');
const { authenticate } = require('../middleware/authMiddleware');

const os = require('os');
const { config: cdnConfig } = require('../services/cdn/config');
const cleanupUploads = require('../middleware/cleanupUploads');

const chatUploadDir = path.join(__dirname, '../uploads/chat');
if (!fs.existsSync(chatUploadDir)) fs.mkdirSync(chatUploadDir, { recursive: true });

// Bật CDN ⇒ ghi tạm rồi đẩy lên MinIO; tắt ⇒ giữ nguyên hành vi cũ.
const chatTmpDir = path.join(os.tmpdir(), 'social-uploads', 'chat');
if (cdnConfig.enabled && !fs.existsSync(chatTmpDir)) fs.mkdirSync(chatTmpDir, { recursive: true });

const chatStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, cdnConfig.enabled ? chatTmpDir : 'uploads/chat/');
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
//
// SIS-181: 100MB vẫn chặn video 4K của iPhone (một clip 4K60p ~500MB). Nâng lên 1GB.
//
// CẢNH BÁO VẬN HÀNH — `client_max_body_size` của nginx PHẢI LỚN HƠN con số này.
// Nginx nhỏ hơn thì nó cắt request trước khi tới Node, và **trang lỗi 413 của nginx
// không mang header CORS** (CORS do app gắn) ⇒ trình duyệt báo "blocked by CORS
// policy" và nuốt mất thông báo tiếng Việt bên dưới. Đó chính là SIS-181: đoạn
// `res.status(413)` ngay dưới đây vẫn đúng, chỉ là chưa ai từng nhìn thấy nó.
const CHAT_UPLOAD_MAX_BYTES = Number(process.env.CHAT_UPLOAD_MAX_BYTES || 1024 * 1024 * 1024); // 1GB
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
  cleanupUploads,
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
// Bình chọn — đặt cùng khối /messages/... (trước /conversations/:conversationId/* để không bị nuốt param).
router.post('/messages/:messageId/poll/vote', authenticate, chatController.votePoll);
router.post('/messages/:messageId/poll/close', authenticate, chatController.closePoll);
router.get('/messages/:messageId/poll/voters', authenticate, chatController.getPollVoters);
router.get('/conversations/:conversationId/messages', authenticate, chatController.getMessages);
// Lấy 1 hội thoại theo id — mở link `?c=<id>` khi danh sách đã phân trang (SIS-166).
router.get('/conversations/:conversationId', authenticate, chatController.getConversation);
router.post(
  '/conversations/:conversationId/attachments',
  authenticate,
  chatUploadArray,
  cleanupUploads,
  chatController.uploadAttachments,
);
router.post('/conversations/:conversationId/messages', authenticate, chatController.sendMessage);
// Tạo bình chọn — chỉ GVCN/Phó GVCN của nhóm lớp (check trong controller theo scope Frappe).
router.post('/conversations/:conversationId/polls', authenticate, chatController.createPoll);
router.post('/conversations/:conversationId/read', authenticate, chatController.markRead);
router.post(
  '/conversations/:conversationId/hide-from-list',
  authenticate,
  chatController.hideConversationFromList,
);
router.post('/conversations/:conversationId/pin', authenticate, chatController.pinMessage);
router.delete('/conversations/:conversationId/pin', authenticate, chatController.unpinMessage);
// Chế độ ghi của nhóm lớp ("chỉ GV được nhắn") — chỉ GVCN/Phó GVCN (check trong controller).
router.patch(
  '/conversations/:conversationId/write-mode',
  authenticate,
  chatController.setConversationWriteMode,
);
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
