/**
 * Route upload trực tiếp lên CDN (Phase 3).
 *
 * Mount ở `/api/social/media` TRƯỚC postRoutes trong app.js — postRoutes có
 * `GET /:postId` sẽ nuốt mọi path một đoạn nếu mount sau. Cùng lý do chatRoutes
 * phải đứng trước postRoutes.
 */

const express = require('express');
const mediaController = require('../controllers/mediaController');
const { authenticate } = require('../middleware/authMiddleware');

const router = express.Router();

router.get('/capability', authenticate, mediaController.capability);
router.post('/presign', authenticate, mediaController.presign);
router.post('/complete', authenticate, mediaController.complete);

module.exports = router;
