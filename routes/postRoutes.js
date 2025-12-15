const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const { authenticate, optionalAuth } = require('../middleware/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadPath = path.join(__dirname, '../uploads/posts');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, 'uploads/posts/'); },
  filename: function (req, file, cb) { const unique = Date.now() + '-' + Math.round(Math.random() * 1e9); cb(null, file.fieldname + '-' + unique + path.extname(file.originalname)); },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true); else cb(new Error('Chỉ cho phép upload hình ảnh và video!'), false);
}});

// Public/optional GETs
router.get('/trending', optionalAuth, postController.getTrendingPosts);
router.get('/search', optionalAuth, postController.searchPosts);
router.get('/newsfeed', optionalAuth, postController.getNewsfeed);
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
router.post('/', authenticate, upload.array('files', 10), postController.createPost);
router.put('/:postId', authenticate, upload.array('files', 10), postController.updatePost);
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

