const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const { authenticate, optionalAuth } = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const os = require('os');
const { config: cdnConfig } = require('../services/cdn/config');
const cleanupUploads = require('../middleware/cleanupUploads');

const uploadPath = path.join(__dirname, '../uploads/posts');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

// Bật CDN ⇒ ghi vào thư mục TẠM, controller đẩy lên MinIO rồi unlink.
// Tắt CDN ⇒ giữ nguyên hành vi cũ (ghi ./uploads/posts) để rollback tức thì.
const postTmpDir = path.join(os.tmpdir(), 'social-uploads', 'posts');
if (cdnConfig.enabled && !fs.existsSync(postTmpDir)) fs.mkdirSync(postTmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, cdnConfig.enabled ? postTmpDir : 'uploads/posts/'); },
  filename: function (req, file, cb) { const unique = Date.now() + '-' + Math.round(Math.random() * 1e9); cb(null, file.fieldname + '-' + unique + path.extname(file.originalname)); },
});
// SIS-181: 50MB chặn video điện thoại y như bên chat. Nâng lên 1GB cho khớp
// `CHAT_UPLOAD_MAX_BYTES` — hai bề mặt cùng một loại nội dung thì không có lý do
// gì lệch trần nhau.
//
// CẢNH BÁO VẬN HÀNH: `client_max_body_size` của nginx PHẢI LỚN HƠN con số này.
// Nhỏ hơn thì nginx cắt trước khi tới Node và trang lỗi 413 của nó KHÔNG mang
// header CORS ⇒ trình duyệt báo "blocked by CORS policy", nuốt mất thông báo thật.
const POST_UPLOAD_MAX_BYTES = Number(process.env.POST_UPLOAD_MAX_BYTES || 1024 * 1024 * 1024); // 1GB
const POST_UPLOAD_MAX_MB = Math.round(POST_UPLOAD_MAX_BYTES / (1024 * 1024));

const upload = multer({ storage, limits: { fileSize: POST_UPLOAD_MAX_BYTES }, fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true); else cb(new Error('Chỉ cho phép upload hình ảnh và video!'), false);
}});

/**
 * Bọc `upload.array` để lỗi multer ra JSON rõ ràng — giống chatRoutes.
 * Lỗi multer phát sinh ở middleware, KHÔNG đi vào try/catch của controller, nên
 * không bắt ở đây thì client chỉ nhận lỗi chung chung (SIS-181).
 */
function postUploadArray(field, maxCount) {
  return function (req, res, next) {
    upload.array(field, maxCount)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            success: false,
            code: 'FILE_TOO_LARGE',
            message: `Tệp/video quá lớn (tối đa ${POST_UPLOAD_MAX_MB}MB)`,
          });
        }
        return res.status(400).json({ success: false, code: err.code, message: 'Không thể tải tệp lên' });
      }
      return res.status(415).json({
        success: false,
        code: 'UNSUPPORTED_FILE_TYPE',
        message: err.message || 'Chỉ cho phép upload hình ảnh và video',
      });
    });
  };
}

// Public/optional GETs
router.get('/trending', optionalAuth, postController.getTrendingPosts);
router.get('/search', optionalAuth, postController.searchPosts);
router.get('/newsfeed', optionalAuth, postController.getNewsfeed);
router.get('/class-feed', authenticate, postController.getClassFeed);
router.get('/class-guardian-directory', authenticate, postController.getClassGuardianDirectory);
router.get('/student-feed', optionalAuth, postController.getStudentFeed);
router.get('/student-post/:postId', optionalAuth, postController.getStudentPostDetail);
router.get('/:postId/comments', authenticate, postController.getPostCommentsPaged);
router.get('/:postId', optionalAuth, postController.getPostById);
router.get('/:postId/stats', optionalAuth, postController.getPostEngagementStats);
router.get('/:postId/related', optionalAuth, postController.getRelatedPosts);
router.get('/contributors/top', optionalAuth, postController.getTopContributors || ((req, res)=>res.status(501).json({message:'Not implemented'})));

// Auth-required feeds
router.get('/personalized', authenticate, postController.getPersonalizedFeed);
router.get('/following', authenticate, postController.getFollowingPosts);
router.get('/pinned', authenticate, postController.getPinnedPosts);
router.get('/contributors/top', postController.getTopContributors || ((req, res)=>res.status(501).json({message:'Not implemented'})));

// Write operations require auth
router.post('/', authenticate, postUploadArray('files', 30), cleanupUploads, postController.createPost);
router.put('/:postId', authenticate, postUploadArray('files', 30), cleanupUploads, postController.updatePost);
router.delete('/:postId', authenticate, postController.deletePost);
router.post('/:postId/reactions', authenticate, postController.addReaction);
router.delete('/:postId/reactions', authenticate, postController.removeReaction);
router.post('/:postId/comments', authenticate, postController.addComment);
router.delete('/:postId/comments/:commentId', authenticate, postController.deleteComment);
router.post('/:postId/comments/:commentId/replies', authenticate, postController.replyComment);
// Comment reactions
router.post('/:postId/comments/:commentId/reactions', authenticate, postController.addCommentReaction);
router.delete('/:postId/comments/:commentId/reactions', authenticate, postController.removeCommentReaction);
// Pin/Unpin post - Chỉ Mobile BOD
router.post('/:postId/pin', authenticate, postController.pinPost);
router.delete('/:postId/pin', authenticate, postController.unpinPost);

module.exports = router;

