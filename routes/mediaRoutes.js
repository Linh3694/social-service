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

// Upload nhiều phần, nối lại được (SIS-181) — dành cho file lớn trên 4G.
router.post('/multipart/create', authenticate, mediaController.multipartCreate);
router.post('/multipart/sign', authenticate, mediaController.multipartSign);
router.post('/multipart/status', authenticate, mediaController.multipartStatus);
router.post('/multipart/complete', authenticate, mediaController.multipartComplete);
router.post('/multipart/abort', authenticate, mediaController.multipartAbort);

module.exports = router;
