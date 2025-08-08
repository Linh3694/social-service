const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const authMiddleware = require('../middleware/authMiddleware');
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

router.use(authMiddleware);

router.get('/trending', postController.getTrendingPosts);
router.get('/search', postController.searchPosts);
router.get('/newsfeed', postController.getNewsfeed);
router.get('/personalized', postController.getPersonalizedFeed);
router.get('/following', postController.getFollowingPosts);
router.get('/pinned', postController.getPinnedPosts);
router.get('/contributors/top', postController.getTopContributors || ((req, res)=>res.status(501).json({message:'Not implemented'})));

router.post('/', upload.array('files', 10), postController.createPost);
router.get('/:postId', postController.getPostById);
router.put('/:postId', upload.array('files', 10), postController.updatePost);
router.delete('/:postId', postController.deletePost);
router.get('/:postId/stats', postController.getPostEngagementStats);
router.get('/:postId/related', postController.getRelatedPosts);
router.post('/:postId/reactions', postController.addReaction);
router.delete('/:postId/reactions', postController.removeReaction);
router.post('/:postId/comments', postController.addComment);
router.delete('/:postId/comments/:commentId', postController.deleteComment);
router.patch('/:postId/pin', postController.togglePinPost);

module.exports = router;

